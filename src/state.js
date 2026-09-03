(function (root, factory) {
  "use strict";

  var api = factory(typeof module !== "undefined" && module.exports ? require("./core") : root.MaterialBatchCore);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.MaterialBatchState = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (Core) {
  "use strict";

  var SCHEMA_VERSION = 1;
  var HISTORY_LIMIT = 200;
  var TRANSACTION_LIMIT = 100;

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function iso(value) {
    var date = value instanceof Date ? value : new Date(value || Date.now());
    return date.toISOString();
  }

  function initialBatch(now) {
    return {
      index: 1,
      name: Core.batchName(1, now),
      status: "open",
      createdAt: iso(now),
      lockedAt: "",
      fileCount: 0,
      byteCount: 0,
    };
  }

  function createState(workspaceRoot, now) {
    var createdAt = iso(now);
    return {
      schemaVersion: SCHEMA_VERSION,
      mediaSpaceId: Core.makeMediaSpaceId(workspaceRoot, createdAt),
      workspaceName: Core.basename(workspaceRoot),
      mediaFolderName: "素材",
      initialized: false,
      currentBatchIndex: 1,
      batches: [initialBatch(now)],
      protectedLibraries: [],
      projects: {},
      knownMedia: {},
      pathMappings: {},
      pendingTransaction: null,
      pendingProjectSave: null,
      transactions: [],
      activity: [],
      createdAt: createdAt,
      updatedAt: createdAt,
    };
  }

  function validBatch(raw, now) {
    raw = raw || {};
    var index = Math.max(1, Math.floor(Number(raw && raw.index) || 1));
    return {
      index: index,
      name: typeof raw.name === "string" && Core.isSafePathSegment(raw.name) ? raw.name : Core.batchName(index, now),
      status: raw.status === "locked" ? "locked" : "open",
      createdAt: typeof raw.createdAt === "string" ? raw.createdAt : iso(now),
      lockedAt: typeof raw.lockedAt === "string" ? raw.lockedAt : "",
      fileCount: Math.max(0, Math.floor(Number(raw.fileCount) || 0)),
      byteCount: Math.max(0, Number(raw.byteCount) || 0),
    };
  }

  function objectOrEmpty(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? clone(value) : {};
  }

  function canonicalKey(key, value) {
    var candidate = value && (value.path || value.sourcePath) || key;
    return Core.normalizePathForComparison(candidate);
  }

  function mergeKeyedValue(target, key, value) {
    if (!key) return;
    if (target[key] == null) {
      target[key] = value;
      return;
    }
    if (Array.isArray(target[key])) {
      target[key] = target[key].concat(Array.isArray(value) ? value : [value]);
    } else if (Array.isArray(value)) {
      target[key] = [target[key]].concat(value);
    } else if (JSON.stringify(target[key]) !== JSON.stringify(value)) {
      target[key] = [target[key], value];
    }
  }

  function isRecord(value) {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  function hasPortableFingerprint(value) {
    if (!isRecord(value)) return false;
    var size = Number(value.size);
    var mtimeMs = Number(value.mtimeMs);
    return Number.isFinite(size) && size >= 0 && Number.isFinite(mtimeMs) && mtimeMs > 0;
  }

  function isCompatibleState(raw) {
    if (!isRecord(raw) || raw.schemaVersion !== SCHEMA_VERSION) return false;
    if (typeof raw.mediaSpaceId !== "string" || !raw.mediaSpaceId) return false;
    if (typeof raw.mediaFolderName !== "string") return false;
    if (!Array.isArray(raw.batches) || !raw.batches.length) return false;
    if (!isRecord(raw.projects) || !isRecord(raw.knownMedia) || !isRecord(raw.pathMappings)) return false;
    if (!Array.isArray(raw.protectedLibraries) || !Array.isArray(raw.transactions) || !Array.isArray(raw.activity)) return false;
    if (raw.pendingTransaction != null && !isRecord(raw.pendingTransaction)) return false;
    if (raw.pendingProjectSave != null) {
      if (!isRecord(raw.pendingProjectSave)) return false;
      if (typeof raw.pendingProjectSave.sourcePath !== "string" || !raw.pendingProjectSave.sourcePath) return false;
      if (!Core.isSafeRelativePath(raw.pendingProjectSave.targetRelativePath)) return false;
    }
    if (raw.pendingTransaction && raw.pendingProjectSave) return false;
    return true;
  }

  function validateStoredState(raw) {
    if (isRecord(raw)
      && Object.prototype.hasOwnProperty.call(raw, "schemaVersion")
      && raw.schemaVersion !== SCHEMA_VERSION) {
      var error = new Error("素材空间状态由其他版本的插件创建，当前版本不会覆盖它");
      error.code = "MATERIAL_BATCH_STATE_SCHEMA_UNSUPPORTED";
      error.preventBackupFallback = true;
      throw error;
    }
    return isCompatibleState(raw);
  }

  function hydrateState(raw, workspaceRoot, now) {
    if (!isCompatibleState(raw)) {
      var error = new Error(raw && raw.schemaVersion !== undefined && raw.schemaVersion !== SCHEMA_VERSION
        ? "素材空间状态版本不受当前插件支持，已停止自动整理"
        : "素材空间状态结构不完整，已停止自动整理");
      error.code = raw && raw.schemaVersion !== undefined && raw.schemaVersion !== SCHEMA_VERSION
        ? "MATERIAL_BATCH_STATE_SCHEMA_UNSUPPORTED"
        : "MATERIAL_BATCH_STATE_INVALID";
      throw error;
    }

    var state = createState(workspaceRoot, now);
    state.mediaSpaceId = typeof raw.mediaSpaceId === "string" && raw.mediaSpaceId ? raw.mediaSpaceId : state.mediaSpaceId;
    state.workspaceName = typeof raw.workspaceName === "string" && raw.workspaceName ? raw.workspaceName : state.workspaceName;
    state.mediaFolderName = typeof raw.mediaFolderName === "string" && Core.isSafePathSegment(raw.mediaFolderName) ? raw.mediaFolderName : "素材";
    state.initialized = raw.initialized === true;
    state.batches = Array.isArray(raw.batches) && raw.batches.length
      ? raw.batches.map(function (batch) { return validBatch(batch, now); })
      : [initialBatch(now)];
    state.batches.sort(function (left, right) { return left.index - right.index; });
    state.currentBatchIndex = Math.max(1, Math.floor(Number(raw.currentBatchIndex) || state.batches[state.batches.length - 1].index));
    if (!state.batches.some(function (batch) { return batch.index === state.currentBatchIndex; })) {
      state.currentBatchIndex = state.batches[state.batches.length - 1].index;
    }

    state.protectedLibraries = Array.isArray(raw.protectedLibraries)
      ? raw.protectedLibraries.filter(function (library) {
          return library && typeof library.libraryId === "string" && library.libraryId && typeof library.label === "string";
        }).map(function (library) {
          return { libraryId: library.libraryId, label: library.label };
        })
      : [];
    state.projects = objectOrEmpty(raw.projects);
    state.knownMedia = {};
    Object.keys(objectOrEmpty(raw.knownMedia)).forEach(function (sourceKey) {
      var value = clone(raw.knownMedia[sourceKey]);
      state.knownMedia[canonicalKey(sourceKey, value)] = value;
    });
    state.pathMappings = {};
    Object.keys(objectOrEmpty(raw.pathMappings)).forEach(function (sourceKey) {
      var rawMappings = Array.isArray(raw.pathMappings[sourceKey]) ? raw.pathMappings[sourceKey] : [raw.pathMappings[sourceKey]];
      var safeMappings = rawMappings.filter(function (mapping) {
        return mapping && typeof mapping === "object" && Core.isSafeRelativePath(mapping.targetRelativePath);
      }).map(function (mapping) { return clone(mapping); });
      if (safeMappings.length) {
        var canonicalSourceKey = canonicalKey(sourceKey, safeMappings[0]);
        mergeKeyedValue(state.pathMappings, canonicalSourceKey, safeMappings);
      }
    });
    state.projects = Object.keys(state.projects).reduce(function (projects, projectKey) {
      var project = projects[projectKey];
      if (project && project.baselineMedia && typeof project.baselineMedia === "object") {
        var migratedBaseline = {};
        Object.keys(project.baselineMedia).forEach(function (sourceKey) {
          var entry = project.baselineMedia[sourceKey];
          migratedBaseline[canonicalKey(sourceKey, entry)] = entry;
        });
        project.baselineMedia = migratedBaseline;
      }
      return projects;
    }, state.projects);
    state.pendingTransaction = raw.pendingTransaction && typeof raw.pendingTransaction === "object" ? clone(raw.pendingTransaction) : null;
    state.pendingProjectSave = raw.pendingProjectSave && typeof raw.pendingProjectSave === "object" ? clone(raw.pendingProjectSave) : null;
    state.transactions = Array.isArray(raw.transactions) ? clone(raw.transactions.slice(-TRANSACTION_LIMIT)) : [];
    state.activity = Array.isArray(raw.activity) ? clone(raw.activity.slice(-HISTORY_LIMIT)) : [];
    state.createdAt = typeof raw.createdAt === "string" ? raw.createdAt : state.createdAt;
    state.updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : state.updatedAt;
    return state;
  }

  function currentBatch(state) {
    return state.batches.find(function (batch) {
      return batch.index === state.currentBatchIndex;
    }) || state.batches[state.batches.length - 1];
  }

  function currentBatchPath(state, workspaceRoot) {
    var batch = currentBatch(state);
    return Core.joinNativePath(workspaceRoot, state.mediaFolderName, batch.name);
  }

  function touch(state, at) {
    state.updatedAt = iso(at);
    return state;
  }

  function addActivity(state, level, message, at, details) {
    var next = clone(state);
    next.activity.push({
      at: iso(at),
      level: ["ok", "warn", "error"].indexOf(level) >= 0 ? level : "info",
      message: String(message || ""),
      details: details && typeof details === "object" ? clone(details) : {},
    });
    next.activity = next.activity.slice(-HISTORY_LIMIT);
    return touch(next, at);
  }

  function registerProject(state, projectPath, projectName, at) {
    var next = clone(state);
    var key = projectKey(projectPath);
    var previous = next.projects[key] || {};
    next.projects[key] = Object.assign({}, previous, {
      fileName: Core.basename(projectPath),
      displayName: String(projectName || Core.basename(projectPath)),
      lastSeenAt: iso(at),
      baselineEstablished: previous.baselineEstablished === true,
      baselineVersion: Math.max(0, Math.floor(Number(previous.baselineVersion) || 0)),
      baselineMedia: objectOrEmpty(previous.baselineMedia),
    });
    return touch(next, at);
  }

  function projectKey(projectPath) {
    return Core.normalizePathForComparison(projectPath);
  }

  function projectHasBaseline(state, projectPath) {
    var project = state && state.projects ? state.projects[projectKey(projectPath)] : null;
    return Boolean(project && project.baselineEstablished === true && project.baselineVersion === 1);
  }

  function markProjectBaseline(state, projectPath, entries, at) {
    if (!Array.isArray(entries)) {
      at = entries;
      entries = [];
    }
    var next = clone(state);
    var key = projectKey(projectPath);
    if (!next.projects[key]) {
      next.projects[key] = {
        fileName: Core.basename(projectPath),
        displayName: Core.basename(projectPath),
        lastSeenAt: iso(at),
      };
    }
    next.projects[key].baselineEstablished = true;
    next.projects[key].baselineVersion = 1;
    next.projects[key].baselineAt = iso(at);
    next.projects[key].baselineMedia = {};
    entries.forEach(function (entry) {
      if (!entry || !entry.mediaPath) return;
      next.projects[key].baselineMedia[Core.normalizePathForComparison(entry.mediaPath)] = {
        path: String(entry.mediaPath),
        sourceFingerprint: clone(entry.sourceFingerprint || {}),
      };
    });
    return touch(next, at);
  }

  function projectBaselineMatches(state, projectPath, nativePath, sourceFingerprint) {
    return projectBaselineStatus(state, projectPath, nativePath, sourceFingerprint) === "match";
  }

  function projectBaselineStatus(state, projectPath, nativePath, sourceFingerprint) {
    var project = state && state.projects ? state.projects[projectKey(projectPath)] : null;
    if (!project || project.baselineVersion !== 1 || !project.baselineMedia) return "none";
    var baseline = project.baselineMedia[Core.normalizePathForComparison(nativePath)];
    if (!baseline) return "none";
    var expected = baseline.sourceFingerprint || {};
    if (!hasPortableFingerprint(expected)) return hasPortableFingerprint(sourceFingerprint) ? "unverified" : "unavailable";
    if (!hasPortableFingerprint(sourceFingerprint)) return "unavailable";
    if (Number(expected.size) !== Number(sourceFingerprint.size)) return "changed";
    if (Number(expected.mtimeMs) && Number(sourceFingerprint.mtimeMs) && Number(expected.mtimeMs) !== Number(sourceFingerprint.mtimeMs)) return "changed";
    if (Number(expected.ctimeMs) && Number(sourceFingerprint.ctimeMs) && Number(expected.ctimeMs) !== Number(sourceFingerprint.ctimeMs)) return "changed";
    if (Number(expected.birthtimeMs) && Number(sourceFingerprint.birthtimeMs) && Number(expected.birthtimeMs) !== Number(sourceFingerprint.birthtimeMs)) return "changed";
    if (Number(expected.dev) && Number(sourceFingerprint.dev) && Number(expected.dev) !== Number(sourceFingerprint.dev)) return "changed";
    if (Number(expected.ino) && Number(sourceFingerprint.ino) && Number(expected.ino) !== Number(sourceFingerprint.ino)) return "changed";
    return "match";
  }

  function setProjectBaselineEntry(state, projectPath, nativePath, sourceFingerprint, at) {
    var next = clone(state);
    var key = projectKey(projectPath);
    if (!next.projects[key] || next.projects[key].baselineVersion !== 1) return next;
    next.projects[key].baselineMedia = objectOrEmpty(next.projects[key].baselineMedia);
    next.projects[key].baselineMedia[Core.normalizePathForComparison(nativePath)] = {
      path: String(nativePath),
      sourceFingerprint: clone(sourceFingerprint || {}),
    };
    return touch(next, at);
  }

  function removeProjectBaselineEntry(state, projectPath, nativePath, at) {
    var next = clone(state);
    var key = projectKey(projectPath);
    if (!next.projects[key] || next.projects[key].baselineVersion !== 1) return next;
    next.projects[key].baselineMedia = objectOrEmpty(next.projects[key].baselineMedia);
    delete next.projects[key].baselineMedia[Core.normalizePathForComparison(nativePath)];
    return touch(next, at);
  }

  function mappingMovedAfterProjectBaseline(state, projectPath, mappings) {
    var project = state && state.projects ? state.projects[projectKey(projectPath)] : null;
    var baselineAt = Date.parse(project && project.baselineAt || "");
    if (!Number.isFinite(baselineAt)) return false;
    return (Array.isArray(mappings) ? mappings : []).some(function (mapping) {
      var movedAt = Date.parse(mapping && mapping.movedAt || "");
      return Number.isFinite(movedAt) && movedAt > baselineAt;
    });
  }

  function markKnown(state, nativePath, status, at, extra) {
    var next = clone(state);
    var key = Core.normalizePathForComparison(nativePath);
    next.knownMedia[key] = Object.assign({
      path: String(nativePath),
      status: String(status || "seen"),
      lastSeenAt: iso(at),
    }, extra || {});
    return touch(next, at);
  }

  function initializeBaseline(state, entries, classifications, at) {
    var next = clone(state);
    (entries || []).forEach(function (entry, index) {
      var pathKey = Core.normalizePathForComparison(entry.mediaPath);
      var classification = classifications[index] || { kind: "baseline" };
      next.knownMedia[pathKey] = {
        path: entry.mediaPath,
        status: classification.kind === "collect" ? "baseline" : classification.kind,
        lastSeenAt: iso(at),
        sourceFingerprint: entry.sourceFingerprint ? clone(entry.sourceFingerprint) : {},
      };
    });
    next.initialized = true;
    return touch(next, at);
  }

  function beginTransaction(state, transaction, at) {
    var next = clone(state);
    if (next.pendingProjectSave) throw new Error("Premiere 工程仍有补链尚未确认保存");
    next.pendingTransaction = Object.assign({}, clone(transaction), {
      status: "running",
      startedAt: iso(at),
    });
    return touch(next, at);
  }

  function commitTransaction(state, result, at) {
    if (result && result.cleanupPending === true) {
      return markCleanupPending(state, result.cleanupWarning || "原位置文件尚未删除", at);
    }
    var next = clone(state);
    var pending = next.pendingTransaction || {};
    var transactionId = String(result.id || pending.id || "");
    var previousTransaction = transactionId
      ? next.transactions.find(function (transaction) { return transaction.id === transactionId; })
      : null;
    if (previousTransaction) {
      var repeatedSourcePath = String(result.sourcePath || pending.sourcePath || "");
      var repeatedTargetPath = String(result.targetRelativePath || pending.targetRelativePath || "");
      var repeatedBatchIndex = Math.max(1, Math.floor(Number(result.batchIndex || pending.batchIndex) || next.currentBatchIndex));
      var repeatedProjectPath = String(result.projectPath || pending.projectPath || "");
      var repeatedProjectIdentity = String(result.projectIdentity || pending.projectIdentity || "");
      var sameProject = (!previousTransaction.projectPath || !repeatedProjectPath || Core.samePath(previousTransaction.projectPath, repeatedProjectPath))
        && (!previousTransaction.projectIdentity || !repeatedProjectIdentity || previousTransaction.projectIdentity === repeatedProjectIdentity);
      var sameTransaction = Core.samePath(previousTransaction.sourcePath, repeatedSourcePath)
        && Core.sameRelativePath(previousTransaction.targetRelativePath, repeatedTargetPath)
        && previousTransaction.batchIndex === repeatedBatchIndex
        && sameProject;
      if (sameTransaction) {
        next.pendingTransaction = null;
      } else if (next.pendingTransaction) {
        next.pendingTransaction.status = "conflict";
        next.pendingTransaction.error = "事务 ID 与已有记录冲突，未自动清除";
      }
      return touch(next, at);
    }
    var sourcePath = String(result.sourcePath || pending.sourcePath || "");
    var sourceKey = Core.normalizePathForComparison(sourcePath);
    var record = {
      id: transactionId,
      at: iso(at),
      status: "complete",
      sourcePath: sourcePath,
      targetRelativePath: String(result.targetRelativePath || pending.targetRelativePath || ""),
      targetPath: String(result.targetPath || pending.targetPath || ""),
      byteCount: Math.max(0, Number(result.byteCount || pending.byteCount) || 0),
      batchIndex: Math.max(1, Math.floor(Number(result.batchIndex || pending.batchIndex) || next.currentBatchIndex)),
      mode: String(result.mode || pending.mode || ""),
      modeEvidence: clone(result.modeEvidence || pending.modeEvidence || {}),
      projectPath: String(result.projectPath || pending.projectPath || ""),
      projectIdentity: String(result.projectIdentity || pending.projectIdentity || ""),
      sourceRetained: false,
      sourceChanged: result.sourceChanged === true,
      cleanupPending: false,
      targetFingerprint: clone(result.targetFingerprint || pending.targetFingerprint || {}),
    };
    next.transactions.push(record);
    next.transactions = next.transactions.slice(-TRANSACTION_LIMIT);
    var mapping = {
      sourcePath: sourcePath,
      targetRelativePath: record.targetRelativePath,
      byteCount: record.byteCount,
      batchIndex: record.batchIndex,
      movedAt: record.at,
      sourceFingerprint: clone(result.sourceFingerprint || pending.sourceFingerprint || {}),
      targetFingerprint: clone(result.targetFingerprint || pending.targetFingerprint || {}),
    };
    var existingMappings = Array.isArray(next.pathMappings[sourceKey])
      ? next.pathMappings[sourceKey]
      : next.pathMappings[sourceKey] ? [next.pathMappings[sourceKey]] : [];
    var fingerprintKey = [
      Number(mapping.sourceFingerprint.size) || 0,
      Number(mapping.sourceFingerprint.mtimeMs) || 0,
      Number(mapping.sourceFingerprint.ctimeMs) || 0,
      Number(mapping.sourceFingerprint.birthtimeMs) || 0,
      Number(mapping.sourceFingerprint.dev) || 0,
      Number(mapping.sourceFingerprint.ino) || 0,
    ].join(":");
    var replaced = false;
    existingMappings = existingMappings.map(function (existing) {
      var existingFingerprint = existing.sourceFingerprint || {};
      var existingKey = [
        Number(existingFingerprint.size) || 0,
        Number(existingFingerprint.mtimeMs) || 0,
        Number(existingFingerprint.ctimeMs) || 0,
        Number(existingFingerprint.birthtimeMs) || 0,
        Number(existingFingerprint.dev) || 0,
        Number(existingFingerprint.ino) || 0,
      ].join(":");
      if (existingKey === fingerprintKey) {
        replaced = true;
        return mapping;
      }
      return existing;
    });
    if (!replaced) existingMappings.push(mapping);
    next.pathMappings[sourceKey] = existingMappings;
    next.knownMedia[sourceKey] = {
      path: sourcePath,
      status: "moved",
      targetRelativePath: record.targetRelativePath,
      lastSeenAt: record.at,
    };
    var batch = next.batches.find(function (candidate) { return candidate.index === record.batchIndex; });
    if (batch) {
      batch.fileCount += 1;
      batch.byteCount += record.byteCount;
    }
    next.pendingTransaction = null;
    return touch(next, at);
  }

  function failTransaction(state, message, at) {
    var next = clone(state);
    if (next.pendingTransaction) {
      next.pendingTransaction.status = "failed";
      next.pendingTransaction.failedAt = iso(at);
      next.pendingTransaction.error = String(message || "未知错误");
    }
    return touch(next, at);
  }

  function markCleanupPending(state, message, at) {
    var next = clone(state);
    if (next.pendingTransaction) {
      next.pendingTransaction.status = "cleanup-pending";
      next.pendingTransaction.failedAt = iso(at);
      next.pendingTransaction.error = String(message || "原位置文件尚未删除");
    }
    return touch(next, at);
  }

  function clearPendingTransaction(state, at) {
    var next = clone(state);
    next.pendingTransaction = null;
    return touch(next, at);
  }

  function beginProjectSave(state, details, at) {
    var next = clone(state);
    if (next.pendingTransaction) throw new Error("仍有文件移动事务尚未完成");
    next.pendingProjectSave = Object.assign({}, clone(details || {}), {
      status: "pending",
      startedAt: iso(at),
    });
    return touch(next, at);
  }

  function failProjectSave(state, message, at) {
    var next = clone(state);
    if (next.pendingProjectSave) {
      next.pendingProjectSave.status = "failed";
      next.pendingProjectSave.failedAt = iso(at);
      next.pendingProjectSave.error = String(message || "Premiere 工程保存失败");
    }
    return touch(next, at);
  }

  function clearPendingProjectSave(state, at) {
    var next = clone(state);
    next.pendingProjectSave = null;
    return touch(next, at);
  }

  function lockAndCreateNextBatch(state, at) {
    var next = clone(state);
    var active = currentBatch(next);
    active.status = "locked";
    active.lockedAt = iso(at);
    var nextIndex = Math.max.apply(null, next.batches.map(function (batch) { return batch.index; })) + 1;
    next.batches.push({
      index: nextIndex,
      name: Core.batchName(nextIndex, at),
      status: "open",
      createdAt: iso(at),
      lockedAt: "",
      fileCount: 0,
      byteCount: 0,
    });
    next.currentBatchIndex = nextIndex;
    return touch(next, at);
  }

  function addProtectedLibrary(state, libraryId, label, at) {
    var next = clone(state);
    var exists = next.protectedLibraries.some(function (library) { return library.libraryId === libraryId; });
    if (!exists) next.protectedLibraries.push({ libraryId: String(libraryId), label: String(label || "共享素材库") });
    return touch(next, at);
  }

  function removeProtectedLibrary(state, libraryId, at) {
    var next = clone(state);
    next.protectedLibraries = next.protectedLibraries.filter(function (library) { return library.libraryId !== libraryId; });
    return touch(next, at);
  }

  function updateMappingTargetFingerprint(state, sourcePath, targetRelativePath, targetFingerprint, at) {
    var next = clone(state);
    var sourceKey = Core.normalizePathForComparison(sourcePath);
    var expectedTarget = String(targetRelativePath || "");
    var mappings = Array.isArray(next.pathMappings[sourceKey])
      ? next.pathMappings[sourceKey]
      : next.pathMappings[sourceKey] ? [next.pathMappings[sourceKey]] : [];
    mappings.forEach(function (mapping) {
      if (Core.sameRelativePath(mapping.targetRelativePath, expectedTarget)) {
        mapping.targetFingerprint = clone(targetFingerprint || {});
      }
    });
    if (mappings.length) next.pathMappings[sourceKey] = mappings;
    return touch(next, at);
  }

  return {
    HISTORY_LIMIT: HISTORY_LIMIT,
    SCHEMA_VERSION: SCHEMA_VERSION,
    addActivity: addActivity,
    addProtectedLibrary: addProtectedLibrary,
    beginProjectSave: beginProjectSave,
    beginTransaction: beginTransaction,
    commitTransaction: commitTransaction,
    createState: createState,
    currentBatch: currentBatch,
    currentBatchPath: currentBatchPath,
    failTransaction: failTransaction,
    hydrateState: hydrateState,
    initializeBaseline: initializeBaseline,
    lockAndCreateNextBatch: lockAndCreateNextBatch,
    markCleanupPending: markCleanupPending,
    markKnown: markKnown,
    markProjectBaseline: markProjectBaseline,
    mappingMovedAfterProjectBaseline: mappingMovedAfterProjectBaseline,
    projectHasBaseline: projectHasBaseline,
    projectBaselineMatches: projectBaselineMatches,
    projectBaselineStatus: projectBaselineStatus,
    projectKey: projectKey,
    registerProject: registerProject,
    removeProjectBaselineEntry: removeProjectBaselineEntry,
    removeProtectedLibrary: removeProtectedLibrary,
    setProjectBaselineEntry: setProjectBaselineEntry,
    updateMappingTargetFingerprint: updateMappingTargetFingerprint,
    clearPendingTransaction: clearPendingTransaction,
    clearPendingProjectSave: clearPendingProjectSave,
    failProjectSave: failProjectSave,
    isCompatibleState: isCompatibleState,
    validateStoredState: validateStoredState,
  };
});
