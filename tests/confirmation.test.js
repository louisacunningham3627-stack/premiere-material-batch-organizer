const test = require("node:test");
const assert = require("node:assert/strict");
const Confirmation = require("../src/confirmation");
function setup() {
  const nodes = Object.fromEntries(["confirmationPage", "confirmationText", "confirmationAccept", "confirmationCancel"].map(id => [id, { hidden: true, scrollTop: 0 }]));
  const document = { body: { dataset: {} }, getElementById: id => nodes[id] };
  return { nodes, document, confirmation: Confirmation.create(document) };
}
test("没有浏览器 confirm 接口仍可在面板确认，点击前不放行", async () => {
  const f = setup(); let completed = false;
  const answer = f.confirmation.request("原位置：E:\\test.wav").then(value => { completed = true; return value; });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(f.nodes.confirmationPage.hidden, false);
  assert.match(f.nodes.confirmationText.textContent, /test.wav/);
  f.nodes.confirmationAccept.onclick();
  assert.equal(await answer, true);
  assert.equal(f.document.body.dataset.confirmation, "false");
});
test("取消或关闭面板不授予操作权限，重复请求拒绝", async () => {
  const f = setup();
  const first = f.confirmation.request("等待确认");
  await assert.rejects(f.confirmation.request("重复"), /已有确认/);
  f.nodes.confirmationCancel.onclick();
  assert.equal(await first, false);
  const second = f.confirmation.request("第二次");
  f.confirmation.cancel();
  assert.equal(await second, false);
});
test("确认界面缺失时明确报错，绝不静默批准", async () => {
  const c = Confirmation.create({ getElementById: () => null });
  await assert.rejects(c.request("test"), /确认界面未加载/);
});
