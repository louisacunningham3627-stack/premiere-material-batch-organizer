const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Recovery = require("../src/recovery");
const Transaction = require("../src/transaction");

async function withFixture(run) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-recovery-test-"));
  try {
    const mediaRoot = path.join(folder, "素材");
    const batch = path.join(mediaRoot, "001_初始素材");
    const source = path.join(folder, "downloads", "clip.mp4");
    const target = path.join(batch, "clip.mp4");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.mkdir(batch, { recursive: true });
    await run({ folder, mediaRoot, source, target });
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
}

async function pendingFor(source) {
  const stat = await Transaction.lstatForIdentity(fs, source);
  return {
    id: "tx-recovery",
    sourcePath: source,
    targetRelativePath: "素材\\001_初始素材\\clip.mp4",
    sourceFingerprint: Transaction.fingerprintFromStat(stat),
    byteCount: Transaction.statSize(stat),
    batchIndex: 1,
    mode: "copy",
    deleteSource: true,
    itemCount: 1,
    itemIds: ["item-1"],
  };
}

function trackFsMutations(baseFs) {
  const mutations = [];
  const mutators = new Set([
    "writeFile",
    "appendFile",
    "copyFile",
    "rename",
    "unlink",
    "rm",
    "mkdir",
    "truncate",
    "open",
  ]);
  const readOnlyFs = new Proxy(baseFs, {
    get(target, key) {
      if (mutators.has(key)) {
        return async (...args) => {
          mutations.push([key, ...args]);
          throw new Error(`unexpected fs mutation: ${String(key)}`);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { readOnlyFs, mutations };
}

test("恢复流程只会清除已确认回滚的事务", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "clip-data");
    const pending = await pendingFor(source);
    const result = await Recovery.inspectPending({ fs, pending, targetPath: target, mediaRoot, linkedEntries: [{ itemId: "item-1", mediaPath: source }] });
    assert.equal(result.kind, "rolled-back");
    assert.equal(await fs.readFile(source, "utf8"), "clip-data");
  });
});

test("恢复流程会拒绝待处理事务中重复的工程项目 ID", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "clip-data");
    const pending = await pendingFor(source);
    pending.itemCount = 2;
    pending.itemIds = ["item-1", "item-1"];
    await fs.copyFile(source, target);

    const result = await Recovery.inspectPending({
      fs,
      pending,
      targetPath: target,
      mediaRoot,
      linkedEntries: [{ itemId: "item-1", mediaPath: target }],
    });

    assert.equal(result.kind, "manual");
    assert.match(result.reason, /身份存在重复/);
  });
});

test("原始源文件仍存在时，恢复流程会阻止完成事务", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "clip-data");
    const pending = await pendingFor(source);
    await fs.copyFile(source, target);
    pending.targetFingerprint = Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, target));
    const result = await Recovery.inspectPending({ fs, pending, targetPath: target, mediaRoot, linkedEntries: [{ itemId: "item-1", mediaPath: target }] });
    assert.equal(result.kind, "completed");
    assert.equal(result.cleanupPending, true);
    assert.equal(await fs.readFile(source, "utf8"), "clip-data");
  });
});

test("恢复流程会接受与已记录目标指纹匹配的目标", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "clip-data");
    const pending = await pendingFor(source);
    await fs.copyFile(source, target);
    pending.targetFingerprint = Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, target));

    const result = await Recovery.inspectPending({
      fs,
      pending,
      targetPath: target,
      mediaRoot,
      linkedEntries: [{ itemId: "item-1", mediaPath: target }],
    });

    assert.equal(result.kind, "completed");
  });
});

test("目标检查点完整匹配时不再使用源文件修改时间判断目标", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "clip-data");
    const pending = await pendingFor(source);
    await fs.copyFile(source, target);
    const distantTargetTime = new Date(Number(pending.sourceFingerprint.mtimeMs) + 60000);
    await fs.utimes(target, distantTargetTime, distantTargetTime);
    pending.targetFingerprint = Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, target));

    assert.ok(
      Math.abs(pending.targetFingerprint.mtimeMs - pending.sourceFingerprint.mtimeMs) > 2000,
    );

    const result = await Recovery.inspectPending({
      fs,
      pending,
      targetPath: target,
      mediaRoot,
      linkedEntries: [{ itemId: "item-1", mediaPath: target }],
    });

    assert.equal(result.kind, "completed");
    assert.equal(result.cleanupPending, true);
  });
});

test("目标检查点的大小和修改时间相同但 ino 或 ctime 不同时仍会阻断", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "clip-data");
    const pending = await pendingFor(source);
    await fs.copyFile(source, target);
    const currentTargetFingerprint = Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, target));
    pending.targetFingerprint = Object.assign({}, currentTargetFingerprint, {
      ino: Number(currentTargetFingerprint.ino) === 1 ? 2 : 1,
      ctimeMs: Number(currentTargetFingerprint.ctimeMs) === 1 ? 2 : 1,
    });

    assert.equal(pending.targetFingerprint.size, currentTargetFingerprint.size);
    assert.equal(pending.targetFingerprint.mtimeMs, currentTargetFingerprint.mtimeMs);
    assert.notEqual(pending.targetFingerprint.ino, currentTargetFingerprint.ino);
    assert.notEqual(pending.targetFingerprint.ctimeMs, currentTargetFingerprint.ctimeMs);

    const result = await Recovery.inspectPending({
      fs,
      pending,
      targetPath: target,
      mediaRoot,
      linkedEntries: [{ itemId: "item-1", mediaPath: target }],
    });

    assert.equal(result.kind, "manual");
    assert.match(result.reason, /身份不一致/);
  });
});

test("已记录目标不匹配时，恢复流程会保留待处理事务", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "clip-data");
    const pending = await pendingFor(source);
    await fs.copyFile(source, target);
    const targetFingerprint = Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, target));
    pending.targetFingerprint = Object.assign({}, targetFingerprint, {
      mtimeMs: targetFingerprint.mtimeMs + 5000,
    });
    const recordedFingerprint = Object.assign({}, pending.targetFingerprint);

    const result = await Recovery.inspectPending({
      fs,
      pending,
      targetPath: target,
      mediaRoot,
      linkedEntries: [{ itemId: "item-1", mediaPath: target }],
    });

    assert.equal(result.kind, "manual");
    assert.match(result.reason, /身份不一致/);
    assert.equal(result.sourcePath, source);
    assert.equal(result.targetPath, target);
    assert.equal(result.sourceExists, true);
    assert.equal(result.targetExists, true);
    assert.equal(result.sourceLinkCount, 0);
    assert.equal(result.targetLinkCount, 1);
    assert.deepEqual(pending.targetFingerprint, recordedFingerprint);
  });
});

test("缺少目标指纹时，恢复流程必须人工检查且不自动完成", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "clip-data");
    const pending = await pendingFor(source);
    delete pending.targetFingerprint;
    await fs.copyFile(source, target);

    const result = await Recovery.inspectPending({
      fs,
      pending,
      targetPath: target,
      mediaRoot,
      linkedEntries: [{ itemId: "item-1", mediaPath: target }],
    });

    assert.equal(result.kind, "manual");
    assert.match(result.reason, /缺少可靠的新位置文件身份/);
    assert.equal(result.sourcePath, source);
    assert.equal(result.targetPath, target);
  });
});

test("缺少目标检查点时即使大小和修改时间接近也必须人工检查", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "clip-data");
    const pending = await pendingFor(source);
    delete pending.targetFingerprint;
    await fs.copyFile(source, target);
    for (const offsetMs of [-1500, 1500]) {
      const compatibleTargetTime = new Date(Number(pending.sourceFingerprint.mtimeMs) + offsetMs);
      await fs.utimes(target, compatibleTargetTime, compatibleTargetTime);
      const targetFingerprint = Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, target));

      assert.ok(Math.abs(targetFingerprint.mtimeMs - pending.sourceFingerprint.mtimeMs) <= 2000);

      const result = await Recovery.inspectPending({
        fs,
        pending,
        targetPath: target,
        mediaRoot,
        linkedEntries: [{ itemId: "item-1", mediaPath: target }],
      });

      assert.equal(result.kind, "manual");
      assert.match(result.reason, /缺少可靠的新位置文件身份/);
    }
  });
});

test("只有大小和修改时间的残缺目标检查点不能触发自动恢复", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "clip-data");
    const pending = await pendingFor(source);
    await fs.copyFile(source, target);
    const completeTarget = Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, target));
    pending.targetFingerprint = {
      size: completeTarget.size,
      mtimeMs: completeTarget.mtimeMs,
    };

    const result = await Recovery.inspectPending({
      fs,
      pending,
      targetPath: target,
      mediaRoot,
      linkedEntries: [{ itemId: "item-1", mediaPath: target }],
    });

    assert.equal(result.kind, "manual");
    assert.match(result.reason, /缺少可靠的新位置文件身份/);
  });
});

test("残缺或不安全的原位置身份不能触发自动恢复", async (t) => {
  for (const sourceFingerprint of [
    { size: 9, mtimeMs: 1000 },
    { size: 9, mtimeMs: 1000, dev: "7", ino: "0" },
    { size: 9, mtimeMs: 1000, dev: "7", ino: Number.MAX_SAFE_INTEGER + 2 },
  ]) await t.test(JSON.stringify(sourceFingerprint), async () => {
    await withFixture(async ({ mediaRoot, source, target }) => {
      await fs.writeFile(source, "clip-data");
      const pending = await pendingFor(source);
      pending.sourceFingerprint = sourceFingerprint;

      const result = await Recovery.inspectPending({
        fs,
        pending,
        targetPath: target,
        mediaRoot,
        linkedEntries: [{ itemId: "item-1", mediaPath: source }],
      });

      assert.equal(result.kind, "manual");
      assert.match(result.reason, /旧记录缺少原文件身份凭据/);
    });
  });
});

test("旧记录缺少原身份仍展示两处文件及链接，但不获得恢复或关闭权限", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "clip-data");
    await fs.writeFile(target, "different-data");
    const pending = await pendingFor(source);
    delete pending.sourceFingerprint;
    const { readOnlyFs, mutations } = trackFsMutations(fs);
    const result = await Recovery.inspectPending({
      fs: readOnlyFs, pending, targetPath: target, mediaRoot,
      linkedEntries: [{ itemId: "item-1", mediaPath: source }],
    });
    assert.equal(result.kind, "manual");
    assert.equal(result.sourceExists, true);
    assert.equal(result.targetExists, true);
    assert.equal(result.sourceSize, 9);
    assert.equal(result.targetSize, 14);
    assert.equal(result.currentLinkState, "source");
    assert.equal(result.manualCode, undefined);
    assert.equal(result.sourceFingerprint, undefined);
    assert.equal(result.resolvedItemIds, undefined);
    assert.deepEqual(mutations, []);
  });
});

test("超过安全整数范围的相邻 inode 不会在恢复时碰撞", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "clip-data");
    await fs.copyFile(source, target);
    const pending = await pendingFor(source);
    const targetFingerprint = Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, target));
    pending.targetFingerprint = Object.assign({}, targetFingerprint, {
      dev: "7",
      ino: "90071992547409920",
    });
    const identityAwareFs = {
      ...fs,
      async lstat(nativePath, options) {
        if (nativePath !== target) return fs.lstat(nativePath, options);
        return {
          isFile: () => true,
          isDirectory: () => false,
          size: BigInt(targetFingerprint.size),
          mtimeMs: BigInt(Math.trunc(targetFingerprint.mtimeMs)),
          ctimeMs: BigInt(Math.trunc(targetFingerprint.ctimeMs)),
          birthtimeMs: BigInt(Math.trunc(targetFingerprint.birthtimeMs)),
          dev: 7n,
          ino: 90071992547409921n,
        };
      },
    };

    const result = await Recovery.inspectPending({
      fs: identityAwareFs,
      pending,
      targetPath: target,
      mediaRoot,
      linkedEntries: [{ itemId: "item-1", mediaPath: target }],
    });

    assert.equal(result.kind, "manual");
    assert.match(result.reason, /目标文件.*身份不一致/);
  });
});

test("恢复流程会把硬链接 ctime 变化视为同一源文件", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "clip-data");
    const pending = await pendingFor(source);
    pending.mode = "rename";
    pending.sourceFingerprint.ctimeMs = Number(pending.sourceFingerprint.ctimeMs) - 10000;
    await fs.link(source, target);
    pending.targetFingerprint = Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, target));

    const result = await Recovery.inspectPending({
      fs,
      pending,
      targetPath: target,
      mediaRoot,
      linkedEntries: [{ itemId: "item-1", mediaPath: target }],
    });

    assert.equal(result.kind, "completed");
    assert.equal(result.sourceChanged, false);
    assert.equal(result.cleanupPending, true);
    assert.equal(result.remainingSourcePath, source);
  });
});

test("持久化为硬链接的目标在源链接改名后允许 ctime 变化并刷新身份", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "clip-data");
    await fs.link(source, target);
    const pending = await pendingFor(source);
    pending.mode = "rename";
    pending.targetMethod = "link";
    pending.cleanupPath = Transaction.cleanupPathFor(source, pending.id);
    pending.sourceFingerprint = Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, source));
    pending.targetFingerprint = Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, target));
    pending.targetFingerprint.ctimeMs += 10000;
    await fs.rename(source, pending.cleanupPath);

    const result = await Recovery.inspectPending({
      fs,
      pending,
      targetPath: target,
      mediaRoot,
      linkedEntries: [{ itemId: "item-1", mediaPath: target }],
    });

    assert.equal(result.kind, "completed");
    assert.equal(result.cleanupPending, true);
    assert.equal(result.cleanupExists, true);
    assert.equal(result.targetCheckpointMatch, "hard-link");
    assert.equal(
      Transaction.sameHardLinkRecoveryFingerprint(pending.targetFingerprint, result.targetFingerprint),
      true,
    );
  });
});

test("硬链接恢复不会接受同大小同修改时间但 inode 不同的替换目标", async () => {
  await withFixture(async ({ folder, mediaRoot, source, target }) => {
    await fs.writeFile(source, "clip-data");
    await fs.link(source, target);
    const pending = await pendingFor(source);
    pending.mode = "rename";
    pending.targetMethod = "link";
    pending.targetFingerprint = Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, target));
    await fs.unlink(source);

    const replacement = path.join(folder, "replacement.mp4");
    await fs.writeFile(replacement, "clip-data");
    await fs.utimes(
      replacement,
      new Date(pending.targetFingerprint.mtimeMs),
      new Date(pending.targetFingerprint.mtimeMs),
    );
    await fs.unlink(target);
    await fs.rename(replacement, target);
    const identityAwareFs = {
      ...fs,
      async lstat(nativePath) {
        const stat = await fs.lstat(nativePath);
        if (nativePath === target) stat.mtimeMs = pending.targetFingerprint.mtimeMs;
        return stat;
      },
    };

    const result = await Recovery.inspectPending({
      fs: identityAwareFs,
      pending,
      targetPath: target,
      mediaRoot,
      linkedEntries: [{ itemId: "item-1", mediaPath: target }],
    });

    assert.equal(result.kind, "manual");
    assert.match(result.reason, /目标文件.*身份不一致/);
  });
});

test("隔离区中的原始文件仍存在时，恢复流程会阻止完成事务", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "clip-data");
    const pending = await pendingFor(source);
    pending.cleanupPath = Transaction.cleanupPathFor(source, pending.id);
    await fs.copyFile(source, target);
    pending.targetFingerprint = Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, target));
    await fs.rename(source, pending.cleanupPath);
    const result = await Recovery.inspectPending({
      fs,
      pending,
      targetPath: target,
      mediaRoot,
      linkedEntries: [{ itemId: "item-1", mediaPath: target }],
    });

    assert.equal(result.kind, "completed");
    assert.equal(result.cleanupPending, true);
    assert.equal(result.cleanupExists, true);
    assert.equal(result.remainingSourcePath, pending.cleanupPath);
    assert.equal(await Transaction.exists(fs, source), false);
    assert.equal(await fs.readFile(pending.cleanupPath, "utf8"), "clip-data");
  });
});

test("旧版 keep-source 事务现在要求移除旧副本", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "clip-data");
    const pending = await pendingFor(source);
    pending.deleteSource = false;
    await fs.copyFile(source, target);
    pending.targetFingerprint = Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, target));
    const result = await Recovery.inspectPending({ fs, pending, targetPath: target, mediaRoot, linkedEntries: [{ itemId: "item-1", mediaPath: target }] });
    assert.equal(result.kind, "completed");
    assert.equal(result.cleanupPending, true);
    assert.equal(result.sourceRetained, false);
  });
});

test("恢复流程能区分旧路径上的替换文件与已移动的源文件", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "original");
    const pending = await pendingFor(source);
    await fs.copyFile(source, target);
    pending.targetFingerprint = Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, target));
    await fs.writeFile(source, "replacement-file");
    const result = await Recovery.inspectPending({
      fs,
      pending,
      targetPath: target,
      mediaRoot,
      linkedEntries: [{ itemId: "item-1", mediaPath: target }],
    });

    assert.equal(result.kind, "completed");
    assert.equal(result.cleanupPending, false);
    assert.equal(result.sourceChanged, true);
    assert.equal(result.sourceRetained, false);
    assert.equal(await fs.readFile(source, "utf8"), "replacement-file");
  });
});

test("Premiere 仍指向源文件时，恢复流程不会重新链接", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "clip-data");
    const pending = await pendingFor(source);
    await fs.copyFile(source, target);
    pending.targetFingerprint = Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, target));
    const result = await Recovery.inspectPending({ fs, pending, targetPath: target, mediaRoot, linkedEntries: [{ itemId: "item-1", mediaPath: source }] });
    assert.equal(result.kind, "confirmation-required");
    assert.equal(result.sourcePath, source);
    assert.equal(result.targetPath, target);
    assert.equal(result.sourceExists, true);
    assert.equal(result.targetExists, true);
    assert.equal(result.sourceLinkCount, 1);
    assert.equal(result.targetLinkCount, 0);
    assert.equal(await fs.readFile(source, "utf8"), "clip-data");
    assert.equal(await fs.readFile(target, "utf8"), "clip-data");
  });
});

test("旧素材项 ID 失效但只有唯一同路径候选时必须等待用户确认", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "clip-data");
    const pending = await pendingFor(source);
    pending.itemCount = 2;
    pending.itemIds = ["item-old-1", "item-old-2"];
    await fs.copyFile(source, target);
    pending.targetFingerprint = Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, target));
    const linkedEntries = [
      { itemId: "item-new-1", mediaPath: source },
      { itemId: "item-new-2", mediaPath: source },
    ];
    const { readOnlyFs, mutations } = trackFsMutations(fs);
    let persistCalls = 0;

    const result = await Recovery.inspectPending({
      fs: readOnlyFs,
      pending,
      targetPath: target,
      mediaRoot,
      linkedEntries,
      persistProject: async () => { persistCalls += 1; },
    });

    assert.equal(result.kind, "confirmation-required");
    assert.equal(result.requiresCandidateConfirmation, true);
    assert.ok(Array.isArray(result.candidateEntries));
    assert.deepEqual(
      result.candidateEntries.map((entry) => ({ itemId: entry.itemId, mediaPath: entry.mediaPath })),
      linkedEntries,
    );
    assert.equal(result.sourcePath, source);
    assert.equal(result.targetPath, target);
    assert.equal(result.sourceExists, true);
    assert.equal(result.targetExists, true);
    assert.equal(result.sourceLinkCount, 2);
    assert.equal(result.targetLinkCount, 0);
    assert.deepEqual(mutations, []);
    assert.equal(persistCalls, 0);
    assert.equal(await fs.readFile(source, "utf8"), "clip-data");
    assert.equal(await fs.readFile(target, "utf8"), "clip-data");
  });
});

test("旧素材项 ID 失效且候选数量不唯一时继续保守阻断", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "clip-data");
    const pending = await pendingFor(source);
    await fs.copyFile(source, target);
    const linkedEntries = [
      { itemId: "item-new-1", mediaPath: source },
      { itemId: "item-new-2", mediaPath: source },
    ];
    const { readOnlyFs, mutations } = trackFsMutations(fs);

    const result = await Recovery.inspectPending({
      fs: readOnlyFs,
      pending,
      targetPath: target,
      mediaRoot,
      linkedEntries,
    });

    assert.equal(result.kind, "manual");
    assert.notEqual(result.requiresCandidateConfirmation, true);
    assert.deepEqual(mutations, []);
    assert.equal(await fs.readFile(source, "utf8"), "clip-data");
    assert.equal(await fs.readFile(target, "utf8"), "clip-data");
  });
});

test("源文件和目标文件都缺失时，恢复流程保持阻断", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "clip-data");
    const pending = await pendingFor(source);
    await fs.unlink(source);
    const result = await Recovery.inspectPending({ fs, pending, targetPath: target, mediaRoot, linkedEntries: [{ itemId: "item-1", mediaPath: source }] });
    assert.equal(result.kind, "manual");
    assert.match(result.reason, /都不存在/);
  });
});

test("恢复流程绝不会把越出素材根目录的旁路目标视为有效", async () => {
  await withFixture(async ({ folder, mediaRoot, source }) => {
    await fs.writeFile(source, "clip-data");
    const pending = await pendingFor(source);
    pending.targetRelativePath = "素材\\..\\outside.mp4";
    const outside = path.join(folder, "outside.mp4");
    await fs.writeFile(outside, "clip-data");
    const result = await Recovery.inspectPending({ fs, pending, targetPath: outside, mediaRoot, linkedEntries: [{ itemId: "item-1", mediaPath: outside }] });
    assert.equal(result.kind, "manual");
    assert.match(result.reason, /目标相对路径无效/);
  });
});

test("恢复流程会拒绝大小相同但修改时间不同的目标", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "AAAA");
    const pending = await pendingFor(source);
    await fs.writeFile(target, "BBBB");
    pending.targetFingerprint = Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, target));
    const differentTime = new Date(Number(pending.sourceFingerprint.mtimeMs) + 10000);
    await fs.utimes(target, differentTime, differentTime);
    const result = await Recovery.inspectPending({
      fs,
      pending,
      targetPath: target,
      mediaRoot,
      linkedEntries: [{ itemId: "item-1", mediaPath: target }],
    });
    assert.equal(result.kind, "manual");
    assert.match(result.reason, /身份不一致/);
  });
});

test("源文件被替换后，恢复流程不会清除回滚标记", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "original");
    const pending = await pendingFor(source);
    await fs.writeFile(source, "replacement-file");
    const result = await Recovery.inspectPending({
      fs,
      pending,
      targetPath: target,
      mediaRoot,
      linkedEntries: [{ itemId: "item-1", mediaPath: source }],
    });
    assert.equal(result.kind, "manual");
  });
});

test("恢复流程要求中断组内的每个项目都具有身份信息", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "clip-data");
    const pending = await pendingFor(source);
    pending.itemCount = 2;
    const result = await Recovery.inspectPending({
      fs,
      pending,
      targetPath: target,
      mediaRoot,
      linkedEntries: [{ itemId: "item-1", mediaPath: source }],
    });
    assert.equal(result.kind, "manual");
    assert.match(result.reason, /完整的素材项身份/);
  });
});

test("macOS 恢复路径比较保留大小写，不会误认大小写不同的源文件", async () => {
  const sourcePath = "/Users/Editor/项目/录音/Voice.WAV";
  const targetPath = "/Users/Editor/项目/素材/001_初始素材/Voice.WAV";
  const stat = { size: 4, mtimeMs: 1000, ctimeMs: 1000, birthtimeMs: 1000, dev: 9, ino: 12 };
  const fakeFs = {
    lstat: async (nativePath) => {
      if (nativePath === sourcePath) return stat;
      const error = new Error("no such file or directory");
      error.code = "ENOENT";
      throw error;
    },
  };
  const result = await Recovery.inspectPending({
    fs: fakeFs,
    pending: {
      id: "mac-recovery",
      sourcePath,
      targetRelativePath: "素材\\001_初始素材\\Voice.WAV",
      sourceFingerprint: stat,
      byteCount: 4,
      mode: "copy",
      itemCount: 1,
      itemIds: ["item-1"],
    },
    targetPath,
    mediaRoot: "/Users/Editor/项目/素材",
    linkedEntries: [{ itemId: "item-1", mediaPath: "/Users/Editor/项目/录音/voice.wav" }],
  });
  assert.equal(result.kind, "manual");
  assert.equal(result.sourceLinkCount, 0);
  assert.match(result.reason, /原工程|素材项/);
});
