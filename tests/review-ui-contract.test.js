const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "plugin", "index.html"), "utf8");
const previewHtml = fs.readFileSync(path.join(__dirname, "..", "preview", "index.html"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "..", "plugin", "styles.css"), "utf8");

test("提供稳定的审核容器，操作属性中不嵌入本机路径", () => {
  assert.match(html, /id="reviewSection"/);
  assert.match(html, /id="reviewList"/);
  assert.doesNotMatch(html, /data-(?:path|source-path|target-path)=/);
});

test("保持三种实际审核操作稳定，供主进程绑定", () => {
  for (const action of ["mapping-confirm", "reveal", "retry"]) {
    assert.match(html, new RegExp(`["']${action}["']`));
  }
  assert.match(html, /dataset\.reviewAction/);
  assert.match(html, /dataset\.reviewId/);
  assert.match(html, /batch-collector:review-action/);
});

test("每种审核类型只提供其所需范围内的处理方式", () => {
  assert.match(html, /确认使用/);
  assert.match(html, /打开所在位置/);
  assert.match(html, /重新检查/);
  assert.match(html, /加入“不搬动文件夹”/);
  assert.match(html, /完整搬移关联文件夹/);
  assert.match(html, /Premiere 中重新链接/);
  assert.doesNotMatch(html, /视为原有素材/);
  assert.doesNotMatch(html, /保留外部文件/);
});

test("冲突状态会直接指向可操作的审核区域", () => {
  assert.match(html, /action: '查看需处理素材'/);
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
  assert.match(previewHtml, /data-state="savefailed">等待保存工程/);
  assert.match(html, /savefailed: \{[\s\S]*?title: 'Premiere 工程保存尚未确认'/);
  assert.match(html, /先检查素材的新位置和 Premiere 链接。检查本身不会删除文件/);
  assert.match(html, /action: '检查文件和链接',[\s\S]*?intent: 'recover'/);
});

test("恢复状态只提供核对上次整理所需的信息和操作", () => {
  assert.match(html, /<body[^>]*data-recovery="false"/);
  for (const id of [
    "recoveryDetails",
    "recoveryFilename",
    "recoverySourcePath",
    "recoveryTargetPath",
    "recoverySize",
    "recoverySourceStatus",
    "recoveryTargetStatus",
    "recoveryLinkStatus",
    "recoveryConfirmation",
    "openRecoveryTargetButton",
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /待核对文件/);
  assert.match(html, /本次核对不会删除任何磁盘文件；真正更新 Premiere 链接、保存工程或清理原位置前，都会再次确认/);
  assert.equal((html.match(/action: '检查文件和链接'/g) || []).length, 2);
  assert.match(html, /document\.body\.dataset\.recovery = recovery \? 'true' : 'false'/);
  assert.match(html, /recoveryDetails\.hidden = !recovery/);
  assert.match(html, /recoverySourceStatus'\)\.textContent = recovery\.sourceStatus/);
  assert.match(html, /recoveryTargetStatus'\)\.textContent = recovery\.targetStatus/);
  assert.match(html, /recoveryLinkStatus'\)\.textContent = recovery\.linkStatus/);
  assert.match(html, /openRecoveryTargetButton'\)\.addEventListener\('click', \(\) => window\.dispatchEvent\(new CustomEvent\('batch-collector:open-recovery-target'\)\)\)/);
});

test("移动失败和工程保存失败预览都给出具体恢复目标", () => {
  assert.match(previewHtml, /data-state="failure">上次整理未完成/);
  assert.match(html, /failure: \{[\s\S]*?recovery: \{[\s\S]*?filename: '318完整版\.mp4'[\s\S]*?source: 'C:\\\\Users\\\\剪辑师\\\\Downloads\\\\318完整版\.mp4'[\s\S]*?target: 'D:\\\\剪辑项目\\\\素材\\\\001_初始素材\\\\318完整版\.mp4'[\s\S]*?size: '5\.40 GB'/);
  assert.match(html, /savefailed: \{[\s\S]*?recovery: \{[\s\S]*?filename: '主镜头\.mov'[\s\S]*?target: 'D:\\\\剪辑项目\\\\素材\\\\2026年09月04日添加素材\\\\主镜头\.mov'[\s\S]*?size: '4\.80 GB'/);
});

test("恢复页隐藏全部普通整理入口，只保留恢复操作", () => {
  for (const id of ["batchSection", "actionSection", "protectedCount", "activityDetails", "reviewSection"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(html, /\['autoCollectControl', 'batchSection', 'actionSection', 'protectedCount', 'activityDetails', 'reviewSection'\][\s\S]*?hidden = Boolean\(recovery\)/);
  assert.match(html, /if \(recovery\) qs\('reviewSection'\)\.hidden = true/);
  for (const selector of [
    "#autoCollectControl",
    ".batch-section",
    ".action-section",
    ".protection-summary",
    ".activity-section",
    ".review-section",
  ]) {
    assert.match(styles, new RegExp(`body\\[data-recovery="true"\\][\\s\\S]*?${selector.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}[\\s\\S]*?display:\\s*none`));
  }
});

test("恢复路径在 300 像素窄面板内可完整换行", () => {
  assert.match(styles, /\.recovery-path-block code\s*\{[^}]*max-width:\s*100%;[^}]*overflow-wrap:\s*anywhere;[^}]*word-break:\s*break-word;[^}]*white-space:\s*normal;/s);
  assert.match(styles, /\.recovery-details\[hidden\], \.recovery-location-actions\[hidden\], \.recovery-open\[hidden\], \.recovery-close\[hidden\]\s*\{[^}]*display:\s*none\s*!important;/s);
});
