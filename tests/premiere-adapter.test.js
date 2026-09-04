const test = require("node:test");
const assert = require("node:assert/strict");
const Premiere = require("../src/premiere-adapter");

test("Premiere 素材清单不完整时无法通过扫描安全门槛", async () => {
  const unreadableClip = {
    getId: () => "clip-1",
    isSequence: async () => false,
    getMediaFilePath: async () => { throw new Error("offline provider failed"); },
  };
  const root = { getItems: async () => [unreadableClip] };
  const ppro = {
    FolderItem: { cast: () => null },
    ClipProjectItem: { cast: (item) => item },
  };
  const inventory = await Premiere.inventoryProject(ppro, { getRootItem: async () => root });

  assert.equal(inventory.entries.length, 0);
  assert.equal(inventory.warnings.length, 1);
  assert.throws(
    () => Premiere.assertCompleteInventory(inventory),
    (error) => error.code === "MATERIAL_BATCH_INVENTORY_INCOMPLETE" && error.warningCount === 1,
  );
});

test("重复项目项 ID 会产生警告并阻止整理，同时避免分箱递归死循环", async () => {
  const cyclicFolder = {
    name: "循环分箱",
    getId: () => "folder-1",
    getItems: async () => [cyclicFolder],
  };
  const root = { getItems: async () => [cyclicFolder] };
  const ppro = {
    FolderItem: { cast: (item) => item === cyclicFolder ? item : null },
    ClipProjectItem: { cast: () => null },
  };

  const inventory = await Premiere.inventoryProject(ppro, { getRootItem: async () => root });

  assert.equal(inventory.entries.length, 0);
  assert.equal(inventory.warnings.length, 1);
  assert.match(inventory.warnings[0], /重复的 Premiere 项目项 ID folder-1/);
  assert.match(inventory.warnings[0], /循环分箱/);
  assert.throws(
    () => Premiere.assertCompleteInventory(inventory),
    (error) => error.code === "MATERIAL_BATCH_INVENTORY_INCOMPLETE" && error.warningCount === 1,
  );
});

test("同一规范化工程路径会生成稳定的工程身份", () => {
  const first = Premiere.projectIdentity({
    guid: { toString: () => "same-guid" },
    path: "C:/Projects/Film/Cut.prproj",
  });
  const samePath = Premiere.projectIdentity({
    guid: { toString: () => "same-guid" },
    path: "c:\\projects\\film\\cut.prproj",
  });

  assert.equal(first, samePath);
  assert.match(first, /path:c:\\projects\\film\\cut\.prproj/);
});

test("工程身份会区分不同路径下 GUID 相同的工程", async () => {
  const original = { guid: { toString: () => "same-guid" }, path: "C:/Projects/Film/Cut.prproj" };
  const copied = { guid: { toString: () => "same-guid" }, path: "C:/Projects/Film/Cut-copy.prproj" };
  const expectedIdentity = Premiere.projectIdentity(original);

  assert.notEqual(expectedIdentity, Premiere.projectIdentity(copied));

  const context = { getActiveProject: async () => copied };
  assert.equal(await Premiere.contextStillActive(context, expectedIdentity), false);
});

test("未保存工程没有路径时，工程身份会安全回退", () => {
  assert.equal(
    Premiere.projectIdentity({ guid: { toString: () => "unsaved-guid" }, name: "Untitled" }),
    "guid:unsaved-guid",
  );
  assert.equal(Premiere.projectIdentity({ name: "Untitled" }), "name:Untitled");
});

test("Premiere 工程路径在适配器边界转换为普通 Windows 路径", async () => {
  const project = {
    guid: { toString: () => "extended-project" },
    name: "测试工程.prproj",
    path: "\\\\?\\E:\\剪辑项目\\测试工程.prproj",
  };
  const context = await Premiere.activeContext({ Project: { getActiveProject: async () => project } });

  assert.equal(context.projectPath, "E:\\剪辑项目\\测试工程.prproj");
  assert.equal(context.workspaceRoot, "E:\\剪辑项目");
  assert.match(context.identity, /^path:e:\\剪辑项目\\测试工程\.prproj/);
});

test("Premiere 素材路径在清单边界转换并合并同一文件", async () => {
  const extendedClip = {
    name: "采访.wav",
    getId: () => "clip-extended",
    isSequence: async () => false,
    getMediaFilePath: async () => "\\\\?\\E:\\素材库\\采访.wav",
  };
  const ordinaryClip = {
    name: "采访副本.wav",
    getId: () => "clip-ordinary",
    isSequence: async () => false,
    getMediaFilePath: async () => "E:\\素材库\\采访.wav",
  };
  const ppro = {
    FolderItem: { cast: () => null },
    ClipProjectItem: { cast: (item) => item },
  };
  const inventory = await Premiere.inventoryProject(ppro, {
    getRootItem: async () => ({ getItems: async () => [extendedClip, ordinaryClip] }),
  });
  const groups = Premiere.groupByMediaPath(inventory.entries);

  assert.equal(inventory.entries[0].mediaPath, "E:\\素材库\\采访.wav");
  assert.equal(groups.length, 1);
  assert.equal(groups[0].entries.length, 2);
});
