(function () {
  "use strict";

  if (typeof require !== "function") return;

  var uxp = require("uxp");
  var ppro = require("premierepro");
  var fs = require("fs");
  var Core = globalThis.MaterialBatchCore;
  var State = globalThis.MaterialBatchState;
  var Transaction = globalThis.MaterialBatchTransaction;
  var Recovery = globalThis.MaterialBatchRecovery;
  var Coordination = globalThis.MaterialBatchCoordination;
  var Premiere = globalThis.MaterialBatchPremiere;
  var Storage = globalThis.MaterialBatchStorage;
  var ScanPolicy = globalThis.MaterialBatchScanPolicy;
  var FileService = globalThis.MaterialBatchFileService;
  var RecycleBridge = globalThis.MaterialBatchRecycleBridge;
  var confirmation = globalThis.MaterialBatchConfirmation.create(document);
  if (RecycleBridge) {
    fs = FileService.createHostFileSystem(fs, async function (path) {
      if (!/^[A-Za-z]:[\\/]/.test(path)) throw new Error("当前平台缺少精确文件身份接口");
      var plugin = await uxp.storage.localFileSystem.getPluginFolder();
      return RecycleBridge.create({ fs: fs, uxp: uxp, pluginPath: plugin.nativePath }).readIdentity(path);
    });
  }
  var recoveryCancelled = false;
  var backgroundOperation = false;

  var MACHINE_SETTINGS_KEY = "hechao.material-batch-organizer.machine.v2";
  var LEGACY_MACHINE_SETTINGS_KEY = "hechao.material-batch-organizer.machine.v1";
  var MACHINE_SETTINGS_SCHEMA_VERSION = 2;
  var POLL_INTERVAL_MS = 2600;
  var operationQueue = Coordination.createOperationQueue();
  var monitorGuard = Coordination.createGenerationGuard();
  var lifecycleGuard = Coordination.createGenerationGuard();
  var stabilityTracker = ScanPolicy.createStabilityTracker({ stableForMs: 8000, minimumAgeMs: 5000 });
  var machineSettings = loadMachineSettings();
  var context = null;
  var projectState = null;
  var stateRevision = Storage.MISSING_REVISION;
  var stateRecoveredFromBackup = false;
  var stateReloadRequired = false;
  var monitoring = false;
  var panelVisible = false;
  var uiBound = false;
  var busy = false;
  var busyStage = "";
  var panelError = "";
  var storageWarning = "";
  var folderActionMessage = "";
  var openingFolder = false;
  var settingsMessage = "";
  var settingsMessageKind = "";
  var scanTimer = null;
  var soonTimer = null;
  var scanPromise = null;
  var silentScan = false;
  var importedDuringScan = false;
  var renderSignature = "";
  var savedProjectEvidence = null;
  var globalImportAttached = false;
  var projectDirtyBinding = null;
  var pendingCount = 0;
  var reviewCount = 0;
  var reviewItems = [];
  var lastProtectedCount = 0;
  var lastInventoryCount = 0;
  var outsideMediaCount = 0;
  var outsideCollectCount = 0;
  var outsideReviewCount = 0;
  var outsideMediaBytes = 0;
  var outsideUnreadableCount = 0;
  var protectedMappingValidation = { validMappings: [], unresolved: [], statusById: {} };
  var recoverySnapshot = null;
  var recoveryMessage = "";

  function element(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    var target = element(id);
    var text = value == null ? "" : String(value);
    if (target && target.textContent !== text) target.textContent = text;
  }

  function setSettingsMessage(kind, message) {
    settingsMessageKind = String(kind || "");
    settingsMessage = String(message || "");
  }

  function readErrorDetail(error, field) {
    try {
      return error && error[field] != null ? String(error[field]) : "";
    } catch (readError) {
      return "";
    }
  }

  function runtimeErrorDiagnostic(error) {
    var details = [];
    function append(source, prefix) {
      if (!source) return;
      ["name", "code", "errno", "message"].forEach(function (field) {
        var value = readErrorDetail(source, field).trim();
        if (value) details.push(prefix + field + "=" + value);
      });
      try {
        var rendered = String(source).trim();
        if (rendered && details.indexOf(prefix + "string=" + rendered) < 0) details.push(prefix + "string=" + rendered);
      } catch (stringError) {}
    }
    append(error, "error.");
    append(error && error.cause, "cause.");
    return details.join("；") || "没有可用的错误详情";
  }

  function reportRuntimeError(action, error) {
    try {
      if (typeof console !== "undefined" && console && typeof console.error === "function") {
        console.error("[赫朝素材自动整理] " + action + "：" + runtimeErrorDiagnostic(error));
      }
    } catch (logError) {}
  }

  function isSafeUserFacingMessage(message) {
    var value = String(message || "").trim();
    if (!(/^[“《（(]*[\u3400-\u9fff]/.test(value) || /^Premiere\s+[\u3400-\u9fff]/.test(value))) return false;
    return !/\b(?:ERROR|FAIL(?:ED|URE)?|PERMISSION|DENIED|ACCESS|EEXIST|ENOENT|EACCES|EPERM|EIO|ENOSPC|EDQUOT|QUOTA|EXISTS?|NOT\s+FOUND|NO\s+SUCH|READ-?ONLY|SHARING\s+VIOLATION|LOCK\s+VIOLATION|DISK\s+FULL|DEVICE\s+NOT\s+READY)\b/i.test(value);
  }

  function userFacingRuntimeError(error, fallback) {
    var message = readErrorDetail(error, "message").trim();
    var code = readErrorDetail(error, "code").trim().toUpperCase();
    var description = (code + " " + message).toUpperCase();
    if (/^MATERIAL_BATCH_[A-Z0-9_]+$/.test(code) && isSafeUserFacingMessage(message)) return message;
    if (Core.isMissingPathError(error)) return "找不到需要使用的文件或文件夹，请检查磁盘是否已连接后重新检查。";
    if (/(?:EACCES|EPERM|ACCESS[_ -]*DENIED|PERMISSION[_ -]*DENIED)/.test(description)) {
      return "无法访问需要使用的文件夹，请检查磁盘连接和读写权限后重新检查。";
    }
    if (/(?:ENOSPC|NO SPACE LEFT|EDQUOT|QUOTA)/.test(description)) {
      return "工程所在磁盘空间不足，插件没有继续移动素材。请清理空间后重新检查。";
    }
    if (isSafeUserFacingMessage(message)) return message;
    return fallback || "检查当前工程时遇到问题，插件没有处理或移动任何素材。";
  }

  function rollbackWarningSuffix(error) {
    var warnings = error && Array.isArray(error.rollbackWarnings) ? error.rollbackWarnings.filter(Boolean) : [];
    if (!warnings.length) return "";
    reportRuntimeError("自动恢复未完全成功", { message: warnings.join("；") });
    return "；自动恢复没有完全完成，相关文件已保留，请检查最近记录后重新检查。";
  }

  function batchDirectoryError(nativePath, error, occupiedByFile) {
    var wrapped = new Error(occupiedByFile
      ? "素材文件夹位置被同名文件占用，插件没有移动任何素材。请移走同名文件后重新检查。"
      : "无法使用当前素材文件夹，插件没有移动任何素材。请检查工程所在磁盘是否已连接，以及文件夹是否有读写权限。");
    wrapped.name = "MaterialBatchDirectoryError";
    wrapped.code = "MATERIAL_BATCH_DIRECTORY_UNAVAILABLE";
    wrapped.directoryPath = String(nativePath || "");
    wrapped.cause = error;
    return wrapped;
  }

  function machineSettingsSaveError(error) {
    var wrapped = new Error("无法保存本机设置，名单尚未确认，请关闭面板后重试。");
    wrapped.name = "MaterialBatchMachineSettingsError";
    wrapped.code = "MATERIAL_BATCH_MACHINE_SETTINGS_SAVE_FAILED";
    wrapped.cause = error;
    wrapped.originalName = readErrorDetail(error, "name");
    wrapped.originalCode = readErrorDetail(error, "code");
    wrapped.originalErrno = readErrorDetail(error, "errno");
    wrapped.originalMessage = readErrorDetail(error, "message");
    return wrapped;
  }

  function protectionSetupErrorMessage(error, stage) {
    var message = readErrorDetail(error, "message").trim();
    var code = readErrorDetail(error, "code").trim().toUpperCase();
    if (/^MATERIAL_BATCH_[A-Z0-9_]+$/.test(code) && isSafeUserFacingMessage(message)) return message;
    var validationMessages = [
      "素材正在整理，完成后才能修改名单。",
      "请先打开并保存 Premiere 工程，才能设置这份名单。",
      "整理记录需要先恢复，暂时不能修改名单。",
      "请先重新选择所有需要连接的不搬动文件夹。",
    ];
    if (stage === "validation" && validationMessages.indexOf(message) >= 0) return message;
    if (stage === "project-state") {
      return "无法保存当前工程文件夹里的整理记录，请检查磁盘连接和访问权限后重试。";
    }
    if (stage === "machine-settings") return "无法保存本机设置，名单尚未确认，请关闭面板后重试。";
    return "无法检查当前工程和不搬动文件夹，请稍后重试。";
  }

  function protectedFolderErrorMessage(error) {
    var message = "";
    try { message = String(error && error.message || error || "").trim(); } catch (stringError) {}
    if (Core.isMissingPathError(error)) return "找不到所选文件夹，请确认磁盘已连接后重新选择。";
    var code = "";
    try { code = String(error && (error.code || error.name) || "").toUpperCase(); } catch (readError) {}
    if (code === "MATERIAL_BATCH_PROTECTED_FOLDER_OVERLAP") {
      var conflictingLabel = readErrorDetail(error, "conflictingLabel") || "已有文件夹";
      var conflictingPath = readErrorDetail(error, "conflictingPath") || "路径无法读取";
      var selectedPath = readErrorDetail(error, "selectedPath") || "路径无法读取";
      return "与已添加的不搬动文件夹“" + conflictingLabel + "”范围重叠。\n"
        + "已有路径：" + conflictingPath + "\n"
        + "本次选择：" + selectedPath;
    }
    var description = (code + " " + message).toUpperCase();
    if (/(?:EACCES|EPERM|ACCESS[_ -]*DENIED|PERMISSION[_ -]*DENIED)/.test(description)) {
      return "没有权限读取所选文件夹，请检查访问权限后重试。";
    }
    if (/(?:EBUSY|SHARING[_ -]*VIOLATION|LOCK[_ -]*VIOLATION)/.test(description)) {
      return "所选文件夹正被其他程序占用，请稍后重试。";
    }
    if (isSafeUserFacingMessage(message)) return message;
    return "无法读取所选文件夹，请检查磁盘连接和访问权限后重试。";
  }

  function protectedSettingsBlockReason() {
    if (busy) return "素材正在整理，完成后才能修改名单。";
    if (!context || !context.projectPath || !projectState) return "请先打开并保存 Premiere 工程，才能设置这份名单。";
    if (stateReloadRequired || storageWarning) return "整理记录需要先恢复，暂时不能修改名单。";
    if (projectState.pendingTransaction || projectState.pendingProjectSave) return "请先完成“检查文件和链接”，再修改不搬动文件夹。";
    return "";
  }

  function renderSettingsState(activePanelError) {
    var workspaceRoot = context && context.workspaceRoot ? Core.toFileSystemPath(context.workspaceRoot) : "";
    setText("settingsWorkspaceName", workspaceRoot ? Core.basename(workspaceRoot) || workspaceRoot : "尚未识别工程文件夹");
    setText("settingsWorkspacePath", workspaceRoot || "打开并保存工程后显示");

    var blockReason = protectedSettingsBlockReason();
    var addButton = element("addProtectedButton");
    if (addButton) addButton.disabled = Boolean(blockReason);
    var blockTarget = element("settingsBlockReason");
    if (blockTarget) {
      blockTarget.hidden = !blockReason;
      blockTarget.textContent = blockReason;
    }
    var finishButton = element("finishProtectionButton");
    if (finishButton) {
      var libraries = projectState && Array.isArray(projectState.protectedLibraries) ? projectState.protectedLibraries : [];
      var unresolved = unresolvedProtectedLibraries();
      finishButton.hidden = currentProtectionSetup();
      finishButton.disabled = Boolean(blockReason) || unresolved.length > 0;
      finishButton.textContent = unresolved.length
        ? "先重新选择上面的文件夹"
        : libraries.length
          ? "名单设置好了，继续"
          : "没有需要不搬动的文件夹，继续";
    }

    var message = settingsMessage;
    var kind = settingsMessageKind;
    if (!message && !projectState && activePanelError) {
      message = activePanelError;
      kind = "error";
    }
    var messageTarget = element("settingsMessage");
    if (messageTarget) {
      messageTarget.hidden = !message;
      messageTarget.textContent = message;
      messageTarget.dataset.kind = kind || "info";
    }
    var saveStatus = element("settingsSaveStatus");
    if (saveStatus) {
      var saved = kind === "success";
      saveStatus.textContent = saved ? "已保存" : "自动保存";
      saveStatus.dataset.saved = saved ? "true" : "false";
    }
  }

  function defaultMachineSettings() {
    return {
      schemaVersion: MACHINE_SETTINGS_SCHEMA_VERSION,
      autoByProject: {},
      projectSetupByProject: {},
      protectedRevisionByProject: {},
      protectedMappings: [],
    };
  }

  function sanitizedProtectedMappings(raw) {
    return Array.isArray(raw && raw.protectedMappings)
      ? raw.protectedMappings.filter(function (mapping) {
          return mapping && mapping.libraryId && mapping.rootPath;
        }).map(function (mapping) {
          return {
            libraryId: String(mapping.libraryId),
            label: String(mapping.label || "共享素材库"),
            rootPath: Core.toFileSystemPath(mapping.rootPath),
          };
        })
      : [];
  }

  function booleanSettingsMap(value) {
    var result = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return result;
    Object.keys(value).forEach(function (key) {
      if (value[key] === true) result[String(key)] = true;
      else if (value[key] === false) result[String(key)] = false;
    });
    return result;
  }

  function revisionSettingsMap(value) {
    var result = {};
    if (!value || typeof value !== "object" || Array.isArray(value)) return result;
    Object.keys(value).forEach(function (key) {
      var revision = Number(value[key]);
      if (Number.isFinite(revision) && revision >= 1 && Math.floor(revision) === revision) {
        result[String(key)] = revision;
      }
    });
    return result;
  }

  function loadMachineSettings() {
    var defaults = defaultMachineSettings();
    try {
      var raw = JSON.parse(localStorage.getItem(MACHINE_SETTINGS_KEY) || "null");
      if (raw && typeof raw === "object" && raw.schemaVersion === MACHINE_SETTINGS_SCHEMA_VERSION) {
        return {
          schemaVersion: MACHINE_SETTINGS_SCHEMA_VERSION,
          autoByProject: booleanSettingsMap(raw.autoByProject),
          projectSetupByProject: booleanSettingsMap(raw.projectSetupByProject),
          protectedRevisionByProject: revisionSettingsMap(raw.protectedRevisionByProject),
          protectedMappings: sanitizedProtectedMappings(raw),
        };
      }
      if (raw && typeof raw === "object") defaults.protectedMappings = sanitizedProtectedMappings(raw);
    } catch (error) {}

    // v1 只迁移本机文件夹路径。旧版的开启、工程确认和保护确认都不能成为新版授权。
    try {
      var legacy = JSON.parse(localStorage.getItem(LEGACY_MACHINE_SETTINGS_KEY) || "null");
      if (!defaults.protectedMappings.length) defaults.protectedMappings = sanitizedProtectedMappings(legacy);
    } catch (legacyError) {}
    return defaults;
  }

  function saveMachineSettings() {
    try {
      localStorage.setItem(MACHINE_SETTINGS_KEY, JSON.stringify(machineSettings));
    } catch (error) {
      throw machineSettingsSaveError(error);
    }
  }

  function currentProjectSettingKey() {
    return context && context.workspaceRoot ? "workspace:" + State.projectKey(context.workspaceRoot) : "";
  }

  function currentProjectSetup() {
    var key = currentProjectSettingKey();
    return Boolean(projectState && key && machineSettings.projectSetupByProject[key] === true);
  }

  function currentAutoSetting() {
    var key = currentProjectSettingKey();
    return Boolean(key && currentProjectSetup() && machineSettings.autoByProject[key] === true);
  }

  function currentProtectionSetup() {
    var key = currentProjectSettingKey();
    var revision = Math.max(1, Math.floor(Number(projectState && projectState.protectedConfigRevision) || 1));
    return Boolean(projectState && key && machineSettings.protectedRevisionByProject[key] === revision);
  }

  function setMachineSettings(values) {
    if (!projectState) return;
    // 所有设置写入都先合并最新本机值；同一宿主内没有异步间隙，避免另一个面板的工程开关被旧快照覆盖。
    machineSettings = loadMachineSettings();
    var changes = [];
    Object.keys(values || {}).forEach(function (name) {
      var target = name === "auto"
        ? machineSettings.autoByProject
        : name === "projectSetup"
          ? machineSettings.projectSetupByProject
        : name === "protection"
          ? machineSettings.protectedRevisionByProject
          : null;
      var key = currentProjectSettingKey();
      if (!target || !key) return;
      var desired = name === "protection"
        ? (values[name] === true ? Math.max(1, Math.floor(Number(projectState.protectedConfigRevision) || 1)) : null)
        : values[name] === true;
      var hadPrevious = Object.prototype.hasOwnProperty.call(target, key);
      if ((!hadPrevious && (desired === false || desired === null)) || (hadPrevious && target[key] === desired)) return;
      changes.push({
        target: target,
        key: key,
        hadPrevious: hadPrevious,
        previous: target[key],
      });
      if (desired === null) delete target[key];
      else target[key] = desired;
    });
    if (!changes.length) return;
    try {
      saveMachineSettings();
    } catch (error) {
      changes.forEach(function (change) {
        if (change.hadPrevious) change.target[change.key] = change.previous;
        else delete change.target[change.key];
      });
      throw error;
    }
  }

  function setMachineSetting(name, value) {
    var values = {};
    values[name] = value;
    setMachineSettings(values);
  }

  function pauseAutomaticBestEffort() {
    try {
      setMachineSetting("auto", false);
    } catch (settingsError) {
      reportRuntimeError("暂停自动整理的本机设置保存失败", settingsError);
    }
    try {
      stopMonitor(false);
    } catch (monitorError) {
      reportRuntimeError("停止自动整理监控失败", monitorError);
    }
  }

  function pauseWorkspaceProjectsInMemory() {
    if (!context || !context.workspaceRoot) return false;
    var changed = false;
    Object.keys(machineSettings.autoByProject).forEach(function (projectPath) {
      if (machineSettings.autoByProject[projectPath] !== true) return;
      if (projectPath !== currentProjectSettingKey() && !Core.samePath(Core.workspaceRootForProject(projectPath), context.workspaceRoot)) return;
      machineSettings.autoByProject[projectPath] = false;
      changed = true;
    });
    Object.keys(machineSettings.protectedRevisionByProject).forEach(function (projectPath) {
      if (projectPath !== currentProjectSettingKey() && !Core.samePath(Core.workspaceRootForProject(projectPath), context.workspaceRoot)) return;
      delete machineSettings.protectedRevisionByProject[projectPath];
      changed = true;
    });
    return changed;
  }

  function pauseWorkspaceProjects() {
    var previousAuto = JSON.parse(JSON.stringify(machineSettings.autoByProject));
    var previousProtection = JSON.parse(JSON.stringify(machineSettings.protectedRevisionByProject));
    if (!pauseWorkspaceProjectsInMemory()) return;
    try {
      saveMachineSettings();
    } catch (error) {
      machineSettings.autoByProject = previousAuto;
      machineSettings.protectedRevisionByProject = previousProtection;
      throw error;
    }
  }

  function workspaceProtectedMappings() {
    return protectedMappingValidation.validMappings.slice();
  }

  function unresolvedProtectedLibraries() {
    return protectedMappingValidation.unresolved.slice();
  }

  async function refreshProtectedMappingStatus() {
    if (!projectState || !context || !context.workspaceRoot) {
      protectedMappingValidation = { validMappings: [], unresolved: [], statusById: {} };
      return protectedMappingValidation;
    }
    protectedMappingValidation = await ScanPolicy.validateProtectedMappings(
      fs,
      projectState.protectedLibraries,
      machineSettings.protectedMappings,
      { mediaRoot: mediaRoot(), workspaceRoot: context.workspaceRoot }
    );
    return protectedMappingValidation;
  }

  function formatBytes(value) {
    var bytes = Math.max(0, Number(value) || 0);
    if (!bytes) return "0 B";
    var units = ["B", "KB", "MB", "GB", "TB"];
    var index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    var number = bytes / Math.pow(1024, index);
    return number.toFixed(index === 0 || number >= 100 ? 0 : number >= 10 ? 1 : 2) + " " + units[index];
  }

  function outsideMediaSummary() {
    var summary = "工程内素材保持原位；";
    if (!outsideMediaCount) return summary + "暂未发现需要处理的工程外素材。";
    summary += "工程外 " + outsideMediaCount + " 个 · " + formatBytes(outsideMediaBytes);
    summary += outsideReviewCount
      ? "，其中 " + outsideCollectCount + " 个待整理、" + outsideReviewCount + " 个需确认。"
      : " 待整理。";
    if (outsideUnreadableCount > 0) summary += "其中 " + outsideUnreadableCount + " 个大小暂时无法读取。";
    return summary;
  }

  function relativeBatchPath() {
    if (!projectState) return "素材";
    return relativePathForContext(projectState.mediaFolderName, State.currentBatch(projectState).name);
  }

  function relativePathForContext() {
    var anchorPath = context && (context.workspaceRoot || context.projectPath) || "";
    var separator = Core.isWindowsPath(anchorPath) ? "\\" : "/";
    return Array.prototype.slice.call(arguments).filter(function (part) {
      return String(part || "").length > 0;
    }).map(function (part) {
      return String(part).replace(/^[\\/]+|[\\/]+$/g, "");
    }).join(separator);
  }

  function batchPath() {
    return context && projectState ? State.currentBatchPath(projectState, context.workspaceRoot) : "";
  }

  function mediaRoot() {
    return context && projectState ? Core.joinNativePath(context.workspaceRoot, projectState.mediaFolderName) : "";
  }

  function currentRecoveryRecord() {
    if (backgroundOperation) return null;
    if (!projectState) return null;
    return projectState.pendingTransaction || projectState.pendingProjectSave || null;
  }

  function recoveryTargetPath(record) {
    if (!record) return "";
    var storedTarget = String(record.targetPath || "");
    if (storedTarget && Core.isAbsoluteLocalPath(storedTarget) && Core.isPathInside(storedTarget, mediaRoot())) {
      return storedTarget;
    }
    try { return targetPathForMapping(record); } catch (error) { return ""; }
  }

  function matchingRecoverySnapshot(record) {
    return record && recoverySnapshot && String(recoverySnapshot.id || "") === String(record.id || "")
      ? recoverySnapshot
      : null;
  }

  function recoverySourcePath(record, snapshot) {
    var cleanupPath = snapshot && snapshot.cleanupExists === true ? String(snapshot.cleanupPath || "") : "";
    if (cleanupPath && Core.isAbsoluteLocalPath(cleanupPath)) return cleanupPath;
    var sourcePath = String(record && record.sourcePath || "");
    return Core.isAbsoluteLocalPath(sourcePath) ? sourcePath : "";
  }

  function canCloseLegacyRecoveryRecord(record, snapshot) {
    if (!record || !snapshot || !projectState || record !== projectState.pendingTransaction) return false;
    if (String(snapshot.id || "") !== String(record.id || "")
      || snapshot.kind !== "manual"
      || snapshot.manualCode !== "missing-target-checkpoint") return false;
    if (snapshot.sourceExists !== true
      || snapshot.targetExists !== true
      || snapshot.stagingExists !== false
      || snapshot.cleanupExists !== false
      || snapshot.sourceChanged !== false
      || snapshot.currentLinkState !== "source") return false;
    if (Transaction.hasStrongFileIdentity(record.targetFingerprint)
      || !Transaction.hasStrongFileIdentity(record.sourceFingerprint)
      || !Transaction.hasStrongFileIdentity(snapshot.sourceFingerprint)
      || !Transaction.hasStrongFileIdentity(snapshot.targetFingerprint)
      || !Transaction.sameStrongPathFingerprint(record.sourceFingerprint, snapshot.sourceFingerprint)) return false;
    var expectedBytes = Number(record.byteCount);
    return Number.isFinite(expectedBytes)
      && expectedBytes >= 0
      && Number(snapshot.sourceSize) === expectedBytes
      && Number(snapshot.targetSize) === expectedBytes;
  }

  function storedRecoveryError(record) {
    var message = readErrorDetail(record, "error").trim();
    if (message.indexOf("最近记录") !== -1) {
      return "上次整理中断，自动整理已暂停。请点击下方“检查文件和链接”，核对两处文件及 Premiere 当前引用的位置。";
    }
    return isSafeUserFacingMessage(message) ? message : "";
  }

  function legacyBatchFolderNameForTarget(targetPath) {
    if (!targetPath) return "";
    var folderName = Core.basename(Core.dirname(targetPath));
    return /^\d{3}_/.test(String(folderName || "")) ? folderName : "";
  }

  function recoverySourceBlockReason(sourcePath) {
    var classification = Core.classifyMediaPath(sourcePath, {
      mediaRoot: mediaRoot(),
      workspaceRoot: context && context.workspaceRoot,
      protectedRoots: workspaceProtectedMappings(),
    });
    if (classification.kind === "collect") return "";
    if (classification.kind === "managed") return "记录中的原位置属于当前工程文件夹，按当前规则必须保持原位；未继续旧事务。";
    if (classification.kind === "protected") return "记录中的原位置属于“不搬动文件夹”，按当前规则必须保持原位；未继续旧事务。";
    if (classification.kind === "ignored") return "记录中的文件是 Premiere 工程文件，绝不会移动、删除或补链。";
    if (classification.kind === "review") return "记录中的素材现在需要人工处理，未继续旧事务。";
    return "记录中的原位置无法按当前规则安全处理，未继续旧事务。";
  }

  function renderRecoveryDetails() {
    var record = currentRecoveryRecord();
    var details = element("recoveryDetails");
    var locationActions = element("recoveryLocationActions");
    var sourceOpenButton = element("openRecoverySourceButton");
    var openButton = element("openRecoveryTargetButton");
    var closeButton = element("closeRecoveryRecordButton");
    var targetPath = recoveryTargetPath(record);
    var snapshot = matchingRecoverySnapshot(record);
    var sourcePath = recoverySourcePath(record, snapshot);
    var canClose = canCloseLegacyRecoveryRecord(record, snapshot);
    var verifyButton = element("verifyRecoveryButton");
    if (verifyButton) { verifyButton.hidden = !record || !snapshot || snapshot.kind !== "manual" || !snapshot.sourceExists || !snapshot.targetExists; verifyButton.disabled = busy; }
    var cancelButton = element("cancelRecoveryButton");
    if (cancelButton) cancelButton.hidden = busyStage !== "verify-content";
    var deferButton = element("deferRecoveryButton");
    if (deferButton) {
      deferButton.hidden = !record || canClose || Boolean(projectState && projectState.pendingProjectSave);
      deferButton.disabled = busy;
      deferButton.textContent = record && record.recycleRequest && !record.recycleReceipt
        ? "核对回收状态后暂缓" : "暂缓此素材，处理其他素材";
    }
    if (details) details.hidden = !record;
    if (locationActions) locationActions.hidden = !record;
    if (sourceOpenButton) {
      sourceOpenButton.hidden = !record;
      sourceOpenButton.disabled = !sourcePath || busy;
    }
    if (openButton) {
      openButton.hidden = !record;
      openButton.disabled = !targetPath || busy;
    }
    if (closeButton) {
      closeButton.hidden = !canClose;
      closeButton.disabled = !canClose || busy;
    }
    if (!record) return;

    var recoveryBytes = snapshot && (snapshot.targetSize || snapshot.sourceSize)
      || record.byteCount
      || record.targetFingerprint && record.targetFingerprint.size
      || 0;
    setText("recoveryFilename", Core.basename(record.sourcePath || targetPath) || "待核对素材");
    setText("recoverySize", formatBytes(recoveryBytes));
    setText("recoverySourceLabel", snapshot && snapshot.cleanupExists === true ? "待处理原素材位置" : "原位置");
    setText("recoverySourcePath", sourcePath || "记录中没有可用的原素材位置");
    setText("recoveryTargetPath", targetPath || "记录中的新位置无效");
    var sourceStatus = "等待核对";
    if (snapshot) {
      sourceStatus = snapshot.cleanupExists === true
        ? "待清理文件存在 · " + formatBytes(snapshot.sourceSize || record.byteCount)
        : snapshot.sourceExists === true
          ? "存在" + (typeof snapshot.sourceSize === "number" ? " · " + formatBytes(snapshot.sourceSize) : " · 大小未确认")
          : snapshot.sourceExists === false ? "原位置未找到" : "无法确认";
    }
    var targetStatus = !snapshot
      ? "等待核对"
      : snapshot.targetExists === true
        ? "存在" + (typeof snapshot.targetSize === "number" ? " · " + formatBytes(snapshot.targetSize) : " · 大小未确认")
        : snapshot.targetExists === false ? "未找到" : "无法确认";
    setText("recoverySourceStatus", sourceStatus);
    setText("recoveryTargetStatus", targetStatus);
    var linkStatus = "等待核对";
    if (snapshot) {
      linkStatus = snapshot.currentLinkState === "source"
        ? "仍在原位置"
        : snapshot.currentLinkState === "target"
          ? "已在新位置"
          : snapshot.currentLinkState === "mixed"
            ? "部分在新位置"
            : "无法唯一确认";
    }
    setText("recoveryLinkStatus", linkStatus);
    var confirmation = recoveryMessage
      || storedRecoveryError(record)
      || "本次核对不会删除任何磁盘文件；真正更新 Premiere 链接、保存工程或清理原位置前，都会再次确认。";
    var legacyFolderName = legacyBatchFolderNameForTarget(targetPath);
    if (legacyFolderName) {
      confirmation += " “" + legacyFolderName + "”是旧版已经创建的文件夹，本次不会改名。";
    }
    if (canClose) {
      confirmation += " 两处文件都已保留，Premiere 仍指向原位置；可完整核验后继续，也可暂缓并保留记录。";
    }
    setText("recoveryConfirmation", confirmation);
  }

  function renderActivity() {
    var list = element("activityList");
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    var activity = projectState && Array.isArray(projectState.activity) ? projectState.activity.slice(-4).reverse() : [];
    if (!activity.length) {
      var empty = document.createElement("div");
      empty.className = "activity-item";
      empty.setAttribute("role", "listitem");
      var bullet = document.createElement("span");
      bullet.className = "activity-bullet";
      var copy = document.createElement("div");
      var title = document.createElement("strong");
      title.textContent = context ? "等待开启自动整理" : "等待 Premiere 工程";
      var detail = document.createElement("small");
      detail.textContent = context ? "尚未移动；开启后才会整理工程外素材" : "打开并保存工程后再重新检查";
      copy.appendChild(title);
      copy.appendChild(detail);
      empty.appendChild(bullet);
      empty.appendChild(copy);
      list.appendChild(empty);
      return;
    }
    activity.forEach(function (entry) {
      var row = document.createElement("div");
      row.className = "activity-item";
      row.setAttribute("role", "listitem");
      var bullet = document.createElement("span");
      bullet.className = "activity-bullet " + (entry.level === "ok" ? "success" : entry.level === "error" ? "danger" : entry.level === "warn" ? "warning" : "");
      var copy = document.createElement("div");
      var title = document.createElement("strong");
      title.textContent = entry.message;
      var detail = document.createElement("small");
      var when = new Date(entry.at);
      var time = Number.isNaN(when.getTime()) ? "" : when.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
      detail.textContent = time + (entry.details && entry.details.summary ? " · " + entry.details.summary : "");
      if (entry.details && entry.details.summary) detail.title = entry.details.summary;
      copy.appendChild(title);
      copy.appendChild(detail);
      row.appendChild(bullet);
      row.appendChild(copy);
      list.appendChild(row);
    });
  }

  function makeReviewId(kind, sourcePath, targetPath) {
    return Core.makeMediaSpaceId(
      String(kind || "review") + "|" + String(sourcePath || "") + "|" + String(targetPath || ""),
      "review-v1"
    ).replace(/^media-/, "review-");
  }

  function addReviewItem(item) {
    var next = Object.assign({}, item);
    next.id = next.id || makeReviewId(next.kind, next.sourcePath, next.targetPath);
    if (!reviewItems.some(function (candidate) { return candidate.id === next.id; })) reviewItems.push(next);
    reviewCount = reviewItems.length;
    return next;
  }

  function renderReviewItems() {
    // Deferred history stays in the journal, not in the current action queue.
    var section = element("reviewSection");
    var list = element("reviewList");
    if (!section || !list) return;
    section.hidden = Boolean(currentRecoveryRecord()) || reviewItems.length === 0;
    setText("reviewCountLabel", reviewItems.length + " 项");
    while (list.firstChild) list.removeChild(list.firstChild);

    reviewItems.forEach(function (review) {
      var row = document.createElement("div");
      row.className = "review-item";
      row.setAttribute("role", "listitem");
      row.dataset.reviewKind = review.kind || "review";

      var type = document.createElement("span");
      type.className = "review-type";
      type.textContent = review.type || "需要确认";
      var filename = document.createElement("strong");
      filename.className = "review-filename";
      filename.textContent = review.filename || Core.basename(review.sourcePath) || "未命名素材";
      var sourceLabel = document.createElement("span");
      sourceLabel.className = "review-path-label";
      sourceLabel.textContent = "原位置";
      var source = document.createElement("code");
      source.className = "review-path";
      source.textContent = review.sourcePath || "无法读取";
      row.appendChild(type);
      row.appendChild(filename);
      row.appendChild(sourceLabel);
      row.appendChild(source);

      if (review.targetPath) {
        var targetLabel = document.createElement("span");
        targetLabel.className = "review-path-label";
        targetLabel.textContent = "记录的新位置";
        var target = document.createElement("code");
        target.className = "review-path";
        target.textContent = review.targetPath;
        row.appendChild(targetLabel);
        row.appendChild(target);
      }

      var reason = document.createElement("p");
      reason.className = "review-reason";
      reason.textContent = review.reason || "插件无法安全地自动处理这个素材。";
      row.appendChild(reason);
      if (review.note) {
        var note = document.createElement("p");
        note.className = "review-note";
        note.textContent = review.note;
        row.appendChild(note);
      }

      var actions = document.createElement("div");
      actions.className = "review-actions";
      (review.actions || []).forEach(function (actionSpec) {
        var button = document.createElement("button");
        button.className = "button button-" + (actionSpec[2] === "primary" ? "primary" : "secondary") + " review-action";
        button.type = "button";
        button.dataset.reviewAction = actionSpec[0];
        button.dataset.reviewId = review.id;
        button.textContent = actionSpec[1];
        button.disabled = busy;
        actions.appendChild(button);
      });
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  function renderProtectedLibraries() {
    var libraries = projectState && Array.isArray(projectState.protectedLibraries) ? projectState.protectedLibraries : [];
    setText("protectedListCount", libraries.length + " 个");
    setText("protectedCountText", libraries.length + " 个");

    var list = element("protectedList");
    if (!list) return;
    var rows = [];
    try {
      if (!libraries.length) {
        var empty = document.createElement("div");
        empty.className = "protected-empty";
        empty.setAttribute("role", "listitem");
        var emptyLabel = document.createElement("strong");
        emptyLabel.textContent = "还没有添加文件夹";
        var emptyHint = document.createElement("span");
        emptyHint.textContent = "后期包、共享音效库等长期素材可以加在这里。";
        empty.appendChild(emptyLabel);
        empty.appendChild(emptyHint);
        rows.push(empty);
      }

      var statusMap = protectedMappingValidation && protectedMappingValidation.statusById
        ? protectedMappingValidation.statusById
        : {};
      libraries.forEach(function (library) {
        var status = statusMap[library.libraryId] || { valid: false, mapping: null, reason: "尚未检查这个文件夹" };
        var mapping = status.mapping;
        var row = document.createElement("div");
        row.className = "protected-item";
        row.setAttribute("role", "listitem");
        row.setAttribute("data-connection-state", status.valid ? "connected" : "unresolved");

        var heading = document.createElement("div");
        heading.className = "protected-item-heading";
        var label = document.createElement("strong");
        label.textContent = library.label || "未命名文件夹";
        var statusLabel = document.createElement("span");
        statusLabel.className = "protected-status";
        statusLabel.textContent = status.valid ? "可正常使用" : "需要重新选择";
        heading.appendChild(label);
        heading.appendChild(statusLabel);
        row.appendChild(heading);

        var pathLabel = document.createElement("span");
        pathLabel.className = "protected-path-label";
        pathLabel.textContent = "磁盘位置";
        row.appendChild(pathLabel);
        if (mapping && mapping.rootPath) {
          var path = document.createElement("div");
          path.className = "protected-path";
          path.textContent = mapping.rootPath;
          row.appendChild(path);
        } else {
          var missing = document.createElement("p");
          missing.className = "protected-reason";
          missing.textContent = "这台电脑还没有选择这个文件夹";
          row.appendChild(missing);
        }
        if (!status.valid && status.reason) {
          var detail = document.createElement("p");
          detail.className = "protected-detail";
          detail.textContent = status.reason;
          row.appendChild(detail);
        }

        var actions = document.createElement("div");
        actions.className = "protected-actions";
        var mapAction = document.createElement("button");
        mapAction.className = "button button-secondary";
        mapAction.type = "button";
        mapAction.setAttribute("data-library-id", library.libraryId);
        mapAction.setAttribute("data-action", "map");
        mapAction.textContent = status.valid ? "更换文件夹" : "选择本机文件夹";
        mapAction.disabled = Boolean(protectedSettingsBlockReason());
        var removeAction = document.createElement("button");
        removeAction.className = "button button-quiet";
        removeAction.type = "button";
        removeAction.setAttribute("data-library-id", library.libraryId);
        removeAction.setAttribute("data-action", "remove");
        removeAction.textContent = "从名单移除";
        removeAction.disabled = Boolean(protectedSettingsBlockReason());
        actions.appendChild(mapAction);
        actions.appendChild(removeAction);
        row.appendChild(actions);
        rows.push(row);
      });

      while (list.firstChild) list.removeChild(list.firstChild);
      rows.forEach(function (row) { list.appendChild(row); });
    } catch (error) {
      reportRuntimeError("显示不搬动文件夹失败", error);
      list.textContent = "暂时无法显示不搬动文件夹，请返回整理界面后再打开这里。";
    }
  }

  function render() {
    if (silentScan && !panelError && !storageWarning) return;
    var root = element("panelRoot");
    var body = document.body;
    var activePanelError = panelError || storageWarning;
    var view = {
      mode: "empty",
      kind: "empty",
      title: "请先打开 Premiere 工程",
      description: "打开工程后，插件才能找到需要整理的素材。",
      status: "等待工程",
      action: "重新检查",
      icon: "folder",
    };

    if (context && !context.projectPath) {
      view = { mode: "unsaved", kind: "warning", title: "请先保存工程", description: "保存后，插件才能在工程旁边建立素材文件夹。", status: "等待保存", action: "重新检查", icon: "alert" };
    } else if (context && context.projectPath && !projectState && activePanelError) {
      view = { mode: "failure", kind: "danger", title: "自动整理已暂停", description: activePanelError, status: "已暂停", action: "重新检查", icon: "alert" };
    } else if (context && projectState) {
      var unresolved = unresolvedProtectedLibraries();
      var persistedRecoveryError = storedRecoveryError(currentRecoveryRecord());
      if (projectState.pendingTransaction && !backgroundOperation) {
        var cleanupRequired = projectState.pendingTransaction.status === "cleanup-pending";
        var pendingFilename = Core.basename(projectState.pendingTransaction.sourcePath || recoveryTargetPath(projectState.pendingTransaction)) || "这个文件";
        view = cleanupRequired
          ? { mode: "failure", kind: "danger", title: "原位置还没有清理", description: persistedRecoveryError || "先检查“" + pendingFilename + "”的两处位置和 Premiere 链接。检查本身不会删除文件。", status: "整理已暂停", action: "检查文件和链接", icon: "alert" }
          : { mode: "failure", kind: "danger", title: "上次整理未完成", description: persistedRecoveryError || "先检查“" + pendingFilename + "”的原位置、新位置和 Premiere 链接。检查本身不会移动或删除文件。", status: "整理已暂停", action: "检查文件和链接", icon: "alert" };
      } else if (projectState.pendingProjectSave) {
        view = { mode: "failure", kind: "danger", title: "Premiere 工程保存尚未确认", description: persistedRecoveryError || "先检查素材的新位置和 Premiere 链接。检查本身不会删除文件。", status: "整理已暂停", action: "检查文件和链接", icon: "alert" };
      } else if (activePanelError) {
        view = { mode: "failure", kind: "danger", title: "自动整理已暂停", description: activePanelError, status: "已暂停", action: "重新检查", icon: "alert" };
      } else if (busy) {
        var stageText = {
          scan: "正在检查工程素材",
          move: "正在移动素材",
          copy: "正在跨盘复制素材",
          relink: "正在更新 Premiere 链接",
          save: "正在保存 Premiere 工程",
          cleanup: "正在将原文件送入系统回收站",
          handoff: "正在建立下一个交接文件夹",
        };
        view = { mode: busyStage === "scan" ? "running" : "moving", kind: busyStage === "scan" ? "running" : "moving", title: stageText[busyStage] || "正在整理素材", description: "确认新位置可用、Premiere 已重新链接并保存后，才会删除原文件。", status: busyStage === "scan" ? "检查中" : "移动中", action: "", icon: "refresh" };
      } else if (!currentProtectionSetup()) {
        view = { mode: "setup", kind: "onboarding", title: "先设置不搬动文件夹", description: "后期包、共享音效库等要保持原位的文件夹，请先加入名单。没有也可以直接继续。", status: "尚未设置", action: "设置不搬动文件夹", icon: "shield" };
      } else if (unresolved.length) {
        view = { mode: "conflict", kind: "danger", title: "有共享文件夹需要重新选择", description: "“" + unresolved[0].label + "”在这台电脑上的位置还没选。", status: "需要处理", action: "选择文件夹", icon: "alert" };
      } else if (!currentProjectSetup() || !projectState.initialized) {
        view = { mode: "activate", kind: "onboarding", title: "当前工程尚未开启", description: outsideMediaSummary(), status: "等待开启", action: "开始整理此工程", icon: "check" };
      } else if (State.needsCollectionPolicyAcceptance(projectState)) {
        view = { mode: "policy", kind: "onboarding", title: "此工程需要重新确认", description: outsideMediaSummary(), status: "等待确认", action: "开始整理此工程", icon: "check" };
      } else if (reviewCount > 0) {
        view = { mode: "conflict", kind: "danger", title: "有 " + reviewCount + " 个素材需要人工处理", description: "这些文件还在原位置，请按每项提示处理后继续。", status: "需要处理", action: "查看需处理素材", icon: "alert" };
      } else if (!currentAutoSetting()) {
        view = { mode: "paused", kind: "warning", title: "此工程的自动整理已暂停", description: outsideMediaSummary(), status: "已暂停", action: "继续自动整理", icon: "pause" };
      } else if (pendingCount > 0) {
        view = { mode: "waiting", kind: "warning", title: "正在等待 " + pendingCount + " 个文件写完", description: "文件仍在下载或写入，暂时留在原位置；稳定后会自动整理。", status: "等待写完", action: "", icon: "refresh" };
      } else if (lastProtectedCount > 0) {
        view = { mode: "protected", kind: "protected", title: "共享素材已留在原位", description: lastProtectedCount + " 个素材来自“不搬动文件夹”，其余素材照常整理。", status: "自动整理中", action: "查看不搬动文件夹", icon: "shield" };
      } else {
        view = { mode: "ready", kind: "ready", title: "此工程的自动整理已开启", description: "工程文件夹内的素材保持原位；以后新增的工程外普通素材会进入当前素材文件夹。", status: "自动整理中", action: "", icon: "check" };
      }
    }

    if (busy && !backgroundOperation && projectState && (projectState.pendingTransaction || projectState.pendingProjectSave)) {
      var recoveryStageTitles = { scan: "正在检查文件和链接", "verify-content": "正在完整核验素材内容", relink: "正在更新 Premiere 链接", save: "正在保存 Premiere 工程", cleanup: "正在将原文件送入系统回收站" };
      view.title = recoveryStageTitles[busyStage] || "正在继续上次整理";
      view.status = "处理中";
      view.action = "";
    }
    var onboardingStage = "complete";
    if (context && context.projectPath && projectState && !projectState.pendingTransaction && !projectState.pendingProjectSave && !activePanelError) {
      if (!currentProtectionSetup()) onboardingStage = "protection";
      else if (!currentProjectSetup() || !projectState.initialized || State.needsCollectionPolicyAcceptance(projectState)) onboardingStage = "auto";
    }
    var recoveryRecord = currentRecoveryRecord();
    if (!busy && recoveryRecord && recoveryRecord.projectPath && context && !Core.samePath(recoveryRecord.projectPath, context.projectPath)) {
      view.title = "这条记录属于另一个工程";
      view.description = "所属工程：" + recoveryRecord.projectPath + "。当前工程不会替它保存或回收素材。";
      view.action = "找到原工程";
    }
    var signature = JSON.stringify({ view: view, busy: busy, openingFolder: openingFolder,
      project: context && [context.projectPath, context.projectName, context.identity],
      batch: projectState && State.currentBatch(projectState), auto: currentAutoSetting(),
      protection: currentProtectionSetup(), setup: currentProjectSetup(), onboarding: onboardingStage,
      recovery: recoveryRecord, snapshot: recoverySnapshot, recoveryMessage: recoveryMessage,
      folderMessage: folderActionMessage, settingsMessage: settingsMessage, settingsKind: settingsMessageKind,
      mappings: protectedMappingValidation, libraries: projectState && projectState.protectedLibraries,
      reviews: reviewItems, waiting: projectState && (projectState.deferredTransactions || []).map(function (item) {
        return [item.sourcePath, item.backgroundTask && item.backgroundTask.kind, item.backgroundTask && item.backgroundTask.message];
      }),
      activity: projectState && projectState.activity && projectState.activity.slice(-4),
      counts: [pendingCount, reviewCount, lastProtectedCount, outsideMediaCount, outsideCollectCount,
        outsideReviewCount, outsideMediaBytes, outsideUnreadableCount], storageWarning: storageWarning,
    });
    if (signature === renderSignature) return;
    renderSignature = signature;
    body.dataset.state = view.mode;
    body.dataset.onboarding = onboardingStage;
    body.dataset.recovery = recoveryRecord ? "true" : "false";
    ["autoCollectControl", "batchSection", "actionSection", "protectedCount", "activityDetails", "reviewSection"].forEach(function (id) {
      var section = element(id);
      if (section) section.hidden = Boolean(recoveryRecord);
    });
    if (recoveryRecord) {
      var settingsPage = element("settingsPage");
      if (settingsPage && !settingsPage.hidden) {
        settingsPage.hidden = true;
        settingsPage.setAttribute("aria-hidden", "true");
        if (root) root.hidden = false;
        var settingsButton = element("protectedCount");
        if (settingsButton) settingsButton.setAttribute("aria-expanded", "false");
      }
    }
    if (root) {
      root.dataset.runtimeState = view.mode;
      root.setAttribute("aria-busy", busy ? "true" : "false");
    }
    var strip = element("stateStrip");
    if (strip) {
      strip.dataset.kind = view.kind;
    }
    setText("stateTitle", view.title);
    setText("stateDescription", view.description);
    setText("batchStatus", view.status);
    var backgroundStatus = element("backgroundStatus");
    if (backgroundStatus) {
      var waitingItems = (projectState && projectState.deferredTransactions || []).filter(function (item) { return Boolean(item.backgroundTask); });
      var waitingCount = waitingItems.filter(function (item) { return item.backgroundTask.kind === "cleanup"; }).length;
      var heldCount = waitingItems.length - waitingCount;
      var parts = [];
      if (waitingCount) parts.push(waitingCount + (currentAutoSetting() ? " 项等待原件释放" : " 项等待继续整理"));
      if (heldCount) parts.push(heldCount + " 项暂时保留");
      backgroundStatus.hidden = Boolean(recoveryRecord) || !parts.length;
      backgroundStatus.textContent = parts.join("，") + (waitingItems.length ? "：" + Core.basename(waitingItems[0].sourcePath) : "");
      backgroundStatus.title = waitingItems.map(function (item) { return item.sourcePath + "：" + item.backgroundTask.message; }).join("\n");
    }

    var action = element("stateAction");
    if (action) {
      action.hidden = !view.action;
      action.textContent = view.action;
      action.dataset.intent = view.action;
      if (recoveryRecord && typeof action.removeAttribute === "function") action.removeAttribute("aria-controls");
      else if (!recoveryRecord && typeof action.setAttribute === "function") action.setAttribute("aria-controls", "settingsPage");
    }

    setText("projectName", context ? context.projectName : "未连接工程");
    setText("projectPath", context ? (context.projectPath || "尚未保存到磁盘") : "尚未读取工程目录");
    setText("projectMeta", context && context.projectPath
      ? projectState && projectState.pendingProjectSave ? "等待重新保存" : "工程路径已识别"
      : context ? "尚未保存" : "等待连接");
    var projectName = element("projectName");
    if (projectName) projectName.title = context ? (context.projectPath || context.projectName || "") : "";

    var batch = projectState && !recoveryRecord ? State.currentBatch(projectState) : null;
    setText("batchName", batch ? batch.name : "等待工程");
    var batchHeading = element("batchHeading");
    if (batchHeading) batchHeading.setAttribute("aria-label", batch ? "当前素材文件夹：" + relativeBatchPath() : "等待工程");
    var batchLegacyNote = element("batchLegacyNote");
    if (batchLegacyNote) {
      var legacyBatchName = batch && /^\d{3}_/.test(String(batch.name || "")) ? String(batch.name) : "";
      batchLegacyNote.hidden = !legacyBatchName;
      batchLegacyNote.textContent = legacyBatchName
        ? "“" + legacyBatchName + "”是旧版已经创建的文件夹，本次不会改名。"
        : "";
    }
    setText("fileCount", batch ? batch.fileCount : 0);
    setText("fileSize", batch ? formatBytes(batch.byteCount) : "0 B");
    setText("batchPath", batch ? relativeBatchPath() : "素材");
    var rail = element("railFill");
    if (rail) rail.style.width = busy ? "64%" : batch && batch.fileCount ? "100%" : "0%";

    var autoToggle = element("autoCollectToggle");
    if (autoToggle) {
      autoToggle.checked = currentAutoSetting();
      autoToggle.disabled = !context || !context.projectPath || !projectState || !currentProtectionSetup() || !currentProjectSetup() || !projectState.initialized || State.needsCollectionPolicyAcceptance(projectState) || Boolean(projectState && (projectState.pendingTransaction || projectState.pendingProjectSave)) || Boolean(activePanelError) || Boolean(unresolved && unresolved.length) || busy;
    }
    var openButton = element("openBatchButton");
    if (openButton) openButton.disabled = !context || !context.projectPath || !projectState || openingFolder;
    var handoffButton = element("handoffButton");
    if (handoffButton) handoffButton.disabled = !projectState || !currentProjectSetup() || !projectState.initialized || busy || pendingCount > 0 || reviewCount > 0 || Boolean(projectState.pendingTransaction) || Boolean(projectState.pendingProjectSave) || Boolean(activePanelError) || Boolean(unresolved && unresolved.length);
    var handoffBlockedByWork = busy || pendingCount > 0;
    var handoffBlockedByProblem = reviewCount > 0 || Boolean(projectState && (projectState.pendingTransaction || projectState.pendingProjectSave)) || Boolean(activePanelError) || Boolean(unresolved && unresolved.length);
    setText("handoffHint", projectState && (projectState.pendingTransaction || projectState.pendingProjectSave)
      ? "先核对并结束上次整理，才能开始新一批。"
      : !currentProjectSetup()
        ? "先开始整理此工程，再使用交接文件夹。"
      : handoffBlockedByWork
        ? "素材整理完成后才能开始新一批。"
        : handoffBlockedByProblem
          ? "先完成上面的处理，才能开始新一批。"
          : "每天自动分批；同一天需要分开时，可开始新一批。");
    var folderMessage = element("folderActionMessage");
    if (folderMessage) {
      folderMessage.hidden = !folderActionMessage;
      folderMessage.textContent = folderActionMessage;
    }
    var refreshButton = element("refreshButton");
    if (refreshButton) refreshButton.disabled = busy;
    renderActivity();
    renderReviewItems();
    renderProtectedLibraries();
    renderSettingsState(activePanelError);
    renderRecoveryDetails();
  }

  async function readProjectState(nextContext) {
    if (!nextContext || !nextContext.workspaceRoot) return null;
    var stateFile = Storage.statePath(nextContext.workspaceRoot);
    var loaded = await Storage.readJsonWithBackup(fs, stateFile, {
      validate: function (value) { return State.validateStoredState(value); },
    });
    stateRevision = loaded.revision;
    stateRecoveredFromBackup = loaded.recovered === true;
    stateReloadRequired = false;
    storageWarning = loaded.recovered && loaded.revision === undefined
      ? "主状态文件当前无法读取，请恢复访问权限后重新检查；为避免覆盖记录，自动整理已暂停"
      : "";
    var state;
    if (loaded.missing) {
      var reservedMediaRoot = Core.joinNativePath(nextContext.workspaceRoot, "素材");
      if (await Transaction.exists(fs, reservedMediaRoot)) {
        var missingStateError = new Error("当前工程的“素材”文件夹已经存在，但整理记录和备份都找不到。为避免混用旧文件夹，自动整理已停止；请先恢复整理记录。确认这里从未使用过插件时，再把现有“素材”文件夹移出后重新检查。");
        missingStateError.code = "MATERIAL_BATCH_STATE_LOST";
        missingStateError.mediaRoot = reservedMediaRoot;
        throw missingStateError;
      }
      state = State.createState(nextContext.workspaceRoot, new Date());
    } else {
      state = State.hydrateState(loaded.value, nextContext.workspaceRoot, new Date());
    }
    if (Storage && typeof Storage.cleanupOrphanedRecycleCredentials === "function") {
      try { await Storage.cleanupOrphanedRecycleCredentials(fs, stateFile, state); } catch (cleanupError) {
        reportRuntimeError("清理已完成回收凭据失败", cleanupError);
      }
    }
    state = State.registerProject(state, nextContext.projectPath, nextContext.projectName, new Date());
    if (loaded.recovered) state = State.addActivity(state, "warn", "状态文件已从备份读取", new Date());
    return state;
  }

  async function persistState() {
    if (!context || !context.workspaceRoot || !projectState) throw new Error("没有可保存的素材空间");
    var saved;
    try {
      saved = await Storage.writeJsonAtomic(fs, Storage.statePath(context.workspaceRoot), projectState, {
        expectedRevision: stateRevision,
        recovered: stateRecoveredFromBackup,
      });
    } catch (error) {
      var code = String(error && error.code || "");
      if (["MATERIAL_BATCH_STORAGE_CONFLICT", "MATERIAL_BATCH_STORAGE_LOCKED", "MATERIAL_BATCH_STORAGE_STALE_LOCK", "MATERIAL_BATCH_STORAGE_LOCK_UNSUPPORTED"].indexOf(code) >= 0) {
        try { setMachineSetting("auto", false); } catch (settingsError) {
          reportRuntimeError("暂停自动整理的本机设置保存失败", settingsError);
        }
        stopMonitor(false);
        stateReloadRequired = code === "MATERIAL_BATCH_STORAGE_CONFLICT";
        panelError = userFacingRuntimeError(error, "整理记录正在被另一个 Premiere 进程修改，自动整理已暂停。");
      }
      throw error;
    }
    stateRevision = saved.revision;
    stateRecoveredFromBackup = false;
    if (saved.warning) {
      reportRuntimeError("保存整理记录后出现警告", { message: String(saved.warning) });
      var settingsWarning = "";
      try { setMachineSetting("auto", false); } catch (settingsError) {
        reportRuntimeError("暂停自动整理的本机设置保存失败", settingsError);
        settingsWarning = "；本机自动开关未能保存，但本次整理记录已经安全写入";
      }
      stopMonitor(false);
      storageWarning = (saved.lockReleaseWarning
        ? "整理记录已经保存，但状态写锁未能清理；请关闭另一个 Premiere 进程并检查 .lock 文件"
        : "整理记录已经保存，但保存后的复核没有完成；自动整理已暂停，请重新检查当前工程。") + settingsWarning;
    } else storageWarning = "";
    return saved;
  }

  function assertCheckpointWriteVerified(saved, message) {
    if (!saved || !saved.warning) return;
    var error = new Error(message || "整理记录已经写入，但保存后的安全复核没有完成；未继续处理素材");
    error.code = saved.lockReleaseWarning
      ? "MATERIAL_BATCH_STORAGE_LOCKED"
      : "MATERIAL_BATCH_STORAGE_UNVERIFIED";
    throw error;
  }

  async function refreshContext(options) {
    var refreshOptions = options || {};
    machineSettings = loadMachineSettings();
    var next = await Premiere.activeContext(ppro);
    var changed = !context || !next || context.identity !== next.identity || context.workspaceRoot !== next.workspaceRoot;
    if (!changed && refreshOptions.force !== true && !stateReloadRequired) return context;

    detachProjectDirtyListener();
    stopMonitor(false);
    context = next;
    projectState = null;
    if (changed) {
      savedProjectEvidence = null;
      setSettingsMessage("", "");
      folderActionMessage = "";
      recoverySnapshot = null;
      recoveryMessage = "";
    }
    stateRevision = Storage.MISSING_REVISION;
    stateRecoveredFromBackup = false;
    protectedMappingValidation = { validMappings: [], unresolved: [], statusById: {} };
    try {
      projectState = next && next.workspaceRoot ? await readProjectState(next) : null;
    } catch (error) {
      stateReloadRequired = true;
      reportRuntimeError("读取整理记录失败", error);
      panelError = userFacingRuntimeError(error, "无法读取当前工程的整理记录，插件没有处理或移动任何素材。请重新检查磁盘连接后再试。");
      throw error;
    }
    await refreshProtectedMappingStatus();
    panelError = "";
    await adoptInterruptedCleanup();
    if (projectState && (projectState.pendingTransaction || projectState.pendingProjectSave) && storageWarning) {
      recoveryMessage = storageWarning;
    }
    pendingCount = 0;
    reviewCount = 0;
    reviewItems = [];
    lastProtectedCount = 0;
    outsideMediaCount = 0;
    outsideCollectCount = 0;
    outsideReviewCount = 0;
    outsideMediaBytes = 0;
    outsideUnreadableCount = 0;
    if (projectState && ((projectState.pendingTransaction && !projectState.pendingTransaction.backgroundTask) || projectState.pendingProjectSave || storageWarning || !currentProtectionSetup())) setMachineSetting("auto", false);
    if (projectState && unresolvedProtectedLibraries().length) setMachineSetting("auto", false);
    if (projectState && State.needsCollectionPolicyAcceptance(projectState)) setMachineSetting("auto", false);
    syncMonitor();
    render();
    return context;
  }

  function currentBatchDirectories() {
    var root = mediaRoot();
    var current = batchPath();
    if (!root || !current) throw new Error("无法确定当前素材文件夹");
    if (!Core.isPathInside(root, context.workspaceRoot) || Core.samePath(root, context.workspaceRoot)) {
      throw new Error("素材根目录越出了当前工程文件夹");
    }
    if (!Core.isPathInside(current, root) || Core.samePath(current, root)) {
      throw new Error("当前素材文件夹的位置不安全");
    }
    return { root: root, current: current };
  }

  async function ensureBatchDirectories() {
    var directories = currentBatchDirectories();
    async function ensureDirectory(nativePath) {
      try {
        await fs.mkdir(nativePath, { recursive: true });
      } catch (error) {
        if (!Storage || typeof Storage.isAlreadyExistsError !== "function" || !Storage.isAlreadyExistsError(error)) {
          throw batchDirectoryError(nativePath, error, false);
        }
      }
      var stat;
      try {
        stat = await fs.lstat(nativePath);
      } catch (error) {
        throw batchDirectoryError(nativePath, error, false);
      }
      if (!stat || typeof stat.isDirectory !== "function" || !stat.isDirectory()) {
        throw batchDirectoryError(nativePath, null, true);
      }
    }
    await ensureDirectory(directories.root);
    await ensureDirectory(directories.current);
  }

  async function verifyExistingBatchDirectory() {
    var directories = currentBatchDirectories();
    var stat;
    try {
      stat = await fs.lstat(directories.current);
    } catch (error) {
      if (Core.isMissingPathError(error)) {
        var missingError = new Error("当前素材文件夹还没有建立。开始整理此工程后，插件会自动建立它。");
        missingError.code = "MATERIAL_BATCH_DIRECTORY_MISSING";
        throw missingError;
      }
      throw batchDirectoryError(directories.current, error, false);
    }
    if (!stat || typeof stat.isDirectory !== "function" || !stat.isDirectory()) {
      throw batchDirectoryError(directories.current, null, true);
    }
    return directories.current;
  }

  function notReadyError(message) {
    var error = new Error(message || "文件仍在写入，稍后重试");
    error.code = "MATERIAL_BATCH_FILE_NOT_READY";
    return error;
  }

  async function verifyStableFile(nativePath, expectedFingerprint, lifecycleGeneration) {
    if (!panelVisible || !lifecycleGuard.isCurrent(lifecycleGeneration)) {
      var cancelled = new Error("面板已关闭");
      cancelled.code = "MATERIAL_BATCH_SCAN_CANCELLED";
      throw cancelled;
    }
    var stat;
    try {
      stat = await Transaction.lstatForIdentity(fs, nativePath);
    } catch (error) {
      throw notReadyError("文件暂时无法读取，稍后重试");
    }
    if (typeof stat.isFile !== "function" || !stat.isFile()) throw new Error("第一版只处理单个文件素材");
    var currentFingerprint = Transaction.fingerprintFromStat(stat);
    if (!Transaction.sameStrongPathFingerprint(expectedFingerprint, currentFingerprint)) {
      stabilityTracker.observe(nativePath, currentFingerprint, Date.now());
      throw notReadyError("文件在整理前又发生变化，已继续等待它写完");
    }
    return stat;
  }

  async function chooseTargetPath(sourcePath) {
    var folder = batchPath();
    if (!Core.isPathInside(folder, mediaRoot())) throw new Error("目标素材文件夹的位置不安全");
    for (var suffix = 1; suffix <= 9999; suffix += 1) {
      var target = Core.joinNativePath(folder, Core.targetNameCandidate(sourcePath, suffix));
      if (!(await Transaction.exists(fs, target)) && !(await Transaction.exists(fs, target + ".organizing-part"))) return target;
    }
    throw new Error("同名素材过多，无法生成不覆盖的目标文件名");
  }

  function targetPathForMapping(mapping) {
    if (!mapping || !Core.isSafeRelativePath(mapping.targetRelativePath)) throw new Error("状态文件中的目标路径不安全");
    var target = Core.joinNativePath(context.workspaceRoot, mapping.targetRelativePath);
    if (!Core.isPathInside(target, mediaRoot())) throw new Error("状态映射越出了素材根目录");
    return target;
  }

  function mappingsForKey(key) {
    if (!projectState || !projectState.pathMappings[key]) return [];
    return Array.isArray(projectState.pathMappings[key]) ? projectState.pathMappings[key] : [projectState.pathMappings[key]];
  }

  async function inspectMappingTarget(mapping) {
    var targetPath = targetPathForMapping(mapping);
    var targetStat;
    try {
      targetStat = await Transaction.lstatForIdentity(fs, targetPath);
    } catch (error) {
      return {
        kind: Core.isMissingPathError(error) ? "mapping-target-missing" : "mapping-target-unavailable",
        mapping: mapping,
        targetPath: targetPath,
        targetFingerprint: null,
        error: error,
      };
    }
    if (typeof targetStat.isFile !== "function" || !targetStat.isFile()) {
      return { kind: "mapping-target-unavailable", mapping: mapping, targetPath: targetPath, targetFingerprint: null };
    }
    var targetFingerprint = Transaction.fingerprintFromStat(targetStat);
    var targetStatus = ScanPolicy.mappingTargetStatus(mapping, true, targetFingerprint);
    if (targetStatus === "match" && !Transaction.sameStrongPathFingerprint(mapping.targetFingerprint, targetFingerprint)) {
      targetStatus = "mismatch";
    }
    return {
      kind: targetStatus === "match" ? "match" : "mapping-target-" + targetStatus,
      mapping: mapping,
      targetPath: targetPath,
      targetFingerprint: targetFingerprint,
    };
  }

  async function mappingDecision(group) {
    var mappings = mappingsForKey(group.key);
    if (!mappings.length) return { kind: "none", mapping: null, sourceFingerprint: null };
    var sourceExists = await Transaction.exists(fs, group.mediaPath);
    if (!sourceExists) {
      return mappings.length === 1
        ? inspectMappingTarget(mappings[0])
        : { kind: "mapping-ambiguous", mapping: null, sourceFingerprint: null };
    }
    var sourceFingerprint = Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, group.mediaPath));
    return { kind: "reused-path", mapping: null, sourceFingerprint: sourceFingerprint };
  }

  function globalSafetyFailure(error) {
    var code = String(error && error.code || "");
    return /MATERIAL_BATCH_(?:STORAGE_|STATE_|JOURNAL_|CONTEXT_|PROJECT_SAVE_FAILED|SCAN_CANCELLED|TRANSACTION_COMMIT_)/.test(code)
      || ["MATERIAL_RECYCLE_PROTOCOL", "MATERIAL_RECYCLE_UNCERTAIN", "MATERIAL_RECYCLE_REQUEST_EXISTS", "MATERIAL_RECYCLE_CANCELLED"].indexOf(code) >= 0
      || Boolean(error && error.committed)
      || Boolean(error && error.cleanupFailure && globalSafetyFailure(error.cleanupFailure));
  }

  async function parkPendingItem(error, options) {
    options = options || {};
    var pending = projectState && projectState.pendingTransaction;
    if (!pending || projectState.pendingProjectSave || storageWarning || stateReloadRequired || globalSafetyFailure(error)
      || pending.recycleReceipt || !context || !Core.samePath(pending.projectPath, context.projectPath)
      || pending.projectIdentity !== context.identity || !(await Premiere.contextStillActive(ppro, context.identity))) return false;
    var request = pending.recycleRequest;
    var result = null;
    if (request) {
      var plugin = await uxp.storage.localFileSystem.getPluginFolder();
      var checked = await RecycleBridge.create({ fs: fs, uxp: uxp, pluginPath: plugin.nativePath }).query(request);
      // 只有已认证的终态才释放当前事务槽。超时、请求消失、提交未决都不能当作失败。
      if (!checked || !checked.value || !((checked.state === "result" && checked.value.status === "failed") || checked.state === "cancelled")) return false;
      result = checked.value;
    } else if (!options.fromBackground && ["EBUSY", "EACCES", "EPERM", "ENOENT"].indexOf(String(error && error.code || "")) < 0) {
      return false;
    }
    var precise = Transaction.hasStrongFileIdentity(pending.sourceFingerprint) && Transaction.hasStrongFileIdentity(pending.targetFingerprint);
    var transient = result && ((result.failureKind === "busy" && [32, 33].indexOf(Number(result.win32Error)) >= 0)
      || (!result.failureKind && result.message === "无法独占原素材的改名权限，原文件保留"));
    var retry = precise && transient && !options.hold && (pending.status === "cleanup-pending" || Boolean(pending.backgroundTask));
    var attempts = Math.min(1000000, (pending.backgroundTask && pending.backgroundTask.attempts || 0) + 1);
    var message = retry ? "原素材暂时被占用，等待释放" : userFacingRuntimeError(error, "此素材暂时保留，其他素材继续整理");
    var nextAttempt = new Date(Date.now() + Math.min(60000, 10000 * Math.pow(2, Math.min(3, attempts - 1))));
    var before = projectState;
    try {
      if (request) projectState = State.updatePendingTransaction(projectState, {
        recycleAttempts: (pending.recycleAttempts || []).concat([{ request: request, result: {
          status: result.status, message: String(result.message || ""), failureKind: String(result.failureKind || ""), win32Error: Number(result.win32Error) || 0,
        } }]), recycleRequest: null,
      }, new Date());
      projectState = State.deferTransaction(projectState, new Date(), {
        version: 1, kind: retry ? "cleanup" : "held", attempts: attempts, nextAttemptAt: nextAttempt.toISOString(), message: message,
      });
      assertCheckpointWriteVerified(await persistState(), "等待记录未可靠保存，已暂停整理");
    } catch (writeError) {
      projectState = before;
      throw writeError;
    }
    recoverySnapshot = null;
    recoveryMessage = "";
    return true;
  }

  async function adoptInterruptedCleanup() {
    var pending = projectState && projectState.pendingTransaction;
    if (!pending || pending.backgroundTask || pending.status !== "cleanup-pending" || !pending.recycleRequest
      || pending.resumeAutomatic !== true || !currentProjectSetup() || !currentProtectionSetup()
      || State.needsCollectionPolicyAcceptance(projectState) || unresolvedProtectedLibraries().length) return;
    if (await parkPendingItem(new Error(pending.error || "原件等待回收"))) setMachineSetting("auto", true);
  }

  async function previewIsMoving() {
    if (!Premiere.previewPosition || !context) return false;
    var before = await Premiere.previewPosition(ppro, context.project);
    if (before === null) return false;
    if (!before) return false;
    await new Promise(function (resolve) { setTimeout(resolve, 180); });
    return before !== await Premiere.previewPosition(ppro, context.project);
  }

  function inventoryLinkSnapshot(inventory) {
    Premiere.assertCompleteInventory(inventory);
    var links = Object.create(null);
    (inventory.entries || []).forEach(function (entry) {
      var id = String(entry.itemId || "");
      if (!id || Object.prototype.hasOwnProperty.call(links, id)) throw new Error("素材项身份不完整，不能复用保存结果");
      links[id] = Core.normalizePathForComparison(entry.mediaPath);
    });
    return links;
  }

  async function saveProjectWithEvidence() {
    savedProjectEvidence = null;
    var identity = context.identity;
    var path = context.projectPath;
    var generation = lifecycleGuard.current();
    var before = inventoryLinkSnapshot(await Premiere.inventoryProject(ppro, context.project));
    if (!(await Premiere.contextStillActive(ppro, identity))) throw new Error("保存前工程已切换");
    var saved;
    try {
      saved = await context.project.save();
      if (saved === false) throw new Error("Premiere 未确认保存成功");
    } catch (cause) {
      var saveError = new Error("Premiere 工程保存失败，本轮原件全部保留，未继续反复保存");
      saveError.code = "MATERIAL_BATCH_PROJECT_SAVE_FAILED";
      saveError.cause = cause;
      throw saveError;
    }
    // 保存凭据只驻留本次面板会话；磁盘工程变化或重新打开面板后必须重新核验。
    try {
      var fingerprint = await currentFileFingerprint(path);
      var after = inventoryLinkSnapshot(await Premiere.inventoryProject(ppro, context.project));
      var keys = Object.keys(before);
      if (panelVisible && lifecycleGuard.isCurrent(generation) && await Premiere.contextStillActive(ppro, identity)
        && keys.length === Object.keys(after).length && keys.every(function (key) { return before[key] === after[key]; })
        && Transaction.sameStrongPathFingerprint(fingerprint, await currentFileFingerprint(path))) {
        savedProjectEvidence = { identity: identity, path: path, fingerprint: fingerprint, links: after };
      }
    } catch (error) { savedProjectEvidence = null; }
    return saved;
  }

  async function canReuseProjectSave(targetPath, itemIds) {
    var evidence = savedProjectEvidence;
    if (!evidence || evidence.identity !== context.identity || !Core.samePath(evidence.path, context.projectPath)
      || !itemIds.length || !itemIds.every(function (id) {
        return evidence.links[String(id)] === Core.normalizePathForComparison(targetPath);
      })) return false;
    try { return Transaction.sameStrongPathFingerprint(evidence.fingerprint, await currentFileFingerprint(evidence.path)); }
    catch (error) { return false; }
  }

  async function runBackgroundCleanupUnlocked() {
    if (!panelVisible || !currentAutoSetting() || !currentProjectSetup() || !currentProtectionSetup() || storageWarning || stateReloadRequired) return;
    var count = (projectState.deferredTransactions || []).length;
    for (var index = 0; index < count; index += 1) {
      var next = State.nextBackgroundCleanup(projectState, context.projectPath, context.identity, new Date());
      if (!next || unresolvedProtectedLibraries().length || !currentAutoSetting() || !panelVisible) return;
      if (await previewIsMoving()) return;
      var before = projectState;
      projectState = State.resumeDeferred(projectState, next.id, new Date());
      try { assertCheckpointWriteVerified(await persistState(), "后台继续记录未可靠保存，未处理素材"); }
      catch (error) { projectState = before; throw error; }
      await recoverPendingTransaction({ automatic: true, unlocked: true });
    }
  }

  async function processGroup(group, lifecycleGeneration) {
    recoveryCancelled = false;
    machineSettings = loadMachineSettings();
    if (!currentProjectSetup() || !currentAutoSetting()) {
      var disabledError = new Error("当前工程尚未开启自动整理");
      disabledError.code = "MATERIAL_BATCH_PROJECT_NOT_ENABLED";
      throw disabledError;
    }
    var sourcePath = group.mediaPath;
    var batch = State.currentBatch(projectState);
    busy = true;
    backgroundOperation = true;
    busyStage = "scan";
    render();
    try {
      await checkRecycleAvailability(lifecycleGeneration);
      projectState = State.prepareCollectionBatch(projectState, new Date());
      batch = State.currentBatch(projectState);
      await ensureBatchDirectories();
      // 目标批次目录创建后，才用真实 lstat.dev 证明同卷；无法证明就走复制。
      var modeEvidence = await Transaction.resolveMoveMode(fs, sourcePath, batchPath());
      var plannedMode = modeEvidence.mode;
      var targetPath = await chooseTargetPath(sourcePath);
      var targetRelativePath = relativePathForContext(projectState.mediaFolderName, batch.name, Core.basename(targetPath));
      if (!Core.isSafeRelativePath(targetRelativePath)) throw new Error("无法生成安全的素材文件路径");
      var sourceStat = await verifyStableFile(sourcePath, group.sourceFingerprint, lifecycleGeneration);
      var sourceFingerprint = Transaction.fingerprintFromStat(sourceStat);
      var transactionId = "tx-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
      var cleanupPath = Transaction.cleanupPathFor(sourcePath, transactionId);
      var itemSignatures = group.entries.map(function (entry) {
        return {
          itemId: String(entry.itemId || ""),
          itemName: String(entry.itemName || ""),
          mediaPath: String(entry.mediaPath || sourcePath),
        };
      });
      var transactionItemIds = itemSignatures.map(function (entry) { return entry.itemId; }).filter(Boolean);
      if (transactionItemIds.length !== group.entries.length || new Set(transactionItemIds).size !== transactionItemIds.length) {
        throw new Error("Premiere 没有提供完整且唯一的素材项身份，不能安全地整理这个文件");
      }
      projectState = State.beginTransaction(projectState, {
        resumeAutomatic: currentAutoSetting(),
        id: transactionId,
        sourcePath: sourcePath,
        targetPath: targetPath,
        cleanupPath: cleanupPath,
        targetRelativePath: targetRelativePath,
        sourceFingerprint: sourceFingerprint,
        byteCount: Transaction.statSize(sourceStat),
        batchIndex: batch.index,
        mode: plannedMode,
        modeEvidence: modeEvidence,
        deleteSource: true,
        projectPath: context.projectPath,
        projectIdentity: context.identity,
        itemCount: group.entries.length,
        itemIds: transactionItemIds,
        itemSignatures: itemSignatures,
      }, new Date());
      try {
        var journalSave = await persistState();
        assertCheckpointWriteVerified(journalSave, "移动记录已经写入，但保存后的安全复核没有完成；素材尚未移动");
      } catch (journalError) {
        if (!journalSave) projectState = State.clearPendingTransaction(projectState, new Date());
        var journalFailure = new Error("无法记录本次移动，素材尚未移动。自动整理已暂停，请重新检查当前工程。");
        journalFailure.code = "MATERIAL_BATCH_JOURNAL_SAVE_FAILED";
        journalFailure.cause = journalError;
        throw journalFailure;
      }

      try {
        var result = await Transaction.moveAndRelink({
          id: transactionId,
          sourceDisposition: "recycle",
          recycle: recycleCurrentSource,
          fs: fs,
          project: context.project,
          projectItems: group.entries.map(function (entry) { return entry.clip; }),
          sourcePath: sourcePath,
          targetPath: targetPath,
          cleanupPath: cleanupPath,
          forceMode: plannedMode,
          modeEvidence: modeEvidence,
          deleteSource: true,
          deferSaveAndCleanup: true,
          shouldDeferRelink: previewIsMoving,
          validate: function () { return Premiere.contextStillActive(ppro, context.identity); },
          persistProject: saveProjectWithEvidence,
          beforeRelink: async function (details) {
            projectState = State.updatePendingTransaction(projectState, {
              id: transactionId,
              targetFingerprint: details.targetFingerprint,
              sourceFingerprint: details.sourceFingerprint,
              targetMethod: details.targetMethod,
              mode: details.mode,
              modeEvidence: details.modeEvidence,
              itemIds: transactionItemIds,
              itemCount: transactionItemIds.length,
              itemSignatures: itemSignatures,
              status: "ready-to-relink",
            }, new Date());
            var checkpointSave = await persistState();
            assertCheckpointWriteVerified(checkpointSave, "目标文件记录已经写入，但保存后的安全复核没有完成；Premiere 链接尚未修改");
          },
          beforeSourceCleanup: function () {
            return verifyCompleteInventoryBeforeDelete(sourcePath, targetPath, transactionItemIds, cleanupPath);
          },
          beforeDelete: async function (details) {
            var inventoryVerified = await verifyCompleteInventoryBeforeDelete(
              sourcePath,
              targetPath,
              transactionItemIds,
              cleanupPath
            );
            if (inventoryVerified === false) return false;
            projectState = State.updatePendingTransaction(projectState, {
              id: transactionId,
              targetFingerprint: details.targetFingerprint,
              targetMethod: details.targetMethod,
              status: "ready-to-delete",
            }, new Date());
            var deleteCheckpointSave = await persistState();
            assertCheckpointWriteVerified(
              deleteCheckpointSave,
              "删除前的文件身份记录已经写入，但保存后的安全复核没有完成；原素材未删除"
            );
            return true;
          },
          onStage: function (stage) {
            busyStage = stage;
            render();
          },
        });
        if (result.awaitingProjectSave) {
          var beforeDeferral = projectState;
          try {
          projectState = State.updatePendingTransaction(projectState, {
            status: "awaiting-batch-save", targetFingerprint: result.targetFingerprint,
          }, new Date());
          projectState = State.deferTransaction(projectState, new Date(), {
            version: 1, kind: "cleanup", attempts: 1, nextAttemptAt: new Date(0).toISOString(),
            message: "等待本轮统一保存后回收原件",
          });
          assertCheckpointWriteVerified(await persistState(), "待保存素材记录未可靠写入，原件保留");
          } catch (deferError) { projectState = beforeDeferral; throw deferError; }
          return result;
        }
        if (result.cleanupPending) {
          var cleanupError = new Error(result.cleanupWarning || "原位置文件没有删除，请手动删除后重新检查");
          cleanupError.code = "MATERIAL_BATCH_SOURCE_CLEANUP_REQUIRED";
          cleanupError.cleanupFailure = result.cleanupFailure || null;
          throw cleanupError;
        }
        result.id = transactionId;
        result.targetRelativePath = targetRelativePath;
        result.batchIndex = batch.index;
        var stateBeforeCommit = projectState;
        try {
          projectState = State.commitTransaction(projectState, result, new Date());
          if (projectState.pendingTransaction
            || !projectState.transactions.some(function (transaction) { return String(transaction.id || "") === transactionId; })) {
            var commitConflict = new Error("整理结果与移动记录不一致，已保留待检查记录，不能标记为整理成功");
            commitConflict.code = "MATERIAL_BATCH_TRANSACTION_COMMIT_CONFLICT";
            throw commitConflict;
          }
          projectState = State.addActivity(
            projectState,
            result.sourceChanged ? "warn" : "ok",
            result.sourceChanged ? "素材已移动；原路径出现另一份文件" : "已整理 " + Core.basename(targetPath),
            new Date(),
            { summary: result.sourceChanged ? sourcePath : formatBytes(result.byteCount) }
          );
          if (Array.isArray(result.warnings) && result.warnings.length) {
            projectState = State.addActivity(projectState, "warn", "Premiere 返回异常，但链接核验已通过", new Date(), {
              summary: result.warnings.join("；"),
            });
          }
          await persistState();
        } catch (commitError) {
          projectState = stateBeforeCommit;
          throw commitError;
        }
        stabilityTracker.forget(sourcePath);
        return result;
      } catch (error) {
        reportRuntimeError("整理素材失败", error);
        var transactionMessage = userFacingRuntimeError(error, "整理素材时遇到问题，插件已暂停。请检查最近记录后重新检查。");
        projectState = error.code === "MATERIAL_BATCH_SOURCE_CLEANUP_REQUIRED"
          ? State.markCleanupPending(projectState, transactionMessage, new Date())
          : State.failTransaction(projectState, transactionMessage, new Date());
        projectState = State.addActivity(projectState, "error", "整理失败：" + Core.basename(sourcePath), new Date(), {
          summary: transactionMessage,
        });
        if (await parkPendingItem(error)) {
          panelError = "";
          return { deferred: true };
        }
        try { await persistState(); } catch (persistError) {}
        pauseAutomaticBestEffort();
        panelError = transactionMessage + rollbackWarningSuffix(error);
        throw error;
      }
    } finally {
      busy = false;
      backgroundOperation = false;
      busyStage = "";
      render();
    }
  }

  async function applyExistingMapping(group, decision) {
    machineSettings = loadMachineSettings();
    if (!currentProjectSetup() || !currentAutoSetting()) {
      var disabledError = new Error("当前工程尚未开启自动整理，历史位置不会自动补链");
      disabledError.code = "MATERIAL_BATCH_PROJECT_NOT_ENABLED";
      throw disabledError;
    }
    var mapping = decision.mapping;
    var targetPath = targetPathForMapping(mapping);
    if (Core.samePath(group.mediaPath, targetPath)) return false;
    var verification = await inspectMappingTarget(mapping);
    if (verification.kind !== "match") return { applied: false, decision: verification };
    if (decision.targetFingerprint
      && !Transaction.sameStrongPathFingerprint(decision.targetFingerprint, verification.targetFingerprint)) {
      verification.kind = "mapping-target-mismatch";
      return { applied: false, decision: verification };
    }
    busy = true;
    busyStage = "relink";
    render();
    var projectSaveRecord = null;
    try {
      var itemIds = group.entries.map(function (entry) { return String(entry.itemId || ""); }).filter(Boolean);
      if (itemIds.length !== group.entries.length || new Set(itemIds).size !== itemIds.length) {
        throw new Error("Premiere 没有提供完整且唯一的素材项身份，不能安全地自动补链");
      }
      projectSaveRecord = {
        id: "save-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7),
        sourcePath: group.mediaPath,
        targetRelativePath: mapping.targetRelativePath,
        targetFingerprint: verification.targetFingerprint,
        projectPath: context.projectPath,
        projectIdentity: context.identity,
        itemIds: itemIds,
        itemCount: group.entries.length,
        itemSignatures: group.entries.map(function (entry) {
          return { itemId: String(entry.itemId || ""), itemName: String(entry.itemName || ""), mediaPath: String(entry.mediaPath || "") };
        }),
      };
      projectState = State.beginProjectSave(projectState, projectSaveRecord, new Date());
      var journalSave = await persistState();
      assertCheckpointWriteVerified(journalSave, "补链记录已经写入，但保存后的安全复核没有完成；Premiere 链接尚未修改");
      await Transaction.relinkExisting({
        fs: fs,
        projectItems: group.entries.map(function (entry) { return entry.clip; }),
        sourcePath: group.mediaPath,
        targetPath: targetPath,
        validate: function () { return Premiere.contextStillActive(ppro, context.identity); },
        persistProject: function () { return context.project.save(); },
      });
      var afterRelink = await inspectMappingTarget(mapping);
      if (afterRelink.kind !== "match"
        || !Transaction.sameStrongPathFingerprint(verification.targetFingerprint, afterRelink.targetFingerprint)) {
        var changed = new Error("补链期间新位置文件发生变化，已停止自动整理");
        changed.code = "MATERIAL_BATCH_MAPPING_TARGET_CHANGED";
        throw changed;
      }
      projectState = State.clearPendingProjectSave(projectState, new Date());
      projectState = State.addActivity(projectState, "ok", "已为当前工程补链 " + Core.basename(targetPath), new Date());
      await persistState();
      return { applied: true, decision: afterRelink };
    } catch (error) {
      reportRuntimeError("更新 Premiere 素材链接失败", error);
      var relinkMessage = userFacingRuntimeError(error, "Premiere 素材链接没有更新完成，自动整理已暂停。请检查最近记录后重试。");
      if (projectState && projectSaveRecord) {
        if (!projectState.pendingProjectSave) {
          projectState = State.beginProjectSave(projectState, projectSaveRecord, new Date());
        }
        projectState = State.failProjectSave(projectState, relinkMessage, new Date());
        projectState = State.addActivity(projectState, "error", "Premiere 补链尚未确认保存", new Date(), {
          summary: relinkMessage,
        });
        try { await persistState(); } catch (persistError) {}
      }
      pauseAutomaticBestEffort();
      panelError = relinkMessage + rollbackWarningSuffix(error);
      throw error;
    } finally {
      busy = false;
      busyStage = "";
    }
  }

  function recordReview(group, status, review, details) {
    var item = addReviewItem(Object.assign({
      kind: status,
      sourcePath: group.mediaPath,
      filename: Core.basename(group.mediaPath),
    }, review || {}));
    var known = projectState.knownMedia[group.key];
    var reason = String(item.reason || "需要人工确认");
    var targetRelativePath = String(details && details.targetRelativePath || "");
    if (known
      && known.status === status
      && String(known.reason || "") === reason
      && Core.sameRelativePath(String(known.targetRelativePath || ""), targetRelativePath)) return false;
    projectState = State.markKnown(projectState, group.mediaPath, status, new Date(), Object.assign({
      reason: reason,
      targetRelativePath: targetRelativePath,
    }, details || {}));
    projectState = State.addActivity(projectState, "warn", "等待确认 " + Core.basename(group.mediaPath), new Date(), { summary: reason });
    return true;
  }

  function mappingReview(group, decision) {
    var mapping = decision.mapping;
    var reasonByKind = {
      "mapping-ambiguous": "同一旧位置对应多个已整理文件，插件无法判断应使用哪一个。",
      "mapping-target-missing": "上次记录的新位置文件不存在，不能自动补链。",
      "mapping-target-unverified": "记录中的新位置文件还没有可靠的身份信息，不能自动让 Premiere 使用。",
      "mapping-target-unavailable": "记录中的新位置当前无法读取或不是单个文件。",
      "mapping-target-mismatch": "新位置文件与上次记录不一致，可能已经被替换。",
    };
    var canConfirm = ["mapping-target-unverified", "mapping-target-mismatch"].indexOf(decision.kind) >= 0;
    return {
      type: "历史位置",
      targetPath: decision.targetPath || "",
      targetRelativePath: mapping && mapping.targetRelativePath || "",
      targetFingerprint: decision.targetFingerprint || null,
      mapping: mapping || null,
      revealPath: decision.targetPath ? Core.dirname(decision.targetPath) : batchPath(),
      reason: reasonByKind[decision.kind] || "无法验证上次整理的新位置。",
      note: decision.kind === "mapping-target-missing"
        ? "请在 Premiere 中重新链接或移除这条离线素材，然后点击“重新检查”。"
        : "",
      actions: canConfirm
        ? [["mapping-confirm", "确认使用", "primary"], ["retry", "重新检查", "secondary"]]
        : [["reveal", "打开所在位置", "secondary"], ["retry", "重新检查", "secondary"]],
    };
  }

  function libraryForMapping(libraryId) {
    return machineSettings.protectedMappings.find(function (mapping) { return mapping.libraryId === libraryId; });
  }

  async function scanUnlocked(options) {
    var scanOptions = options || {};
    var previousSilentScan = silentScan;
    silentScan = scanOptions.quiet === true;
    try {
    if (scanOptions.skipRefresh !== true) await refreshContext({ force: true });
    if (!context || !context.projectPath || !projectState) {
      render();
      return { ok: false, error: "没有已保存的活动工程" };
    }
    if (!currentProtectionSetup()) {
      setMachineSetting("auto", false);
      stopMonitor(false);
      panelError = "";
      render();
      return { ok: false, error: "请先设置不搬动文件夹" };
    }
    if (storageWarning) {
      setMachineSetting("auto", false);
      stopMonitor(false);
      render();
      return { ok: false, error: storageWarning };
    }
    await refreshProtectedMappingStatus();
    if (unresolvedProtectedLibraries().length) {
      setMachineSetting("auto", false);
      stopMonitor(false);
      panelError = "";
      render();
      return { ok: false, error: "有不搬动文件夹需要重新选择" };
    }
    if (currentAutoSetting() && await previewIsMoving()) return { ok: true, previewDeferred: true };
    if (projectState.pendingTransaction && projectState.pendingTransaction.backgroundTask && currentAutoSetting()) {
      await recoverPendingTransaction({ automatic: true, unlocked: true });
    }
    if (projectState.pendingTransaction) {
      panelError = "";
      recoveryMessage = "";
      setMachineSetting("auto", false);
      stopMonitor(false);
      render();
      return { ok: false, error: "检测到上次整理未完成，等待核对" };
    }
    if (projectState.pendingProjectSave) {
      panelError = "";
      recoveryMessage = "";
      setMachineSetting("auto", false);
      stopMonitor(false);
      render();
      return { ok: false, error: "Premiere 工程还有一处补链等待核对" };
    }
    var expectedIdentity = context.identity;
    var lifecycleGeneration = lifecycleGuard.current();
    busy = true;
    busyStage = "scan";
    panelError = "";
    render();

    try {
      var inventory = await Premiere.inventoryProject(ppro, context.project);
      if (!(await Premiere.contextStillActive(ppro, expectedIdentity))) throw new Error("检查期间活动工程已切换");
      var groups = Premiere.groupByMediaPath(inventory.entries);
      lastInventoryCount = groups.length;
      pendingCount = 0;
      reviewCount = 0;
      reviewItems = [];
      lastProtectedCount = 0;
      outsideMediaCount = 0;
      outsideCollectCount = 0;
      outsideReviewCount = 0;
      outsideMediaBytes = 0;
      outsideUnreadableCount = 0;
      Premiere.assertCompleteInventory(inventory);
      var classifications = groups.map(function (group) {
        return Core.classifyMediaPath(group.mediaPath, {
          mediaRoot: mediaRoot(),
          workspaceRoot: context.workspaceRoot,
          protectedRoots: workspaceProtectedMappings(),
        });
      });

      var observedCollectionPaths = [];
      var observedAt = Date.now();
      for (var fingerprintIndex = 0; fingerprintIndex < groups.length; fingerprintIndex += 1) {
        var fingerprintKind = classifications[fingerprintIndex].kind;
        if (fingerprintKind === "protected") lastProtectedCount += 1;
        if (["collect", "review"].indexOf(fingerprintKind) < 0) continue;
        outsideMediaCount += 1;
        if (fingerprintKind === "collect") outsideCollectCount += 1;
        else outsideReviewCount += 1;
        try {
          var fingerprintStat = await Transaction.lstatForIdentity(fs, groups[fingerprintIndex].mediaPath);
          groups[fingerprintIndex].sourceFingerprint = typeof fingerprintStat.isFile === "function" && fingerprintStat.isFile()
            ? Transaction.fingerprintFromStat(fingerprintStat)
            : null;
          if (groups[fingerprintIndex].sourceFingerprint) {
            outsideMediaBytes += Transaction.statSize(fingerprintStat);
          } else {
            outsideUnreadableCount += 1;
          }
        } catch (fingerprintError) {
          groups[fingerprintIndex].sourceFingerprint = null;
          groups[fingerprintIndex].identityError = userFacingRuntimeError(fingerprintError, "无法读取精确文件身份，原文件保留");
          reportRuntimeError("读取素材身份失败", fingerprintError);
          outsideUnreadableCount += 1;
        }
        if (fingerprintKind === "collect") {
          observedCollectionPaths.push(groups[fingerprintIndex].mediaPath);
          groups[fingerprintIndex].stability = stabilityTracker.observe(
            groups[fingerprintIndex].mediaPath,
            groups[fingerprintIndex].sourceFingerprint,
            observedAt
          );
        }
      }
      stabilityTracker.retain(observedCollectionPaths);
      groups.forEach(function (group, index) {
        var classification = classifications[index];
        if (classification.kind !== "review") return;
        addReviewItem({
          kind: "review",
          sourcePath: group.mediaPath,
          filename: Core.basename(group.mediaPath),
          type: "整组素材",
          reason: classification.reason,
          note: "插件不会移动此项。要留在原位，请把所在文件夹加入“不搬动文件夹”；要随工程交接，请完整搬移关联文件夹，在 Premiere 中重新链接后再检查。",
          revealPath: Core.dirname(group.mediaPath),
          actions: [["reveal", "打开所在位置", "secondary"], ["retry", "重新检查", "secondary"]],
        });
      });

      // 未明确开启或已经暂停时只做内存统计。禁止写整理记录、补链、保存工程或移动文件。
      if (!currentProjectSetup() || !currentAutoSetting() || State.needsCollectionPolicyAcceptance(projectState)) {
        pendingCount = outsideCollectCount;
        render();
        return {
          ok: true,
          initialized: projectState.initialized,
          pendingCount: pendingCount,
          reviewCount: reviewCount,
          readOnly: true,
        };
      }

      if (!projectState.initialized) {
        if (scanOptions.initializeCollection === true) {
          projectState = State.initializeCollection(projectState, groups, classifications, new Date());
          projectState = State.addActivity(projectState, "ok", "已开始整理工程素材", new Date(), {
            summary: groups.length + " 条路径将按当前规则检查",
          });
          var initializationSave = await persistState();
          assertCheckpointWriteVerified(initializationSave, "素材空间已经建立，但整理记录的安全复核没有完成；素材尚未移动");
        } else {
          render();
          return { ok: true, initialized: false };
        }
      }

      var dirtyState = false;
      for (var index = 0; index < groups.length; index += 1) {
        var group = groups[index];
        if ((projectState.deferredTransactions || []).some(function (record) { return Core.samePath(record.sourcePath, group.mediaPath); })) continue;
        var classification = classifications[index];
        var key = group.key;
        var known = projectState.knownMedia[key];
        if (classification.kind === "protected") {
          if (!projectState.protectedLibraries.some(function (library) { return library.libraryId === classification.libraryId; })) {
            var localLibrary = libraryForMapping(classification.libraryId);
            projectState = State.addProtectedLibrary(projectState, classification.libraryId, localLibrary ? localLibrary.label : "共享素材库", new Date());
            dirtyState = true;
          }
          if (!known || known.status !== "protected") {
            projectState = State.markKnown(projectState, group.mediaPath, "protected", new Date(), { libraryId: classification.libraryId });
            projectState = State.addActivity(projectState, "ok", "共享素材保持原位", new Date(), { summary: Core.basename(group.mediaPath) });
            dirtyState = true;
          }
          continue;
        }

        if (["managed", "ignored", "unsupported"].indexOf(classification.kind) >= 0) {
          if (!known) {
            projectState = State.markKnown(projectState, group.mediaPath, classification.kind, new Date(), { reason: classification.reason });
            dirtyState = true;
          }
          continue;
        }

        if (classification.kind === "review") {
          if (recordReview(group, "review", {
            type: "整组素材",
            reason: classification.reason,
            note: "插件不会移动此项。要留在原位，请把所在文件夹加入“不搬动文件夹”；要随工程交接，请完整搬移关联文件夹，在 Premiere 中重新链接后再检查。",
            revealPath: Core.dirname(group.mediaPath),
            actions: [["reveal", "打开所在位置", "secondary"], ["retry", "重新检查", "secondary"]],
          })) dirtyState = true;
          continue;
        }

        var decision = await mappingDecision(group);
        if (decision.kind.indexOf("mapping-") === 0) {
          if (recordReview(group, decision.kind, mappingReview(group, decision), {
            targetRelativePath: decision.mapping && decision.mapping.targetRelativePath || "",
          })) dirtyState = true;
          continue;
        }

        if (decision.kind === "match") {
          var mapped = await applyExistingMapping(group, decision);
          if (!mapped || mapped.applied !== true) {
            var changedDecision = mapped && mapped.decision ? mapped.decision : {
              kind: "mapping-target-unavailable",
              mapping: decision.mapping,
              targetPath: decision.targetPath,
            };
            if (recordReview(group, changedDecision.kind, mappingReview(group, changedDecision), {
              targetRelativePath: changedDecision.mapping && changedDecision.mapping.targetRelativePath || "",
            })) dirtyState = true;
          } else {
            dirtyState = true;
          }
          continue;
        }

        if (!Transaction.hasStrongFileIdentity(group.sourceFingerprint)) {
          if (recordReview(group, "source-unavailable", {
            type: "无法读取",
            reason: group.identityError || "文件可见，但宿主未提供可靠文件身份，素材未处理。",
            revealPath: Core.dirname(group.mediaPath),
            actions: [["reveal", "打开所在位置", "secondary"], ["retry", "重新检查", "secondary"]],
          })) dirtyState = true;
          continue;
        }
        pendingCount += 1;
        if (!currentAutoSetting()) continue;
        if (!group.stability || group.stability.ready !== true) continue;
        if (await previewIsMoving()) break;
        try {
          await processGroup(group, lifecycleGeneration);
        } catch (error) {
          if (error && error.code === "MATERIAL_BATCH_FILE_NOT_READY") continue;
          throw error;
        }
        pendingCount = Math.max(0, pendingCount - 1);
        dirtyState = true;
      }

      if (dirtyState) await persistState();
      await runBackgroundCleanupUnlocked();
      return { ok: true, initialized: projectState.initialized, pendingCount: pendingCount, reviewCount: reviewCount };
    } catch (error) {
      if (error && error.code === "MATERIAL_BATCH_SCAN_CANCELLED") {
        return { ok: false, cancelled: true, error: error.message };
      }
      var storageSafetyError = error && [
        "MATERIAL_BATCH_STORAGE_CONFLICT",
        "MATERIAL_BATCH_STORAGE_LOCKED",
        "MATERIAL_BATCH_STORAGE_STALE_LOCK",
        "MATERIAL_BATCH_STORAGE_LOCK_UNSUPPORTED",
      ].indexOf(error.code) >= 0;
      if (!projectState || !projectState.pendingTransaction) {
        if (!storageSafetyError) {
          reportRuntimeError("检查素材失败", error);
          panelError = userFacingRuntimeError(error, "检查当前工程时遇到问题，插件没有处理或移动任何素材。")
            + rollbackWarningSuffix(error);
          if (projectState) projectState = State.addActivity(projectState, "error", "检查已停止", new Date(), { summary: panelError });
        }
      }
      if (projectState) {
        pauseAutomaticBestEffort();
      }
      return { ok: false, error: panelError || userFacingRuntimeError(error) };
    } finally {
      busy = false;
      busyStage = "";
      render();
    }
    } finally {
      silentScan = previousSilentScan;
      render();
    }
  }

  function requestScan(options) {
    if (scanPromise) return scanPromise;
    scanPromise = operationQueue.run(function () { return scanUnlocked(options); }).catch(function (error) {
      reportRuntimeError("重新检查工程失败", error);
      panelError = userFacingRuntimeError(error);
      stateReloadRequired = true;
      if (projectState) {
        pauseAutomaticBestEffort();
      }
      render();
      return { ok: false, error: panelError };
    }).finally(function () {
      scanPromise = null;
      if (importedDuringScan) { importedDuringScan = false; requestSoonScan(); }
    });
    return scanPromise;
  }

  function onImportComplete(event) {
    var successState = ppro.Constants && ppro.Constants.OperationCompleteState
      ? ppro.Constants.OperationCompleteState.SUCCESS
      : null;
    if (!Coordination.shouldHandleOperationComplete(event, successState)) return;
    if (scanPromise || busy) { importedDuringScan = true; return; }
    requestSoonScan();
  }

  function onProjectDirty() {
    // 剪辑、补链和保存都会触发 DIRTY；新增素材由导入事件和低频轮询发现。
  }

  function attachProjectDirtyListener() {
    detachProjectDirtyListener();
    var eventName = ppro.ProjectEvent && ppro.ProjectEvent.EVENT_DIRTY
      ? ppro.ProjectEvent.EVENT_DIRTY
      : ppro.Constants && ppro.Constants.ProjectEvent
        ? ppro.Constants.ProjectEvent.DIRTY
        : null;
    if (!eventName || !context || !ppro.EventManager || typeof ppro.EventManager.addEventListener !== "function") return;
    try {
      ppro.EventManager.addEventListener(context.project, eventName, onProjectDirty);
      projectDirtyBinding = { target: context.project, eventName: eventName };
    } catch (error) {}
  }

  function detachProjectDirtyListener() {
    if (projectDirtyBinding && ppro.EventManager && typeof ppro.EventManager.removeEventListener === "function") {
      try { ppro.EventManager.removeEventListener(projectDirtyBinding.target, projectDirtyBinding.eventName, onProjectDirty); } catch (error) {}
    }
    projectDirtyBinding = null;
  }

  function attachGlobalImportListener() {
    if (globalImportAttached) return;
    var eventName = ppro.Constants && ppro.Constants.OperationCompleteEvent
      ? ppro.Constants.OperationCompleteEvent.IMPORT_MEDIA_COMPLETE
      : null;
    if (!eventName || !ppro.EventManager || typeof ppro.EventManager.addGlobalEventListener !== "function") return;
    try {
      ppro.EventManager.addGlobalEventListener(eventName, onImportComplete);
      globalImportAttached = true;
    } catch (error) {}
  }

  function detachGlobalImportListener() {
    var eventName = ppro.Constants && ppro.Constants.OperationCompleteEvent
      ? ppro.Constants.OperationCompleteEvent.IMPORT_MEDIA_COMPLETE
      : null;
    if (globalImportAttached && eventName && ppro.EventManager && typeof ppro.EventManager.removeGlobalEventListener === "function") {
      try { ppro.EventManager.removeGlobalEventListener(eventName, onImportComplete); } catch (error) {}
    }
    globalImportAttached = false;
  }

  function schedulePoll(generation) {
    if (!monitoring || !monitorGuard.isCurrent(generation)) return;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(function () {
      scanTimer = null;
      requestScan({ quiet: true }).finally(function () { schedulePoll(monitorGuard.current()); });
    }, pendingCount > 0 ? POLL_INTERVAL_MS : 10000);
  }

  function requestSoonScan() {
    if (!monitoring) return;
    if (soonTimer) clearTimeout(soonTimer);
    soonTimer = setTimeout(function () {
      soonTimer = null;
      requestScan({ quiet: true });
    }, 1200);
  }

  function startMonitor() {
    if (monitoring) return;
    monitoring = true;
    var generation = monitorGuard.bump();
    attachGlobalImportListener();
    attachProjectDirtyListener();
    schedulePoll(generation);
  }

  function stopMonitor(updateSetting) {
    if (updateSetting !== false && projectState) setMachineSetting("auto", false);
    monitoring = false;
    monitorGuard.bump();
    if (scanTimer) clearTimeout(scanTimer);
    if (soonTimer) clearTimeout(soonTimer);
    scanTimer = null;
    soonTimer = null;
    detachGlobalImportListener();
    detachProjectDirtyListener();
  }

  function syncMonitor() {
    var shouldRun = ScanPolicy.shouldMonitor({
      panelVisible: panelVisible,
      autoEnabled: currentAutoSetting() && currentProtectionSetup(),
      hasProject: Boolean(context && context.projectPath && projectState),
      pendingTransaction: Boolean(projectState && projectState.pendingTransaction && !projectState.pendingTransaction.backgroundTask),
      pendingProjectSave: Boolean(projectState && projectState.pendingProjectSave),
      unresolvedProtectedCount: unresolvedProtectedLibraries().length,
    });
    if (shouldRun) startMonitor();
    else if (monitoring) stopMonitor(false);
    return shouldRun;
  }

  async function setAutomaticUnlocked(enabled) {
    if (!context || !context.projectPath || !projectState) {
      panelError = "请先打开并保存 Premiere 工程";
      render();
      return;
    }
    var expectedIdentity = context.identity;
    if (enabled && !currentProtectionSetup()) {
      setMachineSetting("auto", false);
      setSettingsMessage("info", "请先确认哪些文件夹需要保持原位。");
      render();
      openSettingsPage();
      return;
    }
    if (enabled && storageWarning) {
      panelError = "请先重新检查整理记录，再继续自动整理";
      render();
      return;
    }
    if (projectState.pendingTransaction || projectState.pendingProjectSave) {
      panelError = "上次整理还没检查完，暂时不能继续自动整理";
      render();
      return;
    }
    await refreshProtectedMappingStatus();
    if (!(await Premiere.contextStillActive(ppro, expectedIdentity))) {
      throw new Error("设置期间活动工程已切换，请在当前工程中重新操作");
    }
    if (enabled && unresolvedProtectedLibraries().length) {
      setMachineSetting("auto", false);
      panelError = "请先在设置中重新选择交接过来的共享素材文件夹";
      render();
      return;
    }

    var firstActivation = enabled && !currentProjectSetup();
    if (enabled && State.needsCollectionPolicyAcceptance(projectState)) {
      projectState = State.acceptCollectionPolicy(projectState, new Date());
      projectState = State.addActivity(projectState, "ok", "已确认当前整理规则", new Date(), {
        summary: "工程文件夹内和不搬动名单中的素材保持原位",
      });
      var policySave = await persistState();
      assertCheckpointWriteVerified(policySave, "整理规则已经确认，但整理记录的安全复核没有完成；素材尚未移动");
      if (!(await Premiere.contextStillActive(ppro, expectedIdentity))) {
        throw new Error("确认规则期间活动工程已切换，请在当前工程中重新操作");
      }
    }

    setMachineSettings(enabled
      ? { projectSetup: true, auto: true }
      : { auto: false });
    if (!enabled) {
      stopMonitor(false);
      projectState = State.addActivity(projectState, "warn", "自动整理已暂停", new Date());
      await persistState();
      render();
      return;
    }

    panelError = "";
    var initialScan = await scanUnlocked({ initializeCollection: !projectState.initialized, skipRefresh: true });
    if (!initialScan || !initialScan.ok) {
      setMachineSetting("auto", false);
      stopMonitor(false);
      render();
      return;
    }
    if (firstActivation) {
      projectState = State.addActivity(projectState, "ok", "已为此工程开启自动整理", new Date(), {
        summary: Core.basename(context.projectPath),
      });
      await persistState();
    }
    if (!projectState.pendingTransaction && !projectState.pendingProjectSave && currentAutoSetting()) {
      syncMonitor();
      requestSoonScan();
    }
    render();
  }

  function setAutomatic(enabled) {
    return operationQueue.run(async function () {
      await refreshContext({ force: true });
      return setAutomaticUnlocked(enabled);
    }).catch(function (error) {
      reportRuntimeError("开启或暂停自动整理失败", error);
      try { setMachineSetting("auto", false); } catch (settingsError) {}
      stopMonitor(false);
      panelError = userFacingRuntimeError(error, "无法更改自动整理状态，请重新检查当前工程后再试。");
      render();
    });
  }

  async function openDirectory(nativePath, label) {
    if (!Core.isAbsoluteLocalPath(nativePath)) throw new Error("无法确定要打开的文件夹");
    if (/^[A-Za-z]:[\\/]/.test(nativePath) && RecycleBridge) {
      var folder = await uxp.storage.localFileSystem.getPluginFolder();
      await RecycleBridge.create({ fs: fs, uxp: uxp, pluginPath: folder.nativePath }).revealDirectory(nativePath, label);
      return;
    }
    var result = await uxp.shell.openPath(nativePath, label);
    if (result) throw new Error(String(result));
  }

  async function openCurrentBatch() {
    if (openingFolder) return;
    openingFolder = true;
    folderActionMessage = "正在打开当前文件夹…";
    render();
    try {
      if (!context || !context.projectPath || !projectState) throw new Error("请先打开并保存 Premiere 工程");
      var expectedIdentity = context.identity;
      var currentDirectory = await verifyExistingBatchDirectory();
      if (!(await Premiere.contextStillActive(ppro, expectedIdentity))) throw new Error("工程已切换，未打开上一个工程的文件夹");
      await openDirectory(currentDirectory, "打开当前素材文件夹");
      folderActionMessage = "已请求打开当前文件夹";
    } catch (error) {
      reportRuntimeError("打开当前素材文件夹失败", error);
      folderActionMessage = userFacingRuntimeError(error, "无法打开当前素材文件夹，请检查工程所在磁盘是否已连接后重试。");
    } finally {
      openingFolder = false;
      render();
    }
  }

  async function openRecoveryTarget() {
    folderActionMessage = "";
    await operationQueue.run(async function () {
      await refreshContext();
      var record = currentRecoveryRecord();
      var targetPath = recoveryTargetPath(record);
      if (!record || !targetPath) throw new Error("当前没有可打开的新位置");
      await openDirectory(Core.dirname(targetPath), "打开整理后的新位置");
    }).catch(function (error) {
      reportRuntimeError("打开整理后的新位置失败", error);
      recoveryMessage = userFacingRuntimeError(error, "无法打开新位置，请检查工程所在磁盘是否已连接。未改动任何文件。");
      render();
    });
  }

  async function openRecoverySource() {
    folderActionMessage = "";
    await operationQueue.run(async function () {
      await refreshContext();
      var record = currentRecoveryRecord();
      var snapshot = matchingRecoverySnapshot(record);
      var sourcePath = recoverySourcePath(record, snapshot);
      if (!record || !sourcePath) throw new Error("当前没有可打开的原素材位置");
      await openDirectory(Core.dirname(sourcePath), "打开原素材所在位置");
    }).catch(function (error) {
      reportRuntimeError("打开原素材所在位置失败", error);
      recoveryMessage = userFacingRuntimeError(error, "无法打开原素材所在位置，请检查磁盘是否已连接。未改动任何文件。");
      render();
    });
  }

  function recoveryEntries(inventory, itemIds) {
    var byId = {};
    (inventory && inventory.entries || []).forEach(function (entry) {
      if (entry.itemId) byId[String(entry.itemId)] = entry;
    });
    var entries = (itemIds || []).map(function (itemId) { return byId[String(itemId)]; });
    if (!entries.length || entries.some(function (entry) { return !entry; })) {
      throw new Error("核对期间素材项发生变化，未继续处理");
    }
    return entries;
  }

  function confirmRecoveryContinuation(pending, outcome) {
    var itemCount = Math.max(1, Number(pending.itemCount) || 1);
    var linkLine = outcome.currentLinkState === "target"
      ? "Premiere 已指向新位置，将重新核验并保存工程。"
      : outcome.currentLinkState === "mixed"
        ? "部分素材项仍在原位置，将统一更新到新位置。"
        : "Premiere 仍指向原位置，将更新到新位置。";
    var message = "已核对：原位置" + (outcome.sourceExists ? "存在" : "未找到")
      + "，新位置" + (outcome.targetExists ? "存在" : "未找到") + "。\n"
      + linkLine + "\n\n"
      + "继续后会处理 " + itemCount + " 个素材项，保存当前 Premiere 工程，并在再次核验通过后清理原位置的原素材。"
      + "\n不会移动、复制或备份 .prproj 工程文件。\n\n确认继续？";
    return confirmation.request(message);
  }

  function confirmProjectSaveRecovery(pending, currentLinkState) {
    var linkLine = currentLinkState === "target"
      ? "Premiere 已指向新位置，将重新核验并保存当前工程。"
      : currentLinkState === "mixed"
        ? "部分素材项仍在原位置，将统一更新到新位置并保存当前工程。"
        : "Premiere 仍指向原位置，将更新链接并保存当前工程。";
    var message = "已核对新位置文件。\n" + linkLine
      + "\n\n不会移动、复制、删除或备份 .prproj 工程文件，也不会删除原位置素材。\n\n确认继续？";
    return confirmation.request(message);
  }

  async function verifyRecoveryEntriesAtTarget(entries, targetPath) {
    for (var index = 0; index < entries.length; index += 1) {
      if (!(await Transaction.waitForVerifiedLink(entries[index].clip, targetPath, function (milliseconds) {
        return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
      }))) {
        throw new Error("一个 Premiere 素材项仍未确认链接到新位置");
      }
    }
  }

  async function deletionInventorySnapshot(sourcePath, targetPath, expectedItemIds, cleanupPath) {
    if (!context || !context.project || !(await Premiere.contextStillActive(ppro, context.identity))) {
      throw new Error("删除原素材前活动工程已切换");
    }
    var inventory = await Premiere.inventoryProject(ppro, context.project);
    Premiere.assertCompleteInventory(inventory);
    if (typeof Premiere.verifyNoTimelineSourceReferences === "function") await Premiere.verifyNoTimelineSourceReferences(ppro, context.project, sourcePath, cleanupPath);
    var expectedIds = (expectedItemIds || []).map(String).filter(Boolean);
    if (!expectedIds.length || new Set(expectedIds).size !== expectedIds.length) {
      throw new Error("删除原素材前缺少完整且唯一的素材项身份");
    }
    var candidates = inventory.entries.filter(function (entry) {
      return Core.samePath(entry.mediaPath, sourcePath)
        || Core.samePath(entry.mediaPath, targetPath)
        || (cleanupPath && Core.samePath(entry.mediaPath, cleanupPath));
    });
    var candidateIds = candidates.map(function (entry) { return String(entry.itemId || ""); });
    var candidateIdSet = new Set(candidateIds);
    if (candidateIds.some(function (itemId) { return !itemId; })
      || candidateIdSet.size !== candidateIds.length
      || candidateIds.length !== expectedIds.length
      || expectedIds.some(function (itemId) { return !candidateIdSet.has(itemId); })) {
      throw new Error("删除原素材前，当前工程引用该文件的素材项集合发生变化");
    }
    await verifyRecoveryEntriesAtTarget(candidates, targetPath);
    if (!(await Premiere.contextStillActive(ppro, context.identity))) {
      throw new Error("删除原素材前活动工程已切换");
    }
    return candidates;
  }

  async function verifyCompleteInventoryBeforeDelete(sourcePath, targetPath, expectedItemIds, cleanupPath) {
    await deletionInventorySnapshot(sourcePath, targetPath, expectedItemIds, cleanupPath);
    // 链接核验需要等待宿主刷新；再次读取完整清单，覆盖等待期间新增或替换素材项的情况。
    await deletionInventorySnapshot(sourcePath, targetPath, expectedItemIds, cleanupPath);
    return true;
  }

  async function inspectPendingTransactionRecord(pending) {
    var targetPath = targetPathForMapping(pending);
    var inventory = await Premiere.inventoryProject(ppro, context.project);
    Premiere.assertCompleteInventory(inventory);
    var outcome = await Recovery.inspectPending({
      fs: fs,
      pending: pending,
      targetPath: targetPath,
      mediaRoot: mediaRoot(),
      linkedEntries: inventory.entries.map(function (entry) {
        return { itemId: entry.itemId, itemName: entry.itemName, mediaPath: entry.mediaPath };
      }),
    });
    return { targetPath: targetPath, outcome: outcome };
  }

  function confirmCloseLegacyRecovery(record, targetPath) {
    var message = "保留现状并暂缓这条旧记录？\n\n"
      + "原位置和新位置的文件都会保持现在的样子，插件不会移动或删除素材，不会修改 Premiere 链接，也不会保存工程。\n\n"
      + "自动整理会继续暂停。关闭后，请自行确认最终要保留哪一份文件。\n\n"
      + "原位置：" + record.sourcePath + "\n新位置：" + targetPath;
    return confirmation.request(message);
  }

  async function closeLegacyRecoveryRecord() {
    await operationQueue.run(async function () {
      await refreshContext({ force: true });
      if (!context || !context.projectPath || !projectState || !projectState.pendingTransaction) {
        throw new Error("当前没有可以关闭的旧整理记录");
      }
      var pending = projectState.pendingTransaction;
      if (pending.projectPath && !Core.samePath(pending.projectPath, context.projectPath)) {
        throw new Error("请先打开这条旧记录所属的工程：" + Core.basename(pending.projectPath));
      }
      if (pending.projectIdentity && pending.projectIdentity !== context.identity) {
        throw new Error("当前工程与这条旧整理记录不一致");
      }
      busy = true;
      busyStage = "scan";
      render();

      var inspected = await inspectPendingTransactionRecord(pending);
      recoverySnapshot = Object.assign({ id: pending.id }, inspected.outcome);
      recoveryMessage = inspected.outcome.reason || "核对完成，未改动任何文件。";
      render();
      if (!canCloseLegacyRecoveryRecord(pending, recoverySnapshot)) {
        throw new Error("当前现场不符合安全关闭条件，旧记录和所有文件都已保留");
      }
      if (!(await confirmCloseLegacyRecovery(pending, inspected.targetPath))) {
        recoveryMessage = "已取消关闭。旧记录、两处文件和 Premiere 链接均保持不变。";
        return;
      }
      if (!(await Premiere.contextStillActive(ppro, context.identity))) {
        throw new Error("关闭记录前活动工程已切换，旧记录仍然保留");
      }

      var confirmedInspection = await inspectPendingTransactionRecord(pending);
      recoverySnapshot = Object.assign({ id: pending.id }, confirmedInspection.outcome);
      recoveryMessage = confirmedInspection.outcome.reason || "二次核对完成，未改动任何文件。";
      if (!Core.samePath(confirmedInspection.targetPath, inspected.targetPath)
        || !Transaction.sameStrongPathFingerprint(inspected.outcome.sourceFingerprint, confirmedInspection.outcome.sourceFingerprint)
        || !Transaction.sameStrongPathFingerprint(inspected.outcome.targetFingerprint, confirmedInspection.outcome.targetFingerprint)
        || !canCloseLegacyRecoveryRecord(pending, recoverySnapshot)) {
        throw new Error("确认期间文件或 Premiere 链接状态发生变化，旧记录和所有文件都已保留");
      }
      if (!(await Premiere.contextStillActive(ppro, context.identity))) {
        throw new Error("二次核对后活动工程已切换，旧记录仍然保留");
      }

      setMachineSetting("auto", false);

      var previousState = projectState;
      try {
        projectState = State.deferTransaction(projectState, new Date());
        projectState = State.addActivity(projectState, "warn", "已保留现场并暂缓旧整理记录", new Date(), {
          summary: Core.basename(pending.sourcePath),
          transactionId: String(pending.id || ""),
          sourcePath: String(pending.sourcePath || ""),
          targetPath: String(inspected.targetPath || ""),
          reason: String(inspected.outcome.reason || ""),
        });
        await persistState();
      } catch (persistError) {
        projectState = previousState;
        throw persistError;
      }
      panelError = "";
      recoverySnapshot = null;
      recoveryMessage = "";
      folderActionMessage = "旧记录已暂缓保留；文件和 Premiere 链接均未改动，可从需处理素材中继续核验。";
    }).catch(function (error) {
      reportRuntimeError("暂缓旧整理记录失败", error);
      recoveryMessage = userFacingRuntimeError(error, "无法安全暂缓这条旧记录，记录和所有文件均已保留。请重新核对后再试。");
    }).finally(function () {
      busy = false;
      busyStage = "";
      syncMonitor();
      render();
    });
  }

  function withoutDigest(fingerprint) {
    var result = Object.assign({}, fingerprint);
    delete result.sha256;
    return result;
  }

  async function checkRecycleAvailability(generation) {
    if (!/^[A-Za-z]:[\\/]/.test(context.workspaceRoot)) return;
    if (!RecycleBridge) throw new Error("回收助手组件未加载，素材未处理");
    var identity = context.identity;
    var folder = await uxp.storage.localFileSystem.getPluginFolder();
    var checker = RecycleBridge.create({ fs: fs, uxp: uxp, pluginPath: folder.nativePath,
      cancelled: function () { return !lifecycleGuard.isCurrent(generation); } });
    await checker.checkAvailability();
    if (!lifecycleGuard.isCurrent(generation) || !(await Premiere.contextStillActive(ppro, identity)))
      throw new Error("检查助手期间工程或面板已切换，素材未处理");
  }

  async function recycleCurrentSource(details) {
    var pending = projectState && projectState.pendingTransaction;
    if (!pending || !FileService || !RecycleBridge) throw new Error("回收组件不可用，原文件保留");
    if (!/^[A-Za-z]:[\\/]/.test(details.path)) throw new Error("此磁盘的系统回收接口尚未验收，原文件保留；不会永久删除");
    var expectedIdentity = context.identity;
    var pluginFolder = await uxp.storage.localFileSystem.getPluginFolder();
    var recycleGeneration = lifecycleGuard.current();
    var bridge = RecycleBridge.create({ fs: fs, uxp: uxp, pluginPath: pluginFolder.nativePath,
      cancelled: function () { return recoveryCancelled || !lifecycleGuard.isCurrent(recycleGeneration); },
      validate: function () { return lifecycleGuard.isCurrent(recycleGeneration) && Premiere.contextStillActive(ppro, expectedIdentity); },
      beforeCommit: async function (job) {
        if (!projectState.pendingTransaction || projectState.pendingTransaction.id !== pending.id) return false;
        await verifyCompleteInventoryBeforeDelete(pending.sourcePath, details.targetPath, projectState.pendingTransaction.itemIds, pending.cleanupPath);
        projectState = State.updatePendingTransaction(projectState, { status: "recycle-issued" }, new Date());
        assertCheckpointWriteVerified(await persistState(), "回收提交记录未可靠保存，原文件保留");
        await fs.writeFile(job.issuedPath, JSON.stringify({ id: job.jobId, transactionId: pending.id }), { encoding: "utf-8", flag: "wx" });
        return true;
      },
      onProgress: function (stage, progress) {
        busyStage = stage === "committed" ? "cleanup" : "verify-content";
        if (progress && Number.isFinite(progress.checkedBytes)) recoveryMessage = "回收前完整核验：" + formatBytes(progress.checkedBytes) + " / " + formatBytes(progress.totalBytes);
        render();
      },
    });
    var request = pending.recycleRequest;
    if (request) {
      var previous = await bridge.query(request);
      if ((previous.state === "result" && previous.value.status === "failed") || previous.state === "cancelled") {
        projectState = State.updatePendingTransaction(projectState, {
          recycleAttempts: (pending.recycleAttempts || []).concat([{ request: request, result: { status: previous.value.status, message: previous.value.message || "" } }]),
          recycleRequest: null,
        }, new Date());
        assertCheckpointWriteVerified(await persistState(), "旧回收失败记录未可靠保存");
        request = null;
      }
    }
    if (!request) {
      var verified = await FileService.compareFiles({ fs: fs, sourcePath: details.path, targetPath: details.targetPath,
        cancelled: function () { return recoveryCancelled || !lifecycleGuard.isCurrent(recycleGeneration); },
        validate: function () { return Premiere.contextStillActive(ppro, expectedIdentity); },
        onProgress: function (progress) { recoveryMessage = "正在核验回收内容：" + formatBytes(progress.checkedBytes) + " / " + formatBytes(progress.totalBytes); render(); },
      });
      request = { id: Array.from({ length: 4 }, function () { return Math.floor(Math.random() * 4294967296).toString(16).padStart(8, "0"); }).join(""),
        path: details.path, targetPath: details.targetPath, sourceFingerprint: verified.sourceFingerprint,
        targetFingerprint: verified.targetFingerprint, workspaceRoot: context.workspaceRoot, statePath: Storage.statePath(context.workspaceRoot) };
      projectState = State.updatePendingTransaction(projectState, { recycleRequest: request, status: "recycle-prepared" }, new Date());
      assertCheckpointWriteVerified(await persistState(), "回收准备记录未可靠保存，原文件保留");
    }
    if (!Core.samePath(request.path, details.path) || !Core.samePath(request.targetPath, details.targetPath)) throw new Error("回收请求路径与事务不一致");
    var receipt = await bridge.recycle(request);
    projectState = State.updatePendingTransaction(projectState, { recycleReceipt: { id: receipt.id, status: receipt.status, path: receipt.path, receiptId: receipt.receiptId }, status: "recycled" }, new Date());
    assertCheckpointWriteVerified(await persistState(), "回收结果尚未可靠记入工程，记录已保留");
    return receipt;
  }

  async function recoverPendingTransaction(recoveryOptions) {
    recoveryOptions = recoveryOptions || {};
    recoveryCancelled = false;
    var recoverWork = async function () {
      if (!recoveryOptions.automatic) await refreshContext();
      if (!context || !context.projectPath) throw new Error("请先打开并保存 Premiere 工程");
      projectState = await readProjectState(context);
      var pendingProjectSave = projectState && projectState.pendingProjectSave;
      var pending = projectState && projectState.pendingTransaction;
      var automaticGeneration = lifecycleGuard.current();
      var automaticIdentity = context.identity;
      async function automaticContextValid() {
        return !recoveryOptions.automatic || (panelVisible && lifecycleGuard.isCurrent(automaticGeneration)
          && currentAutoSetting() && await Premiere.contextStillActive(ppro, automaticIdentity));
      }
      async function assertAutomaticContext() {
        if (await automaticContextValid()) return;
        var changed = new Error("工程或面板已切换，后台处理已停止");
        changed.code = "MATERIAL_BATCH_CONTEXT_CHANGED";
        throw changed;
      }
      if (recoveryOptions.automatic) {
        if (!pending || !pending.backgroundTask || pending.backgroundTask.kind !== "cleanup"
          || !currentAutoSetting() || !currentProjectSetup() || !currentProtectionSetup()
          || storageWarning || stateReloadRequired || State.needsCollectionPolicyAcceptance(projectState)
          || unresolvedProtectedLibraries().length) throw new Error("后台等待条件已变化，原件保留");
        backgroundOperation = true;
      }
      if (!pending && !pendingProjectSave) {
        panelError = "";
        return scanUnlocked();
      }
      if (!recoveryOptions.automatic) setMachineSetting("auto", false);
      if (pending && pendingProjectSave) {
        throw new Error("整理记录同时存在两种未完成操作，已停止自动处理");
      }
      if (pendingProjectSave) {
        if (pendingProjectSave.projectPath && !Core.samePath(pendingProjectSave.projectPath, context.projectPath)) {
          throw new Error("请先打开需要重新保存的工程：" + Core.basename(pendingProjectSave.projectPath));
        }
        if (pendingProjectSave.projectIdentity && pendingProjectSave.projectIdentity !== context.identity) {
          throw new Error("当前工程与待保存的补链记录不一致");
        }
        var pendingSaveBlockReason = recoverySourceBlockReason(pendingProjectSave.sourcePath);
        if (pendingSaveBlockReason) {
          recoveryMessage = pendingSaveBlockReason + " 相关文件均未改动。";
          render();
          return;
        }

        busy = true;
        busyStage = "scan";
        render();
        try {
          var pendingTargetPath = targetPathForMapping(pendingProjectSave);
          var pendingTargetFingerprint = await currentFileFingerprint(pendingTargetPath);
          if (!Transaction.sameStrongPathFingerprint(pendingProjectSave.targetFingerprint, pendingTargetFingerprint)) {
            throw new Error("记录中的新位置文件已经变化，未重新保存 Premiere 工程");
          }

          var pendingInventory = await Premiere.inventoryProject(ppro, context.project);
          Premiere.assertCompleteInventory(pendingInventory);
          var expectedItemIds = Array.isArray(pendingProjectSave.itemIds)
            ? pendingProjectSave.itemIds.map(String).filter(Boolean)
            : [];
          if (!expectedItemIds.length
            || expectedItemIds.length !== Number(pendingProjectSave.itemCount)
            || new Set(expectedItemIds).size !== expectedItemIds.length) {
            throw new Error("补链记录缺少完整的素材项身份，或身份存在重复，不能自动重新保存");
          }
          var entryById = {};
          pendingInventory.entries.forEach(function (entry) {
            if (entry.itemId) entryById[String(entry.itemId)] = entry;
          });
          var pendingEntries = expectedItemIds.map(function (itemId) { return entryById[itemId]; });
          var missingSavedEntries = pendingEntries.filter(function (entry) { return !entry; }).length;
          var rebuiltSavedEntries = false;
          if (missingSavedEntries) {
            var savedCandidates = pendingInventory.entries.filter(function (entry) {
              return entry.itemId && (
                Core.samePath(entry.mediaPath, pendingProjectSave.sourcePath)
                || Core.samePath(entry.mediaPath, pendingTargetPath)
              );
            });
            var savedCandidateIds = savedCandidates.map(function (entry) { return String(entry.itemId); });
            if (missingSavedEntries !== expectedItemIds.length
              || savedCandidates.length !== Number(pendingProjectSave.itemCount)
              || new Set(savedCandidateIds).size !== savedCandidateIds.length) {
              throw new Error("当前工程中的旧素材项身份已经失效，且无法得到唯一候选，未自动重新保存");
            }
            pendingEntries = savedCandidates;
            expectedItemIds = savedCandidateIds;
            rebuiltSavedEntries = true;
          }
          var entriesAtSource = pendingEntries.filter(function (entry) {
            return Core.samePath(entry.mediaPath, pendingProjectSave.sourcePath);
          });
          var entriesAtTarget = pendingEntries.filter(function (entry) {
            return Core.samePath(entry.mediaPath, pendingTargetPath);
          });
          if (entriesAtSource.length + entriesAtTarget.length !== pendingEntries.length) {
            throw new Error("素材项已指向记录之外的位置，未自动改动或保存工程");
          }
          await verifyRecoveryEntriesAtTarget(entriesAtTarget, pendingTargetPath);
          var savedSourceExists = await Transaction.exists(fs, pendingProjectSave.sourcePath);
          var savedSourceSize = 0;
          if (savedSourceExists) {
            try { savedSourceSize = Transaction.statSize(await fs.lstat(pendingProjectSave.sourcePath)); } catch (sourceReadError) {}
          }
          var savedLinkState = entriesAtSource.length === pendingEntries.length
            ? "source"
            : entriesAtTarget.length === pendingEntries.length ? "target" : "mixed";
          recoverySnapshot = {
            id: pendingProjectSave.id,
            sourceExists: savedSourceExists,
            targetExists: true,
            sourceSize: savedSourceSize,
            targetSize: Transaction.statSize(pendingTargetFingerprint),
            currentLinkState: savedLinkState,
          };
          recoveryMessage = rebuiltSavedEntries
            ? "Premiere 重启后素材项身份已变化，但已找到唯一候选。继续前需要你确认。"
            : "核对完成，等待你确认是否更新链接并保存工程。";
          render();
          if (!(await confirmProjectSaveRecovery(pendingProjectSave, savedLinkState))) {
            recoveryMessage = "已核对，尚未更新链接或保存工程。";
            return;
          }

          var confirmedSavedInventory = await Premiere.inventoryProject(ppro, context.project);
          Premiere.assertCompleteInventory(confirmedSavedInventory);
          var confirmedSavedEntries = recoveryEntries(confirmedSavedInventory, expectedItemIds);
          if (confirmedSavedEntries.some(function (entry) {
            return !Core.samePath(entry.mediaPath, pendingProjectSave.sourcePath)
              && !Core.samePath(entry.mediaPath, pendingTargetPath);
          })) {
            throw new Error("确认期间素材项链接发生变化，未继续处理");
          }
          var confirmedEntriesAtSource = confirmedSavedEntries.filter(function (entry) {
            return Core.samePath(entry.mediaPath, pendingProjectSave.sourcePath);
          });
          var confirmedEntriesAtTarget = confirmedSavedEntries.filter(function (entry) {
            return Core.samePath(entry.mediaPath, pendingTargetPath);
          });
          await verifyRecoveryEntriesAtTarget(confirmedEntriesAtTarget, pendingTargetPath);
          if (rebuiltSavedEntries) {
            projectState = State.updatePendingProjectSave(projectState, {
              id: pendingProjectSave.id,
              itemIds: expectedItemIds,
              itemCount: expectedItemIds.length,
              itemSignatures: confirmedSavedEntries.map(function (entry) {
                return { itemId: String(entry.itemId || ""), itemName: String(entry.itemName || ""), mediaPath: String(entry.mediaPath || "") };
              }),
              status: "recovery-confirmed",
              recoveryConfirmedAt: new Date().toISOString(),
            }, new Date());
            var rebuiltSaveCheckpoint = await persistState();
            assertCheckpointWriteVerified(
              rebuiltSaveCheckpoint,
              "恢复确认记录已经写入，但状态写锁未能清理；Premiere 链接尚未修改"
            );
          }

          if (confirmedEntriesAtSource.length) {
            busyStage = "relink";
            render();
            await Transaction.relinkExisting({
              fs: fs,
              projectItems: confirmedEntriesAtSource.map(function (entry) { return entry.clip; }),
              sourcePath: pendingProjectSave.sourcePath,
              targetPath: pendingTargetPath,
              validate: function () { return Premiere.contextStillActive(ppro, context.identity); },
              persistProject: function () { return context.project.save(); },
            });
          } else {
            busyStage = "save";
            render();
            if ((await context.project.save()) === false) throw new Error("Premiere 工程仍未保存");
          }
          if (!(await Premiere.contextStillActive(ppro, context.identity))) {
            throw new Error("重新保存期间活动工程已切换");
          }
          var afterSaveFingerprint = await currentFileFingerprint(pendingTargetPath);
          if (!Transaction.sameStrongPathFingerprint(pendingTargetFingerprint, afterSaveFingerprint)) {
            throw new Error("重新保存期间新位置文件发生变化，已保留待检查记录");
          }
          var savedAfterInventory = await Premiere.inventoryProject(ppro, context.project);
          Premiere.assertCompleteInventory(savedAfterInventory);
          var savedAfterEntries = recoveryEntries(savedAfterInventory, expectedItemIds);
          await verifyRecoveryEntriesAtTarget(savedAfterEntries, pendingTargetPath);
          await verifyRecoveryTargetFingerprint(pendingTargetPath, pendingTargetFingerprint, "最终核验时");

          projectState = State.clearPendingProjectSave(projectState, new Date());
          projectState = State.addActivity(projectState, "ok", "已确认 Premiere 工程保存完成", new Date(), {
            summary: Core.basename(pendingTargetPath),
          });
          await persistState();
          panelError = "";
          recoverySnapshot = null;
          recoveryMessage = "";
          return;
        } catch (saveError) {
          if (!projectState.pendingProjectSave) {
            projectState = State.beginProjectSave(projectState, pendingProjectSave, new Date());
          }
          projectState = State.failProjectSave(projectState, saveError.message || saveError, new Date());
          try { await persistState(); } catch (persistError) {}
          throw saveError;
        }
      }
      if (pending.projectPath && !Core.samePath(pending.projectPath, context.projectPath)) {
        throw new Error("请先打开上次整理素材时使用的工程：" + Core.basename(pending.projectPath));
      }
      if (pending.projectIdentity && pending.projectIdentity !== context.identity) {
        throw new Error("当前工程与上次整理记录不一致");
      }
      var pendingBlockReason = recoverySourceBlockReason(pending.sourcePath);
      if (pendingBlockReason) {
        if (recoveryOptions.automatic) throw new Error(pendingBlockReason);
        recoveryMessage = pendingBlockReason + " 相关文件均未改动。";
        render();
        return;
      }

      busy = true;
      busyStage = "scan";
      render();
      var inspected = await inspectPendingTransactionRecord(pending);
      await assertAutomaticContext();
      var targetPath = inspected.targetPath;
      var outcome = inspected.outcome;
      if (outcome.kind === "manual" && recoveryOptions.verifyLegacy === true
        && outcome.sourceExists === true && outcome.targetExists === true) {
        if (!(await confirmation.request("完整核验两份素材后继续整理？核验一致才会更新链接、保存工程并把原文件放入回收站。\n原位置：" + pending.sourcePath + "\n新位置：" + targetPath))) return;
        busyStage = "verify-content";
        var generation = lifecycleGuard.current();
        var verified = await FileService.compareFiles({ fs: fs, sourcePath: pending.sourcePath, targetPath: targetPath,
          cancelled: function () { return recoveryCancelled || !lifecycleGuard.isCurrent(generation); },
          validate: function () { return Premiere.contextStillActive(ppro, context.identity); },
          onProgress: function (progress) { recoveryMessage = "完整核验：" + formatBytes(progress.checkedBytes) + " / " + formatBytes(progress.totalBytes); render(); },
        });
        var inventory = await Premiere.inventoryProject(ppro, context.project);
        Premiere.assertCompleteInventory(inventory);
        var candidates = inventory.entries.filter(function (entry) { return Core.samePath(entry.mediaPath, pending.sourcePath) || Core.samePath(entry.mediaPath, targetPath); });
        var ids = candidates.map(function (entry) { return String(entry.itemId || ""); });
        if (ids.length !== Math.max(1, Number(pending.itemCount) || 1) || ids.some(function (id) { return !id; }) || new Set(ids).size !== ids.length) throw new Error("无法唯一确认当前素材项，两份文件均保留");
        projectState = State.updatePendingTransaction(projectState, {
          sourceFingerprint: withoutDigest(verified.sourceFingerprint), targetFingerprint: withoutDigest(verified.targetFingerprint),
          byteCount: verified.byteCount, itemIds: ids, itemCount: ids.length,
          targetMethod: verified.sourceFingerprint.dev === verified.targetFingerprint.dev && verified.sourceFingerprint.ino === verified.targetFingerprint.ino ? "link" : "copy",
          legacyVerification: { at: verified.verifiedAt, digest: verified.sourceFingerprint.sha256, previousSourceFingerprint: pending.sourceFingerprint || null },
        }, new Date());
        assertCheckpointWriteVerified(await persistState(), "核验凭据未可靠保存，未继续整理");
        pending = projectState.pendingTransaction;
        inspected = await inspectPendingTransactionRecord(pending);
        outcome = inspected.outcome;
      }
      recoverySnapshot = Object.assign({ id: pending.id }, outcome);
      recoveryMessage = outcome.reason || "核对完成，尚未改动任何文件。";
      render();

      if (outcome.kind === "manual") {
        if (recoveryOptions.automatic) throw new Error(outcome.reason || "无法唯一确认这项素材，已保留文件");
        recoveryMessage += canCloseLegacyRecoveryRecord(pending, recoverySnapshot)
          ? " 未改动任何文件。你可以暂缓此素材，记录不会丢失。"
          : " 未改动任何文件，旧记录继续保留。";
        return;
      }
      if (!(await Premiere.contextStillActive(ppro, context.identity))) throw new Error("恢复检查期间活动工程已切换");
      if (outcome.kind === "rolled-back") {
        projectState = State.clearPendingTransaction(projectState, new Date());
        projectState = State.addActivity(projectState, "ok", "已确认上次整理安全回滚", new Date(), {
          summary: Core.basename(pending.sourcePath),
        });
        await persistState();
        panelError = "";
        recoverySnapshot = null;
        recoveryMessage = "";
        return;
      }
      if (outcome.targetExists !== true) {
        throw new Error("恢复时找不到新位置文件，已保留待检查记录，请人工检查");
      }
      var resolvedItemIds = Array.isArray(outcome.resolvedItemIds) ? outcome.resolvedItemIds.map(String).filter(Boolean) : [];
      if (resolvedItemIds.length !== Math.max(1, Number(pending.itemCount) || 1)
        || new Set(resolvedItemIds).size !== resolvedItemIds.length) {
        throw new Error("无法得到完整且唯一的素材项候选，未继续处理");
      }
      var recoveryTargetFingerprint = outcome.targetFingerprint || await currentFileFingerprint(targetPath);
      if (!Transaction.hasStrongFileIdentity(pending.targetFingerprint)
        || !Transaction.hasStrongFileIdentity(recoveryTargetFingerprint)
        || (!Transaction.sameStrongPathFingerprint(pending.targetFingerprint, recoveryTargetFingerprint)
          && !(outcome.targetCheckpointMatch === "hard-link"
            && Transaction.sameHardLinkRecoveryFingerprint(pending.targetFingerprint, recoveryTargetFingerprint)))) {
        throw new Error("恢复检查后新位置文件已发生变化，已保留待检查记录，请人工检查");
      }
      recoveryMessage = recoveryOptions.automatic ? "正在继续整理" : "核对完成，等待你确认是否继续。";
      render();
      if (!recoveryOptions.automatic && !(await confirmRecoveryContinuation(pending, outcome))) {
        recoveryMessage = "已核对，尚未继续。原位置和新位置都没有改动。";
        return;
      }

      var confirmedInventory = await Premiere.inventoryProject(ppro, context.project);
      Premiere.assertCompleteInventory(confirmedInventory);
      var confirmedEntries = recoveryEntries(confirmedInventory, resolvedItemIds);
      if (confirmedEntries.some(function (entry) {
        return !Core.samePath(entry.mediaPath, pending.sourcePath) && !Core.samePath(entry.mediaPath, targetPath);
      })) {
        throw new Error("确认期间素材项链接发生变化，未继续处理");
      }
      var currentItemSignatures = confirmedEntries.map(function (entry) {
        return { itemId: String(entry.itemId || ""), itemName: String(entry.itemName || ""), mediaPath: String(entry.mediaPath || "") };
      });
      projectState = State.updatePendingTransaction(projectState, {
        id: pending.id,
        itemIds: resolvedItemIds,
        itemCount: resolvedItemIds.length,
        itemSignatures: currentItemSignatures,
        targetFingerprint: recoveryTargetFingerprint,
        status: "recovery-confirmed",
        recoveryConfirmedAt: new Date().toISOString(),
      }, new Date());
      await verifyRecoveryTargetFingerprint(targetPath, recoveryTargetFingerprint, "确认后");
      var recoveryCheckpointSave = await persistState();
      assertCheckpointWriteVerified(
        recoveryCheckpointSave,
        "恢复确认记录已经写入，但状态写锁未能清理；Premiere 链接和原位置文件尚未修改"
      );
      await verifyRecoveryTargetFingerprint(targetPath, recoveryTargetFingerprint, "改链前");
      await assertAutomaticContext();

      var entriesAtSource = confirmedEntries.filter(function (entry) {
        return Core.samePath(entry.mediaPath, pending.sourcePath);
      });
      var entriesAtTarget = confirmedEntries.filter(function (entry) {
        return Core.samePath(entry.mediaPath, targetPath);
      });
      await verifyRecoveryEntriesAtTarget(entriesAtTarget, targetPath);
      var relinkWarnings = [];
      busyStage = entriesAtSource.length ? "relink" : "save";
      render();
      if (entriesAtSource.length) {
        var relinkResult = await Transaction.relinkExisting({
          fs: fs,
          projectItems: entriesAtSource.map(function (entry) { return entry.clip; }),
          sourcePath: pending.sourcePath,
          targetPath: targetPath,
          validate: function () { return Premiere.contextStillActive(ppro, context.identity); },
          persistProject: saveProjectWithEvidence,
        });
        relinkWarnings = Array.isArray(relinkResult.warnings) ? relinkResult.warnings : [];
      } else if (!(await canReuseProjectSave(targetPath, resolvedItemIds)) && (await saveProjectWithEvidence()) === false) {
        throw new Error("Premiere 工程仍未保存，原位置文件未处理");
      }
      if (!(await Premiere.contextStillActive(ppro, context.identity))) {
        throw new Error("恢复保存期间活动工程已切换");
      }
      await verifyRecoveryTargetFingerprint(targetPath, recoveryTargetFingerprint, "保存后");
      await assertAutomaticContext();

      var afterSaveInventory = await Premiere.inventoryProject(ppro, context.project);
      Premiere.assertCompleteInventory(afterSaveInventory);
      var afterSaveEntries = recoveryEntries(afterSaveInventory, resolvedItemIds);
      await verifyRecoveryEntriesAtTarget(afterSaveEntries, targetPath);

      busyStage = "cleanup";
      render();
      var cleanupResult = await Transaction.cleanupVerifiedSource({
        sourceDisposition: "recycle",
        recycle: recycleCurrentSource,
        id: pending.id,
        fs: fs,
        sourcePath: pending.sourcePath,
        cleanupPath: pending.cleanupPath,
        sourceFingerprint: pending.sourceFingerprint,
        targetPath: targetPath,
        targetFingerprint: recoveryTargetFingerprint,
        targetMethod: pending.targetMethod,
        projectItems: afterSaveEntries.map(function (entry) { return entry.clip; }),
        validate: async function () { return await automaticContextValid() && await Premiere.contextStillActive(ppro, automaticIdentity); },
        beforeSourceCleanup: function () {
          return verifyCompleteInventoryBeforeDelete(
            pending.sourcePath,
            targetPath,
            resolvedItemIds,
            pending.cleanupPath || Transaction.cleanupPathFor(pending.sourcePath, pending.id)
          );
        },
        beforeDelete: async function (details) {
          var inventoryVerified = await verifyCompleteInventoryBeforeDelete(
            pending.sourcePath,
            targetPath,
            resolvedItemIds,
            pending.cleanupPath || Transaction.cleanupPathFor(pending.sourcePath, pending.id)
          );
          if (inventoryVerified === false) return false;
          projectState = State.updatePendingTransaction(projectState, {
            id: pending.id,
            targetFingerprint: details.targetFingerprint,
            targetMethod: details.targetMethod,
            status: "ready-to-delete",
          }, new Date());
          var recoveryDeleteCheckpointSave = await persistState();
          assertCheckpointWriteVerified(
            recoveryDeleteCheckpointSave,
            "删除前的文件身份记录已经写入，但状态写锁未能安全释放；原素材未删除"
          );
          return true;
        },
      });
      if (cleanupResult.cleanupPending) {
        var remainingSourcePath = typeof cleanupResult.remainingSourcePath === "string"
          ? cleanupResult.remainingSourcePath
          : pending.sourcePath;
        var cleanupMessage = cleanupResult.cleanupWarning || "原位置文件暂时无法安全清理";
        if (Transaction.hasStrongFileIdentity(cleanupResult.targetFingerprint)) {
          projectState = State.updatePendingTransaction(projectState, {
            id: pending.id,
            targetFingerprint: cleanupResult.targetFingerprint,
            targetMethod: cleanupResult.targetMethod || pending.targetMethod,
          }, new Date());
        }
        projectState = State.markCleanupPending(projectState, cleanupMessage, new Date());
        if (recoveryOptions.automatic) {
          var backgroundError = new Error(cleanupMessage);
          backgroundError.cleanupFailure = cleanupResult.cleanupFailure;
          if (await parkPendingItem(backgroundError, { fromBackground: true })) return;
          throw backgroundError;
        }
        projectState = State.addActivity(
          projectState,
          "error",
          remainingSourcePath ? "原素材还没有彻底移走" : "原素材删除后的核验没有完成",
          new Date(),
          { summary: remainingSourcePath || cleanupMessage }
        );
        await persistState();
        recoveryMessage = cleanupMessage + "。相关文件已保留，请再次核对。";
        return;
      }
      var finalRecoveryTargetFingerprint = cleanupResult.targetFingerprint || await currentFileFingerprint(targetPath);
      await verifyRecoveryTargetFingerprint(targetPath, finalRecoveryTargetFingerprint, "清理后");

      await verifyRecoveryTargetFingerprint(targetPath, finalRecoveryTargetFingerprint, "记录前");
      var stateBeforeCommit = projectState;
      try {
        projectState = State.commitTransaction(projectState, {
          id: pending.id,
          sourcePath: pending.sourcePath,
          targetPath: targetPath,
          targetRelativePath: pending.targetRelativePath,
          sourceFingerprint: pending.sourceFingerprint || {},
          byteCount: pending.byteCount,
          batchIndex: pending.batchIndex,
          // 旧状态没有模式证据时保守按复制恢复，避免在 macOS 上猜测同卷。
          mode: pending.mode || "copy",
          modeEvidence: pending.modeEvidence || null,
          projectPath: pending.projectPath || context.projectPath,
          projectIdentity: pending.projectIdentity || context.identity,
          cleanupPending: false,
          sourceChanged: cleanupResult.sourceChanged === true,
          targetFingerprint: finalRecoveryTargetFingerprint,
          targetMethod: cleanupResult.targetMethod || pending.targetMethod,
        }, new Date());
        projectState = State.addActivity(projectState, cleanupResult.sourceChanged ? "warn" : "ok", cleanupResult.sourceChanged ? "已完成整理；原路径出现另一份文件" : "已恢复上次整理记录", new Date(), {
          summary: cleanupResult.sourceChanged
            ? "目标已在线；源路径现为另一份文件，未触碰"
            : "目标文件与 Premiere 链接已确认",
        });
        if (relinkWarnings.length) {
          projectState = State.addActivity(projectState, "warn", "Premiere 返回异常，但链接核验已通过", new Date(), {
            summary: relinkWarnings.join("；"),
          });
        }
        await verifyRecoveryTargetFingerprint(targetPath, finalRecoveryTargetFingerprint, "记录后");
        await persistState();
      } catch (commitError) {
        projectState = stateBeforeCommit;
        try { await persistState(); } catch (persistError) {}
        throw commitError;
      }
      panelError = "";
      recoverySnapshot = null;
      recoveryMessage = "";
      if (!recoveryOptions.automatic && pending.resumeAutomatic && currentProjectSetup() && currentProtectionSetup() && !unresolvedProtectedLibraries().length) {
        setMachineSetting("auto", true);
        syncMonitor();
        requestSoonScan();
      }
    };
    await (recoveryOptions.unlocked ? recoverWork() : operationQueue.run(recoverWork)).catch(async function (error) {
      reportRuntimeError("核对上次整理失败", error);
      if (recoveryOptions.automatic) {
        if (await parkPendingItem(error, { fromBackground: true, hold: true })) return;
        throw error;
      }
      var recoveryError = userFacingRuntimeError(error, "核对上次整理时遇到问题，插件没有继续处理素材。请检查磁盘连接后重试。");
      panelError = "";
      recoveryMessage = recoveryError + " 待处理记录已保留，请按页面显示核对原位置、新位置和 Premiere 链接。";
      if (projectState && projectState.pendingTransaction) {
        projectState = projectState.pendingTransaction.status === "cleanup-pending"
          ? State.markCleanupPending(projectState, recoveryError, new Date())
          : State.failTransaction(projectState, recoveryError, new Date());
        try { await persistState(); } catch (persistError) {}
      }
    }).finally(function () {
      backgroundOperation = false;
      busy = false;
      busyStage = "";
      render();
    });
  }

  async function confirmHandoff() {
    var message = "后续新增素材放入新一批？\n\n有素材需要整理时才创建文件夹，不会传输文件或复制工程。";
    return confirmation.request(message);
  }

  async function deferCurrentRecovery() {
    if (busy) return;
      await operationQueue.run(async function () {
        await refreshContext();
        var deferredPending = projectState && projectState.pendingTransaction;
        if (deferredPending && deferredPending.recycleRequest && !deferredPending.recycleReceipt) {
          busy = true;
          busyStage = "scan";
          recoveryMessage = "正在核对旧回收请求；不会重新提交回收。";
          render();
          var folder = await uxp.storage.localFileSystem.getPluginFolder();
          var queryIdentity = context.identity;
          var queryGeneration = lifecycleGuard.current();
          var queryBridge = RecycleBridge.create({ fs: fs, uxp: uxp, pluginPath: folder.nativePath });
          var checked = await queryBridge.query(deferredPending.recycleRequest);
          if (!lifecycleGuard.isCurrent(queryGeneration) || !(await Premiere.contextStillActive(ppro, queryIdentity)))
            throw new Error("核对期间工程或面板已切换，记录保留，未暂缓");
          if (checked.state !== "cancelled" && !(checked.state === "result" && checked.value.status === "failed"))
            throw new Error("回收仍未确认结束，所有记录已保留，不能暂缓。请打开原工程继续核对。");
          projectState = State.updatePendingTransaction(projectState, {
            recycleAttempts: (deferredPending.recycleAttempts || []).concat([{ request: deferredPending.recycleRequest, result: checked.value }]),
            recycleRequest: null,
          }, new Date());
          assertCheckpointWriteVerified(await persistState(), "取消回收记录未可靠保存，不能暂缓");
        }
        var beforeDefer = projectState;
        var resumeAutomatic = Boolean(projectState && projectState.pendingTransaction && projectState.pendingTransaction.resumeAutomatic);
        projectState = State.deferTransaction(projectState, new Date());
        try { assertCheckpointWriteVerified(await persistState(), "暂缓记录未可靠保存，未继续整理"); }
        catch (error) { projectState = beforeDefer; throw error; }
      recoverySnapshot = null;
      recoveryMessage = "";
      panelError = "";
        if (resumeAutomatic && currentProjectSetup() && currentProtectionSetup() && !unresolvedProtectedLibraries().length) setMachineSetting("auto", true);
      syncMonitor();
      requestSoonScan();
      render();
    }).catch(function (error) { recoveryMessage = userFacingRuntimeError(error); })
      .finally(function () { busy = false; busyStage = ""; render(); });
  }

  async function handoffCurrentBatch() {
    if (!(await confirmHandoff())) return;
    await operationQueue.run(async function () {
      await refreshContext();
      if (!context || !projectState || !currentProjectSetup() || !projectState.initialized) throw new Error("当前工程还没有开启自动整理");
      busy = true;
      busyStage = "handoff";
      render();
      var scanResult = await scanUnlocked();
      busy = true;
      busyStage = "handoff";
      render();
      if (!scanResult || !scanResult.ok || panelError || storageWarning) throw new Error(scanResult && scanResult.error ? scanResult.error : "交接前检查失败");
      if (pendingCount > 0) throw new Error("仍有 " + pendingCount + " 个素材没有整理完成");
      if (reviewCount > 0) throw new Error("仍有 " + reviewCount + " 个素材需要确认");
      if (projectState.pendingTransaction) throw new Error("存在未收口的文件事务");
      var previous = State.currentBatch(projectState);
      projectState = State.requestNextBatch(projectState, new Date());
      projectState = State.addActivity(projectState, "ok", "已预约开始新一批", new Date(), {
        summary: "当前文件夹 " + previous.name + " 保持原位；下次新增素材时建立新文件夹",
      });
      await persistState();
      panelError = "";
    }).catch(function (error) {
      reportRuntimeError("完成交接失败", error);
      panelError = userFacingRuntimeError(error, "无法完成这次交接，插件没有建立下一个素材文件夹。请重新检查后再试。");
      if (projectState) projectState = State.addActivity(projectState, "error", "无法完成这次交接", new Date(), { summary: panelError });
    }).finally(function () {
      busy = false;
      busyStage = "";
      render();
    });
  }

  function libraryIdFor(rootPath) {
    var reused = machineSettings.protectedMappings.find(function (mapping) {
      return Core.samePath(mapping.rootPath, rootPath);
    });
    if (reused) return reused.libraryId;
    for (var suffix = 1; suffix <= 100; suffix += 1) {
      var candidate = Core.makeMediaSpaceId(rootPath, "protected-library-v1-" + suffix).replace(/^media-/, "library-");
      var collision = machineSettings.protectedMappings.find(function (mapping) { return mapping.libraryId === candidate; });
      if (!collision || Core.samePath(collision.rootPath, rootPath)) return candidate;
    }
    throw new Error("无法为这个不搬动文件夹生成稳定编号");
  }

  function protectedFolderOverlapError(selectedPath, library, mapping) {
    var error = new Error("选择的文件夹与已有不搬动文件夹范围重叠");
    error.name = "MaterialBatchProtectedFolderOverlapError";
    error.code = "MATERIAL_BATCH_PROTECTED_FOLDER_OVERLAP";
    error.conflictingLabel = String(library && library.label || mapping && mapping.label || "已有文件夹");
    error.conflictingPath = Core.toFileSystemPath(mapping && mapping.rootPath || "");
    error.selectedPath = Core.toFileSystemPath(selectedPath);
    return error;
  }

  async function validateChosenProtectedFolder(rootPath, existingLibraryId) {
    if (!Core.isAbsoluteLocalPath(rootPath)) throw new Error("没有取得有效的绝对目录路径");
    if (context && context.workspaceRoot && Core.isPathInside(context.workspaceRoot, rootPath)) {
      throw new Error("不能选择当前工程文件夹或它的上级目录");
    }
    if (mediaRoot() && (Core.isPathInside(rootPath, mediaRoot()) || Core.isPathInside(mediaRoot(), rootPath))) {
      throw new Error("已经整理到“素材”里的文件不需要再设为不搬动");
    }
    var overlap = null;
    if (projectState) projectState.protectedLibraries.some(function (library) {
      if (library.libraryId === existingLibraryId) return false;
      var mapping = machineSettings.protectedMappings.find(function (candidate) { return candidate.libraryId === library.libraryId; });
      if (!mapping || (!Core.isPathInside(rootPath, mapping.rootPath) && !Core.isPathInside(mapping.rootPath, rootPath))) return false;
      overlap = { library: library, mapping: mapping };
      return true;
    });
    if (overlap) throw protectedFolderOverlapError(rootPath, overlap.library, overlap.mapping);
    var stat = await fs.lstat(rootPath);
    if (!stat || typeof stat.isDirectory !== "function" || !stat.isDirectory()) {
      throw new Error("选择的路径不是文件夹");
    }
  }

  async function chooseProtectedFolder(existingLibraryId) {
    var initialBlockReason = protectedSettingsBlockReason();
    if (initialBlockReason) {
      setSettingsMessage(busy ? "info" : "error", initialBlockReason);
      render();
      return;
    }
    setSettingsMessage("", "");
    var expectedIdentity = context && context.identity;
    var selectedLabel = "";
    stopMonitor(false);
    try {
      var folder = await uxp.storage.localFileSystem.getFolder();
      if (!folder) {
        syncMonitor();
        return;
      }
      var rootPath = Core.toFileSystemPath(folder.nativePath);
      await validateChosenProtectedFolder(rootPath, existingLibraryId);
      await operationQueue.run(async function () {
        await refreshContext({ force: true });
        if (!context || context.identity !== expectedIdentity || !projectState) {
          throw new Error("选择文件夹期间活动工程已切换，请重新选择");
        }
        var blockReason = protectedSettingsBlockReason();
        if (blockReason) throw new Error(blockReason);
        await validateChosenProtectedFolder(rootPath, existingLibraryId);
        var previousSettings = JSON.parse(JSON.stringify(machineSettings));
        var previousState = projectState;
        try {
          var existingLibrary = existingLibraryId
            ? projectState.protectedLibraries.find(function (library) { return library.libraryId === existingLibraryId; })
            : null;
          var samePathMapping = machineSettings.protectedMappings.find(function (mapping) { return Core.samePath(mapping.rootPath, rootPath); });
          var libraryId = existingLibrary ? existingLibrary.libraryId : libraryIdFor(rootPath);
          if (samePathMapping && samePathMapping.libraryId !== libraryId) {
            throw new Error("这个目录已经在不搬动列表中");
          }
          var label = existingLibrary
            ? existingLibrary.label
            : samePathMapping
              ? samePathMapping.label
              : String(folder.name || Core.basename(rootPath) || "共享素材库");
          selectedLabel = label;
          machineSettings.protectedMappings = machineSettings.protectedMappings.filter(function (mapping) { return mapping.libraryId !== libraryId; });
          machineSettings.protectedMappings.push({ libraryId: libraryId, label: label, rootPath: rootPath });
          projectState = State.bumpProtectedConfigRevision(projectState, new Date());
          pauseWorkspaceProjectsInMemory();
          saveMachineSettings();
          projectState = State.addProtectedLibrary(projectState, libraryId, label, new Date());
          projectState = State.addActivity(projectState, "ok", "这里的素材不会移动：" + label, new Date(), { summary: rootPath });
          await persistState();
        } catch (error) {
          machineSettings = previousSettings;
          pauseWorkspaceProjectsInMemory();
          projectState = previousState;
          try { saveMachineSettings(); } catch (settingsRollbackError) {}
          throw error;
        }
        await refreshProtectedMappingStatus();
        if (unresolvedProtectedLibraries().length) setMachineSetting("auto", false);
        panelError = "";
      });
      setSettingsMessage("success", (existingLibraryId
        ? "已更新“" + selectedLabel + "”在这台电脑上的位置。"
        : "已添加“" + selectedLabel + "”，这里的素材不会移动。")
        + " 同一工程文件夹内的所有工程已暂停，请分别确认名单后再开启。");
    } catch (error) {
      try { await refreshProtectedMappingStatus(); } catch (validationError) {}
      panelError = (existingLibraryId ? "重新选择失败：" : "添加失败：") + protectedFolderErrorMessage(error);
      setSettingsMessage("error", panelError);
    } finally {
      syncMonitor();
      render();
    }
  }

  async function removeProtectedLibrary(libraryId) {
    var initialBlockReason = protectedSettingsBlockReason();
    if (initialBlockReason) {
      setSettingsMessage(busy ? "info" : "error", initialBlockReason);
      render();
      return;
    }
    var library = projectState.protectedLibraries.find(function (candidate) { return candidate.libraryId === libraryId; });
    if (!library) return;
    var mapping = machineSettings.protectedMappings.find(function (candidate) { return candidate.libraryId === libraryId; });
    var pathLine = mapping && mapping.rootPath ? "\n文件夹：" + Core.toFileSystemPath(mapping.rootPath) : "";
    var approved = await confirmation.request("从不搬动名单移除“" + library.label + "”？" + pathLine + "\n\n不会删除磁盘文件夹或里面的素材。同一工程文件夹内的所有工程都会暂停。");
    if (!approved) return;
    setSettingsMessage("", "");
    var expectedIdentity = context && context.identity;
    await operationQueue.run(async function () {
      await refreshContext({ force: true });
      if (!context || context.identity !== expectedIdentity || !projectState) {
        throw new Error("移除文件夹期间活动工程已切换，请重新操作");
      }
      var currentLibrary = projectState.protectedLibraries.find(function (candidate) { return candidate.libraryId === libraryId; });
      if (!currentLibrary) throw new Error("不搬动名单已经变化，请重新打开管理页后再操作");
      var blockReason = protectedSettingsBlockReason();
      if (blockReason) throw new Error(blockReason);
      stopMonitor(false);
      pauseWorkspaceProjects();
      var previousState = projectState;
      try {
        projectState = State.removeProtectedLibrary(projectState, libraryId, new Date());
        projectState = State.bumpProtectedConfigRevision(projectState, new Date());
        projectState = State.addActivity(projectState, "warn", "已从不搬动名单移除：" + currentLibrary.label, new Date());
        await persistState();
      } catch (error) {
        projectState = previousState;
        throw error;
      }
      await refreshProtectedMappingStatus();
      panelError = "";
      setSettingsMessage("success", "已从名单移除“" + currentLibrary.label + "”。没有删除磁盘文件或素材；同一工程文件夹内的所有工程已暂停，请分别确认名单后再开启。");
    }).catch(function (error) {
      reportRuntimeError("从不搬动名单移除文件夹失败", error);
      panelError = "移除失败：" + userFacingRuntimeError(error, "无法从名单移除这个文件夹，请重新检查后再试。")
        + " 原名单没有改变。";
      setSettingsMessage("error", panelError);
    }).finally(function () {
      syncMonitor();
      render();
    });
  }

  async function completeProtectionSetup() {
    var failureStage = "validation";
    var expectedIdentity = context && context.identity;
    await operationQueue.run(async function () {
      await refreshContext({ force: true });
      if (!expectedIdentity || !context || context.identity !== expectedIdentity || !projectState) {
        throw new Error("确认名单期间活动工程已切换，请在当前工程中重新操作");
      }
      var blockReason = protectedSettingsBlockReason();
      if (blockReason) throw new Error(blockReason);
      await refreshProtectedMappingStatus();
      if (!(await Premiere.contextStillActive(ppro, expectedIdentity))) {
        throw new Error("确认名单期间活动工程已切换，请在当前工程中重新操作");
      }
      if (unresolvedProtectedLibraries().length) {
        throw new Error("请先重新选择所有需要连接的不搬动文件夹。");
      }
      // 空名单首次确认时也要先固定素材空间编号，关闭面板后才能继续复用本机确认。
      failureStage = "project-state";
      await persistState();
      if (!(await Premiere.contextStillActive(ppro, expectedIdentity))) {
        throw new Error("保存名单期间活动工程已切换，请在当前工程中重新操作");
      }
      failureStage = "machine-settings";
      setMachineSettings({ protection: true, auto: false });
      panelError = "";
      setSettingsMessage("success", "这份不搬动名单已确认，现在可以开始整理此工程。");
      var scanResult = await scanUnlocked({ skipRefresh: true });
      if (!scanResult || !scanResult.ok) throw new Error(scanResult && scanResult.error || "无法检查当前工程素材");
    }).then(function () {
      render();
      if (typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
        window.dispatchEvent(new CustomEvent("batch-collector:close-settings"));
      }
    }).catch(function (error) {
      reportRuntimeError("确认不搬动名单失败（" + failureStage + "）", error);
      setSettingsMessage("error", protectionSetupErrorMessage(error, failureStage));
      render();
    });
  }

  function openSettingsPage() {
    if (typeof window.dispatchEvent === "function" && typeof CustomEvent === "function") {
      window.dispatchEvent(new CustomEvent("batch-collector:open-settings"));
    }
    return requestScan({ forceContext: true });
  }

  function openActivityLog() {
    var details = element("activityDetails");
    if (!details) return;
    details.open = true;
    if (typeof details.scrollIntoView === "function") details.scrollIntoView({ block: "nearest" });
  }

  function openReviewList() {
    var section = element("reviewSection");
    if (section && !section.hidden && typeof section.scrollIntoView === "function") {
      section.scrollIntoView({ block: "start" });
    }
  }

  async function revealReviewLocation(review) {
    var revealPath = String(review && review.revealPath || "");
    await openDirectory(revealPath, "打开素材所在位置");
  }

  async function currentFileFingerprint(nativePath) {
    var stat = await Transaction.lstatForIdentity(fs, nativePath);
    if (!stat || typeof stat.isFile !== "function" || !stat.isFile()) throw new Error("当前路径不是单个文件");
    var fingerprint = Transaction.fingerprintFromStat(stat);
    if (!Transaction.hasStrongFileIdentity(fingerprint)) throw new Error("当前文件缺少可靠的文件身份，请稍后重试");
    return fingerprint;
  }

  async function verifyRecoveryTargetFingerprint(nativePath, expectedFingerprint, stage) {
    var currentFingerprint;
    try {
      currentFingerprint = await currentFileFingerprint(nativePath);
    } catch (error) {
      var unavailable = new Error("恢复" + stage + "无法核对新位置文件，已保留待检查记录，请人工检查");
      unavailable.code = "MATERIAL_BATCH_RECOVERY_TARGET_CHANGED";
      unavailable.cause = error;
      throw unavailable;
    }
    if (!Transaction.sameStrongPathFingerprint(expectedFingerprint, currentFingerprint)) {
      var changed = new Error("恢复" + stage + "新位置文件已发生变化，已保留待检查记录，请人工检查");
      changed.code = "MATERIAL_BATCH_RECOVERY_TARGET_CHANGED";
      throw changed;
    }
    return currentFingerprint;
  }

  async function handleReviewAction(event) {
    var detail = event && event.detail || {};
    var action = String(detail.action || "");
    var reviewId = String(detail.reviewId || "");
    await operationQueue.run(async function () {
      await refreshContext();
      var review = reviewItems.find(function (candidate) { return candidate.id === reviewId; });
      if (!review) throw new Error("这条待确认素材已变化，请重新检查");
      if (action === "reveal") {
        folderActionMessage = "";
        return revealReviewLocation(review);
      }
      if (action === "retry") return scanUnlocked({ skipRefresh: true });
      if (action === "resume-deferred") {
        projectState = State.resumeDeferred(projectState, review.transactionId, new Date());
        assertCheckpointWriteVerified(await persistState(), "恢复记录未可靠保存");
        pauseAutomaticBestEffort();
        panelError = "";
        recoverySnapshot = null;
        return render();
      }
      if (!projectState || !context || !context.projectPath) throw new Error("当前 Premiere 工程不可用");

      if (action === "baseline-keep" || action === "baseline-move") {
        var fingerprint = await currentFileFingerprint(review.sourcePath);
        if (!Transaction.sameStrongPathFingerprint(review.sourceFingerprint, fingerprint)) {
          throw new Error("文件在确认期间发生变化，请重新检查后再选择");
        }
        projectState = action === "baseline-keep"
          ? State.setProjectBaselineEntry(projectState, context.projectPath, review.sourcePath, fingerprint, new Date())
          : State.removeProjectBaselineEntry(projectState, context.projectPath, review.sourcePath, new Date());
        projectState = State.markKnown(projectState, review.sourcePath, action === "baseline-keep" ? "baseline" : "approved-to-move", new Date(), {
          sourceFingerprint: fingerprint,
        });
        projectState = State.addActivity(
          projectState,
          "ok",
          action === "baseline-keep" ? "已视为原有素材" : "已确认整理这个文件",
          new Date(),
          { summary: Core.basename(review.sourcePath) }
        );
        await persistState();
        return scanUnlocked({ skipRefresh: true });
      }

      if (action === "mapping-confirm") {
        if (!review.mapping || !review.targetRelativePath || !review.targetPath) throw new Error("这条历史位置记录已失效");
        var targetFingerprint = await currentFileFingerprint(review.targetPath);
        if (!Transaction.hasStrongFileIdentity(review.targetFingerprint)
          || !Transaction.sameStrongPathFingerprint(review.targetFingerprint, targetFingerprint)) {
          throw new Error("新位置文件在确认期间发生变化，请重新检查后再确认");
        }
        projectState = State.updateMappingTargetFingerprint(
          projectState,
          review.sourcePath,
          review.targetRelativePath,
          targetFingerprint,
          new Date()
        );
        projectState = State.addActivity(projectState, "ok", "已确认使用记录中的新位置", new Date(), {
          summary: review.targetPath,
        });
        await persistState();
        return scanUnlocked({ skipRefresh: true });
      }

      throw new Error("无法识别这项确认操作");
    }).catch(function (error) {
      reportRuntimeError("处理待确认素材失败", error);
      if (action === "reveal") {
        folderActionMessage = userFacingRuntimeError(error, "无法打开素材所在文件夹，请检查磁盘是否已连接后重试。");
      } else {
        panelError = userFacingRuntimeError(error, "这项素材没有处理完成，自动整理仍保持暂停。请重新检查后再试。");
      }
    }).finally(function () {
      syncMonitor();
      render();
    });
  }

  async function handleStateAction() {
    var action = element("stateAction");
    var intent = action ? action.dataset.intent : "";
    if (intent === "找到原工程") {
      var record = currentRecoveryRecord();
      if (!record || !record.projectPath) return;
      try { await openDirectory(Core.dirname(record.projectPath), "打开原工程所在文件夹"); }
      catch (error) { recoveryMessage = userFacingRuntimeError(error); render(); }
      return;
    }
    if (intent === "开始整理此工程" || intent === "开启自动整理" || intent === "继续自动整理" || intent === "开始整理现有素材") return setAutomatic(true);
    if (intent === "设置不搬动文件夹" || intent === "选择文件夹" || intent === "查看不搬动文件夹") return openSettingsPage();
    if (intent === "查看需处理素材" || intent === "查看待确认素材") return openReviewList();
    if (intent === "查看最近记录") return openActivityLog();
    if (intent === "检查上次整理" || intent === "核对并继续" || intent === "检查文件和链接") return recoverPendingTransaction();
    return requestScan({ forceContext: true });
  }

  function bindUi() {
    // Production buttons must not depend on the preview's CustomEvent bridge.
    var directActions = { stateAction: handleStateAction, refreshButton: function () { requestScan(); },
      openBatchButton: openCurrentBatch, openRecoverySourceButton: openRecoverySource,
      openRecoveryTargetButton: openRecoveryTarget, closeRecoveryRecordButton: closeLegacyRecoveryRecord,
      handoffButton: handoffCurrentBatch };
    Object.keys(directActions).forEach(function (id) {
      var button = element(id);
      if (button && typeof button.addEventListener === "function") button.addEventListener("click", function (event) {
        if (event && typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
        directActions[id]();
      }, true);
    });
    var verifyRecovery = element("verifyRecoveryButton");
    if (verifyRecovery) verifyRecovery.addEventListener("click", function () { recoverPendingTransaction({ verifyLegacy: true }); });
    var cancelRecovery = element("cancelRecoveryButton");
    if (cancelRecovery) cancelRecovery.addEventListener("click", function () { recoveryCancelled = true; });
    var deferRecovery = element("deferRecoveryButton");
    if (deferRecovery) deferRecovery.addEventListener("click", deferCurrentRecovery);
    window.addEventListener("batch-collector:refresh", function () { requestScan(); });
    window.addEventListener("batch-collector:open-batch", openCurrentBatch);
    window.addEventListener("batch-collector:open-recovery-source", openRecoverySource);
    window.addEventListener("batch-collector:open-recovery-target", openRecoveryTarget);
    window.addEventListener("batch-collector:close-recovery-record", closeLegacyRecoveryRecord);
    window.addEventListener("batch-collector:handoff", handoffCurrentBatch);
    window.addEventListener("batch-collector:auto-collect", function (event) {
      setAutomatic(Boolean(event.detail && event.detail.enabled));
    });
    window.addEventListener("batch-collector:state-action", handleStateAction);
    window.addEventListener("batch-collector:review-action", handleReviewAction);

    var addProtected = element("addProtectedButton");
    if (addProtected) addProtected.addEventListener("click", function () { chooseProtectedFolder(""); });
    var finishProtection = element("finishProtectionButton");
    if (finishProtection) finishProtection.addEventListener("click", completeProtectionSetup);
    var protectedList = element("protectedList");
    if (protectedList) protectedList.addEventListener("click", function (event) {
      var button = event.target;
      while (button && button !== protectedList && !(String(button.tagName || "").toUpperCase() === "BUTTON" && button.getAttribute("data-library-id"))) {
        button = button.parentNode;
      }
      if (button === protectedList) button = null;
      if (!button) return;
      var libraryId = button.getAttribute("data-library-id");
      var action = button.getAttribute("data-action");
      if (action === "map") chooseProtectedFolder(libraryId);
      if (action === "remove") removeProtectedLibrary(libraryId);
    });
  }

  async function initializePanel() {
    panelVisible = true;
    var showGeneration = lifecycleGuard.bump();
    if (!uiBound) {
      uiBound = true;
      bindUi();
    }
    render();
    return operationQueue.run(async function () {
      if (!panelVisible || !lifecycleGuard.isCurrent(showGeneration)) return;
      try {
        await refreshContext({ force: true });
        if (!panelVisible || !lifecycleGuard.isCurrent(showGeneration)) return;
        if (context && projectState && currentProtectionSetup()) await scanUnlocked({ skipRefresh: true });
        syncMonitor();
      } catch (error) {
        reportRuntimeError("打开插件面板失败", error);
        panelError = userFacingRuntimeError(error);
        syncMonitor();
        render();
      }
    });
  }

  function panelHide() {
    confirmation.cancel();
    panelVisible = false;
    stopMonitor(false);
    stabilityTracker.clear();
    savedProjectEvidence = null;
    lifecycleGuard.bump();
  }

  uxp.entrypoints.setup({
    panels: {
      materialBatchOrganizer: {
        show: initializePanel,
        hide: panelHide,
        destroy: panelHide,
      },
    },
  });

  window.addEventListener("error", function (event) {
    reportRuntimeError("插件面板发生错误", event && event.error ? event.error : event);
    panelError = userFacingRuntimeError(event && event.error ? event.error : event, "插件界面遇到问题，自动整理已暂停。请关闭面板后重新打开。");
    render();
  });
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event && event.reason;
    reportRuntimeError("插件操作发生未处理错误", reason);
    panelError = userFacingRuntimeError(reason, "插件操作没有完成，自动整理已暂停。请关闭面板后重新打开。");
    render();
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initializePanel);
  else initializePanel();
})();
