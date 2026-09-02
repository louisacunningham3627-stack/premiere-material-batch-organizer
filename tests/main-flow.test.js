const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const Core = require("../src/core");
const State = require("../src/state");
const Transaction = require("../src/transaction");
const Recovery = require("../src/recovery");
const Coordination = require("../src/coordination");
const ScanPolicy = require("../src/scan-policy");

const mainSource = fs.readFileSync(require.resolve("../src/main.js"), "utf8");

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function createDocument(resolveElement) {
  const listeners = new Map();
  return {
    readyState: "loading",
    body: { dataset: {} },
    addEventListener(name, listener) { listeners.set(name, listener); },
    getElementById(id) { return resolveElement ? resolveElement(id) : null; },
    listeners,
  };
}

function createHarness() {
  const document = createDocument();
  const windowListeners = new Map();
  const entrypoints = {};
  const readGate = deferred();
  const context = {
    project: { path: "D:\\handoff\\Episode.prproj", name: "Episode" },
    projectPath: "D:\\handoff\\Episode.prproj",
    projectName: "Episode",
    identity: "path:d:\\handoff\\episode.prproj",
    workspaceRoot: "D:\\handoff",
  };
  let readCount = 0;
  let inventoryCount = 0;

  const storage = {
    MISSING_REVISION: null,
    statePath(root) { return `${root}\\.premiere-material-space.json`; },
    async readJsonWithBackup() {
      readCount += 1;
      if (readCount === 1) {
        const error = new Error("第一次读取整理记录失败");
        error.code = "EACCES";
        throw error;
      }
      await readGate.promise;
      return { missing: true, recovered: false, revision: null };
    },
    async writeJsonAtomic() {
      return { revision: "test-revision" };
    },
  };

  const premiere = {
    async activeContext() { return context; },
    async inventoryProject() {
      inventoryCount += 1;
      return { entries: [], warnings: [] };
    },
    assertCompleteInventory(inventory) {
      if (inventory.warnings.length) throw new Error("unexpected inventory warning");
    },
    groupByMediaPath() { return []; },
    async contextStillActive() { return true; },
  };

  const fsMock = {
    async lstat() {
      return { isDirectory: () => true };
    },
    async mkdir() {},
  };

  const localStorage = {
    values: new Map(),
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
    setItem(key, value) { this.values.set(key, String(value)); },
  };

  const window = {
    addEventListener(name, listener) {
      windowListeners.set(name, listener);
    },
    removeEventListener() {},
    listeners: windowListeners,
  };

  const uxp = {
    entrypoints: {
      setup(config) {
        Object.assign(entrypoints, config.panels.materialBatchOrganizer);
      },
    },
    shell: { async openPath() {} },
  };

  const ppro = {
    Constants: {},
    ProjectEvent: {},
    EventManager: {},
  };

  const sandbox = {
    console,
    document,
    window,
    localStorage,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    MaterialBatchCore: Core,
    MaterialBatchState: State,
    MaterialBatchTransaction: Transaction,
    MaterialBatchRecovery: Recovery,
    MaterialBatchCoordination: Coordination,
    MaterialBatchPremiere: premiere,
    MaterialBatchStorage: storage,
    MaterialBatchScanPolicy: ScanPolicy,
    require(name) {
      if (name === "uxp") return uxp;
      if (name === "premierepro") return ppro;
      if (name === "fs") return fsMock;
      throw new Error(`unexpected require: ${name}`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(mainSource, sandbox, { filename: "src/main.js" });

  return {
    document,
    window,
    entrypoints,
    readGate,
    get readCount() { return readCount; },
    get inventoryCount() { return inventoryCount; },
  };
}

function createMappingHarness() {
  const sourcePath = "C:\\Downloads\\mapped.mp4";
  const targetRelativePath = "素材\\001_初始素材\\mapped.mp4";
  const targetPath = `D:\\handoff\\${targetRelativePath}`;
  const targetFingerprint = { size: 100, mtimeMs: 2000, ctimeMs: 3000 };
  const workspaceRoot = "D:\\handoff";
  const projectPath = `${workspaceRoot}\\Episode.prproj`;
  const stateAction = { dataset: {}, hidden: false, textContent: "" };
  const document = createDocument((id) => id === "stateAction" ? stateAction : null);
  const windowListeners = new Map();
  const entrypoints = {};
  const projectItems = [];
  const project = {
    path: projectPath,
    name: "Episode",
    saveCalls: 0,
    async save() {
      this.saveCalls += 1;
      return this.saveCalls > 1;
    },
  };
  const context = {
    project,
    projectPath,
    projectName: "Episode",
    identity: "path:d:\\handoff\\episode.prproj",
    workspaceRoot,
  };

  let clip;
  function inventoryEntry() {
    return { itemId: "clip-1", mediaPath: clip.mediaPath, clip, itemName: "mapped.mp4" };
  }
  const premiere = {
    async activeContext() { return context; },
    async inventoryProject() { return { entries: [inventoryEntry()], warnings: [] }; },
    assertCompleteInventory(inventory) {
      if (inventory.warnings.length) throw new Error("unexpected inventory warning");
    },
    groupByMediaPath(entries) {
      return [{
        key: Core.normalizePathForComparison(entries[0].mediaPath),
        mediaPath: entries[0].mediaPath,
        entries,
      }];
    },
    async contextStillActive() { return true; },
  };
  clip = {
    mediaPath: sourcePath,
    async canChangeMediaPath() { return true; },
    async changeMediaFilePath(nextPath) {
      this.mediaPath = nextPath;
      return true;
    },
    async refreshMedia() {},
    async getMediaFilePath() { return this.mediaPath; },
    async isOffline() { return false; },
  };
  projectItems.push(clip);

  let state = State.createState(workspaceRoot, new Date("2026-09-03T00:00:00.000Z"));
  state.initialized = true;
  state.pathMappings[Core.normalizePathForComparison(sourcePath)] = [{
    sourcePath,
    targetRelativePath,
    targetFingerprint,
    sourceFingerprint: { size: 100, mtimeMs: 1000 },
    batchIndex: 1,
    byteCount: 100,
  }];
  let latestState = JSON.parse(JSON.stringify(state));
  let readCount = 0;
  let writeCount = 0;
  const storage = {
    MISSING_REVISION: null,
    statePath(root) { return `${root}\\.premiere-material-space.json`; },
    async readJsonWithBackup() {
      readCount += 1;
      return { value: JSON.parse(JSON.stringify(latestState)), missing: false, recovered: false, revision: `r${writeCount}` };
    },
    async writeJsonAtomic(_fs, _path, nextState) {
      writeCount += 1;
      latestState = JSON.parse(JSON.stringify(nextState));
      return { revision: `r${writeCount}` };
    },
  };
  const fsMock = {
    async lstat(nativePath) {
      if (Core.samePath(nativePath, targetPath)) return {
        isFile: () => true,
        isDirectory: () => false,
        ...targetFingerprint,
      };
      const error = new Error("path not found");
      error.code = "ENOENT";
      throw error;
    },
  };
  const localStorage = {
    values: new Map(),
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
    setItem(key, value) { this.values.set(key, String(value)); },
  };
  const window = {
    addEventListener(name, listener) { windowListeners.set(name, listener); },
    removeEventListener() {},
    listeners: windowListeners,
  };
  const uxp = {
    entrypoints: {
      setup(config) { Object.assign(entrypoints, config.panels.materialBatchOrganizer); },
    },
    shell: { async openPath() {} },
  };
  const ppro = { Constants: {}, ProjectEvent: {}, EventManager: {} };
  const transaction = Object.assign({}, Transaction, {
    async relinkExisting(options) {
      for (const item of options.projectItems) {
        await item.changeMediaFilePath(options.targetPath, false);
        await item.refreshMedia();
      }
      if ((await options.persistProject()) === false) {
        const error = new Error("补链后的 Premiere 工程保存失败");
        error.rollbackWarnings = ["补链未确认保存，已保持 Premiere 指向整理后的位置，未自动恢复旧路径"];
        throw error;
      }
      return { targetPath: options.targetPath, itemCount: options.projectItems.length };
    },
  });
  const sandbox = {
    console,
    document,
    window,
    localStorage,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    MaterialBatchCore: Core,
    MaterialBatchState: State,
    MaterialBatchTransaction: transaction,
    MaterialBatchRecovery: Recovery,
    MaterialBatchCoordination: Coordination,
    MaterialBatchPremiere: premiere,
    MaterialBatchStorage: storage,
    MaterialBatchScanPolicy: ScanPolicy,
    require(name) {
      if (name === "uxp") return uxp;
      if (name === "premierepro") return ppro;
      if (name === "fs") return fsMock;
      throw new Error(`unexpected require: ${name}`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(mainSource, sandbox, { filename: "src/main.js" });

  return {
    document,
    window,
    entrypoints,
    stateAction,
    project,
    clip,
    targetPath,
    get latestState() { return latestState; },
    get readCount() { return readCount; },
    get writeCount() { return writeCount; },
  };
}

function createRecoveryRaceHarness() {
  const sourcePath = "C:\\Downloads\\race.mp4";
  const targetRelativePath = "素材\\001_初始素材\\race.mp4";
  const targetPath = `D:\\handoff\\${targetRelativePath}`;
  const workspaceRoot = "D:\\handoff";
  const projectPath = `${workspaceRoot}\\Episode.prproj`;
  const identity = "path:d:\\handoff\\episode.prproj";
  const stateAction = { dataset: {}, hidden: false, textContent: "" };
  const document = createDocument((id) => id === "stateAction" ? stateAction : null);
  const windowListeners = new Map();
  const entrypoints = {};
  let targetFingerprint = { size: 100, mtimeMs: 2000, ctimeMs: 3000 };
  let saveCalls = 0;
  const project = {
    path: projectPath,
    name: "Episode",
    async save() {
      saveCalls += 1;
      targetFingerprint = { size: 100, mtimeMs: 9999, ctimeMs: 9999 };
      return true;
    },
  };
  const context = { project, projectPath, projectName: "Episode", identity, workspaceRoot };
  const clip = {
    mediaPath: targetPath,
    async getMediaFilePath() { return this.mediaPath; },
  };
  const premiere = {
    async activeContext() { return context; },
    async inventoryProject() {
      return { entries: [{ itemId: "clip-1", mediaPath: clip.mediaPath, clip, itemName: "race.mp4" }], warnings: [] };
    },
    assertCompleteInventory(inventory) {
      if (inventory.warnings.length) throw new Error("unexpected inventory warning");
    },
    groupByMediaPath(entries) {
      return [{ key: Core.normalizePathForComparison(entries[0].mediaPath), mediaPath: entries[0].mediaPath, entries }];
    },
    async contextStillActive() { return true; },
  };
  const pending = {
    id: "tx-race",
    sourcePath,
    targetRelativePath,
    cleanupPath: `${sourcePath}.premiere-material-tx-race.pending-delete`,
    sourceFingerprint: { size: 100, mtimeMs: 1000, ctimeMs: 1000 },
    targetFingerprint: { size: 100, mtimeMs: 2000, ctimeMs: 3000 },
    byteCount: 100,
    batchIndex: 1,
    mode: "copy",
    projectPath,
    projectIdentity: identity,
    itemCount: 1,
    itemIds: ["clip-1"],
    status: "failed",
  };
  const initialState = State.createState(workspaceRoot, new Date("2026-09-03T00:00:00.000Z"));
  initialState.initialized = true;
  initialState.pendingTransaction = pending;
  let latestState = JSON.parse(JSON.stringify(initialState));
  let readCount = 0;
  let writeCount = 0;
  const storage = {
    MISSING_REVISION: null,
    statePath(root) { return `${root}\\.premiere-material-space.json`; },
    async readJsonWithBackup() {
      readCount += 1;
      return { value: JSON.parse(JSON.stringify(latestState)), missing: false, recovered: false, revision: `r${writeCount}` };
    },
    async writeJsonAtomic(_fs, _path, nextState) {
      writeCount += 1;
      latestState = JSON.parse(JSON.stringify(nextState));
      return { revision: `r${writeCount}` };
    },
  };
  const fsMock = {
    async lstat(nativePath) {
      if (Core.samePath(nativePath, targetPath)) {
        return { isFile: () => true, isDirectory: () => false, ...targetFingerprint };
      }
      const error = new Error("path not found");
      error.code = "ENOENT";
      throw error;
    },
  };
  const localStorage = {
    values: new Map(),
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
    setItem(key, value) { this.values.set(key, String(value)); },
  };
  const window = {
    addEventListener(name, listener) { windowListeners.set(name, listener); },
    removeEventListener() {},
    listeners: windowListeners,
  };
  const uxp = {
    entrypoints: {
      setup(config) { Object.assign(entrypoints, config.panels.materialBatchOrganizer); },
    },
    shell: { async openPath() {} },
  };
  const ppro = { Constants: {}, ProjectEvent: {}, EventManager: {} };
  const sandbox = {
    console,
    document,
    window,
    localStorage,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    MaterialBatchCore: Core,
    MaterialBatchState: State,
    MaterialBatchTransaction: Transaction,
    MaterialBatchRecovery: Recovery,
    MaterialBatchCoordination: Coordination,
    MaterialBatchPremiere: premiere,
    MaterialBatchStorage: storage,
    MaterialBatchScanPolicy: ScanPolicy,
    require(name) {
      if (name === "uxp") return uxp;
      if (name === "premierepro") return ppro;
      if (name === "fs") return fsMock;
      throw new Error(`unexpected require: ${name}`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(mainSource, sandbox, { filename: "src/main.js" });

  return {
    document,
    window,
    entrypoints,
    stateAction,
    project,
    get saveCalls() { return saveCalls; },
    get latestState() { return latestState; },
    get readCount() { return readCount; },
    get writeCount() { return writeCount; },
    get targetFingerprint() { return targetFingerprint; },
  };
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("刷新失败后可通过已绑定的刷新事件重试，且不会出现未处理的异步拒绝", async () => {
  const harness = createHarness();
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);

  try {
    await harness.entrypoints.show();
    assert.equal(harness.readCount, 1);

    const refresh = harness.window.listeners.get("batch-collector:refresh");
    assert.equal(typeof refresh, "function");

    const retry = refresh();
    assert.equal(retry, undefined, "UI 事件仍为触发后即不等待结果");
    harness.readGate.resolve();
    await settle();

    assert.equal(harness.readCount, 2, "状态读取失败后会重试");
    assert.equal(harness.inventoryCount, 1, "重试会继续执行真实工程扫描");
    assert.deepEqual(unhandled, []);
    assert.equal(harness.document.body.dataset.state, "paused");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    harness.entrypoints.hide();
  }
});

test("历史重链接失败后会保持等待，直到恢复操作成功保存 Premiere 工程", async () => {
  const harness = createMappingHarness();
  await harness.entrypoints.show();

  assert.equal(harness.project.saveCalls, 1, "首次重链接会尝试保存一次 Premiere 工程");
  assert.equal(harness.clip.mediaPath, harness.targetPath, "保存失败后 Premiere 仍链接到目标");
  assert.equal(harness.latestState.pendingProjectSave.status, "failed");
  const writesAfterFailure = harness.writeCount;

  const refresh = harness.window.listeners.get("batch-collector:refresh");
  assert.equal(typeof refresh, "function");
  refresh();
  await settle();
  assert.equal(harness.latestState.pendingProjectSave.status, "failed", "普通刷新不能静默清除待保存状态");
  assert.equal(harness.writeCount, writesAfterFailure);

  const stateActionEvent = harness.window.listeners.get("batch-collector:state-action");
  assert.equal(typeof stateActionEvent, "function");
  assert.equal(harness.stateAction.dataset.intent, "检查上次整理");
  stateActionEvent();
  await settle();

  assert.equal(harness.project.saveCalls, 2, "显式恢复操作会重试保存 Premiere 工程");
  assert.equal(harness.latestState.pendingProjectSave, null, "只有保存成功后才会清除待保存状态");
  assert.equal(harness.readCount, 2, "恢复流程会重新读取持久化的待处理记录");
});

test("恢复待处理事务时拒绝接受在 Premiere 保存期间被替换的目标", async () => {
  const harness = createRecoveryRaceHarness();
  await harness.entrypoints.show();
  assert.equal(harness.stateAction.dataset.intent, "检查上次整理");

  const recoveryAction = harness.window.listeners.get("batch-collector:state-action");
  assert.equal(typeof recoveryAction, "function");
  recoveryAction();
  await settle();

  assert.equal(harness.saveCalls, 1, "恢复流程已执行一次 Premiere 保存");
  assert.equal(harness.targetFingerprint.mtimeMs, 9999, "测试夹具会在保存期间替换目标");
  assert.equal(harness.latestState.pendingTransaction.id, "tx-race", "中断的事务会继续持久化保留");
  assert.equal(harness.latestState.transactions.length, 0, "不会提交替换后的映射");
  assert.equal(harness.writeCount, 0, "目标发生变化时不会写入已完成的恢复记录");
  assert.match(harness.document.body.dataset.state, /failure/);
});
