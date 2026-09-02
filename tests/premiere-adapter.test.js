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
