(function (root, factory) {
  "use strict";

  var api = factory(
    typeof module !== "undefined" && module.exports ? require("./core") : root.MaterialBatchCore,
    typeof module !== "undefined" && module.exports ? require("./transaction") : root.MaterialBatchTransaction
  );
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.MaterialBatchStorage = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (Core, Transaction) {
  "use strict";

  var STATE_FILE_NAME = ".premiere-material-space.json";
  var MISSING_REVISION = null;
  var LOCK_SCHEMA_VERSION = 1;
  var LOCK_RECORD_BYTES = 1024;
  var LOCK_STALE_MS = 30 * 60 * 1000;
  var LOCK_RECHECK_MS = 125;
  var LOCK_FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

  function statePath(workspaceRoot) {
    return Core.joinNativePath(workspaceRoot, STATE_FILE_NAME);
  }

  async function readText(fs, nativePath) {
    var value = await fs.readFile(nativePath, { encoding: "utf-8" });
    return typeof value === "string" ? value : String(value);
  }

  function readErrorField(error, field) {
    try {
      return error && error[field] != null ? String(error[field]) : "";
    } catch (readError) {
      return "";
    }
  }

  function isAlreadyExistsError(error) {
    var structured = ["code", "name", "errno"].map(function (field) {
      return readErrorField(error, field).trim().toUpperCase();
    });
    var normalized = structured.map(function (value) { return value.replace(/[\s_-]+/g, ""); });
    var knownOtherCodes = [
      "ENOENT", "EACCES", "EPERM", "EBUSY", "EIO", "EROFS", "ENOTDIR", "EISDIR", "EINVAL", "ENOSPC",
      "ETXTBSY", "ENOTEMPTY", "ELOOP", "ENAMETOOLONG", "EMFILE", "ENFILE", "EDQUOT", "EXDEV",
      "FILENOTFOUND", "PATHNOTFOUND", "NOTFOUNDERROR", "ACCESSDENIED", "PERMISSIONDENIED",
      "SHARINGVIOLATION", "LOCKVIOLATION",
    ];
    if (normalized.some(function (value) { return knownOtherCodes.indexOf(value) >= 0; })) return false;

    var knownExists = ["EEXIST", "FILEEXISTS", "FILEALREADYEXISTS", "ALREADYEXISTS", "FILEEXISTSERROR", "ALREADYEXISTSERROR"];
    if (normalized.some(function (value) { return knownExists.indexOf(value) >= 0; })) return true;

    var numericFields = [readErrorField(error, "code"), readErrorField(error, "errno")];
    if (typeof error === "number" || (typeof error === "string" && /^-?\d+$/.test(error.trim()))) {
      numericFields.push(String(error));
    }
    var knownOtherNumbers = [2, 3, 5, 13, -13, 16, -16, 28, -28, 30, -30, 32, 33, -4058, -4092];
    if (numericFields.some(function (value) {
      var number = Number(value);
      return Number.isFinite(number) && knownOtherNumbers.indexOf(number) >= 0;
    })) return false;
    var knownExistsNumbers = [17, -17, -4075, 80, 183];
    if (numericFields.some(function (value) {
      var number = Number(value);
      return Number.isFinite(number) && knownExistsNumbers.indexOf(number) >= 0;
    })) return true;

    var parts = structured.concat([readErrorField(error, "message")]);
    try { parts.push(error == null ? "" : String(error)); } catch (stringError) {}
    var description = parts.join("\n").toUpperCase();
    var knownOtherMessage = /ACCESS[_ -]*DENIED|PERMISSION[_ -]*DENIED|SHARING[_ -]*VIOLATION|LOCK[_ -]*VIOLATION|(?:I\/O|IO|INPUT[ /-]*OUTPUT)[ _-]*(?:ERROR|FAIL(?:ED|URE)?)|NO SPACE LEFT|READ-ONLY FILE SYSTEM/;
    if (knownOtherMessage.test(description)) return false;

    return description.split(/\r?\n/).some(function (line) {
      var value = line.trim();
      return /^(?:(?:ERROR|FILESYSTEM ?ERROR)\s*:\s*)?EEXIST(?:\s*:.*)?$/.test(value)
        || /^(?:(?:ERROR|FILESYSTEM ?ERROR)\s*:\s*)?(?:(?:A|THE)\s+)?(?:FILE|FOLDER|DIRECTORY|ENTRY)\s+(?:ALREADY\s+)?EXISTS(?:\s*[.!])?(?:\s*[,;:]\s*.*|\s+(?:AT|FOR)\s+.*)?$/.test(value)
        || /^(?:(?:ERROR|FILESYSTEM ?ERROR)\s*:\s*)?ALREADY\s+EXISTS(?:\s*[.!])?(?:\s*[,;:]\s*.*)?$/.test(value)
        || /^(?:错误\s*[:：]\s*)?(?:文件|文件夹|目录|路径)已(?:经)?存在(?:[。.!！]|$|\s*[,，:：]\s*.*)/.test(value);
    });
  }

  function hashText(text) {
    var hash = 2166136261;
    for (var index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash.toString(16).padStart(8, "0");
  }

  function statNumber(stat, field) {
    var value = stat && stat[field];
    if (value instanceof Date) value = value.getTime();
    value = Number(value);
    return Number.isFinite(value) ? value : 0;
  }

  function revisionFor(text, stat) {
    return [
      "r1",
      hashText(text),
      text.length,
      statNumber(stat, "size"),
      statNumber(stat, "mtimeMs") || statNumber(stat, "mtime"),
      statNumber(stat, "ctimeMs") || statNumber(stat, "ctime"),
      statNumber(stat, "birthtimeMs") || statNumber(stat, "birthtime"),
      statNumber(stat, "dev"),
      statNumber(stat, "ino"),
    ].join(":");
  }

  async function inspectFile(fs, nativePath) {
    var text;
    try {
      text = await readText(fs, nativePath);
    } catch (error) {
      if (Core.isMissingPathError(error)) return { exists: false, text: "", revision: MISSING_REVISION };
      throw error;
    }
    try {
      var stat = await fs.lstat(nativePath);
      return { exists: true, text: text, revision: revisionFor(text, stat) };
    } catch (error) {
      if (Core.isMissingPathError(error)) return { exists: false, text: "", revision: MISSING_REVISION };
      throw error;
    }
  }

  function storageError(code, message, details) {
    var error = new Error(message);
    error.code = code;
    if (details) Object.assign(error, details);
    return error;
  }

  async function closeFileHandle(fs, handle) {
    var result;
    if (handle && typeof handle.close === "function") {
      result = await handle.close();
    } else if (typeof fs.close === "function") {
      result = await fs.close(handle);
    } else {
      throw new Error("当前文件接口无法关闭状态写锁");
    }
    if (result !== undefined && result !== null && result !== 0) {
      throw new Error("关闭状态写锁时返回了意外结果: " + result);
    }
  }

  function uniquePath(nativePath, marker) {
    var random = Math.floor(Math.random() * 0x100000000).toString(16);
    return nativePath + marker + Date.now().toString(36) + "-" + random;
  }

  function successfulFsResult(value) {
    return value === undefined || value === null || value === 0;
  }

  function assertFsSuccess(value, action) {
    if (!successfulFsResult(value)) throw new Error(action + "时返回了意外结果: " + value);
  }

  function currentTime(options) {
    var value = options && typeof options.now === "function" ? options.now() : Date.now();
    value = value instanceof Date ? value.getTime() : Number(value);
    return Number.isFinite(value) ? value : Date.now();
  }

  function defaultLockOwner() {
    try {
      if (typeof process !== "undefined" && Number(process.pid) > 0) return "process:" + Number(process.pid);
    } catch (error) {}
    return "premiere-uxp";
  }

  function makeLockToken(now) {
    return [
      "lock",
      Math.max(0, Number(now) || Date.now()).toString(36),
      Math.floor(Math.random() * 0x100000000).toString(36),
      Math.floor(Math.random() * 0x100000000).toString(36),
    ].join("-");
  }

  function lockRecord(options, token) {
    var createdAtMs = currentTime(options);
    return {
      schemaVersion: LOCK_SCHEMA_VERSION,
      owner: String(options && options.lockOwner || defaultLockOwner()),
      token: String(token || makeLockToken(createdAtMs)),
      status: "active",
      phase: "writing",
      createdAtMs: createdAtMs,
      createdAtUtc: new Date(createdAtMs).toISOString(),
    };
  }

  function releasedLockRecord(record, options, phase) {
    var releasedAtMs = currentTime(options);
    return Object.assign({}, record, {
      status: "released",
      phase: phase === "committed" ? "committed" : "aborted",
      releasedAtMs: releasedAtMs,
      releasedAtUtc: new Date(releasedAtMs).toISOString(),
    });
  }

  function parseLockRecord(text, now) {
    var value;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw storageError("MATERIAL_BATCH_STORAGE_LOCKED", "状态写锁内容损坏，未自动删除；请先关闭其他 Premiere 进程，再手动删除 .lock 文件后重试", {
        lockReason: "invalid-format",
      });
    }
    var createdAtMs = Number(value && value.createdAtMs);
    var utcTime = Date.parse(value && value.createdAtUtc || "");
    var isActive = value && value.status === "active" && value.phase === "writing";
    var isReleased = value
      && value.status === "released"
      && (value.phase === "committed" || value.phase === "aborted");
    var releasedAtMs = Number(value && value.releasedAtMs);
    var releasedUtcTime = Date.parse(value && value.releasedAtUtc || "");
    if (!value
      || typeof value !== "object"
      || Array.isArray(value)
      || value.schemaVersion !== LOCK_SCHEMA_VERSION
      || typeof value.owner !== "string"
      || !value.owner
      || typeof value.token !== "string"
      || value.token.length < 8
      || (!isActive && !isReleased)
      || !Number.isFinite(createdAtMs)
      || createdAtMs <= 0
      || !Number.isFinite(utcTime)
      || Math.abs(utcTime - createdAtMs) > 1000
      || (isReleased && (!Number.isFinite(releasedAtMs)
        || releasedAtMs < createdAtMs
        || !Number.isFinite(releasedUtcTime)
        || Math.abs(releasedUtcTime - releasedAtMs) > 1000))) {
      throw storageError("MATERIAL_BATCH_STORAGE_LOCKED", "状态写锁格式无法验证，未自动删除；请先关闭其他 Premiere 进程，再手动删除 .lock 文件后重试", {
        lockReason: "invalid-format",
      });
    }
    if (createdAtMs > now + LOCK_FUTURE_TOLERANCE_MS) {
      throw storageError("MATERIAL_BATCH_STORAGE_LOCKED", "状态写锁的创建时间异常，未自动删除；请检查系统时间并确认没有其他 Premiere 进程后再处理 .lock 文件", {
        lockReason: "future-time",
        lockOwner: value.owner,
        lockCreatedAt: value.createdAtUtc,
      });
    }
    if (isReleased && releasedAtMs > now + LOCK_FUTURE_TOLERANCE_MS) {
      throw storageError("MATERIAL_BATCH_STORAGE_LOCKED", "状态写锁的释放时间异常，未自动处理；请检查系统时间并确认没有其他 Premiere 进程后再处理 .lock 文件", {
        lockReason: "future-time",
        lockOwner: value.owner,
        lockCreatedAt: value.createdAtUtc,
      });
    }
    return value;
  }

  function lockBlockedError(record, now, reason) {
    return storageError("MATERIAL_BATCH_STORAGE_LOCKED", "状态文件正在被另一个 Premiere 进程写入，请稍后重试", {
      lockReason: reason || "active",
      lockOwner: record && record.owner || "unknown",
      lockCreatedAt: record && record.createdAtUtc || "",
      lockAgeMs: record ? Math.max(0, now - Number(record.createdAtMs)) : 0,
    });
  }

  function staleLockError(record, now, lockPath) {
    return storageError(
      "MATERIAL_BATCH_STORAGE_STALE_LOCK",
      "检测到超过 30 分钟仍未释放的状态写锁。为避免误删仍在工作的 Premiere 锁，插件不会自动处理；请先关闭所有 Premiere 进程，再手动删除这个文件后重试：" + lockPath,
      {
        lockReason: "active-stale",
        lockPath: lockPath,
        lockOwner: record && record.owner || "unknown",
        lockCreatedAt: record && record.createdAtUtc || "",
        lockAgeMs: record ? Math.max(0, now - Number(record.createdAtMs)) : 0,
      },
    );
  }

  async function encodeUtf8(value) {
    if (typeof TextEncoder === "function") return new TextEncoder().encode(value);
    var bytes = [];
    for (var index = 0; index < value.length; index += 1) {
      var code = value.charCodeAt(index);
      if (code > 0x7f) throw new Error("当前运行环境无法编码状态写锁");
      bytes.push(code);
    }
    return new Uint8Array(bytes);
  }

  async function serializeLockRecord(record) {
    var json = JSON.stringify(record);
    var encoded = await encodeUtf8(json);
    if (encoded.byteLength + 1 > LOCK_RECORD_BYTES) {
      throw new Error("状态写锁记录超过固定长度限制");
    }
    return json + " ".repeat(LOCK_RECORD_BYTES - encoded.byteLength - 1) + "\n";
  }

  async function writeLockContents(fs, handle, serialized) {
    var encoded = await encodeUtf8(serialized);
    var result;
    if (handle && typeof handle.write === "function") {
      result = await handle.write(encoded, 0, encoded.byteLength, 0);
    } else if (typeof handle === "number" && typeof fs.write === "function") {
      result = await fs.write(handle, encoded.buffer, encoded.byteOffset, encoded.byteLength, 0);
    } else {
      throw storageError("MATERIAL_BATCH_STORAGE_LOCK_UNSUPPORTED", "当前文件接口无法通过已打开的句柄安全写入状态锁");
    }
    var bytesWritten = Number(result && result.bytesWritten != null ? result.bytesWritten : result);
    if (!Number.isFinite(bytesWritten) || bytesWritten !== encoded.byteLength) {
      throw new Error("状态写锁内容没有完整写入");
    }
  }

  async function createWriteLock(fs, lockPath, options, token) {
    var record = lockRecord(options, token);
    var serialized = await serializeLockRecord(record);
    var handle = await fs.open(lockPath, "wx");
    try {
      await writeLockContents(fs, handle, serialized);
      var observed = await readText(fs, lockPath);
      var parsed = parseLockRecord(observed, currentTime(options));
      if (observed !== serialized || parsed.token !== record.token) {
        throw new Error("状态写锁身份复核失败");
      }
      return { path: lockPath, handle: handle, record: record, serialized: serialized };
    } catch (error) {
      // 如果另一个已释放锁的竞争者暂时移动了此 inode，
      // 就将它明确标记为已释放，避免遗留无法验证的活动锁。
      try {
        var abortedRecord = releasedLockRecord(record, options, "aborted");
        await writeLockContents(fs, handle, await serializeLockRecord(abortedRecord));
      } catch (releaseError) {}
      try { await closeFileHandle(fs, handle); } catch (closeError) {}
      throw error;
    }
  }

  async function inspectLock(fs, lockPath, options) {
    var snapshot;
    try {
      snapshot = await inspectFile(fs, lockPath);
    } catch (error) {
      throw storageError("MATERIAL_BATCH_STORAGE_LOCKED", "状态写锁当前无法读取，未自动删除；请确认没有其他 Premiere 进程后重试", {
        lockReason: "unreadable",
        cause: error,
      });
    }
    if (!snapshot.exists) return null;
    snapshot.record = parseLockRecord(snapshot.text, currentTime(options));
    return snapshot;
  }

  async function assertOwnsWriteLock(fs, lock, options) {
    var snapshot = await inspectLock(fs, lock.path, options);
    if (!snapshot || snapshot.record.token !== lock.record.token || snapshot.text !== lock.serialized) {
      throw storageError("MATERIAL_BATCH_STORAGE_LOCKED", "状态写锁身份发生变化，已停止写入以避免覆盖其他进程", {
        lockReason: "ownership-lost",
      });
    }
  }

  async function restoreUnexpectedLock(fs, stalePath, lockPath) {
    try {
      if (!(await Transaction.exists(fs, lockPath)) && (await Transaction.exists(fs, stalePath))) {
        assertFsSuccess(await fs.rename(stalePath, lockPath), "恢复发生竞态的状态写锁");
      }
    } catch (error) {}
  }

  async function acquireWriteLock(fs, nativePath, options) {
    options = options || {};
    var lockPath = nativePath + ".lock";
    var staleAfterMs = Math.max(1000, Number(options.lockStaleMs) || LOCK_STALE_MS);
    var recheckWait = typeof options.lockRecheckWait === "function"
      ? options.lockRecheckWait
      : function () { return new Promise(function (resolve) { setTimeout(resolve, LOCK_RECHECK_MS); }); };
    var token = String(options.lockToken || makeLockToken(currentTime(options)));
    if (typeof fs.open !== "function") {
      throw storageError("MATERIAL_BATCH_STORAGE_LOCK_UNSUPPORTED", "当前文件接口不支持状态写锁");
    }

    for (var attempt = 0; attempt < 4; attempt += 1) {
      try {
        return await createWriteLock(fs, lockPath, options, token);
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
      }

      var first;
      try {
        first = await inspectLock(fs, lockPath, options);
      } catch (error) {
        // 新的持有者可能仍在写入其独占创建的文件。
        if (error && error.lockReason === "invalid-format") {
          await recheckWait(LOCK_RECHECK_MS);
          first = await inspectLock(fs, lockPath, options);
        } else throw error;
      }
      if (!first) continue;
      var now = currentTime(options);
      if (first.record.status === "active") {
        if (now - Number(first.record.createdAtMs) >= staleAfterMs) {
          throw staleLockError(first.record, now, lockPath);
        }
        throw lockBlockedError(first.record, now, "active");
      }

      await recheckWait(LOCK_RECHECK_MS);
      var second = await inspectLock(fs, lockPath, options);
      if (!second) continue;
      if (second.text !== first.text
        || second.revision !== first.revision
        || second.record.token !== first.record.token) {
        throw lockBlockedError(second.record, currentTime(options), "changed-during-recheck");
      }
      if (second.record.status !== "released") {
        now = currentTime(options);
        if (now - Number(second.record.createdAtMs) >= staleAfterMs) {
          throw staleLockError(second.record, now, lockPath);
        }
        throw lockBlockedError(second.record, now, "active-after-recheck");
      }

      var stalePath = uniquePath(lockPath, ".released-");
      try {
        assertFsSuccess(await fs.rename(lockPath, stalePath), "隔离已释放的状态写锁");
      } catch (error) {
        if (Core.isMissingPathError(error)) continue;
        throw storageError("MATERIAL_BATCH_STORAGE_LOCKED", "已释放的状态写锁暂时无法安全接管，未执行写入", {
          lockReason: "reclaim-failed",
          cause: error,
        });
      }

      var quarantined;
      try {
        quarantined = await inspectLock(fs, stalePath, options);
      } catch (error) {
        await restoreUnexpectedLock(fs, stalePath, lockPath);
        throw error;
      }
      if (!quarantined
        || quarantined.text !== second.text
        || quarantined.record.token !== second.record.token
        || quarantined.record.status !== "released") {
        await restoreUnexpectedLock(fs, stalePath, lockPath);
        throw storageError("MATERIAL_BATCH_STORAGE_LOCKED", "状态写锁在回收时发生身份竞态，已停止写入", {
          lockReason: "reclaim-race",
        });
      }

      try {
        var acquired = await createWriteLock(fs, lockPath, options, token);
        await safeUnlink(fs, stalePath);
        return acquired;
      } catch (error) {
        if (isAlreadyExistsError(error)) {
          await safeUnlink(fs, stalePath);
          var winner = await inspectLock(fs, lockPath, options);
          throw winner
            ? lockBlockedError(winner.record, currentTime(options), "reclaim-lost")
            : lockBlockedError(null, currentTime(options), "reclaim-lost");
        }
        await restoreUnexpectedLock(fs, stalePath, lockPath);
        throw error;
      }
    }
    throw lockBlockedError(null, currentTime(options), "reclaim-retry-exhausted");
  }

  async function releaseWriteLock(fs, lock, options, phase) {
    if (!lock) return "";
    var warnings = [];
    try {
      await assertOwnsWriteLock(fs, lock, options);
      var releasedRecord = releasedLockRecord(lock.record, options, phase);
      var releasedSerialized = await serializeLockRecord(releasedRecord);
      await writeLockContents(fs, lock.handle, releasedSerialized);
      var releasedSnapshot = await inspectLock(fs, lock.path, options);
      if (!releasedSnapshot
        || releasedSnapshot.record.token !== lock.record.token
        || releasedSnapshot.record.status !== "released"
        || releasedSnapshot.text !== releasedSerialized) {
        warnings.push("状态写锁已由其他进程接管；旧 owner 只释放了自己的文件句柄，未改动当前 .lock 文件");
      }
    } catch (error) {
      warnings.push("无法把状态写锁标记为已释放: " + (error.message || error));
    }
    try {
      await closeFileHandle(fs, lock.handle);
    } catch (error) {
      warnings.push("关闭状态写锁失败: " + (error.message || error));
    }
    return warnings.join("; ");
  }

  async function readJsonWithBackup(fs, nativePath) {
    var options = arguments.length > 2 && arguments[2] ? arguments[2] : {};
    var validate = typeof options.validate === "function" ? options.validate : null;
    var primary;
    try {
      primary = await inspectFile(fs, nativePath);
    } catch (error) {
      primary = { exists: true, text: "", revision: undefined, readError: error };
    }
    if (primary.exists && !primary.readError) {
      try {
        var primaryValue = JSON.parse(primary.text);
        if (!validate || validate(primaryValue) !== false) {
          return { value: primaryValue, recovered: false, missing: false, revision: primary.revision };
        }
        primary.validationError = new Error("主状态文件内容不兼容当前状态格式");
      } catch (error) {
        if (error && error.preventBackupFallback === true) throw error;
        primary.parseError = error;
      }
    }

    var backup;
    try {
      backup = await inspectFile(fs, nativePath + ".bak");
    } catch (error) {
      backup = { exists: true, text: "", revision: undefined, readError: error };
    }
    if (backup.exists && !backup.readError) {
      try {
        var backupValue = JSON.parse(backup.text);
        if (!validate || validate(backupValue) !== false) {
          return { value: backupValue, recovered: true, missing: false, revision: primary.revision };
        }
        backup.validationError = new Error("备份状态文件内容不兼容当前状态格式");
      } catch (error) {
        if (error && error.preventBackupFallback === true) throw error;
        backup.parseError = error;
      }
    }

    if (!primary.exists && !backup.exists) {
      return { value: null, recovered: false, missing: true, revision: MISSING_REVISION };
    }

    throw storageError(
      "MATERIAL_BATCH_STORAGE_CORRUPT",
      validate
        ? "素材空间状态文件格式不兼容或已损坏，且备份文件也不可用，已停止自动整理"
        : "素材空间状态文件损坏，且备份文件不可用，已停止自动整理",
      {
        primaryError: primary.parseError || primary.validationError || primary.readError,
        backupError: backup.parseError || backup.validationError || backup.readError,
      },
    );
  }

  async function safeUnlink(fs, nativePath) {
    try {
      if (await Transaction.exists(fs, nativePath)) await fs.unlink(nativePath);
    } catch (error) {}
  }

  async function writeJsonAtomic(fs, nativePath, value, options) {
    options = options || {};
    var backupPath = nativePath + ".bak";
    var tempPath = uniquePath(nativePath, ".tmp-");
    var previousPath = uniquePath(nativePath, ".bak-old-");
    var previousBackupPath = uniquePath(nativePath, ".bak-previous-");
    var initialBackupTempPath = uniquePath(nativePath, ".bak-new-");
    var lock = await acquireWriteLock(fs, nativePath, options);
    var mainMoved = false;
    var backupMoved = false;
    var previousBackupMoved = false;
    var initialBackupMoved = false;
    var promoted = false;
    var writeResult = null;
    var commitWarning = "";

    try {
      await assertOwnsWriteLock(fs, lock, options);
      var current = await inspectFile(fs, nativePath);
      if (Object.prototype.hasOwnProperty.call(options, "expectedRevision")
        && current.revision !== options.expectedRevision) {
        throw storageError("MATERIAL_BATCH_STORAGE_CONFLICT", "状态文件已被其他进程修改，未覆盖最新状态", {
          expectedRevision: options.expectedRevision,
          actualRevision: current.revision,
        });
      }

      var serialized = JSON.stringify(value, null, 2) + "\n";
      await fs.writeFile(tempPath, serialized, { encoding: "utf-8" });
      var tempSnapshot = await inspectFile(fs, tempPath);
      var afterWrite = await inspectFile(fs, nativePath);
      if (current.revision !== afterWrite.revision) {
        throw storageError("MATERIAL_BATCH_STORAGE_CONFLICT", "状态文件在写入期间发生变化，未覆盖最新状态", {
          expectedRevision: current.revision,
          actualRevision: afterWrite.revision,
        });
      }
      await assertOwnsWriteLock(fs, lock, options);

      var preserveBackup = options.recovered === true || options.preserveBackup === true;
      if (current.exists && !preserveBackup) {
        await fs.rename(nativePath, previousPath);
        mainMoved = true;
        if (await Transaction.exists(fs, backupPath)) {
          await fs.rename(backupPath, previousBackupPath);
          previousBackupMoved = true;
        }
        await fs.rename(previousPath, backupPath);
        backupMoved = true;
      }

      // 全新状态必须先具备可恢复的备份，才能提升为主文件。
      // 这样即使首次写入成功，也不会只留下唯一一份可用副本。
      if (!current.exists && !(await Transaction.exists(fs, backupPath))) {
        await fs.writeFile(initialBackupTempPath, serialized, { encoding: "utf-8" });
        var initialBackupSnapshot = await inspectFile(fs, initialBackupTempPath);
        if (!initialBackupSnapshot.exists || initialBackupSnapshot.text !== serialized) {
          throw storageError("MATERIAL_BATCH_STORAGE_BACKUP_FAILED", "无法准备状态文件备份，未提交新的状态");
        }
        await fs.rename(initialBackupTempPath, backupPath);
        initialBackupMoved = true;
      }

      await assertOwnsWriteLock(fs, lock, options);
      await fs.rename(tempPath, nativePath);
      promoted = true;
      if (previousBackupMoved) await safeUnlink(fs, previousBackupPath);
      try {
        writeResult = { committed: true, revision: (await inspectFile(fs, nativePath)).revision };
      } catch (postCommitError) {
        // 重命名是提交点。在受支持的文件系统中，提升前临时文件的状态信息
        // 在重命名后仍然有效，因此用它作为 CAS 令牌更安全，避免主文件已经就位后
        // 再让整个写入失败。
        var fallbackRevision = tempSnapshot && tempSnapshot.revision;
        if (!fallbackRevision) fallbackRevision = revisionFor(serialized, null);
        commitWarning = "状态文件已经写入，但提交后的复核失败，已使用写入时指纹继续；请稍后重新检查（"
          + (postCommitError.message || postCommitError) + "）";
        writeResult = { committed: true, revision: fallbackRevision, warning: commitWarning };
      }
      return writeResult;
    } catch (error) {
      await safeUnlink(fs, tempPath);
      await safeUnlink(fs, initialBackupTempPath);
      if (!promoted) {
        if (initialBackupMoved) await safeUnlink(fs, backupPath);
        if (backupMoved && !(await Transaction.exists(fs, previousPath))) {
          try { await fs.rename(backupPath, previousPath); } catch (restoreError) {}
        }
        if (mainMoved && (await Transaction.exists(fs, previousPath)) && !(await Transaction.exists(fs, nativePath))) {
          try { await fs.rename(previousPath, nativePath); } catch (restoreError) {}
        }
        if (previousBackupMoved && !(await Transaction.exists(fs, backupPath)) && (await Transaction.exists(fs, previousBackupPath))) {
          try { await fs.rename(previousBackupPath, backupPath); } catch (restoreError) {}
        }
      }
      throw error;
    } finally {
      var lockWarning = await releaseWriteLock(fs, lock, options, promoted ? "committed" : "aborted");
      if (lockWarning && writeResult) {
        writeResult.lockReleaseWarning = lockWarning;
        writeResult.warning = [writeResult.warning, "状态写锁清理警告: " + lockWarning].filter(Boolean).join("；");
      }
    }
  }

  return {
    STATE_FILE_NAME: STATE_FILE_NAME,
    LOCK_SCHEMA_VERSION: LOCK_SCHEMA_VERSION,
    LOCK_RECORD_BYTES: LOCK_RECORD_BYTES,
    LOCK_STALE_MS: LOCK_STALE_MS,
    MISSING_REVISION: MISSING_REVISION,
    readJsonWithBackup: readJsonWithBackup,
    statePath: statePath,
    writeJsonAtomic: writeJsonAtomic,
  };
});
