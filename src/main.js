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

  var MACHINE_SETTINGS_KEY = "hechao.material-batch-organizer.machine.v1";
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
  var scanTimer = null;
  var soonTimer = null;
  var globalImportAttached = false;
  var projectDirtyBinding = null;
  var pendingCount = 0;
  var reviewCount = 0;
  var reviewItems = [];
  var lastProtectedCount = 0;
  var lastInventoryCount = 0;
  var protectedMappingValidation = { validMappings: [], unresolved: [], statusById: {} };

  function element(id) {
    return document.getElementById(id);
  }

  function setText(id, value) {
    var target = element(id);
    if (target) target.textContent = value == null ? "" : String(value);
  }

  function defaultMachineSettings() {
    return {
      autoByMediaSpace: {},
      protectedMappings: [],
    };
  }

  function loadMachineSettings() {
    var defaults = defaultMachineSettings();
    try {
      var raw = JSON.parse(localStorage.getItem(MACHINE_SETTINGS_KEY) || "null");
      if (!raw || typeof raw !== "object") return defaults;
      return {
        autoByMediaSpace: raw.autoByMediaSpace && typeof raw.autoByMediaSpace === "object" ? raw.autoByMediaSpace : {},
        protectedMappings: Array.isArray(raw.protectedMappings)
          ? raw.protectedMappings.filter(function (mapping) {
              return mapping && mapping.libraryId && mapping.rootPath;
            }).map(function (mapping) {
              return {
                libraryId: String(mapping.libraryId),
                label: String(mapping.label || "共享素材库"),
                rootPath: String(mapping.rootPath),
              };
            })
          : [],
      };
    } catch (error) {
      return defaults;
    }
  }

  function saveMachineSettings() {
    localStorage.setItem(MACHINE_SETTINGS_KEY, JSON.stringify(machineSettings));
  }

  function currentAutoSetting() {
    return Boolean(projectState && machineSettings.autoByMediaSpace[projectState.mediaSpaceId] === true);
  }

  function setMachineSetting(name, value) {
    if (!projectState) return;
    if (name === "auto") machineSettings.autoByMediaSpace[projectState.mediaSpaceId] = value === true;
    saveMachineSettings();
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
      { mediaRoot: mediaRoot() }
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

  function relativeBatchPath() {
    if (!projectState) return "素材";
    return Core.joinNativePath(projectState.mediaFolderName, State.currentBatch(projectState).name);
  }

  function batchPath() {
    return context && projectState ? State.currentBatchPath(projectState, context.workspaceRoot) : "";
  }

  function mediaRoot() {
    return context && projectState ? Core.joinNativePath(context.workspaceRoot, projectState.mediaFolderName) : "";
  }

  function stateIcon(name) {
    return '<svg class="icon"><use href="#icon-' + name + '"></use></svg>';
  }

  function renderActivity() {
    var list = element("activityList");
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    var activity = projectState && Array.isArray(projectState.activity) ? projectState.activity.slice(-4).reverse() : [];
    if (!activity.length) {
      var empty = document.createElement("li");
      var bullet = document.createElement("span");
      bullet.className = "activity-bullet";
      var copy = document.createElement("div");
      var title = document.createElement("strong");
      title.textContent = context ? "等待开启自动整理" : "等待 Premiere 工程";
      var detail = document.createElement("small");
      detail.textContent = context ? "第一次开启只记录现有素材，不会移动它们" : "打开并保存工程后再重新检查";
      copy.appendChild(title);
      copy.appendChild(detail);
      empty.appendChild(bullet);
      empty.appendChild(copy);
      list.appendChild(empty);
      return;
    }
    activity.forEach(function (entry) {
      var row = document.createElement("li");
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
    var section = element("reviewSection");
    var list = element("reviewList");
    if (!section || !list) return;
    section.hidden = reviewItems.length === 0;
    setText("reviewCountLabel", reviewItems.length + " 项");
    while (list.firstChild) list.removeChild(list.firstChild);

    reviewItems.forEach(function (review) {
      var row = document.createElement("li");
      row.className = "review-item";
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
    var list = element("protectedList");
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    var libraries = projectState ? projectState.protectedLibraries : [];
    if (!libraries.length) {
      var empty = document.createElement("li");
      empty.className = "protected-empty";
      var emptyLabel = document.createElement("code");
      emptyLabel.textContent = "还没有“不搬动文件夹”";
      empty.appendChild(emptyLabel);
      list.appendChild(empty);
    }

    libraries.forEach(function (library) {
      var status = protectedMappingValidation.statusById[library.libraryId] || { valid: false, mapping: null, reason: "尚未检查这个文件夹" };
      var mapping = status.mapping;
      var row = document.createElement("li");
      var label = document.createElement("code");
      label.textContent = library.label + (status.valid ? " · 已连接" : " · 路径不可用，请重新选择");
      label.title = status.valid && mapping ? mapping.rootPath : status.reason;
      var action = document.createElement("button");
      action.className = "icon-button small";
      action.type = "button";
      action.dataset.libraryId = library.libraryId;
      action.dataset.action = status.valid ? "remove" : "map";
      action.setAttribute("aria-label", status.valid ? "从不搬动列表中移除" : "在这台电脑上重新选择对应文件夹");
      action.title = status.valid ? "允许移动这里的素材" : status.reason;
      action.innerHTML = stateIcon(status.valid ? "close" : "folder");
      row.appendChild(label);
      row.appendChild(action);
      list.appendChild(row);
    });

    setText("protectedCountText", libraries.length
      ? libraries.length + " 个共享素材文件夹不会移动"
      : "没有设置“不搬动文件夹”");
  }

  function render() {
    var root = element("panelRoot");
    var body = document.body;
    var activePanelError = panelError || storageWarning;
    var view = {
      mode: "empty",
      kind: "empty",
      title: "请先打开 Premiere 工程",
      description: "打开工程后，插件才能找到需要整理的素材。",
      status: "等待工程",
      action: "重新检查工程",
      icon: "folder",
    };

    if (context && !context.projectPath) {
      view = { mode: "unsaved", kind: "warning", title: "请先保存工程", description: "保存后，插件才能在工程旁边建立素材文件夹。", status: "等待保存", action: "重新检查工程", icon: "alert" };
    } else if (context && context.projectPath && !projectState && activePanelError) {
      view = { mode: "failure", kind: "danger", title: "无法读取整理记录", description: activePanelError, status: "已停止", action: "重新检查工程", icon: "alert" };
    } else if (context && projectState) {
      var unresolved = unresolvedProtectedLibraries();
      if (projectState.pendingTransaction) {
        var cleanupRequired = projectState.pendingTransaction.status === "cleanup-pending";
        view = cleanupRequired
          ? { mode: "failure", kind: "danger", title: "原素材还没有彻底移走", description: "请在最近记录中查看待删除路径，手动删除后再检查一次。", status: "尚未完成", action: "检查上次整理", icon: "alert" }
          : { mode: "failure", kind: "danger", title: "上次整理中断，需要检查", description: "只核对新旧位置和 Premiere 链接，检查时不会删除文件。", status: "需要检查", action: "检查上次整理", icon: "alert" };
      } else if (projectState.pendingProjectSave) {
        view = { mode: "failure", kind: "danger", title: "Premiere 工程还没有确认保存", description: "素材已在整理后的位置；请检查链接并重新保存当前工程。", status: "需要检查", action: "检查上次整理", icon: "alert" };
      } else if (activePanelError) {
        view = { mode: "failure", kind: "danger", title: "有一步没有完成", description: activePanelError, status: "需要处理", action: "重新检查工程", icon: "alert" };
      } else if (busy) {
        var stageText = {
          scan: "正在检查新素材",
          move: "正在移动素材",
          copy: "正在跨盘复制素材",
          relink: "正在更新 Premiere 链接",
          save: "正在保存 Premiere 工程",
          cleanup: "正在删除已验证的源文件",
          handoff: "正在建立下一个交接文件夹",
        };
        view = { mode: busyStage === "scan" ? "running" : "moving", kind: busyStage === "scan" ? "running" : "moving", title: stageText[busyStage] || "正在整理素材", description: "确认新位置可用、Premiere 已重新链接并保存后，才会删除原文件。", status: busyStage === "scan" ? "检查中" : "移动中", action: "", icon: "refresh" };
      } else if (unresolved.length) {
        view = { mode: "conflict", kind: "danger", title: "有共享文件夹需要重新选择", description: "“" + unresolved[0].label + "”在这台电脑上的位置还没选。", status: "需要处理", action: "选择文件夹", icon: "alert" };
      } else if (reviewCount > 0) {
        view = { mode: "conflict", kind: "danger", title: "有 " + reviewCount + " 个素材需要确认", description: "这些文件还在原位置，请逐项确认后继续。", status: "需要处理", action: "查看待确认素材", icon: "alert" };
      } else if (!projectState.initialized) {
        view = { mode: "paused", kind: "warning", title: "自动整理还未开启", description: "第一次开启只记录已有素材，不会移动它们。", status: "未开启", action: "开启自动整理", icon: "pause" };
      } else if (!currentAutoSetting()) {
        view = { mode: "paused", kind: "warning", title: "自动整理已暂停", description: pendingCount ? pendingCount + " 个新素材仍在原位置等待整理。" : "新导入素材暂时留在原位置。", status: "已暂停", action: "继续自动整理", icon: "pause" };
      } else if (pendingCount > 0) {
        view = { mode: "waiting", kind: "warning", title: "正在等待 " + pendingCount + " 个文件写完", description: "文件仍在下载或写入，暂时留在原位置；稳定后会自动整理。", status: "等待写完", action: "", icon: "refresh" };
      } else if (lastProtectedCount > 0) {
        view = { mode: "protected", kind: "protected", title: "共享素材已留在原位", description: lastProtectedCount + " 个素材来自“不搬动文件夹”，其余素材照常整理。", status: "自动整理中", action: "查看不搬动文件夹", icon: "shield" };
      } else {
        view = { mode: "ready", kind: "ready", title: "自动整理已开启", description: "新导入的原始素材和下载素材会自动放入下面的文件夹；共享素材库保持原位。", status: "自动整理中", action: "", icon: "check" };
      }
    }

    body.dataset.state = view.mode;
    if (root) {
      root.dataset.runtimeState = view.mode;
      root.setAttribute("aria-busy", busy ? "true" : "false");
    }
    var strip = element("stateStrip");
    if (strip) {
      strip.dataset.kind = view.kind;
      var iconTarget = strip.querySelector(".state-icon");
      if (iconTarget) iconTarget.innerHTML = stateIcon(view.icon);
    }
    setText("stateTitle", view.title);
    setText("stateDescription", view.description);
    setText("batchStatus", view.status);

    var action = element("stateAction");
    if (action) {
      action.hidden = !view.action;
      action.textContent = view.action;
      action.dataset.intent = view.action;
    }

    setText("projectName", context ? context.projectName : "未连接工程");
    setText("projectPath", context ? (context.projectPath || "尚未保存到磁盘") : "尚未读取工程目录");
    setText("projectMeta", context && context.projectPath
      ? projectState && projectState.pendingProjectSave ? "等待重新保存" : "工程已保存"
      : context ? "尚未保存" : "等待连接");
    var projectName = element("projectName");
    if (projectName) projectName.title = context ? (context.projectPath || context.projectName || "") : "";

    var batch = projectState ? State.currentBatch(projectState) : null;
    setText("batchNumber", batch ? String(batch.index).padStart(3, "0") : "---");
    setText("batchName", batch ? batch.name.replace(/^\d{3}_/, "") : "等待工程");
    var batchHeading = element("batchHeading");
    if (batchHeading) batchHeading.setAttribute("aria-label", batch ? "素材会放到 " + relativeBatchPath() : "等待工程");
    setText("fileCount", batch ? batch.fileCount : 0);
    setText("fileSize", batch ? formatBytes(batch.byteCount) : "0 B");
    setText("batchPath", batch ? relativeBatchPath() : "素材");
    var rail = element("railFill");
    if (rail) rail.style.width = busy ? "64%" : batch && batch.fileCount ? "100%" : "0%";

    var autoToggle = element("autoCollectToggle");
    if (autoToggle) {
      autoToggle.checked = currentAutoSetting();
      autoToggle.disabled = !context || !context.projectPath || Boolean(projectState && (projectState.pendingTransaction || projectState.pendingProjectSave)) || busy;
    }
    var openButton = element("openBatchButton");
    if (openButton) openButton.disabled = !context || !context.projectPath || busy;
    var handoffButton = element("handoffButton");
    if (handoffButton) handoffButton.disabled = !projectState || !projectState.initialized || busy || pendingCount > 0 || reviewCount > 0 || Boolean(projectState.pendingTransaction) || Boolean(projectState.pendingProjectSave) || Boolean(activePanelError) || Boolean(unresolved && unresolved.length);
    var handoffBlockedByWork = busy || pendingCount > 0;
    var handoffBlockedByProblem = reviewCount > 0 || Boolean(projectState && (projectState.pendingTransaction || projectState.pendingProjectSave)) || Boolean(activePanelError) || Boolean(unresolved && unresolved.length);
    setText("handoffHint", handoffBlockedByWork
      ? "素材整理完成后才能交接。"
      : handoffBlockedByProblem
        ? "先完成上面的处理，才能完成交接。"
        : "完成后，新导入素材会进入下一个文件夹。");
    var refreshButton = element("refreshButton");
    if (refreshButton) refreshButton.disabled = busy;
    var settingsButton = element("settingsButton");
    if (settingsButton) settingsButton.disabled = busy;

    renderActivity();
    renderReviewItems();
    renderProtectedLibraries();
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
    var state = loaded.missing
      ? State.createState(nextContext.workspaceRoot, new Date())
      : State.hydrateState(loaded.value, nextContext.workspaceRoot, new Date());
    state = State.registerProject(state, nextContext.projectPath, nextContext.projectName, new Date());
    if (loaded.recovered) state = State.addActivity(state, "warn", "状态文件已从备份读取", new Date());
    return state;
  }

  async function persistState() {
    if (!context || !context.workspaceRoot || !projectState) throw new Error("没有可保存的素材空间");
    try {
      var saved = await Storage.writeJsonAtomic(fs, Storage.statePath(context.workspaceRoot), projectState, {
        expectedRevision: stateRevision,
        recovered: stateRecoveredFromBackup,
      });
      stateRevision = saved.revision;
      stateRecoveredFromBackup = false;
      if (saved.warning) {
        setMachineSetting("auto", false);
        stopMonitor(false);
        storageWarning = saved.lockReleaseWarning
          ? "整理记录已经保存，但状态写锁未能清理；请关闭另一个 Premiere 进程并检查 .lock 文件"
          : saved.warning;
      } else storageWarning = "";
      return saved;
    } catch (error) {
      var code = String(error && error.code || "");
      if (["MATERIAL_BATCH_STORAGE_CONFLICT", "MATERIAL_BATCH_STORAGE_LOCKED", "MATERIAL_BATCH_STORAGE_STALE_LOCK", "MATERIAL_BATCH_STORAGE_LOCK_UNSUPPORTED"].indexOf(code) >= 0) {
        setMachineSetting("auto", false);
        stopMonitor(false);
        stateReloadRequired = code === "MATERIAL_BATCH_STORAGE_CONFLICT";
        panelError = error.message || "整理记录正在被另一个 Premiere 进程修改，自动整理已暂停";
      }
      throw error;
    }
  }

  async function refreshContext(options) {
    var refreshOptions = options || {};
    var next = await Premiere.activeContext(ppro);
    var changed = !context || !next || context.identity !== next.identity || context.workspaceRoot !== next.workspaceRoot;
    if (!changed && refreshOptions.force !== true && !stateReloadRequired) return context;

    detachProjectDirtyListener();
    stopMonitor(false);
    context = next;
    projectState = null;
    stateRevision = Storage.MISSING_REVISION;
    stateRecoveredFromBackup = false;
    protectedMappingValidation = { validMappings: [], unresolved: [], statusById: {} };
    try {
      projectState = next && next.workspaceRoot ? await readProjectState(next) : null;
    } catch (error) {
      stateReloadRequired = true;
      panelError = error.message || String(error);
      throw error;
    }
    await refreshProtectedMappingStatus();
    panelError = projectState && projectState.pendingTransaction
      ? "检测到上次整理未完成，自动整理已暂停"
      : projectState && projectState.pendingProjectSave
        ? "Premiere 工程还有一处补链没有确认保存，自动整理已暂停"
        : "";
    pendingCount = 0;
    reviewCount = 0;
    reviewItems = [];
    lastProtectedCount = 0;
    if (projectState && (projectState.pendingTransaction || projectState.pendingProjectSave || storageWarning)) setMachineSetting("auto", false);
    if (projectState && unresolvedProtectedLibraries().length) setMachineSetting("auto", false);
    syncMonitor();
    render();
    return context;
  }

  async function ensureBatchDirectories() {
    var root = mediaRoot();
    var current = batchPath();
    if (!root || !current) throw new Error("无法确定当前素材文件夹");
    if (!Core.isPathInside(root, context.workspaceRoot) || Core.samePath(root, context.workspaceRoot)) {
      throw new Error("素材根目录越出了当前工程文件夹");
    }
    if (!Core.isPathInside(current, root) || Core.samePath(current, root)) {
      throw new Error("当前素材文件夹的位置不安全");
    }
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(current, { recursive: true });
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
      stat = await fs.lstat(nativePath);
    } catch (error) {
      throw notReadyError("文件暂时无法读取，稍后重试");
    }
    if (typeof stat.isFile !== "function" || !stat.isFile()) throw new Error("第一版只处理单个文件素材");
    var currentFingerprint = Transaction.fingerprintFromStat(stat);
    if (!Transaction.samePortableFingerprint(expectedFingerprint, currentFingerprint)) {
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

  function isMissingPathError(error) {
    var code = String(error && error.code || "").toUpperCase();
    return code === "ENOENT" || code === "PATH_NOT_FOUND" || code === "FILE_NOT_FOUND";
  }

  async function inspectMappingTarget(mapping) {
    var targetPath = targetPathForMapping(mapping);
    var targetStat;
    try {
      targetStat = await fs.lstat(targetPath);
    } catch (error) {
      return {
        kind: isMissingPathError(error) ? "mapping-target-missing" : "mapping-target-unavailable",
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
    if (targetStatus === "match" && !Transaction.samePortableFingerprint(mapping.targetFingerprint, targetFingerprint)) {
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
    var sourceFingerprint = Transaction.fingerprintFromStat(await fs.lstat(group.mediaPath));
    return { kind: "reused-path", mapping: null, sourceFingerprint: sourceFingerprint };
  }

  async function processGroup(group, lifecycleGeneration) {
    var sourcePath = group.mediaPath;
    var batch = State.currentBatch(projectState);
    busy = true;
    busyStage = "scan";
    render();
    try {
      var plannedMode = Core.isSameVolume(sourcePath, batchPath()) ? "rename" : "copy";
      await ensureBatchDirectories();
      var targetPath = await chooseTargetPath(sourcePath);
      var targetRelativePath = Core.joinNativePath(projectState.mediaFolderName, batch.name, Core.basename(targetPath));
      if (!Core.isSafeRelativePath(targetRelativePath)) throw new Error("无法生成安全的素材文件路径");
      var sourceStat = await verifyStableFile(sourcePath, group.sourceFingerprint, lifecycleGeneration);
      var sourceFingerprint = Transaction.fingerprintFromStat(sourceStat);
      var transactionId = "tx-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
      var cleanupPath = Transaction.cleanupPathFor(sourcePath, transactionId);
      projectState = State.beginTransaction(projectState, {
        id: transactionId,
        sourcePath: sourcePath,
        targetPath: targetPath,
        cleanupPath: cleanupPath,
        targetRelativePath: targetRelativePath,
        sourceFingerprint: sourceFingerprint,
        byteCount: Transaction.statSize(sourceStat),
        batchIndex: batch.index,
        mode: plannedMode,
        deleteSource: true,
        projectPath: context.projectPath,
        projectIdentity: context.identity,
        itemCount: group.entries.length,
        itemIds: group.entries.map(function (entry) { return entry.itemId; }).filter(Boolean),
      }, new Date());
      try {
        var journalSave = await persistState();
        if (journalSave && journalSave.lockReleaseWarning) {
          var lockError = new Error("移动记录已经写入，但状态写锁没有清理；素材尚未移动");
          lockError.code = "MATERIAL_BATCH_STORAGE_LOCKED";
          throw lockError;
        }
      } catch (journalError) {
        if (!journalSave) projectState = State.clearPendingTransaction(projectState, new Date());
        throw new Error("无法记录本次移动，素材尚未移动: " + (journalError.message || journalError));
      }

      try {
        var result = await Transaction.moveAndRelink({
          fs: fs,
          project: context.project,
          projectItems: group.entries.map(function (entry) { return entry.clip; }),
          sourcePath: sourcePath,
          targetPath: targetPath,
          cleanupPath: cleanupPath,
          deleteSource: true,
          validate: function () { return Premiere.contextStillActive(ppro, context.identity); },
          persistProject: function () { return context.project.save(); },
          onStage: function (stage) {
            busyStage = stage;
            render();
          },
        });
        if (result.cleanupPending) {
          var cleanupError = new Error(result.cleanupWarning || "原位置文件没有删除，请手动删除后重新检查");
          cleanupError.code = "MATERIAL_BATCH_SOURCE_CLEANUP_REQUIRED";
          throw cleanupError;
        }
        result.id = transactionId;
        result.targetRelativePath = targetRelativePath;
        result.batchIndex = batch.index;
        result.sourceFingerprint = sourceFingerprint;
        projectState = State.commitTransaction(projectState, result, new Date());
        stabilityTracker.forget(sourcePath);
        projectState = State.addActivity(
          projectState,
          result.sourceChanged ? "warn" : "ok",
          result.sourceChanged ? "素材已移动；原路径出现另一份文件" : "已整理 " + Core.basename(targetPath),
          new Date(),
          { summary: result.sourceChanged ? sourcePath : formatBytes(result.byteCount) }
        );
        await persistState();
        return result;
      } catch (error) {
        projectState = error.code === "MATERIAL_BATCH_SOURCE_CLEANUP_REQUIRED"
          ? State.markCleanupPending(projectState, error.message || error, new Date())
          : State.failTransaction(projectState, error.message || error, new Date());
        projectState = State.addActivity(projectState, "error", "整理失败：" + Core.basename(sourcePath), new Date(), {
          summary: error.message || String(error),
        });
        try { await persistState(); } catch (persistError) {}
        setMachineSetting("auto", false);
        panelError = (error.message || String(error)) + (error.rollbackWarnings && error.rollbackWarnings.length ? "；" + error.rollbackWarnings.join("；") : "");
        throw error;
      }
    } finally {
      busy = false;
      busyStage = "";
      render();
    }
  }

  async function applyExistingMapping(group, decision) {
    var mapping = decision.mapping;
    var targetPath = targetPathForMapping(mapping);
    if (Core.samePath(group.mediaPath, targetPath)) return false;
    var verification = await inspectMappingTarget(mapping);
    if (verification.kind !== "match") return { applied: false, decision: verification };
    if (decision.targetFingerprint
      && !Transaction.samePortableFingerprint(decision.targetFingerprint, verification.targetFingerprint)) {
      verification.kind = "mapping-target-mismatch";
      return { applied: false, decision: verification };
    }
    busy = true;
    busyStage = "relink";
    render();
    var projectSaveRecord = null;
    try {
      var itemIds = group.entries.map(function (entry) { return String(entry.itemId || ""); }).filter(Boolean);
      if (itemIds.length !== group.entries.length) {
        throw new Error("Premiere 没有提供完整的素材项身份，不能安全地自动补链");
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
      };
      projectState = State.beginProjectSave(projectState, projectSaveRecord, new Date());
      var journalSave = await persistState();
      if (journalSave.lockReleaseWarning) {
        throw new Error("补链记录已经写入，但状态写锁未能清理；Premiere 链接尚未修改");
      }
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
        || !Transaction.samePortableFingerprint(verification.targetFingerprint, afterRelink.targetFingerprint)) {
        var changed = new Error("补链期间新位置文件发生变化，已停止自动整理");
        changed.code = "MATERIAL_BATCH_MAPPING_TARGET_CHANGED";
        throw changed;
      }
      projectState = State.clearPendingProjectSave(projectState, new Date());
      projectState = State.addActivity(projectState, "ok", "已为当前工程补链 " + Core.basename(targetPath), new Date());
      await persistState();
      return { applied: true, decision: afterRelink };
    } catch (error) {
      if (projectState && projectSaveRecord) {
        if (!projectState.pendingProjectSave) {
          projectState = State.beginProjectSave(projectState, projectSaveRecord, new Date());
        }
        projectState = State.failProjectSave(projectState, error.message || error, new Date());
        projectState = State.addActivity(projectState, "error", "Premiere 补链尚未确认保存", new Date(), {
          summary: error.message || String(error),
        });
        try { await persistState(); } catch (persistError) {}
      }
      setMachineSetting("auto", false);
      panelError = (error.message || String(error))
        + (error.rollbackWarnings && error.rollbackWarnings.length ? "；" + error.rollbackWarnings.join("；") : "");
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
      && String(known.targetRelativePath || "") === targetRelativePath) return false;
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
    if (scanOptions.skipRefresh !== true) await refreshContext({ force: scanOptions.forceContext === true });
    if (!context || !context.projectPath || !projectState) {
      render();
      return { ok: false, error: "没有已保存的活动工程" };
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
    if (projectState.pendingTransaction) {
      panelError = "检测到上次整理未完成，自动整理已暂停";
      setMachineSetting("auto", false);
      stopMonitor(false);
      render();
      return { ok: false, error: panelError };
    }
    if (projectState.pendingProjectSave) {
      panelError = "Premiere 工程还有一处补链没有确认保存，自动整理已暂停";
      setMachineSetting("auto", false);
      stopMonitor(false);
      render();
      return { ok: false, error: panelError };
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
      Premiere.assertCompleteInventory(inventory);
      var classifications = groups.map(function (group) {
        return Core.classifyMediaPath(group.mediaPath, {
          mediaRoot: mediaRoot(),
          protectedRoots: workspaceProtectedMappings(),
        });
      });

      var observedCollectionPaths = [];
      var observedAt = Date.now();
      for (var fingerprintIndex = 0; fingerprintIndex < groups.length; fingerprintIndex += 1) {
        var fingerprintKind = classifications[fingerprintIndex].kind;
        if (["collect", "review"].indexOf(fingerprintKind) < 0) continue;
        try {
          var fingerprintStat = await fs.lstat(groups[fingerprintIndex].mediaPath);
          groups[fingerprintIndex].sourceFingerprint = typeof fingerprintStat.isFile === "function" && fingerprintStat.isFile()
            ? Transaction.fingerprintFromStat(fingerprintStat)
            : null;
        } catch (fingerprintError) {
          groups[fingerprintIndex].sourceFingerprint = null;
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

      if (!projectState.initialized) {
        if (scanOptions.initializeBaseline === true) {
          projectState = State.initializeBaseline(projectState, groups, classifications, new Date());
          projectState = State.markProjectBaseline(projectState, context.projectPath, groups, new Date());
          projectState = State.addActivity(projectState, "ok", "已建立现有素材基线", new Date(), {
            summary: groups.length + " 条路径，旧引用未移动",
          });
          await ensureBatchDirectories();
          await persistState();
        } else {
          render();
          return { ok: true, initialized: false };
        }
      }

      var dirtyState = false;
      var firstProjectScan = !State.projectHasBaseline(projectState, context.projectPath);
      for (var index = 0; index < groups.length; index += 1) {
        var group = groups[index];
        var classification = classifications[index];
        var key = group.key;
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

        var known = projectState.knownMedia[key];
        if (classification.kind === "protected") {
          lastProtectedCount += 1;
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
          var reviewBaselineStatus = State.projectBaselineStatus(projectState, context.projectPath, group.mediaPath, group.sourceFingerprint);
          if (firstProjectScan || reviewBaselineStatus === "match") continue;
          if (recordReview(group, "review", {
            type: "整组素材",
            reason: classification.reason,
            note: "请将所在文件夹加入“不搬动文件夹”，或在 Premiere 中手动重新链接后再检查。",
            revealPath: Core.dirname(group.mediaPath),
            actions: [["reveal", "打开所在位置", "secondary"], ["retry", "重新检查", "secondary"]],
          })) dirtyState = true;
          continue;
        }

        if (firstProjectScan) {
          continue;
        }

        if (!ScanPolicy.hasPortableFingerprint(group.sourceFingerprint)) {
          if (recordReview(group, "source-unavailable", {
            type: "无法读取",
            reason: "当前无法读取这个文件的大小和修改时间，插件不会冒险移动。",
            revealPath: Core.dirname(group.mediaPath),
            actions: [["reveal", "打开所在位置", "secondary"], ["retry", "重新检查", "secondary"]],
          })) dirtyState = true;
          continue;
        }
        var baselineStatus = State.projectBaselineStatus(projectState, context.projectPath, group.mediaPath, group.sourceFingerprint);
        var movedAfterBaseline = State.mappingMovedAfterProjectBaseline(projectState, context.projectPath, mappingsForKey(key));
        if (baselineStatus === "match" && !movedAfterBaseline) continue;
        if (baselineStatus === "unverified") {
          if (recordReview(group, "baseline-unverified", {
            type: "首次识别",
            reason: "这个工程的旧记录缺少可核对的文件信息，不能判断它原本是否就在工程中。",
            sourceFingerprint: group.sourceFingerprint,
            revealPath: Core.dirname(group.mediaPath),
            actions: [["baseline-keep", "视为原有素材", "secondary"], ["baseline-move", "整理这个文件", "primary"]],
          })) dirtyState = true;
          continue;
        }
        pendingCount += 1;
        if (!currentAutoSetting()) continue;
        if (!group.stability || group.stability.ready !== true) continue;
        try {
          await processGroup(group, lifecycleGeneration);
        } catch (error) {
          if (error && error.code === "MATERIAL_BATCH_FILE_NOT_READY") continue;
          throw error;
        }
        pendingCount = Math.max(0, pendingCount - 1);
        dirtyState = true;
      }

      if (firstProjectScan) {
        projectState = State.markProjectBaseline(projectState, context.projectPath, groups, new Date());
        projectState = State.addActivity(projectState, "ok", "已接入同目录中的另一个工程版本", new Date(), {
          summary: "已记住现有素材，以后只整理新导入素材",
        });
        dirtyState = true;
      }

      if (dirtyState) await persistState();
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
          panelError = (error.message || String(error))
            + (error.rollbackWarnings && error.rollbackWarnings.length ? "；" + error.rollbackWarnings.join("；") : "");
          if (projectState) projectState = State.addActivity(projectState, "error", "检查已停止", new Date(), { summary: panelError });
        }
      }
      if (projectState) {
        setMachineSetting("auto", false);
        stopMonitor(false);
      }
      return { ok: false, error: panelError || error.message || String(error) };
    } finally {
      busy = false;
      busyStage = "";
      render();
    }
  }

  function requestScan(options) {
    return operationQueue.run(function () { return scanUnlocked(options); }).catch(function (error) {
      panelError = error.message || String(error);
      stateReloadRequired = true;
      if (projectState) {
        setMachineSetting("auto", false);
        stopMonitor(false);
      }
      render();
      return { ok: false, error: panelError };
    });
  }

  function onImportComplete(event) {
    var successState = ppro.Constants && ppro.Constants.OperationCompleteState
      ? ppro.Constants.OperationCompleteState.SUCCESS
      : null;
    if (!Coordination.shouldHandleOperationComplete(event, successState)) return;
    requestSoonScan();
  }

  function onProjectDirty() {
    requestSoonScan();
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
      requestScan().finally(function () { schedulePoll(generation); });
    }, POLL_INTERVAL_MS);
  }

  function requestSoonScan() {
    if (!monitoring || soonTimer) return;
    soonTimer = setTimeout(function () {
      soonTimer = null;
      requestScan();
    }, 220);
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
      autoEnabled: currentAutoSetting(),
      hasProject: Boolean(context && context.projectPath && projectState),
      pendingTransaction: Boolean(projectState && projectState.pendingTransaction),
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
    if (enabled && unresolvedProtectedLibraries().length) {
      setMachineSetting("auto", false);
      panelError = "请先在设置中重新选择交接过来的共享素材文件夹";
      render();
      return;
    }

    setMachineSetting("auto", enabled);
    if (!enabled) {
      stopMonitor(false);
      projectState = State.addActivity(projectState, "warn", "自动整理已暂停", new Date());
      await persistState();
      render();
      return;
    }

    panelError = "";
    var initialScan = await scanUnlocked({ initializeBaseline: !projectState.initialized });
    if (!initialScan || !initialScan.ok) {
      setMachineSetting("auto", false);
      stopMonitor(false);
      render();
      return;
    }
    if (!projectState.pendingTransaction && !projectState.pendingProjectSave && currentAutoSetting()) {
      syncMonitor();
      requestSoonScan();
    }
    render();
  }

  function setAutomatic(enabled) {
    return operationQueue.run(function () {
      return setAutomaticUnlocked(enabled);
    }).catch(function (error) {
      panelError = error.message || String(error);
      render();
    });
  }

  async function openCurrentBatch() {
    await operationQueue.run(async function () {
      await refreshContext();
      if (!context || !projectState) throw new Error("没有可打开的素材文件夹");
      await ensureBatchDirectories();
      var result = await uxp.shell.openPath(batchPath(), "打开本批素材");
      if (result) throw new Error(String(result));
    }).catch(function (error) {
      panelError = "打开目录失败: " + (error.message || error);
      render();
    });
  }

  async function recoverPendingTransaction() {
    await operationQueue.run(async function () {
      await refreshContext();
      if (!context || !context.projectPath) throw new Error("请先打开并保存 Premiere 工程");
      projectState = await readProjectState(context);
      var pendingProjectSave = projectState && projectState.pendingProjectSave;
      var pending = projectState && projectState.pendingTransaction;
      if (!pending && !pendingProjectSave) {
        panelError = "";
        return scanUnlocked();
      }
      setMachineSetting("auto", false);
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

        busy = true;
        busyStage = "scan";
        render();
        try {
          var pendingTargetPath = targetPathForMapping(pendingProjectSave);
          var pendingTargetFingerprint = await currentFileFingerprint(pendingTargetPath);
          if (!Transaction.samePortableFingerprint(pendingProjectSave.targetFingerprint, pendingTargetFingerprint)) {
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
          if (pendingEntries.some(function (entry) { return !entry; })) {
            throw new Error("当前工程中的素材项与补链记录不一致，不能自动重新保存");
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
          for (var linkedIndex = 0; linkedIndex < entriesAtTarget.length; linkedIndex += 1) {
            var linkedClip = entriesAtTarget[linkedIndex].clip;
            await linkedClip.refreshMedia();
            var linkedPath = await linkedClip.getMediaFilePath();
            if (!Core.samePath(linkedPath, pendingTargetPath) || (await linkedClip.isOffline())) {
              throw new Error("记录中的新位置在 Premiere 中仍然离线，未重新保存工程");
            }
          }

          if (entriesAtSource.length) {
            busyStage = "relink";
            render();
            await Transaction.relinkExisting({
              fs: fs,
              projectItems: entriesAtSource.map(function (entry) { return entry.clip; }),
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
          if (!Transaction.samePortableFingerprint(pendingTargetFingerprint, afterSaveFingerprint)) {
            throw new Error("重新保存期间新位置文件发生变化，已保留待检查记录");
          }

          projectState = State.clearPendingProjectSave(projectState, new Date());
          projectState = State.addActivity(projectState, "ok", "已确认 Premiere 工程保存完成", new Date(), {
            summary: Core.basename(pendingTargetPath),
          });
          await persistState();
          panelError = "";
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

      busy = true;
      busyStage = "scan";
      render();
      var targetPath = targetPathForMapping(pending);
      var inventory = await Premiere.inventoryProject(ppro, context.project);
      Premiere.assertCompleteInventory(inventory);
      var outcome = await Recovery.inspectPending({
        fs: fs,
        pending: pending,
        targetPath: targetPath,
        mediaRoot: mediaRoot(),
        linkedEntries: inventory.entries.map(function (entry) {
          return { itemId: entry.itemId, mediaPath: entry.mediaPath };
        }),
      });

      if (outcome.kind === "manual") throw new Error(outcome.reason);
      if (!(await Premiere.contextStillActive(ppro, context.identity))) throw new Error("恢复检查期间活动工程已切换");
      if (outcome.kind === "rolled-back") {
        projectState = State.clearPendingTransaction(projectState, new Date());
        projectState = State.addActivity(projectState, "ok", "已确认上次整理安全回滚", new Date(), {
          summary: Core.basename(pending.sourcePath),
        });
        await persistState();
        panelError = "";
        return;
      }
      if (outcome.targetExists !== true) {
        throw new Error("恢复时找不到新位置文件，已保留待检查记录，请人工检查");
      }
      // 保留首次恢复检查取得的文件指纹。旧版记录可能没有指纹；
      // 遇到这种情况，就把这次经过验证的读取结果作为恢复基线。
      // 后续读取绝不能把替换文件误写成新的已提交映射。
      var recoveryTargetFingerprint = await currentFileFingerprint(targetPath);
      if (ScanPolicy.hasPortableFingerprint(pending.targetFingerprint)
        && !Transaction.samePortableFingerprint(pending.targetFingerprint, recoveryTargetFingerprint)) {
        throw new Error("恢复检查后新位置文件已发生变化，已保留待检查记录，请人工检查");
      }
      busyStage = "save";
      render();
      await verifyRecoveryTargetFingerprint(targetPath, recoveryTargetFingerprint, "保存前");
      if ((await context.project.save()) === false) {
        throw new Error("Premiere 工程仍未保存，原位置文件未处理");
      }
      if (!(await Premiere.contextStillActive(ppro, context.identity))) {
        throw new Error("恢复保存期间活动工程已切换");
      }
      await verifyRecoveryTargetFingerprint(targetPath, recoveryTargetFingerprint, "保存后");
      if (outcome.cleanupPending) {
        var remainingSourcePath = outcome.remainingSourcePath || pending.sourcePath;
        var cleanupMessage = "待删除的原素材仍然存在：" + remainingSourcePath + "。请先手动删除它，再点击“检查上次整理”";
        projectState = State.markCleanupPending(projectState, cleanupMessage, new Date());
        projectState = State.addActivity(projectState, "error", "原素材还没有彻底移走", new Date(), { summary: remainingSourcePath });
        await persistState();
        throw new Error(cleanupMessage);
      }

      await verifyRecoveryTargetFingerprint(targetPath, recoveryTargetFingerprint, "记录前");
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
          mode: pending.mode || (Core.isSameVolume(pending.sourcePath, targetPath) ? "rename" : "copy"),
          projectPath: pending.projectPath || context.projectPath,
          projectIdentity: pending.projectIdentity || context.identity,
          cleanupPending: outcome.cleanupPending === true,
          sourceChanged: outcome.sourceChanged === true,
          targetFingerprint: recoveryTargetFingerprint,
        }, new Date());
        projectState = State.addActivity(projectState, outcome.cleanupPending ? "warn" : "ok", outcome.cleanupPending ? "原位置文件已保留：" + Core.basename(pending.sourcePath) : "已恢复上次整理记录", new Date(), {
          summary: outcome.cleanupPending
            ? pending.sourcePath
            : outcome.sourceChanged
              ? "目标已在线；源路径现为另一份文件，未触碰"
              : "目标文件与 Premiere 链接已确认",
        });
        await verifyRecoveryTargetFingerprint(targetPath, recoveryTargetFingerprint, "记录后");
        await persistState();
      } catch (commitError) {
        projectState = stateBeforeCommit;
        try { await persistState(); } catch (persistError) {}
        throw commitError;
      }
      panelError = "";
    }).catch(function (error) {
      panelError = error.message || String(error);
    }).finally(function () {
      busy = false;
      busyStage = "";
      render();
    });
  }

  async function confirmHandoff() {
    var message = "完成当前交接，并建立下一个素材文件夹？\n\n不会复制或移动任何 Premiere 工程文件。";
    if (typeof window.confirm === "function") return window.confirm(message);
    return true;
  }

  async function handoffCurrentBatch() {
    if (!(await confirmHandoff())) return;
    await operationQueue.run(async function () {
      await refreshContext();
      if (!context || !projectState || !projectState.initialized) throw new Error("当前工程还没有开启自动整理");
      busy = true;
      busyStage = "handoff";
      render();
      var scanResult = await scanUnlocked();
      busy = true;
      busyStage = "handoff";
      render();
      if (!scanResult || !scanResult.ok || panelError || storageWarning) throw new Error(scanResult && scanResult.error ? scanResult.error : "交接前检查失败");
      if (pendingCount > 0) throw new Error("仍有 " + pendingCount + " 个新素材没有整理完成");
      if (reviewCount > 0) throw new Error("仍有 " + reviewCount + " 个素材需要确认");
      if (projectState.pendingTransaction) throw new Error("存在未收口的文件事务");
      var previous = State.currentBatch(projectState);
      projectState = State.lockAndCreateNextBatch(projectState, new Date());
      projectState = State.addActivity(projectState, "ok", "交接文件夹 " + previous.name + " 已完成", new Date(), {
        summary: "Premiere 工程文件未移动，下一个素材文件夹已建立",
      });
      await ensureBatchDirectories();
      await persistState();
      panelError = "";
    }).catch(function (error) {
      panelError = error.message || String(error);
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

  async function validateChosenProtectedFolder(rootPath) {
    if (!Core.isAbsoluteLocalPath(rootPath)) throw new Error("没有取得有效的绝对目录路径");
    if (mediaRoot() && Core.isPathInside(rootPath, mediaRoot())) {
      throw new Error("已经整理到“素材”里的文件不需要再设为不搬动");
    }
    var stat = await fs.lstat(rootPath);
    if (!stat || typeof stat.isDirectory !== "function" || !stat.isDirectory()) {
      throw new Error("选择的路径不是文件夹");
    }
  }

  async function chooseProtectedFolder(existingLibraryId) {
    if (!projectState || busy) return;
    var expectedIdentity = context && context.identity;
    stopMonitor(false);
    try {
      var folder = await uxp.storage.localFileSystem.getFolder();
      if (!folder) {
        syncMonitor();
        return;
      }
      var rootPath = String(folder.nativePath || "");
      await validateChosenProtectedFolder(rootPath);
      await operationQueue.run(async function () {
        await refreshContext();
        if (!context || context.identity !== expectedIdentity || !projectState) {
          throw new Error("选择文件夹期间活动工程已切换，请重新选择");
        }
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
          machineSettings.protectedMappings = machineSettings.protectedMappings.filter(function (mapping) { return mapping.libraryId !== libraryId; });
          machineSettings.protectedMappings.push({ libraryId: libraryId, label: label, rootPath: rootPath });
          saveMachineSettings();
          projectState = State.addProtectedLibrary(projectState, libraryId, label, new Date());
          projectState = State.addActivity(projectState, "ok", "这里的素材不会移动：" + label, new Date(), { summary: rootPath });
          await persistState();
        } catch (error) {
          machineSettings = previousSettings;
          projectState = previousState;
          try { saveMachineSettings(); } catch (settingsRollbackError) {}
          throw error;
        }
        await refreshProtectedMappingStatus();
        if (unresolvedProtectedLibraries().length) setMachineSetting("auto", false);
        var pathInput = element("protectedPathInput");
        if (pathInput) pathInput.value = rootPath;
        panelError = "";
      });
    } catch (error) {
      try { await refreshProtectedMappingStatus(); } catch (validationError) {}
      panelError = "添加“不搬动文件夹”失败: " + (error.message || error);
    } finally {
      syncMonitor();
      render();
    }
  }

  async function removeProtectedLibrary(libraryId) {
    if (!projectState || busy) return;
    var library = projectState.protectedLibraries.find(function (candidate) { return candidate.libraryId === libraryId; });
    if (!library) return;
    var approved = typeof window.confirm !== "function" || window.confirm("允许移动“" + library.label + "”里的新素材？\n\n移除后，这个文件夹里的新导入素材可能会被整理走。");
    if (!approved) return;
    var expectedIdentity = context && context.identity;
    await operationQueue.run(async function () {
      await refreshContext();
      if (!context || context.identity !== expectedIdentity || !projectState) {
        throw new Error("移除文件夹期间活动工程已切换，请重新操作");
      }
      stopMonitor(false);
      setMachineSetting("auto", false);
      projectState = State.removeProtectedLibrary(projectState, libraryId, new Date());
      projectState = State.addActivity(projectState, "warn", "已允许移动这里的素材：" + library.label, new Date());
      await persistState();
      await refreshProtectedMappingStatus();
    }).catch(function (error) {
      panelError = "移除“不搬动文件夹”失败: " + (error.message || error);
    }).finally(function () {
      syncMonitor();
      render();
    });
  }

  function openSettingsDrawer() {
    var button = element("settingsButton");
    if (button) button.click();
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
    if (!Core.isAbsoluteLocalPath(revealPath)) throw new Error("无法确定要打开的文件夹");
    var result = await uxp.shell.openPath(revealPath, "打开素材所在位置");
    if (result) throw new Error(String(result));
  }

  async function currentFileFingerprint(nativePath) {
    var stat = await fs.lstat(nativePath);
    if (!stat || typeof stat.isFile !== "function" || !stat.isFile()) throw new Error("当前路径不是单个文件");
    var fingerprint = Transaction.fingerprintFromStat(stat);
    if (!ScanPolicy.hasPortableFingerprint(fingerprint)) throw new Error("当前文件缺少可验证的修改时间，请稍后重试");
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
    if (!Transaction.samePortableFingerprint(expectedFingerprint, currentFingerprint)) {
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
      if (action === "reveal") return revealReviewLocation(review);
      if (action === "retry") return scanUnlocked({ skipRefresh: true });
      if (!projectState || !context || !context.projectPath) throw new Error("当前 Premiere 工程不可用");

      if (action === "baseline-keep" || action === "baseline-move") {
        var fingerprint = await currentFileFingerprint(review.sourcePath);
        if (!Transaction.samePortableFingerprint(review.sourceFingerprint, fingerprint)) {
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
        if (!ScanPolicy.hasPortableFingerprint(review.targetFingerprint)
          || !Transaction.samePortableFingerprint(review.targetFingerprint, targetFingerprint)) {
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
      panelError = error.message || String(error);
    }).finally(function () {
      syncMonitor();
      render();
    });
  }

  async function handleStateAction() {
    var action = element("stateAction");
    var intent = action ? action.dataset.intent : "";
    if (intent === "开启自动整理" || intent === "继续自动整理") return setAutomatic(true);
    if (intent === "选择文件夹" || intent === "查看不搬动文件夹") return openSettingsDrawer();
    if (intent === "查看待确认素材") return openReviewList();
    if (intent === "查看最近记录") return openActivityLog();
    if (intent === "检查上次整理") return recoverPendingTransaction();
    return requestScan({ forceContext: true });
  }

  function bindUi() {
    window.addEventListener("batch-collector:refresh", function () { requestScan(); });
    window.addEventListener("batch-collector:open-batch", openCurrentBatch);
    window.addEventListener("batch-collector:handoff", handoffCurrentBatch);
    window.addEventListener("batch-collector:auto-collect", function (event) {
      setAutomatic(Boolean(event.detail && event.detail.enabled));
    });
    window.addEventListener("batch-collector:state-action", handleStateAction);
    window.addEventListener("batch-collector:review-action", handleReviewAction);

    var addProtected = element("addProtectedButton");
    if (addProtected) addProtected.addEventListener("click", function () { chooseProtectedFolder(""); });
    var protectedList = element("protectedList");
    if (protectedList) protectedList.addEventListener("click", function (event) {
      var button = event.target.closest ? event.target.closest("button[data-library-id]") : null;
      if (!button) return;
      if (button.dataset.action === "map") chooseProtectedFolder(button.dataset.libraryId);
      if (button.dataset.action === "remove") removeProtectedLibrary(button.dataset.libraryId);
    });
    var pathInput = element("protectedPathInput");
    if (pathInput) {
      pathInput.readOnly = true;
      pathInput.placeholder = "点击“选择文件夹”";
    }
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
        if (context && projectState) await scanUnlocked({ skipRefresh: true });
        syncMonitor();
      } catch (error) {
        panelError = error.message || String(error);
        syncMonitor();
        render();
      }
    });
  }

  function panelHide() {
    panelVisible = false;
    stopMonitor(false);
    stabilityTracker.clear();
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
    panelError = event && event.message ? event.message : "面板发生错误";
    render();
  });
  window.addEventListener("unhandledrejection", function (event) {
    var reason = event && event.reason;
    panelError = reason && reason.message ? reason.message : String(reason || "未处理的异步错误");
    render();
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initializePanel);
  else initializePanel();
})();
