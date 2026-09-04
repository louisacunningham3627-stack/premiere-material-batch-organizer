const test = require("node:test");
const assert = require("node:assert/strict");
const nativeFs = require("node:fs/promises");
// 让测试中的直接 lstat 也使用与事务相同的精确身份模式。
const fs = Object.assign({}, nativeFs, {
  lstat: (nativePath, options) => nativeFs.lstat(nativePath, options || { bigint: true }),
});
const os = require("node:os");
const path = require("node:path");
const Transaction = require("../src/transaction");

function fakeProjectItem(initialPath) {
  let mediaPath = initialPath;
  let offline = false;
  return {
    canChangeMediaPath: async () => true,
    changeMediaFilePath: async (nextPath, override) => {
      assert.equal(override, false);
      mediaPath = nextPath;
      return true;
    },
    refreshMedia: async () => true,
    getMediaFilePath: async () => mediaPath,
    isOffline: async () => offline,
    currentPath: () => mediaPath,
    setMediaPath: (nextPath) => { mediaPath = nextPath; },
    setOffline: (nextOffline) => { offline = Boolean(nextOffline); },
  };
}

async function withTempFolder(run) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-batch-test-"));
  try {
    await run(folder);
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
}

async function createCleanupEvidence(folder, fileName, content) {
  const targetPath = path.join(folder, "batch", fileName);
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, content);
  return {
    targetPath,
    targetFingerprint: Transaction.fingerprintFromStat(await fs.lstat(targetPath)),
    projectItems: [fakeProjectItem(targetPath)],
  };
}

test("复制模式会依次校验、重链接全部工程项目、保存并删除源文件", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.bin");
    const target = path.join(folder, "batch", "source.bin");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, Buffer.from("material-data"));
    const originalSourceFingerprint = Transaction.fingerprintFromStat(await fs.lstat(source));
    const first = fakeProjectItem(source);
    const second = fakeProjectItem(source);
    let saves = 0;
    const result = await Transaction.moveAndRelink({
      fs,
      sourcePath: source,
      targetPath: target,
      projectItems: [first, second],
      forceMode: "copy",
      validate: async () => true,
      persistProject: async () => { saves += 1; return true; },
      wait: async () => {},
    });
    assert.equal(result.cleanupPending, false);
    assert.deepEqual(result.sourceFingerprint, originalSourceFingerprint);
    assert.equal(await Transaction.exists(fs, source), false);
    assert.equal(await fs.readFile(target, "utf8"), "material-data");
    assert.equal(first.currentPath(), target);
    assert.equal(second.currentPath(), target);
    assert.equal(saves, 1);
  });
});

test("整理操作必须移动文件，因此拒绝保留源文件", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.wav");
    const target = path.join(folder, "batch", "source.wav");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "voice");
    const item = fakeProjectItem(source);
    await assert.rejects(Transaction.moveAndRelink({
      fs,
      sourcePath: source,
      targetPath: target,
      projectItems: [item],
      forceMode: "copy",
      deleteSource: false,
      validate: async () => true,
      persistProject: async () => true,
      wait: async () => {},
    }), (error) => error.code === "MATERIAL_BATCH_RETAIN_SOURCE_BLOCKED");
    assert.equal(await Transaction.exists(fs, source), true);
    assert.equal(await Transaction.exists(fs, target), false);
    assert.equal(item.currentPath(), source);
  });
});

test("重链接前置失败不会被误记为 Premiere 已改链", async (t) => {
  await t.test("第二次权限检查拒绝时不记录 changed", async () => {
    await withTempFolder(async (folder) => {
      const source = path.join(folder, "source.mp4");
      const target = path.join(folder, "batch", "source.mp4");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(source, "video");
      let canChangeCalls = 0;
      let changeCalls = 0;
      let saveCalls = 0;
      const item = {
        async canChangeMediaPath() {
          canChangeCalls += 1;
          return canChangeCalls === 1;
        },
        async changeMediaFilePath() {
          changeCalls += 1;
          return true;
        },
        async refreshMedia() {},
        async getMediaFilePath() { return source; },
        async isOffline() { return false; },
      };

      let thrown;
      try {
        await Transaction.moveAndRelink({
          fs,
          sourcePath: source,
          targetPath: target,
          projectItems: [item],
          forceMode: "copy",
          validate: async () => true,
          persistProject: async () => { saveCalls += 1; return true; },
          wait: async () => {},
        });
      } catch (error) {
        thrown = error;
      }

      assert.ok(thrown);
      assert.match(thrown.message, /不允许修改/);
      assert.equal(changeCalls, 0);
      assert.equal(saveCalls, 0);
      assert.equal(
        (thrown.rollbackWarnings || []).some((warning) => /Premiere 指向新位置/.test(warning)),
        false,
      );
      assert.equal(await Transaction.exists(fs, source), true);
      assert.equal(await Transaction.exists(fs, target), false);
    });
  });

  await t.test("changeMediaFilePath 抛错但确认目标在线时带警告继续", async () => {
    await withTempFolder(async (folder) => {
      const source = path.join(folder, "source.mp4");
      const target = path.join(folder, "batch", "source.mp4");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(source, "video");
      let mediaPath = source;
      let saveCalls = 0;
      const item = {
        async canChangeMediaPath() { return true; },
        async changeMediaFilePath(nextPath) {
          mediaPath = nextPath;
          throw new Error("host returned an exception after relink");
        },
        async refreshMedia() {},
        async getMediaFilePath() { return mediaPath; },
        async isOffline() { return false; },
      };

      const result = await Transaction.moveAndRelink({
        fs,
        sourcePath: source,
        targetPath: target,
        projectItems: [item],
        forceMode: "copy",
        validate: async () => true,
        persistProject: async () => { saveCalls += 1; return true; },
        wait: async () => {},
      });

      assert.equal(mediaPath, target);
      assert.equal(saveCalls, 1);
      assert.ok(Array.isArray(result.warnings));
      assert.ok(result.warnings.some((warning) => /异常.*确认.*新位置/.test(warning)));
      assert.equal(await Transaction.exists(fs, source), false);
      assert.equal(await Transaction.exists(fs, target), true);
    });
  });

  await t.test("changeMediaFilePath 在改链前抛错时不记录 changed", async () => {
    await withTempFolder(async (folder) => {
      const source = path.join(folder, "source.mp4");
      const target = path.join(folder, "batch", "source.mp4");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(source, "video");
      let saveCalls = 0;
      const item = {
        async canChangeMediaPath() { return true; },
        async changeMediaFilePath() { throw new Error("nullptr before relink"); },
        async refreshMedia() {},
        async getMediaFilePath() { return source; },
        async isOffline() { return false; },
      };

      let thrown;
      try {
        await Transaction.moveAndRelink({
          fs,
          sourcePath: source,
          targetPath: target,
          projectItems: [item],
          forceMode: "copy",
          validate: async () => true,
          persistProject: async () => { saveCalls += 1; return true; },
          wait: async () => {},
        });
      } catch (error) {
        thrown = error;
      }

      assert.ok(thrown);
      assert.equal(saveCalls, 0);
      assert.equal(
        (thrown.rollbackWarnings || []).some((warning) => /Premiere 指向新位置/.test(warning)),
        false,
      );
      assert.equal(await Transaction.exists(fs, source), true);
      assert.equal(await Transaction.exists(fs, target), false);
    });
  });

  await t.test("changeMediaFilePath 抛错且后置状态不可读时保留两处现场", async () => {
    await withTempFolder(async (folder) => {
      const source = path.join(folder, "source.mp4");
      const target = path.join(folder, "batch", "source.mp4");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(source, "video");
      let saveCalls = 0;
      const item = {
        async canChangeMediaPath() { return true; },
        async changeMediaFilePath() { throw new Error("host interrupted"); },
        async refreshMedia() {},
        async getMediaFilePath() { throw new Error("path unavailable"); },
        async isOffline() { throw new Error("online state unavailable"); },
      };

      let thrown;
      try {
        await Transaction.moveAndRelink({
          fs,
          sourcePath: source,
          targetPath: target,
          projectItems: [item],
          forceMode: "copy",
          validate: async () => true,
          persistProject: async () => { saveCalls += 1; return true; },
          wait: async () => {},
        });
      } catch (error) {
        thrown = error;
      }

      assert.ok(thrown);
      assert.equal(thrown.code, "MATERIAL_BATCH_RELINK_UNCERTAIN");
      assert.equal(saveCalls, 0);
      assert.ok((thrown.rollbackWarnings || []).some((warning) => /无法确认 Premiere 当前链接/.test(warning)));
      assert.equal(await Transaction.exists(fs, source), true);
      assert.equal(await Transaction.exists(fs, target), true);
    });
  });
});

test("改链前素材已经被用户改到第三路径时，不改链、不保存且保留目标回滚现场", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const thirdPath = path.join(folder, "another-location.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "video");
    await fs.writeFile(thirdPath, "user-replacement");
    let pathReads = 0;
    let changeCalls = 0;
    let saveCalls = 0;
    const item = {
      async canChangeMediaPath() { return true; },
      async changeMediaFilePath() { changeCalls += 1; return true; },
      async refreshMedia() {},
      async getMediaFilePath() {
        pathReads += 1;
        return pathReads < 2 ? source : thirdPath;
      },
      async isOffline() { return false; },
    };

    await assert.rejects(Transaction.moveAndRelink({
      fs,
      sourcePath: source,
      targetPath: target,
      projectItems: [item],
      forceMode: "copy",
      validate: async () => true,
      persistProject: async () => { saveCalls += 1; return true; },
      wait: async () => {},
    }), (error) => error.code === "MATERIAL_BATCH_RELINK_SOURCE_CHANGED");

    assert.equal(changeCalls, 0);
    assert.equal(saveCalls, 0);
    assert.equal(await fs.readFile(source, "utf8"), "video");
    assert.equal(await fs.readFile(thirdPath, "utf8"), "user-replacement");
    assert.equal(await Transaction.exists(fs, target), true, "链接状态不确定时应保留插件创建的目标现场");
    assert.equal(await fs.readFile(target, "utf8"), "video");
  });
});

test("refreshMedia 失败后以路径和在线状态决定继续或保留现场", async (t) => {
  await t.test("目标路径在线时带警告完成事务", async () => {
    await withTempFolder(async (folder) => {
      const source = path.join(folder, "source.mp4");
      const target = path.join(folder, "batch", "source.mp4");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(source, "video");
      let mediaPath = source;
      let saveCalls = 0;
      const item = {
        async canChangeMediaPath() { return true; },
        async changeMediaFilePath(nextPath) { mediaPath = nextPath; return true; },
        async refreshMedia() { throw new Error("refresh unavailable"); },
        async getMediaFilePath() { return mediaPath; },
        async isOffline() { return false; },
      };

      const result = await Transaction.moveAndRelink({
        fs,
        sourcePath: source,
        targetPath: target,
        projectItems: [item],
        forceMode: "copy",
        validate: async () => true,
        persistProject: async () => { saveCalls += 1; return true; },
        wait: async () => {},
      });

      assert.equal(mediaPath, target);
      assert.equal(saveCalls, 1);
      assert.equal(await Transaction.exists(fs, source), false);
      assert.equal(await Transaction.exists(fs, target), true);
      assert.ok(Array.isArray(result.warnings));
      assert.ok(result.warnings.some((warning) => /刷新|refreshMedia/.test(warning)));
    });
  });

  await t.test("路径和在线状态无法确认时保留源与目标并且不保存", async () => {
    await withTempFolder(async (folder) => {
      const source = path.join(folder, "source.mp4");
      const target = path.join(folder, "batch", "source.mp4");
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(source, "video");
      let saveCalls = 0;
      const item = {
        async canChangeMediaPath() { return true; },
        async changeMediaFilePath() { return true; },
        async refreshMedia() { throw new Error("refresh unavailable"); },
        async getMediaFilePath() { throw new Error("path unavailable"); },
        async isOffline() { throw new Error("online state unavailable"); },
      };

      let thrown;
      try {
        await Transaction.moveAndRelink({
          fs,
          sourcePath: source,
          targetPath: target,
          projectItems: [item],
          forceMode: "copy",
          validate: async () => true,
          persistProject: async () => { saveCalls += 1; return true; },
          wait: async () => {},
        });
      } catch (error) {
        thrown = error;
      }

      assert.ok(thrown);
      assert.equal(saveCalls, 0);
      assert.equal(await Transaction.exists(fs, source), true);
      assert.equal(await Transaction.exists(fs, target), true);
      assert.ok((thrown.rollbackWarnings || []).some((warning) => /保留|检查|指向新位置/.test(warning)));
    });
  });
});

test("路径检查只会把确认缺失的文件视为不存在", async () => {
  const missingError = Object.assign(new Error("missing"), { code: "ENOENT" });
  const uxpMissingError = new Error("no such file or directory");
  const deniedError = Object.assign(new Error("access denied"), { code: "EACCES" });

  assert.equal(await Transaction.exists({ lstat: async () => { throw missingError; } }, "C:\\missing.mov"), false);
  assert.equal(await Transaction.exists({ lstat: async () => { throw uxpMissingError; } }, "C:\\uxp-missing.mov"), false);
  await assert.rejects(
    Transaction.exists({ lstat: async () => { throw deniedError; } }, "C:\\locked.mov"),
    (error) => error === deniedError,
  );
});

test("运行时只有源文件与已创建目标目录 dev 相等才使用同卷模式", async () => {
  const stats = {
    "/Volumes/素材盘/source.wav": { dev: 17 },
    "/Volumes/素材盘/项目/素材/001_初始素材": { dev: 17 },
    "/Volumes/外置盘/项目/素材/001_初始素材": { dev: 22 },
  };
  const fakeFs = {
    lstat: async (nativePath) => {
      if (stats[nativePath]) return stats[nativePath];
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    },
  };
  assert.equal((await Transaction.resolveMoveMode(fakeFs, "/Volumes/素材盘/source.wav", "/Volumes/素材盘/项目/素材/001_初始素材")).mode, "rename");
  assert.equal((await Transaction.resolveMoveMode(fakeFs, "/Volumes/素材盘/source.wav", "/Volumes/外置盘/项目/素材/001_初始素材")).mode, "copy");
  assert.equal((await Transaction.resolveMoveMode(fakeFs, "/Volumes/素材盘/missing.wav", "/Volumes/素材盘/项目/素材/001_初始素材")).mode, "copy");
});

test("未指定模式时事务使用已读取的源文件和目标目录卷证据", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mov");
    const target = path.join(folder, "batch", "source.mov");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "same-volume");
    const result = await Transaction.moveAndRelink({
      fs,
      sourcePath: source,
      targetPath: target,
      projectItems: [fakeProjectItem(source)],
      validate: async () => true,
      persistProject: async () => true,
      wait: async () => {},
    });
    assert.equal(result.mode, "rename");
    assert.equal(result.modeEvidence.proven, true);
    assert.equal(result.modeEvidence.sourceDev, result.modeEvidence.targetDev);
  });
});

test("源文件删除失败时保持 cleanup-pending，而不会报告成功", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "video");
    const item = fakeProjectItem(source);
    const failingFs = {
      ...fs,
      rename: async (nativePath, nextPath) => {
        if (nativePath === source && nextPath.endsWith(".pending-delete")) throw new Error("file is in use");
        return fs.rename(nativePath, nextPath);
      },
    };

    const result = await Transaction.moveAndRelink({
      fs: failingFs,
      sourcePath: source,
      targetPath: target,
      projectItems: [item],
      forceMode: "copy",
      validate: async () => true,
      persistProject: async () => true,
      wait: async () => {},
    });

    assert.equal(result.cleanupPending, true);
    assert.match(result.cleanupWarning, /待删除的原素材仍在/);
    assert.equal(await Transaction.exists(fs, source), true);
    assert.equal(await Transaction.exists(fs, target), true);
    assert.equal(item.currentPath(), target);
  });
});

test("隔离后无法删除的源文件仍可恢复", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    const transactionId = "tx-locked-cleanup";
    const cleanupPath = Transaction.cleanupPathFor(source, transactionId);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "video");
    const item = fakeProjectItem(source);
    const failingFs = {
      ...fs,
      unlink: async (nativePath) => {
        if (nativePath === cleanupPath) throw new Error("file is in use");
        return fs.unlink(nativePath);
      },
    };

    const result = await Transaction.moveAndRelink({
      id: transactionId,
      fs: failingFs,
      sourcePath: source,
      targetPath: target,
      cleanupPath,
      projectItems: [item],
      forceMode: "copy",
      validate: async () => true,
      persistProject: async () => true,
      wait: async () => {},
    });

    assert.equal(result.cleanupPending, true);
    assert.match(result.cleanupWarning, new RegExp(cleanupPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(await Transaction.exists(fs, source), false);
    assert.equal(await fs.readFile(cleanupPath, "utf8"), "video");
    assert.equal(await fs.readFile(target, "utf8"), "video");
    assert.equal(item.currentPath(), target);
  });
});

test("恢复阶段的小文件清理必须经过隔离和重复核验", async (t) => {
  await t.test("源文件身份稳定时先隔离再删除", async () => {
    await withTempFolder(async (folder) => {
      const source = path.join(folder, "source.txt");
      const cleanupPath = Transaction.cleanupPathFor(source, "cleanup-normal");
      await fs.writeFile(source, "small-file");
      const sourceFingerprint = Transaction.fingerprintFromStat(await fs.lstat(source));
      const evidence = await createCleanupEvidence(folder, "source.txt", "small-file");
      const events = [];
      const trackingFs = {
        ...fs,
        async rename(from, to) {
          events.push(["rename", from, to]);
          return fs.rename(from, to);
        },
        async unlink(nativePath) {
          events.push(["unlink", nativePath]);
          return fs.unlink(nativePath);
        },
      };

      const result = await Transaction.cleanupVerifiedSource({
        id: "cleanup-normal",
        fs: trackingFs,
        sourcePath: source,
        cleanupPath,
        sourceFingerprint,
        ...evidence,
        validate: async () => true,
        cleanupWait: async () => { events.push(["wait"]); },
      });

      assert.equal(result.cleanupPending, false);
      assert.equal(result.sourceChanged, false);
      assert.equal(result.cleanupWarning, "");
      assert.equal(result.remainingSourcePath, "");
      assert.deepEqual(events.map((event) => event[0]), ["rename", "wait", "unlink"]);
      assert.equal(await Transaction.exists(fs, source), false);
      assert.equal(await Transaction.exists(fs, cleanupPath), false);
    });
  });

  await t.test("原位置文件身份变化时保留新文件", async () => {
    await withTempFolder(async (folder) => {
      const source = path.join(folder, "source.txt");
      const cleanupPath = Transaction.cleanupPathFor(source, "cleanup-source-changed");
      await fs.writeFile(source, "original");
      const sourceFingerprint = Transaction.fingerprintFromStat(await fs.lstat(source));
      const evidence = await createCleanupEvidence(folder, "source.txt", "original");
      await fs.writeFile(source, "replacement-file");
      let renameCalls = 0;
      let unlinkCalls = 0;
      const trackingFs = {
        ...fs,
        async rename(...args) { renameCalls += 1; return fs.rename(...args); },
        async unlink(...args) { unlinkCalls += 1; return fs.unlink(...args); },
      };

      const result = await Transaction.cleanupVerifiedSource({
        id: "cleanup-source-changed",
        fs: trackingFs,
        sourcePath: source,
        cleanupPath,
        sourceFingerprint,
        ...evidence,
        validate: async () => true,
        cleanupWait: async () => {},
      });

      assert.equal(result.cleanupPending, false);
      assert.equal(result.sourceChanged, true);
      assert.equal(result.remainingSourcePath, source);
      assert.match(result.cleanupWarning, /原路径.*另一份文件|未删除这份新文件/);
      assert.equal(renameCalls, 0);
      assert.equal(unlinkCalls, 0);
      assert.equal(await fs.readFile(source, "utf8"), "replacement-file");
      assert.equal(await Transaction.exists(fs, cleanupPath), false);
    });
  });

  await t.test("隔离文件在稳定等待期间变化时保留 cleanup", async () => {
    await withTempFolder(async (folder) => {
      const source = path.join(folder, "source.txt");
      const cleanupPath = Transaction.cleanupPathFor(source, "cleanup-mutated");
      await fs.writeFile(source, "original");
      const sourceFingerprint = Transaction.fingerprintFromStat(await fs.lstat(source));
      const evidence = await createCleanupEvidence(folder, "source.txt", "original");
      let unlinkCalls = 0;
      const trackingFs = {
        ...fs,
        async unlink(...args) { unlinkCalls += 1; return fs.unlink(...args); },
      };

      const result = await Transaction.cleanupVerifiedSource({
        id: "cleanup-mutated",
        fs: trackingFs,
        sourcePath: source,
        cleanupPath,
        sourceFingerprint,
        ...evidence,
        validate: async () => true,
        cleanupWait: async () => { await fs.writeFile(cleanupPath, "changed-during-wait"); },
      });

      assert.equal(result.cleanupPending, true);
      assert.equal(result.sourceChanged, false);
      assert.equal(result.remainingSourcePath, cleanupPath);
      assert.match(result.cleanupWarning, /仍在|未自动删除/);
      assert.equal(unlinkCalls, 0);
      assert.equal(await Transaction.exists(fs, source), false);
      assert.equal(await fs.readFile(cleanupPath, "utf8"), "changed-during-wait");
    });
  });

  await t.test("活动工程在最终删除前切换时保留 cleanup", async () => {
    await withTempFolder(async (folder) => {
      const source = path.join(folder, "source.txt");
      const cleanupPath = Transaction.cleanupPathFor(source, "cleanup-context-change");
      await fs.writeFile(source, "original");
      const sourceFingerprint = Transaction.fingerprintFromStat(await fs.lstat(source));
      const evidence = await createCleanupEvidence(folder, "source.txt", "original");
      let validations = 0;
      let unlinkCalls = 0;
      const trackingFs = {
        ...fs,
        async unlink(...args) { unlinkCalls += 1; return fs.unlink(...args); },
      };

      const result = await Transaction.cleanupVerifiedSource({
        id: "cleanup-context-change",
        fs: trackingFs,
        sourcePath: source,
        cleanupPath,
        sourceFingerprint,
        ...evidence,
        validate: async () => {
          validations += 1;
          return validations < 3;
        },
        cleanupWait: async () => {},
      });

      assert.equal(validations, 3);
      assert.equal(result.cleanupPending, true);
      assert.equal(result.sourceChanged, false);
      assert.equal(result.remainingSourcePath, cleanupPath);
      assert.match(result.cleanupWarning, /仍在|未自动删除/);
      assert.equal(unlinkCalls, 0);
      assert.equal(await Transaction.exists(fs, source), false);
      assert.equal(await fs.readFile(cleanupPath, "utf8"), "original");
    });
  });
});

test("moveAndRelink 删除前的最终核验会拦住竞态变化", async (t) => {
  await t.test("目标被同大小同修改时间的另一文件替换时保留 cleanup", async () => {
    await withTempFolder(async (folder) => {
      const source = path.join(folder, "source.mp4");
      const target = path.join(folder, "batch", "source.mp4");
      const cleanupPath = Transaction.cleanupPathFor(source, "move-target-replaced");
      const replacementPath = target + ".replacement";
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(source, "original");
      const item = fakeProjectItem(source);
      let expectedTargetFingerprint = null;
      let targetReplaced = false;
      let originalDeleteCalls = 0;
      const racingFs = {
        ...fs,
        async lstat(nativePath) {
          const stat = await fs.lstat(nativePath);
          if (targetReplaced && nativePath === target) {
            stat.mtimeMs = expectedTargetFingerprint.mtimeMs;
            stat.ctimeMs = (Number(expectedTargetFingerprint.ctimeMs) || 1) + 1;
            stat.ino = (Number(expectedTargetFingerprint.ino) || 1) + 1;
          }
          return stat;
        },
        async unlink(nativePath) {
          if (nativePath === source || nativePath === cleanupPath) originalDeleteCalls += 1;
          return fs.unlink(nativePath);
        },
      };

      const result = await Transaction.moveAndRelink({
        id: "move-target-replaced",
        fs: racingFs,
        sourcePath: source,
        targetPath: target,
        cleanupPath,
        projectItems: [item],
        forceMode: "copy",
        validate: async () => true,
        persistProject: async () => true,
        wait: async () => {},
        cleanupWait: async () => {},
        beforeDelete: async (details) => {
          expectedTargetFingerprint = details.targetFingerprint;
          await fs.writeFile(replacementPath, Buffer.alloc(expectedTargetFingerprint.size, 0x78));
          await fs.utimes(
            replacementPath,
            new Date(expectedTargetFingerprint.mtimeMs),
            new Date(expectedTargetFingerprint.mtimeMs),
          );
          await fs.unlink(target);
          await fs.rename(replacementPath, target);
          targetReplaced = true;
          const replacementFingerprint = Transaction.fingerprintFromStat(await racingFs.lstat(target));
          assert.equal(Transaction.samePortableFingerprint(expectedTargetFingerprint, replacementFingerprint), true);
          assert.equal(Transaction.sameFingerprint(expectedTargetFingerprint, replacementFingerprint), false);
          return true;
        },
      });

      assert.equal(targetReplaced, true);
      assert.equal(originalDeleteCalls, 0);
      assert.equal(result.cleanupPending, true);
      assert.match(result.cleanupWarning, /仍在|未自动删除|未删除/);
      assert.equal(await Transaction.exists(fs, source), false);
      assert.equal(await fs.readFile(cleanupPath, "utf8"), "original");
      assert.equal((await fs.readFile(target)).equals(Buffer.alloc(8, 0x78)), true);
      assert.equal(item.currentPath(), target);
    });
  });

  for (const scenario of [
    {
      name: "Premiere 素材被改回源路径时保留 cleanup",
      mutate(item, sourcePath) { item.setMediaPath(sourcePath); },
    },
    {
      name: "Premiere 素材变为离线时保留 cleanup",
      mutate(item) { item.setOffline(true); },
    },
  ]) {
    await t.test(scenario.name, async () => {
      await withTempFolder(async (folder) => {
        const source = path.join(folder, "source.mp4");
        const target = path.join(folder, "batch", "source.mp4");
        const transactionId = scenario.name.includes("离线") ? "move-link-offline" : "move-link-source";
        const cleanupPath = Transaction.cleanupPathFor(source, transactionId);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(source, "original");
        const item = fakeProjectItem(source);
        let originalDeleteCalls = 0;
        const trackingFs = {
          ...fs,
          async unlink(nativePath) {
            if (nativePath === source || nativePath === cleanupPath) originalDeleteCalls += 1;
            return fs.unlink(nativePath);
          },
        };

        const result = await Transaction.moveAndRelink({
          id: transactionId,
          fs: trackingFs,
          sourcePath: source,
          targetPath: target,
          cleanupPath,
          projectItems: [item],
          forceMode: "copy",
          validate: async () => true,
          persistProject: async () => true,
          wait: async () => {},
          cleanupWait: async () => {},
          beforeDelete: async () => {
            scenario.mutate(item, source);
            return true;
          },
        });

        assert.equal(originalDeleteCalls, 0);
        assert.equal(result.cleanupPending, true);
        assert.match(result.cleanupWarning, /仍在|未自动删除|未删除/);
        assert.equal(await Transaction.exists(fs, source), false);
        assert.equal(await fs.readFile(cleanupPath, "utf8"), "original");
        assert.equal(await fs.readFile(target, "utf8"), "original");
      });
    });
  }
});

test("beforeSourceCleanup 在源文件隔离前阻断清理", async (t) => {
  for (const scenario of [
    {
      name: "门禁回调抛错",
      guard: async () => { throw new Error("source cleanup guard failed"); },
    },
    {
      name: "门禁回调返回 false",
      guard: async () => false,
    },
  ]) {
    await t.test(scenario.name, async () => {
      await withTempFolder(async (folder) => {
        const source = path.join(folder, "source.mp4");
        const target = path.join(folder, "batch", "source.mp4");
        const cleanupPath = Transaction.cleanupPathFor(source, "before-source-cleanup");
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(source, "original");
        const renameEvents = [];
        const unlinkEvents = [];
        const trackingFs = {
          ...fs,
          async rename(from, to) {
            renameEvents.push([from, to]);
            return fs.rename(from, to);
          },
          async unlink(nativePath) {
            unlinkEvents.push(nativePath);
            return fs.unlink(nativePath);
          },
        };
        const item = fakeProjectItem(source);
        let guardCalls = 0;

        const result = await Transaction.moveAndRelink({
          id: "before-source-cleanup",
          fs: trackingFs,
          sourcePath: source,
          targetPath: target,
          cleanupPath,
          projectItems: [item],
          forceMode: "copy",
          validate: async () => true,
          persistProject: async () => true,
          wait: async () => {},
          cleanupWait: async () => {},
          beforeSourceCleanup: async (details) => {
            guardCalls += 1;
            assert.equal(details.sourcePath, source);
            assert.equal(details.cleanupPath, cleanupPath);
            assert.equal(await Transaction.exists(fs, source), true);
            assert.equal(await Transaction.exists(fs, cleanupPath), false);
            assert.equal(await Transaction.exists(fs, target), true);
            assert.equal(renameEvents.some(([from, to]) => from === source && to === cleanupPath), false);
            return scenario.guard();
          },
        });

        assert.equal(guardCalls, 1);
        assert.equal(result.cleanupPending, true);
        assert.equal(await fs.readFile(source, "utf8"), "original");
        assert.equal(await Transaction.exists(fs, cleanupPath), false);
        assert.equal(await fs.readFile(target, "utf8"), "original");
        assert.equal(renameEvents.some(([from, to]) => from === source && to === cleanupPath), false);
        assert.equal(unlinkEvents.includes(source), false);
        assert.equal(unlinkEvents.includes(cleanupPath), false);
      });
    });

    await t.test(`${scenario.name}（恢复入口）`, async () => {
      await withTempFolder(async (folder) => {
        const source = path.join(folder, "source.mp4");
        const cleanupPath = Transaction.cleanupPathFor(source, "before-source-cleanup-recovery");
        await fs.writeFile(source, "original");
        const sourceFingerprint = Transaction.fingerprintFromStat(await fs.lstat(source));
        const evidence = await createCleanupEvidence(folder, "source.mp4", "original");
        const renameEvents = [];
        const unlinkEvents = [];
        const trackingFs = {
          ...fs,
          async rename(from, to) {
            renameEvents.push([from, to]);
            return fs.rename(from, to);
          },
          async unlink(nativePath) {
            unlinkEvents.push(nativePath);
            return fs.unlink(nativePath);
          },
        };
        let guardCalls = 0;

        const result = await Transaction.cleanupVerifiedSource({
          id: "before-source-cleanup-recovery",
          fs: trackingFs,
          sourcePath: source,
          cleanupPath,
          sourceFingerprint,
          ...evidence,
          validate: async () => true,
          wait: async () => {},
          cleanupWait: async () => {},
          beforeSourceCleanup: async (details) => {
            guardCalls += 1;
            assert.equal(details.sourcePath, source);
            assert.equal(details.cleanupPath, cleanupPath);
            assert.equal(await Transaction.exists(fs, source), true);
            assert.equal(await Transaction.exists(fs, cleanupPath), false);
            assert.equal(await Transaction.exists(fs, evidence.targetPath), true);
            assert.equal(renameEvents.some(([from, to]) => from === source && to === cleanupPath), false);
            return scenario.guard();
          },
        });

        assert.equal(guardCalls, 1);
        assert.equal(result.cleanupPending, true);
        assert.equal(await fs.readFile(source, "utf8"), "original");
        assert.equal(await Transaction.exists(fs, cleanupPath), false);
        assert.equal(await fs.readFile(evidence.targetPath, "utf8"), "original");
        assert.equal(renameEvents.some(([from, to]) => from === source && to === cleanupPath), false);
        assert.equal(unlinkEvents.includes(source), false);
        assert.equal(unlinkEvents.includes(cleanupPath), false);
      });
    });
  }
});

test("cleanupVerifiedSource 删除前的最终核验会拦住竞态变化", async (t) => {
  await t.test("目标被同大小同修改时间的另一文件替换时绝不删除 cleanup", async () => {
    await withTempFolder(async (folder) => {
      const source = path.join(folder, "source.mp4");
      const cleanupPath = Transaction.cleanupPathFor(source, "recovery-target-replaced");
      await fs.writeFile(source, "original");
      const sourceFingerprint = Transaction.fingerprintFromStat(await fs.lstat(source));
      const evidence = await createCleanupEvidence(folder, "source.mp4", "original");
      const replacementPath = evidence.targetPath + ".replacement";
      let targetReplaced = false;
      let originalDeleteCalls = 0;
      const racingFs = {
        ...fs,
        async lstat(nativePath) {
          const stat = await fs.lstat(nativePath);
          if (targetReplaced && nativePath === evidence.targetPath) {
            stat.mtimeMs = evidence.targetFingerprint.mtimeMs;
            stat.ctimeMs = (Number(evidence.targetFingerprint.ctimeMs) || 1) + 1;
            stat.ino = (Number(evidence.targetFingerprint.ino) || 1) + 1;
          }
          return stat;
        },
        async unlink(nativePath) {
          if (nativePath === source || nativePath === cleanupPath) originalDeleteCalls += 1;
          return fs.unlink(nativePath);
        },
      };

      const result = await Transaction.cleanupVerifiedSource({
        id: "recovery-target-replaced",
        fs: racingFs,
        sourcePath: source,
        cleanupPath,
        sourceFingerprint,
        ...evidence,
        validate: async () => true,
        wait: async () => {},
        cleanupWait: async () => {},
        beforeDelete: async () => {
          await fs.writeFile(replacementPath, Buffer.alloc(evidence.targetFingerprint.size, 0x78));
          await fs.utimes(
            replacementPath,
            new Date(evidence.targetFingerprint.mtimeMs),
            new Date(evidence.targetFingerprint.mtimeMs),
          );
          await fs.unlink(evidence.targetPath);
          await fs.rename(replacementPath, evidence.targetPath);
          targetReplaced = true;
          const replacementFingerprint = Transaction.fingerprintFromStat(await racingFs.lstat(evidence.targetPath));
          assert.equal(Transaction.samePortableFingerprint(evidence.targetFingerprint, replacementFingerprint), true);
          assert.equal(Transaction.sameFingerprint(evidence.targetFingerprint, replacementFingerprint), false);
          return true;
        },
      });

      assert.equal(targetReplaced, true);
      assert.equal(originalDeleteCalls, 0);
      assert.equal(result.cleanupPending, true);
      assert.equal(result.remainingSourcePath, cleanupPath);
      assert.equal(await Transaction.exists(fs, source), false);
      assert.equal(await fs.readFile(cleanupPath, "utf8"), "original");
    });
  });

  for (const scenario of [
    {
      name: "Premiere 素材被改回源路径时绝不删除 cleanup",
      mutate(item, sourcePath) { item.setMediaPath(sourcePath); },
    },
    {
      name: "Premiere 素材变为离线时绝不删除 cleanup",
      mutate(item) { item.setOffline(true); },
    },
  ]) {
    await t.test(scenario.name, async () => {
      await withTempFolder(async (folder) => {
        const source = path.join(folder, "source.mp4");
        const transactionId = scenario.name.includes("离线") ? "recovery-link-offline" : "recovery-link-source";
        const cleanupPath = Transaction.cleanupPathFor(source, transactionId);
        await fs.writeFile(source, "original");
        const sourceFingerprint = Transaction.fingerprintFromStat(await fs.lstat(source));
        const evidence = await createCleanupEvidence(folder, "source.mp4", "original");
        const item = evidence.projectItems[0];
        let originalDeleteCalls = 0;
        const trackingFs = {
          ...fs,
          async unlink(nativePath) {
            if (nativePath === source || nativePath === cleanupPath) originalDeleteCalls += 1;
            return fs.unlink(nativePath);
          },
        };

        const result = await Transaction.cleanupVerifiedSource({
          id: transactionId,
          fs: trackingFs,
          sourcePath: source,
          cleanupPath,
          sourceFingerprint,
          ...evidence,
          validate: async () => true,
          wait: async () => {},
          cleanupWait: async () => {},
          beforeDelete: async () => {
            scenario.mutate(item, source);
            return true;
          },
        });

        assert.equal(originalDeleteCalls, 0);
        assert.equal(result.cleanupPending, true);
        assert.equal(result.remainingSourcePath, cleanupPath);
        assert.equal(await Transaction.exists(fs, source), false);
        assert.equal(await fs.readFile(cleanupPath, "utf8"), "original");
        assert.equal(await fs.readFile(evidence.targetPath, "utf8"), "original");
      });
    });
  }
});

test("同卷硬链接在工程保存失败时保留两条路径及 Premiere 新链接", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "video");
    const item = fakeProjectItem(source);
    let saves = 0;
    await assert.rejects(
      Transaction.moveAndRelink({
        fs,
        sourcePath: source,
        targetPath: target,
        projectItems: [item],
        forceMode: "rename",
        validate: async () => true,
        persistProject: async () => {
          saves += 1;
          return saves > 1;
        },
        wait: async () => {},
      }),
      (error) => {
        assert.match(error.message, /Premiere 工程保存失败/);
        assert.ok(error.rollbackWarnings.some((warning) => /保持 Premiere 指向新位置/.test(warning)));
        return true;
      },
    );
    assert.equal(await Transaction.exists(fs, source), true);
    assert.equal(await fs.readFile(target, "utf8"), "video");
    assert.equal(item.currentPath(), target);
    assert.equal(saves, 1);
  });
});

test("同卷硬链接清理时刷新目标检查点并正常删除源文件", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "video");
    const item = fakeProjectItem(source);
    let linkCalls = 0;
    let copyCalls = 0;
    const trackingFs = {
      ...fs,
      link: async (...args) => {
        linkCalls += 1;
        return fs.link(...args);
      },
      copyFile: async () => {
        copyCalls += 1;
        throw new Error("same-volume path must not call copyFile");
      },
    };

    const result = await Transaction.moveAndRelink({
      fs: trackingFs,
      sourcePath: source,
      targetPath: target,
      projectItems: [item],
      forceMode: "rename",
      validate: async () => true,
      persistProject: async () => true,
      wait: async () => {},
    });

    assert.equal(result.cleanupPending, false);
    assert.equal(result.cleanupWarning, "");
    assert.equal(linkCalls, 1);
    assert.equal(copyCalls, 0);
    assert.equal(await Transaction.exists(fs, source), false);
    assert.equal(await Transaction.exists(fs, result.cleanupPath), false);
    assert.equal(await fs.readFile(target, "utf8"), "video");
    assert.equal(item.currentPath(), target);
    assert.equal(result.targetMethod, "link");
    assert.equal(
      Transaction.samePathFingerprint(
        result.targetFingerprint,
        Transaction.fingerprintFromStat(await fs.lstat(target)),
      ),
      true,
    );
  });
});

test("源文件缺少可靠身份时在同盘和跨盘模式都保持原位且不创建目标", async () => {
  for (const forceMode of ["rename", "copy"]) await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "video");
    const item = fakeProjectItem(source);
    let linkCalls = 0;
    let copyCalls = 0;
    let targetUnlinkCalls = 0;
    let renameCalls = 0;
    const identityBlindFs = {
      ...fs,
      async lstat(nativePath) {
        const stat = await fs.lstat(nativePath);
        return {
          ...stat,
          dev: 0,
          ino: 0,
          isFile: () => stat.isFile(),
          isDirectory: () => stat.isDirectory(),
        };
      },
      async link(from, to) {
        linkCalls += 1;
        return fs.link(from, to);
      },
      async unlink(nativePath) {
        if (nativePath === target) targetUnlinkCalls += 1;
        return fs.unlink(nativePath);
      },
      async copyFile() {
        copyCalls += 1;
        throw new Error("身份不足时不应复制文件");
      },
      async rename(...args) {
        renameCalls += 1;
        return fs.rename(...args);
      },
    };

    await assert.rejects(Transaction.moveAndRelink({
      fs: identityBlindFs,
      sourcePath: source,
      targetPath: target,
      projectItems: [item],
      forceMode,
      validate: async () => true,
      persistProject: async () => true,
      wait: async () => {},
    }), /未提供可验证的文件身份/);

    assert.equal(linkCalls, 0);
    assert.equal(targetUnlinkCalls, 0);
    assert.equal(copyCalls, 0);
    assert.equal(renameCalls, 0);
    assert.equal(await fs.readFile(source, "utf8"), "video");
    assert.equal(await Transaction.exists(fs, target), false);
    assert.equal(item.currentPath(), source);
  });
});

test("目标占位缺少可靠身份时不覆盖源文件且不删除占位", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "video");
    const item = fakeProjectItem(source);
    let renameCalls = 0;
    let targetUnlinkCalls = 0;
    const targetIdentityBlindFs = {
      ...fs,
      async lstat(nativePath) {
        const stat = await fs.lstat(nativePath);
        if (nativePath !== target) return stat;
        return {
          ...stat,
          dev: 0,
          ino: 0,
          isFile: () => stat.isFile(),
          isDirectory: () => stat.isDirectory(),
        };
      },
      async rename(...args) {
        renameCalls += 1;
        return fs.rename(...args);
      },
      async unlink(nativePath) {
        if (nativePath === target) targetUnlinkCalls += 1;
        return fs.unlink(nativePath);
      },
    };

    await assert.rejects(Transaction.moveAndRelink({
      fs: targetIdentityBlindFs,
      sourcePath: source,
      targetPath: target,
      projectItems: [item],
      forceMode: "rename",
      validate: async () => true,
      persistProject: async () => true,
      wait: async () => {},
    }), (error) => {
      assert.match(error.message, /目标占位身份|建立目标文件后无法证明/);
      assert.ok(error.rollbackWarnings.some((warning) => /未自动删除/.test(warning)));
      return true;
    });

    assert.equal(renameCalls, 0);
    assert.equal(targetUnlinkCalls, 0);
    assert.equal(await fs.readFile(source, "utf8"), "video");
    assert.equal((await fs.lstat(target)).size, 5n);
    assert.equal(item.currentPath(), source);
  });
});

test("硬链接建立后身份证据缺失时保留两处文件且不进入回退删除", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "video");
    const item = fakeProjectItem(source);
    let linkCalls = 0;
    let targetUnlinkCalls = 0;
    let renameCalls = 0;
    const targetIdentityBlindFs = {
      ...fs,
      async lstat(nativePath) {
        const stat = await fs.lstat(nativePath);
        if (nativePath !== target) return stat;
        return {
          ...stat,
          dev: 0,
          ino: 0,
          isFile: () => stat.isFile(),
          isDirectory: () => stat.isDirectory(),
        };
      },
      async link(from, to) {
        linkCalls += 1;
        return fs.link(from, to);
      },
      async unlink(nativePath) {
        if (nativePath === target) targetUnlinkCalls += 1;
        return fs.unlink(nativePath);
      },
      async rename(...args) {
        renameCalls += 1;
        return fs.rename(...args);
      },
    };

    await assert.rejects(Transaction.moveAndRelink({
      fs: targetIdentityBlindFs,
      sourcePath: source,
      targetPath: target,
      projectItems: [item],
      forceMode: "rename",
      validate: async () => true,
      persistProject: async () => true,
      wait: async () => {},
    }), (error) => {
      assert.match(error.message, /无法证明.*源文件相同/);
      assert.ok(error.rollbackWarnings.some((warning) => /未自动删除|保留/.test(warning)));
      return true;
    });

    assert.equal(linkCalls, 1);
    assert.equal(targetUnlinkCalls, 0);
    assert.equal(renameCalls, 0);
    assert.equal(await fs.readFile(source, "utf8"), "video");
    assert.equal(await fs.readFile(target, "utf8"), "video");
    assert.equal(item.currentPath(), source);
  });
});

test("恢复清理会用强硬链接身份跨过合法 ctime 变化并返回删除后的目标指纹", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    const cleanupPath = Transaction.cleanupPathFor(source, "hard-link-recovery");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "video");
    await fs.link(source, target);
    const sourceFingerprint = Transaction.fingerprintFromStat(await fs.lstat(source));
    const targetCheckpoint = Transaction.fingerprintFromStat(await fs.lstat(target));
    targetCheckpoint.ctimeMs += 10000;
    await fs.rename(source, cleanupPath);
    const item = fakeProjectItem(target);

    const result = await Transaction.cleanupVerifiedSource({
      id: "hard-link-recovery",
      fs,
      sourcePath: source,
      cleanupPath,
      sourceFingerprint,
      targetPath: target,
      targetFingerprint: targetCheckpoint,
      targetMethod: "link",
      projectItems: [item],
      validate: async () => true,
      wait: async () => {},
      cleanupWait: async () => {},
    });

    const finalTargetFingerprint = Transaction.fingerprintFromStat(await fs.lstat(target));
    assert.equal(result.cleanupPending, false);
    assert.equal(result.targetMethod, "link");
    assert.equal(await Transaction.exists(fs, source), false);
    assert.equal(await Transaction.exists(fs, cleanupPath), false);
    assert.equal(Transaction.samePathFingerprint(result.targetFingerprint, finalTargetFingerprint), true);
    assert.equal(Transaction.sameHardLinkRecoveryFingerprint(targetCheckpoint, finalTargetFingerprint), true);
  });
});

test("强硬链接恢复比较必须具有相同且有效的 dev 与 ino", () => {
  const base = { size: 8, mtimeMs: 1000, ctimeMs: 2000, birthtimeMs: 500, dev: 3, ino: 7 };
  assert.equal(Transaction.sameHardLinkRecoveryFingerprint(base, { ...base, ctimeMs: 9000 }), true);
  assert.equal(Transaction.sameHardLinkRecoveryFingerprint(base, { ...base, ctimeMs: 9000, ino: 8 }), false);
  assert.equal(Transaction.sameHardLinkRecoveryFingerprint(base, { ...base, ctimeMs: 9000, ino: 0 }), false);
  assert.equal(Transaction.sameHardLinkRecoveryFingerprint(base, { ...base, ctimeMs: 9000, dev: 0 }), false);
});

test("高位 BigInt 文件身份会按十进制字符串精确区分", () => {
  const baseStat = {
    size: 12,
    mtimeMs: 1000,
    ctimeMs: 1000,
    birthtimeMs: 1000,
    dev: 9007199254740993n,
    ino: 148900262680038880n,
  };
  const first = Transaction.fingerprintFromStat(baseStat);
  const adjacent = Transaction.fingerprintFromStat({ ...baseStat, ino: 148900262680038881n });
  assert.equal(first.dev, "9007199254740993");
  assert.equal(first.ino, "148900262680038880");
  assert.equal(Transaction.hasStrongFileIdentity(first), true);
  assert.equal(Transaction.sameStrongPathFingerprint(first, adjacent), false);
  assert.equal(Transaction.sameHardLinkRecoveryFingerprint(first, adjacent), false);
  assert.equal(Transaction.hasStrongFileIdentity({ ...first, ino: 148900262680038880 }), false);
  assert.equal(Transaction.hasStrongFileIdentity({ dev: first.dev, ino: first.ino }), false);
  assert.equal(Transaction.hasStrongFileIdentity({ size: 12, mtimeMs: 1000, dev: first.dev, ino: first.ino }), true);
});

test("不支持 bigint 选项的文件接口会安全回退到普通 lstat", async () => {
  let calls = 0;
  const expected = {
    size: 0,
    mtimeMs: 100,
    ctimeMs: 100,
    birthtimeMs: 100,
    dev: 7,
    ino: 8,
  };
  const unsupportedFs = {
    lstat: async (nativePath, options) => {
      calls += 1;
      if (options && options.bigint) throw new TypeError("bigint option is not supported");
      return expected;
    },
  };
  assert.deepEqual(await Transaction.lstatForIdentity(unsupportedFs, "C:\\material.mov"), expected);
  assert.equal(calls, 2);
});

test("硬链接排他创建的目标竞态不会覆盖竞争者", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "original");
    const item = fakeProjectItem(source);
    let claimed = false;
    const racingFs = {
      ...fs,
      async link(from, to) {
        if (!claimed && to === target) {
          claimed = true;
          await fs.writeFile(target, "competitor");
        }
        return fs.link(from, to);
      },
    };
    await assert.rejects(Transaction.moveAndRelink({
      fs: racingFs,
      sourcePath: source,
      targetPath: target,
      projectItems: [item],
      forceMode: "rename",
      validate: async () => true,
      persistProject: async () => true,
      wait: async () => {},
    }));
    assert.equal(await fs.readFile(source, "utf8"), "original");
    assert.equal(await fs.readFile(target, "utf8"), "competitor");
    assert.equal(item.currentPath(), source);
  });
});

for (const mode of ["rename", "copy"]) {
  test(`${mode} 模式绝不会覆盖创建期间被占用的目标`, async () => {
    await withTempFolder(async (folder) => {
      const source = path.join(folder, "source.mp4");
      const target = path.join(folder, "batch", "source.mp4");
      const stagingPath = target + ".organizing-part";
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(source, "original");
      const item = fakeProjectItem(source);
      let claimed = false;
      const claimingFs = {
        ...fs,
        link: async (sourcePath, nativePath) => {
          if (mode === "rename" && !claimed && nativePath === target) {
            claimed = true;
            await fs.writeFile(target, "competitor");
          }
          return fs.link(sourcePath, nativePath);
        },
        copyFile: async (sourcePath, nativePath, flags) => {
          if (mode === "copy" && !claimed && nativePath === target) {
            claimed = true;
            await fs.writeFile(target, "competitor");
          }
          return fs.copyFile(sourcePath, nativePath, flags);
        },
      };

      await assert.rejects(Transaction.moveAndRelink({
        fs: claimingFs,
        sourcePath: source,
        targetPath: target,
        stagingPath,
        projectItems: [item],
        forceMode: mode,
        validate: async () => true,
        persistProject: async () => true,
        wait: async () => {},
      }), (error) => error.code === "EEXIST");

      assert.equal(await fs.readFile(source, "utf8"), "original");
      assert.equal(await fs.readFile(target, "utf8"), "competitor");
      assert.equal(await Transaction.exists(fs, stagingPath), false);
      assert.equal(item.currentPath(), source);
    });
  });
}

test("同卷移动在硬链接不可用时使用原生重命名而不复制", { skip: "安全策略已禁用可能覆盖目标的占位 rename" }, async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "video");
    const item = fakeProjectItem(source);
    let copyCalls = 0;
    let renameCalls = 0;
    const fallbackFs = {
      ...fs,
      link: undefined,
      copyFile: async () => {
        copyCalls += 1;
        throw new Error("same-volume path must not call copyFile");
      },
      rename: async (...args) => {
        renameCalls += 1;
        return fs.rename(...args);
      },
    };

    const result = await Transaction.moveAndRelink({
      fs: fallbackFs,
      sourcePath: source,
      targetPath: target,
      projectItems: [item],
      forceMode: "rename",
      validate: async () => true,
      persistProject: async () => true,
      wait: async () => {},
    });

    assert.equal(result.cleanupPending, false);
    assert.equal(copyCalls, 0);
    assert.equal(renameCalls, 1);
    assert.equal(await Transaction.exists(fs, source), false);
    assert.equal(await fs.readFile(target, "utf8"), "video");
    assert.equal(item.currentPath(), target);
  });
});

test("原生重命名支持 UXP 数字文件描述符和零值成功码", { skip: "安全策略已禁用可能覆盖目标的占位 rename" }, async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "video");
    const item = fakeProjectItem(source);
    const handles = new Map();
    let nextHandle = 1;
    const uxpFs = {
      ...fs,
      link: undefined,
      open: async (...args) => {
        const handle = await fs.open(...args);
        const id = nextHandle;
        nextHandle += 1;
        handles.set(id, handle);
        return id;
      },
      close: async (id) => {
        const handle = handles.get(id);
        assert.ok(handle);
        await handle.close();
        handles.delete(id);
        return 0;
      },
      rename: async (...args) => {
        await fs.rename(...args);
        return 0;
      },
      unlink: async (...args) => {
        await fs.unlink(...args);
        return 0;
      },
    };

    const result = await Transaction.moveAndRelink({
      fs: uxpFs,
      sourcePath: source,
      targetPath: target,
      projectItems: [item],
      forceMode: "rename",
      validate: async () => true,
      persistProject: async () => true,
      wait: async () => {},
    });

    assert.equal(result.cleanupPending, false);
    assert.equal(handles.size, 0);
    assert.equal(await Transaction.exists(fs, source), false);
    assert.equal(await fs.readFile(target, "utf8"), "video");
    assert.equal(item.currentPath(), target);
  });
});

test("原生重命名失败时只移除自己创建的空目标占位", { skip: "安全策略已禁用可能覆盖目标的占位 rename" }, async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "video");
    const item = fakeProjectItem(source);
    const failingFs = {
      ...fs,
      link: undefined,
      rename: async () => {
        throw Object.assign(new Error("file is busy"), { code: "EBUSY" });
      },
    };

    await assert.rejects(
      Transaction.moveAndRelink({
        fs: failingFs,
        sourcePath: source,
        targetPath: target,
        projectItems: [item],
        forceMode: "rename",
        validate: async () => true,
        persistProject: async () => true,
        wait: async () => {},
      }),
      (error) => error.code === "EBUSY",
    );

    assert.equal(await fs.readFile(source, "utf8"), "video");
    assert.equal(await Transaction.exists(fs, target), false);
    assert.equal(item.currentPath(), source);
  });
});

test("Premiere 保存失败时，原生同卷重命名会保留新路径", { skip: "安全策略已禁用可能覆盖目标的占位 rename" }, async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "video");
    const item = fakeProjectItem(source);
    let saves = 0;
    let renameCalls = 0;
    const uxpLikeFs = {
      ...fs,
      link: undefined,
      copyFile: async () => {
        throw new Error("same-volume path must not call copyFile");
      },
      rename: async (...args) => {
        renameCalls += 1;
        return fs.rename(...args);
      },
    };

    await assert.rejects(
      Transaction.moveAndRelink({
        fs: uxpLikeFs,
        sourcePath: source,
        targetPath: target,
        projectItems: [item],
        forceMode: "rename",
        validate: async () => true,
        persistProject: async () => {
          saves += 1;
          return saves > 1;
        },
        wait: async () => {},
      }),
      /Premiere 工程保存失败/,
    );

    assert.equal(renameCalls, 1);
    assert.equal(saves, 1);
    assert.equal(await Transaction.exists(fs, source), false);
    assert.equal(await fs.readFile(target, "utf8"), "video");
    assert.equal(item.currentPath(), target);
  });
});

test("原生同卷重命名只会在 Premiere 开始重链接前移回源路径", { skip: "安全策略已禁用可能覆盖目标的占位 rename" }, async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "video");
    const item = fakeProjectItem(source);
    let validations = 0;
    let renameCalls = 0;
    const uxpLikeFs = {
      ...fs,
      link: undefined,
      rename: async (...args) => {
        renameCalls += 1;
        return fs.rename(...args);
      },
    };

    await assert.rejects(Transaction.moveAndRelink({
      fs: uxpLikeFs,
      sourcePath: source,
      targetPath: target,
      projectItems: [item],
      forceMode: "rename",
      validate: async () => {
        validations += 1;
        return validations < 3;
      },
      persistProject: async () => true,
      wait: async () => {},
    }), (error) => error.code === "MATERIAL_BATCH_CONTEXT_CHANGED");

    assert.equal(renameCalls, 2);
    assert.equal(await fs.readFile(source, "utf8"), "video");
    assert.equal(await Transaction.exists(fs, target), false);
    assert.equal(item.currentPath(), source);
  });
});

test("原生回滚绝不会把 Premiere 重链接到旧路径上的替换文件", { skip: "安全策略已禁用可能覆盖目标的占位 rename" }, async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "original");
    const item = fakeProjectItem(source);
    let saves = 0;
    let thrown;

    try {
      await Transaction.moveAndRelink({
        fs: { ...fs, link: undefined },
        sourcePath: source,
        targetPath: target,
        projectItems: [item],
        forceMode: "rename",
        validate: async () => true,
        persistProject: async () => {
          saves += 1;
          await fs.writeFile(source, "replacement");
          return false;
        },
        wait: async () => {},
      });
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown);
    assert.match(thrown.message, /Premiere 工程保存失败/);
    assert.ok(thrown.rollbackWarnings.some((warning) => /保持 Premiere 指向新位置/.test(warning)));
    assert.equal(saves, 1);
    assert.equal(item.currentPath(), target);
    assert.equal(await fs.readFile(source, "utf8"), "replacement");
    assert.equal(await fs.readFile(target, "utf8"), "original");
  });
});

test("复制回滚绝不会把 Premiere 重链接到旧路径上的替换文件", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "original");
    const item = fakeProjectItem(source);
    let saves = 0;
    let thrown;

    try {
      await Transaction.moveAndRelink({
        fs,
        sourcePath: source,
        targetPath: target,
        projectItems: [item],
        forceMode: "copy",
        validate: async () => true,
        persistProject: async () => {
          saves += 1;
          await fs.unlink(source);
          await fs.writeFile(source, "replacement");
          return false;
        },
        wait: async () => {},
      });
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown);
    assert.match(thrown.message, /Premiere 工程保存失败/);
    assert.ok(thrown.rollbackWarnings.some((warning) => /保持 Premiere 指向新位置/.test(warning)));
    assert.equal(saves, 1);
    assert.equal(item.currentPath(), target);
    assert.equal(await fs.readFile(source, "utf8"), "replacement");
    assert.equal(await fs.readFile(target, "utf8"), "original");
  });
});

test("现有映射回滚绝不会把 Premiere 重链接到新出现的旧路径", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, "original");
    const item = fakeProjectItem(source);
    let saves = 0;
    let thrown;

    try {
      await Transaction.relinkExisting({
        fs,
        sourcePath: source,
        targetPath: target,
        projectItems: [item],
        validate: async () => true,
        persistProject: async () => {
          saves += 1;
          await fs.writeFile(source, "replacement");
          return false;
        },
        wait: async () => {},
      });
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown);
    assert.match(thrown.message, /补链后的 Premiere 工程保存失败/);
    assert.ok(thrown.rollbackWarnings.some((warning) => /保持 Premiere 指向整理后的位置/.test(warning)));
    assert.equal(saves, 1);
    assert.equal(item.currentPath(), target);
    assert.equal(await fs.readFile(source, "utf8"), "replacement");
    assert.equal(await fs.readFile(target, "utf8"), "original");
  });
});

test("检查后源文件立即被替换时，复制回滚会保留目标", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "original");
    const item = fakeProjectItem(source);
    let rollbackStarted = false;
    let replaced = false;
    const racingFs = {
      ...fs,
      lstat: async (nativePath) => {
        const stat = await fs.lstat(nativePath);
        if (rollbackStarted && !replaced && nativePath === source) {
          replaced = true;
          await fs.unlink(source);
          await fs.writeFile(source, "replacement");
        }
        return stat;
      },
    };

    let thrown;
    try {
      await Transaction.moveAndRelink({
        fs: racingFs,
        sourcePath: source,
        targetPath: target,
        projectItems: [item],
        forceMode: "copy",
        validate: async () => true,
        persistProject: async () => {
          rollbackStarted = true;
          return false;
        },
        wait: async () => {},
      });
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown);
    assert.ok(thrown.rollbackWarnings.some((warning) => /保持 Premiere 指向新位置/.test(warning)));
    assert.equal(replaced, true);
    assert.equal(item.currentPath(), target);
    assert.equal(await fs.readFile(source, "utf8"), "replacement");
    assert.equal(await fs.readFile(target, "utf8"), "original");
  });
});

test("跨卷 UXP 路径只复制一次内容，然后移除源文件", { skip: "当前安全策略要求目标建立具备排他硬链接能力" }, async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "video");
    const item = fakeProjectItem(source);
    let copyCalls = 0;
    const uxpLikeFs = {
      ...fs,
      link: undefined,
      copyFile: async (from, to, flags) => {
        copyCalls += 1;
        assert.equal(flags, fs.constants.COPYFILE_EXCL);
        return fs.copyFile(from, to, flags);
      },
    };

    const result = await Transaction.moveAndRelink({
      fs: uxpLikeFs,
      sourcePath: source,
      targetPath: target,
      projectItems: [item],
      forceMode: "copy",
      validate: async () => true,
      persistProject: async () => true,
      wait: async () => {},
    });

    assert.equal(result.cleanupPending, false);
    assert.equal(copyCalls, 1);
    assert.equal(await Transaction.exists(fs, source), false);
    assert.equal(await fs.readFile(target, "utf8"), "video");
    assert.equal(item.currentPath(), target);
  });
});

test("严格路径指纹要求有效大小和修改时间，并核对双方都有的身份字段", () => {
  const samePathFingerprint = Transaction.samePathFingerprint || Transaction.sameFingerprint;
  assert.equal(typeof samePathFingerprint, "function");
  const base = {
    size: 0,
    mtimeMs: 100,
    ctimeMs: 200,
    birthtimeMs: 300,
    dev: 400,
    ino: 500,
  };

  assert.equal(samePathFingerprint(base, { ...base }), true);
  assert.equal(samePathFingerprint({ ...base, size: 1 }, base), false);
  assert.equal(samePathFingerprint({ ...base, mtimeMs: 101 }, base), false);

  for (const field of ["size", "mtimeMs"]) {
    const missingLeft = { ...base };
    const missingRight = { ...base };
    delete missingLeft[field];
    delete missingRight[field];
    assert.equal(samePathFingerprint(missingLeft, base), false, `${field} 缺失时左侧应失败`);
    assert.equal(samePathFingerprint(base, missingRight), false, `${field} 缺失时右侧应失败`);
  }
  for (const value of [null, NaN, Infinity, -1]) {
    assert.equal(samePathFingerprint({ ...base, size: value }, base), false, `size=${String(value)} 应失败`);
  }
  for (const value of [null, NaN, Infinity, 0, -1]) {
    assert.equal(samePathFingerprint({ ...base, mtimeMs: value }, base), false, `mtimeMs=${String(value)} 应失败`);
  }

  for (const field of ["ctimeMs", "birthtimeMs", "dev", "ino"]) {
    assert.equal(samePathFingerprint({ ...base, [field]: base[field] + 1 }, base), false, `${field} 双方都有但不同应失败`);
    const missingLeft = { ...base };
    const missingRight = { ...base };
    delete missingLeft[field];
    delete missingRight[field];
    assert.equal(samePathFingerprint(missingLeft, base), true, `${field} 仅左侧缺失应放行`);
    assert.equal(samePathFingerprint(base, missingRight), true, `${field} 仅右侧缺失应放行`);
  }
});

test("重命名后的文件指纹同样要求有效大小和修改时间，但忽略 ctime", () => {
  const base = {
    size: 0,
    mtimeMs: 100,
    ctimeMs: 200,
    birthtimeMs: 300,
    dev: 400,
    ino: 500,
  };

  assert.equal(Transaction.sameFileAfterRename(base, { ...base, ctimeMs: 999 }), true);
  assert.equal(Transaction.sameFileAfterRename({ ...base, size: 1 }, base), false);
  assert.equal(Transaction.sameFileAfterRename({ ...base, mtimeMs: 0 }, base), false);
  const missingSize = { ...base };
  delete missingSize.size;
  assert.equal(Transaction.sameFileAfterRename(missingSize, base), false);
  const missingMtime = { ...base };
  delete missingMtime.mtimeMs;
  assert.equal(Transaction.sameFileAfterRename(missingMtime, base), false);
});

test("复制成功后返回实际目标指纹，可移植比较会忽略身份字段", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "video");
    const result = await Transaction.moveAndRelink({
      fs,
      sourcePath: source,
      targetPath: target,
      projectItems: [fakeProjectItem(source)],
      forceMode: "copy",
      validate: async () => true,
      persistProject: async () => true,
      wait: async () => {},
    });

    const targetFingerprint = Transaction.fingerprintFromStat(await fs.lstat(target));
    assert.deepEqual(result.targetFingerprint, targetFingerprint);
    assert.equal(Transaction.samePortableFingerprint(
      result.targetFingerprint,
      { size: targetFingerprint.size, mtimeMs: targetFingerprint.mtimeMs, dev: 999, ino: 888, ctimeMs: 1 },
    ), true);
    assert.equal(Transaction.samePortableFingerprint(
      result.targetFingerprint,
      { size: targetFingerprint.size + 1, mtimeMs: targetFingerprint.mtimeMs },
    ), false);
    assert.equal(Transaction.samePortableFingerprint(
      result.targetFingerprint,
      { size: targetFingerprint.size, mtimeMs: 0 },
    ), false);
  });
});

test("跨卷清理绝不会删除在稳定等待期间持续变化的隔离内容", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    const transactionId = "tx-changing-quarantine";
    const cleanupPath = Transaction.cleanupPathFor(source, transactionId);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "original");
    let cleanupWaitCalls = 0;
    let cleanupWaitMilliseconds = [];
    const result = await Transaction.moveAndRelink({
      id: transactionId,
      fs,
      sourcePath: source,
      targetPath: target,
      cleanupPath,
      projectItems: [fakeProjectItem(source)],
      forceMode: "copy",
      validate: async () => true,
      persistProject: async () => true,
      wait: async () => {},
      cleanupWait: async (milliseconds) => {
        cleanupWaitCalls += 1;
        cleanupWaitMilliseconds.push(milliseconds);
        if (await Transaction.exists(fs, cleanupPath)) await fs.appendFile(cleanupPath, "-continued");
      },
    });

    assert.equal(cleanupWaitCalls, 1);
    assert.deepEqual(cleanupWaitMilliseconds, [Transaction.cleanupSettlingMs]);
    assert.ok(Transaction.cleanupSettlingMs > 140);
    assert.equal(result.cleanupPending, true);
    assert.match(result.cleanupWarning, /稳定复核期间发生变化/);
    assert.equal(await Transaction.exists(fs, source), false);
    assert.equal(await fs.readFile(cleanupPath, "utf8"), "original-continued");
    assert.equal(await fs.readFile(target, "utf8"), "original");
  });
});

test("目标创建后的身份校验失败时会保留目标以供人工审核", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "video");
    const item = fakeProjectItem(source);
    let spoofTargetStat = true;
    const mismatchingFs = {
      ...fs,
      lstat: async (nativePath) => {
        const stat = await fs.lstat(nativePath);
        if (nativePath === target && spoofTargetStat) {
          spoofTargetStat = false;
          return { ...stat, size: typeof stat.size === "bigint" ? stat.size + 1n : stat.size + 1 };
        }
        return stat;
      },
    };

    await assert.rejects(
      Transaction.moveAndRelink({
        fs: mismatchingFs,
        sourcePath: source,
        targetPath: target,
        projectItems: [item],
        forceMode: "rename",
        validate: async () => true,
        persistProject: async () => true,
        wait: async () => {},
      }),
      (error) => {
        assert.match(error.message, /身份校验失败/);
        assert.ok(error.rollbackWarnings.some((warning) => /未自动删除/.test(warning)));
        return true;
      },
    );

    assert.equal(await fs.readFile(source, "utf8"), "video");
    assert.equal(await fs.readFile(target, "utf8"), "video");
    assert.equal(item.currentPath(), source);
  });
});

test("复制后暂存路径被替换时，回滚绝不会删除该路径", { skip: "旧测试依赖被禁用的暂存 rename 路径" }, async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    const stagingPath = target + ".organizing-part";
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "original");
    const item = fakeProjectItem(source);
    const replacingFs = {
      ...fs,
      rename: async (from, to) => {
        if (from === stagingPath && to === target) {
          await fs.unlink(stagingPath);
          await fs.writeFile(stagingPath, "replacement-staging-file");
          throw Object.assign(new Error("target creation interrupted"), { code: "EIO" });
        }
        return fs.rename(from, to);
      },
    };

    await assert.rejects(
      Transaction.moveAndRelink({
        fs: replacingFs,
        sourcePath: source,
        targetPath: target,
        stagingPath,
        projectItems: [item],
        forceMode: "copy",
        validate: async () => true,
        persistProject: async () => true,
        wait: async () => {},
      }),
      (error) => {
        assert.equal(error.code, "EIO");
        assert.ok(error.rollbackWarnings.some((warning) => /保留新位置的素材/.test(warning)));
        return true;
      },
    );

    assert.equal(await fs.readFile(source, "utf8"), "original");
    assert.equal(await fs.readFile(stagingPath, "utf8"), "replacement-staging-file");
    assert.equal((await fs.readFile(target)).length, 0);
    assert.equal(item.currentPath(), source);
  });
});

test("目标重命名后暂存路径被重新创建时，复制模式绝不会删除该路径", { skip: "旧测试依赖被禁用的暂存 rename 路径" }, async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    const stagingPath = target + ".organizing-part";
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "original");
    const item = fakeProjectItem(source);
    let recreated = false;
    const racingFs = {
      ...fs,
      link: undefined,
      rename: async (from, to) => {
        const result = await fs.rename(from, to);
        if (!recreated && from === stagingPath && to === target) {
          recreated = true;
          await fs.writeFile(stagingPath, "competitor-staging");
        }
        return result;
      },
    };

    await assert.rejects(Transaction.moveAndRelink({
      fs: racingFs,
      sourcePath: source,
      targetPath: target,
      stagingPath,
      projectItems: [item],
      forceMode: "copy",
      validate: async () => true,
      persistProject: async () => true,
      wait: async () => {},
    }), /临时文件路径在目标建立后被重新占用/);

    assert.equal(recreated, true);
    assert.equal(await fs.readFile(source, "utf8"), "original");
    assert.equal(await fs.readFile(target, "utf8"), "original");
    assert.equal(await fs.readFile(stagingPath, "utf8"), "competitor-staging");
    assert.equal(item.currentPath(), source);
  });
});

test("绝不会覆盖现有目标", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "target.mp4");
    await fs.writeFile(source, "new");
    await fs.writeFile(target, "existing");
    const item = fakeProjectItem(source);
    await assert.rejects(Transaction.moveAndRelink({
      fs,
      sourcePath: source,
      targetPath: target,
      projectItems: [item],
      validate: async () => true,
      persistProject: async () => true,
      wait: async () => {},
    }), /目标文件已存在/);
    assert.equal(await fs.readFile(source, "utf8"), "new");
    assert.equal(await fs.readFile(target, "utf8"), "existing");
  });
});

test("事务边界会拒绝源路径或目标路径中的 .prproj 文件", async () => {
  await withTempFolder(async (folder) => {
    const projectSource = path.join(folder, "edit.PRPROJ");
    const mediaSource = path.join(folder, "source.mp4");
    const mediaTarget = path.join(folder, "batch", "source.mp4");
    const projectTarget = path.join(folder, "batch", "copied.prproj");
    await fs.mkdir(path.dirname(mediaTarget), { recursive: true });
    await fs.writeFile(projectSource, "project");
    await fs.writeFile(mediaSource, "video");

    for (const [sourcePath, targetPath] of [[projectSource, mediaTarget], [mediaSource, projectTarget]]) {
      await assert.rejects(Transaction.moveAndRelink({
        fs,
        sourcePath,
        targetPath,
        projectItems: [fakeProjectItem(sourcePath)],
        validate: async () => true,
        persistProject: async () => true,
        wait: async () => {},
      }), (error) => error.code === "MATERIAL_BATCH_PROJECT_FILE_BLOCKED");
    }

    assert.equal(await fs.readFile(projectSource, "utf8"), "project");
    assert.equal(await fs.readFile(mediaSource, "utf8"), "video");
    assert.equal(await Transaction.exists(fs, mediaTarget), false);
    assert.equal(await Transaction.exists(fs, projectTarget), false);
  });
});

test("跨卷保存后上下文发生变化时会保留两条路径，而不删除源文件", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "video");
    const item = fakeProjectItem(source);
    let validations = 0;
    const result = await Transaction.moveAndRelink({
      fs,
      sourcePath: source,
      targetPath: target,
      projectItems: [item],
      forceMode: "copy",
      validate: async () => {
        validations += 1;
        return validations < 9;
      },
      persistProject: async () => true,
      wait: async () => {},
    });
    assert.equal(result.cleanupPending, true);
    assert.equal(result.sourceChanged, false);
    assert.equal(result.sourceRetained, false);
    assert.equal(await Transaction.exists(fs, source), true);
    assert.equal(await Transaction.exists(fs, target), true);
  });
});

test("清理重命名后上下文发生变化时会保留隔离的源文件", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    const transactionId = "tx-context-after-rename";
    const cleanupPath = Transaction.cleanupPathFor(source, transactionId);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "video");
    const item = fakeProjectItem(source);
    let validations = 0;
    const result = await Transaction.moveAndRelink({
      id: transactionId,
      fs,
      sourcePath: source,
      targetPath: target,
      cleanupPath,
      projectItems: [item],
      forceMode: "copy",
      validate: async () => {
        validations += 1;
        return validations < 10;
      },
      persistProject: async () => true,
      wait: async () => {},
    });

    assert.equal(result.cleanupPending, true);
    assert.equal(await Transaction.exists(fs, source), false);
    assert.equal(await fs.readFile(cleanupPath, "utf8"), "video");
    assert.equal(await fs.readFile(target, "utf8"), "video");
    assert.equal(item.currentPath(), target);
  });
});

test("跨卷清理期间绝不会删除已被替换的源路径", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "original");
    const item = fakeProjectItem(source);
    const result = await Transaction.moveAndRelink({
      fs,
      sourcePath: source,
      targetPath: target,
      projectItems: [item],
      forceMode: "copy",
      validate: async () => true,
      persistProject: async () => {
        await fs.writeFile(source, "replacement-file");
        return true;
      },
      wait: async () => {},
    });

    assert.equal(result.cleanupPending, false);
    assert.equal(result.sourceChanged, true);
    assert.equal(await fs.readFile(source, "utf8"), "replacement-file");
    assert.equal(await fs.readFile(target, "utf8"), "original");
    assert.equal(item.currentPath(), target);
  });
});

test("待删除隔离文件被抢占时，不删除竞争文件并保留 cleanup-pending", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    const transactionId = "tx-cleanup-occupy";
    const cleanupPath = Transaction.cleanupPathFor(source, transactionId);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "original");
    const item = fakeProjectItem(source);
    let beforeDeleteCalls = 0;
    const result = await Transaction.moveAndRelink({
      id: transactionId,
      fs,
      sourcePath: source,
      targetPath: target,
      cleanupPath,
      projectItems: [item],
      forceMode: "copy",
      validate: async () => true,
      persistProject: async () => true,
      wait: async () => {},
      beforeDelete: async ({ cleanupPath: occupiedPath }) => {
        beforeDeleteCalls += 1;
        await nativeFs.unlink(occupiedPath);
        await nativeFs.writeFile(occupiedPath, "another-process-file");
        return true;
      },
    });

    assert.equal(beforeDeleteCalls, 1);
    assert.equal(result.cleanupPending, true);
    assert.equal(result.remainingSourcePath, cleanupPath);
    assert.equal(await fs.readFile(cleanupPath, "utf8"), "another-process-file");
    assert.equal(await Transaction.exists(fs, source), false);
    assert.equal(await fs.readFile(target, "utf8"), "original");
  });
});

test("硬链接不支持且异常没有错误码时，会降级为排他复制并完成清理", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mov");
    const target = path.join(folder, "batch", "source.mov");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "video");
    const item = fakeProjectItem(source);
    const fallbackFs = Object.assign({}, fs, {
      async link() { throw new Error("operation not supported"); },
    });

    const result = await Transaction.moveAndRelink({
      fs: fallbackFs,
      sourcePath: source,
      targetPath: target,
      projectItems: [item],
      forceMode: "rename",
      validate: async () => true,
      persistProject: async () => true,
      wait: async () => {},
    });

    assert.equal(result.targetMethod, "copy");
    assert.equal(result.mode, "copy");
    assert.equal(await Transaction.exists(fallbackFs, source), false);
    assert.equal(await fs.readFile(target, "utf8"), "video");
    assert.equal(item.currentPath(), target);
  });
});

test("身份检查与清理重命名之间源文件被替换时会恢复该文件，而不删除", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    const transactionId = "tx-race";
    const cleanupPath = Transaction.cleanupPathFor(source, transactionId);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "original");
    const item = fakeProjectItem(source);
    let replaced = false;
    const replacingFs = {
      ...fs,
      rename: async (nativePath, nextPath) => {
        if (!replaced && nativePath === source && nextPath === cleanupPath) {
          replaced = true;
          await fs.unlink(source);
          await fs.writeFile(source, "replacement-file");
        }
        return fs.rename(nativePath, nextPath);
      },
    };

    const result = await Transaction.moveAndRelink({
      id: transactionId,
      fs: replacingFs,
      sourcePath: source,
      targetPath: target,
      cleanupPath,
      projectItems: [item],
      forceMode: "copy",
      validate: async () => true,
      persistProject: async () => true,
      wait: async () => {},
    });

    assert.equal(result.cleanupPending, false);
    assert.equal(result.sourceChanged, true);
    assert.equal(await fs.readFile(source, "utf8"), "replacement-file");
    assert.equal(await Transaction.exists(fs, cleanupPath), false);
    assert.equal(await fs.readFile(target, "utf8"), "original");
    assert.equal(item.currentPath(), target);
  });
});

test("跨卷清理前源文件已被移除时，事务可正常完成", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.mp4");
    const target = path.join(folder, "batch", "source.mp4");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, "video");
    const item = fakeProjectItem(source);
    const result = await Transaction.moveAndRelink({
      fs,
      sourcePath: source,
      targetPath: target,
      projectItems: [item],
      forceMode: "copy",
      validate: async () => true,
      persistProject: async () => {
        await fs.unlink(source);
        return true;
      },
      wait: async () => {},
    });

    assert.equal(result.cleanupPending, false);
    assert.equal(result.sourceChanged, false);
    assert.equal(await Transaction.exists(fs, source), false);
    assert.equal(await fs.readFile(target, "utf8"), "video");
    assert.equal(item.currentPath(), target);
  });
});
