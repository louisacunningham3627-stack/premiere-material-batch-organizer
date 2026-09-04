const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "plugin", "index.html"), "utf8");
const previewHtml = fs.readFileSync(path.join(__dirname, "..", "preview", "index.html"), "utf8");

test("提供稳定的审核容器，操作属性中不嵌入本机路径", () => {
  assert.match(html, /id="reviewSection"/);
  assert.match(html, /id="reviewList"/);
  assert.doesNotMatch(html, /data-(?:path|source-path|target-path)=/);
});

test("保持五种审核操作稳定，供主进程绑定", () => {
  for (const action of ["baseline-keep", "baseline-move", "mapping-confirm", "reveal", "retry"]) {
    assert.match(html, new RegExp(`["']${action}["']`));
  }
  assert.match(html, /dataset\.reviewAction/);
  assert.match(html, /dataset\.reviewId/);
  assert.match(html, /batch-collector:review-action/);
});

test("每种审核类型只提供其所需范围内的处理方式", () => {
  assert.match(html, /视为原有素材/);
  assert.match(html, /整理这个文件/);
  assert.match(html, /确认使用/);
  assert.match(html, /打开所在位置/);
  assert.match(html, /重新检查/);
  assert.match(html, /加入“不搬动文件夹”/);
  assert.match(html, /Premiere 中手动重新链接/);
  assert.doesNotMatch(html, /保留外部文件/);
});

test("冲突状态会直接指向可操作的审核区域", () => {
  assert.match(html, /action: '查看待确认素材'/);
  assert.match(html, /intent: 'review'/);
  assert.match(html, /if \(intent === 'review'\) showReviews\(\)/);
});

test("重新检查是始终可读的文字按钮", () => {
  const refreshButton = html.match(/<button[^>]*id="refreshButton"[^>]*>[\s\S]*?<\/button>/);
  assert.ok(refreshButton, "主页必须提供重新检查按钮");
  assert.match(refreshButton[0], />\s*重新检查\s*<\/button>/);
  assert.match(html, /qs\('refreshButton'\)\.addEventListener\('click'/);
});

test("预览会展示被动等待写入状态", () => {
  assert.match(previewHtml, /data-state="waiting">等待写完/);
  assert.match(html, /waiting: \{ title: '正在等待文件写完'/);
  assert.match(html, /文件仍在下载或写入，会保持在原位置；写完后自动重试/);
  assert.match(html, /kind: 'waiting', action: '', intent: '', icon: 'file', auto: true/);
  assert.match(html, /const locked = \['setup', 'activate', 'policy', 'empty', 'unsaved', 'running', 'waiting', 'moving', 'conflict', 'failure', 'savefailed'\]/);
  assert.match(html, /openBatchButton'\)\.disabled = \['setup', 'activate', 'empty', 'unsaved', 'running', 'moving'\]/);
});

test("预览会展示因等待 Premiere 保存而阻断的恢复状态", () => {
  assert.match(previewHtml, /data-state="savefailed">补链待保存/);
  assert.match(html, /savefailed: \{ title: 'Premiere 工程还没有确认保存'/);
  assert.match(html, /素材已在整理后的位置；请检查链接并重新保存当前工程/);
  assert.match(html, /action: '检查上次整理', intent: 'recover'/);
});
