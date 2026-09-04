const test = require("node:test");
const assert = require("node:assert/strict");
const State = require("../src/state");

const now = new Date("2026-09-02T02:00:00.000Z");

test("创建一个共享初始批次且不复制 .prproj", () => {
  const createdAt = new Date(2026, 8, 4, 10, 0, 0);
  const state = State.createState("I:\\剪辑\\新手", createdAt);
  assert.equal(state.batches.length, 1);
  assert.equal(state.batches[0].name, "2026年09月04日添加素材");
  assert.equal(JSON.stringify(state).includes(".prproj"), false);
  assert.equal(State.currentBatchPath(state, "I:\\剪辑\\新手"), "I:\\剪辑\\新手\\素材\\2026年09月04日添加素材");
});

test("多个 .prproj 名称会注册到同一素材空间", () => {
  let state = State.createState("I:\\剪辑\\新手", now);
  state = State.registerProject(state, "I:\\剪辑\\新手\\新手-v1.prproj", "新手-v1.prproj", now);
  state = State.registerProject(state, "I:\\剪辑\\新手\\新手-接手.prproj", "新手-接手.prproj", now);
  assert.equal(Object.keys(state.projects).length, 2);
  assert.equal(state.mediaSpaceId.startsWith("media-"), true);
});

test("首次收集会保留分类结果，不再把现有外部素材改写成 baseline", () => {
  let state = State.createState("I:\\项目", now);
  state = State.initializeBaseline(
    state,
    [{ mediaPath: "C:\\Downloads\\old.mp4" }, { mediaPath: "I:\\项目\\素材\\old.wav" }],
    [{ kind: "collect" }, { kind: "managed" }],
    now,
  );
  assert.equal(state.initialized, true);
  assert.equal(state.knownMedia["c:\\downloads\\old.mp4"].status, "collect");
  assert.equal(state.knownMedia["i:\\项目\\素材\\old.wav"].status, "managed");
});

test("旧 baseline 接受现有素材归集策略时幂等且不删除原路径证据", () => {
  const projectPath = "I:\\项目\\剪辑-v1.prproj";
  const mediaPath = "C:\\Downloads\\legacy.mp4";
  const fingerprint = { size: 4096, mtimeMs: 1000, ctimeMs: 900 };
  let raw = State.createState("I:\\项目", now);
  raw.initialized = true;
  delete raw.collectionPolicyVersion;
  raw = State.registerProject(raw, projectPath, "剪辑-v1.prproj", now);
  raw = State.markProjectBaseline(raw, projectPath, [{ mediaPath, sourceFingerprint: fingerprint }], now);

  let hydrated = State.hydrateState(raw, "I:\\项目", now);
  assert.equal(State.needsCollectionPolicyAcceptance(hydrated), true);
  assert.equal(State.projectBaselineStatus(hydrated, projectPath, mediaPath, fingerprint), "match");

  hydrated = State.acceptCollectionPolicy(hydrated, now);
  assert.equal(State.needsCollectionPolicyAcceptance(hydrated), false);
  assert.equal(hydrated.collectionPolicyVersion, State.COLLECTION_POLICY_VERSION);
  assert.equal(State.projectBaselineStatus(hydrated, projectPath, mediaPath, fingerprint), "match");

  const acceptedAgain = State.acceptCollectionPolicy(hydrated, now);
  assert.equal(acceptedAgain.collectionPolicyVersion, State.COLLECTION_POLICY_VERSION);
  assert.deepEqual(acceptedAgain.projects, hydrated.projects);
});

test("提交事务会记录路径映射和批次总计", () => {
  let state = State.createState("I:\\项目", now);
  state = State.beginTransaction(state, {
    id: "tx-1",
    sourcePath: "C:\\Downloads\\new.mp4",
    targetPath: "I:\\项目\\素材\\001_初始素材\\new.mp4",
    targetRelativePath: "素材\\001_初始素材\\new.mp4",
    sourceFingerprint: { size: 1024, mtimeMs: 10, ctimeMs: 20 },
    byteCount: 1024,
    batchIndex: 1,
  }, now);
  state = State.commitTransaction(state, { id: "tx-1", mode: "copy", modeEvidence: { proven: false, reason: "测试" }, byteCount: 1024 }, now);
  assert.equal(state.pendingTransaction, null);
  assert.equal(state.pathMappings["c:\\downloads\\new.mp4"][0].targetRelativePath, "素材\\001_初始素材\\new.mp4");
  assert.equal(state.batches[0].fileCount, 1);
  assert.equal(state.batches[0].byteCount, 1024);
  assert.equal(state.transactions[0].modeEvidence.proven, false);
});

test("旧路径被替换时会记录 sourceChanged，且不会声称源文件仍被保留", () => {
  let state = State.createState("I:\\项目", now);
  state = State.beginTransaction(state, {
    id: "tx-source-changed",
    sourcePath: "C:\\Downloads\\new.mp4",
    targetPath: "I:\\项目\\素材\\001_初始素材\\new.mp4",
    targetRelativePath: "素材\\001_初始素材\\new.mp4",
    sourceFingerprint: { size: 1024, mtimeMs: 10, ctimeMs: 20 },
    byteCount: 1024,
    batchIndex: 1,
  }, now);
  state = State.commitTransaction(state, {
    id: "tx-source-changed",
    mode: "copy",
    sourceChanged: true,
    sourceRetained: true,
  }, now);

  assert.equal(state.transactions[0].sourceChanged, true);
  assert.equal(state.transactions[0].sourceRetained, false);
});

test("cleanup-pending 状态不会提交事务或递增交接文件夹", () => {
  let state = State.createState("I:\\项目", now);
  state = State.beginTransaction(state, {
    id: "tx-cleanup",
    sourcePath: "C:\\Downloads\\locked.mp4",
    targetPath: "I:\\项目\\素材\\001_初始素材\\locked.mp4",
    targetRelativePath: "素材\\001_初始素材\\locked.mp4",
    sourceFingerprint: { size: 64, mtimeMs: 10, ctimeMs: 20 },
    byteCount: 64,
    batchIndex: 1,
  }, now);
  state = State.commitTransaction(state, {
    id: "tx-cleanup",
    cleanupPending: true,
    cleanupWarning: "原位置文件尚未删除",
  }, now);

  assert.equal(state.pendingTransaction.status, "cleanup-pending");
  assert.equal(state.transactions.length, 0);
  assert.equal(state.batches[0].fileCount, 0);
  const hydrated = State.hydrateState(state, "I:\\项目", now);
  assert.equal(hydrated.pendingTransaction.status, "cleanup-pending");
});

test("同一源路径会为不同文件保留独立映射", () => {
  let state = State.createState("I:\\项目", now);
  const sourcePath = "C:\\Downloads\\new.mp4";
  state = State.beginTransaction(state, {
    id: "tx-first",
    sourcePath,
    targetPath: "I:\\项目\\素材\\001_初始素材\\new.mp4",
    targetRelativePath: "素材\\001_初始素材\\new.mp4",
    sourceFingerprint: { size: 100, mtimeMs: 10, ctimeMs: 20 },
    byteCount: 100,
    batchIndex: 1,
  }, now);
  state = State.commitTransaction(state, { id: "tx-first", mode: "copy" }, now);
  state = State.beginTransaction(state, {
    id: "tx-second",
    sourcePath,
    targetPath: "I:\\项目\\素材\\001_初始素材\\new (2).mp4",
    targetRelativePath: "素材\\001_初始素材\\new (2).mp4",
    sourceFingerprint: { size: 220, mtimeMs: 30, ctimeMs: 40 },
    byteCount: 220,
    batchIndex: 1,
  }, now);
  state = State.commitTransaction(state, { id: "tx-second", mode: "copy" }, now);

  assert.equal(state.pathMappings["c:\\downloads\\new.mp4"].length, 2);
  assert.deepEqual(
    state.pathMappings["c:\\downloads\\new.mp4"].map((mapping) => mapping.targetRelativePath),
    ["素材\\001_初始素材\\new.mp4", "素材\\001_初始素材\\new (2).mp4"],
  );
  assert.equal(state.batches[0].fileCount, 2);
  assert.equal(state.batches[0].byteCount, 320);
});

test("重复提交同一事务不会重复计入批次总数", () => {
  let state = State.createState("I:\\项目", now);
  state = State.beginTransaction(state, {
    id: "tx-idempotent",
    sourcePath: "C:\\Downloads\\only-once.mp4",
    targetPath: "I:\\项目\\素材\\001_初始素材\\only-once.mp4",
    targetRelativePath: "素材\\001_初始素材\\only-once.mp4",
    sourceFingerprint: { size: 512, mtimeMs: 10, ctimeMs: 20 },
    byteCount: 512,
    batchIndex: 1,
  }, now);
  const result = { id: "tx-idempotent", mode: "copy", byteCount: 512 };
  state = State.commitTransaction(state, result, now);
  state = State.beginTransaction(state, {
    id: "tx-idempotent",
    sourcePath: "C:\\Downloads\\only-once.mp4",
    targetRelativePath: "素材\\001_初始素材\\only-once.mp4",
    batchIndex: 1,
  }, now);
  state = State.commitTransaction(state, result, now);

  assert.equal(state.transactions.length, 1);
  assert.equal(state.batches[0].fileCount, 1);
  assert.equal(state.batches[0].byteCount, 512);
  assert.equal(state.pendingTransaction, null);
});

test("重复使用的事务 ID 不能清除另一项待处理操作", () => {
  let state = State.createState("I:\\项目", now);
  state = State.beginTransaction(state, {
    id: "tx-collision",
    sourcePath: "C:\\Downloads\\first.mp4",
    targetRelativePath: "素材\\001_初始素材\\first.mp4",
    byteCount: 100,
    batchIndex: 1,
  }, now);
  state = State.commitTransaction(state, { id: "tx-collision", mode: "copy" }, now);
  state = State.beginTransaction(state, {
    id: "tx-collision",
    sourcePath: "C:\\Downloads\\other.mp4",
    targetRelativePath: "素材\\001_初始素材\\other.mp4",
    byteCount: 200,
    batchIndex: 1,
  }, now);
  state = State.commitTransaction(state, { id: "tx-collision", mode: "copy" }, now);

  assert.equal(state.transactions.length, 1);
  assert.equal(state.pendingTransaction.status, "conflict");
  assert.match(state.pendingTransaction.error, /事务 ID/);
  assert.equal(state.batches[0].fileCount, 1);
});

test("每个 .prproj（包括 Auto-Save 快照）都有独立基线", () => {
  let state = State.createState("I:\\项目", now);
  const first = "I:\\项目\\Adobe Premiere Pro Auto-Save\\剪辑-2026-09-01.prproj";
  const second = "I:\\项目\\Adobe Premiere Pro Auto-Save\\剪辑-2026-09-02.prproj";
  state = State.registerProject(state, first, "剪辑-2026-09-01.prproj", now);
  state = State.registerProject(state, second, "剪辑-2026-09-02.prproj", now);
  state = State.markProjectBaseline(state, first, now);

  assert.equal(State.projectHasBaseline(state, first), true);
  assert.equal(State.projectHasBaseline(state, second), false);
  assert.notEqual(State.projectKey(first), State.projectKey(second));
});

test("一个工程的基线不会忽略另一工程中的新素材", () => {
  let state = State.createState("I:\\项目", now);
  const first = "I:\\项目\\剪辑-v1.prproj";
  const second = "I:\\项目\\剪辑-v2.prproj";
  const mediaPath = "C:\\Downloads\\today.mp4";
  const fingerprint = { size: 900, mtimeMs: 10, ctimeMs: 20 };
  state = State.registerProject(state, first, "剪辑-v1.prproj", now);
  state = State.registerProject(state, second, "剪辑-v2.prproj", now);
  state = State.markProjectBaseline(state, first, [{ mediaPath, sourceFingerprint: fingerprint }], now);

  assert.equal(State.projectBaselineMatches(state, first, mediaPath, fingerprint), true);
  assert.equal(State.projectBaselineMatches(state, second, mediaPath, fingerprint), false);
  assert.equal(State.projectBaselineMatches(state, first, mediaPath, { ...fingerprint, size: 901 }), false);
  assert.equal(State.projectBaselineMatches(state, first, mediaPath, { ...fingerprint, ino: 200 }), true);

  state = State.markProjectBaseline(state, first, [{ mediaPath, sourceFingerprint: { ...fingerprint, ino: 100 } }], now);
  assert.equal(State.projectBaselineMatches(state, first, mediaPath, { ...fingerprint, ino: 200 }), false);
});

test("未经验证的基线不会静默匹配后来出现的文件", () => {
  const projectPath = "I:\\项目\\剪辑-v1.prproj";
  const mediaPath = "C:\\Downloads\\offline-then-reused.mp4";
  let state = State.createState("I:\\项目", now);
  state = State.registerProject(state, projectPath, "剪辑-v1.prproj", now);
  state = State.markProjectBaseline(state, projectPath, [{ mediaPath, sourceFingerprint: null }], now);

  const laterFingerprint = { size: 2048, mtimeMs: 50, ctimeMs: 60 };
  assert.equal(State.projectBaselineStatus(state, projectPath, mediaPath, laterFingerprint), "unverified");
  assert.equal(State.projectBaselineMatches(state, projectPath, mediaPath, laterFingerprint), false);

  state = State.setProjectBaselineEntry(state, projectPath, mediaPath, laterFingerprint, now);
  assert.equal(State.projectBaselineMatches(state, projectPath, mediaPath, laterFingerprint), true);
  state = State.removeProjectBaselineEntry(state, projectPath, mediaPath, now);
  assert.equal(State.projectBaselineStatus(state, projectPath, mediaPath, laterFingerprint), "none");
});

test("已提交的映射会存储目标指纹并可刷新该指纹", () => {
  const sourcePath = "C:\\Downloads\\mapped.mp4";
  const targetRelativePath = "素材\\001_初始素材\\mapped.mp4";
  let state = State.createState("I:\\项目", now);
  state = State.beginTransaction(state, {
    id: "tx-target-fingerprint",
    sourcePath,
    targetRelativePath,
    sourceFingerprint: { size: 100, mtimeMs: 10 },
    byteCount: 100,
    batchIndex: 1,
  }, now);
  state = State.commitTransaction(state, {
    id: "tx-target-fingerprint",
    targetFingerprint: { size: 100, mtimeMs: 20, dev: 2, ino: 3 },
  }, now);

  assert.equal(state.pathMappings["c:\\downloads\\mapped.mp4"][0].targetFingerprint.mtimeMs, 20);
  state = State.updateMappingTargetFingerprint(
    state,
    sourcePath,
    targetRelativePath,
    { size: 100, mtimeMs: 30 },
    now,
  );
  assert.equal(state.pathMappings["c:\\downloads\\mapped.mp4"][0].targetFingerprint.mtimeMs, 30);
});

test("工程基线只会在后续移动被记录后释放重复路径", () => {
  const projectPath = "I:\\项目\\剪辑-v2.prproj";
  const mediaPath = "C:\\Downloads\\clip.mp4";
  const fingerprint = { size: 100, mtimeMs: 10, ctimeMs: 20 };
  let state = State.createState("I:\\项目", new Date("2026-09-02T01:00:00.000Z"));
  state = State.registerProject(state, projectPath, "剪辑-v2.prproj", new Date("2026-09-02T01:00:00.000Z"));
  state = State.markProjectBaseline(state, projectPath, [{ mediaPath, sourceFingerprint: fingerprint }], new Date("2026-09-02T02:00:00.000Z"));

  assert.equal(State.mappingMovedAfterProjectBaseline(state, projectPath, [{ movedAt: "2026-09-02T01:30:00.000Z" }]), false);
  assert.equal(State.mappingMovedAfterProjectBaseline(state, projectPath, [{ movedAt: "2026-09-02T03:00:00.000Z" }]), true);
  assert.equal(State.projectBaselineMatches(state, projectPath, mediaPath, fingerprint), true);
});

test("缺少有效正数修改时间的基线绝不会被信任", () => {
  const projectPath = "I:\\项目\\剪辑-v1.prproj";
  const mediaPath = "C:\\Downloads\\mtime-missing.mp4";
  let state = State.createState("I:\\项目", now);
  state = State.registerProject(state, projectPath, "剪辑-v1.prproj", now);
  state = State.markProjectBaseline(state, projectPath, [{
    mediaPath,
    sourceFingerprint: { size: 500, mtimeMs: 0 },
  }], now);

  assert.equal(State.projectBaselineStatus(state, projectPath, mediaPath, { size: 500, mtimeMs: 9000 }), "unverified");
  assert.equal(State.projectBaselineStatus(state, projectPath, mediaPath, { size: 500, mtimeMs: 0 }), "unavailable");
});

test("可解析但不完整或来自未来版本的状态不会恢复为新素材空间", () => {
  assert.equal(State.isCompatibleState({}), false);
  assert.throws(
    () => State.hydrateState({}, "I:\\项目", now),
    (error) => error.code === "MATERIAL_BATCH_STATE_INVALID",
  );

  const future = State.createState("I:\\项目", now);
  future.schemaVersion = State.SCHEMA_VERSION + 1;
  assert.equal(State.isCompatibleState(future), false);
  assert.throws(
    () => State.validateStoredState(future),
    (error) => error.code === "MATERIAL_BATCH_STATE_SCHEMA_UNSUPPORTED" && error.preventBackupFallback === true,
  );
  assert.throws(
    () => State.hydrateState(future, "I:\\项目", now),
    (error) => error.code === "MATERIAL_BATCH_STATE_SCHEMA_UNSUPPORTED",
  );
});

test("未来整理策略不会被当前版本接受或降级", () => {
  for (const futureVersion of [State.COLLECTION_POLICY_VERSION + 1, "999", Infinity]) {
    const future = State.createState("I:\\项目", now);
    future.initialized = true;
    future.collectionPolicyVersion = futureVersion;

    assert.equal(State.isCompatibleState(future), false);
    assert.throws(
      () => State.validateStoredState(future),
      (error) => error.code === "MATERIAL_BATCH_STATE_POLICY_UNSUPPORTED"
        && error.preventBackupFallback === true,
    );
    assert.throws(
      () => State.hydrateState(future, "I:\\项目", now),
      (error) => error.code === "MATERIAL_BATCH_STATE_POLICY_UNSUPPORTED",
    );
    assert.throws(
      () => State.acceptCollectionPolicy(future, now),
      (error) => error.code === "MATERIAL_BATCH_STATE_POLICY_UNSUPPORTED",
    );
  }
});

test("等待 Premiere 保存的状态会在恢复后保留并阻断文件事务", () => {
  let state = State.createState("I:\\项目", now);
  state = State.beginProjectSave(state, {
    id: "save-1",
    sourcePath: "C:\\Downloads\\old.mp4",
    targetRelativePath: "素材\\001_初始素材\\old.mp4",
    targetFingerprint: { size: 100, mtimeMs: 2000 },
    projectPath: "I:\\项目\\剪辑.prproj",
    projectIdentity: "guid|i:\\项目\\剪辑.prproj",
    itemIds: ["clip-1"],
    itemCount: 1,
  }, now);
  state = State.failProjectSave(state, "save returned false", now);

  const hydrated = State.hydrateState(state, "I:\\项目", now);
  assert.equal(hydrated.pendingProjectSave.status, "failed");
  assert.throws(
    () => State.beginTransaction(hydrated, { id: "tx-should-not-start" }, now),
    /补链尚未确认保存/,
  );
  assert.equal(State.clearPendingProjectSave(hydrated, now).pendingProjectSave, null);
});

test("恢复状态时会拒绝可能越出素材根目录的旁路文件路径", () => {
  const raw = State.createState("I:\\项目", now);
  raw.mediaFolderName = "..";
  raw.batches[0].name = "..\\outside";
  raw.pathMappings = {
    "c:\\downloads\\unsafe.mp4": { targetRelativePath: "素材\\..\\outside.mp4" },
    "c:\\downloads\\safe.mp4": { targetRelativePath: "素材\\001_初始素材\\safe.mp4" },
  };
  const hydrated = State.hydrateState(raw, "I:\\项目", now);

  assert.equal(hydrated.mediaFolderName, "素材");
  assert.equal(hydrated.batches[0].name, State.createState("I:\\项目", now).batches[0].name);
  assert.equal(hydrated.pathMappings["c:\\downloads\\unsafe.mp4"], undefined);
  assert.equal(hydrated.pathMappings["c:\\downloads\\safe.mp4"].length, 1);
});

test("同日交接使用稳定的非序号名称，跨日恢复中文日期基础名", () => {
  const morning = new Date(2026, 8, 4, 9, 0, 0);
  let state = State.createState("I:\\项目", morning);
  const firstName = state.batches[0].name;
  state = State.lockAndCreateNextBatch(state, new Date(2026, 8, 4, 14, 5, 0));
  assert.equal(state.batches[0].status, "locked");
  const secondName = state.batches[1].name;
  assert.notEqual(secondName, firstName);
  assert.match(secondName, /2026年09月04日/);
  assert.match(secondName, /添加素材/);
  assert.doesNotMatch(secondName, /^\d+_|第\d+次/);
  assert.equal(State.currentBatch(state).index, 2);

  state = State.lockAndCreateNextBatch(state, new Date(2026, 8, 4, 14, 6, 0));
  const thirdName = state.batches[2].name;
  assert.notEqual(thirdName, firstName);
  assert.notEqual(thirdName, secondName);
  assert.doesNotMatch(thirdName, /^\d+_|第\d+次/);
  assert.equal(State.currentBatch(state).index, 3, "内部批次 ID 仍应稳定递增");

  state = State.lockAndCreateNextBatch(state, new Date(2026, 8, 5, 9, 0, 0));
  assert.equal(state.batches[3].name, "2026年09月05日添加素材");
  assert.equal(State.currentBatch(state).index, 4);
});

test("恢复合法旧批次时不改名，只让后续新批次使用新格式", () => {
  const raw = State.createState("I:\\项目", new Date(2026, 8, 3, 9, 0, 0));
  raw.batches = [
    { ...raw.batches[0], index: 1, name: "001_初始素材", status: "locked" },
    { ...raw.batches[0], index: 2, name: "002_2026-09-03", status: "open" },
  ];
  raw.currentBatchIndex = 2;
  raw.pathMappings = {
    "c:\\downloads\\legacy.mp4": {
      sourcePath: "C:\\Downloads\\legacy.mp4",
      targetRelativePath: "素材\\001_初始素材\\legacy.mp4",
    },
  };

  let hydrated = State.hydrateState(raw, "I:\\项目", new Date(2026, 8, 4, 9, 0, 0));
  assert.deepEqual(hydrated.batches.map((batch) => batch.name), ["001_初始素材", "002_2026-09-03"]);
  assert.equal(State.currentBatchPath(hydrated, "I:\\项目"), "I:\\项目\\素材\\002_2026-09-03");
  assert.equal(
    hydrated.pathMappings["c:\\downloads\\legacy.mp4"][0].targetRelativePath,
    "素材\\001_初始素材\\legacy.mp4",
  );

  hydrated = State.lockAndCreateNextBatch(hydrated, new Date(2026, 8, 4, 15, 0, 0));
  assert.deepEqual(hydrated.batches.slice(0, 2).map((batch) => batch.name), ["001_初始素材", "002_2026-09-03"]);
  assert.match(hydrated.batches[2].name, /2026年09月04日/);
  assert.doesNotMatch(hydrated.batches[2].name, /^\d+_/);
});

test("恢复状态时，即使路径变化也会保留保护素材库 ID", () => {
  let state = State.createState("I:\\项目", now);
  state = State.addProtectedLibrary(state, "post-kit-v10", "后期包 v10", now);
  const handedOff = State.hydrateState(state, "E:\\接手\\项目", now);
  assert.deepEqual(handedOff.protectedLibraries, [{ libraryId: "post-kit-v10", label: "后期包 v10" }]);
  assert.equal(
    State.currentBatchPath(handedOff, "E:\\接手\\项目"),
    "E:\\接手\\项目\\素材\\" + State.currentBatch(state).name,
  );
});

test("恢复旧 Windows 状态键时按素材真实路径迁移，且相对路径比较兼容旧反斜杠", () => {
  const raw = State.createState("/Users/Editor/项目", now);
  raw.knownMedia = {
    "\\users\\editor\\downloads\\voice.wav": {
      path: "/Users/Editor/Downloads/Voice.WAV",
      status: "moved",
    },
  };
  raw.pathMappings = {
    "\\users\\editor\\downloads\\voice.wav": {
      sourcePath: "/Users/Editor/Downloads/Voice.WAV",
      targetRelativePath: "素材\\001_初始素材\\Voice.WAV",
    },
  };
  const hydrated = State.hydrateState(raw, "/Users/Editor/项目", now);
  assert.ok(hydrated.knownMedia["/Users/Editor/Downloads/Voice.WAV"]);
  assert.ok(hydrated.pathMappings["/Users/Editor/Downloads/Voice.WAV"]);
  let updated = State.updateMappingTargetFingerprint(
    hydrated,
    "/Users/Editor/Downloads/Voice.WAV",
    "素材/001_初始素材/voice.wav",
    { size: 4, mtimeMs: 10 },
    now,
  );
  assert.equal(updated.pathMappings["/Users/Editor/Downloads/Voice.WAV"][0].targetFingerprint.mtimeMs, 10);
});

test("恢复状态时会规范旧工程键，并拒绝规范后冲突的工程记录", () => {
  const projectPath = "C:\\work\\edit.prproj";
  let raw = State.createState("C:\\work", now);
  raw = State.registerProject(raw, projectPath, "edit.prproj", now);
  raw = State.markProjectBaseline(raw, projectPath, [], now);
  const canonicalKey = State.projectKey(projectPath);
  const project = raw.projects[canonicalKey];
  raw.projects = {
    "c:\\work\\sub\\..\\edit.prproj": project,
  };

  const hydrated = State.hydrateState(raw, "C:\\work", now);
  assert.equal(State.projectHasBaseline(hydrated, "C:\\work\\sub\\..\\edit.prproj"), true);
  assert.deepEqual(Object.keys(hydrated.projects), [canonicalKey]);

  raw.projects[canonicalKey] = Object.assign({}, project, { displayName: "冲突工程" });
  assert.throws(
    () => State.hydrateState(raw, "C:\\work", now),
    (error) => error.code === "MATERIAL_BATCH_STATE_INVALID" && /冲突的工程记录/.test(error.message),
  );
});

test("恢复状态时拒绝规范后冲突的工程基线素材记录", () => {
  const projectPath = "C:\\work\\edit.prproj";
  let raw = State.createState("C:\\work", now);
  raw = State.registerProject(raw, projectPath, "edit.prproj", now);
  const key = State.projectKey(projectPath);
  raw.projects[key].baselineEstablished = true;
  raw.projects[key].baselineVersion = 1;
  raw.projects[key].baselineMedia = {
    "c:\\media\\temp\\..\\clip.wav": { size: 1, mtimeMs: 10 },
    "c:\\media\\clip.wav": { size: 2, mtimeMs: 20 },
  };

  assert.throws(
    () => State.hydrateState(raw, "C:\\work", now),
    (error) => error.code === "MATERIAL_BATCH_STATE_INVALID" && /冲突的工程基线记录/.test(error.message),
  );
});
