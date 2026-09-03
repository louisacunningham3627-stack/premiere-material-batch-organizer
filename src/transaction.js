(function (root, factory) {
  "use strict";

  var api = factory(typeof module !== "undefined" && module.exports ? require("./core") : root.MaterialBatchCore);
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.MaterialBatchTransaction = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (Core) {
  "use strict";

  var CLEANUP_SETTLING_MS = 1000;

  function delay(milliseconds) {
    return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
  }

  function successfulFsResult(value) {
    return value === undefined || value === null || value === 0;
  }

  async function exists(fs, nativePath) {
    try {
      await fs.lstat(nativePath);
      return true;
    } catch (error) {
      if (Core.isMissingPathError(error)) return false;
      throw error;
    }
  }

  // 只有文件与已创建目标目录的 lstat.dev 都存在且相同，才证明可以走同卷移动。
  // UXP 或某些文件系统可能不提供 dev；此时必须保守地走复制事务。
  async function resolveMoveMode(fs, sourcePath, targetDirectory) {
    var sourceStat;
    var targetStat;
    try {
      sourceStat = await fs.lstat(sourcePath);
      targetStat = await fs.lstat(targetDirectory);
    } catch (error) {
      return { mode: "copy", proven: false, reason: "无法读取源文件或目标目录卷标识" };
    }
    var sourceDev = Number(sourceStat && sourceStat.dev);
    var targetDev = Number(targetStat && targetStat.dev);
    if (!Number.isFinite(sourceDev) || !Number.isFinite(targetDev) || sourceDev <= 0 || targetDev <= 0) {
      return { mode: "copy", proven: false, reason: "文件系统未提供可验证的卷标识", sourceDev: sourceDev || 0, targetDev: targetDev || 0 };
    }
    if (sourceDev !== targetDev) {
      return { mode: "copy", proven: true, reason: "源文件与目标目录不在同一卷", sourceDev: sourceDev, targetDev: targetDev };
    }
    return { mode: "rename", proven: true, reason: "源文件与目标目录确认同卷", sourceDev: sourceDev, targetDev: targetDev };
  }

  async function assertContext(validate) {
    if (typeof validate !== "function") return;
    if ((await validate()) === false) {
      var error = new Error("活动工程已切换，已停止整理");
      error.code = "MATERIAL_BATCH_CONTEXT_CHANGED";
      throw error;
    }
  }

  function notify(listener, stage, details) {
    if (typeof listener !== "function") return;
    try { listener(stage, details || {}); } catch (error) {}
  }

  function statSize(stat) {
    return Math.max(0, Number(stat && stat.size) || 0);
  }

  function statMtime(stat) {
    if (!stat) return 0;
    var value = stat.mtimeMs != null ? stat.mtimeMs : stat.mtime;
    if (value instanceof Date) return value.getTime();
    var number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function statCtime(stat) {
    if (!stat) return 0;
    var value = stat.ctimeMs != null ? stat.ctimeMs : stat.ctime;
    if (value instanceof Date) return value.getTime();
    var number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function statBirthtime(stat) {
    if (!stat) return 0;
    var value = stat.birthtimeMs != null ? stat.birthtimeMs : stat.birthtime;
    if (value instanceof Date) return value.getTime();
    var number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function statIdentityNumber(stat, field) {
    var number = Number(stat && stat[field]);
    return Number.isFinite(number) ? number : 0;
  }

  function fingerprintFromStat(stat) {
    return {
      size: statSize(stat),
      mtimeMs: statMtime(stat),
      ctimeMs: statCtime(stat),
      birthtimeMs: statBirthtime(stat),
      dev: statIdentityNumber(stat, "dev"),
      ino: statIdentityNumber(stat, "ino"),
    };
  }

  function sameOptionalNumber(left, right, field) {
    var leftValue = Number(left && left[field]) || 0;
    var rightValue = Number(right && right[field]) || 0;
    return !leftValue || !rightValue || leftValue === rightValue;
  }

  function sameFingerprint(left, right) {
    if (!left || !right || Number(left.size) !== Number(right.size)) return false;
    return sameOptionalNumber(left, right, "mtimeMs")
      && sameOptionalNumber(left, right, "ctimeMs")
      && sameOptionalNumber(left, right, "birthtimeMs")
      && sameOptionalNumber(left, right, "dev")
      && sameOptionalNumber(left, right, "ino");
  }

  function sameFileAfterRename(left, right) {
    if (!left || !right || Number(left.size) !== Number(right.size)) return false;
    return sameOptionalNumber(left, right, "mtimeMs")
      && sameOptionalNumber(left, right, "birthtimeMs")
      && sameOptionalNumber(left, right, "dev")
      && sameOptionalNumber(left, right, "ino");
  }

  // 设备号和 inode 值无法跨卷使用，也无法用于复制后的文件。
  // 文件大小可以为零，但执行此项检查时两个字段都必须存在且为有限数值。
  function portableNumber(value, allowZero) {
    var number = Number(value);
    if (!Number.isFinite(number)) return null;
    if (!allowZero && number <= 0) return null;
    return number;
  }

  function samePortableFingerprint(left, right) {
    if (!left || !right) return false;
    var leftSize = portableNumber(left.size, true);
    var rightSize = portableNumber(right.size, true);
    var leftMtime = portableNumber(left.mtimeMs, false);
    var rightMtime = portableNumber(right.mtimeMs, false);
    return leftSize !== null
      && rightSize !== null
      && leftMtime !== null
      && rightMtime !== null
      && leftSize === rightSize
      && leftMtime === rightMtime;
  }

  function cleanupPathFor(sourcePath, transactionId) {
    var safeId = String(transactionId || "transaction").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "transaction";
    return String(sourcePath || "") + ".premiere-material-" + safeId + ".pending-delete";
  }

  async function verifyFileCopy(fs, sourcePath, targetPath, originalStat) {
    var sourceStat = await fs.lstat(sourcePath);
    var targetStat = await fs.lstat(targetPath);
    var expectedSize = statSize(originalStat);
    if (statSize(sourceStat) !== expectedSize || statSize(targetStat) !== expectedSize) {
      throw new Error("复制后的文件大小不一致");
    }
    if (!sameFingerprint(fingerprintFromStat(originalStat), fingerprintFromStat(sourceStat))) {
      throw new Error("复制期间源文件发生变化");
    }
    return expectedSize;
  }

  async function waitForVerifiedLink(projectItem, expectedPath, wait) {
    for (var attempt = 0; attempt < 10; attempt += 1) {
      try {
        var mediaPath = await projectItem.getMediaFilePath();
        var offline = await projectItem.isOffline();
        if (!offline && Core.samePath(mediaPath, expectedPath)) return true;
      } catch (error) {}
      if (attempt < 9) await wait(140);
    }
    return false;
  }

  async function relinkItem(projectItem, targetPath, wait) {
    var canChange = await projectItem.canChangeMediaPath();
    if (!canChange) throw new Error("Premiere 不允许修改其中一个素材的媒体路径");
    var relinked = await projectItem.changeMediaFilePath(targetPath, false);
    if (!relinked) throw new Error("Premiere 拒绝了媒体重链接");
    await projectItem.refreshMedia();
    if (!(await waitForVerifiedLink(projectItem, targetPath, wait))) {
      throw new Error("重链接后素材仍离线或路径不一致");
    }
  }

  async function relinkMany(projectItems, targetPath, wait, onEach) {
    for (var index = 0; index < projectItems.length; index += 1) {
      if (typeof onEach === "function") onEach(projectItems[index]);
      await relinkItem(projectItems[index], targetPath, wait);
    }
  }

  async function unlinkIfPresent(fs, nativePath) {
    if (!(await exists(fs, nativePath))) return;
    var result = await fs.unlink(nativePath);
    if (!successfulFsResult(result)) throw new Error("删除文件时返回了意外结果: " + result);
  }

  async function rename(fs, sourcePath, targetPath) {
    var result = await fs.rename(sourcePath, targetPath);
    if (!successfulFsResult(result)) throw new Error("移动文件时返回了意外结果: " + result);
  }

  function copyFileExclusiveFlag(fs) {
    return Number(fs && fs.constants && fs.constants.COPYFILE_EXCL) || 1;
  }

  function linkFallbackAllowed(error) {
    var code = String(error && error.code || "").toUpperCase();
    return code === "ENOSYS" || code === "ENOTSUP" || code === "EOPNOTSUPP" || code === "EXDEV" || code === "EPERM";
  }

  async function closeFileHandle(fs, handle) {
    var result;
    if (handle && typeof handle.close === "function") {
      result = await handle.close();
    } else if (typeof fs.close === "function") {
      result = await fs.close(handle);
    } else {
      throw new Error("当前文件接口无法关闭目标占位文件");
    }
    if (!successfulFsResult(result)) throw new Error("关闭目标占位文件时返回了意外结果: " + result);
  }

  async function renameTargetWithoutOverwrite(fs, sourcePath, targetPath, sourceStat, context) {
    if (typeof fs.open !== "function") throw new Error("当前文件接口不支持安全的同盘移动");
    var handle = await fs.open(targetPath, "wx");
    context.targetCreated = true;
    try {
      var reservedFingerprint = fingerprintFromStat(await fs.lstat(targetPath));
      if (statSize(reservedFingerprint) !== 0) throw new Error("目标文件名已被其他文件占用");
      context.targetFingerprint = reservedFingerprint;
    } finally {
      await closeFileHandle(fs, handle);
    }

    var currentReservation = fingerprintFromStat(await fs.lstat(targetPath));
    if (!context.targetFingerprint || !sameFingerprint(context.targetFingerprint, currentReservation)) {
      throw new Error("目标文件名在移动前发生变化，未覆盖");
    }

    context.targetMethod = "rename";
    var renameResult = await fs.rename(sourcePath, targetPath);
    if (!successfulFsResult(renameResult)) throw new Error("移动文件时返回了意外结果: " + renameResult);
    context.sourceMovedToTarget = true;
    var movedFingerprint = fingerprintFromStat(await fs.lstat(targetPath));
    if (!sameFileAfterRename(fingerprintFromStat(sourceStat), movedFingerprint)) {
      throw new Error("移动后目标文件身份校验失败");
    }
    context.targetFingerprint = movedFingerprint;
    return "rename";
  }

  async function createTargetWithoutOverwrite(fs, sourcePath, targetPath, sourceStat, context) {
    if (typeof fs.link === "function") {
      try {
        var linkResult = await fs.link(sourcePath, targetPath);
        context.targetCreated = true;
        if (!successfulFsResult(linkResult)) throw new Error("建立安全目标文件时返回了意外结果: " + linkResult);
        var linkedFingerprint = fingerprintFromStat(await fs.lstat(targetPath));
        if (!sameFileAfterRename(fingerprintFromStat(sourceStat), linkedFingerprint)) {
          throw new Error("建立目标文件后身份校验失败");
        }
        context.targetFingerprint = linkedFingerprint;
        return "link";
      } catch (error) {
        if (context.targetCreated || !linkFallbackAllowed(error)) throw error;
      }
    }

    return renameTargetWithoutOverwrite(fs, sourcePath, targetPath, sourceStat, context);
  }

  async function rollback(options, context) {
    var warnings = [];
    var sourceExists = await exists(options.fs, options.sourcePath);
    var targetExists = await exists(options.fs, options.targetPath);
    var canRelinkToSource = true;
    var preserveCreatedPayload = context.mode === "copy" || context.targetMethod === "link";

    if (context.mode === "rename" && context.targetMethod === "rename" && context.sourceMovedToTarget) {
      if (context.changedItems.length) {
        canRelinkToSource = false;
        warnings.push("整理未完成，已保持 Premiere 指向新位置，未自动恢复旧路径");
      } else if (sourceExists) {
        warnings.push("原路径已出现另一份文件，未自动移回素材");
        canRelinkToSource = false;
      } else if (!targetExists) {
        warnings.push("移动后的素材不在预期目标位置，无法自动回滚");
        canRelinkToSource = false;
      } else {
        var restoreContext = {
          targetCreated: false,
          targetFingerprint: null,
          sourceMovedToTarget: false,
        };
        try {
          var rollbackMovedFingerprint = fingerprintFromStat(await options.fs.lstat(options.targetPath));
          if (!context.targetFingerprint || !sameFileAfterRename(context.targetFingerprint, rollbackMovedFingerprint)) {
            throw new Error("移动后的素材身份发生变化");
          }
          await renameTargetWithoutOverwrite(
            options.fs,
            options.targetPath,
            options.sourcePath,
            await options.fs.lstat(options.targetPath),
            restoreContext
          );
          context.sourceMovedToTarget = false;
          context.targetCreated = false;
          context.targetFingerprint = null;
          sourceExists = true;
          targetExists = false;
        } catch (error) {
          canRelinkToSource = false;
          if (restoreContext.targetCreated && !restoreContext.sourceMovedToTarget && restoreContext.targetFingerprint) {
            try {
              var restoreReservationFingerprint = fingerprintFromStat(await options.fs.lstat(options.sourcePath));
              if (sameFingerprint(restoreContext.targetFingerprint, restoreReservationFingerprint)) {
                await unlinkIfPresent(options.fs, options.sourcePath);
              }
            } catch (cleanupError) {}
          }
          warnings.push("素材移回原路径失败: " + (error.message || error));
        }
      }
    }

    if (preserveCreatedPayload && context.changedItems.length) {
      canRelinkToSource = false;
      warnings.push("整理未完成，已保持 Premiere 指向新位置，未自动恢复旧路径");
    } else if (preserveCreatedPayload && (context.targetCreated || context.stagingCreated)) {
      warnings.push("整理未完成，已保留新位置的素材供检查");
    }

    if (sourceExists && canRelinkToSource && context.changedItems.length) {
      for (var index = 0; index < context.changedItems.length; index += 1) {
        try {
          await relinkItem(context.changedItems[index], options.sourcePath, options.wait || delay);
        } catch (error) {
          warnings.push("一个 Premiere 素材恢复原路径失败");
        }
      }
      if (typeof options.persistProject === "function") {
        try {
          if ((await options.persistProject()) === false) warnings.push("回滚后的工程保存失败");
        } catch (error) {
          warnings.push("回滚后的工程保存失败: " + (error.message || error));
        }
      }
    }

    if (context.targetCreated && sourceExists && targetExists && warnings.length === 0) {
      try {
        var rollbackTargetFingerprint = fingerprintFromStat(await options.fs.lstat(options.targetPath));
        if (!context.targetFingerprint || !sameFileAfterRename(context.targetFingerprint, rollbackTargetFingerprint)) {
          warnings.push("目标文件在回滚前发生变化，未自动删除");
        } else {
          await unlinkIfPresent(options.fs, options.targetPath);
        }
      } catch (error) {
        warnings.push("目标副本清理失败: " + (error.message || error));
      }
    }
    if (context.stagingCreated && !preserveCreatedPayload) {
      try {
        if (await exists(options.fs, context.stagingPath)) {
          var rollbackStagingFingerprint = fingerprintFromStat(await options.fs.lstat(context.stagingPath));
          if (!context.stagingFingerprint || !sameFileAfterRename(context.stagingFingerprint, rollbackStagingFingerprint)) {
            warnings.push("临时复制文件在回滚前发生变化，未自动删除");
          } else {
            await unlinkIfPresent(options.fs, context.stagingPath);
          }
        }
      } catch (error) {
        warnings.push("临时复制文件清理失败: " + (error.message || error));
      }
    }
    return warnings;
  }

  async function moveAndRelink(options) {
    var fs = options.fs;
    var projectItems = Array.isArray(options.projectItems) ? options.projectItems.filter(Boolean) : [];
    var wait = options.wait || delay;
    var cleanupWait = options.cleanupWait || wait;
    var sourcePath = options.sourcePath;
    var targetPath = options.targetPath;
    var stagingPath = options.stagingPath || targetPath + ".organizing-part";
    var cleanupPath = options.cleanupPath || cleanupPathFor(sourcePath, options.id);
    var context = {
      changedItems: [],
      mode: options.forceMode || "copy",
      stagingPath: stagingPath,
      cleanupPath: cleanupPath,
      stagingCreated: false,
      stagingFingerprint: null,
      targetCreated: false,
      targetFingerprint: null,
      targetMethod: "",
      sourceMovedToTarget: false,
      sourceFingerprint: null,
      modeEvidence: options.modeEvidence || null,
    };

    if (Core.isProjectFile(sourcePath) || Core.isProjectFile(targetPath)) {
      var projectFileError = new Error("Premiere 工程文件不允许进入素材整理事务");
      projectFileError.code = "MATERIAL_BATCH_PROJECT_FILE_BLOCKED";
      throw projectFileError;
    }
    if (options.deleteSource === false) {
      var retainError = new Error("素材整理只支持移动，不能保留原位置文件");
      retainError.code = "MATERIAL_BATCH_RETAIN_SOURCE_BLOCKED";
      throw retainError;
    }
    if (!projectItems.length) throw new Error("没有可重链接的 Premiere 素材项");
    if (
      !Core.isAbsoluteLocalPath(cleanupPath)
      || Core.samePath(cleanupPath, sourcePath)
      || !Core.samePath(Core.dirname(cleanupPath), Core.dirname(sourcePath))
    ) {
      throw new Error("待删除文件路径不安全");
    }

    try {
      await assertContext(options.validate);
      if (!(await exists(fs, sourcePath))) throw new Error("源文件不存在");
      if (await exists(fs, targetPath)) throw new Error("目标文件已存在，未覆盖");
      if (context.mode === "copy" && (await exists(fs, stagingPath))) throw new Error("发现未完成的临时文件，请先检查");
      if (await exists(fs, cleanupPath)) throw new Error("发现未完成的源文件清理，请先检查");

      var originalStat = await fs.lstat(sourcePath);
      if (!options.forceMode) {
        var resolvedMode = await resolveMoveMode(fs, sourcePath, Core.dirname(targetPath));
        context.mode = resolvedMode.mode;
        context.modeEvidence = resolvedMode;
      }
      var byteCount = statSize(originalStat);
      var sourceFingerprint = fingerprintFromStat(originalStat);
      var cleanupFingerprint = sourceFingerprint;
      context.sourceFingerprint = sourceFingerprint;
      for (var index = 0; index < projectItems.length; index += 1) {
        if (!(await projectItems[index].canChangeMediaPath())) {
          throw new Error("Premiere 不允许修改其中一个素材的媒体路径");
        }
      }

      await assertContext(options.validate);
      notify(options.onStage, context.mode === "rename" ? "move" : "copy", { byteCount: byteCount });
      if (context.mode === "rename") {
        context.targetMethod = await createTargetWithoutOverwrite(fs, sourcePath, targetPath, originalStat, context);
        if (context.targetMethod === "link") {
          cleanupFingerprint = fingerprintFromStat(await fs.lstat(sourcePath));
          if (!sameFileAfterRename(sourceFingerprint, cleanupFingerprint)) {
            throw new Error("建立目标文件时源文件发生变化");
          }
          context.sourceFingerprint = cleanupFingerprint;
        }
      } else {
        context.stagingCreated = true;
        var copyResult = await fs.copyFile(sourcePath, stagingPath, copyFileExclusiveFlag(fs));
        if (!successfulFsResult(copyResult)) throw new Error("复制文件时返回了意外结果: " + copyResult);
        await verifyFileCopy(fs, sourcePath, stagingPath, originalStat);
        var stagingStat = await fs.lstat(stagingPath);
        context.stagingFingerprint = fingerprintFromStat(stagingStat);
        context.targetMethod = await renameTargetWithoutOverwrite(fs, stagingPath, targetPath, stagingStat, context);
        context.sourceMovedToTarget = false;
        if (await exists(fs, stagingPath)) {
          throw new Error("临时文件路径在目标建立后被重新占用，已保留现场");
        }
        context.stagingCreated = false;
        context.stagingFingerprint = null;
      }

      await assertContext(options.validate);
      notify(options.onStage, "relink", { itemCount: projectItems.length });
      await relinkMany(projectItems, targetPath, wait, function (item) {
        context.changedItems.push(item);
      });

      await assertContext(options.validate);
      notify(options.onStage, "save", {});
      if (typeof options.persistProject !== "function") throw new Error("缺少 Premiere 工程保存步骤");
      if ((await options.persistProject()) === false) throw new Error("Premiere 工程保存失败");

      var cleanupPending = false;
      var cleanupWarning = "";
      var sourceChanged = false;
      var cleanupVerificationPending = false;
      if (!(context.mode === "rename" && context.targetMethod === "rename")) {
        notify(options.onStage, "cleanup", {});
        try {
          await assertContext(options.validate);
          var cleanupStat = await fs.lstat(sourcePath);
          if (!sameFingerprint(cleanupFingerprint, fingerprintFromStat(cleanupStat))) {
            sourceChanged = true;
            cleanupWarning = "原路径已出现另一份文件，未删除这份新文件";
          } else {
            await rename(fs, sourcePath, cleanupPath);
            var quarantinedFingerprint = fingerprintFromStat(await fs.lstat(cleanupPath));
            if (!sameFileAfterRename(sourceFingerprint, quarantinedFingerprint)) {
              if (await exists(fs, sourcePath)) throw new Error("原路径和待删除路径都出现了新文件，未执行删除");
              await rename(fs, cleanupPath, sourcePath);
              sourceChanged = true;
              cleanupWarning = "原路径已出现另一份文件，已恢复它且未执行删除";
            } else {
              await assertContext(options.validate);
              // 下载任务可能会在原路径被隔离后继续写入。
              // 等待一个可注入的稳定间隔；如果隔离文件在此期间发生变化，
              // 则拒绝删除该文件。
              var quarantineBeforeWait = quarantinedFingerprint;
              await cleanupWait(CLEANUP_SETTLING_MS);
              var quarantineAfterWait = fingerprintFromStat(await fs.lstat(cleanupPath));
              if (!samePortableFingerprint(quarantineBeforeWait, quarantineAfterWait)) {
                cleanupVerificationPending = true;
                throw new Error("待删除文件在稳定复核期间发生变化，未执行删除");
              }
              await assertContext(options.validate);
              var unlinkResult = await fs.unlink(cleanupPath);
              if (!successfulFsResult(unlinkResult)) throw new Error("删除文件时返回了意外结果: " + unlinkResult);
            }
          }
        } catch (error) {
          try {
            var sourceStillExists = await exists(fs, sourcePath);
            var cleanupStillExists = await exists(fs, cleanupPath);
            if (!sourceStillExists && !cleanupStillExists) {
              cleanupPending = cleanupVerificationPending;
              if (cleanupVerificationPending) {
                cleanupWarning = "待删除的原素材在稳定复核期间消失，未确认删除结果";
              }
            } else if (sourceStillExists && !cleanupStillExists) {
              var remainingFingerprint = fingerprintFromStat(await fs.lstat(sourcePath));
              if (!sameFingerprint(cleanupFingerprint, remainingFingerprint)) {
                sourceChanged = true;
                cleanupPending = false;
                cleanupWarning = "原路径已出现另一份文件，未删除这份新文件";
              } else {
                cleanupPending = true;
                cleanupWarning = "待删除的原素材仍在: " + sourcePath + "；" + (error.message || error);
              }
            } else {
              cleanupPending = true;
              cleanupWarning = "待删除的原素材仍在: " + cleanupPath + "；" + (error.message || error);
            }
          } catch (inspectionError) {
            cleanupPending = true;
            cleanupWarning = "无法确认原素材是否已经删除: " + (inspectionError.message || inspectionError);
          }
        }
      }

      var actualTargetFingerprint = fingerprintFromStat(await fs.lstat(targetPath));

      notify(options.onStage, "complete", { cleanupPending: cleanupPending });
      return {
        sourcePath: sourcePath,
        targetPath: targetPath,
        cleanupPath: cleanupPath,
        byteCount: byteCount,
        sourceFingerprint: sourceFingerprint,
        targetFingerprint: actualTargetFingerprint,
        mode: context.mode,
        modeEvidence: context.modeEvidence || null,
        sourceRetained: false,
        sourceChanged: sourceChanged,
        cleanupPending: cleanupPending,
        cleanupWarning: cleanupWarning,
      };
    } catch (error) {
      var rollbackWarnings = [];
      try {
        rollbackWarnings = await rollback(options, context);
      } catch (rollbackError) {
        rollbackWarnings.push("自动回滚检查失败: " + (rollbackError.message || rollbackError));
      }
      var wrapped = new Error(error && error.message ? error.message : String(error));
      wrapped.code = error && error.code ? error.code : "MATERIAL_BATCH_TRANSACTION_FAILED";
      wrapped.rollbackWarnings = rollbackWarnings;
      throw wrapped;
    }
  }

  async function relinkExisting(options) {
    var projectItems = Array.isArray(options.projectItems) ? options.projectItems.filter(Boolean) : [];
    var wait = options.wait || delay;
    await assertContext(options.validate);
    if (!(await exists(options.fs, options.targetPath))) throw new Error("整理后的目标文件不存在");
    var changedItems = [];
    try {
      await relinkMany(projectItems, options.targetPath, wait, function (item) { changedItems.push(item); });
      await assertContext(options.validate);
      if (typeof options.persistProject !== "function" || (await options.persistProject()) === false) {
        throw new Error("补链后的 Premiere 工程保存失败");
      }
      return { targetPath: options.targetPath, itemCount: changedItems.length };
    } catch (error) {
      if (changedItems.length) {
        var wrapped = new Error(error && error.message ? error.message : String(error));
        wrapped.code = error && error.code ? error.code : "MATERIAL_BATCH_RELINK_FAILED";
        wrapped.rollbackWarnings = ["补链未确认保存，已保持 Premiere 指向整理后的位置，未自动恢复旧路径"];
        throw wrapped;
      }
      throw error;
    }
  }

  return {
    exists: exists,
    moveAndRelink: moveAndRelink,
    relinkExisting: relinkExisting,
    cleanupPathFor: cleanupPathFor,
    fingerprintFromStat: fingerprintFromStat,
    sameFingerprint: sameFingerprint,
    sameFileAfterRename: sameFileAfterRename,
    samePortableFingerprint: samePortableFingerprint,
    cleanupSettlingMs: CLEANUP_SETTLING_MS,
    statMtime: statMtime,
    statSize: statSize,
    verifyFileCopy: verifyFileCopy,
    waitForVerifiedLink: waitForVerifiedLink,
    resolveMoveMode: resolveMoveMode,
  };
});
