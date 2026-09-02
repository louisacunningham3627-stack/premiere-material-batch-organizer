(function (root, factory) {
  "use strict";

  var api = factory(typeof module !== "undefined" && module.exports ? require("./core") : root.MaterialBatchCore);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.MaterialBatchScanPolicy = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (Core) {
  "use strict";

  function numericFingerprint(value) {
    var fingerprint = value && typeof value === "object" ? value : {};
    return {
      size: Math.max(0, Number(fingerprint.size) || 0),
      mtimeMs: Math.max(0, Number(fingerprint.mtimeMs) || 0),
      ctimeMs: Math.max(0, Number(fingerprint.ctimeMs) || 0),
      birthtimeMs: Math.max(0, Number(fingerprint.birthtimeMs) || 0),
      dev: Math.max(0, Number(fingerprint.dev) || 0),
      ino: Math.max(0, Number(fingerprint.ino) || 0),
    };
  }

  function signatureFor(value) {
    var fingerprint = numericFingerprint(value);
    return [
      fingerprint.size,
      fingerprint.mtimeMs,
      fingerprint.ctimeMs,
      fingerprint.birthtimeMs,
      fingerprint.dev,
      fingerprint.ino,
    ].join(":");
  }

  function hasPortableFingerprint(value) {
    if (!value || typeof value !== "object") return false;
    var size = Number(value.size);
    var mtimeMs = Number(value.mtimeMs);
    return Number.isFinite(size) && size >= 0 && Number.isFinite(mtimeMs) && mtimeMs > 0;
  }

  function samePortableFingerprint(left, right) {
    return hasPortableFingerprint(left)
      && hasPortableFingerprint(right)
      && Number(left.size) === Number(right.size)
      && Number(left.mtimeMs) === Number(right.mtimeMs);
  }

  function mappingTargetStatus(mapping, targetExists, targetFingerprint) {
    if (!targetExists) return "missing";
    if (!hasPortableFingerprint(mapping && mapping.targetFingerprint)) return "unverified";
    if (!hasPortableFingerprint(targetFingerprint)) return "unavailable";
    return samePortableFingerprint(mapping.targetFingerprint, targetFingerprint) ? "match" : "mismatch";
  }

  function shouldMonitor(options) {
    var status = options || {};
    return status.panelVisible === true
      && status.autoEnabled === true
      && status.hasProject === true
      && status.pendingTransaction !== true
      && status.pendingProjectSave !== true
      && Math.max(0, Number(status.unresolvedProtectedCount) || 0) === 0;
  }

  async function validateProtectedMappings(fs, libraries, machineMappings, options) {
    var config = options || {};
    var mappingsById = {};
    (machineMappings || []).forEach(function (mapping) {
      if (mapping && mapping.libraryId) mappingsById[String(mapping.libraryId)] = mapping;
    });

    var validMappings = [];
    var unresolved = [];
    var statusById = {};
    var claimedRootByKey = {};
    var requestedLibraries = Array.isArray(libraries) ? libraries : [];
    for (var index = 0; index < requestedLibraries.length; index += 1) {
      var library = requestedLibraries[index];
      if (!library || !library.libraryId) continue;
      var libraryId = String(library.libraryId);
      var mapping = mappingsById[libraryId];
      var reason = "";
      if (!mapping) {
        reason = "这台电脑还没有选择对应文件夹";
      } else if (!Core.isAbsoluteLocalPath(mapping.rootPath)) {
        reason = "保存的文件夹路径不是有效的绝对路径";
      } else if (config.mediaRoot && Core.isPathInside(mapping.rootPath, config.mediaRoot)) {
        reason = "不能把已经整理的素材目录设为不搬动文件夹";
      } else {
        try {
          var stat = await fs.lstat(mapping.rootPath);
          if (!stat || typeof stat.isDirectory !== "function" || !stat.isDirectory()) {
            reason = "保存的路径不是文件夹";
          }
        } catch (error) {
          reason = "文件夹不存在或当前无法访问";
        }
      }
      if (!reason) {
        var rootKey = Core.normalizePathForComparison(mapping.rootPath);
        var claimedBy = claimedRootByKey[rootKey];
        if (claimedBy && claimedBy !== libraryId) {
          reason = "这个文件夹已经映射给另一个不搬动素材库";
        } else {
          claimedRootByKey[rootKey] = libraryId;
        }
      }

      if (reason) {
        var invalid = { libraryId: libraryId, label: String(library.label || mapping && mapping.label || "共享素材库"), mapping: mapping || null, reason: reason };
        unresolved.push(invalid);
        statusById[libraryId] = { valid: false, mapping: mapping || null, reason: reason };
      } else {
        validMappings.push(mapping);
        statusById[libraryId] = { valid: true, mapping: mapping, reason: "" };
      }
    }

    return {
      validMappings: validMappings,
      unresolved: unresolved,
      statusById: statusById,
    };
  }

  function createStabilityTracker(options) {
    var config = options || {};
    var stableForMs = Math.max(1000, Number(config.stableForMs) || 8000);
    var minimumAgeMs = Math.max(1000, Number(config.minimumAgeMs) || 5000);
    var observations = {};

    function observe(nativePath, value, at) {
      var key = Core.normalizePathForComparison(nativePath);
      var now = at instanceof Date ? at.getTime() : Number(at) || Date.now();
      var fingerprint = numericFingerprint(value);
      if (!key || !value || !fingerprint.mtimeMs) {
        delete observations[key];
        return { ready: false, status: "unverifiable", stableForMs: 0 };
      }

      var signature = signatureFor(fingerprint);
      var previous = observations[key];
      if (!previous || previous.signature !== signature) {
        observations[key] = { signature: signature, stableSince: now, lastSeenAt: now };
        return { ready: false, status: "waiting", stableForMs: 0 };
      }

      previous.lastSeenAt = now;
      var observedStableFor = Math.max(0, now - previous.stableSince);
      var modifiedAge = Math.max(0, now - fingerprint.mtimeMs);
      return {
        ready: observedStableFor >= stableForMs && modifiedAge >= minimumAgeMs,
        status: observedStableFor >= stableForMs && modifiedAge >= minimumAgeMs ? "ready" : "waiting",
        stableForMs: observedStableFor,
        modifiedAgeMs: modifiedAge,
      };
    }

    function forget(nativePath) {
      delete observations[Core.normalizePathForComparison(nativePath)];
    }

    function retain(nativePaths) {
      var retained = new Set((nativePaths || []).map(Core.normalizePathForComparison));
      Object.keys(observations).forEach(function (key) {
        if (!retained.has(key)) delete observations[key];
      });
    }

    function clear() {
      observations = {};
    }

    return {
      clear: clear,
      forget: forget,
      observe: observe,
      retain: retain,
    };
  }

  return {
    createStabilityTracker: createStabilityTracker,
    hasPortableFingerprint: hasPortableFingerprint,
    mappingTargetStatus: mappingTargetStatus,
    samePortableFingerprint: samePortableFingerprint,
    shouldMonitor: shouldMonitor,
    signatureFor: signatureFor,
    validateProtectedMappings: validateProtectedMappings,
  };
});
