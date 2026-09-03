(function (root, factory) {
  "use strict";

  var api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.MaterialBatchCore = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var WINDOWS_SEPARATOR = "\\";
  var UNSAFE_EXTENSIONS = new Set([".prproj", ".aep", ".aepx", ".mogrt"]);
  var SEQUENCE_EXTENSIONS = new Set([".bmp", ".cin", ".dpx", ".exr", ".gif", ".jpeg", ".jpg", ".png", ".tif", ".tiff", ".tga"]);

  function text(value) {
    return value == null ? "" : String(value);
  }

  function runtimePlatformName(override) {
    var explicit = text(override).trim().toLocaleLowerCase("en-US");
    if (explicit) return explicit;
    try {
      if (typeof process !== "undefined" && process && typeof process.platform === "string") {
        return process.platform.toLocaleLowerCase("en-US");
      }
    } catch (processError) {}
    try {
      if (typeof navigator !== "undefined" && navigator) {
        var hint = [navigator.platform, navigator.userAgent].map(text).join(" ");
        if (/windows|win32|win64/i.test(hint)) return "win32";
        if (/macintosh|macintel|mac os|darwin/i.test(hint)) return "darwin";
      }
    } catch (navigatorError) {}
    return "";
  }

  function readErrorField(error, field) {
    try {
      return error && error[field] != null ? String(error[field]) : "";
    } catch (readError) {
      return "";
    }
  }

  function isMissingPathError(error) {
    var structured = ["code", "name", "errno"].map(function (field) {
      return readErrorField(error, field).trim().toUpperCase();
    });
    var numericFields = [readErrorField(error, "code"), readErrorField(error, "errno")];
    if (typeof error === "number" || (typeof error === "string" && /^-?\d+$/.test(error.trim()))) {
      numericFields.push(String(error));
    }
    var knownNonMissingNumbers = [
      5, 13, -13, 16, -16, 20, -20, 21, -21, 22, -22, 26, -26, 28, -28, 30, -30, 32, 33,
      -4092, -4082, -4071, -4070, -4068, -4055, -4052, -4048, -4047, -4027,
    ];
    if (numericFields.some(function (value) {
      var number = Number(value);
      return Number.isFinite(number) && knownNonMissingNumbers.indexOf(number) >= 0;
    })) return false;

    var parts = structured.concat([readErrorField(error, "message")]);
    try { parts.push(error == null ? "" : String(error)); } catch (stringError) {}
    var description = parts.join("\n").toUpperCase();
    var knownNonMissingPattern = /(?:^|[^A-Z0-9])(?:EACCES|EPERM|EBUSY|EIO|EROFS|ENOTDIR|EISDIR|EINVAL|ENOSPC|ETXTBSY|EEXIST|ENOTEMPTY|ELOOP|ENAMETOOLONG|EMFILE|ENFILE|EDQUOT|EXDEV|ACCESS[_ -]*DENIED|PERMISSION[_ -]*DENIED|SHARING[_ -]*VIOLATION|LOCK[_ -]*VIOLATION)(?:$|[^A-Z0-9])/;
    if (knownNonMissingPattern.test(description)) return false;

    var knownMissing = ["ENOENT", "FILE_NOT_FOUND", "PATH_NOT_FOUND", "FILENOTFOUND", "PATHNOTFOUND", "FILENOTFOUNDERROR", "PATHNOTFOUNDERROR", "NOTFOUNDERROR"];
    if (structured.some(function (value) { return knownMissing.indexOf(value) >= 0; })) return true;

    if (numericFields.some(function (value) {
      var number = Number(value);
      return Number.isFinite(number) && [2, 3, -2, -4058].indexOf(number) >= 0;
    })) return true;
    return /(?:^|[^A-Z0-9])ENOENT(?:$|[^A-Z0-9])/.test(description)
      || /(?:^|[^A-Z0-9])(?:FILE|PATH)(?:[_ -]+WAS)?[_ -]+NOT[_ -]+FOUND(?:$|[^A-Z0-9])/.test(description)
      || /NO SUCH FILE OR DIRECTORY/.test(description)
      || /(?:^|[^A-Z0-9])(?:FILE|PATH) DOES NOT EXIST(?:$|[^A-Z0-9])/.test(description)
      || /(?:THE SYSTEM )?(?:CANNOT|COULD NOT) FIND (?:THE )?(?:FILE|PATH)(?: SPECIFIED)?/.test(description)
      || /系统找不到指定的(?:文件|路径)/.test(description)
      || /(?:文件|路径)不存在/.test(description);
  }

  function isForwardSlashUncPath(nativePath, platform) {
    // //host/share 与 POSIX 双斜杠路径在语法上不可区分，只有明确的 Windows 运行时才转换。
    if (runtimePlatformName(platform) !== "win32") return false;
    var value = text(nativePath).trim();
    return /^\/\/[^\\/]+[\\/]+[^\\/]+(?:[\\/]|$)/.test(value);
  }

  function toFileSystemPath(nativePath, platform) {
    var value = text(nativePath);
    if (/^\\\\\?\\UNC\\/i.test(value)) return "\\\\" + value.slice(8);
    if (/^\\\\\?\\[A-Za-z]:[\\/]/.test(value)) return value.slice(4);
    if (isForwardSlashUncPath(value, platform)) return "\\\\" + value.slice(2).replace(/\//g, WINDOWS_SEPARATOR);
    return value;
  }

  function isWindowsPath(nativePath, platform) {
    var value = text(nativePath).trim();
    return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value)
      || isForwardSlashUncPath(value, platform)
      || /^\\\\\?\\(?:UNC\\|[A-Za-z]:[\\/])/i.test(value);
  }

  function separatorFor(nativePath) {
    return isWindowsPath(nativePath) ? "\\" : "/";
  }

  function trimTrailingSeparators(nativePath, platform) {
    var value = toFileSystemPath(nativePath, platform);
    if (/^[A-Za-z]:[\\/]+$/.test(value)) return value.charAt(0).toUpperCase() + ":\\";
    if (/^\/+$/.test(value)) return "/";
    if (value.slice(0, 2) === WINDOWS_SEPARATOR + WINDOWS_SEPARATOR) {
      var uncRoot = value.replace(/[\\/]+$/, "");
      var uncRootParts = uncRoot.slice(2).split(/[\\/]+/);
      if (uncRootParts.length === 2 && uncRootParts[0] && uncRootParts[1]) {
        return WINDOWS_SEPARATOR + WINDOWS_SEPARATOR + uncRootParts.join(WINDOWS_SEPARATOR);
      }
    }
    return value.replace(/[\\/]+$/, "");
  }

  function legacyNormalizePathForComparison(nativePath) {
    var value = trimTrailingSeparators(toFileSystemPath(nativePath).trim()).replace(/\//g, WINDOWS_SEPARATOR);
    if (/^[A-Za-z]:/.test(value)) value = value.charAt(0).toUpperCase() + value.slice(1);
    return value.toLocaleLowerCase("en-US");
  }

  function lexicalNormalizePath(nativePath, platform) {
    var value = toFileSystemPath(nativePath, platform).trim();
    var windows = isWindowsPath(value, platform);
    if (windows) {
      value = value.replace(/\//g, WINDOWS_SEPARATOR);
      if (value.slice(0, 2) === WINDOWS_SEPARATOR + WINDOWS_SEPARATOR) {
        value = WINDOWS_SEPARATOR + WINDOWS_SEPARATOR + value.slice(2).replace(/\\+/g, WINDOWS_SEPARATOR);
      } else {
        value = value.replace(/\\+/g, WINDOWS_SEPARATOR);
      }
    } else {
      value = value.replace(/\/+/g, "/");
    }
    value = trimTrailingSeparators(value, platform);
    var separator = windows ? WINDOWS_SEPARATOR : "/";
    var absolute = false;
    var prefix = "";
    var rootCount = 0;
    if (windows) {
      var drive = value.match(/^([A-Za-z]:)(?:\\|$)/);
      var unc = value.match(/^\\\\([^\\]+)\\([^\\]+)(?:\\|$)/);
      if (drive) {
        absolute = true;
        prefix = drive[1].toUpperCase() + WINDOWS_SEPARATOR;
        value = value.slice(drive[0].length);
      } else if (unc) {
        absolute = true;
        prefix = WINDOWS_SEPARATOR + WINDOWS_SEPARATOR;
        value = value.slice(2);
        rootCount = 2;
      }
    } else if (value.charAt(0) === "/") {
      absolute = true;
      prefix = "/";
      value = value.slice(1);
    }
    var parts = value.split(separator);
    var stack = windows && rootCount ? value.split(separator).slice(0, rootCount) : [];
    if (windows && rootCount) {
      value = parts.slice(rootCount).join(separator);
      parts = value ? value.split(separator) : [];
    }
    parts.forEach(function (part) {
      if (!part || part === ".") return;
      if (part === "..") {
        if (stack.length > rootCount && stack[stack.length - 1] !== "..") stack.pop();
        else if (!absolute) stack.push(part);
        return;
      }
      stack.push(part);
    });
    var body = stack.join(separator);
    if (absolute) return prefix + body;
    return body;
  }

  function normalizePathForComparison(nativePath, platform) {
    var value = lexicalNormalizePath(nativePath, platform);
    if (isWindowsPath(value, platform)) {
      value = value.replace(/\//g, WINDOWS_SEPARATOR);
      if (/^[A-Za-z]:/.test(value)) value = value.charAt(0).toUpperCase() + value.slice(1);
      return value.toLocaleLowerCase("en-US");
    }
    return value.replace(/\/+/g, "/");
  }

  function samePath(left, right, platform) {
    return normalizePathForComparison(left, platform) === normalizePathForComparison(right, platform);
  }

  function normalizeRelativePathForComparison(relativePath) {
    var input = text(relativePath).trim().replace(/[\\/]+/g, "/");
    var value = lexicalNormalizePath(input).replace(/[\\/]+/g, "/");
    return value.replace(/^\.\//, "").replace(/\/+$/, "");
  }

  function sameRelativePath(left, right) {
    var normalizedLeft = normalizeRelativePathForComparison(left);
    var normalizedRight = normalizeRelativePathForComparison(right);
    if (normalizedLeft === normalizedRight) return true;
    // 0.1.0/0.1.1 在 Windows 状态中使用小写反斜杠键；
    // 只对携带旧 Windows 分隔符的相对路径启用兼容比较，保持 macOS 大小写敏感。
    if (text(left).indexOf("\\") < 0 && text(right).indexOf("\\") < 0) return false;
    return normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US");
  }

  function isAbsoluteLocalPath(nativePath, platform) {
    return /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)|\/)/.test(toFileSystemPath(nativePath, platform).trim());
  }

  function dirname(nativePath) {
    var value = trimTrailingSeparators(nativePath);
    var index = Math.max(value.lastIndexOf("\\"), value.lastIndexOf("/"));
    if (index < 0) return "";
    if (index === 0 && value.charAt(0) === "/") return "/";
    if (index === 2 && /^[A-Za-z]:/.test(value)) return value.slice(0, 3).replace("/", "\\");
    return value.slice(0, index);
  }

  function basename(nativePath) {
    var value = trimTrailingSeparators(nativePath);
    var index = Math.max(value.lastIndexOf("\\"), value.lastIndexOf("/"));
    return index < 0 ? value : value.slice(index + 1);
  }

  function extname(nativePath) {
    var name = basename(nativePath);
    var index = name.lastIndexOf(".");
    return index <= 0 ? "" : name.slice(index).toLocaleLowerCase("en-US");
  }

  function stem(nativePath) {
    var name = basename(nativePath);
    var extension = extname(name);
    return extension ? name.slice(0, -extension.length) : name;
  }

  function joinNativePath() {
    var parts = Array.prototype.slice.call(arguments).filter(function (part) {
      return text(part).length > 0;
    });
    if (!parts.length) return "";
    var separator = separatorFor(parts[0]);
    var joined = parts
      .map(function (part, index) {
        var value = index === 0 ? toFileSystemPath(part) : text(part);
        if (index === 0) {
          if (value === "/") return value;
          if (/^[A-Za-z]:[\\/]$/.test(value)) return value.charAt(0).toUpperCase() + ":\\";
          return value.replace(/[\\/]+$/, "");
        }
        return value.replace(/^[\\/]+|[\\/]+$/g, "");
      })
      .join(separator);
    return separator === "/" && joined.indexOf("//") === 0 ? joined.slice(1) : joined;
  }

  function isPathInside(candidate, rootPath, platform) {
    var candidateKey = normalizePathForComparison(candidate, platform);
    var rootKey = normalizePathForComparison(rootPath, platform);
    if (!candidateKey || !rootKey) return false;
    var separator = isWindowsPath(rootPath, platform) ? WINDOWS_SEPARATOR : "/";
    var prefix = rootKey.charAt(rootKey.length - 1) === separator
      ? rootKey
      : rootKey + separator;
    return candidateKey === rootKey || candidateKey.indexOf(prefix) === 0;
  }

  function workspaceRootForProject(projectPath) {
    var projectFolder = dirname(projectPath);
    if (basename(projectFolder).toLocaleLowerCase("en-US") === "adobe premiere pro auto-save") {
      return dirname(projectFolder);
    }
    return projectFolder;
  }

  function padBatchIndex(index) {
    return String(Math.max(1, Math.floor(Number(index) || 1))).padStart(3, "0");
  }

  function localDateStamp(date) {
    var value = date instanceof Date ? date : new Date(date || Date.now());
    return [value.getFullYear(), String(value.getMonth() + 1).padStart(2, "0"), String(value.getDate()).padStart(2, "0")].join("-");
  }

  function batchName(index, date) {
    var safeIndex = Math.max(1, Math.floor(Number(index) || 1));
    return padBatchIndex(safeIndex) + "_" + (safeIndex === 1 ? "初始素材" : localDateStamp(date));
  }

  function isSameVolume(left, right, platform) {
    var leftPath = toFileSystemPath(left, platform);
    var rightPath = toFileSystemPath(right, platform);
    var leftMatch = leftPath.match(/^([A-Za-z]):[\\/]/);
    var rightMatch = rightPath.match(/^([A-Za-z]):[\\/]/);
    if (leftMatch && rightMatch) return leftMatch[1].toLocaleLowerCase("en-US") === rightMatch[1].toLocaleLowerCase("en-US");
    var leftUnc = leftPath.match(/^\\\\([^\\]+)\\([^\\]+)/);
    var rightUnc = rightPath.match(/^\\\\([^\\]+)\\([^\\]+)/);
    if (leftUnc && rightUnc) return leftUnc[0].toLocaleLowerCase("en-US") === rightUnc[0].toLocaleLowerCase("en-US");
    return false;
  }

  function isProjectFile(nativePath) {
    return extname(nativePath) === ".prproj";
  }

  function isSafePathSegment(value) {
    var segment = text(value).trim();
    if (!segment || segment === "." || segment === "..") return false;
    if (/[\\/:*?"<>|]/.test(segment)) return false;
    return !/[. ]$/.test(segment);
  }

  function isSafeRelativePath(value) {
    var relative = text(value).trim();
    if (!relative || isAbsoluteLocalPath(relative)) return false;
    var parts = relative.split(/[\\/]/);
    return parts.length > 0 && parts.every(isSafePathSegment);
  }

  function isUnsafeLinkedAsset(nativePath) {
    return UNSAFE_EXTENSIONS.has(extname(nativePath));
  }

  function isPotentialImageSequence(nativePath) {
    if (!SEQUENCE_EXTENSIONS.has(extname(nativePath))) return false;
    return /(?:^|[^0-9])[0-9]{3,}$/.test(stem(nativePath));
  }

  function classifyMediaPath(nativePath, options) {
    var config = options || {};
    if (!nativePath || !isAbsoluteLocalPath(nativePath)) {
      return { kind: "unsupported", reason: "不是可识别的本地绝对路径" };
    }
    if (isProjectFile(nativePath)) return { kind: "ignored", reason: "Premiere 工程文件永不整理" };
    if (config.mediaRoot && isPathInside(nativePath, config.mediaRoot)) return { kind: "managed", reason: "已在素材根目录" };

    var protectedRoots = Array.isArray(config.protectedRoots) ? config.protectedRoots : [];
    for (var index = 0; index < protectedRoots.length; index += 1) {
      if (isPathInside(nativePath, protectedRoots[index].rootPath)) {
        return { kind: "protected", reason: "命中受保护素材库", libraryId: protectedRoots[index].libraryId };
      }
    }
    if (isUnsafeLinkedAsset(nativePath)) return { kind: "review", reason: "动态链接或工程型素材暂不自动移动" };
    if (isPotentialImageSequence(nativePath)) return { kind: "review", reason: "疑似图片序列，需保留整组结构" };
    return { kind: "collect", reason: "项目外的新素材" };
  }

  function targetNameCandidate(sourcePath, suffixIndex) {
    var extension = extname(sourcePath);
    var baseStem = stem(sourcePath);
    if (!suffixIndex || suffixIndex < 2) return basename(sourcePath);
    return baseStem + " (" + suffixIndex + ")" + extension;
  }

  function makeMediaSpaceId(workspaceRoot, createdAt) {
    var seed = normalizePathForComparison(workspaceRoot) + "|" + text(createdAt || new Date().toISOString());
    var hash = 2166136261;
    for (var index = 0; index < seed.length; index += 1) {
      hash ^= seed.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return "media-" + (hash >>> 0).toString(16).padStart(8, "0");
  }

  return {
    batchName: batchName,
    basename: basename,
    classifyMediaPath: classifyMediaPath,
    dirname: dirname,
    extname: extname,
    isMissingPathError: isMissingPathError,
    isWindowsPath: isWindowsPath,
    legacyNormalizePathForComparison: legacyNormalizePathForComparison,
    isPathInside: isPathInside,
    isAbsoluteLocalPath: isAbsoluteLocalPath,
    isPotentialImageSequence: isPotentialImageSequence,
    isProjectFile: isProjectFile,
    isSafePathSegment: isSafePathSegment,
    isSafeRelativePath: isSafeRelativePath,
    isSameVolume: isSameVolume,
    joinNativePath: joinNativePath,
    localDateStamp: localDateStamp,
    makeMediaSpaceId: makeMediaSpaceId,
    normalizePathForComparison: normalizePathForComparison,
    samePath: samePath,
    sameRelativePath: sameRelativePath,
    normalizeRelativePathForComparison: normalizeRelativePathForComparison,
    stem: stem,
    targetNameCandidate: targetNameCandidate,
    toFileSystemPath: toFileSystemPath,
    workspaceRootForProject: workspaceRootForProject,
  };
});
