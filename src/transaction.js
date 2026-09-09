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
    if (error && error.code === "MATERIAL_RECYCLE_LAUNCH_FAILED") return "本地文件助手未运行或正在忙，原件保留；运行插件安装器可修复助手";
    if (error && error.code === "MATERIAL_RECYCLE_NOT_COMMITTED") return "系统回收助手未响应，未提交回收，原件保留";
    if (error && error.code === "MATERIAL_RECYCLE_CANCELLED") return "回收请求已取消，原件保留";
    if (error && error.code === "MATERIAL_RECYCLE_REQUEST_EXISTS") return "上次回收请求尚未核对，未重复提交；需要先核对请求状态";
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

  function snapshotStat(stat) {
    var snapshot = { size: stat.size, mtimeMs: statMtime(stat), ctimeMs: statCtime(stat),
      birthtimeMs: statBirthtime(stat), dev: stat.dev, ino: stat.ino };
    // UXP 类型方法依赖原生接收对象，不能在 Object.create(stat) 的包装上调用。
    ["isFile", "isDirectory", "isSymbolicLink"].forEach(function (name) {
      if (typeof stat[name] !== "function") return;
      var result = stat[name]();
      snapshot[name] = function () { return result; };
    });
    return snapshot;
  }

  // Node 使用 bigint；已知 UXP 接口只传支持的单参数，不以原生异常探测能力。
  async function lstatForIdentity(fs, nativePath) {
    if (!fs || typeof fs.lstat !== "function") throw new Error("当前文件接口不支持 lstat");
    var stat;
    try {
      stat = fs.lstatSupportsBigInt === false
        ? await fs.lstat(nativePath) : await fs.lstat(nativePath, { bigint: true });
    } catch (error) {
      if (!isBigIntLstatUnsupported(error)) throw error;
      stat = await fs.lstat(nativePath);
    }
    if (stat && typeof stat.isFile === "function" && stat.isFile() && !identityDecimal(stat.ino) && typeof fs.materialIdentity === "function") {
      var before = snapshotStat(stat);
      var native = await fs.materialIdentity(nativePath);
      var after = snapshotStat(await fs.lstat(nativePath));
      if (typeof after.isFile !== "function" || !after.isFile()
        || Number(native.size) !== statSize(before) || Number(native.size) !== statSize(after)
        || Math.floor(statMtime(before)) !== Number(native.mtimeMs) || Math.floor(statMtime(after)) !== Number(native.mtimeMs)
        || statCtime(before) !== statCtime(after) || statBirthtime(before) !== statBirthtime(after)
        || String(after.dev) !== String(native.dev) || Number(after.ino) !== Number(native.ino))
        throw new Error("读取精确文件身份期间素材发生变化，未继续处理");
      ["size", "mtimeMs", "birthtimeMs", "dev", "ino"].forEach(function (key) {
        after[key] = native[key];
      });
      return after;
    }
    return stat;
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
    if ((await readLinkState(projectItem, targetPath)).atTarget) return;
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
      var deferRelink = options.deferSaveAndCleanup === true && typeof options.shouldDeferRelink === "function"
        && await options.shouldDeferRelink();
      if (!deferRelink) {
      notify(options.onStage, "relink", { itemCount: projectItems.length });
      await relinkMany(projectItems, targetPath, wait, {
        sourcePath: sourcePath,
        onChanged: function (item) { pushUnique(context.changedItems, item); },
        onPossiblyChanged: function (item) { pushUnique(context.possiblyChangedItems, item); },
        onWarning: function (message) {
          if (context.warnings.indexOf(message) < 0) context.warnings.push(message);
        },
      });
      }

      await assertContext(options.validate);
      if (options.deferSaveAndCleanup === true) {
        if (!deferRelink) await assertTargetAndLinks({
          fs: fs, targetPath: targetPath, targetFingerprint: context.targetFingerprint,
          projectItems: projectItems, validate: options.validate, wait: wait,
          allowHardLinkCtimeChange: context.targetMethod === "link",
        });
        return {
          awaitingProjectSave: true, sourceRetained: true, sourcePath: sourcePath, targetPath: targetPath,
          linksReady: !deferRelink,
          cleanupPath: cleanupPath, byteCount: byteCount, sourceFingerprint: context.sourceFingerprint,
          targetFingerprint: context.targetFingerprint, targetMethod: context.targetMethod,
          mode: context.mode, modeEvidence: context.modeEvidence, warnings: context.warnings.slice(),
        };
      }
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
      {
        var recycled = await recycleVerifiedSource(Object.assign({}, options, {
          sourceFingerprint: cleanupFingerprint,
          targetFingerprint: context.targetFingerprint,
          targetMethod: context.targetMethod,
          projectItems: projectItems,
        }));
        cleanupPending = recycled.cleanupPending;
        cleanupWarning = recycled.cleanupWarning;
        remainingSourcePath = recycled.remainingSourcePath;
        sourceChanged = recycled.sourceChanged;
        context.targetFingerprint = recycled.targetFingerprint;
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
        cleanupFailure: recycled.cleanupFailure || null,
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
    return recycleVerifiedSource(options);
  }
  async function recycleVerifiedSource(options) {
    var result = { cleanupPending: true, cleanupWarning: "", remainingSourcePath: options.sourcePath,
      sourceChanged: false, targetFingerprint: options.targetFingerprint, targetMethod: options.targetMethod };
    try {
      if (typeof options.recycle !== "function") throw new Error("回收站助手不可用，原文件保留；不会永久删除");
      var sourcePath = options.sourcePath;
      if (!Core.isAbsoluteLocalPath(sourcePath) || !Core.isAbsoluteLocalPath(options.targetPath)
        || Core.samePath(sourcePath, options.targetPath)) throw new Error("回收源和目标路径无效");
      if (options.cleanupPath) {
        if (!Core.isAbsoluteLocalPath(options.cleanupPath) || Core.samePath(sourcePath, options.cleanupPath)
          || !Core.samePath(Core.dirname(sourcePath), Core.dirname(options.cleanupPath))) throw new Error("旧待处理路径不安全");
        if (await exists(options.fs, options.cleanupPath)) {
          if (await exists(options.fs, sourcePath)) throw new Error("原位置与旧待处理位置同时存在，不能唯一确认原素材");
          sourcePath = options.cleanupPath;
        }
      }
      result.remainingSourcePath = sourcePath;
      if (Core.isProjectFile(sourcePath)) throw new Error("不能回收工程文件");
      var sourceExists = await exists(options.fs, sourcePath);
      var source = sourceExists ? fingerprintFromStat(await lstatForIdentity(options.fs, sourcePath)) : options.sourceFingerprint;
      var sameSource = Core.samePath(sourcePath, options.sourcePath)
        ? sameStrongPathFingerprint(options.sourceFingerprint, source)
        : sameFileAfterRename(options.sourceFingerprint, source);
      if (!sameSource && !(options.targetMethod === "link" && sameHardLinkRecoveryFingerprint(options.sourceFingerprint, source))) {
        result.sourceChanged = true;
        throw new Error("原文件身份已变化，未回收");
      }
      await assertContext(options.validate);
      var details = { id: options.id, sourcePath: options.sourcePath, cleanupPath: sourcePath,
        targetPath: options.targetPath, sourceFingerprint: source, targetFingerprint: options.targetFingerprint,
        targetMethod: options.targetMethod, projectItems: options.projectItems || [] };
      if (options.beforeSourceCleanup && await options.beforeSourceCleanup(details) === false) throw new Error("回收前工程引用核验未通过");
      await (options.cleanupWait || options.wait || delay)(CLEANUP_SETTLING_MS);
      await assertContext(options.validate);
      await assertTargetAndLinks(Object.assign({}, options, { allowHardLinkCtimeChange: options.targetMethod === "link", beforeDeleteDetails: details }), options.beforeDelete);
      if (sourceExists && !sameStrongPathFingerprint(source, fingerprintFromStat(await lstatForIdentity(options.fs, sourcePath)))) {
        result.sourceChanged = true;
        throw new Error("回收前原文件身份或内容已变化");
      }
      var receipt = await options.recycle({ id: options.id, path: sourcePath, targetPath: options.targetPath,
        sourceFingerprint: source, targetFingerprint: options.targetFingerprint });
      if (!receipt || receipt.status !== "recycled" || receipt.path !== sourcePath || !receipt.receiptId) throw new Error("回收结果未确认，保留事务记录");
      if (await exists(options.fs, sourcePath)) throw new Error("原路径仍存在，回收结果需要核对");
      var targetAfter = fingerprintFromStat(await lstatForIdentity(options.fs, options.targetPath));
      if (!(options.targetMethod === "link" ? sameHardLinkRecoveryFingerprint(options.targetFingerprint, targetAfter)
        : sameStrongPathFingerprint(options.targetFingerprint, targetAfter))) throw new Error("回收后目标身份核验失败");
      result.targetFingerprint = targetAfter;
      result.cleanupPending = false;
      result.remainingSourcePath = "";
      result.receipt = receipt;
    } catch (error) {
      result.cleanupWarning = "目标已就绪，原文件待回收：" + userSafeFailureDetail(error, "回收结果需要人工核对");
      result.cleanupFailure = { code: String(error && error.code || ""),
        win32Error: Number(error && error.win32Error) || 0, failureKind: String(error && error.failureKind || ""),
        committed: Boolean(error && error.committed) };
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
