const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const Service = require("../src/file-service");
const Transaction = require("../src/transaction");

test("宿主文件接口适配保持所有原生方法接收对象，不修改原模块", async () => {
  const nativeFs = { constants: { COPYFILE_EXCL: 1 } };
  for (const name of ["lstat", "open", "close", "read", "write", "readFile", "writeFile", "mkdir", "rename", "unlink", "copyFile"]) {
    Object.defineProperty(nativeFs, name, { value: function (...args) {
      assert.equal(this, nativeFs, `${name} 必须绑定原生模块`); return args;
    } });
  }
  Object.freeze(nativeFs);
  const identity = async value => value;
  const adapted = Service.createHostFileSystem(nativeFs, identity);
  assert.equal(Object.getPrototypeOf(adapted), Object.prototype);
  for (const name of Object.getOwnPropertyNames(nativeFs).filter(name => name !== "constants")) {
    assert.deepEqual(await adapted[name]("path", 7), ["path", 7]);
  }
  assert.equal(adapted.constants, nativeFs.constants);
  assert.equal(adapted.link, undefined);
  assert.equal(adapted.materialIdentity, identity);
  assert.equal(adapted.lstatSupportsBigInt, false);
  assert.equal(nativeFs.materialIdentity, undefined);
});

async function fixture(run) {
  const root = path.resolve(__dirname, "../work/file-service-tests");
  await fs.mkdir(root, { recursive: true });
  const folder = await fs.mkdtemp(path.join(root, "run-"));
  try { await run(folder); } finally { await fs.rm(folder, { recursive: true, force: true }); }
}

test("分块完整比较及 SHA256 与标准实现一致", async () => fixture(async folder => {
  const bytes = crypto.randomBytes(2 * 1024 * 1024 + 17);
  const sourcePath = path.join(folder, "source.bin");
  const targetPath = path.join(folder, "target.bin");
  await fs.writeFile(sourcePath, bytes); await fs.writeFile(targetPath, bytes);
  let count = 0;
  const result = await Service.compareFiles({ fs, sourcePath, targetPath, onProgress: () => count++ });
  assert.equal(result.sourceFingerprint.sha256, crypto.createHash("sha256").update(bytes).digest("hex"));
  assert.equal(result.byteCount, bytes.length);
  assert.equal(count, 3);
}));

test("同大小不同内容不授予恢复凭据", async () => fixture(async folder => {
  const sourcePath = path.join(folder, "a.bin"), targetPath = path.join(folder, "b.bin");
  await fs.writeFile(sourcePath, "1234"); await fs.writeFile(targetPath, "1235");
  await assert.rejects(Service.compareFiles({ fs, sourcePath, targetPath }), /内容不同/);
  assert.equal(await fs.readFile(sourcePath, "utf8"), "1234");
  assert.equal(await fs.readFile(targetPath, "utf8"), "1235");
}));

test("核验取消、文件增长均保持两处文件", async () => fixture(async folder => {
  const sourcePath = path.join(folder, "a.bin"), targetPath = path.join(folder, "b.bin");
  await fs.writeFile(sourcePath, "1234"); await fs.writeFile(targetPath, "1234");
  await assert.rejects(Service.compareFiles({ fs, sourcePath, targetPath, cancelled: () => true }), /取消/);
  await assert.rejects(Service.compareFiles({ fs, sourcePath, targetPath, wait: async () => fs.appendFile(sourcePath, "5") }), /增长|变化/);
}));

test("回收失败时原位置不改名、不永久删除且目标继续在线", async () => fixture(async folder => {
  const sourcePath = path.join(folder, "a.bin"), targetPath = path.join(folder, "b.bin");
  await fs.writeFile(sourcePath, "1234"); await fs.writeFile(targetPath, "1234");
  const item = { getMediaFilePath: async () => targetPath, isOffline: async () => false };
  const result = await Transaction.cleanupVerifiedSource({ fs, sourcePath, targetPath, sourceDisposition: "recycle",
    sourceFingerprint: Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, sourcePath)),
    targetFingerprint: Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, targetPath)),
    projectItems: [item], recycle: async () => { throw new Error("回收站不可用"); } });
  assert.equal(result.cleanupPending, true);
  assert.equal(await fs.readFile(sourcePath, "utf8"), "1234");
  assert.deepEqual((await fs.readdir(folder)).sort(), ["a.bin", "b.bin"]);
}));
