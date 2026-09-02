const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../src/core");

test("规范化 Windows 路径时不会混淆前缀相同的同级目录", () => {
  assert.equal(Core.samePath("F:/素材/镜头.MOV", "f:\\素材\\镜头.mov"), true);
  assert.equal(Core.isPathInside("F:\\后期包\\音效\\a.wav", "f:/后期包"), true);
  assert.equal(Core.isPathInside("F:\\后期包-旧\\a.wav", "F:\\后期包"), false);
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
