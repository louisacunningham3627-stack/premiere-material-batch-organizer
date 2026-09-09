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

  var SCHEMA_VERSION = 2;
  var COLLECTION_POLICY_VERSION = 3;
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
      collectionPolicyVersion: COLLECTION_POLICY_VERSION,
      protectedConfigRevision: 1,
      currentBatchIndex: 1,
      batches: [initialBatch(now)],
      protectedLibraries: [],
      projects: {},
      knownMedia: {},
      pathMappings: {},
      pendingTransaction: null,
      deferredTransactions: [],
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

  function collectionPolicyStatus(raw) {
    if (!isRecord(raw) || !Object.prototype.hasOwnProperty.call(raw, "collectionPolicyVersion")) return "legacy";
    var version = Number(raw.collectionPolicyVersion);
    if (!Number.isFinite(version) || version > COLLECTION_POLICY_VERSION) return "future";
    if (version < 1 || Math.floor(version) !== version) return "invalid";
    return "supported";
  }

  function unsupportedCollectionPolicyError() {
    var error = new Error("素材空间由更新版本的整理规则创建，当前插件不会降级或覆盖它");
    error.code = "MATERIAL_BATCH_STATE_POLICY_UNSUPPORTED";
    error.preventBackupFallback = true;
    return error;
  }

  function hasPortableFingerprint(value) {
    if (!isRecord(value)) return false;
    var size = Number(value.size);
    var mtimeMs = Number(value.mtimeMs);
    return Number.isFinite(size) && size >= 0 && Number.isFinite(mtimeMs) && mtimeMs > 0;
  }

  function isCompatibleState(raw) {
    if (!isRecord(raw) || (raw.schemaVersion !== SCHEMA_VERSION && raw.schemaVersion !== 1)) return false;
    if (raw.deferredTransactions != null && (!Array.isArray(raw.deferredTransactions)
      || raw.deferredTransactions.some(function (entry) { return !isRecord(entry) || !entry.id || !Core.isAbsoluteLocalPath(entry.sourcePath) || !Core.isSafeRelativePath(entry.targetRelativePath); }))) return false;
    var pendingItems = (raw.deferredTransactions || []).concat(raw.pendingTransaction ? [raw.pendingTransaction] : []);
    var pendingIds = pendingItems.map(function (item) { return item.id; }).filter(Boolean);
    if (new Set(pendingIds).size !== pendingIds.length) return false;
    if (pendingItems.some(function (item) { return item.backgroundTask != null && !validBackgroundTask(item.backgroundTask); })) return false;
    var policyStatus = collectionPolicyStatus(raw);
    if (policyStatus === "future" || policyStatus === "invalid") return false;
    if (typeof raw.mediaSpaceId !== "string" || !raw.mediaSpaceId) return false;
    if (typeof raw.mediaFolderName !== "string") return false;
    if (!Array.isArray(raw.batches) || !raw.batches.length) return false;
    if (!isRecord(raw.projects) || !isRecord(raw.knownMedia) || !isRecord(raw.pathMappings)) return false;
    if (!Array.isArray(raw.protectedLibraries) || !Array.isArray(raw.transactions) || !Array.isArray(raw.activity)) return false;
    if (Object.prototype.hasOwnProperty.call(raw, "protectedConfigRevision")) {
      var protectedRevision = Number(raw.protectedConfigRevision);
      if (!Number.isFinite(protectedRevision) || protectedRevision < 1 || Math.floor(protectedRevision) !== protectedRevision) return false;
    }
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
      && raw.schemaVersion !== SCHEMA_VERSION && raw.schemaVersion !== 1) {
      var error = new Error("素材空间状态由其他版本的插件创建，当前版本不会覆盖它");
      error.code = "MATERIAL_BATCH_STATE_SCHEMA_UNSUPPORTED";
      error.preventBackupFallback = true;
      throw error;
    }
    if (collectionPolicyStatus(raw) === "future") throw unsupportedCollectionPolicyError();
    return isCompatibleState(raw);
  }

  function hydrateState(raw, workspaceRoot, now) {
    if (collectionPolicyStatus(raw) === "future") throw unsupportedCollectionPolicyError();
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
    state.deferredTransactions = clone(raw.deferredTransactions || []);
    if (typeof raw.nextBatchRequestedAt === "string" && Number.isFinite(Date.parse(raw.nextBatchRequestedAt))) {
      state.nextBatchRequestedAt = raw.nextBatchRequestedAt;
    }
    state.collectionPolicyVersion = Math.max(1, Math.floor(Number(raw.collectionPolicyVersion)
      || (state.initialized ? 1 : COLLECTION_POLICY_VERSION)));
    state.protectedConfigRevision = Math.max(1, Math.floor(Number(raw.protectedConfigRevision) || 1));
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
    var storedProjects = objectOrEmpty(raw.projects);
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
    state.projects = Object.keys(storedProjects).reduce(function (projects, storedProjectKey) {
      var normalizedProjectKey = Core.normalizePathForComparison(storedProjectKey);
      if (!normalizedProjectKey) {
        var emptyProjectKeyError = new Error("素材空间状态包含无效的工程路径，已停止自动整理");
        emptyProjectKeyError.code = "MATERIAL_BATCH_STATE_INVALID";
        throw emptyProjectKeyError;
      }
      var project = storedProjects[storedProjectKey];
      if (project && project.baselineMedia && typeof project.baselineMedia === "object") {
        var migratedBaseline = {};
        Object.keys(project.baselineMedia).forEach(function (sourceKey) {
          var entry = project.baselineMedia[sourceKey];
          var normalizedSourceKey = canonicalKey(sourceKey, entry);
          if (Object.prototype.hasOwnProperty.call(migratedBaseline, normalizedSourceKey)) {
            if (JSON.stringify(migratedBaseline[normalizedSourceKey]) !== JSON.stringify(entry)) {
              var duplicateBaselineKeyError = new Error("素材空间状态包含冲突的工程基线记录，已停止自动整理");
              duplicateBaselineKeyError.code = "MATERIAL_BATCH_STATE_INVALID";
              throw duplicateBaselineKeyError;
            }
            return;
          }
          migratedBaseline[normalizedSourceKey] = entry;
        });
        project.baselineMedia = migratedBaseline;
      }
      if (Object.prototype.hasOwnProperty.call(projects, normalizedProjectKey)) {
        if (JSON.stringify(projects[normalizedProjectKey]) !== JSON.stringify(project)) {
          var duplicateProjectKeyError = new Error("素材空间状态包含冲突的工程记录，已停止自动整理");
          duplicateProjectKeyError.code = "MATERIAL_BATCH_STATE_INVALID";
          throw duplicateProjectKeyError;
        }
        return projects;
      }
      projects[normalizedProjectKey] = project;
      return projects;
    }, {});
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

  function initializeCollection(state, entries, classifications, at) {
    var next = clone(state);
    (entries || []).forEach(function (entry, index) {
      var pathKey = Core.normalizePathForComparison(entry.mediaPath);
      var classification = classifications[index] || { kind: "collect" };
      next.knownMedia[pathKey] = {
        path: entry.mediaPath,
        status: classification.kind,
        lastSeenAt: iso(at),
        sourceFingerprint: entry.sourceFingerprint ? clone(entry.sourceFingerprint) : {},
      };
    });
    next.initialized = true;
    next.collectionPolicyVersion = COLLECTION_POLICY_VERSION;
    return touch(next, at);
  }

  function initializeBaseline(state, entries, classifications, at) {
    return initializeCollection(state, entries, classifications, at);
  }

  function needsCollectionPolicyAcceptance(state) {
    return Boolean(state
      && state.initialized === true
      && Math.max(1, Math.floor(Number(state.collectionPolicyVersion) || 1)) < COLLECTION_POLICY_VERSION);
  }

  function acceptCollectionPolicy(state, at) {
    if (collectionPolicyStatus(state) === "future") throw unsupportedCollectionPolicyError();
    var next = clone(state);
    next.collectionPolicyVersion = COLLECTION_POLICY_VERSION;
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

  function updatePendingTransaction(state, details, at) {
    var next = clone(state);
    if (!next.pendingTransaction) throw new Error("没有可以更新的文件移动事务");
    var currentId = String(next.pendingTransaction.id || "");
    var nextId = String(details && details.id || currentId);
    if (currentId && nextId && currentId !== nextId) throw new Error("事务 ID 与待处理记录不一致");
    next.pendingTransaction = Object.assign({}, next.pendingTransaction, clone(details || {}), {
      id: currentId || nextId,
      updatedAt: iso(at),
    });
    return touch(next, at);
  }

  function stableJsonValue(value) {
    if (Array.isArray(value)) return value.map(stableJsonValue);
    if (!isRecord(value)) return value;
    return Object.keys(value).sort().reduce(function (result, key) {
      result[key] = stableJsonValue(value[key]);
      return result;
    }, {});
  }

  function sameJsonValue(left, right) {
    return JSON.stringify(stableJsonValue(left)) === JSON.stringify(stableJsonValue(right));
  }

  var TRANSACTION_IDENTITY_FIELDS = [
    "sourcePath",
    "targetPath",
    "cleanupPath",
    "targetRelativePath",
    "sourceFingerprint",
    "targetFingerprint",
    "byteCount",
    "batchIndex",
    "mode",
    "modeEvidence",
    "targetMethod",
    "projectPath",
    "projectIdentity",
    "deleteSource",
    "itemCount",
    "itemIds",
    "itemSignatures",
  ];

  function hasOwn(object, key) {
    return Boolean(object && Object.prototype.hasOwnProperty.call(object, key));
  }

  function decimalIdentity(value) {
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || value <= 0) return null;
      return String(value);
    }
    if (typeof value !== "string") return null;
    var normalized = value.trim();
    if (!/^\d+$/.test(normalized)) return null;
    normalized = normalized.replace(/^0+(?=\d)/, "");
    return normalized === "0" ? null : normalized;
  }

  function sameIdentityNumber(left, right) {
    var leftValue = decimalIdentity(left);
    var rightValue = decimalIdentity(right);
    return leftValue !== null && rightValue !== null && leftValue === rightValue;
  }

  function hasUnsafeFingerprintIdentity(value) {
    if (!isRecord(value)) return false;
    return ["dev", "ino"].some(function (field) {
      return hasOwn(value, field) && decimalIdentity(value[field]) === null;
    });
  }

  function sameFingerprintValue(left, right, allowHardLinkCtimeChange) {
    if (!isRecord(left) || !isRecord(right)) return sameJsonValue(left || {}, right || {});
    var keys = Object.keys(left).concat(Object.keys(right)).filter(function (key, index, all) {
      return all.indexOf(key) === index;
    });
    return keys.every(function (key) {
      if (allowHardLinkCtimeChange && key === "ctimeMs") return true;
      var leftHas = hasOwn(left, key);
      var rightHas = hasOwn(right, key);
      if (leftHas !== rightHas) return false;
      if (!leftHas) return true;
      if (key === "dev" || key === "ino") return sameIdentityNumber(left[key], right[key]);
      return sameJsonValue(left[key], right[key]);
    });
  }

  function sameTransactionIdentityField(field, left, right, allowHardLinkCtimeChange) {
    if (field === "sourcePath" || field === "targetPath" || field === "cleanupPath" || field === "projectPath") {
      return Core.samePath(String(left || ""), String(right || ""));
    }
    if (field === "targetRelativePath") return Core.sameRelativePath(String(left || ""), String(right || ""));
    if (field === "sourceFingerprint" || field === "targetFingerprint") {
      return sameFingerprintValue(left || {}, right || {}, allowHardLinkCtimeChange);
    }
    if (field === "modeEvidence" || field === "itemIds" || field === "itemSignatures") {
      return sameJsonValue(left, right);
    }
    if (field === "byteCount" || field === "batchIndex" || field === "itemCount") {
      return Number(left) === Number(right) && Number.isFinite(Number(left));
    }
    if (field === "deleteSource") return left === right;
    return String(left || "") === String(right || "");
  }

  function transactionIdentityConflicts(pending, result) {
    var conflicts = [];
    function addConflict(field) {
      if (conflicts.indexOf(field) < 0) conflicts.push(field);
    }
    ["sourceFingerprint", "targetFingerprint"].forEach(function (field) {
      if ((hasOwn(pending, field) && hasUnsafeFingerprintIdentity(pending[field]))
        || (hasOwn(result, field) && hasUnsafeFingerprintIdentity(result[field]))) addConflict(field);
    });
    TRANSACTION_IDENTITY_FIELDS.forEach(function (field) {
      // 结果省略字段时，继续使用 pending 中已经持久化的身份。
      if (!hasOwn(result, field) || result[field] === undefined || !hasOwn(pending, field)) return;
      var allowHardLinkCtimeChange = field === "targetFingerprint"
        && String(result.targetMethod !== undefined ? result.targetMethod : pending.targetMethod || "") === "link";
      if (!sameTransactionIdentityField(field, pending[field], result[field], allowHardLinkCtimeChange)) {
        addConflict(field);
      }
    });
    return conflicts;
  }

  function mergeTransactionField(result, pending, field) {
    return hasOwn(result, field) && result[field] !== undefined ? result[field] : pending[field];
  }

  function fingerprintKeyValue(fingerprint, field) {
    if (!hasOwn(fingerprint, field)) return "<missing>";
    if (field === "dev" || field === "ino") {
      var identity = decimalIdentity(fingerprint[field]);
      return identity === null
        ? "<invalid:" + typeof fingerprint[field] + ":" + String(fingerprint[field]) + ">"
        : identity;
    }
    var value = stableJsonValue(fingerprint[field]);
    return JSON.stringify(value === undefined ? String(fingerprint[field]) : value);
  }

  function sourceFingerprintKey(fingerprint) {
    fingerprint = isRecord(fingerprint) ? fingerprint : {};
    return ["size", "mtimeMs", "ctimeMs", "birthtimeMs", "dev", "ino"]
      .map(function (field) { return field + "=" + fingerprintKeyValue(fingerprint, field); })
      .join(":");
  }

  function completedTransactionRecord(pending, result, currentBatchIndex, at) {
    pending = pending || {};
    result = result || {};
    var itemIds = Array.isArray(mergeTransactionField(result, pending, "itemIds"))
      ? mergeTransactionField(result, pending, "itemIds")
      : [];
    var itemSignatures = Array.isArray(mergeTransactionField(result, pending, "itemSignatures"))
      ? mergeTransactionField(result, pending, "itemSignatures")
      : [];
    return {
      identityVersion: 1,
      id: String(result.id || pending.id || "").trim(),
      at: iso(at),
      status: "complete",
      sourcePath: String(mergeTransactionField(result, pending, "sourcePath") || ""),
      targetRelativePath: String(mergeTransactionField(result, pending, "targetRelativePath") || ""),
      targetPath: String(mergeTransactionField(result, pending, "targetPath") || ""),
      cleanupPath: String(mergeTransactionField(result, pending, "cleanupPath") || ""),
      sourceFingerprint: clone(mergeTransactionField(result, pending, "sourceFingerprint") || {}),
      targetFingerprint: clone(mergeTransactionField(result, pending, "targetFingerprint") || {}),
      byteCount: Math.max(0, Number(mergeTransactionField(result, pending, "byteCount")) || 0),
      batchIndex: Math.max(1, Math.floor(Number(mergeTransactionField(result, pending, "batchIndex")) || currentBatchIndex)),
      mode: String(mergeTransactionField(result, pending, "mode") || ""),
      targetMethod: String(mergeTransactionField(result, pending, "targetMethod") || ""),
      modeEvidence: clone(mergeTransactionField(result, pending, "modeEvidence") || {}),
      recycleReceipt: clone(mergeTransactionField(result, pending, "recycleReceipt") || {}),
      legacyVerification: clone(mergeTransactionField(result, pending, "legacyVerification") || {}),
      projectPath: String(mergeTransactionField(result, pending, "projectPath") || ""),
      projectIdentity: String(mergeTransactionField(result, pending, "projectIdentity") || ""),
      deleteSource: hasOwn(result, "deleteSource") && result.deleteSource !== undefined
        ? result.deleteSource === true
        : pending.deleteSource !== false,
      itemCount: Math.max(0, Math.floor(Number(mergeTransactionField(result, pending, "itemCount")) || itemIds.length)),
      itemIds: itemIds.map(function (itemId) { return String(itemId || ""); }),
      itemSignatures: clone(itemSignatures),
      sourceRetained: false,
      sourceChanged: result.sourceChanged === true,
      cleanupPending: false,
    };
  }

  function sameCompletedTransaction(left, right) {
    if (!left || !right || left.identityVersion !== 1 || right.identityVersion !== 1) return false;
    return String(left.id || "") === String(right.id || "")
      && Core.samePath(String(left.sourcePath || ""), String(right.sourcePath || ""))
      && Core.sameRelativePath(String(left.targetRelativePath || ""), String(right.targetRelativePath || ""))
      && Core.samePath(String(left.targetPath || ""), String(right.targetPath || ""))
      && Core.samePath(String(left.cleanupPath || ""), String(right.cleanupPath || ""))
      && Number(left.byteCount) === Number(right.byteCount)
      && Number(left.batchIndex) === Number(right.batchIndex)
      && String(left.mode || "") === String(right.mode || "")
      && String(left.targetMethod || "") === String(right.targetMethod || "")
      && String(left.projectIdentity || "") === String(right.projectIdentity || "")
      && ((!left.projectPath && !right.projectPath)
        || (left.projectPath && right.projectPath && Core.samePath(left.projectPath, right.projectPath)))
      && left.deleteSource === right.deleteSource
      && Number(left.itemCount) === Number(right.itemCount)
      && sameFingerprintValue(left.sourceFingerprint || {}, right.sourceFingerprint || {}, false)
      && sameFingerprintValue(left.targetFingerprint || {}, right.targetFingerprint || {}, String(left.targetMethod || "") === "link")
      && sameJsonValue(left.modeEvidence || {}, right.modeEvidence || {})
      && sameJsonValue(left.itemIds || [], right.itemIds || [])
      && sameJsonValue(left.itemSignatures || [], right.itemSignatures || []);
  }

  function commitTransaction(state, result, at) {
    var activePendingId = String(state && state.pendingTransaction && state.pendingTransaction.id || "").trim();
    var suppliedResultId = String(result && result.id || "").trim();
    if (!suppliedResultId) throw new Error("提交结果缺少事务 ID");
    if (state && state.pendingTransaction && !activePendingId) {
      throw new Error("待处理记录缺少事务 ID");
    }
    if (activePendingId && activePendingId !== suppliedResultId) {
      throw new Error("事务 ID 与待处理记录不一致");
    }
    if (!state || !state.pendingTransaction) {
      var committed = state && Array.isArray(state.transactions)
        ? state.transactions.find(function (transaction) { return transaction.id === suppliedResultId; })
        : null;
      var exactRepeat = committed && sameCompletedTransaction(
        committed,
        completedTransactionRecord({}, result, state.currentBatchIndex, at)
      );
      if (!exactRepeat) throw new Error("没有与提交结果匹配的待处理事务");
      return clone(state);
    }
    var identityConflicts = transactionIdentityConflicts(state.pendingTransaction, result || {});
    if (identityConflicts.length) {
      var conflictState = clone(state);
      conflictState.pendingTransaction.status = "conflict";
      conflictState.pendingTransaction.error = "事务 ID 与待处理记录的不可变身份冲突（字段："
        + identityConflicts.join("、") + "），未写入事务记录";
      return touch(conflictState, at);
    }
    if (result && result.cleanupPending === true) {
      return markCleanupPending(state, result.cleanupWarning || "原位置文件尚未删除", at);
    }
    var next = clone(state);
    var pending = next.pendingTransaction;
    var transactionId = suppliedResultId;
    var previousTransaction = transactionId
      ? next.transactions.find(function (transaction) { return transaction.id === transactionId; })
      : null;
    if (previousTransaction) {
      var repeatedRecord = completedTransactionRecord(pending, result, next.currentBatchIndex, at);
      var sameTransaction = sameCompletedTransaction(previousTransaction, repeatedRecord);
      if (sameTransaction) {
        next.pendingTransaction = null;
      } else if (next.pendingTransaction) {
        next.pendingTransaction.status = "conflict";
        next.pendingTransaction.error = "事务 ID 与已有记录冲突，未自动清除";
      }
      return touch(next, at);
    }
    var record = completedTransactionRecord(pending, result, next.currentBatchIndex, at);
    var sourcePath = record.sourcePath;
    var sourceKey = Core.normalizePathForComparison(sourcePath);
    next.transactions.push(record);
    next.transactions = next.transactions.slice(-TRANSACTION_LIMIT);
    var mapping = {
      sourcePath: sourcePath,
      targetRelativePath: record.targetRelativePath,
      byteCount: record.byteCount,
      batchIndex: record.batchIndex,
      movedAt: record.at,
      sourceFingerprint: clone(record.sourceFingerprint || {}),
      targetFingerprint: clone(record.targetFingerprint || {}),
    };
    var existingMappings = Array.isArray(next.pathMappings[sourceKey])
      ? next.pathMappings[sourceKey]
      : next.pathMappings[sourceKey] ? [next.pathMappings[sourceKey]] : [];
    var fingerprintKey = sourceFingerprintKey(mapping.sourceFingerprint);
    var replaced = false;
    existingMappings = existingMappings.map(function (existing) {
      var existingFingerprint = existing.sourceFingerprint || {};
      var existingKey = sourceFingerprintKey(existingFingerprint);
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

  function updatePendingProjectSave(state, details, at) {
    var next = clone(state);
    if (!next.pendingProjectSave) throw new Error("没有可以更新的 Premiere 工程保存记录");
    var currentId = String(next.pendingProjectSave.id || "");
    var nextId = String(details && details.id || currentId);
    if (currentId && nextId && currentId !== nextId) throw new Error("保存记录 ID 与待处理记录不一致");
    next.pendingProjectSave = Object.assign({}, next.pendingProjectSave, clone(details || {}), {
      id: currentId || nextId,
      updatedAt: iso(at),
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
      name: Core.batchName(nextIndex, at, next.batches.map(function (batch) { return batch.name; })),
      status: "open",
      createdAt: iso(at),
      lockedAt: "",
      fileCount: 0,
      byteCount: 0,
    });
    next.currentBatchIndex = nextIndex;
    return touch(next, at);
  }

  function requestNextBatch(state, at) {
    if (state.pendingTransaction || state.pendingProjectSave) throw new Error("当前操作尚未完成，不能开始新一批");
    var next = clone(state);
    next.nextBatchRequestedAt = iso(at);
    return touch(next, at);
  }

  function validBackgroundTask(value) {
    return isRecord(value) && value.version === 1 && ["cleanup", "held"].indexOf(value.kind) >= 0
      && Number.isSafeInteger(value.attempts) && value.attempts >= 1
      && typeof value.nextAttemptAt === "string" && Number.isFinite(Date.parse(value.nextAttemptAt))
      && typeof value.message === "string";
  }

  function deferTransaction(state, at, backgroundTask) {
    if (!state.pendingTransaction || state.pendingProjectSave) throw new Error("当前没有可暂缓的单项事务");
    if (state.pendingTransaction.recycleRequest && !state.pendingTransaction.recycleReceipt) throw new Error("回收结果尚不明确，请先核对，不能暂缓正在提交的回收");
    var next = clone(state);
    next.deferredTransactions = next.deferredTransactions || [];
    if (next.deferredTransactions.some(function (item) { return item.id === next.pendingTransaction.id; })) throw new Error("暂缓记录已存在");
    if (backgroundTask != null && !validBackgroundTask(backgroundTask)) throw new Error("后台等待记录无效");
    var deferred = Object.assign({}, next.pendingTransaction, { deferredAt: iso(at) });
    if (backgroundTask) deferred.backgroundTask = clone(backgroundTask);
    next.deferredTransactions.push(deferred);
    next.pendingTransaction = null;
    return touch(next, at);
  }

  function resumeDeferred(state, transactionId, at) {
    if (state.pendingTransaction || state.pendingProjectSave) throw new Error("请先处理当前未完成操作");
    var next = clone(state);
    var record = (next.deferredTransactions || []).find(function (item) { return item.id === transactionId; });
    if (!record) throw new Error("暂缓记录不存在");
    next.pendingTransaction = record;
    next.deferredTransactions = next.deferredTransactions.filter(function (item) { return item.id !== transactionId; });
    return touch(next, at);
  }

  function nextBackgroundCleanup(state, projectPath, projectIdentity, at) {
    if (state.pendingTransaction || state.pendingProjectSave) return null;
    var now = new Date(at).getTime();
    return (state.deferredTransactions || []).filter(function (item) {
      return validBackgroundTask(item.backgroundTask) && item.backgroundTask.kind === "cleanup"
        && Core.samePath(item.projectPath, projectPath) && item.projectIdentity === projectIdentity
        && Date.parse(item.backgroundTask.nextAttemptAt) <= now;
    }).sort(function (left, right) {
      return Date.parse(left.backgroundTask.nextAttemptAt) - Date.parse(right.backgroundTask.nextAttemptAt);
    })[0] || null;
  }

  function prepareCollectionBatch(state, at) {
    if (state.pendingTransaction || state.pendingProjectSave) throw new Error("当前操作尚未完成，不能切换素材文件夹");
    var active = currentBatch(state);
    var day = Core.localChineseDateStamp(at);
    var changedDay = Core.localChineseDateStamp(new Date(active.createdAt)) !== day;
    if (!changedDay && !state.nextBatchRequestedAt) return clone(state);
    var next = lockAndCreateNextBatch(state, at);
    if (state.nextBatchRequestedAt) {
      var date = at instanceof Date ? at : new Date(at);
      var name = day + " " + String(date.getHours()).padStart(2, "0") + "时"
        + String(date.getMinutes()).padStart(2, "0") + "分" + String(date.getSeconds()).padStart(2, "0") + "秒添加素材";
      var names = state.batches.map(function (batch) { return batch.name; });
      if (names.indexOf(name) >= 0) throw new Error("同一时刻已建立素材批次，请稍后再试");
      currentBatch(next).name = name;
    }
    delete next.nextBatchRequestedAt;
    return next;
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

  function bumpProtectedConfigRevision(state, at) {
    var next = clone(state);
    next.protectedConfigRevision = Math.max(1, Math.floor(Number(next.protectedConfigRevision) || 1)) + 1;
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
    COLLECTION_POLICY_VERSION: COLLECTION_POLICY_VERSION,
    SCHEMA_VERSION: SCHEMA_VERSION,
    acceptCollectionPolicy: acceptCollectionPolicy,
    addActivity: addActivity,
    addProtectedLibrary: addProtectedLibrary,
    beginProjectSave: beginProjectSave,
    beginTransaction: beginTransaction,
    bumpProtectedConfigRevision: bumpProtectedConfigRevision,
    commitTransaction: commitTransaction,
    createState: createState,
    currentBatch: currentBatch,
    currentBatchPath: currentBatchPath,
    failTransaction: failTransaction,
    hydrateState: hydrateState,
    initializeCollection: initializeCollection,
    initializeBaseline: initializeBaseline,
    lockAndCreateNextBatch: lockAndCreateNextBatch,
    requestNextBatch: requestNextBatch,
    deferTransaction: deferTransaction,
    nextBackgroundCleanup: nextBackgroundCleanup,
    resumeDeferred: resumeDeferred,
    prepareCollectionBatch: prepareCollectionBatch,
    markCleanupPending: markCleanupPending,
    markKnown: markKnown,
    markProjectBaseline: markProjectBaseline,
    mappingMovedAfterProjectBaseline: mappingMovedAfterProjectBaseline,
    needsCollectionPolicyAcceptance: needsCollectionPolicyAcceptance,
    projectHasBaseline: projectHasBaseline,
    projectBaselineMatches: projectBaselineMatches,
    projectBaselineStatus: projectBaselineStatus,
    projectKey: projectKey,
    registerProject: registerProject,
    removeProjectBaselineEntry: removeProjectBaselineEntry,
    removeProtectedLibrary: removeProtectedLibrary,
    setProjectBaselineEntry: setProjectBaselineEntry,
    updateMappingTargetFingerprint: updateMappingTargetFingerprint,
    updatePendingTransaction: updatePendingTransaction,
    updatePendingProjectSave: updatePendingProjectSave,
    clearPendingTransaction: clearPendingTransaction,
    clearPendingProjectSave: clearPendingProjectSave,
    failProjectSave: failProjectSave,
    isCompatibleState: isCompatibleState,
    validateStoredState: validateStoredState,
  };
});
