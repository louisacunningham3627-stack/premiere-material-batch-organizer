const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const Transaction = require("../src/transaction");

async function fixture(run) {
  const root = path.resolve(__dirname, "../work/recycle-transaction-tests");
  await fs.mkdir(root, { recursive: true });
  const folder = await fs.mkdtemp(path.join(root, "run-"));
  const source = path.join(folder, "source.bin"), target = path.join(folder, "target.bin");
  await fs.writeFile(source, "original");
  let mediaPath = source, offline = false;
  const item = { canChangeMediaPath: async () => true, changeMediaFilePath: async next => { mediaPath = next; return true; },
    refreshMedia: async () => {}, getMediaFilePath: async () => mediaPath, isOffline: async () => offline };
  const original = Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, source));
  try { await run({ folder, source, target, item, original, changeLink: value => { mediaPath = value; }, setOffline: () => { offline = true; } }); }
  finally { await fs.rm(folder, { recursive: true, force: true }); }
}

for (const kind of ["正常归集", "恢复归集"]) {
  for (const scenario of ["源被替换", "目标被替换", "链接改变", "素材离线", "工程切换", "回收失败", "缺少助手", "伪成功回执", "核验期间增长"]) {
    test(kind + "：" + scenario + "时保留现场，不误回收", async () => fixture(async f => {
      let active = true, recycleCalls = 0, unlinks = 0;
      const guardedFs = new Proxy(fs, { get(target, key) { if (key === "unlink") return async () => { unlinks++; throw new Error("禁止永久删除"); }; return target[key]; } });
      const options = { fs: guardedFs, sourcePath: f.source, targetPath: f.target, projectItems: [f.item], forceMode: "copy",
        validate: async () => active, persistProject: async () => true, wait: async () => {},
        beforeDelete: async () => {
          if (scenario === "源被替换" || scenario === "目标被替换") {
            const selected = scenario === "源被替换" ? f.source : f.target;
            await fs.rename(selected, selected + ".original"); await fs.writeFile(selected, "new-file");
          }
          if (scenario === "链接改变") f.changeLink(f.source);
          if (scenario === "素材离线") f.setOffline();
          if (scenario === "工程切换") active = false;
        },
        cleanupWait: async () => { if (scenario === "核验期间增长") await fs.appendFile(f.source, "changed"); },
        recycle: scenario === "缺少助手" ? undefined : async () => {
          recycleCalls++;
          if (scenario === "回收失败") throw new Error("系统拒绝回收");
          if (scenario === "伪成功回执") return { status: "recycled", path: f.source };
          throw new Error("安全门禁漏过，回收接口不应执行");
        },
      };
      let result;
      if (kind === "恢复归集") {
        await fs.copyFile(f.source, f.target); f.changeLink(f.target);
        options.sourceFingerprint = f.original;
        options.targetFingerprint = Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, f.target));
        result = await Transaction.cleanupVerifiedSource(options);
      } else result = await Transaction.moveAndRelink(options);
      assert.equal(result.cleanupPending, true);
      assert.equal(await Transaction.exists(fs, f.source), true);
      assert.equal(await Transaction.exists(fs, f.target), true);
      assert.equal(unlinks, 0);
      assert.equal(recycleCalls, ["回收失败", "伪成功回执"].includes(scenario) ? 1 : 0);
    }));
  }
}

test("旧隔离文件与原位置同时存在时不选择任意一份回收", async () => fixture(async f => {
  await fs.copyFile(f.source, f.target); f.changeLink(f.target);
  const cleanup = Transaction.cleanupPathFor(f.source, "old"); await fs.copyFile(f.source, cleanup);
  const result = await Transaction.cleanupVerifiedSource({ fs, sourcePath: f.source, targetPath: f.target, cleanupPath: cleanup,
    sourceFingerprint: f.original, targetFingerprint: Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, f.target)),
    projectItems: [f.item], recycle: async () => { assert.fail("不能回收"); } });
  assert.equal(result.cleanupPending, true);
  assert.match(result.cleanupWarning, /同时存在/);
}));

test("恢复回收失败保持原位，重试使用同一原件并保留可恢复副本", async () => fixture(async f => {
  await fs.copyFile(f.source, f.target); f.changeLink(f.target);
  const options = { fs, sourcePath: f.source, targetPath: f.target, sourceFingerprint: f.original,
    targetFingerprint: Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, f.target)), projectItems: [f.item], wait: async () => {} };
  const failed = await Transaction.cleanupVerifiedSource({ ...options, recycle: async () => { throw new Error("暂时占用"); } });
  assert.equal(failed.cleanupPending, true);
  assert.equal(await fs.readFile(f.source, "utf8"), "original");
  const recycled = path.join(f.folder, "simulated-recycle.bin");
  const completed = await Transaction.cleanupVerifiedSource({ ...options, recycle: async details => {
    await fs.rename(details.path, recycled);
    return { status: "recycled", path: details.path, receiptId: "verified-test-receipt" };
  } });
  assert.equal(completed.cleanupPending, false);
  assert.equal(await fs.readFile(recycled, "utf8"), "original");
  assert.equal(await fs.readFile(f.target, "utf8"), "original");
}));
