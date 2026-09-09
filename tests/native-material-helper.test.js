const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const Service = require("../src/file-service");
const enabled = process.platform === "win32" && process.env.MATERIAL_NATIVE_SMOKE === "1";

test("Windows 原生身份请求精确返回文件编号且不修改文件", { skip: !enabled }, async () => {
  const root = path.resolve(__dirname, "../work/native-smoke");
  await fs.mkdir(root, { recursive: true });
  const folder = await fs.mkdtemp(path.join(root, "identity-"));
  const helper = path.join(folder, "MaterialFileHelper.exe");
  await fs.copyFile(path.resolve(__dirname, "../work/native-candidate/MaterialFileHelper.exe"), helper);
  const id = require("node:crypto").randomBytes(16).toString("hex"), token = "b".repeat(64);
  const file = path.join(folder, "独立小素材.bin");
  await fs.writeFile(file, "identity-only-fixture");
  const before = await fs.lstat(file, { bigint: true });
  await fs.writeFile(path.join(folder, "token.txt"), token);
  await fs.writeFile(path.join(folder, "bridge-location.json"), JSON.stringify({ directory: folder }));
  await fs.writeFile(path.join(folder, id + ".identity-request.json"), JSON.stringify({ id, token, path: file, version: 1, expiresAt: Date.now() + 15000 }));
  const child = spawn(helper, ["hechao-material-recycle://identity/" + id], { windowsHide: true });
  assert.equal(await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); }), 0);
  const result = JSON.parse(await fs.readFile(path.join(folder, id + ".identity-result.json"), "utf8"));
  assert.equal(result.ino, String(before.ino));
  assert.equal(result.dev, String(before.dev));
  assert.equal(result.mtimeMs, Number(before.mtimeMs));
  assert.equal(await fs.readFile(file, "utf8"), "identity-only-fixture");
});

test("Windows 助手预检不接触媒体且只响应有效安装凭据", { skip: !enabled }, async () => {
  const root = path.resolve(__dirname, "../work/native-smoke");
  await fs.mkdir(root, { recursive: true });
  const folder = await fs.mkdtemp(path.join(root, "probe-"));
  const helper = path.join(folder, "MaterialFileHelper.exe");
  await fs.copyFile(path.resolve(__dirname, "../work/native-candidate/MaterialFileHelper.exe"), helper);
  const token = require("node:crypto").randomBytes(32).toString("hex");
  await fs.writeFile(path.join(folder, "token.txt"), token);
  await fs.writeFile(path.join(folder, "bridge-location.json"), JSON.stringify({ directory: folder }));
  for (const valid of [true, false]) {
    const id = require("node:crypto").randomBytes(16).toString("hex");
    const prefix = path.join(folder, id);
    await fs.writeFile(prefix + ".probe-request.json", JSON.stringify({ id, token: valid ? token : "0".repeat(64), version: 1, expiresAt: Date.now() + 15000 }));
    const child = spawn(helper, ["hechao-material-recycle://probe/" + id], { windowsHide: true });
    const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    assert.equal(code, valid ? 0 : 2);
    if (valid) assert.equal(JSON.parse(await fs.readFile(prefix + ".probe-result.json", "utf8")).status, "available");
    else await assert.rejects(fs.stat(prefix + ".probe-result.json"), { code: "ENOENT" });
    await assert.rejects(fs.stat(prefix + ".commit.json"), { code: "ENOENT" });
    await assert.rejects(fs.stat(prefix + ".lock"), { code: "ENOENT" });
  }
});

async function interruptedJob(run) {
  const root = path.resolve(__dirname, "../work/native-smoke");
  await fs.mkdir(root, { recursive: true });
  const folder = await fs.mkdtemp(path.join(root, "interrupt-"));
  const helper = path.join(folder, "MaterialFileHelper.exe");
  await fs.copyFile(path.resolve(__dirname, "../work/native-test-candidate/MaterialFileHelper.exe"), helper);
  const workspaceRoot = path.join(folder, "project"); await fs.mkdir(workspaceRoot);
  const crypto = require("node:crypto"), id = crypto.randomBytes(16).toString("hex"), token = crypto.randomBytes(32).toString("hex");
  const sourcePath = path.join(folder, id + ".bin"), targetPath = path.join(workspaceRoot, id + ".bin");
  await fs.writeFile(sourcePath, "independent-native-fixture"); await fs.copyFile(sourcePath, targetPath);
  const verified = await Service.compareFiles({ fs, sourcePath, targetPath });
  const statePath = path.join(workspaceRoot, ".premiere-material-space.json"), prefix = path.join(folder, id);
  const request = { id, version: 1, token, expiresAt: Date.now() + 60000, path: sourcePath, targetPath, workspaceRoot, statePath,
    sourceFingerprint: verified.sourceFingerprint, targetFingerprint: verified.targetFingerprint };
  await fs.writeFile(path.join(folder, "bridge-location.json"), JSON.stringify({ directory: folder }));
  await fs.writeFile(path.join(folder, "token.txt"), token);
  await fs.writeFile(statePath, JSON.stringify({ pendingTransaction: { id, sourcePath, targetRelativePath: id + ".bin", recycleRequest: request } }));
  await fs.writeFile(prefix + ".request.json", JSON.stringify(request));
  const children = [];
  const launch = (mode, env = {}) => {
    const child = spawn(helper, ["hechao-material-recycle://" + mode + "/" + id], { windowsHide: true, env: { ...process.env, ...env } });
    const done = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    const job = { child, done }; children.push(job); return job;
  };
  const waitFile = async suffix => {
    for (let i = 0; i < 300; i++) {
      try { return JSON.parse(await fs.readFile(prefix + suffix, "utf8")); }
      catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error("测试助手未产生预期文件：" + suffix);
  };
  const commit = async () => {
    await waitFile(".ready.json");
    const issuedPath = statePath + ".recycle-" + id + ".issued";
    await fs.writeFile(issuedPath, JSON.stringify({ id, transactionId: id }));
    await fs.writeFile(prefix + ".commit.json", JSON.stringify({ id, token, at: Date.now(), statePath, issuedPath }));
  };
  try { await run({ folder, id, prefix, sourcePath, targetPath, request, launch, waitFile, commit }); }
  finally { for (const job of children) { if (job.child.exitCode === null && job.child.signalCode === null) job.child.kill(); await job.done; } }
}

async function holdNativeReadLock(file) {
  const quoted = file.replace(/'/g, "''");
  const script = "$f=[IO.File]::Open('" + quoted + "',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read); "
    + "try { [Console]::WriteLine('LOCK_READY'); [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }";
  const child = spawn("powershell.exe", ["-NoProfile", "-Command", script], { windowsHide: true });
  let output = "";
  const done = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("独立测试文件未取得占用锁")); }, 5000);
    child.stdout.on("data", data => { output += data; if (output.includes("LOCK_READY")) { clearTimeout(timer); resolve(); } });
    done.then(() => { clearTimeout(timer); if (!output.includes("LOCK_READY")) reject(new Error("独立占用进程提前退出")); }, reject);
  });
  return { async release() { if (child.exitCode === null) child.stdin.end("\n"); await done; } };
}

test("Windows 原件短暂占用释放后自动完成真实回收，无第二次请求", { skip: !enabled }, async () => interruptedJob(async f => {
  const lock = await holdNativeReadLock(f.sourcePath);
  const job = f.launch("job");
  try {
    await new Promise(resolve => setTimeout(resolve, 400));
    await lock.release();
    await f.commit();
    assert.equal(await job.done, 0);
    const result = await f.waitFile(".result.json");
    assert.equal(result.status, "recycled", result.message);
    assert.match(result.receiptId, /^[0-9a-f]{64}$/);
    await assert.rejects(fs.stat(f.sourcePath), { code: "ENOENT" });
    assert.equal(await fs.readFile(f.targetPath, "utf8"), "independent-native-fixture");
  } finally { await lock.release(); }
}));

test("Windows 原件持续占用在有限等待后返回32，不提交不暂存", { skip: !enabled }, async () => interruptedJob(async f => {
  const lock = await holdNativeReadLock(f.sourcePath);
  try {
    const at = Date.now();
    assert.equal(await f.launch("job").done, 1);
    const result = await f.waitFile(".result.json");
    assert.equal(result.status, "failed");
    assert.equal(result.failureKind, "busy");
    assert.equal(result.win32Error, 32);
    assert.ok(Date.now() - at >= 1100);
    for (const suffix of [".ready.json", ".commit.json", ".staged.json"]) await assert.rejects(fs.stat(f.prefix + suffix), { code: "ENOENT" });
    assert.equal(await fs.readFile(f.sourcePath, "utf8"), "independent-native-fixture");
  } finally { await lock.release(); }
}));

test("Windows 占用等待期间取消，不取得回收凭据且原件完整", { skip: !enabled }, async () => interruptedJob(async f => {
  const lock = await holdNativeReadLock(f.sourcePath);
  try {
    const job = f.launch("job");
    await new Promise(resolve => setTimeout(resolve, 300));
    await fs.writeFile(f.prefix + ".cancel", "{}");
    assert.equal(await job.done, 1);
    const result = await f.waitFile(".result.json");
    assert.equal(result.status, "failed");
    assert.match(result.message, /取消/);
    await assert.rejects(fs.stat(f.prefix + ".ready.json"), { code: "ENOENT" });
    assert.equal(await fs.readFile(f.sourcePath, "utf8"), "independent-native-fixture");
  } finally { await lock.release(); }
}));

test("Windows 暂存后助手中断，核对请求恢复原位置且不回收", { skip: !enabled }, async () => interruptedJob(async f => {
  const job = f.launch("job", { MATERIAL_TEST_PAUSE_AFTER_STAGE: "1" });
  await f.commit();
  const staged = await f.waitFile(".test-staged.json");
  assert.equal(await fs.readFile(staged.message, "utf8"), "independent-native-fixture");
  job.child.kill(); await job.done;
  await assert.rejects(fs.stat(f.sourcePath), { code: "ENOENT" });
  assert.equal(await f.launch("query").done, 0);
  const result = await f.waitFile(".reconciled.json");
  assert.equal(result.status, "failed", result.message);
  assert.equal(await fs.readFile(f.sourcePath, "utf8"), "independent-native-fixture");
  assert.equal(await fs.readFile(f.targetPath, "utf8"), "independent-native-fixture");
}));

test("Windows 暂存后原路径被新文件占用，恢复不覆盖任何一份", { skip: !enabled }, async () => interruptedJob(async f => {
  const job = f.launch("job", { MATERIAL_TEST_PAUSE_AFTER_STAGE: "1" });
  await f.commit(); const staged = await f.waitFile(".test-staged.json");
  await fs.writeFile(f.sourcePath, "new-download");
  job.child.kill(); await job.done;
  await f.launch("query").done;
  assert.equal((await f.waitFile(".reconciled.json")).status, "uncertain");
  assert.equal(await fs.readFile(f.sourcePath, "utf8"), "new-download");
  assert.equal(await fs.readFile(staged.message, "utf8"), "independent-native-fixture");
  await fs.rename(f.sourcePath, f.sourcePath + ".new-download-preserved");
  await f.launch("query").done;
  const retried = await f.waitFile(".reconciled.json");
  assert.equal(retried.status, "failed", retried.message);
  assert.equal(await fs.readFile(f.sourcePath, "utf8"), "independent-native-fixture");
  assert.equal(await fs.readFile(f.sourcePath + ".new-download-preserved", "utf8"), "new-download");
}));

test("Windows 系统回收前失败会恢复原位置，不永久删除", { skip: !enabled }, async () => interruptedJob(async f => {
  const job = f.launch("job", { MATERIAL_TEST_FAIL_RECYCLE: "1" });
  await f.commit(); await job.done;
  const result = await f.waitFile(".result.json");
  assert.equal(result.status, "failed", result.message);
  assert.equal(await fs.readFile(f.sourcePath, "utf8"), "independent-native-fixture");
  assert.equal(await fs.readFile(f.targetPath, "utf8"), "independent-native-fixture");
}));

test("Windows 回收成功后只清理空目录，额外文件存在时完整保留", { skip: !enabled }, async () => interruptedJob(async f => {
  const job = f.launch("job", { MATERIAL_TEST_KEEP_STAGE_FILE: "1" });
  await f.commit();
  assert.equal(await job.done, 0);
  assert.equal((await f.waitFile(".result.json")).status, "recycled");
  const directory = path.join(f.folder, ".premiere-material-recycle-" + f.id);
  assert.equal(await fs.readFile(path.join(directory, "independent-preserved.txt"), "utf8"), "preserved-test-file");
}));

test("Windows 原生助手将独立小测试素材回收并核对唯一回收站条目", { skip: process.platform !== "win32" || process.env.MATERIAL_NATIVE_SMOKE !== "1" }, async () => {
  const root = path.resolve(__dirname, "../work/native-smoke");
  await fs.mkdir(root, { recursive: true });
  const folder = await fs.mkdtemp(path.join(root, "run-"));
  const helper = path.join(folder, "MaterialFileHelper.exe");
  await fs.copyFile(path.resolve(__dirname, "../work/native-candidate/MaterialFileHelper.exe"), helper);
  const workspaceRoot = path.join(folder, "project");
  await fs.mkdir(workspaceRoot);
  const id = require("node:crypto").randomBytes(16).toString("hex");
  const token = require("node:crypto").randomBytes(32).toString("hex");
  const sourcePath = path.join(folder, id + ".bin");
  const targetPath = path.join(workspaceRoot, id + ".bin");
  await fs.writeFile(sourcePath, "material-helper-disposable-" + id);
  await fs.copyFile(sourcePath, targetPath);
  const verified = await Service.compareFiles({ fs, sourcePath, targetPath });
  const statePath = path.join(workspaceRoot, ".premiere-material-space.json");
  const request = { id, version: 1, token, expiresAt: Date.now() + 120000, path: sourcePath, targetPath,
    workspaceRoot, statePath, sourceFingerprint: verified.sourceFingerprint, targetFingerprint: verified.targetFingerprint };
  await fs.writeFile(path.join(folder, "bridge-location.json"), JSON.stringify({ directory: folder }));
  await fs.writeFile(path.join(folder, "token.txt"), token);
  await fs.writeFile(statePath, JSON.stringify({ pendingTransaction: { id, sourcePath, targetRelativePath: id + ".bin", recycleRequest: request } }));
  const prefix = path.join(folder, id);
  await fs.writeFile(prefix + ".request.json", JSON.stringify(request));
  const child = spawn(helper, ["hechao-material-recycle://job/" + id], { windowsHide: true });
  const done = new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  let committed = false;
  for (let i = 0; i < 1200; i++) {
    const names = await fs.readdir(folder);
    if (names.includes(id + ".result.json")) break;
    if (!committed && names.includes(id + ".ready.json")) {
      const issuedPath = statePath + ".recycle-" + id + ".issued";
      await fs.writeFile(issuedPath, JSON.stringify({ id, transactionId: id }));
      await fs.writeFile(prefix + ".commit.json", JSON.stringify({ id, token, at: Date.now(), statePath, issuedPath }));
      committed = true;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const exit = await done;
  const result = JSON.parse(await fs.readFile(prefix + ".result.json", "utf8"));
  assert.equal(result.status, "recycled", "原生助手结果：" + result.message);
  assert.equal(exit, 0);
  assert.match(result.receiptId, /^[0-9a-f]{64}$/);
  await assert.rejects(fs.stat(sourcePath), { code: "ENOENT" });
  assert.equal((await fs.stat(targetPath)).size, verified.byteCount);
  const journal = JSON.parse(await fs.readFile(prefix + ".staged.json", "utf8"));
  assert.equal(journal.message, path.join(folder, ".premiere-material-recycle-" + id, id + ".bin"));
  await assert.rejects(fs.stat(path.dirname(journal.message)), { code: "ENOENT" }, "成功回收后应收掉本次空目录");
  // 模拟回收后响应丢失：新进程只核对回收站，不能执行第二次回收。
  await fs.rename(prefix + ".result.json", prefix + ".result-interrupted.json");
  const query = spawn(helper, ["hechao-material-recycle://query/" + id], { windowsHide: true });
  const queryExit = await new Promise((resolve, reject) => { query.on("error", reject); query.on("close", resolve); });
  assert.equal(queryExit, 0);
  const reconciled = JSON.parse(await fs.readFile(prefix + ".reconciled.json", "utf8"));
  assert.equal(reconciled.status, "recycled", reconciled.message);
  assert.equal(reconciled.receiptId, result.receiptId);
  assert.equal(await fs.readFile(targetPath, "utf8"), "material-helper-disposable-" + id);
  // Keep the small evidence directory; the original sample remains recoverable in the system bin.
});
