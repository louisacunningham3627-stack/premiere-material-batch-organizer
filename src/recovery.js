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

  function hasFingerprint(value) {
    return Boolean(value && typeof value === "object" && Object.keys(value).length);
  }

  async function inspectPending(options) {
    var pending = options.pending || {};
    var sourcePath = String(pending.sourcePath || "");
    var targetPath = String(options.targetPath || "");
    var mediaRoot = String(options.mediaRoot || "");
    var linkedEntries = Array.isArray(options.linkedEntries) ? options.linkedEntries : [];
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
    var entryById = {};
    linkedEntries.forEach(function (entry) {
      if (entry && entry.itemId) entryById[String(entry.itemId)] = String(entry.mediaPath || "");
    });
    var missingItemIds = expectedItemIds.filter(function (itemId) { return !entryById[itemId]; });
    var sourceLinkCount = expectedItemIds.filter(function (itemId) { return Core.samePath(entryById[itemId], sourcePath); }).length;
    var targetLinkCount = expectedItemIds.filter(function (itemId) { return Core.samePath(entryById[itemId], targetPath); }).length;
    var sourceChanged = false;

    if (sourceExists && hasFingerprint(pending.sourceFingerprint)) {
      var currentSourceFingerprint = Transaction.fingerprintFromStat(await options.fs.lstat(sourcePath));
      sourceChanged = !Transaction.sameFingerprint(pending.sourceFingerprint, currentSourceFingerprint);
      if (sourceChanged && String(pending.mode || "") === "rename") {
        sourceChanged = !Transaction.sameFileAfterRename(pending.sourceFingerprint, currentSourceFingerprint);
      }
    }
    if (cleanupExists && (
      !hasFingerprint(pending.sourceFingerprint)
      || !Transaction.sameFileAfterRename(
        pending.sourceFingerprint,
        Transaction.fingerprintFromStat(await options.fs.lstat(cleanupPath))
      )
    )) {
      return manual("待删除文件的身份与事务记录不一致，未执行恢复", {
        sourceExists: sourceExists,
        targetExists: targetExists,
        stagingExists: stagingExists,
        cleanupExists: true,
        cleanupPath: cleanupPath,
      });
    }

    if (targetExists) {
      var targetStat = await options.fs.lstat(targetPath);
      var currentTargetFingerprint = Transaction.fingerprintFromStat(targetStat);
      if (hasFingerprint(pending.targetFingerprint)
        && !Transaction.samePortableFingerprint(pending.targetFingerprint, currentTargetFingerprint)) {
        return manual("目标文件与事务记录的身份不一致，未自动恢复", {
          sourceExists: sourceExists,
          targetExists: true,
          stagingExists: stagingExists,
        });
      }
      if (Object.prototype.hasOwnProperty.call(pending, "byteCount") && Transaction.statSize(targetStat) !== Math.max(0, Number(pending.byteCount) || 0)) {
        return manual("目标文件大小与事务记录不一致，已保留两处文件", {
          sourceExists: sourceExists,
          targetExists: true,
          stagingExists: stagingExists,
        });
      }
      var expectedMtime = Number(pending.sourceFingerprint && pending.sourceFingerprint.mtimeMs) || 0;
      var targetMtime = Transaction.statMtime(targetStat);
      if (expectedMtime && targetMtime && Math.abs(expectedMtime - targetMtime) > 2000) {
        return manual("目标文件时间与事务记录不一致，未自动恢复", {
          sourceExists: sourceExists,
          targetExists: true,
          stagingExists: stagingExists,
        });
      }
    }

    var details = {
      sourceExists: sourceExists,
      targetExists: targetExists,
      stagingExists: stagingExists,
      cleanupExists: cleanupExists,
      cleanupPath: cleanupPath,
      remainingSourcePath: cleanupExists ? cleanupPath : sourceExists && !sourceChanged ? sourcePath : "",
      sourceChanged: sourceChanged,
      sourceLinkCount: sourceLinkCount,
      targetLinkCount: targetLinkCount,
      missingItemIds: missingItemIds,
    };

    if (stagingExists) return manual("发现未完成的临时副本，需要人工检查", details);
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
