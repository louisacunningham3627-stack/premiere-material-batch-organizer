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
const MACHINE_SETTINGS_V1_KEY = "hechao.material-batch-organizer.machine.v1";
const MACHINE_SETTINGS_V2_KEY = "hechao.material-batch-organizer.machine.v2";

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

function createSharedLocalStorage(entries = []) {
  return {
    values: new Map(entries),
    setCalls: 0,
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
    setItem(key, value) {
      this.setCalls += 1;
      this.values.set(key, String(value));
    },
  };
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
  const autoCollectToggle = testElement();
  const folderActionMessage = testElement();
  const openBatchButton = testElement();
  const protectedListCount = testElement();
  const protectedCountText = testElement();
  const protectedList = createDomElement("div");
  const reviewCountLabel = testElement();
  const reviewList = createDomElement("div");
  const reviewSection = testElement();
  const fileCount = testElement();
  const fileSize = testElement();
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
    ["autoCollectToggle", autoCollectToggle],
    ["folderActionMessage", folderActionMessage],
    ["openBatchButton", openBatchButton],
    ["protectedListCount", protectedListCount],
    ["protectedCountText", protectedCountText],
    ["protectedList", protectedList],
    ["reviewCountLabel", reviewCountLabel],
    ["reviewList", reviewList],
    ["reviewSection", reviewSection],
    ["fileCount", fileCount],
    ["fileSize", fileSize],
  ]);
  const document = createDocument((id) => elements.get(id) || null);
  const entrypoints = {};
  const windowListeners = new Map();
  const context = harnessOptions.context || {
    project: { path: "E:\\项目\\测试工程.prproj", name: "测试工程.prproj" },
    projectPath: "E:\\项目\\测试工程.prproj",
    projectName: "测试工程.prproj",
    identity: "path:e:\\项目\\测试工程.prproj",
    workspaceRoot: "E:\\项目",
  };
  const selectedFolder = harnessOptions.selectedFolder || { nativePath: "\\\\?\\E:\\共享库\\后期包", name: "后期包" };
  const stateStore = harnessOptions.stateStore || null;
  const lstatPaths = [];
  const mkdirPaths = [];
  const shellOpenCalls = [];
  const fsMutationCalls = [];
  const confirmMessages = [];
  let latestState = stateStore && stateStore.value
    ? JSON.parse(JSON.stringify(stateStore.value))
    : harnessOptions.initialState
      ? JSON.parse(JSON.stringify(harnessOptions.initialState))
      : null;
  let stateReadCalls = 0;
  let stateWriteCalls = 0;
  let inventoryCount = 0;
  let inventoryEntries = Array.isArray(harnessOptions.inventoryEntries)
    ? harnessOptions.inventoryEntries
    : [];
  const diagnostics = [];
  const fsMock = {
    async lstat(nativePath) {
      lstatPaths.push(nativePath);
      if (String(nativePath).startsWith("\\\\?\\")) {
        const error = new Error("no such file or directory");
        error.code = "ENOENT";
        throw error;
      }
      const mediaRootPath = Core.joinNativePath(context.workspaceRoot, "素材");
      if (!latestState && Core.samePath(nativePath, mediaRootPath)) {
        if (harnessOptions.missingStateMediaRootError) throw harnessOptions.missingStateMediaRootError;
        if (harnessOptions.missingStateMediaRootExists) {
          return { isDirectory: () => true, isFile: () => false };
        }
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
      stateReadCalls += 1;
      const storedState = stateStore ? stateStore.value : latestState;
      return storedState
        ? {
            value: JSON.parse(JSON.stringify(storedState)),
            missing: false,
            recovered: false,
            revision: stateStore ? String(stateStore.revision || "initial") : "initial",
          }
        : { missing: true, recovered: false, revision: null };
    },
    async writeJsonAtomic(_fs, _path, value) {
      stateWriteCalls += 1;
      if (stateWriteError && stateWriteCalls === (harnessOptions.stateWriteErrorAt || 2)) throw stateWriteError;
      latestState = JSON.parse(JSON.stringify(value));
      if (stateStore) {
        stateStore.value = JSON.parse(JSON.stringify(value));
        stateStore.revision = "saved-" + stateWriteCalls;
      }
      return { revision: `saved-${stateWriteCalls}` };
    },
  };
  const localStorage = harnessOptions.sharedLocalStorage || {
    values: new Map(),
    setCalls: 0,
    getItem(key) { return this.values.has(key) ? this.values.get(key) : null; },
    setItem(key, value) {
      this.setCalls += 1;
      if (localSettingsError && this.setCalls === (harnessOptions.localSettingsErrorAt || 1)) throw localSettingsError;
      this.values.set(key, String(value));
    },
  };
  if (harnessOptions.initialMachineSettings) {
    localStorage.values.set(
      MACHINE_SETTINGS_V2_KEY,
      JSON.stringify(harnessOptions.initialMachineSettings)
    );
  }
  if (harnessOptions.initialLegacyMachineSettings) {
    localStorage.values.set(
      MACHINE_SETTINGS_V1_KEY,
      JSON.stringify(harnessOptions.initialLegacyMachineSettings)
    );
  }
  const window = {
    addEventListener(name, listener) { windowListeners.set(name, listener); },
    removeEventListener() {},
    confirm(message) {
      confirmMessages.push(String(message));
      if (typeof harnessOptions.onConfirm === "function") harnessOptions.onConfirm(String(message));
      return harnessOptions.confirmResult !== false;
    },
    listeners: windowListeners,
  };
  const uxp = {
    entrypoints: {
      setup(config) { Object.assign(entrypoints, config.panels.materialBatchOrganizer); },
    },
    storage: {
      localFileSystem: {
        async getFolder() {
          return typeof harnessOptions.getFolder === "function"
            ? harnessOptions.getFolder()
            : selectedFolder;
        },
      },
    },
    shell: {
      async openPath(nativePath, label) {
        shellOpenCalls.push([nativePath, label]);
        if (harnessOptions.shellOpenError) throw harnessOptions.shellOpenError;
        return harnessOptions.shellOpenResult || "";
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
      async activeContext() {
        return typeof harnessOptions.activeContext === "function"
          ? harnessOptions.activeContext()
          : context;
      },
      async inventoryProject() {
        inventoryCount += 1;
        return {
          entries: typeof harnessOptions.inventoryEntries === "function"
            ? harnessOptions.inventoryEntries()
            : inventoryEntries,
          warnings: Array.isArray(harnessOptions.inventoryWarnings) ? harnessOptions.inventoryWarnings : [],
        };
      },
      assertCompleteInventory() {},
      groupByMediaPath(entries) {
        if (typeof harnessOptions.groupByMediaPath === "function") return harnessOptions.groupByMediaPath(entries);
        const groups = new Map();
        (entries || []).forEach((entry) => {
          const mediaPath = String(entry && entry.mediaPath || "");
          const key = Core.normalizePathForComparison(mediaPath);
          if (!groups.has(key)) groups.set(key, { key, mediaPath, entries: [] });
          groups.get(key).entries.push(entry);
        });
        return Array.from(groups.values());
      },
      async contextStillActive(_ppro, expectedIdentity) {
        return typeof harnessOptions.contextStillActive === "function"
          ? harnessOptions.contextStillActive(expectedIdentity)
          : true;
      },
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
    autoCollectToggle,
    document,
    entrypoints,
    finishButton,
    folderActionMessage,
    confirmMessages,
    diagnostics,
    fileCount,
    fileSize,
    fsMutationCalls,
    lstatPaths,
    mkdirPaths,
    localStorage,
    openBatchButton,
    protectedCountText,
    protectedList,
    protectedListCount,
    reviewCountLabel,
    reviewList,
    reviewSection,
    settingsBlockReason,
    settingsMessage,
    shellOpenCalls,
    stateAction,
    stateDescription,
    stateTitle,
    window,
    setInventoryEntries(entries) { inventoryEntries = Array.isArray(entries) ? entries : []; },
    get inventoryCount() { return inventoryCount; },
    get latestState() { return latestState; },
    get stateReadCalls() { return stateReadCalls; },
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
      const error = new Error("no such file or directory");
      error.code = "ENOENT";
      throw error;
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

function createMappingHarness(options = {}) {
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
      MACHINE_SETTINGS_V2_KEY,
      JSON.stringify({
        schemaVersion: 2,
        autoByProject: { [State.projectKey(projectPath)]: options.autoEnabled !== false },
        projectSetupByProject: { [State.projectKey(projectPath)]: true },
        protectedRevisionByProject: {
          [State.projectKey(projectPath)]: Math.max(1, Number(state.protectedConfigRevision) || 1),
        },
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

function projectContext(workspaceRoot, fileName, projectOverrides = {}) {
  const projectPath = Core.joinNativePath(workspaceRoot, fileName);
  const project = Object.assign({
    path: projectPath,
    name: fileName,
    async save() { return true; },
  }, projectOverrides);
  return {
    project,
    projectPath,
    projectName: fileName,
    identity: "path:" + Core.normalizePathForComparison(projectPath),
    workspaceRoot,
  };
}

function readableFile(size, mtimeMs) {
  return {
    isDirectory: () => false,
    isFile: () => true,
    size,
    mtimeMs,
    ctimeMs: mtimeMs,
  };
}

function projectMachineSettings(state, projectPath, options = {}) {
  const projectKey = State.projectKey(projectPath);
  const projectSetup = options.projectSetup !== false;
  const protectionConfirmed = options.protection !== false;
  return {
    schemaVersion: 2,
    autoByProject: projectSetup ? { [projectKey]: options.auto !== false } : {},
    projectSetupByProject: projectSetup ? { [projectKey]: true } : {},
    protectedRevisionByProject: protectionConfirmed
      ? { [projectKey]: Math.max(1, Number(state && state.protectedConfigRevision) || 1) }
      : {},
    protectedMappings: Array.isArray(options.protectedMappings) ? options.protectedMappings : [],
  };
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
    initialMachineSettings: projectMachineSettings(initialState, projectPath, {
      protectedMappings: [
        { libraryId: firstId, label: "后期包", rootPath: "I:\\【后期包 ver10.0】" },
        { libraryId: secondId, label: "AI视频制作", rootPath: "I:\\AI视频制作" },
      ],
    }),
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

  assert.ok(harness.lstatPaths.includes("E:\\项目\\素材"));
  assert.ok(harness.lstatPaths.includes("E:\\共享库\\后期包"));
  const settings = JSON.parse(harness.localStorage.values.get(MACHINE_SETTINGS_V2_KEY));
  assert.equal(settings.protectedMappings[0].rootPath, "E:\\共享库\\后期包");
  assert.equal(harness.latestState.protectedLibraries[0].label, "后期包");
  assert.match(harness.settingsMessage.textContent, /已添加“后期包”/);
  assert.doesNotMatch(harness.settingsMessage.textContent, /no such file|directory/i);
});

test("首次开启时已有的外部普通素材会进入待整理，不会被 baseline 静默跳过", async () => {
  const sourcePath = "C:\\Users\\Administrator\\Downloads\\318完整版.mp4";
  const sourceSize = 5_802_589_846;
  const sourceMtime = Date.now() - 60_000;
  const initialState = State.createState("E:\\项目", new Date(2026, 8, 4, 9, 0, 0));
  const harness = createProtectedFolderHarness(null, null, null, {
    initialState,
    initialMachineSettings: projectMachineSettings(
      initialState,
      "E:\\项目\\测试工程.prproj",
      { projectSetup: false },
    ),
    inventoryEntries: [{ itemId: "clip-download", mediaPath: sourcePath, itemName: "318完整版.mp4" }],
    lstatResultForPath(nativePath) {
      if (Core.samePath(nativePath, sourcePath)) {
        return {
          isDirectory: () => false,
          isFile: () => true,
          size: sourceSize,
          mtimeMs: sourceMtime,
          ctimeMs: sourceMtime,
        };
      }
      return { isDirectory: () => true, isFile: () => false };
    },
  });

  await harness.entrypoints.show();
  try {
    harness.window.listeners.get("batch-collector:auto-collect")({ detail: { enabled: true } });
    await settle();
    await settle();

    assert.equal(
      harness.latestState.initialized,
      true,
      "首次归集应完成初始化；诊断：" + harness.diagnostics.join(" | "),
    );
    assert.equal(
      JSON.parse(harness.localStorage.values.get(MACHINE_SETTINGS_V2_KEY))
        .autoByProject[State.projectKey("E:\\项目\\测试工程.prproj")],
      true,
    );
    assert.equal(
      JSON.parse(harness.localStorage.values.get(MACHINE_SETTINGS_V2_KEY))
        .projectSetupByProject[State.projectKey("E:\\项目\\测试工程.prproj")],
      true,
    );
    assert.match(harness.stateTitle.textContent, /等待 1 个文件写完/);
    assert.notEqual(harness.stateTitle.textContent, "自动整理已开启");
    assert.equal(
      harness.latestState.knownMedia[Core.normalizePathForComparison(sourcePath)].sourceFingerprint.size,
      sourceSize,
      "大于 4 GiB 的视频大小必须保持为完整 Number，不能截断成 32 位整数",
    );
  } finally {
    harness.entrypoints.hide();
  }
});

test("同目录第二个工程不会继承旧的工作区自动开关，也不会在首次显示时自动补链", async () => {
  const workspaceRoot = "E:\\项目";
  const firstContext = projectContext(workspaceRoot, "第一版.prproj");
  let saveCalls = 0;
  const secondContext = projectContext(workspaceRoot, "交接版.prproj", {
    async save() {
      saveCalls += 1;
      return true;
    },
  });
  const sourcePath = "C:\\Downloads\\共享镜头.mp4";
  const targetRelativePath = "素材\\001_初始素材\\共享镜头.mp4";
  const targetPath = Core.joinNativePath(workspaceRoot, targetRelativePath);
  const targetFingerprint = { size: 4096, mtimeMs: 2000, ctimeMs: 3000 };
  let relinkCalls = 0;
  const clip = {
    mediaPath: sourcePath,
    async canChangeMediaPath() { return true; },
    async changeMediaFilePath(nextPath) {
      relinkCalls += 1;
      this.mediaPath = nextPath;
      return true;
    },
    async refreshMedia() {},
    async getMediaFilePath() { return this.mediaPath; },
    async isOffline() { return false; },
  };
  const now = new Date("2026-09-04T08:00:00.000Z");
  let initialState = State.createState(workspaceRoot, now);
  initialState.initialized = true;
  initialState = State.registerProject(initialState, firstContext.projectPath, firstContext.projectName, now);
  initialState.pathMappings[Core.normalizePathForComparison(sourcePath)] = [{
    sourcePath,
    targetRelativePath,
    sourceFingerprint: { size: 4096, mtimeMs: 1000, ctimeMs: 1000 },
    targetFingerprint,
    batchIndex: 1,
    byteCount: 4096,
    movedAt: "2026-09-04T08:01:00.000Z",
  }];

  const harness = createProtectedFolderHarness(null, null, null, {
    context: secondContext,
    initialState,
    initialMachineSettings: {
      schemaVersion: 2,
      autoByProject: { [State.projectKey(firstContext.projectPath)]: true },
      projectSetupByProject: { [State.projectKey(firstContext.projectPath)]: true },
      protectedRevisionByProject: {
        [State.projectKey(firstContext.projectPath)]: initialState.protectedConfigRevision,
      },
      protectedMappings: [],
    },
    inventoryEntries: [{ itemId: "clip-shared", mediaPath: sourcePath, itemName: "共享镜头.mp4", clip }],
    lstatResultForPath(nativePath) {
      if (Core.samePath(nativePath, sourcePath)) {
        const error = new Error("path not found");
        error.code = "ENOENT";
        throw error;
      }
      if (Core.samePath(nativePath, targetPath)) return readableFile(
        targetFingerprint.size,
        targetFingerprint.mtimeMs,
      );
      return { isDirectory: () => true, isFile: () => false };
    },
  });

  await harness.entrypoints.show();
  try {
    const visibleState = harness.stateTitle.textContent + " " + harness.stateDescription.textContent;
    assert.equal(harness.autoCollectToggle.checked, false);
    assert.match(visibleState, /先设置不搬动文件夹/);
    assert.equal(harness.document.body.dataset.onboarding, "protection");
    assert.equal(relinkCalls, 0, "第二个工程未显式启用前不能自动补链");
    assert.equal(saveCalls, 0, "第二个工程未显式启用前不能触发工程保存");
    assert.deepEqual(harness.fsMutationCalls, []);
  } finally {
    harness.entrypoints.hide();
  }
});

test("旧 autoByMediaSpace=true 只作为旧数据保留，不能让任意工程自动开启", async () => {
  const workspaceRoot = "E:\\旧项目";
  const context = projectContext(workspaceRoot, "旧工程.prproj");
  const sourcePath = "C:\\Downloads\\旧素材.wav";
  const protectedRoot = "I:\\共享素材\\旧后期包";
  const libraryId = "library-legacy-post-kit";
  const now = new Date("2026-09-04T08:00:00.000Z");
  let initialState = State.createState(workspaceRoot, now);
  initialState.initialized = true;
  initialState = State.registerProject(initialState, context.projectPath, context.projectName, now);
  initialState = State.addProtectedLibrary(initialState, libraryId, "旧后期包", now);
  const harness = createProtectedFolderHarness(null, null, null, {
    context,
    initialState,
    initialLegacyMachineSettings: {
      autoByMediaSpace: { [initialState.mediaSpaceId]: true },
      protectedSetupByMediaSpace: { [initialState.mediaSpaceId]: true },
      protectedMappings: [{ libraryId, label: "旧后期包", rootPath: protectedRoot }],
    },
    inventoryEntries: [{ itemId: "legacy-clip", mediaPath: sourcePath, itemName: "旧素材.wav" }],
    lstatResultForPath(nativePath) {
      if (Core.samePath(nativePath, sourcePath)) return readableFile(2048, Date.now() - 60_000);
      return { isDirectory: () => true, isFile: () => false };
    },
  });

  await harness.entrypoints.show();
  try {
    assert.equal(harness.autoCollectToggle.checked, false);
    assert.equal(harness.document.body.dataset.onboarding, "protection");
    assert.match(harness.protectedList.textContent, /旧后期包/);
    assert.match(harness.protectedList.textContent, /I:\\共享素材\\旧后期包/);
    assert.deepEqual(harness.fsMutationCalls, []);
  } finally {
    harness.entrypoints.hide();
  }
});

test("v2 中遗留的工作区布尔字段不能替代当前工程的名单版本确认", async () => {
  const workspaceRoot = "E:\\迁移项目";
  const context = projectContext(workspaceRoot, "剪辑.prproj");
  const sourcePath = "C:\\Downloads\\待归集.mov";
  const now = new Date("2026-09-04T08:00:00.000Z");
  let initialState = State.createState(workspaceRoot, now);
  initialState.initialized = true;
  initialState = State.registerProject(initialState, context.projectPath, context.projectName, now);
  const projectKey = State.projectKey(context.projectPath);
  const harness = createProtectedFolderHarness(null, null, null, {
    context,
    initialState,
    initialMachineSettings: {
      schemaVersion: 2,
      autoByProject: {},
      projectSetupByProject: {},
      protectedRevisionByProject: {},
      autoByMediaSpace: { [initialState.mediaSpaceId]: true },
      protectedSetupByMediaSpace: { [initialState.mediaSpaceId]: true },
      protectedMappings: [],
    },
    inventoryEntries: [{ itemId: "clip-stale", mediaPath: sourcePath, itemName: "待归集.mov" }],
    lstatResultForPath(nativePath) {
      if (Core.samePath(nativePath, sourcePath)) return readableFile(2048, Date.now() - 60_000);
      return { isDirectory: () => true, isFile: () => false };
    },
  });

  await harness.entrypoints.show();
  try {
    assert.equal(harness.document.body.dataset.onboarding, "protection");
    assert.equal(harness.autoCollectToggle.checked, false);
    assert.equal(harness.inventoryCount, 0);
    assert.deepEqual(harness.fsMutationCalls, []);
    const settings = JSON.parse(harness.localStorage.values.get(MACHINE_SETTINGS_V2_KEY));
    assert.equal(settings.autoByProject[projectKey], undefined);
    assert.equal(settings.protectedRevisionByProject[projectKey], undefined);
  } finally {
    harness.entrypoints.hide();
  }
});

test("每个工程显式开启后才扫描工程外已有和后来新增的素材", async () => {
  const workspaceRoot = "E:\\逐工程开启";
  const enabledContext = projectContext(workspaceRoot, "本期.prproj");
  const otherContext = projectContext(workspaceRoot, "下期.prproj");
  const existingPath = "C:\\Downloads\\开场.mp4";
  const addedPath = "C:\\Downloads\\补拍.mp4";
  const now = new Date("2026-09-04T08:00:00.000Z");
  let initialState = State.createState(workspaceRoot, now);
  initialState.initialized = true;
  initialState = State.registerProject(initialState, enabledContext.projectPath, enabledContext.projectName, now);
  const initialMachineSettings = projectMachineSettings(
    initialState,
    enabledContext.projectPath,
    { projectSetup: false },
  );
  const existing = { itemId: "existing", mediaPath: existingPath, itemName: "开场.mp4" };
  const added = { itemId: "added", mediaPath: addedPath, itemName: "补拍.mp4" };
  const harness = createProtectedFolderHarness(null, null, null, {
    context: enabledContext,
    initialState,
    initialMachineSettings,
    inventoryEntries: [existing],
    lstatResultForPath(nativePath) {
      if (Core.samePath(nativePath, existingPath)) return readableFile(2 * 1024 * 1024, Date.now() - 60_000);
      if (Core.samePath(nativePath, addedPath)) return readableFile(3 * 1024 * 1024, Date.now() - 60_000);
      return { isDirectory: () => true, isFile: () => false };
    },
  });

  await harness.entrypoints.show();
  try {
    assert.equal(harness.autoCollectToggle.checked, false);
    assert.deepEqual(harness.fsMutationCalls, []);
    const scansBeforeEnable = harness.inventoryCount;

    harness.window.listeners.get("batch-collector:auto-collect")({ detail: { enabled: true } });
    await settle();
    assert.equal(harness.autoCollectToggle.checked, true);
    assert.ok(harness.inventoryCount > scansBeforeEnable, "显式开启时应检查工程外已有素材");

    harness.setInventoryEntries([existing, added]);
    const scansBeforeNewImport = harness.inventoryCount;
    harness.window.listeners.get("batch-collector:refresh")();
    await settle();
    assert.ok(harness.inventoryCount > scansBeforeNewImport, "开启后应继续检查后来新增的工程外素材");
    assert.match(
      harness.stateTitle.textContent + " " + harness.stateDescription.textContent,
      /2\s*个/,
    );
  } finally {
    harness.entrypoints.hide();
  }

  const savedSettings = JSON.parse(
    harness.localStorage.values.get(MACHINE_SETTINGS_V2_KEY),
  );
  const otherHarness = createProtectedFolderHarness(null, null, null, {
    context: otherContext,
    initialState: harness.latestState || initialState,
    initialMachineSettings: savedSettings,
    inventoryEntries: [],
  });
  await otherHarness.entrypoints.show();
  try {
    assert.equal(otherHarness.autoCollectToggle.checked, false, "另一个工程仍需自己显式开启");
    assert.deepEqual(otherHarness.fsMutationCalls, []);
  } finally {
    otherHarness.entrypoints.hide();
  }
});

test("工程首次显示时汇总工程外普通素材的数量和总大小，但不会立即搬动", async () => {
  const workspaceRoot = "E:\\待启用项目";
  const context = projectContext(workspaceRoot, "待启用.prproj");
  const firstPath = "C:\\Downloads\\甲.wav";
  const secondPath = "D:\\临时素材\\乙.mp4";
  const now = new Date("2026-09-04T08:00:00.000Z");
  let initialState = State.createState(workspaceRoot, now);
  initialState.initialized = true;
  initialState = State.registerProject(initialState, context.projectPath, context.projectName, now);
  const harness = createProtectedFolderHarness(null, null, null, {
    context,
    initialState,
    initialMachineSettings: projectMachineSettings(initialState, context.projectPath, {
      projectSetup: false,
    }),
    inventoryEntries: [
      { itemId: "first", mediaPath: firstPath, itemName: "甲.wav" },
      { itemId: "second", mediaPath: secondPath, itemName: "乙.mp4" },
    ],
    lstatResultForPath(nativePath) {
      if (Core.samePath(nativePath, firstPath)) return readableFile(2 * 1024 * 1024, Date.now() - 60_000);
      if (Core.samePath(nativePath, secondPath)) return readableFile(3 * 1024 * 1024, Date.now() - 60_000);
      return { isDirectory: () => true, isFile: () => false };
    },
  });

  await harness.entrypoints.show();
  try {
    const visibleSummary = [
      harness.stateTitle.textContent,
      harness.stateDescription.textContent,
      harness.fileCount.textContent,
      harness.fileSize.textContent,
    ].join(" ");
    assert.match(visibleSummary, /2\s*个/);
    assert.match(visibleSummary, /5(?:\.0+)?\s*MB/i);
    assert.equal(harness.autoCollectToggle.checked, false);
    assert.deepEqual(harness.fsMutationCalls, []);
  } finally {
    harness.entrypoints.hide();
  }
});

test("状态与备份丢失但素材根目录仍存在时会停止，不会复用旧批次", async () => {
  const harness = createProtectedFolderHarness(null, null, null, {
    missingStateMediaRootExists: true,
  });

  await harness.entrypoints.show();

  assert.equal(harness.stateTitle.textContent, "自动整理已暂停");
  assert.match(harness.stateDescription.textContent, /“素材”文件夹已经存在/);
  assert.match(harness.stateDescription.textContent, /整理记录和备份都找不到/);
  assert.equal(harness.inventoryCount, 0);
  assert.equal(harness.stateWriteCalls, 0);
  assert.deepEqual(harness.mkdirPaths, []);
  assert.deepEqual(harness.fsMutationCalls, []);
});

test("状态与备份及素材根目录都不存在时仍允许进入首次设置", async () => {
  const harness = createProtectedFolderHarness();

  await harness.entrypoints.show();

  assert.equal(harness.stateTitle.textContent, "先设置不搬动文件夹");
  assert.equal(harness.inventoryCount, 0);
  assert.equal(harness.stateWriteCalls, 0);
  assert.deepEqual(harness.mkdirPaths, []);
  assert.deepEqual(harness.fsMutationCalls, []);
});

test("状态缺失时素材根目录无法读取不会伪装成首次使用", async () => {
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const harness = createProtectedFolderHarness(null, null, null, {
    missingStateMediaRootError: denied,
  });

  await harness.entrypoints.show();

  assert.equal(harness.stateTitle.textContent, "自动整理已暂停");
  assert.match(harness.stateDescription.textContent, /无法访问需要使用的文件夹/);
  assert.equal(harness.inventoryCount, 0);
  assert.equal(harness.stateWriteCalls, 0);
  assert.deepEqual(harness.mkdirPaths, []);
  assert.deepEqual(harness.fsMutationCalls, []);
});

test("旧状态确认新归集策略后保留 baseline 证据，但不再用它跳过现有素材", async () => {
  const projectPath = "E:\\项目\\测试工程.prproj";
  const sourcePath = "C:\\Users\\Administrator\\Downloads\\旧版已记住.mp4";
  const sourceMtime = Date.now() - 60_000;
  const fingerprint = { size: 2048, mtimeMs: sourceMtime, ctimeMs: sourceMtime };
  const now = new Date(2026, 8, 4, 9, 0, 0);
  let initialState = State.createState("E:\\项目", now);
  initialState.initialized = true;
  initialState.collectionPolicyVersion = 1;
  initialState = State.registerProject(initialState, projectPath, "测试工程.prproj", now);
  initialState = State.markProjectBaseline(initialState, projectPath, [{
    mediaPath: sourcePath,
    sourceFingerprint: fingerprint,
  }], now);
  const harness = createProtectedFolderHarness(null, null, null, {
    initialState,
    initialMachineSettings: projectMachineSettings(initialState, projectPath, {
      projectSetup: false,
    }),
    inventoryEntries: [{ itemId: "clip-legacy", mediaPath: sourcePath, itemName: "旧版已记住.mp4" }],
    lstatResultForPath(nativePath) {
      if (Core.samePath(nativePath, sourcePath)) {
        return { isDirectory: () => false, isFile: () => true, ...fingerprint };
      }
      return { isDirectory: () => true, isFile: () => false };
    },
  });

  await harness.entrypoints.show();
  try {
    assert.equal(harness.stateTitle.textContent, "当前工程尚未开启");
    assert.equal(harness.stateAction.dataset.intent, "开始整理此工程");
    assert.deepEqual(harness.fsMutationCalls, [], "确认之前不得移动旧 baseline 素材");

    await harness.window.listeners.get("batch-collector:state-action")();
    await settle();

    assert.equal(harness.latestState.collectionPolicyVersion, State.COLLECTION_POLICY_VERSION);
    assert.equal(
      State.projectBaselineStatus(harness.latestState, projectPath, sourcePath, fingerprint),
      "match",
      "迁移不应删除旧路径和指纹证据",
    );
    assert.match(harness.stateTitle.textContent, /等待 1 个文件写完/);
    assert.equal(
      JSON.parse(harness.localStorage.values.get(MACHINE_SETTINGS_V2_KEY))
        .autoByProject[State.projectKey(projectPath)],
      true,
    );
  } finally {
    harness.entrypoints.hide();
  }
});

test("首次扫描仍保护不搬动、已管理和工程文件，并把危险素材交给人工确认", async () => {
  const protectedRoot = "I:\\共享素材\\后期包";
  const protectedPath = protectedRoot + "\\音效.wav";
  const managedPath = "E:\\项目\\素材\\已有素材\\片头.wav";
  const projectAssetPath = "C:\\Downloads\\另一个工程.prproj";
  const reviewPath = "C:\\Downloads\\动态模板.mogrt";
  const sourceMtime = Date.now() - 60_000;
  const libraryId = "library-first-scan-protected";
  let initialState = State.createState("E:\\项目", new Date(2026, 8, 4, 9, 0, 0));
  initialState = State.addProtectedLibrary(initialState, libraryId, "后期包", new Date(2026, 8, 4, 9, 0, 1));
  const harness = createProtectedFolderHarness(null, null, null, {
    initialState,
    initialMachineSettings: projectMachineSettings(initialState, "E:\\项目\\测试工程.prproj", {
      projectSetup: false,
      protectedMappings: [{ libraryId, label: "后期包", rootPath: protectedRoot }],
    }),
    inventoryEntries: [protectedPath, managedPath, projectAssetPath, reviewPath].map((mediaPath, index) => ({
      itemId: "clip-" + index,
      mediaPath,
      itemName: Core.basename(mediaPath),
    })),
    lstatResultForPath(nativePath) {
      if (Core.samePath(nativePath, protectedRoot)) {
        return { isDirectory: () => true, isFile: () => false };
      }
      if ([protectedPath, reviewPath].some((candidate) => Core.samePath(nativePath, candidate))) {
        return {
          isDirectory: () => false,
          isFile: () => true,
          size: 512,
          mtimeMs: sourceMtime,
          ctimeMs: sourceMtime,
        };
      }
      return { isDirectory: () => true, isFile: () => false };
    },
  });

  await harness.entrypoints.show();
  try {
    harness.window.listeners.get("batch-collector:auto-collect")({ detail: { enabled: true } });
    await settle();
    await settle();

    assert.equal(
      harness.latestState.knownMedia[Core.normalizePathForComparison(protectedPath)]?.status,
      "protected",
      "首次分类应被持久化；诊断：" + harness.diagnostics.join(" | "),
    );
    assert.equal(harness.latestState.knownMedia[Core.normalizePathForComparison(managedPath)].status, "managed");
    assert.equal(harness.latestState.knownMedia[Core.normalizePathForComparison(projectAssetPath)].status, "ignored");
    assert.equal(harness.reviewSection.hidden, false);
    assert.equal(harness.reviewList.children.length, 1);
    assert.match(harness.reviewList.textContent, /动态模板\.mogrt/);
    assert.match(harness.stateTitle.textContent, /1 个素材需要人工处理/);
    assert.deepEqual(harness.fsMutationCalls, []);
  } finally {
    harness.entrypoints.hide();
  }
});

test("素材目录已经存在时仍会确认目录并正常打开", async () => {
  const existsError = new Error("file already exists");
  const initialState = State.createState("E:\\项目", new Date("2026-09-04T00:00:00.000Z"));
  const projectPath = "E:\\项目\\测试工程.prproj";
  const expectedBatchPath = State.currentBatchPath(initialState, "E:\\项目");
  const harness = createProtectedFolderHarness(null, null, null, {
    initialState,
    initialMachineSettings: projectMachineSettings(initialState, projectPath, { auto: false }),
    mkdirError: existsError,
  });
  await harness.entrypoints.show();

  assert.equal(harness.openBatchButton.disabled, false);
  harness.window.listeners.get("batch-collector:open-batch")();
  await settle();

  assert.deepEqual(harness.mkdirPaths, ["E:\\项目\\素材", expectedBatchPath]);
  assert.ok(harness.lstatPaths.includes("E:\\项目\\素材"));
  assert.ok(harness.lstatPaths.includes(expectedBatchPath));
  assert.equal(harness.shellOpenCalls.length, 1, "确认已有目录可用后应继续打开当前素材文件夹");
  assert.equal(harness.shellOpenCalls[0][0], expectedBatchPath);
  assert.doesNotMatch(harness.stateDescription.textContent, /file already exists/i);
});

test("打开素材目录遇到权限错误时只显示局部中文提示，不污染主状态", async () => {
  const denied = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const initialState = State.createState("E:\\项目", new Date("2026-09-04T00:00:00.000Z"));
  const projectPath = "E:\\项目\\测试工程.prproj";
  const harness = createProtectedFolderHarness(null, null, null, {
    initialState,
    initialMachineSettings: projectMachineSettings(initialState, projectPath, { auto: false }),
    mkdirError: denied,
  });
  await harness.entrypoints.show();

  harness.window.listeners.get("batch-collector:open-batch")();
  await settle();

  assert.equal(harness.shellOpenCalls.length, 0);
  assert.notEqual(harness.stateTitle.textContent, "自动整理已暂停");
  assert.equal(harness.folderActionMessage.hidden, false);
  assert.match(harness.folderActionMessage.textContent, /无法使用当前素材文件夹/);
  assert.match(harness.folderActionMessage.textContent, /没有移动任何素材/);
  assert.doesNotMatch(harness.folderActionMessage.textContent, /permission|denied|EACCES/i);
  assert.match(harness.diagnostics.join("\n"), /cause\.code=EACCES/);
});

test("素材目录位置被同名文件占用时不会打开或覆盖", async () => {
  const initialState = State.createState("E:\\项目", new Date("2026-09-04T00:00:00.000Z"));
  const projectPath = "E:\\项目\\测试工程.prproj";
  const expectedBatchPath = State.currentBatchPath(initialState, "E:\\项目");
  const harness = createProtectedFolderHarness(null, null, null, {
    initialState,
    initialMachineSettings: projectMachineSettings(initialState, projectPath, { auto: false }),
    mkdirError: new Error("file already exists"),
    lstatResultForPath(nativePath) {
      if (nativePath === "E:\\项目\\素材") return { isDirectory: () => true, isFile: () => false };
      if (nativePath === expectedBatchPath) return { isDirectory: () => false, isFile: () => true };
      throw new Error("unexpected lstat path: " + nativePath);
    },
  });
  await harness.entrypoints.show();

  harness.window.listeners.get("batch-collector:open-batch")();
  await settle();

  assert.equal(harness.shellOpenCalls.length, 0);
  assert.deepEqual(harness.mkdirPaths, ["E:\\项目\\素材", expectedBatchPath]);
  assert.deepEqual(harness.lstatPaths, ["E:\\项目\\素材", expectedBatchPath]);
  assert.notEqual(harness.stateTitle.textContent, "自动整理已暂停");
  assert.match(harness.folderActionMessage.textContent, /被同名文件占用/);
  assert.match(harness.folderActionMessage.textContent, /没有移动任何素材/);
});

test("仅打开文件夹失败时不会把正在运行的自动整理显示为全局暂停", async () => {
  const now = new Date(2026, 8, 4, 10, 0, 0);
  let initialState = State.createState("E:\\项目", now);
  initialState.initialized = true;
  initialState = State.registerProject(initialState, "E:\\项目\\测试工程.prproj", "测试工程.prproj", now);
  initialState = State.markProjectBaseline(initialState, "E:\\项目\\测试工程.prproj", [], now);
  const openError = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const harness = createProtectedFolderHarness(null, null, null, {
    initialState,
    initialMachineSettings: projectMachineSettings(initialState, "E:\\项目\\测试工程.prproj"),
    shellOpenError: openError,
  });

  await harness.entrypoints.show();
  try {
    assert.equal(harness.stateTitle.textContent, "此工程的自动整理已开启");
    harness.window.listeners.get("batch-collector:open-batch")();
    await settle();

    const settings = JSON.parse(harness.localStorage.values.get(MACHINE_SETTINGS_V2_KEY));
    assert.equal(settings.autoByProject[State.projectKey("E:\\项目\\测试工程.prproj")], true);
    assert.equal(harness.autoCollectToggle.checked, true);
    assert.notEqual(harness.stateTitle.textContent, "自动整理已暂停");
    assert.notEqual(harness.document.body.dataset.state, "failure");
    assert.equal(harness.shellOpenCalls.length, 1);
    assert.equal(harness.folderActionMessage.hidden, false);
    assert.match(harness.folderActionMessage.textContent, /无法访问需要使用的文件夹/);
    assert.doesNotMatch(harness.folderActionMessage.textContent, /permission|denied|EACCES/i);
    assert.match(harness.diagnostics.join("\n"), /error\.code=EACCES/);
  } finally {
    harness.entrypoints.hide();
  }
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
    initialMachineSettings: projectMachineSettings(initialState, "E:\\项目\\测试工程.prproj", {
      projectSetup: false,
      protectedMappings: libraries.map(function ([libraryId, label, rootPath]) {
        return { libraryId, label, rootPath };
      }),
    }),
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
    initialMachineSettings: projectMachineSettings(initialState, "E:\\项目\\测试工程.prproj", {
      projectSetup: false,
      protectedMappings: [{ libraryId, label: "【后期包 ver10.0】", rootPath: existingPath }],
    }),
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

test("选择器打开期间其他面板加入重叠目录时会重读名单并拒绝写入", async () => {
  const workspaceRoot = "E:\\项目";
  const projectPath = "E:\\项目\\测试工程.prproj";
  const parentPath = "I:\\共享库\\后期包";
  const selectedPath = parentPath + "\\音效";
  const libraryId = "library-concurrent-post-kit";
  const pickerStarted = deferred();
  const pickerResult = deferred();
  const now = new Date("2026-09-04T00:00:00.000Z");
  let initialState = State.createState(workspaceRoot, now);
  initialState = State.registerProject(initialState, projectPath, "测试工程.prproj", now);
  const stateStore = { value: initialState, revision: "initial" };
  const sharedLocalStorage = createSharedLocalStorage([[
    MACHINE_SETTINGS_V2_KEY,
    JSON.stringify(projectMachineSettings(initialState, projectPath, {
      projectSetup: false,
      protection: false,
    })),
  ]]);
  const harness = createProtectedFolderHarness(null, null, null, {
    stateStore,
    sharedLocalStorage,
    async getFolder() {
      pickerStarted.resolve();
      return pickerResult.promise;
    },
  });
  await harness.entrypoints.show();

  try {
    harness.addButton.listeners.get("click")();
    await pickerStarted.promise;

    let externalState = State.addProtectedLibrary(stateStore.value, libraryId, "后期包", now);
    externalState = State.bumpProtectedConfigRevision(externalState, now);
    stateStore.value = externalState;
    stateStore.revision = "external-1";
    sharedLocalStorage.values.set(
      MACHINE_SETTINGS_V2_KEY,
      JSON.stringify(projectMachineSettings(externalState, projectPath, {
        projectSetup: false,
        protection: false,
        protectedMappings: [{ libraryId, label: "后期包", rootPath: parentPath }],
      })),
    );
    pickerResult.resolve({ nativePath: "\\\\?\\" + selectedPath, name: "音效" });
    await settle();
    await settle();

    assert.equal(harness.stateWriteCalls, 0, "并发名单变化后不得覆盖共享状态");
    assert.equal(stateStore.value.protectedConfigRevision, 2);
    assert.deepEqual(
      stateStore.value.protectedLibraries.map((library) => library.libraryId),
      [libraryId],
    );
    assert.equal(harness.settingsMessage.dataset.kind, "error");
    assert.match(harness.settingsMessage.textContent, /范围重叠/);
    assert.deepEqual(harness.fsMutationCalls, []);
  } finally {
    harness.entrypoints.hide();
  }
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
    const settingsBefore = harness.localStorage.values.get(MACHINE_SETTINGS_V2_KEY);
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
    assert.equal(harness.localStorage.values.get(MACHINE_SETTINGS_V2_KEY), settingsBefore);
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
    assert.match(harness.confirmMessages[0], /同一工程文件夹内的所有工程都会暂停/);
    assert.equal(harness.stateWriteCalls, stateWritesBefore + 1, "确认后会原子保存更新后的工程名单");
    assert.deepEqual(
      harness.latestState.protectedLibraries.map((library) => library.libraryId),
      [fixture.secondId],
      "只移除用户确认的那一个名单项"
    );
    const machineSettings = JSON.parse(harness.localStorage.values.get(MACHINE_SETTINGS_V2_KEY));
    assert.equal(machineSettings.autoByProject[State.projectKey("E:\\项目\\测试工程.prproj")], false);
    assert.equal(harness.inventoryCount, inventoryBefore, "名单管理不应启动素材扫描");
    assert.deepEqual(harness.fsMutationCalls, [], "名单管理不应调用任何文件移动或删除 API");
    assert.equal(harness.protectedListCount.textContent, "1 个");
    assert.equal(harness.protectedCountText.textContent, "1 个");
    assert.doesNotMatch(harness.protectedList.textContent, /后期包/);
    assert.match(harness.protectedList.textContent, /AI视频制作/);
    assert.equal(harness.settingsMessage.dataset.kind, "success");
    assert.match(harness.settingsMessage.textContent, /没有删除磁盘文件或素材/);
    assert.match(harness.settingsMessage.textContent, /同一工程文件夹内的所有工程已暂停/);
  } finally {
    harness.entrypoints.hide();
  }
});

test("确认移除期间其他面板已删除同一项时不会重复递增名单版本", async () => {
  const fixture = protectedRemovalFixture();
  const stateStore = { value: fixture.initialState, revision: "initial" };
  const sharedLocalStorage = createSharedLocalStorage([[
    MACHINE_SETTINGS_V2_KEY,
    JSON.stringify(fixture.initialMachineSettings),
  ]]);
  const originalRevision = fixture.initialState.protectedConfigRevision;
  const harness = createProtectedFolderHarness(null, null, null, {
    ...fixture,
    stateStore,
    sharedLocalStorage,
    confirmResult: true,
    onConfirm() {
      let externalState = State.removeProtectedLibrary(stateStore.value, fixture.firstId, new Date());
      externalState = State.bumpProtectedConfigRevision(externalState, new Date());
      stateStore.value = externalState;
      stateStore.revision = "external-remove";
    },
  });
  await harness.entrypoints.show();

  try {
    const removeButton = findProtectedAction(harness.protectedList, fixture.firstId, "remove");
    harness.protectedList.listeners.get("click")({ target: removeButton });
    await settle();

    assert.equal(harness.stateWriteCalls, 0, "已经完成的外部删除不得再次写状态");
    assert.equal(stateStore.value.protectedConfigRevision, originalRevision + 1);
    assert.deepEqual(
      stateStore.value.protectedLibraries.map((library) => library.libraryId),
      [fixture.secondId],
    );
    assert.equal(harness.settingsMessage.dataset.kind, "error");
    assert.match(harness.settingsMessage.textContent, /名单已经变化/);
    assert.deepEqual(harness.fsMutationCalls, []);
  } finally {
    harness.entrypoints.hide();
  }
});

test("不搬动名单变化会暂停同一工程文件夹里的全部工程，但不会影响其他工程文件夹", async () => {
  const fixture = protectedRemovalFixture();
  const currentProjectPath = "E:\\项目\\测试工程.prproj";
  const siblingProjectPath = "E:\\项目\\交接版.prproj";
  const unrelatedProjectPath = "D:\\其他项目\\独立工程.prproj";
  fixture.initialState = State.registerProject(
    fixture.initialState,
    siblingProjectPath,
    "交接版.prproj",
    new Date("2026-09-04T08:01:00.000Z"),
  );
  fixture.initialMachineSettings.autoByProject[State.projectKey(siblingProjectPath)] = true;
  fixture.initialMachineSettings.projectSetupByProject[State.projectKey(siblingProjectPath)] = true;
  fixture.initialMachineSettings.autoByProject[State.projectKey(unrelatedProjectPath)] = true;
  fixture.initialMachineSettings.projectSetupByProject[State.projectKey(unrelatedProjectPath)] = true;

  const harness = createProtectedFolderHarness(null, null, null, {
    ...fixture,
    confirmResult: true,
  });
  await harness.entrypoints.show();

  try {
    const removeButton = findProtectedAction(harness.protectedList, fixture.firstId, "remove");
    harness.protectedList.listeners.get("click")({ target: removeButton });
    await settle();

    const settings = JSON.parse(
      harness.localStorage.values.get(MACHINE_SETTINGS_V2_KEY),
    );
    assert.equal(settings.autoByProject[State.projectKey(currentProjectPath)], false);
    assert.equal(settings.autoByProject[State.projectKey(siblingProjectPath)], false);
    assert.equal(settings.autoByProject[State.projectKey(unrelatedProjectPath)], true);
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
  assert.equal(harness.stateAction.textContent, "开始整理此工程");
  assert.ok(harness.latestState && harness.latestState.mediaSpaceId, "空名单确认也会先保存素材空间");
  const settings = JSON.parse(harness.localStorage.values.get(MACHINE_SETTINGS_V2_KEY));
  const projectKey = State.projectKey("E:\\项目\\测试工程.prproj");
  assert.equal(settings.schemaVersion, 2);
  assert.equal(settings.protectedRevisionByProject[projectKey], harness.latestState.protectedConfigRevision);
  assert.equal(Object.keys(settings.protectedRevisionByProject).length, 1);
  assert.equal(harness.localStorage.setCalls, settingsWritesBeforeConfirmation + 1, "确认时两个本机字段只提交一次");
});

test("其他面板更新不搬动名单版本后，当前面板会在扫描前暂停", async () => {
  const workspaceRoot = "E:\\跨面板项目";
  const context = projectContext(workspaceRoot, "剪辑.prproj");
  const now = new Date("2026-09-04T08:00:00.000Z");
  let initialState = State.createState(workspaceRoot, now);
  initialState.initialized = true;
  initialState = State.registerProject(initialState, context.projectPath, context.projectName, now);
  const stateStore = { value: initialState, revision: "initial" };
  const sharedLocalStorage = createSharedLocalStorage([[
    MACHINE_SETTINGS_V2_KEY,
    JSON.stringify(projectMachineSettings(initialState, context.projectPath)),
  ]]);
  const harness = createProtectedFolderHarness(null, null, null, {
    context,
    stateStore,
    sharedLocalStorage,
    inventoryEntries: [],
  });
  await harness.entrypoints.show();

  try {
    const scansBefore = harness.inventoryCount;
    const writesBefore = harness.stateWriteCalls;
    stateStore.value = State.bumpProtectedConfigRevision(stateStore.value, new Date(now.getTime() + 1000));
    stateStore.revision = "external-revision-2";

    harness.window.listeners.get("batch-collector:refresh")();
    await settle();
    await settle();

    const projectKey = State.projectKey(context.projectPath);
    const settings = JSON.parse(sharedLocalStorage.values.get(MACHINE_SETTINGS_V2_KEY));
    assert.equal(harness.stateReadCalls >= 2, true, "扫描前必须重新读取共享工程状态");
    assert.equal(settings.autoByProject[projectKey], false);
    assert.equal(harness.autoCollectToggle.checked, false);
    assert.equal(harness.document.body.dataset.onboarding, "protection");
    assert.equal(harness.inventoryCount, scansBefore, "名单版本不匹配时不得读取素材清单");
    assert.equal(harness.stateWriteCalls, writesBefore);
    assert.deepEqual(harness.fsMutationCalls, []);
  } finally {
    harness.entrypoints.hide();
  }
});

test("确认名单入队后活动工程已切换时不会确认任何工程", async () => {
  const workspaceRoot = "E:\\工程切换";
  const contextA = projectContext(workspaceRoot, "A.prproj");
  const contextB = projectContext(workspaceRoot, "B.prproj");
  let liveContext = contextA;
  const harness = createProtectedFolderHarness(null, null, null, {
    context: contextA,
    activeContext() { return liveContext; },
    contextStillActive(expectedIdentity) { return liveContext.identity === expectedIdentity; },
  });
  await harness.entrypoints.show();

  try {
    const writesBefore = harness.stateWriteCalls;
    const settingsWritesBefore = harness.localStorage.setCalls;
    const scansBefore = harness.inventoryCount;
    liveContext = contextB;
    harness.finishButton.listeners.get("click")();
    await settle();

    assert.equal(harness.stateWriteCalls, writesBefore);
    assert.equal(harness.localStorage.setCalls, settingsWritesBefore);
    assert.equal(harness.inventoryCount, scansBefore);
    assert.equal(harness.settingsMessage.dataset.kind, "error");
    assert.match(harness.diagnostics.join("\n"), /活动工程已切换/);
    assert.deepEqual(harness.fsMutationCalls, []);
  } finally {
    harness.entrypoints.hide();
  }
});

test("确认名单刷新取得旧工程快照后再切换工程时仍不会保存", async () => {
  const workspaceRoot = "E:\\工程切换";
  const contextA = projectContext(workspaceRoot, "A.prproj");
  const contextB = projectContext(workspaceRoot, "B.prproj");
  let liveContext = contextA;
  let activeContextCalls = 0;
  const harness = createProtectedFolderHarness(null, null, null, {
    context: contextA,
    activeContext() {
      activeContextCalls += 1;
      if (activeContextCalls === 2) {
        liveContext = contextB;
        return contextA;
      }
      return liveContext;
    },
    contextStillActive(expectedIdentity) { return liveContext.identity === expectedIdentity; },
  });
  await harness.entrypoints.show();

  try {
    const writesBefore = harness.stateWriteCalls;
    const settingsWritesBefore = harness.localStorage.setCalls;
    const scansBefore = harness.inventoryCount;
    harness.finishButton.listeners.get("click")();
    await settle();

    assert.equal(harness.stateWriteCalls, writesBefore);
    assert.equal(harness.localStorage.setCalls, settingsWritesBefore);
    assert.equal(harness.inventoryCount, scansBefore);
    assert.equal(harness.settingsMessage.dataset.kind, "error");
    assert.match(harness.diagnostics.join("\n"), /活动工程已切换/);
    assert.deepEqual(harness.fsMutationCalls, []);
  } finally {
    harness.entrypoints.hide();
  }
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
  assert.equal(
    harness.localStorage.values.has(MACHINE_SETTINGS_V2_KEY),
    false,
    "第一次写入失败时不会残留任何已确认设置",
  );
  assert.match(harness.diagnostics.join("\n"), /cause\.message=quota exceeded/);

  harness.finishButton.listeners.get("click")();
  await settle();
  const retriedSettings = JSON.parse(harness.localStorage.values.get(MACHINE_SETTINGS_V2_KEY));
  assert.equal(
    retriedSettings.protectedRevisionByProject[State.projectKey("E:\\项目\\测试工程.prproj")],
    harness.latestState.protectedConfigRevision,
    "重试后可一次提交当前工程和当前名单版本",
  );
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
  assert.ok(harness.readCount >= 2, "恢复流程会重新读取持久化的待处理记录");
});

test("当前工程明确开启后再暂停，历史映射也不会自动补链或保存 Premiere 工程", async () => {
  const harness = createMappingHarness({ autoEnabled: false });
  await harness.entrypoints.show();

  try {
    assert.equal(harness.project.saveCalls, 0);
    assert.equal(harness.clip.mediaPath, "C:\\Downloads\\mapped.mp4");
    assert.equal(harness.writeCount, 0);
    assert.equal(harness.stateAction.dataset.intent, "继续自动整理");
  } finally {
    harness.entrypoints.hide();
  }
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
