(function (root, factory) {
  "use strict";

  var api = factory(
    typeof module !== "undefined" && module.exports ? require("./core") : root.MaterialBatchCore,
    typeof module !== "undefined" && module.exports ? require("./transaction") : root.MaterialBatchTransaction
  );
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.MaterialBatchRecovery = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (Core, Transaction) {
  "use strict";

  function manual(reason, details) {
    return Object.assign({ kind: "manual", reason: reason }, details || {});
  }

  async function inspectPending(options) {
    var pending = options.pending || {};
    var sourcePath = String(pending.sourcePath || "");
    var targetPath = String(options.targetPath || "");
    var mediaRoot = String(options.mediaRoot || "");
    var linkedEntries = (Array.isArray(options.linkedEntries) ? options.linkedEntries : []).map(function (entry) {
      return {
        itemId: String(entry && entry.itemId || ""),
        itemName: String(entry && entry.itemName || ""),
        mediaPath: String(entry && entry.mediaPath || ""),
      };
    });
    var expectedItemIds = Array.isArray(pending.itemIds) ? pending.itemIds.map(String).filter(Boolean) : [];
    var expectedItemCount = Math.max(1, Math.floor(Number(pending.itemCount) || 1));

    if (!Core.isAbsoluteLocalPath(sourcePath) || Core.isProjectFile(sourcePath)) {
      return manual("事务中的源路径无效，未执行恢复");
    }
    if (!Core.isSafeRelativePath(pending.targetRelativePath)) {
      return manual("事务中的目标相对路径无效，未执行恢复");
    }
    if (!Core.isAbsoluteLocalPath(targetPath) || !mediaRoot || !Core.isPathInside(targetPath, mediaRoot)) {
      return manual("事务目标越出了素材目录，未执行恢复");
    }

    var cleanupPath = "";
    if (pending.cleanupPath) {
      var expectedCleanupPath = Transaction.cleanupPathFor(sourcePath, pending.id);
      if (!Core.isAbsoluteLocalPath(pending.cleanupPath) || !Core.samePath(pending.cleanupPath, expectedCleanupPath)) {
        return manual("事务中的待删除文件路径无效，未执行恢复");
      }
      cleanupPath = String(pending.cleanupPath);
    }

    var stagingPath = targetPath + ".organizing-part";
    var sourceExists = await Transaction.exists(options.fs, sourcePath);
    var targetExists = await Transaction.exists(options.fs, targetPath);
    var stagingExists = await Transaction.exists(options.fs, stagingPath);
    var cleanupExists = cleanupPath ? await Transaction.exists(options.fs, cleanupPath) : false;
    if (!expectedItemIds.length
      || expectedItemIds.length !== expectedItemCount
      || new Set(expectedItemIds).size !== expectedItemIds.length) {
      return manual("事务缺少完整的素材项身份，或身份存在重复，不能自动恢复");
    }
    if (!Transaction.hasStrongFileIdentity(pending.sourceFingerprint)) {
      return manual("事务缺少可核对的原位置文件身份，不能自动恢复");
    }
    var entryById = {};
    var duplicateCurrentItemIds = [];
    linkedEntries.forEach(function (entry) {
      if (!entry.itemId) return;
      if (entryById[entry.itemId]) duplicateCurrentItemIds.push(entry.itemId);
      entryById[entry.itemId] = entry;
    });
    if (duplicateCurrentItemIds.length) {
      return manual("当前工程包含重复的素材项身份，不能自动恢复", {
        sourcePath: sourcePath,
        targetPath: targetPath,
        duplicateCurrentItemIds: duplicateCurrentItemIds,
      });
    }
    var missingItemIds = expectedItemIds.filter(function (itemId) { return !entryById[itemId]; });
    var candidateEntries = linkedEntries.filter(function (entry) {
      return entry.itemId && (Core.samePath(entry.mediaPath, sourcePath) || Core.samePath(entry.mediaPath, targetPath));
    });
    var candidateIds = candidateEntries.map(function (entry) { return entry.itemId; });
    var candidatesAreUnique = candidateIds.length === new Set(candidateIds).size;
    var rebuiltIdentity = missingItemIds.length === expectedItemIds.length
      && candidateEntries.length === expectedItemCount
      && candidatesAreUnique;
    var resolvedEntries = missingItemIds.length === 0
      ? expectedItemIds.map(function (itemId) { return entryById[itemId]; })
      : rebuiltIdentity ? candidateEntries : [];
    var sourceLinkCount = resolvedEntries.filter(function (entry) { return Core.samePath(entry.mediaPath, sourcePath); }).length;
    var targetLinkCount = resolvedEntries.filter(function (entry) { return Core.samePath(entry.mediaPath, targetPath); }).length;
    var sourceChanged = false;
    var currentSourceFingerprint = null;
    var currentTargetFingerprint = null;
    var targetCheckpointMatch = "none";

    if (sourceExists) {
      currentSourceFingerprint = Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(options.fs, sourcePath));
      if (!Transaction.hasStrongFileIdentity(currentSourceFingerprint)) {
        return manual("无法取得原位置文件的可靠身份，不能自动恢复", {
          sourcePath: sourcePath,
          targetPath: targetPath,
          sourceExists: true,
          targetExists: targetExists,
          stagingExists: stagingExists,
          cleanupExists: cleanupExists,
          cleanupPath: cleanupPath,
          sourceLinkCount: sourceLinkCount,
          targetLinkCount: targetLinkCount,
        });
      }
      sourceChanged = !Transaction.sameStrongPathFingerprint(pending.sourceFingerprint, currentSourceFingerprint);
      if (sourceChanged && String(pending.mode || "") === "rename") {
        sourceChanged = !Transaction.sameFileAfterRename(pending.sourceFingerprint, currentSourceFingerprint);
      }
    }
    if (cleanupExists) {
      var currentCleanupFingerprint = Transaction.fingerprintFromStat(
        await Transaction.lstatForIdentity(options.fs, cleanupPath)
      );
      if (!Transaction.hasStrongFileIdentity(currentCleanupFingerprint)
        || !Transaction.sameFileAfterRename(pending.sourceFingerprint, currentCleanupFingerprint)) {
        return manual("待删除文件的身份与事务记录不一致，未执行恢复", {
          sourcePath: sourcePath,
          targetPath: targetPath,
          sourceExists: sourceExists,
          targetExists: targetExists,
          stagingExists: stagingExists,
          cleanupExists: true,
          cleanupPath: cleanupPath,
          sourceLinkCount: sourceLinkCount,
          targetLinkCount: targetLinkCount,
        });
      }
    }

    var targetProblem = "";
    var targetProblemCode = "";
    if (targetExists) {
      var targetStat = await Transaction.lstatForIdentity(options.fs, targetPath);
      currentTargetFingerprint = Transaction.fingerprintFromStat(targetStat);
      var hasTargetCheckpoint = Transaction.hasStrongFileIdentity(pending.targetFingerprint);
      var strictTargetMatch = hasTargetCheckpoint
        && Transaction.sameStrongPathFingerprint(pending.targetFingerprint, currentTargetFingerprint);
      var hardLinkTargetMatch = hasTargetCheckpoint
        && pending.targetMethod === "link"
        && (cleanupExists || !sourceExists || sourceChanged)
        && Transaction.sameHardLinkRecoveryFingerprint(pending.targetFingerprint, currentTargetFingerprint);
      if (!targetStat || typeof targetStat.isFile !== "function" || !targetStat.isFile()) {
        targetProblem = "新位置不是单个文件，未自动恢复";
        targetProblemCode = "target-not-file";
      } else if (!hasTargetCheckpoint) {
        targetProblem = "事务缺少可靠的新位置文件身份，无法确认当前目标文件，未自动恢复";
        targetProblemCode = "missing-target-checkpoint";
      } else if (!strictTargetMatch && !hardLinkTargetMatch) {
        targetProblem = "目标文件与事务记录的身份不一致，未自动恢复";
        targetProblemCode = "target-identity-mismatch";
      }
      if (hasTargetCheckpoint) targetCheckpointMatch = strictTargetMatch ? "strict" : "hard-link";
      if (!targetProblem
        && Object.prototype.hasOwnProperty.call(pending, "byteCount")
        && Transaction.statSize(targetStat) !== Math.max(0, Number(pending.byteCount) || 0)) {
        targetProblem = "目标文件大小与事务记录不一致，已保留两处文件";
        targetProblemCode = "target-size-mismatch";
      }
    }

    var details = {
      sourcePath: sourcePath,
      targetPath: targetPath,
      sourceExists: sourceExists,
      targetExists: targetExists,
      stagingExists: stagingExists,
      cleanupExists: cleanupExists,
      cleanupPath: cleanupPath,
      remainingSourcePath: cleanupExists ? cleanupPath : sourceExists && !sourceChanged ? sourcePath : "",
      sourceChanged: sourceChanged,
      sourceFingerprint: currentSourceFingerprint,
      targetFingerprint: currentTargetFingerprint,
      targetCheckpointMatch: targetCheckpointMatch,
      sourceSize: currentSourceFingerprint ? Transaction.statSize(currentSourceFingerprint) : 0,
      targetSize: currentTargetFingerprint ? Transaction.statSize(currentTargetFingerprint) : 0,
      sourceLinkCount: sourceLinkCount,
      targetLinkCount: targetLinkCount,
      missingItemIds: missingItemIds,
      candidateEntries: rebuiltIdentity ? candidateEntries : [],
      resolvedItemIds: resolvedEntries.map(function (entry) { return entry.itemId; }),
      requiresCandidateConfirmation: rebuiltIdentity,
      currentLinkState: sourceLinkCount === expectedItemCount
        ? "source"
        : targetLinkCount === expectedItemCount
          ? "target"
          : sourceLinkCount + targetLinkCount === expectedItemCount && resolvedEntries.length === expectedItemCount
            ? "mixed"
            : "unknown",
    };

    if (targetProblem) {
      return manual(targetProblem, Object.assign({ manualCode: targetProblemCode }, details));
    }

    if (stagingExists) return manual("发现未完成的临时副本，需要人工检查", details);
    if (missingItemIds.length && !rebuiltIdentity) {
      return manual("当前工程中的旧素材项身份已经失效，且无法得到唯一候选，未自动恢复", details);
    }
    if (sourceChanged && sourceLinkCount > 0) {
      return manual("原位置文件已经变化，不能确认当前素材项仍是上次整理的文件", details);
    }
    if (targetExists
      && resolvedEntries.length === expectedItemCount
      && sourceLinkCount + targetLinkCount === expectedItemCount
      && (rebuiltIdentity || sourceLinkCount > 0)) {
      return Object.assign({
        kind: "confirmation-required",
        reason: rebuiltIdentity
          ? "Premiere 重启后素材项身份已变化，已找到唯一候选；继续前需要你确认"
          : "原位置和新位置都已找到；继续前需要你确认更新 Premiere 链接",
        requiresCandidateConfirmation: rebuiltIdentity,
      }, details);
    }
    if (targetExists && !missingItemIds.length && targetLinkCount === expectedItemIds.length && sourceLinkCount === 0) {
      return Object.assign({
        kind: "completed",
        cleanupPending: cleanupExists || (sourceExists && !sourceChanged),
        sourceRetained: false,
      }, details);
    }

    if (!cleanupExists && sourceExists && !sourceChanged && !targetExists && !missingItemIds.length && sourceLinkCount === expectedItemIds.length && targetLinkCount === 0) {
      return Object.assign({ kind: "rolled-back" }, details);
    }

    if (!sourceExists && !targetExists) return manual("源文件和目标文件都不存在，无法自动恢复", details);
    if (missingItemIds.length || (sourceLinkCount === 0 && targetLinkCount === 0)) return manual("请先打开发生整理操作的原工程，或确认素材项没有被替换", details);
    return manual("当前文件与 Premiere 链接状态不一致，需要人工检查", details);
  }

  return {
    inspectPending: inspectPending,
  };
});
