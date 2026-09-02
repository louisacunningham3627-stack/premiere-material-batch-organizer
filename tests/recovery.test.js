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
  const stat = await fs.lstat(source);
  return {
    id: "tx-recovery",
    sourcePath: source,
    targetRelativePath: "素材\\001_初始素材\\clip.mp4",
    sourceFingerprint: Transaction.fingerprintFromStat(stat),
    byteCount: stat.size,
    batchIndex: 1,
    mode: "copy",
    deleteSource: true,
    itemCount: 1,
    itemIds: ["item-1"],
  };
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
    pending.targetFingerprint = Transaction.fingerprintFromStat(await fs.lstat(target));

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

test("已记录目标不匹配时，恢复流程会保留待处理事务", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "clip-data");
    const pending = await pendingFor(source);
    await fs.copyFile(source, target);
    const targetFingerprint = Transaction.fingerprintFromStat(await fs.lstat(target));
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
    assert.deepEqual(pending.targetFingerprint, recordedFingerprint);
  });
});

test("缺少目标指纹时，恢复流程仍使用旧版大小和时间检查", async () => {
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

    assert.equal(result.kind, "completed");
    assert.equal(result.cleanupPending, true);
  });
});

test("恢复流程会把硬链接 ctime 变化视为同一源文件", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "clip-data");
    const pending = await pendingFor(source);
    pending.mode = "rename";
    pending.sourceFingerprint.ctimeMs = Number(pending.sourceFingerprint.ctimeMs) - 10000;
    await fs.link(source, target);

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

test("隔离区中的原始文件仍存在时，恢复流程会阻止完成事务", async () => {
  await withFixture(async ({ mediaRoot, source, target }) => {
    await fs.writeFile(source, "clip-data");
    const pending = await pendingFor(source);
    pending.cleanupPath = Transaction.cleanupPathFor(source, pending.id);
    await fs.copyFile(source, target);
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
    const result = await Recovery.inspectPending({ fs, pending, targetPath: target, mediaRoot, linkedEntries: [{ itemId: "item-1", mediaPath: source }] });
    assert.equal(result.kind, "manual");
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
    assert.match(result.reason, /时间/);
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
