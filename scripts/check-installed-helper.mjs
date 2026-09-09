import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

if (process.platform !== "win32") throw new Error("此检查只适用于 Windows");
const pluginPath = path.join(process.env.APPDATA, "Adobe/UXP/Plugins/External/com.hechao.premiere.material-batch-organizer");
const manifest = JSON.parse(await fs.readFile(path.join(pluginPath, "manifest.json"), "utf8"));
const require = createRequire(import.meta.url);
const Bridge = require(path.join(pluginPath, "src/recycle-bridge.js"));
const bridge = Bridge.create({ fs, pluginPath });
const result = await bridge.checkAvailability();
console.log(JSON.stringify({ version: manifest.version, status: result.status, mediaTouched: false }));

if (process.argv.includes("--exercise")) {
  const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  assert.match(project, /^E:\\/i, "独立测试必须位于 E 盘项目");
  const root = path.join(project, "work/installed-helper-smoke");
  await fs.mkdir(root, { recursive: true });
  const folder = await fs.mkdtemp(path.join(root, "run-"));
  const workspaceRoot = path.join(folder, "测试工程");
  await fs.mkdir(workspaceRoot);
  const sourcePath = path.join(folder, "独立回收测试.bin");
  const targetPath = path.join(workspaceRoot, "独立回收测试.bin");
  const content = "installed-helper-isolated-fixture-" + crypto.randomBytes(8).toString("hex");
  await fs.writeFile(sourcePath, content, { flag: "wx" });
  await fs.copyFile(sourcePath, targetPath, (await import("node:fs")).constants.COPYFILE_EXCL);
  const identity = await bridge.readIdentity(sourcePath);
  assert.equal(identity.ino, String((await fs.lstat(sourcePath, { bigint: true })).ino));
  const Service = require(path.join(pluginPath, "src/file-service.js"));
  const verified = await Service.compareFiles({ fs, sourcePath, targetPath });
  const statePath = path.join(workspaceRoot, ".premiere-material-space.json");
  const request = { id: crypto.randomBytes(16).toString("hex"), path: sourcePath, targetPath, workspaceRoot, statePath,
    sourceFingerprint: verified.sourceFingerprint, targetFingerprint: verified.targetFingerprint };
  await fs.writeFile(statePath, JSON.stringify({ pendingTransaction: {
    id: request.id, sourcePath, targetRelativePath: path.basename(targetPath), recycleRequest: request,
  } }), { flag: "wx" });
  const api = Bridge.create({ fs, pluginPath, uxp: { shell: {
    openExternal() { assert.fail("不得调用宿主外部启动授权"); },
    openPath() { assert.fail("不得调用宿主文件夹授权"); },
  } }, beforeCommit: async job => {
    await fs.writeFile(job.issuedPath, JSON.stringify({ id: job.jobId, transactionId: request.id }), { flag: "wx" });
    return true;
  } });
  const receipt = await api.recycle(request);
  assert.equal(receipt.status, "recycled");
  assert.match(receipt.receiptId, /^[0-9a-f]{64}$/);
  assert.equal((await api.recycle(request)).receiptId, receipt.receiptId);
  await assert.rejects(fs.stat(sourcePath), { code: "ENOENT" });
  assert.equal(await fs.readFile(targetPath, "utf8"), content);
  await api.revealDirectory(workspaceRoot);
  const evidence = { version: manifest.version, installedTransport: "local-file-service", exactIdentity: true,
    recycleStatus: receipt.status, sameReceiptOnRepeat: true, sourceRecoverableInRecycleBin: true,
    folderOpenReceipt: true, hostRelinkAndSaveTested: false, userMediaTouched: false, folder };
  await fs.writeFile(path.join(folder, "验收结果.json"), JSON.stringify(evidence, null, 2), { flag: "wx" });
  console.log(JSON.stringify(evidence));
}
