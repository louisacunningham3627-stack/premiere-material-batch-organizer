const test = require("node:test");
const assert = require("node:assert/strict");
const State = require("../src/state");

test("跨日只在准备归集时切换，不修改旧目录名称", () => {
  const yesterday = new Date(2026, 8, 6, 10);
  const today = new Date(2026, 8, 7, 10);
  const state = State.createState("E:\\项目", yesterday);
  state.batches[0].name = "001_初始素材";
  const next = State.prepareCollectionBatch(state, today);
  assert.equal(next.batches.length, 2);
  assert.equal(next.batches[0].name, "001_初始素材");
  assert.equal(State.currentBatch(next).name, "2026年09月07日添加素材");
  assert.equal(State.prepareCollectionBatch(next, today).batches.length, 2);
  assert.equal(state.batches.length, 1);
});

test("手动分批只登记意图，跨重载保留且归集时才建带秒批次", () => {
  const at = new Date(2026, 8, 6, 15, 30, 12);
  const state = State.requestNextBatch(State.createState("E:\\项目", at), at);
  assert.equal(state.batches.length, 1);
  const loaded = State.hydrateState(state, "E:\\项目", at);
  assert.equal(loaded.nextBatchRequestedAt, at.toISOString());
  const next = State.prepareCollectionBatch(loaded, at);
  assert.equal(State.currentBatch(next).name, "2026年09月06日 15时30分12秒添加素材");
  assert.equal(next.nextBatchRequestedAt, undefined);
  assert.equal(State.prepareCollectionBatch(next, at).batches.length, 2);
});

test("重复预约不会创建空批次，未完成事务不允许切换", () => {
  const at = new Date(2026, 8, 6, 15, 30, 12);
  let state = State.createState("E:\\项目", at);
  state = State.requestNextBatch(State.requestNextBatch(state, at), at);
  assert.equal(state.batches.length, 1);
  state.pendingTransaction = { id: "protected" };
  assert.throws(() => State.requestNextBatch(state, at));
  assert.throws(() => State.prepareCollectionBatch(state, at));
});

test("暂缓保留完整事务，恢复时按身份取回且不清空其他记录", () => {
  const state = State.createState("E:\\项目");
  state.pendingTransaction = { id: "one", sourcePath: "E:\\原片.bin", resumeAutomatic: false };
  const deferred = State.deferTransaction(state);
  assert.equal(deferred.pendingTransaction, null);
  assert.equal(deferred.deferredTransactions[0].sourcePath, state.pendingTransaction.sourcePath);
  const resumed = State.resumeDeferred(deferred, "one");
  assert.equal(resumed.pendingTransaction.id, "one");
  assert.equal(resumed.pendingTransaction.resumeAutomatic, false);
  assert.equal(resumed.deferredTransactions.length, 0);
  assert.equal(state.pendingTransaction.id, "one");
});

test("回收结果未明或工程待保存时不能通过暂缓绕过", () => {
  const state = State.createState("E:\\项目");
  state.pendingTransaction = { id: "one", recycleRequest: { id: "request" } };
  assert.throws(() => State.deferTransaction(state), /回收结果/);
  state.pendingTransaction = { id: "one" };
  state.pendingProjectSave = { id: "save" };
  assert.throws(() => State.deferTransaction(state));
  assert.throws(() => State.resumeDeferred(state, "one"));
});

test("后台等待跨重载保留，到期只取当前工程的一项，人工暂缓不自动恢复", () => {
  const at = new Date("2026-09-07T00:00:00Z");
  let state = State.createState("E:\\项目", at);
  for (const [id, project, kind] of [["a", "A", "cleanup"], ["b", "B", "cleanup"], ["c", "A", "held"]]) {
    state.pendingTransaction = { id, sourcePath: "C:\\素材\\" + id, targetRelativePath: "素材\\" + id,
      projectPath: "E:\\项目\\" + project + ".prproj", projectIdentity: project };
    state = State.deferTransaction(state, at, { version: 1, kind, attempts: 1, nextAttemptAt: "2026-09-07T00:00:10Z", message: "等待中" });
  }
  state = State.hydrateState(state, "E:\\项目", at);
  assert.equal(State.nextBackgroundCleanup(state, "E:\\项目\\A.prproj", "A", at), null);
  const due = new Date(at.getTime() + 11000);
  assert.equal(State.nextBackgroundCleanup(state, "E:\\项目\\A.prproj", "A", due).id, "a");
  assert.equal(State.nextBackgroundCleanup(state, "E:\\项目\\A.prproj", "B", due), null);
  state = State.resumeDeferred(state, "a", due);
  assert.equal(State.nextBackgroundCleanup(state, "E:\\项目\\B.prproj", "B", due), null);
  assert.equal(state.deferredTransactions.length, 2);
});

test("损坏的后台时间、重复事务及未来队列格式不能被悄悄采用", () => {
  const base = State.createState("E:\\项目");
  base.deferredTransactions = [{ id: "a", sourcePath: "C:\\a.gif", targetRelativePath: "素材\\a.gif",
    backgroundTask: { version: 1, kind: "cleanup", attempts: 1, nextAttemptAt: "2026-09-07T00:00:10Z", message: "等待中" } }];
  for (const change of [s => { s.deferredTransactions[0].backgroundTask.version = 2; },
    s => { s.deferredTransactions[0].backgroundTask.nextAttemptAt = "invalid"; },
    s => { s.pendingTransaction = { ...s.deferredTransactions[0] }; }]) {
    const value = JSON.parse(JSON.stringify(base)); change(value);
    assert.throws(() => State.hydrateState(value, "E:\\项目"));
  }
});
