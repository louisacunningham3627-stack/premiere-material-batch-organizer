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
const Storage = require("../src/storage");

const mainSource = fs.readFileSync(require.resolve("../src/main.js"), "utf8");

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function createDomElement(tagName = "div") {
  const listeners = new Map();
  const attributes = new Map();
  const children = [];
  let ownText = "";
  const node = {
    tagName: String(tagName).toUpperCase(),
    dataset: {},
    style: {},
    disabled: false,
    hidden: false,
    className: "",
    type: "",
    children,
    addEventListener(name, listener) { listeners.set(name, listener); },
    setAttribute(name, value) {
      attributes.set(name, String(value));
      if (name.startsWith("data-")) {
        const key = name.slice(5).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
        this.dataset[key] = String(value);
      }
    },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
    appendChild(child) {
      children.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const index = children.indexOf(child);
      if (index >= 0) children.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    replaceChildren(...nextChildren) {
      children.splice(0, children.length);
      nextChildren.forEach((child) => this.appendChild(child));
    },
    closest(selector) {
      if (selector === "button[data-library-id]" && this.tagName === "BUTTON" && this.getAttribute("data-library-id")) return this;
      return this.parentNode && typeof this.parentNode.closest === "function" ? this.parentNode.closest(selector) : null;
    },
    focus() { this.focused = true; },
    listeners,
  };
  Object.defineProperties(node, {
    firstChild: { get() { return children[0] || null; } },
    textContent: {
      get() { return ownText + children.map((child) => child.textContent || "").join(""); },
      set(value) {
        ownText = String(value == null ? "" : value);
        children.splice(0, children.length);
      },
    },
  });
  return node;
}

function findDescendant(node, predicate) {
  if (!node) return null;
  if (predicate(node)) return node;
  for (const child of node.children || []) {
    const match = findDescendant(child, predicate);
    if (match) return match;
  }
  return null;
}

function findProtectedAction(list, libraryId, action) {
  return findDescendant(list, (node) => (
    node.tagName === "BUTTON"
    && node.getAttribute("data-library-id") === libraryId
    && node.getAttribute("data-action") === action
  ));
}

function createDocument(resolveElement) {
  const listeners = new Map();
  return {
    readyState: "loading",
    body: { dataset: {} },
    addEventListener(name, listener) { listeners.set(name, listener); },
    createElement(tagName) { return createDomElement(tagName); },
    getElementById(id) { return resolveElement ? resolveElement(id) : null; },
    listeners,
  };
}

function createSettingsGuardHarness() {
  function testElement() {
    const listeners = new Map();
    return {
      dataset: {},
      disabled: false,
      hidden: false,
      textContent: "",
      addEventListener(name, listener) { listeners.set(name, listener); },
      listeners,
    };
  }

  const addButton = testElement();
  const settingsMessage = testElement();
  const settingsBlockReason = testElement();
  const settingsSaveStatus = testElement();
  const settingsButton = testElement();
  const textOnly = { textContent: "" };
  const elements = new Map([
    ["addProtectedButton", addButton],
    ["settingsMessage", settingsMessage],
    ["settingsBlockReason", settingsBlockReason],
    ["settingsSaveStatus", settingsSaveStatus],
    ["settingsButton", settingsButton],
    ["settingsWorkspaceName", { ...textOnly }],
    ["settingsWorkspacePath", { ...textOnly }],
  ]);
  const document = createDocument((id) => elements.get(id) || null);
  const entrypoints = {};
  let pickerCalls = 0;
  const window = {
    addEventListener() {},
    removeEventListener() {},
  };
  const localStorage = {
    getItem() { return null; },
    setItem() {},
  };
  const uxp = {
    entrypoints: {
      setup(config) { Object.assign(entrypoints, config.panels.materialBatchOrganizer); },
    },
    storage: {
      localFileSystem: {
        async getFolder() {
          pickerCalls += 1;
          return null;
        },
      },
    },
    shell: { async openPath() {} },
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
    MaterialBatchPremiere: { async activeContext() { return null; } },
    MaterialBatchStorage: { MISSING_REVISION: null },
    MaterialBatchScanPolicy: ScanPolicy,
    require(name) {
      if (name === "uxp") return uxp;
      if (name === "premierepro") return { Constants: {}, ProjectEvent: {}, EventManager: {} };
      if (name === "fs") return {};
      throw new Error(`unexpected require: ${name}`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(mainSource, sandbox, { filename: "src/main.js" });

  return {
    addButton,
    entrypoints,
    settingsBlockReason,
    settingsMessage,
    get pickerCalls() { return pickerCalls; },
  };
}

function createProtectedFolderHarness(folderError, localSettingsError, stateWriteError, harnessOptions = {}) {
  function testElement() {
    const listeners = new Map();
    return {
      dataset: {},
      disabled: false,
      hidden: false,
      textContent: "",
      addEventListener(name, listener) { listeners.set(name, listener); },
      listeners,
    };
  }

  const addButton = testElement();
  const finishButton = testElement();
  const settingsMessage = testElement();
  const settingsBlockReason = testElement();
  const settingsSaveStatus = testElement();
  const stateAction = testElement();
  const stateTitle = testElement();
  const stateDescription = testElement();
  const openBatchButton = testElement();
  const protectedListCount = testElement();
  const protectedCountText = testElement();
  const protectedList = createDomElement("div");
  const elements = new Map([
    ["addProtectedButton", addButton],
    ["finishProtectionButton", finishButton],
    ["settingsMessage", settingsMessage],
    ["settingsBlockReason", settingsBlockReason],
    ["settingsSaveStatus", settingsSaveStatus],
    ["settingsWorkspaceName", testElement()],
    ["settingsWorkspacePath", testElement()],
    ["stateAction", stateAction],
    ["stateTitle", stateTitle],
    ["stateDescription", stateDescription],
    ["openBatchButton", openBatchButton],
    ["protectedListCount", protectedListCount],
    ["protectedCountText", protectedCountText],
    ["protectedList", protectedList],
  ]);
  const document = createDocument((id) => elements.get(id) || null);
  const entrypoints = {};
  const windowListeners = new Map();
  const context = {
    project: { path: "E:\\项目\\测试工程.prproj", name: "测试工程.prproj" },
    projectPath: "E:\\项目\\测试工程.prproj",
    projectName: "测试工程.prproj",
    identity: "path:e:\\项目\\测试工程.prproj",
    workspaceRoot: "E:\\项目",
  };
  const selectedFolder = harnessOptions.selectedFolder || { nativePath: "\\\\?\\E:\\共享库\\后期包", name: "后期包" };
  const lstatPaths = [];
  const mkdirPaths = [];
  const shellOpenCalls = [];
  const fsMutationCalls = [];
  const confirmMessages = [];
  let latestState = harnessOptions.initialState ? JSON.parse(JSON.stringify(harnessOptions.initialState)) : null;
  let stateWriteCalls = 0;
  let inventoryCount = 0;
  const diagnostics = [];
  const fsMock = {
    async lstat(nativePath) {
      lstatPaths.push(nativePath);
      if (String(nativePath).startsWith("\\\\?\\")) {
        const error = new Error("no such file or directory");
        error.code = "ENOENT";
        throw error;
      }
      if (folderError) throw folderError;
      if (typeof harnessOptions.lstatResultForPath === "function") {
        return harnessOptions.lstatResultForPath(nativePath);
      }
      return harnessOptions.lstatResult || { isDirectory: () => true, isFile: () => false };
    },
    async mkdir(nativePath) {
      mkdirPaths.push(nativePath);
      if (harnessOptions.mkdirError) throw harnessOptions.mkdirError;
    },
    async unlink(nativePath) { fsMutationCalls.push(["unlink", nativePath]); },
    async rm(nativePath) { fsMutationCalls.push(["rm", nativePath]); },
    async rename(from, to) { fsMutationCalls.push(["rename", from, to]); },
    async copyFile(from, to) { fsMutationCalls.push(["copyFile", from, to]); },
  };
  const storage = {
    MISSING_REVISION: null,
    isAlreadyExistsError: Storage.isAlreadyExistsError,
    statePath(root) { return `${root}\\.premiere-material-space.json`; },
    async readJsonWithBackup() {
      return harnessOptions.initialState
        ? { value: JSON.parse(JSON.stringify(harnessOptions.initialState)), missing: false, recovered: false, revision: "initial" }
        : { missing: true, recovered: false, revision: null };
    },
    async writeJsonAtomic(_fs, _path, value) {
      stateWriteCalls += 1;
      if (stateWriteError && stateWriteCalls === (harnessOptions.stateWriteErrorAt || 2)) throw stateWriteError;
      latestState = JSON.parse(JSON.stringify(value));
      return { revision: `saved-${stateWriteCalls}` };
    },
  };
  const localStorage = {
    values: new Map(),
    setCalls: 0,
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
    setItem(key, value) {
      this.setCalls += 1;
      if (localSettingsError && this.setCalls === 2) throw localSettingsError;
      this.values.set(key, String(value));
    },
  };
  if (harnessOptions.initialMachineSettings) {
    localStorage.values.set(
      "hechao.material-batch-organizer.machine.v1",
      JSON.stringify(harnessOptions.initialMachineSettings)
    );
  }
  const window = {
    addEventListener(name, listener) { windowListeners.set(name, listener); },
    removeEventListener() {},
    confirm(message) {
      confirmMessages.push(String(message));
      return harnessOptions.confirmResult !== false;
    },
    listeners: windowListeners,
  };
  const uxp = {
    entrypoints: {
      setup(config) { Object.assign(entrypoints, config.panels.materialBatchOrganizer); },
    },
    storage: { localFileSystem: { async getFolder() { return selectedFolder; } } },
    shell: {
      async openPath(nativePath, label) {
        shellOpenCalls.push([nativePath, label]);
        return "";
      },
    },
  };
  const sandbox = {
    console: {
      error(...values) { diagnostics.push(values.map(String).join(" ")); },
      log() {},
      warn() {},
    },
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
    MaterialBatchPremiere: {
      async activeContext() { return context; },
      async inventoryProject() {
        inventoryCount += 1;
        return { entries: [], warnings: [] };
      },
      assertCompleteInventory() {},
      groupByMediaPath() { return []; },
      async contextStillActive() { return true; },
    },
    MaterialBatchStorage: storage,
    MaterialBatchScanPolicy: ScanPolicy,
    require(name) {
      if (name === "uxp") return uxp;
      if (name === "premierepro") return { Constants: {}, ProjectEvent: {}, EventManager: {} };
      if (name === "fs") return fsMock;
      throw new Error(`unexpected require: ${name}`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(mainSource, sandbox, { filename: "src/main.js" });

  return {
    addButton,
    document,
    entrypoints,
    finishButton,
    confirmMessages,
    diagnostics,
    fsMutationCalls,
    lstatPaths,
    mkdirPaths,
    localStorage,
    openBatchButton,
    protectedCountText,
    protectedList,
    protectedListCount,
    settingsBlockReason,
    settingsMessage,
    shellOpenCalls,
    stateAction,
    stateDescription,
    stateTitle,
    window,
    get inventoryCount() { return inventoryCount; },
    get latestState() { return latestState; },
    get stateWriteCalls() { return stateWriteCalls; },
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
    values: new Map([[
      "hechao.material-batch-organizer.machine.v1",
      JSON.stringify({
        autoByMediaSpace: {},
        protectedSetupByMediaSpace: { [state.mediaSpaceId]: true },
        protectedMappings: [],
      }),
    ]]),
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

function protectedRemovalFixture(pendingKind = "") {
  const workspaceRoot = "E:\\项目";
  const projectPath = `${workspaceRoot}\\测试工程.prproj`;
  const firstId = "library-post-kit";
  const secondId = "library-ai-video";
  const now = new Date("2026-09-04T08:00:00.000Z");
  let initialState = State.createState(workspaceRoot, now);
  initialState.initialized = true;
  initialState = State.registerProject(initialState, projectPath, "测试工程.prproj", now);
  initialState = State.markProjectBaseline(initialState, projectPath, [], now);
  initialState = State.addProtectedLibrary(initialState, firstId, "后期包", now);
  initialState = State.addProtectedLibrary(initialState, secondId, "AI视频制作", now);

  if (pendingKind === "transaction") {
    initialState = State.beginTransaction(initialState, {
      id: "tx-pending",
      sourcePath: "C:\\Downloads\\未完成.mov",
      targetPath: "E:\\项目\\素材\\001_初始素材\\未完成.mov",
      targetRelativePath: "素材\\001_初始素材\\未完成.mov",
      sourceFingerprint: { size: 100, mtimeMs: 1000 },
      byteCount: 100,
      batchIndex: 1,
      projectPath,
      projectIdentity: "path:e:\\项目\\测试工程.prproj",
    }, now);
  }
  if (pendingKind === "project-save") {
    initialState = State.beginProjectSave(initialState, {
      id: "save-pending",
      sourcePath: "C:\\Downloads\\待保存.mov",
      targetRelativePath: "素材\\001_初始素材\\待保存.mov",
      targetFingerprint: { size: 100, mtimeMs: 2000 },
      projectPath,
      projectIdentity: "path:e:\\项目\\测试工程.prproj",
      itemCount: 1,
      itemIds: ["clip-1"],
    }, now);
  }

  return {
    firstId,
    secondId,
    initialState,
    initialMachineSettings: {
      autoByMediaSpace: { [initialState.mediaSpaceId]: true },
      protectedSetupByMediaSpace: { [initialState.mediaSpaceId]: true },
      protectedMappings: [
        { libraryId: firstId, label: "后期包", rootPath: "I:\\【后期包 ver10.0】" },
        { libraryId: secondId, label: "AI视频制作", rootPath: "I:\\AI视频制作" },
      ],
    },
  };
}

test("刷新失败后可重试，并在首次保护设置前保持不扫描", async () => {
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
    assert.equal(harness.inventoryCount, 0, "确认不搬动文件夹之前不会扫描工程素材");
    assert.deepEqual(unhandled, []);
    assert.equal(harness.document.body.dataset.state, "setup");
    assert.equal(harness.document.body.dataset.onboarding, "protection");
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    harness.entrypoints.hide();
  }
});

test("没有已保存工程时设置页会解释原因，且不会打开目录选择器", async () => {
  const harness = createSettingsGuardHarness();
  await harness.entrypoints.show();

  assert.equal(harness.addButton.disabled, true);
  assert.equal(harness.settingsBlockReason.hidden, false);
  assert.match(harness.settingsBlockReason.textContent, /请先打开并保存 Premiere 工程/);

  const click = harness.addButton.listeners.get("click");
  assert.equal(typeof click, "function");
  click();
  await settle();

  assert.equal(harness.pickerCalls, 0);
  assert.equal(harness.settingsMessage.hidden, false);
  assert.equal(harness.settingsMessage.dataset.kind, "error");
  assert.match(harness.settingsMessage.textContent, /请先打开并保存 Premiere 工程/);
});

test("添加不搬动文件夹时会先转换 UXP 扩展路径", async () => {
  const harness = createProtectedFolderHarness();
  await harness.entrypoints.show();

  harness.addButton.listeners.get("click")();
  await settle();

  assert.ok(harness.lstatPaths.length >= 1);
  assert.ok(harness.lstatPaths.every((nativePath) => nativePath === "E:\\共享库\\后期包"));
  const settings = JSON.parse(harness.localStorage.values.get("hechao.material-batch-organizer.machine.v1"));
  assert.equal(settings.protectedMappings[0].rootPath, "E:\\共享库\\后期包");
  assert.equal(harness.latestState.protectedLibraries[0].label, "后期包");
  assert.match(harness.settingsMessage.textContent, /已添加“后期包”/);
  assert.doesNotMatch(harness.settingsMessage.textContent, /no such file|directory/i);
});

test("素材目录已经存在时仍会确认目录并正常打开", async () => {
  const existsError = new Error("file already exists");
  const initialState = State.createState("E:\\项目", new Date("2026-09-04T00:00:00.000Z"));
  const harness = createProtectedFolderHarness(null, null, null, {
    initialState,
    mkdirError: existsError,
  });
  await harness.entrypoints.show();

  assert.equal(harness.openBatchButton.disabled, false);
  harness.window.listeners.get("batch-collector:open-batch")();
  await settle();

  assert.deepEqual(harness.mkdirPaths, ["E:\\项目\\素材", "E:\\项目\\素材\\001_初始素材"]);
  assert.ok(harness.lstatPaths.includes("E:\\项目\\素材"));
  assert.ok(harness.lstatPaths.includes("E:\\项目\\素材\\001_初始素材"));
  assert.equal(harness.shellOpenCalls.length, 1, "确认已有目录可用后应继续打开当前素材文件夹");
  assert.equal(harness.shellOpenCalls[0][0], "E:\\项目\\素材\\001_初始素材");
  assert.doesNotMatch(harness.stateDescription.textContent, /file already exists/i);
});

test("素材目录没有权限时暂停并只显示中文，不继续打开目录", async () => {
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const initialState = State.createState("E:\\项目", new Date("2026-09-04T00:00:00.000Z"));
  const harness = createProtectedFolderHarness(null, null, null, {
    initialState,
    mkdirError: denied,
  });
  await harness.entrypoints.show();

  harness.window.listeners.get("batch-collector:open-batch")();
  await settle();

  assert.equal(harness.shellOpenCalls.length, 0);
  assert.equal(harness.stateTitle.textContent, "自动整理已暂停");
  assert.match(harness.stateDescription.textContent, /无法使用当前素材文件夹/);
  assert.match(harness.stateDescription.textContent, /没有移动任何素材/);
  assert.doesNotMatch(harness.stateDescription.textContent, /permission|denied|EACCES/i);
  assert.match(harness.diagnostics.join("\n"), /cause\.code=EACCES/);
});

test("素材目录位置被同名文件占用时不会打开或覆盖", async () => {
  const initialState = State.createState("E:\\项目", new Date("2026-09-04T00:00:00.000Z"));
  const harness = createProtectedFolderHarness(null, null, null, {
    initialState,
    mkdirError: new Error("file already exists"),
    lstatResultForPath(nativePath) {
      if (nativePath === "E:\\项目\\素材") return { isDirectory: () => true, isFile: () => false };
      if (nativePath === "E:\\项目\\素材\\001_初始素材") return { isDirectory: () => false, isFile: () => true };
      throw new Error("unexpected lstat path: " + nativePath);
    },
  });
  await harness.entrypoints.show();

  harness.window.listeners.get("batch-collector:open-batch")();
  await settle();

  assert.equal(harness.shellOpenCalls.length, 0);
  assert.deepEqual(harness.mkdirPaths, ["E:\\项目\\素材", "E:\\项目\\素材\\001_初始素材"]);
  assert.deepEqual(harness.lstatPaths, ["E:\\项目\\素材", "E:\\项目\\素材\\001_初始素材"]);
  assert.match(harness.stateDescription.textContent, /被同名文件占用/);
  assert.match(harness.stateDescription.textContent, /没有移动任何素材/);
});

test("三个不搬动文件夹会逐项显示名称、完整路径和管理按钮", async () => {
  const now = new Date("2026-09-04T00:00:00.000Z");
  let initialState = State.createState("E:\\项目", now);
  const libraries = [
    ["library-post-kit", "后期包", "I:\\【后期包 ver10.0】"],
    ["library-ai-video", "AI视频制作", "I:\\AI视频制作"],
    ["library-mineways", "Mineways 9.12汉化版本体", "I:\\Mineways 9.12汉化版本体"],
  ];
  libraries.forEach(function ([libraryId, label], index) {
    initialState = State.addProtectedLibrary(initialState, libraryId, label, new Date(now.getTime() + index + 1));
  });
  const harness = createProtectedFolderHarness(null, null, null, {
    initialState,
    initialMachineSettings: {
      autoByMediaSpace: {},
      protectedSetupByMediaSpace: {},
      protectedMappings: libraries.map(function ([libraryId, label, rootPath]) {
        return { libraryId, label, rootPath };
      }),
    },
  });
  await harness.entrypoints.show();

  assert.equal(harness.protectedList.tagName, "DIV");
  assert.equal(harness.protectedListCount.textContent, "3 个");
  assert.equal(harness.protectedList.children.length, 3);
  harness.protectedList.children.forEach(function (row, index) {
    const [libraryId, label, rootPath] = libraries[index];
    assert.equal(row.tagName, "DIV");
    assert.equal(row.getAttribute("role"), "listitem");
    assert.match(row.textContent, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(row.textContent, new RegExp(rootPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(findProtectedAction(row, libraryId, "map").textContent, "更换文件夹");
    assert.equal(findProtectedAction(row, libraryId, "remove").textContent, "从名单移除");
  });
});

test("选择重叠文件夹时会写出已有名单路径和本次选择路径", async () => {
  const existingPath = "E:\\共享库\\后期包";
  const selectedPath = "E:\\共享库\\后期包\\音效";
  const libraryId = "library-existing-post-kit";
  let initialState = State.createState("E:\\项目", new Date("2026-09-04T00:00:00.000Z"));
  initialState = State.addProtectedLibrary(initialState, libraryId, "【后期包 ver10.0】", new Date("2026-09-04T00:00:01.000Z"));
  const harness = createProtectedFolderHarness(null, null, null, {
    initialState,
    initialMachineSettings: {
      autoByMediaSpace: {},
      protectedSetupByMediaSpace: {},
      protectedMappings: [{ libraryId, label: "【后期包 ver10.0】", rootPath: existingPath }],
    },
    selectedFolder: { nativePath: "\\\\?\\" + selectedPath, name: "音效" },
  });
  await harness.entrypoints.show();

  assert.equal(harness.protectedListCount.textContent, "1 个");
  assert.match(harness.protectedList.textContent, /【后期包 ver10\.0】/);
  assert.match(harness.protectedList.textContent, /E:\\共享库\\后期包/);

  harness.addButton.listeners.get("click")();
  await settle();

  assert.equal(harness.stateWriteCalls, 0, "重叠目录不会改写工程名单");
  assert.equal(harness.settingsMessage.dataset.kind, "error");
  assert.match(harness.settingsMessage.textContent, /【后期包 ver10\.0】/);
  assert.match(harness.settingsMessage.textContent, /已有路径：E:\\共享库\\后期包/);
  assert.match(harness.settingsMessage.textContent, /本次选择：E:\\共享库\\后期包\\音效/);
  assert.equal(harness.lstatPaths.includes(selectedPath), false, "发现名单重叠后不会再访问本次选择路径");
});

test("取消从名单移除时不会修改任何设置或整理记录", async () => {
  const fixture = protectedRemovalFixture();
  const harness = createProtectedFolderHarness(null, null, null, {
    ...fixture,
    confirmResult: false,
  });
  await harness.entrypoints.show();

  try {
    const stateBefore = JSON.stringify(harness.latestState);
    const settingsBefore = harness.localStorage.values.get("hechao.material-batch-organizer.machine.v1");
    const stateWritesBefore = harness.stateWriteCalls;
    const machineWritesBefore = harness.localStorage.setCalls;
    const inventoryBefore = harness.inventoryCount;
    const removeButton = findProtectedAction(harness.protectedList, fixture.firstId, "remove");
    assert.ok(removeButton, "名单里的每个文件夹都应有移除入口");
    assert.equal(removeButton.textContent, "从名单移除");

    harness.protectedList.listeners.get("click")({ target: removeButton });
    await settle();

    assert.equal(harness.confirmMessages.length, 1);
    assert.match(harness.confirmMessages[0], /从不搬动名单移除“后期包”/);
    assert.match(harness.confirmMessages[0], /不会删除磁盘文件夹或里面的素材/);
    assert.equal(harness.stateWriteCalls, stateWritesBefore);
    assert.equal(harness.localStorage.setCalls, machineWritesBefore);
    assert.equal(harness.localStorage.values.get("hechao.material-batch-organizer.machine.v1"), settingsBefore);
    assert.equal(JSON.stringify(harness.latestState), stateBefore);
    assert.equal(harness.inventoryCount, inventoryBefore, "取消后不会重新扫描工程");
    assert.deepEqual(harness.fsMutationCalls, []);
    assert.equal(harness.protectedListCount.textContent, "2 个");
  } finally {
    harness.entrypoints.hide();
  }
});

test("确认移除只删除所选名单项并持久化，同时暂停自动整理且不触碰素材文件", async () => {
  const fixture = protectedRemovalFixture();
  const harness = createProtectedFolderHarness(null, null, null, {
    ...fixture,
    confirmResult: true,
  });
  await harness.entrypoints.show();

  try {
    const stateWritesBefore = harness.stateWriteCalls;
    const inventoryBefore = harness.inventoryCount;
    const removeButton = findProtectedAction(harness.protectedList, fixture.firstId, "remove");
    assert.ok(removeButton);

    harness.protectedList.listeners.get("click")({ target: removeButton });
    await settle();

    assert.equal(harness.confirmMessages.length, 1);
    assert.match(harness.confirmMessages[0], /文件夹：I:\\【后期包 ver10\.0】/);
    assert.match(harness.confirmMessages[0], /自动整理会暂停/);
    assert.equal(harness.stateWriteCalls, stateWritesBefore + 1, "确认后会原子保存更新后的工程名单");
    assert.deepEqual(
      harness.latestState.protectedLibraries.map((library) => library.libraryId),
      [fixture.secondId],
      "只移除用户确认的那一个名单项"
    );
    const machineSettings = JSON.parse(harness.localStorage.values.get("hechao.material-batch-organizer.machine.v1"));
    assert.equal(machineSettings.autoByMediaSpace[harness.latestState.mediaSpaceId], false);
    assert.equal(harness.inventoryCount, inventoryBefore, "名单管理不应启动素材扫描");
    assert.deepEqual(harness.fsMutationCalls, [], "名单管理不应调用任何文件移动或删除 API");
    assert.equal(harness.protectedListCount.textContent, "1 个");
    assert.equal(harness.protectedCountText.textContent, "1 个");
    assert.doesNotMatch(harness.protectedList.textContent, /后期包/);
    assert.match(harness.protectedList.textContent, /AI视频制作/);
    assert.equal(harness.settingsMessage.dataset.kind, "success");
    assert.match(harness.settingsMessage.textContent, /没有删除磁盘文件或素材/);
    assert.match(harness.settingsMessage.textContent, /自动整理已暂停/);
  } finally {
    harness.entrypoints.hide();
  }
});

test("移除名单保存失败时保留原名单并且界面不泄漏英文异常", async (t) => {
  const variants = [
    "permission denied while writing E:\\项目\\整理记录",
    "无法写入整理记录：permission denied",
  ];
  for (const message of variants) await t.test(message, async () => {
    const fixture = protectedRemovalFixture();
    const harness = createProtectedFolderHarness(null, null, new Error(message), {
      ...fixture,
      confirmResult: true,
      stateWriteErrorAt: 1,
    });
    await harness.entrypoints.show();

    try {
      const removeButton = findProtectedAction(harness.protectedList, fixture.firstId, "remove");
      harness.protectedList.listeners.get("click")({ target: removeButton });
      await settle();

      assert.deepEqual(
        harness.latestState.protectedLibraries.map((library) => library.libraryId),
        [fixture.firstId, fixture.secondId],
        "保存失败时应恢复原名单"
      );
      assert.match(harness.settingsMessage.textContent, /移除失败/);
      assert.match(harness.settingsMessage.textContent, /原名单没有改变/);
      assert.doesNotMatch(harness.settingsMessage.textContent, /permission|denied|writing/i);
      assert.match(harness.diagnostics.join("\n"), /permission denied/);
      assert.deepEqual(harness.fsMutationCalls, []);
    } finally {
      harness.entrypoints.hide();
    }
  });
});

test("存在未完成的文件事务或工程待保存状态时不能修改不搬动名单", async () => {
  for (const pendingKind of ["transaction", "project-save"]) {
    const fixture = protectedRemovalFixture(pendingKind);
    const harness = createProtectedFolderHarness(null, null, null, {
      ...fixture,
      confirmResult: true,
    });
    await harness.entrypoints.show();

    try {
      const writesBefore = harness.stateWriteCalls;
      const machineWritesBefore = harness.localStorage.setCalls;
      const inventoryBefore = harness.inventoryCount;
      const removeButton = findProtectedAction(harness.protectedList, fixture.firstId, "remove");
      assert.ok(removeButton, `${pendingKind} 状态仍应显示当前名单`);
      assert.equal(removeButton.disabled, true, `${pendingKind} 状态必须禁用移除按钮`);
      assert.equal(harness.addButton.disabled, true, `${pendingKind} 状态必须禁用添加按钮`);
      assert.equal(harness.settingsBlockReason.hidden, false);
      assert.match(harness.settingsBlockReason.textContent, /请先完成“检查上次整理”/);

      harness.protectedList.listeners.get("click")({ target: removeButton });
      await settle();

      assert.equal(harness.confirmMessages.length, 0, `${pendingKind} 状态不应进入确认对话框`);
      assert.equal(harness.stateWriteCalls, writesBefore);
      assert.equal(harness.localStorage.setCalls, machineWritesBefore);
      assert.equal(harness.inventoryCount, inventoryBefore);
      assert.deepEqual(harness.fsMutationCalls, []);
      assert.match(harness.settingsMessage.textContent, /请先完成“检查上次整理”/);
      assert.deepEqual(
        harness.latestState.protectedLibraries.map((library) => library.libraryId),
        [fixture.firstId, fixture.secondId]
      );
    } finally {
      harness.entrypoints.hide();
    }
  }
});

test("首次确认不搬动名单后才进入开启自动整理步骤", async () => {
  const harness = createProtectedFolderHarness();
  await harness.entrypoints.show();
  const settingsWritesBeforeConfirmation = harness.localStorage.setCalls;

  assert.equal(harness.document.body.dataset.onboarding, "protection");
  assert.equal(harness.stateAction.textContent, "设置不搬动文件夹");
  harness.finishButton.listeners.get("click")();
  await settle();

  assert.equal(harness.document.body.dataset.onboarding, "auto");
  assert.equal(harness.stateAction.textContent, "开启自动整理");
  assert.ok(harness.latestState && harness.latestState.mediaSpaceId, "空名单确认也会先保存素材空间");
  const settings = JSON.parse(harness.localStorage.values.get("hechao.material-batch-organizer.machine.v1"));
  assert.equal(Object.values(settings.protectedSetupByMediaSpace).every(Boolean), true);
  assert.equal(Object.keys(settings.protectedSetupByMediaSpace).length, 1);
  assert.equal(settings.protectedSetupByMediaSpace[harness.latestState.mediaSpaceId], true);
  assert.equal(harness.localStorage.setCalls, settingsWritesBeforeConfirmation + 1, "确认时两个本机字段只提交一次");
});

test("文件夹缺失和权限错误只显示中文", async () => {
  const missing = Object.assign(new Error("ENOENT: no such file or directory, lstat 'E:\\共享库\\后期包'"), { code: "ENOENT" });
  const missingHarness = createProtectedFolderHarness(missing);
  await missingHarness.entrypoints.show();
  missingHarness.addButton.listeners.get("click")();
  await settle();
  assert.match(missingHarness.settingsMessage.textContent, /找不到所选文件夹/);
  assert.doesNotMatch(missingHarness.settingsMessage.textContent, /no such file|directory/i);

  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const deniedHarness = createProtectedFolderHarness(denied);
  await deniedHarness.entrypoints.show();
  deniedHarness.addButton.listeners.get("click")();
  await settle();
  assert.match(deniedHarness.settingsMessage.textContent, /没有权限读取所选文件夹/);
  assert.doesNotMatch(deniedHarness.settingsMessage.textContent, /permission|denied/i);
});

test("本机设置保存失败时不会误认为不搬动名单已确认", async () => {
  const saveError = new Error("quota exceeded");
  const harness = createProtectedFolderHarness(null, saveError);
  await harness.entrypoints.show();

  harness.finishButton.listeners.get("click")();
  await settle();

  assert.equal(harness.document.body.dataset.onboarding, "protection");
  assert.equal(harness.stateAction.textContent, "设置不搬动文件夹");
  assert.equal(harness.settingsMessage.dataset.kind, "error");
  assert.match(harness.settingsMessage.textContent, /无法保存本机设置/);
  assert.doesNotMatch(harness.settingsMessage.textContent, /quota|exceeded/i);
  const failedSettings = JSON.parse(harness.localStorage.values.get("hechao.material-batch-organizer.machine.v1"));
  assert.equal(Object.keys(failedSettings.protectedSetupByMediaSpace).length, 0, "失败写入不会残留已确认标记");
  assert.match(harness.diagnostics.join("\n"), /cause\.message=quota exceeded/);

  harness.finishButton.listeners.get("click")();
  await settle();
  const retriedSettings = JSON.parse(harness.localStorage.values.get("hechao.material-batch-organizer.machine.v1"));
  assert.equal(retriedSettings.protectedSetupByMediaSpace[harness.latestState.mediaSpaceId], true, "重试后可一次提交完整设置");
  assert.equal(harness.document.body.dataset.onboarding, "auto");
});

test("工程整理记录写入失败不会再误报成本机设置失败", async () => {
  const stateWriteError = new Error("保存整理记录失败: File exists");
  const harness = createProtectedFolderHarness(null, null, stateWriteError);
  await harness.entrypoints.show();

  harness.addButton.listeners.get("click")();
  await settle();
  assert.equal(harness.stateWriteCalls, 1, "添加文件夹已完成第一次状态写入");
  const machineWritesBeforeConfirmation = harness.localStorage.setCalls;

  harness.finishButton.listeners.get("click")();
  await settle();

  assert.equal(harness.stateWriteCalls, 2, "确认名单触发第二次状态写入");
  assert.equal(harness.localStorage.setCalls, machineWritesBeforeConfirmation, "状态写失败后不会误写本机确认标记");
  assert.equal(harness.document.body.dataset.onboarding, "protection");
  assert.equal(harness.settingsMessage.dataset.kind, "error");
  assert.match(harness.settingsMessage.textContent, /无法保存当前工程文件夹里的整理记录/);
  assert.doesNotMatch(harness.settingsMessage.textContent, /本机设置|File exists/i);
  assert.match(harness.diagnostics.join("\n"), /确认不搬动名单失败（project-state）/);
  assert.match(harness.diagnostics.join("\n"), /error\.message=保存整理记录失败: File exists/);
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
