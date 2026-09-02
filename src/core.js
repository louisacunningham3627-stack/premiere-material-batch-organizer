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

  function separatorFor(nativePath) {
    return text(nativePath).indexOf("\\") >= 0 ? "\\" : "/";
  }

  function trimTrailingSeparators(nativePath) {
    var value = text(nativePath);
    if (/^[A-Za-z]:[\\/]$/.test(value)) return value.charAt(0).toUpperCase() + ":\\";
    if (/^\\\\[^\\]+\\[^\\]+\\?$/.test(value)) return value.replace(/[\\/]+$/, "");
    return value.replace(/[\\/]+$/, "");
  }

  function normalizePathForComparison(nativePath) {
    var value = trimTrailingSeparators(text(nativePath).trim()).replace(/\//g, WINDOWS_SEPARATOR);
    if (/^[A-Za-z]:/.test(value)) value = value.charAt(0).toUpperCase() + value.slice(1);
    return value.toLocaleLowerCase("en-US");
  }

  function samePath(left, right) {
    return normalizePathForComparison(left) === normalizePathForComparison(right);
  }

  function isAbsoluteLocalPath(nativePath) {
    return /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$)|\/)/.test(text(nativePath).trim());
  }

  function dirname(nativePath) {
    var value = trimTrailingSeparators(nativePath);
    var index = Math.max(value.lastIndexOf("\\"), value.lastIndexOf("/"));
    if (index < 0) return "";
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
    return parts
      .map(function (part, index) {
        var value = text(part);
        if (index === 0) return value.replace(/[\\/]+$/, "");
        return value.replace(/^[\\/]+|[\\/]+$/g, "");
      })
      .join(separator);
  }

  function isPathInside(candidate, rootPath) {
    var candidateKey = normalizePathForComparison(candidate);
    var rootKey = normalizePathForComparison(rootPath);
    if (!candidateKey || !rootKey) return false;
    return candidateKey === rootKey || candidateKey.indexOf(rootKey + WINDOWS_SEPARATOR) === 0;
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

  function isSameVolume(left, right) {
    var leftMatch = text(left).match(/^([A-Za-z]):[\\/]/);
    var rightMatch = text(right).match(/^([A-Za-z]):[\\/]/);
    if (leftMatch && rightMatch) return leftMatch[1].toLocaleLowerCase("en-US") === rightMatch[1].toLocaleLowerCase("en-US");
    var leftUnc = text(left).match(/^\\\\([^\\]+)\\([^\\]+)/);
    var rightUnc = text(right).match(/^\\\\([^\\]+)\\([^\\]+)/);
    return Boolean(leftUnc && rightUnc && leftUnc[0].toLocaleLowerCase("en-US") === rightUnc[0].toLocaleLowerCase("en-US"));
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
    stem: stem,
    targetNameCandidate: targetNameCandidate,
    workspaceRootForProject: workspaceRootForProject,
  };
});
