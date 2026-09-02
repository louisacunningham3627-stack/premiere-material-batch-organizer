const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Transaction = require("../src/transaction");

function fakeProjectItem(initialPath) {
  let mediaPath = initialPath;
  return {
    canChangeMediaPath: async () => true,
    changeMediaFilePath: async (nextPath, override) => {
      assert.equal(override, false);
      mediaPath = nextPath;
      return true;
    },
    refreshMedia: async () => true,
    getMediaFilePath: async () => mediaPath,
    isOffline: async () => false,
    currentPath: () => mediaPath,
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

test("复制模式会依次校验、重链接全部工程项目、保存并删除源文件", async () => {
  await withTempFolder(async (folder) => {
    const source = path.join(folder, "source.bin");
    const target = path.join(folder, "batch", "source.bin");
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(source, Buffer.from("material-data"));
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

test("路径检查只会把确认缺失的文件视为不存在", async () => {
  const missingError = Object.assign(new Error("missing"), { code: "ENOENT" });
  const deniedError = Object.assign(new Error("access denied"), { code: "EACCES" });

  assert.equal(await Transaction.exists({ lstat: async () => { throw missingError; } }, "C:\\missing.mov"), false);
  await assert.rejects(
    Transaction.exists({ lstat: async () => { throw deniedError; } }, "C:\\locked.mov"),
    (error) => error === deniedError,
  );
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

test("同卷操作成功时使用硬链接而不复制，并移除源路径", async () => {
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
    assert.equal(linkCalls, 1);
    assert.equal(copyCalls, 0);
    assert.equal(await Transaction.exists(fs, source), false);
    assert.equal(await fs.readFile(target, "utf8"), "video");
    assert.equal(item.currentPath(), target);
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
        link: undefined,
        open: async (nativePath, ...args) => {
          if (!claimed && nativePath === target) {
            claimed = true;
            await fs.writeFile(target, "competitor");
          }
          return fs.open(nativePath, ...args);
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
      if (mode === "copy") {
        assert.equal(await fs.readFile(stagingPath, "utf8"), "original");
      } else {
        assert.equal(await Transaction.exists(fs, stagingPath), false);
      }
      assert.equal(item.currentPath(), source);
    });
  });
}

test("同卷移动在硬链接不可用时使用原生重命名而不复制", async () => {
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

test("原生重命名支持 UXP 数字文件描述符和零值成功码", async () => {
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

test("原生重命名失败时只移除自己创建的空目标占位", async () => {
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

test("Premiere 保存失败时，原生同卷重命名会保留新路径", async () => {
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

test("原生同卷重命名只会在 Premiere 开始重链接前移回源路径", async () => {
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

test("原生回滚绝不会把 Premiere 重链接到旧路径上的替换文件", async () => {
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

test("跨卷 UXP 路径只复制一次内容，然后移除源文件", async () => {
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
          return { ...stat, size: stat.size + 1 };
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

test("复制后暂存路径被替换时，回滚绝不会删除该路径", async () => {
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

test("目标重命名后暂存路径被重新创建时，复制模式绝不会删除该路径", async () => {
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
        return validations < 5;
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
        return validations < 6;
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
