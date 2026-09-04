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

  function userSafeFailureDetail(error, fallback) {
    var message = "";
    try { message = String(error && error.message || "").trim(); } catch (readError) {}
    var startsAsUserMessage = /^[“《（(]*[\u3400-\u9fff]/.test(message) || /^Premiere\s+[\u3400-\u9fff]/.test(message);
    var containsHostError = /\b(?:ERROR|FAIL(?:ED|URE)?|PERMISSION|DENIED|ACCESS|EEXIST|ENOENT|EACCES|EPERM|EIO|ENOSPC|EDQUOT|QUOTA|EXISTS?|NOT\s+FOUND|NO\s+SUCH|READ-?ONLY|SHARING\s+VIOLATION|LOCK\s+VIOLATION|DISK\s+FULL|DEVICE\s+NOT\s+READY)\b/i.test(message);
    return (startsAsUserMessage && !containsHostError)
      ? message
      : fallback;
  }

  function isBigIntLstatUnsupported(error) {
    if (!error) return false;
    var code = String(error.code || "").toUpperCase();
    if (["ERR_INVALID_ARG_TYPE", "ERR_INVALID_ARG_VALUE", "ERR_METHOD_NOT_IMPLEMENTED", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].indexOf(code) >= 0) return true;
    var message = "";
    try { message = String(error.message || ""); } catch (readError) {}
    return error instanceof TypeError || /bigint|unsupported|not supported|option|argument|参数|不支持/i.test(message);
  }

  // Node 的 Windows 文件身份可能超过 JS 安全整数范围。优先要求 bigint；
  // UXP 等只接受一个参数的接口则安全回退到普通 lstat，由指纹层拒绝不安全数字。
  async function lstatForIdentity(fs, nativePath) {
    if (!fs || typeof fs.lstat !== "function") throw new Error("当前文件接口不支持 lstat");
    try {
      return await fs.lstat(nativePath, { bigint: true });
    } catch (error) {
      if (!isBigIntLstatUnsupported(error)) throw error;
      return fs.lstat(nativePath);
    }
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
  // 此函数只选择候选模式；事务入口还会要求源文件具有有效 dev + ino，
  // 身份不足时会在复制、移动或删除之前停止。
  async function resolveMoveMode(fs, sourcePath, targetDirectory) {
    var sourceStat;
    var targetStat;
    try {
      sourceStat = await lstatForIdentity(fs, sourcePath);
      targetStat = await lstatForIdentity(fs, targetDirectory);
    } catch (error) {
      return { mode: "copy", proven: false, reason: "无法读取源文件或目标目录卷标识" };
    }
    var sourceDev = identityDecimal(sourceStat && sourceStat.dev);
    var targetDev = identityDecimal(targetStat && targetStat.dev);
    if (!sourceDev || !targetDev) {
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

  function identityDecimal(value) {
    if (typeof value === "bigint") {
      var bigintText = String(value);
      return /^\d+$/.test(bigintText) && bigintText !== "0" ? bigintText : null;
    }
    if (typeof value === "number") {
      return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
    }
    if (typeof value !== "string") return null;
    var normalized = value.trim();
    if (!/^\d+$/.test(normalized)) return null;
    normalized = normalized.replace(/^0+(?=\d)/, "");
    return normalized === "0" ? null : normalized;
  }

  function statIdentity(stat, field) {
    return identityDecimal(stat && stat[field]) || 0;
  }

  function fingerprintFromStat(stat) {
    return {
      size: statSize(stat),
      mtimeMs: statMtime(stat),
      ctimeMs: statCtime(stat),
      birthtimeMs: statBirthtime(stat),
      dev: statIdentity(stat, "dev"),
      ino: statIdentity(stat, "ino"),
    };
  }

  function sameAvailableIdentityNumber(left, right, field) {
    var leftValue = Number(left && left[field]);
    var rightValue = Number(right && right[field]);
    var leftAvailable = Number.isFinite(leftValue) && leftValue > 0;
    var rightAvailable = Number.isFinite(rightValue) && rightValue > 0;
    return !leftAvailable || !rightAvailable || leftValue === rightValue;
  }

  function sameAvailableIdentity(left, right, field) {
    var leftValue = identityDecimal(left && left[field]);
    var rightValue = identityDecimal(right && right[field]);
    return !leftValue || !rightValue || leftValue === rightValue;
  }

  function samePathFingerprint(left, right) {
    if (!samePortableFingerprint(left, right)) return false;
    return sameAvailableIdentityNumber(left, right, "ctimeMs")
      && sameAvailableIdentityNumber(left, right, "birthtimeMs")
      && sameAvailableIdentity(left, right, "dev")
      && sameAvailableIdentity(left, right, "ino");
  }

  function sameFingerprint(left, right) {
    return samePathFingerprint(left, right);
  }

  function sameFileAfterRename(left, right) {
    if (!samePortableFingerprint(left, right)) return false;
    return sameAvailableIdentityNumber(left, right, "birthtimeMs")
      && sameAvailableIdentity(left, right, "dev")
      && sameAvailableIdentity(left, right, "ino");
  }

  function sameHardLinkRecoveryFingerprint(left, right) {
    if (!samePortableFingerprint(left, right)) return false;
    var leftDev = identityDecimal(left && left.dev);
    var rightDev = identityDecimal(right && right.dev);
    var leftIno = identityDecimal(left && left.ino);
    var rightIno = identityDecimal(right && right.ino);
    return leftDev !== null
      && rightDev !== null
      && leftIno !== null
      && rightIno !== null
      && leftDev === rightDev
      && leftIno === rightIno
      && sameAvailableIdentityNumber(left, right, "birthtimeMs");
  }

  function hasHardLinkIdentity(fingerprint) {
    return identityDecimal(fingerprint && fingerprint.dev) !== null
      && identityDecimal(fingerprint && fingerprint.ino) !== null;
  }

  function hasStrongFileIdentity(fingerprint) {
    return samePortableFingerprint(fingerprint, fingerprint)
      && hasHardLinkIdentity(fingerprint);
  }

  function sameStrongPathFingerprint(left, right) {
    return hasHardLinkIdentity(left)
      && hasHardLinkIdentity(right)
      && samePathFingerprint(left, right);
  }

  function sameStrongFileAfterRename(left, right) {
    return hasHardLinkIdentity(left)
      && hasHardLinkIdentity(right)
      && sameFileAfterRename(left, right);
  }

  // 设备号和 inode 值无法跨卷使用，也无法用于复制后的文件。
  // 文件大小可以为零，但执行此项检查时两个字段都必须存在且为有限数值。
  function portableNumber(value, allowZero) {
    if (value === null || value === undefined || typeof value === "boolean"
      || (typeof value === "string" && !value.trim())) return null;
    var number = Number(value);
    if (!Number.isFinite(number)) return null;
    if ((allowZero && number < 0) || (!allowZero && number <= 0)) return null;
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
    var sourceStat = await lstatForIdentity(fs, sourcePath);
    var targetStat = await lstatForIdentity(fs, targetPath);
    var expectedSize = statSize(originalStat);
    if (statSize(sourceStat) !== expectedSize || statSize(targetStat) !== expectedSize) {
      throw new Error("复制后的文件大小不一致");
    }
    if (!sameStrongPathFingerprint(fingerprintFromStat(originalStat), fingerprintFromStat(sourceStat))) {
      throw new Error("复制期间源文件发生变化");
    }
    return expectedSize;
  }

  async function readLinkState(projectItem, expectedPath) {
    try {
      var mediaPath = await projectItem.getMediaFilePath();
      var offline = await projectItem.isOffline();
      return {
        readable: true,
        mediaPath: String(mediaPath || ""),
        offline: Boolean(offline),
        atTarget: !offline && Core.samePath(mediaPath, expectedPath),
      };
    } catch (error) {
      return { readable: false, mediaPath: "", offline: true, atTarget: false, error: error };
    }
  }

  async function waitForVerifiedLink(projectItem, expectedPath, wait) {
    for (var attempt = 0; attempt < 10; attempt += 1) {
      var state = await readLinkState(projectItem, expectedPath);
      if (state.atTarget) return true;
      if (attempt < 9) await wait(140);
    }
    return false;
  }

  async function assertTargetAndLinks(options, beforeDelete) {
    var targetPath = String(options.targetPath || "");
    var targetFingerprint = options.targetFingerprint;
    var projectItems = Array.isArray(options.projectItems) ? options.projectItems.filter(Boolean) : [];
    var wait = options.wait || delay;
    if (!Core.isAbsoluteLocalPath(targetPath) || !samePortableFingerprint(targetFingerprint, targetFingerprint)) {
      throw new Error("缺少可验证的新位置文件身份，未删除原素材");
    }
    if (!projectItems.length) throw new Error("缺少可核对的 Premiere 素材项，未删除原素材");

    async function verifyTarget(expectedFingerprint, allowHardLinkCtimeChange) {
      var targetStat = await lstatForIdentity(options.fs, targetPath);
      if (targetStat && typeof targetStat.isFile === "function" && !targetStat.isFile()) {
        throw new Error("新位置已不是单个文件，未删除原素材");
      }
      var currentFingerprint = fingerprintFromStat(targetStat);
      if (!sameStrongPathFingerprint(expectedFingerprint, currentFingerprint)
        && !(allowHardLinkCtimeChange && sameHardLinkRecoveryFingerprint(expectedFingerprint, currentFingerprint))) {
        throw new Error("新位置文件在删除原素材前发生变化，未删除原素材");
      }
      return currentFingerprint;
    }

    await assertContext(options.validate);
    var verifiedTargetFingerprint = await verifyTarget(
      targetFingerprint,
      options.allowHardLinkCtimeChange === true
    );
    for (var index = 0; index < projectItems.length; index += 1) {
      if (!(await waitForVerifiedLink(projectItems[index], targetPath, wait))) {
        throw new Error("Premiere 素材在删除原文件前未确认链接到新位置");
      }
    }
    if (typeof beforeDelete === "function") {
      var beforeDeleteResult = await beforeDelete(Object.assign({
        targetPath: targetPath,
        targetFingerprint: verifiedTargetFingerprint,
        projectItems: projectItems.slice(),
      }, options.beforeDeleteDetails || {}));
      if (beforeDeleteResult === false) throw new Error("删除前的最终核验未通过，未删除原素材");
    }
    await assertContext(options.validate);
    await verifyTarget(verifiedTargetFingerprint, false);
    for (var verifyIndex = 0; verifyIndex < projectItems.length; verifyIndex += 1) {
      var linkState = await readLinkState(projectItems[verifyIndex], targetPath);
      if (!linkState.atTarget) throw new Error("Premiere 素材链接在删除原文件前发生变化，未删除原素材");
    }
    await assertContext(options.validate);
    return verifyTarget(verifiedTargetFingerprint, false);
  }

  function pushUnique(list, item) {
    if (list.indexOf(item) < 0) list.push(item);
  }

  function relinkInterruptedError(message, cause) {
    var error = new Error(message);
    error.code = "MATERIAL_BATCH_RELINK_UNCERTAIN";
    error.cause = cause;
    return error;
  }

  async function relinkItem(projectItem, targetPath, wait, hooks) {
    var callbacks = hooks || {};
    var changed = false;
    function markChanged() {
      if (changed) return;
      changed = true;
      if (typeof callbacks.onChanged === "function") callbacks.onChanged(projectItem);
    }
    function markPossiblyChanged() {
      if (changed) return;
      if (typeof callbacks.onPossiblyChanged === "function") callbacks.onPossiblyChanged(projectItem);
    }
    function addWarning(message) {
      if (typeof callbacks.onWarning === "function") callbacks.onWarning(message);
    }

    async function assertStillAtExpectedSource() {
      var currentState = await readLinkState(projectItem, targetPath);
      if (!currentState.readable || !callbacks.sourcePath) {
        markPossiblyChanged();
        throw relinkInterruptedError(
          "Premiere 素材链接在改链前无法读取，未修改当前链接",
          currentState.error
        );
      }
      if (!Core.samePath(currentState.mediaPath, callbacks.sourcePath)) {
        markPossiblyChanged();
        var changedError = new Error("Premiere 素材链接在改链前已经变化，未覆盖用户当前链接");
        changedError.code = "MATERIAL_BATCH_RELINK_SOURCE_CHANGED";
        throw changedError;
      }
    }

    await assertStillAtExpectedSource();
    var canChange = await projectItem.canChangeMediaPath();
    if (!canChange) throw new Error("Premiere 不允许修改其中一个素材的媒体路径");
    await assertStillAtExpectedSource();
    var relinked = false;
    try {
      relinked = await projectItem.changeMediaFilePath(targetPath, false);
    } catch (changeError) {
      if (await waitForVerifiedLink(projectItem, targetPath, wait)) {
        markChanged();
        addWarning("Premiere 返回了异常，但已确认素材链接到新位置");
        return;
      }
      var changeState = await readLinkState(projectItem, targetPath);
      if (!changeState.readable || !callbacks.sourcePath || !Core.samePath(changeState.mediaPath, callbacks.sourcePath)) {
        markPossiblyChanged();
      }
      throw relinkInterruptedError("Premiere 修改媒体路径时中断，无法确认当前链接", changeError);
    }
    if (!relinked) {
      if (await waitForVerifiedLink(projectItem, targetPath, wait)) {
        markChanged();
        addWarning("Premiere 未返回成功结果，但已确认素材链接到新位置");
        return;
      }
      var rejectedState = await readLinkState(projectItem, targetPath);
      if (!rejectedState.readable || !callbacks.sourcePath || !Core.samePath(rejectedState.mediaPath, callbacks.sourcePath)) {
        markPossiblyChanged();
      }
      throw new Error("Premiere 拒绝了媒体重链接");
    }

    // 从此刻开始，即使 refreshMedia 或后续验证抛错，也不能再把它当作未改链。
    markChanged();
    try {
      await projectItem.refreshMedia();
    } catch (refreshError) {
      if (await waitForVerifiedLink(projectItem, targetPath, wait)) {
        addWarning("Premiere 刷新素材时返回了异常，但新位置和在线状态已经确认");
        return;
      }
      throw relinkInterruptedError("Premiere 刷新素材时中断，无法确认新位置", refreshError);
    }
    if (!(await waitForVerifiedLink(projectItem, targetPath, wait))) {
      throw new Error("重链接后素材仍离线或路径不一致");
    }
  }

  async function relinkMany(projectItems, targetPath, wait, hooks) {
    var callbacks = hooks || {};
    for (var index = 0; index < projectItems.length; index += 1) {
      await relinkItem(projectItems[index], targetPath, wait, callbacks);
    }
  }

  async function unlink(fs, nativePath) {
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
    var fields = [];
    ["code", "name", "errno", "message"].forEach(function (field) {
      try {
        if (error && error[field] != null) fields.push(String(error[field]));
      } catch (readError) {}
    });
    var description = fields.join(" ");
    var upper = description.toUpperCase();
    if (/(?:^|\s)(?:ENOSYS|ENOTSUP|EOPNOTSUPP|EXDEV|EPERM|ERR_METHOD_NOT_IMPLEMENTED)(?:\s|$)/.test(upper)) return true;
    return /(?:HARD\s*LINK|LINK)[^\n]*(?:UNSUPPORTED|NOT\s+SUPPORTED|NOT\s+IMPLEMENTED)|(?:UNSUPPORTED|NOT\s+SUPPORTED|NOT\s+IMPLEMENTED)[^\n]*(?:HARD\s*LINK|LINK)|\b(?:OPERATION|METHOD)\s+(?:IS\s+)?NOT\s+(?:SUPPORTED|IMPLEMENTED)\b|不支持[^\n]*硬链接|硬链接[^\n]*不支持/i.test(description);
  }

  function hardLinkUnavailableError(cause) {
    var error = new Error("当前文件系统不支持安全硬链接，将改用排他复制");
    error.code = "MATERIAL_BATCH_HARD_LINK_UNAVAILABLE";
    error.cause = cause;
    return error;
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
    if (typeof fs.link !== "function") throw new Error("当前文件接口不支持安全的同盘移动，未移动素材");
    var sourceFingerprint = fingerprintFromStat(sourceStat);
    if (!hasHardLinkIdentity(sourceFingerprint)) {
      throw new Error("文件系统未提供可验证的源文件身份，未移动素材");
    }
    var linkResult = await fs.link(sourcePath, targetPath);
    context.targetCreated = true;
    context.targetMethod = context.mode === "copy" ? "copy-link" : "link";
    if (!successfulFsResult(linkResult)) throw new Error("建立安全目标文件时返回了意外结果: " + linkResult);
    try {
      var linkedSourceFingerprint = fingerprintFromStat(await lstatForIdentity(fs, sourcePath));
      var linkedFingerprint = fingerprintFromStat(await lstatForIdentity(fs, targetPath));
      if (context.mode !== "copy") context.sourceFingerprint = linkedSourceFingerprint;
      context.targetFingerprint = linkedFingerprint;
      if (!sameStrongFileAfterRename(sourceFingerprint, linkedFingerprint)
        || !sameHardLinkRecoveryFingerprint(linkedSourceFingerprint, linkedFingerprint)) {
        throw new Error("建立目标文件后身份校验失败，已保留源文件");
      }
      await unlink(fs, sourcePath);
      context.sourceMovedToTarget = true;
      return context.mode === "copy" ? "copy-link" : "link";
    } catch (error) {
      // 只有确认目标仍是本次建立的同一硬链接时才允许回收目标。
      try {
        var currentTargetFingerprint = fingerprintFromStat(await lstatForIdentity(fs, targetPath));
        if (context.targetFingerprint && sameStrongPathFingerprint(context.targetFingerprint, currentTargetFingerprint)) {
          await unlink(fs, targetPath);
          context.targetCreated = false;
          context.targetFingerprint = null;
        }
      } catch (cleanupError) {}
      throw error;
    }
  }

  async function createTargetWithoutOverwrite(fs, sourcePath, targetPath, sourceStat, context) {
    var sourceFingerprint = fingerprintFromStat(sourceStat);
    if (!hasHardLinkIdentity(sourceFingerprint)) {
      throw new Error("文件系统未提供可验证的源文件身份，未移动素材");
    }
    if (typeof fs.link === "function") {
      try {
        var linkResult = await fs.link(sourcePath, targetPath);
        context.targetCreated = true;
        context.targetMethod = "link";
        if (!successfulFsResult(linkResult)) throw new Error("建立安全目标文件时返回了意外结果: " + linkResult);
        var linkedSourceFingerprint = fingerprintFromStat(await lstatForIdentity(fs, sourcePath));
        context.sourceFingerprint = linkedSourceFingerprint;
        var linkedFingerprint = fingerprintFromStat(await lstatForIdentity(fs, targetPath));
        context.targetFingerprint = linkedFingerprint;
        if (!sameFileAfterRename(sourceFingerprint, linkedFingerprint)) {
          throw new Error("建立目标文件后身份校验失败");
        }
        if (!sameHardLinkRecoveryFingerprint(linkedSourceFingerprint, linkedFingerprint)) {
          throw new Error("建立目标文件后无法证明它仍与源文件相同，已保留两处文件");
        }
        return "link";
      } catch (error) {
        if (context.targetCreated || !linkFallbackAllowed(error)) throw error;
        throw hardLinkUnavailableError(error);
      }
    }

    throw hardLinkUnavailableError();
  }

  async function copyTargetWithoutOverwrite(fs, sourcePath, targetPath, originalStat, context) {
    // COPYFILE_EXCL 是跨卷时唯一需要的发布门：目标已存在就失败，绝不覆盖。
    // 调用前先标记为可能已创建；若宿主在复制中途失败，回滚会保留未知目标供人工核对。
    context.targetCreated = true;
    var copyResult = await fs.copyFile(sourcePath, targetPath, copyFileExclusiveFlag(fs));
    if (!successfulFsResult(copyResult)) throw new Error("复制文件时返回了意外结果: " + copyResult);
    await verifyFileCopy(fs, sourcePath, targetPath, originalStat);
    var targetStat = await lstatForIdentity(fs, targetPath);
    if (targetStat && typeof targetStat.isFile === "function" && !targetStat.isFile()) {
      throw new Error("复制后的新位置不是单个文件");
    }
    context.targetFingerprint = fingerprintFromStat(targetStat);
    if (!hasStrongFileIdentity(context.targetFingerprint)) {
      throw new Error("复制后的新位置缺少可靠文件身份，已保留源文件");
    }
    context.targetMethod = "copy";
    return context.targetMethod;
  }

  async function rollback(options, context) {
    var warnings = [];
    var sourceExists = await exists(options.fs, options.sourcePath);
    var targetExists = await exists(options.fs, options.targetPath);
    var canRelinkToSource = true;
    var preserveCreatedPayload = context.mode === "copy" || context.targetMethod === "link";
    var linkChangeRiskCount = context.changedItems.length + context.possiblyChangedItems.length;

    if (context.mode === "rename" && context.targetMethod === "rename" && context.sourceMovedToTarget) {
      if (linkChangeRiskCount) {
        canRelinkToSource = false;
        warnings.push(context.possiblyChangedItems.length
          ? "整理未完成，无法确认 Premiere 当前链接；新位置文件已保留"
          : "整理未完成，已保持 Premiere 指向新位置，未自动恢复旧路径");
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
          var rollbackMovedFingerprint = fingerprintFromStat(await lstatForIdentity(options.fs, options.targetPath));
          if (!context.targetFingerprint || !sameStrongPathFingerprint(context.targetFingerprint, rollbackMovedFingerprint)) {
            throw new Error("移动后的素材身份发生变化");
          }
          await renameTargetWithoutOverwrite(
            options.fs,
            options.targetPath,
            options.sourcePath,
            await lstatForIdentity(options.fs, options.targetPath),
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
              var restoreReservationFingerprint = fingerprintFromStat(await lstatForIdentity(options.fs, options.sourcePath));
              if (sameStrongPathFingerprint(restoreContext.targetFingerprint, restoreReservationFingerprint)) {
                await unlink(options.fs, options.sourcePath);
              }
            } catch (cleanupError) {}
          }
          warnings.push("素材移回原路径失败；相关文件已保留，请人工检查新旧位置");
        }
      }
    }

    if (preserveCreatedPayload && linkChangeRiskCount) {
      canRelinkToSource = false;
      warnings.push(context.possiblyChangedItems.length
        ? "整理未完成，无法确认 Premiere 当前链接；新位置文件已保留"
        : "整理未完成，已保持 Premiere 指向新位置，未自动恢复旧路径");
    } else if (preserveCreatedPayload && (context.targetCreated || context.stagingCreated)) {
      var sourceStillOriginal = false;
      var stagingConflict = false;
      if (context.stagingCreated) {
        try { stagingConflict = await exists(options.fs, context.stagingPath); } catch (stagingCheckError) { stagingConflict = true; }
      }
      if (sourceExists && context.sourceFingerprint) {
        try {
          sourceStillOriginal = samePathFingerprint(
            context.sourceFingerprint,
            fingerprintFromStat(await lstatForIdentity(options.fs, options.sourcePath))
          );
        } catch (sourceCheckError) {}
      }
      if (stagingConflict || !sourceStillOriginal) warnings.push("整理未完成，已保留新位置的素材供检查");
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
          warnings.push("回滚后的工程保存失败；请人工确认 Premiere 当前素材链接");
        }
      }
    }

    if (context.targetCreated && sourceExists && targetExists && warnings.length === 0) {
      try {
        var rollbackTargetFingerprint = fingerprintFromStat(await lstatForIdentity(options.fs, options.targetPath));
        var rollbackTargetMatches = context.targetMethod === "link"
          ? sameHardLinkRecoveryFingerprint(context.targetFingerprint, rollbackTargetFingerprint)
          : sameStrongPathFingerprint(context.targetFingerprint, rollbackTargetFingerprint);
        if (!context.targetFingerprint || !rollbackTargetMatches) {
          warnings.push("目标文件在回滚前发生变化，未自动删除");
        } else {
          await unlink(options.fs, options.targetPath);
        }
      } catch (error) {
        warnings.push("目标副本清理失败；新位置文件已保留，请人工检查");
      }
    }
    if (context.stagingCreated && !preserveCreatedPayload) {
      try {
        if (await exists(options.fs, context.stagingPath)) {
      var rollbackStagingFingerprint = fingerprintFromStat(await lstatForIdentity(options.fs, context.stagingPath));
          if (!context.stagingFingerprint || !sameStrongPathFingerprint(context.stagingFingerprint, rollbackStagingFingerprint)) {
            warnings.push("临时复制文件在回滚前发生变化，未自动删除");
          } else {
            await unlink(options.fs, context.stagingPath);
          }
        }
      } catch (error) {
        warnings.push("临时复制文件清理失败；临时文件已保留，请人工检查");
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
      possiblyChangedItems: [],
      warnings: [],
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

      var originalStat = await lstatForIdentity(fs, sourcePath);
      if (!options.forceMode) {
        var resolvedMode = await resolveMoveMode(fs, sourcePath, Core.dirname(targetPath));
        context.mode = resolvedMode.mode;
        context.modeEvidence = resolvedMode;
      }
      var byteCount = statSize(originalStat);
      var sourceFingerprint = fingerprintFromStat(originalStat);
      if (!hasHardLinkIdentity(sourceFingerprint)) {
        throw new Error("文件系统未提供可验证的文件身份，未复制、移动或删除素材");
      }
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
        try {
          context.targetMethod = await createTargetWithoutOverwrite(fs, sourcePath, targetPath, originalStat, context);
        } catch (linkError) {
          if (!linkError || linkError.code !== "MATERIAL_BATCH_HARD_LINK_UNAVAILABLE") throw linkError;
          context.mode = "copy";
          context.modeEvidence = Object.assign({}, context.modeEvidence || {}, {
            mode: "copy",
            fallbackFrom: "rename",
            reason: "同卷不支持安全硬链接，已改用排他复制",
          });
          notify(options.onStage, "copy", { byteCount: byteCount });
          context.targetMethod = await copyTargetWithoutOverwrite(fs, sourcePath, targetPath, originalStat, context);
        }
        if (context.targetMethod === "link") {
          cleanupFingerprint = fingerprintFromStat(await lstatForIdentity(fs, sourcePath));
          if (!sameFileAfterRename(sourceFingerprint, cleanupFingerprint)) {
            throw new Error("建立目标文件时源文件发生变化");
          }
          context.sourceFingerprint = cleanupFingerprint;
        }
      } else {
        context.targetMethod = await copyTargetWithoutOverwrite(fs, sourcePath, targetPath, originalStat, context);
      }

      await assertContext(options.validate);
      if (typeof options.beforeRelink === "function") {
        await options.beforeRelink({
          targetFingerprint: context.targetFingerprint,
          sourceFingerprint: context.sourceFingerprint,
          targetMethod: context.targetMethod,
          mode: context.mode,
          modeEvidence: context.modeEvidence || null,
        });
      }
      await assertContext(options.validate);
      notify(options.onStage, "relink", { itemCount: projectItems.length });
      await relinkMany(projectItems, targetPath, wait, {
        sourcePath: sourcePath,
        onChanged: function (item) { pushUnique(context.changedItems, item); },
        onPossiblyChanged: function (item) { pushUnique(context.possiblyChangedItems, item); },
        onWarning: function (message) {
          if (context.warnings.indexOf(message) < 0) context.warnings.push(message);
        },
      });

      await assertContext(options.validate);
      notify(options.onStage, "save", {});
      if (typeof options.persistProject !== "function") throw new Error("缺少 Premiere 工程保存步骤");
      if ((await options.persistProject()) === false) throw new Error("Premiere 工程保存失败");
      await assertTargetAndLinks({
        fs: fs,
        targetPath: targetPath,
        targetFingerprint: context.targetFingerprint,
        projectItems: projectItems,
        validate: options.validate,
        wait: wait,
        allowHardLinkCtimeChange: context.targetMethod === "link",
      });

      var cleanupPending = false;
      var cleanupWarning = "";
      var sourceChanged = false;
      var remainingSourcePath = "";
      var cleanupVerificationPending = false;
      if (!(context.mode === "rename" && context.targetMethod === "rename")) {
        notify(options.onStage, "cleanup", {});
        try {
          await assertContext(options.validate);
          var cleanupStat = await lstatForIdentity(fs, sourcePath);
          if (!sameStrongPathFingerprint(cleanupFingerprint, fingerprintFromStat(cleanupStat))) {
            sourceChanged = true;
            remainingSourcePath = sourcePath;
            cleanupWarning = "原路径已出现另一份文件，未删除这份新文件";
          } else {
            if (typeof options.beforeSourceCleanup === "function") {
              var beforeCleanupResult = await options.beforeSourceCleanup({
                id: options.id,
                sourcePath: sourcePath,
                targetPath: targetPath,
                cleanupPath: cleanupPath,
                sourceFingerprint: cleanupFingerprint,
                targetFingerprint: context.targetFingerprint,
                targetMethod: context.targetMethod,
                projectItems: projectItems.slice(),
              });
              if (beforeCleanupResult === false) {
                throw new Error("移出原位置前的最终核验未通过，未移动或删除原素材");
              }
              await assertContext(options.validate);
              cleanupStat = await lstatForIdentity(fs, sourcePath);
              if (!sameStrongPathFingerprint(cleanupFingerprint, fingerprintFromStat(cleanupStat))) {
                throw new Error("原素材在移出原位置前发生变化，未移动或删除原素材");
              }
            }
            if (await exists(fs, cleanupPath)) {
              throw new Error("待删除位置已被其他文件占用，未移动或删除原素材");
            }
            await rename(fs, sourcePath, cleanupPath);
            var quarantinedFingerprint = fingerprintFromStat(await lstatForIdentity(fs, cleanupPath));
            if (!sameStrongFileAfterRename(sourceFingerprint, quarantinedFingerprint)) {
              if (await exists(fs, sourcePath)) throw new Error("原路径和待删除路径都出现了新文件，未执行删除");
              await rename(fs, cleanupPath, sourcePath);
              sourceChanged = true;
              remainingSourcePath = sourcePath;
              cleanupWarning = "原路径已出现另一份文件，已恢复它且未执行删除";
            } else {
              if (context.targetMethod === "link") {
                var linkedTargetFingerprint = fingerprintFromStat(await lstatForIdentity(fs, targetPath));
                if (!sameFileAfterRename(quarantinedFingerprint, linkedTargetFingerprint)) {
                  throw new Error("同盘目标文件身份在原位置隔离后发生变化，未执行删除");
                }
                // 重命名同一 inode 的另一条硬链接会合法更新 ctime；从此刻继续使用新检查点。
                context.targetFingerprint = linkedTargetFingerprint;
              }
              await assertContext(options.validate);
              // 下载任务可能会在原路径被隔离后继续写入。
              // 等待一个可注入的稳定间隔；如果隔离文件在此期间发生变化，
              // 则拒绝删除该文件。
              var quarantineBeforeWait = quarantinedFingerprint;
              await cleanupWait(CLEANUP_SETTLING_MS);
              var quarantineAfterWait = fingerprintFromStat(await lstatForIdentity(fs, cleanupPath));
              if (!sameStrongPathFingerprint(quarantineBeforeWait, quarantineAfterWait)) {
                cleanupVerificationPending = true;
                throw new Error("待删除文件在稳定复核期间发生变化，未执行删除");
              }
              await assertTargetAndLinks({
                fs: fs,
                targetPath: targetPath,
                targetFingerprint: context.targetFingerprint,
                projectItems: projectItems,
                validate: options.validate,
                wait: wait,
                beforeDeleteDetails: {
                  id: options.id,
                  sourcePath: sourcePath,
                  cleanupPath: cleanupPath,
                  quarantinedFingerprint: quarantineAfterWait,
                  targetMethod: context.targetMethod,
                },
              }, options.beforeDelete);
              var quarantineBeforeDelete = fingerprintFromStat(await lstatForIdentity(fs, cleanupPath));
              if (!sameStrongPathFingerprint(quarantineAfterWait, quarantineBeforeDelete)) {
                throw new Error("待删除文件在最终核验期间发生变化，未执行删除");
              }
              var targetBeforeUnlinkFingerprint = fingerprintFromStat(await lstatForIdentity(fs, targetPath));
              if (!sameStrongPathFingerprint(context.targetFingerprint, targetBeforeUnlinkFingerprint)) {
                throw new Error("新位置文件在最终删除前发生变化，未执行删除");
              }
              cleanupVerificationPending = true;
              var unlinkResult = await fs.unlink(cleanupPath);
              if (!successfulFsResult(unlinkResult)) throw new Error("删除文件时返回了意外结果: " + unlinkResult);
              var targetAfterUnlinkFingerprint = fingerprintFromStat(await lstatForIdentity(fs, targetPath));
              var targetStillSame = context.targetMethod === "link"
                ? sameHardLinkRecoveryFingerprint(targetBeforeUnlinkFingerprint, targetAfterUnlinkFingerprint)
                : sameStrongPathFingerprint(targetBeforeUnlinkFingerprint, targetAfterUnlinkFingerprint);
              if (!targetStillSame) throw new Error("删除原位置后无法确认新位置仍是同一文件");
              context.targetFingerprint = targetAfterUnlinkFingerprint;
              cleanupVerificationPending = false;
            }
          }
        } catch (error) {
          try {
            var sourceStillExists = await exists(fs, sourcePath);
            var cleanupStillExists = await exists(fs, cleanupPath);
            if (!sourceStillExists && !cleanupStillExists) {
              cleanupPending = cleanupVerificationPending;
              if (cleanupVerificationPending) {
                cleanupWarning = "原素材已移出，但删除后的新位置核验没有完成";
              }
            } else if (sourceStillExists && !cleanupStillExists) {
              var remainingFingerprint = fingerprintFromStat(await lstatForIdentity(fs, sourcePath));
              if (!sameStrongPathFingerprint(cleanupFingerprint, remainingFingerprint)) {
                sourceChanged = true;
                remainingSourcePath = sourcePath;
                cleanupPending = false;
                cleanupWarning = "原路径已出现另一份文件，未删除这份新文件";
              } else {
                cleanupPending = true;
                remainingSourcePath = sourcePath;
                cleanupWarning = "待删除的原素材仍在：" + sourcePath + "；"
                  + userSafeFailureDetail(error, "请人工检查后重新处理");
              }
            } else {
              cleanupPending = true;
              remainingSourcePath = cleanupPath;
              cleanupWarning = "待删除的原素材仍在：" + cleanupPath + "；"
                + userSafeFailureDetail(error, "请人工检查后重新处理");
            }
          } catch (inspectionError) {
            cleanupPending = true;
            cleanupWarning = "无法确认原素材是否已经删除；相关文件已保留，请人工检查";
          }
        }
      }

      var actualTargetFingerprint = fingerprintFromStat(await lstatForIdentity(fs, targetPath));

      notify(options.onStage, "complete", { cleanupPending: cleanupPending });
      return {
        sourcePath: sourcePath,
        targetPath: targetPath,
        cleanupPath: cleanupPath,
        byteCount: byteCount,
        sourceFingerprint: context.sourceFingerprint || sourceFingerprint,
        targetFingerprint: actualTargetFingerprint,
        targetMethod: context.targetMethod,
        mode: context.mode,
        modeEvidence: context.modeEvidence || null,
        sourceRetained: false,
        sourceChanged: sourceChanged,
        cleanupPending: cleanupPending,
        cleanupWarning: cleanupWarning,
        remainingSourcePath: remainingSourcePath,
        warnings: context.warnings.slice(),
      };
    } catch (error) {
      var rollbackWarnings = [];
      try {
        rollbackWarnings = await rollback(options, context);
      } catch (rollbackError) {
        rollbackWarnings.push("自动回滚检查失败；相关文件已保留，请人工检查新旧位置和 Premiere 素材链接");
      }
      var wrapped = new Error(error && error.message ? error.message : String(error));
      wrapped.code = error && error.code ? error.code : "MATERIAL_BATCH_TRANSACTION_FAILED";
      wrapped.cause = error;
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
    var possiblyChangedItems = [];
    var warnings = [];
    try {
      await relinkMany(projectItems, options.targetPath, wait, {
        sourcePath: options.sourcePath,
        onChanged: function (item) { pushUnique(changedItems, item); },
        onPossiblyChanged: function (item) { pushUnique(possiblyChangedItems, item); },
        onWarning: function (message) {
          if (warnings.indexOf(message) < 0) warnings.push(message);
        },
      });
      await assertContext(options.validate);
      if (typeof options.persistProject !== "function" || (await options.persistProject()) === false) {
        throw new Error("补链后的 Premiere 工程保存失败");
      }
      return { targetPath: options.targetPath, itemCount: changedItems.length, warnings: warnings };
    } catch (error) {
      if (changedItems.length || possiblyChangedItems.length) {
        var wrapped = new Error(error && error.message ? error.message : String(error));
        wrapped.code = error && error.code ? error.code : "MATERIAL_BATCH_RELINK_FAILED";
        wrapped.cause = error;
        wrapped.rollbackWarnings = [possiblyChangedItems.length
          ? "补链未确认完成，无法确认 Premiere 当前链接；没有自动恢复旧路径"
          : "补链未确认保存，已保持 Premiere 指向整理后的位置，未自动恢复旧路径"];
        throw wrapped;
      }
      throw error;
    }
  }

  async function cleanupVerifiedSource(options) {
    var fs = options.fs;
    var sourcePath = String(options.sourcePath || "");
    var cleanupPath = String(options.cleanupPath || cleanupPathFor(sourcePath, options.id));
    var sourceFingerprint = options.sourceFingerprint;
    var cleanupWait = options.cleanupWait || options.wait || delay;
    var result = {
      cleanupPending: false,
      cleanupWarning: "",
      sourceChanged: false,
      remainingSourcePath: "",
      targetFingerprint: options.targetFingerprint || null,
      targetMethod: String(options.targetMethod || ""),
    };

    if (Core.isProjectFile(sourcePath)) throw new Error("Premiere 工程文件不允许进入源文件清理");
    if (
      !Core.isAbsoluteLocalPath(sourcePath)
      || !Core.isAbsoluteLocalPath(cleanupPath)
      || Core.samePath(cleanupPath, sourcePath)
      || !Core.samePath(Core.dirname(cleanupPath), Core.dirname(sourcePath))
    ) {
      throw new Error("待删除文件路径不安全");
    }
    if (!sourceFingerprint || !Number.isFinite(Number(sourceFingerprint.size))) {
      throw new Error("缺少可验证的源文件身份，未清理原位置文件");
    }
    if (!Core.isAbsoluteLocalPath(options.targetPath)
      || !samePortableFingerprint(options.targetFingerprint, options.targetFingerprint)
      || !Array.isArray(options.projectItems)
      || !options.projectItems.filter(Boolean).length) {
      throw new Error("缺少删除前的新位置或 Premiere 链接证据，未清理原位置文件");
    }

    await assertContext(options.validate);
    var sourceExists = await exists(fs, sourcePath);
    var cleanupExists = await exists(fs, cleanupPath);
    async function refreshRecordedTarget(allowHardLinkCtimeChange) {
      var currentTargetFingerprint = fingerprintFromStat(await lstatForIdentity(fs, options.targetPath));
      if (!sameStrongPathFingerprint(options.targetFingerprint, currentTargetFingerprint)
        && !(allowHardLinkCtimeChange
          && sameHardLinkRecoveryFingerprint(options.targetFingerprint, currentTargetFingerprint))) {
        throw new Error("新位置文件与整理记录不一致");
      }
      result.targetFingerprint = currentTargetFingerprint;
      return currentTargetFingerprint;
    }
    if (!sourceExists && !cleanupExists) {
      await refreshRecordedTarget(result.targetMethod === "link");
      return result;
    }
    if (sourceExists && cleanupExists) {
      result.cleanupPending = true;
      result.cleanupWarning = "原位置和待删除位置同时存在文件，未自动删除";
      result.remainingSourcePath = cleanupPath;
      return result;
    }

    if (sourceExists) {
      var currentSourceFingerprint = fingerprintFromStat(await lstatForIdentity(fs, sourcePath));
      if (!hasHardLinkIdentity(sourceFingerprint) || !hasHardLinkIdentity(currentSourceFingerprint)) {
        result.cleanupPending = true;
        result.cleanupWarning = "文件系统未提供可验证的原素材身份，未自动删除";
        result.remainingSourcePath = sourcePath;
        return result;
      }
      if (!sameStrongPathFingerprint(sourceFingerprint, currentSourceFingerprint)
        && !(result.targetMethod === "link"
          && sameHardLinkRecoveryFingerprint(sourceFingerprint, currentSourceFingerprint))) {
        await refreshRecordedTarget(result.targetMethod === "link");
        result.sourceChanged = true;
        result.remainingSourcePath = sourcePath;
        result.cleanupWarning = "原路径已出现另一份文件，未删除这份新文件";
        return result;
      }
      sourceFingerprint = currentSourceFingerprint;
      try {
        if (typeof options.beforeSourceCleanup === "function") {
          var beforeCleanupResult = await options.beforeSourceCleanup({
            id: options.id,
            sourcePath: sourcePath,
            targetPath: options.targetPath,
            cleanupPath: cleanupPath,
            sourceFingerprint: sourceFingerprint,
            targetFingerprint: options.targetFingerprint,
            targetMethod: result.targetMethod,
            projectItems: options.projectItems.filter(Boolean),
          });
          if (beforeCleanupResult === false) {
            throw new Error("移出原位置前的最终核验未通过");
          }
          await assertContext(options.validate);
          currentSourceFingerprint = fingerprintFromStat(await lstatForIdentity(fs, sourcePath));
          if (!sameStrongPathFingerprint(sourceFingerprint, currentSourceFingerprint)) {
            throw new Error("原素材在移出原位置前发生变化");
          }
        }
        if (await exists(fs, cleanupPath)) {
          throw new Error("待删除位置已被其他文件占用");
        }
        await rename(fs, sourcePath, cleanupPath);
        cleanupExists = true;
      } catch (renameError) {
        result.cleanupPending = true;
        result.cleanupWarning = "原素材暂时无法移出原位置，未自动删除";
        result.remainingSourcePath = sourcePath;
        return result;
      }
    }

    var quarantinedFingerprint;
    try {
      quarantinedFingerprint = fingerprintFromStat(await lstatForIdentity(fs, cleanupPath));
    } catch (readError) {
      result.cleanupPending = true;
      result.cleanupWarning = "无法核对待删除的原素材，未自动删除";
      result.remainingSourcePath = cleanupPath;
      return result;
    }
    if (!sameStrongFileAfterRename(sourceFingerprint, quarantinedFingerprint)) {
      result.cleanupPending = true;
      result.cleanupWarning = "待删除文件与原素材身份不一致，未自动删除";
      result.remainingSourcePath = cleanupPath;
      return result;
    }

    var cleanupTargetFingerprint;
    try {
      cleanupTargetFingerprint = await refreshRecordedTarget(result.targetMethod === "link");
    } catch (targetError) {
      result.cleanupPending = true;
      result.cleanupWarning = "新位置文件与整理记录不一致，未自动删除原素材";
      result.remainingSourcePath = cleanupPath;
      return result;
    }

    try {
      await assertContext(options.validate);
      await cleanupWait(CLEANUP_SETTLING_MS);
      var afterWaitFingerprint = fingerprintFromStat(await lstatForIdentity(fs, cleanupPath));
      if (!sameStrongPathFingerprint(quarantinedFingerprint, afterWaitFingerprint)) {
        throw new Error("待删除文件在稳定复核期间发生变化");
      }
      await assertTargetAndLinks({
        fs: fs,
        targetPath: options.targetPath,
        targetFingerprint: cleanupTargetFingerprint,
        projectItems: options.projectItems,
        validate: options.validate,
        wait: options.wait,
        beforeDeleteDetails: {
          id: options.id,
          sourcePath: sourcePath,
          cleanupPath: cleanupPath,
          quarantinedFingerprint: afterWaitFingerprint,
          targetMethod: result.targetMethod,
        },
      }, options.beforeDelete);
      var cleanupBeforeDeleteFingerprint = fingerprintFromStat(await lstatForIdentity(fs, cleanupPath));
      if (!sameStrongPathFingerprint(afterWaitFingerprint, cleanupBeforeDeleteFingerprint)) {
        throw new Error("待删除文件在最终核验期间发生变化");
      }
      var targetBeforeCleanupUnlink = fingerprintFromStat(await lstatForIdentity(fs, options.targetPath));
      if (!sameStrongPathFingerprint(cleanupTargetFingerprint, targetBeforeCleanupUnlink)) {
        throw new Error("新位置文件在最终删除前发生变化");
      }
      var cleanupUnlinkResult = await fs.unlink(cleanupPath);
      if (!successfulFsResult(cleanupUnlinkResult)) throw new Error("删除文件时返回了意外结果: " + cleanupUnlinkResult);
      var targetAfterCleanupUnlink = fingerprintFromStat(await lstatForIdentity(fs, options.targetPath));
      var cleanupTargetStillSame = result.targetMethod === "link"
        ? sameHardLinkRecoveryFingerprint(targetBeforeCleanupUnlink, targetAfterCleanupUnlink)
        : sameStrongPathFingerprint(targetBeforeCleanupUnlink, targetAfterCleanupUnlink);
      if (!cleanupTargetStillSame) throw new Error("删除原位置后无法确认新位置仍是同一文件");
      result.targetFingerprint = targetAfterCleanupUnlink;
    } catch (cleanupError) {
      var cleanupStillPresent = true;
      try { cleanupStillPresent = await exists(fs, cleanupPath); } catch (cleanupInspectionError) {}
      result.cleanupPending = true;
      result.cleanupWarning = cleanupStillPresent
        ? "待删除的原素材仍在，未自动删除"
        : "原素材已移出，但删除后的新位置核验没有完成";
      result.remainingSourcePath = cleanupStillPresent ? cleanupPath : "";
      return result;
    }

    if (await exists(fs, sourcePath)) {
      result.sourceChanged = true;
      result.remainingSourcePath = sourcePath;
      result.cleanupWarning = "清理期间原路径出现了另一份文件，未触碰这份新文件";
    }
    return result;
  }

  return {
    exists: exists,
    moveAndRelink: moveAndRelink,
    relinkExisting: relinkExisting,
    cleanupVerifiedSource: cleanupVerifiedSource,
    cleanupPathFor: cleanupPathFor,
    lstatForIdentity: lstatForIdentity,
    fingerprintFromStat: fingerprintFromStat,
    hasStrongFileIdentity: hasStrongFileIdentity,
    sameFingerprint: sameFingerprint,
    samePathFingerprint: samePathFingerprint,
    sameFileAfterRename: sameFileAfterRename,
    sameHardLinkRecoveryFingerprint: sameHardLinkRecoveryFingerprint,
    sameStrongPathFingerprint: sameStrongPathFingerprint,
    samePortableFingerprint: samePortableFingerprint,
    cleanupSettlingMs: CLEANUP_SETTLING_MS,
    statMtime: statMtime,
    statSize: statSize,
    verifyFileCopy: verifyFileCopy,
    waitForVerifiedLink: waitForVerifiedLink,
    resolveMoveMode: resolveMoveMode,
  };
});
