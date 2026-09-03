const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../src/core");

test("规范化 Windows 路径时不会混淆前缀相同的同级目录", () => {
  assert.equal(Core.samePath("F:/素材/镜头.MOV", "f:\\素材\\镜头.mov"), true);
  assert.equal(Core.isPathInside("F:\\后期包\\音效\\a.wav", "f:/后期包"), true);
  assert.equal(Core.isPathInside("F:\\后期包-旧\\a.wav", "F:\\后期包"), false);
});

test("Windows 扩展路径会在进入文件系统前转换为普通路径", () => {
  assert.equal(Core.toFileSystemPath("\\\\?\\E:\\项目\\素材\\a.mov"), "E:\\项目\\素材\\a.mov");
  assert.equal(
    Core.toFileSystemPath("\\\\?\\UNC\\server\\share\\素材\\a.mov"),
    "\\\\server\\share\\素材\\a.mov",
  );
  assert.equal(Core.toFileSystemPath("E:\\项目\\素材\\a.mov"), "E:\\项目\\素材\\a.mov");
  assert.equal(Core.samePath("\\\\?\\E:\\项目\\素材\\a.mov", "e:\\项目\\素材\\A.MOV"), true);
  assert.equal(Core.isAbsoluteLocalPath("\\\\?\\E:\\项目\\素材\\a.mov"), true);
  assert.equal(Core.isSameVolume("\\\\?\\E:\\项目\\素材\\a.mov", "E:\\其他\\b.mov"), true);
  assert.equal(
    Core.isSameVolume("\\\\?\\UNC\\server\\share\\a.mov", "\\\\server\\share\\其他\\b.mov"),
    true,
  );
});

test("盘符根目录能正确包含其下路径", () => {
  assert.equal(Core.isPathInside("D:\\Project\\clip.mp4", "D:\\"), true);
  assert.equal(Core.isPathInside("E:\\Project\\clip.mp4", "D:\\"), false);
});

test("使用 Premiere Auto-Save 的父目录作为共享工作区", () => {
  assert.equal(
    Core.workspaceRootForProject("I:\\剪辑\\新手\\Adobe Premiere Pro Auto-Save\\新手-01.prproj"),
    "I:\\剪辑\\新手",
  );
  assert.equal(Core.workspaceRootForProject("I:\\剪辑\\新手\\新手-01.prproj"), "I:\\剪辑\\新手");
});

test("创建浅层交接批次名称", () => {
  const date = new Date(2026, 8, 2, 10, 0, 0);
  assert.equal(Core.batchName(1, date), "001_初始素材");
  assert.equal(Core.batchName(2, date), "002_2026-09-02");
  assert.equal(Core.batchName(12, date), "012_2026-09-02");
});

test("统一识别 Node、UXP 和 Windows 的明确缺失路径错误", () => {
  assert.equal(Core.isMissingPathError(Object.assign(new Error("missing"), { code: "ENOENT" })), true);
  assert.equal(Core.isMissingPathError(new Error("no such file or directory")), true);
  assert.equal(Core.isMissingPathError("Error: enoent: missing path"), true);
  assert.equal(Core.isMissingPathError({ name: "FileNotFoundError" }), true);
  assert.equal(Core.isMissingPathError({ errno: -4058 }), true);
  assert.equal(Core.isMissingPathError({ code: 3 }), true);
  assert.equal(Core.isMissingPathError(-4058), true);
  assert.equal(Core.isMissingPathError(new Error("the file was not found")), true);
  assert.equal(Core.isMissingPathError(new Error("could not find the file")), true);
  assert.equal(Core.isMissingPathError("系统找不到指定的路径"), true);
});

test("权限、占用和 I/O 错误绝不会被当成路径不存在", () => {
  assert.equal(Core.isMissingPathError(Object.assign(new Error("permission denied"), { code: "EACCES" })), false);
  assert.equal(Core.isMissingPathError(Object.assign(new Error("resource busy"), { code: "EBUSY" })), false);
  assert.equal(Core.isMissingPathError(Object.assign(new Error("input output error"), { code: "EIO" })), false);
  assert.equal(Core.isMissingPathError({ code: "ACCESS_DENIED", message: "PATH_NOT_FOUND" }), false);
  assert.equal(Core.isMissingPathError({ errno: "EBUSY", message: "no such file or directory" }), false);
  assert.equal(Core.isMissingPathError(new Error("EACCES: PATH_NOT_FOUND")), false);
  assert.equal(Core.isMissingPathError("Error: EPERM: FILE_NOT_FOUND"), false);
  assert.equal(Core.isMissingPathError({ code: "ERROR_ACCESS_DENIED", message: "PATH_NOT_FOUND" }), false);
  assert.equal(Core.isMissingPathError({ message: "ERROR_SHARING_VIOLATION: file not found" }), false);
  assert.equal(Core.isMissingPathError({ code: 5, message: "PATH_NOT_FOUND" }), false);
  assert.equal(Core.isMissingPathError({ errno: -13, message: "FILE_NOT_FOUND" }), false);
  assert.equal(Core.isMissingPathError({ errno: -16, message: "no such file or directory" }), false);
  assert.equal(Core.isMissingPathError(new Error("plugin was not found")), false);
  assert.equal(Core.isMissingPathError(new Error("PROFILE_NOT_FOUNDATION")), false);
  assert.equal(Core.isMissingPathError(null), false);

  const busyToStringError = { toString: () => "EBUSY: no such file or directory" };
  assert.equal(Core.isMissingPathError(busyToStringError), false);

  const hostileError = {};
  Object.defineProperty(hostileError, "code", { get() { throw new Error("getter failed"); } });
  hostileError.toString = () => { throw new Error("string conversion failed"); };
  assert.equal(Core.isMissingPathError(hostileError), false);
});

test("不会把 .prproj 或保护目录根路径归类为待归集素材", () => {
  const options = {
    mediaRoot: "I:\\项目\\素材",
    protectedRoots: [{ libraryId: "post-kit", rootPath: "I:\\【后期包 ver10.0】" }],
  };
  assert.equal(Core.classifyMediaPath("C:\\下载\\版本.prproj", options).kind, "ignored");
  assert.deepEqual(Core.classifyMediaPath("I:\\【后期包 ver10.0】\\音效\\hit.wav", options), {
    kind: "protected",
    reason: "命中受保护素材库",
    libraryId: "post-kit",
  });
  assert.equal(Core.classifyMediaPath("I:\\项目\\素材\\002_2026-09-02\\a.mp4", options).kind, "managed");
  assert.equal(Core.classifyMediaPath("C:\\Users\\Admin\\Downloads\\a.mp4", options).kind, "collect");
});

test("将动态链接和疑似图像序列留待审核", () => {
  assert.equal(Core.classifyMediaPath("D:\\motion\\title.aep", {}).kind, "review");
  assert.equal(Core.classifyMediaPath("D:\\frames\\shot_0001.exr", {}).kind, "review");
  assert.equal(Core.classifyMediaPath("D:\\stills\\cover.png", {}).kind, "collect");
});

test("已整理的动态素材和图像序列会留在受管空间中", () => {
  const options = { mediaRoot: "D:\\项目\\素材" };
  assert.deepEqual(Core.classifyMediaPath("D:\\项目\\素材\\title.aep", options), {
    kind: "managed",
    reason: "已在素材根目录",
  });
  assert.deepEqual(Core.classifyMediaPath("D:\\项目\\素材\\template.mogrt", options), {
    kind: "managed",
    reason: "已在素材根目录",
  });
  assert.deepEqual(Core.classifyMediaPath("D:\\项目\\素材\\shot_0001.exr", options), {
    kind: "managed",
    reason: "已在素材根目录",
  });
});

test("受保护的动态素材和图像序列会留在其素材库中", () => {
  const options = {
    protectedRoots: [{ libraryId: "post-kit", rootPath: "D:\\后期包" }],
  };
  assert.deepEqual(Core.classifyMediaPath("D:\\后期包\\title.aep", options), {
    kind: "protected",
    reason: "命中受保护素材库",
    libraryId: "post-kit",
  });
  assert.deepEqual(Core.classifyMediaPath("D:\\后期包\\template.mogrt", options), {
    kind: "protected",
    reason: "命中受保护素材库",
    libraryId: "post-kit",
  });
  assert.deepEqual(Core.classifyMediaPath("D:\\后期包\\shot_0001.exr", options), {
    kind: "protected",
    reason: "命中受保护素材库",
    libraryId: "post-kit",
  });
});

test("外部动态素材和图像序列仍会送交审核", () => {
  const options = {
    mediaRoot: "D:\\项目\\素材",
    protectedRoots: [{ libraryId: "post-kit", rootPath: "D:\\后期包" }],
  };
  assert.equal(Core.classifyMediaPath("D:\\下载\\title.aep", options).kind, "review");
  assert.equal(Core.classifyMediaPath("D:\\下载\\template.mogrt", options).kind, "review");
  assert.equal(Core.classifyMediaPath("D:\\下载\\shot_0001.exr", options).kind, "review");
});

test("识别相同 Windows 卷并为重名冲突添加后缀", () => {
  assert.equal(Core.isSameVolume("D:\\a\\x.mp4", "d:\\b\\x.mp4"), true);
  assert.equal(Core.isSameVolume("D:\\a\\x.mp4", "E:\\b\\x.mp4"), false);
  assert.equal(Core.targetNameCandidate("D:\\a\\x.mp4", 1), "x.mp4");
  assert.equal(Core.targetNameCandidate("D:\\a\\x.mp4", 2), "x (2).mp4");
});

test("macOS POSIX 路径保留大小写并正确处理根目录", () => {
  assert.equal(Core.samePath("/Users/Editor/Media/Clip.WAV", "/Users/Editor/Media/Clip.WAV"), true);
  assert.equal(Core.samePath("/Users/Editor/Media/Clip.WAV", "/users/editor/media/clip.wav"), false);
  assert.equal(Core.isPathInside("/Users/Editor/Media/素材/a.wav", "/Users/Editor/Media/素材"), true);
  assert.equal(Core.isPathInside("/Users/Editor/Media/素材-old/a.wav", "/Users/Editor/Media/素材"), false);
  assert.equal(Core.isPathInside("/项目/素材/a.wav", "/"), true);
  assert.equal(Core.joinNativePath("/", "项目", "素材"), "/项目/素材");
  assert.equal(Core.dirname("/项目/素材/a.wav"), "/项目/素材");
  assert.equal(Core.dirname("/a"), "/");
});

test("macOS 路径不会凭字符串猜测卷，交给运行时 lstat 证明", () => {
  assert.equal(Core.isSameVolume("/Volumes/素材盘/a.wav", "/Volumes/素材盘/项目/a.wav"), false);
  assert.equal(Core.isAbsoluteLocalPath("/Users/Editor/a.wav"), true);
  assert.equal(Core.isAbsoluteLocalPath("Users/Editor/a.wav"), false);
});
