const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const html = fs.readFileSync(path.join(__dirname, "..", "plugin", "index.html"), "utf8");
const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");
const previewHtml = fs.readFileSync(path.join(__dirname, "..", "preview", "index.html"), "utf8");
const styles = fs.readFileSync(path.join(__dirname, "..", "plugin", "styles.css"), "utf8");

test("设置是独立的不搬动文件夹管理页，不再伪装成保存表单", () => {
  assert.match(html, /<section class="settings-page" id="settingsPage"/);
  assert.match(html, /id="closeSettingsButton"[\s\S]*?>[\s\S]*?返回主页/);
  assert.match(html, /id="settingsSaveStatus">自动保存/);
  assert.match(html, /id="addProtectedButton"[\s\S]*?添加不搬动文件夹/);
  assert.match(html, /id="protectedList"/);
  assert.match(html, /id="protectedListCount"/);
  assert.match(html, /id="protectedPathOverview"/);
  assert.match(html, /id="settingsMessage" role="status" aria-live="polite"/);
  assert.doesNotMatch(html, /id="settingsDrawer"|id="drawerBackdrop"|id="protectedPathInput"|id="saveSettingsButton"/);
  assert.doesNotMatch(html, /<h3>整理方式<\/h3>|class="policy-row"/);
});

test("设置页明确当前共享范围、连接状态和每项操作", () => {
  assert.match(html, /当前工程文件夹/);
  assert.match(html, /同一文件夹里的 Premiere 工程共用这份名单/);
  assert.match(source, /还没有添加文件夹/);
  assert.match(source, /statusLabel\.textContent = status\.valid \? "已连接" : "需要重新选择"/);
  assert.match(source, /mapAction\.textContent = status\.valid \? "更换位置" : "选择本机位置"/);
  assert.match(source, /removeAction\.textContent = "移除"/);
  assert.match(source, /path\.textContent = mapping\.rootPath/);
  assert.match(source, /setText\("protectedListCount", libraries\.length \+ " 个"\)/);
  assert.match(source, /overview\.textContent = libraries\.map/);
  assert.doesNotMatch(html, /data-(?:path|root-path|source-path|target-path)=/);
});

test("设置操作会在当前页反馈，缺少工程或忙碌时不会静默失败", () => {
  assert.match(source, /function setSettingsMessage\(kind, message\)/);
  assert.match(source, /请先打开并保存 Premiere 工程，再添加不搬动文件夹/);
  assert.match(source, /素材正在整理，完成后才能修改名单/);
  assert.match(source, /setSettingsMessage\("success", existingLibraryId/);
  assert.match(source, /setSettingsMessage\("error", panelError\)/);
  assert.doesNotMatch(source, /if \(!projectState \|\| busy\) return;/);
});

test("名单确认会原子保存本机设置，并按失败阶段显示固定中文提示", () => {
  assert.match(source, /setMachineSettings\(\{ protection: true, auto: false \}\)/);
  assert.match(source, /failureStage = "project-state"/);
  assert.match(source, /failureStage = "machine-settings"/);
  assert.match(source, /无法保存当前工程文件夹里的整理记录/);
  assert.match(source, /MATERIAL_BATCH_MACHINE_SETTINGS_SAVE_FAILED/);
  assert.match(source, /reportRuntimeError\("确认不搬动名单失败/);
  assert.doesNotMatch(source, /无法保存本机设置，请关闭面板后重试/);
});

test("添加范围拒绝工程上级目录、素材目录和父子重叠目录", () => {
  assert.match(source, /Core\.isPathInside\(context\.workspaceRoot, rootPath\)/);
  assert.match(source, /Core\.isPathInside\(rootPath, mediaRoot\(\)\).*Core\.isPathInside\(mediaRoot\(\), rootPath\)/);
  assert.match(source, /MATERIAL_BATCH_PROTECTED_FOLDER_OVERLAP/);
  assert.match(source, /已有路径：/);
  assert.match(source, /本次选择：/);
});

test("预览提供设置页入口，返回只切换页面而不触发交接", () => {
  assert.match(previewHtml, /data-view="settings">不搬动文件夹/);
  assert.match(html, /qs\('panelRoot'\)\.hidden = true/);
  assert.match(html, /qs\('panelRoot'\)\.hidden = false/);
  assert.match(html, /params\.get\('view'\) === 'settings'/);
  assert.doesNotMatch(html, /closeSettingsPage[\s\S]{0,180}batch-collector:handoff/);
});

test("预览切换名单状态时会同步数量和完整路径摘要", () => {
  assert.match(html, /empty: \{ count: '0 个', overview: '' \}/);
  assert.match(html, /connected: \{ count: '1 个', overview: '后期包\\nI:\\\\【后期包 ver10\.0】' \}/);
  assert.match(html, /unresolved: \{ count: '1 个', overview: '共享音效库\\n这台电脑还没有选择位置' \}/);
  assert.match(html, /qs\('protectedListCount'\)\.textContent = summary\.count/);
  assert.match(html, /qs\('protectedPathOverview'\)\.textContent = summary\.overview/);
  assert.match(html, /qs\('protectedPathOverview'\)\.hidden = !summary\.overview/);
});

test("首次使用先确认不搬动文件夹，再允许开启自动整理", () => {
  assert.match(html, /id="autoCollectControl"/);
  assert.match(html, /id="finishProtectionButton"[\s\S]*?没有需要不搬动的文件夹，继续/);
  assert.match(source, /protectedSetupByMediaSpace/);
  assert.match(source, /body\.dataset\.onboarding = onboardingStage/);
  assert.match(source, /title: "先设置不搬动文件夹"/);
  assert.match(source, /action: "设置不搬动文件夹"/);
  assert.match(source, /if \(enabled && !currentProtectionSetup\(\)\)/);
  assert.match(styles, /body\[data-onboarding="protection"\][\s\S]*\.batch-section/);
  assert.match(styles, /body\[data-onboarding="auto"\][\s\S]*\.activity-section/);
  assert.doesNotMatch(html, /id="settingsButton"/);
});

test("小面板具有自己的纵向滚动区，关键设置动作排在路径详情之前", () => {
  assert.match(styles, /\.panel\s*\{[^}]*height:\s*100vh;[^}]*overflow-y:\s*auto;/s);
  assert.match(styles, /\.settings-scroll\s*\{[^}]*overflow-y:\s*auto;/s);
  assert.ok(html.indexOf('id="addProtectedButton"') < html.indexOf('id="settingsWorkspacePath"'));
  assert.match(styles, /\.settings-header\s*\{[^}]*flex:\s*0 0 46px;/s);
  assert.match(styles, /\.settings-message\s*\{[^}]*white-space:\s*pre-wrap;/s);
});

test("UXP 页面不再使用无法稳定显示的 SVG use 引用", () => {
  assert.doesNotMatch(html, /<use\b/);
  assert.doesNotMatch(source, /<use\b/);
});

test("文件夹访问失败会转换成中文提示", () => {
  assert.match(source, /function protectedFolderErrorMessage\(error\)/);
  assert.match(source, /找不到所选文件夹/);
  assert.match(source, /没有权限读取所选文件夹/);
  assert.match(source, /Core\.toFileSystemPath\(folder\.nativePath\)/);
  assert.match(source, /rootPath: Core\.toFileSystemPath\(mapping\.rootPath\)/);
});
