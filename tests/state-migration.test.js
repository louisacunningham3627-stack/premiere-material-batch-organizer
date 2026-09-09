const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const Storage = require("../src/storage");
const State = require("../src/state");

test("旧版迁移原文备份不随正常保存轮换", async () => {
  const root = path.resolve(__dirname, "../work/migration-tests");
  await fs.mkdir(root, { recursive: true });
  const folder = await fs.mkdtemp(path.join(root, "run-"));
  const file = path.join(folder, Storage.STATE_FILE_NAME);
  const old = State.createState(folder); old.schemaVersion = 1;
  const original = JSON.stringify(old);
  await fs.writeFile(file, original);
  const upgraded = State.hydrateState(old, folder);
  await Storage.writeJsonAtomic(fs, file, upgraded);
  await Storage.writeJsonAtomic(fs, file, upgraded);
  assert.equal(await fs.readFile(file + ".schema-1-before-migration.json", "utf8"), original);
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).schemaVersion, 2);
});
