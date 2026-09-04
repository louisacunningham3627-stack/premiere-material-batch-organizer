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
  const settingsScrollAt = html.indexOf('id="settingsScroll"');
  const backButtonAt = html.indexOf('id="closeSettingsButton"');
  const settingsPageEndAt = html.indexOf("</section>", settingsScrollAt);
  assert.ok(settingsScrollAt >= 0, "设置页必须提供唯一的滚动内容区");
  assert.ok(backButtonAt > settingsScrollAt && backButtonAt < settingsPageEndAt, "返回按钮必须放在可滚动内容流顶部");
  assert.match(html.slice(backButtonAt, backButtonAt + 260), /返回整理界面/);
  assert.doesNotMatch(html, /<header class="settings-header">[\s\S]*?id="closeSettingsButton"[\s\S]*?<\/header>/);
  assert.match(html, /id="settingsSaveStatus">自动保存/);
  assert.match(html, /id="addProtectedButton"[\s\S]*?添加不搬动文件夹/);
  assert.match(html, /id="protectedList"/);
  assert.match(html, /id="protectedListCount"/);
  assert.match(html, /id="settingsMessage" role="status" aria-live="polite"/);
  assert.doesNotMatch(html, /id="settingsDrawer"|id="drawerBackdrop"|id="protectedPathInput"|id="protectedPathOverview"|id="saveSettingsButton"/);
  assert.doesNotMatch(html, /<h3>整理方式<\/h3>|class="policy-row"/);
});

test("主页提供明确的管理入口，并把名单数量作为单独信息显示", () => {
  const control = html.match(/<button class="protection-summary" id="protectedCount"[\s\S]*?<\/button>/);
  assert.ok(control, "主页必须保留可进入管理页的按钮");
  assert.match(control[0], /<strong>不搬动文件夹<\/strong>/);
  assert.match(control[0], /<span id="protectedCountText">\d+ 个<\/span>/);
  assert.match(control[0], /<span class="protection-action">管理<\/span>/);
  assert.match(source, /setText\("protectedCountText", libraries\.length \+ " 个"\)/);
  assert.doesNotMatch(source, /protectedCountText[\s\S]{0,120}共享素材文件夹不会移动/);
});

test("设置页明确当前共享范围、连接状态和每项操作", () => {
  assert.match(html, /当前工程文件夹/);
  assert.match(html, /同一文件夹里的所有 Premiere 工程共用这份名单/);
  assert.match(html, /名单改变后，每个工程都要先确认新名单，再单独点击“开始整理此工程”/);
  assert.match(source, /还没有添加文件夹/);
  assert.match(source, /statusLabel\.textContent = status\.valid \? "可正常使用" : "需要重新选择"/);
  assert.match(source, /mapAction\.textContent = status\.valid \? "更换文件夹" : "选择本机文件夹"/);
  assert.match(source, /removeAction\.textContent = "从名单移除"/);
  assert.match(source, /path\.textContent = mapping\.rootPath/);
  assert.match(source, /setText\("protectedListCount", libraries\.length \+ " 个"\)/);
  assert.doesNotMatch(html, /data-(?:path|root-path|source-path|target-path)=/);
});

test("设置操作会在当前页反馈，缺少工程或忙碌时不会静默失败", () => {
  assert.match(source, /function setSettingsMessage\(kind, message\)/);
  assert.match(source, /请先打开并保存 Premiere 工程，才能设置这份名单/);
  assert.match(source, /素材正在整理，完成后才能修改名单/);
  assert.match(source, /projectState\.pendingTransaction \|\| projectState\.pendingProjectSave/);
  assert.match(source, /请先完成“检查文件和链接”，再修改不搬动文件夹/);
  assert.match(source, /同一工程文件夹内的所有工程已暂停，请分别确认名单后再开启/);
  assert.match(source, /setSettingsMessage\("error", panelError\)/);
  assert.match(source, /var initialBlockReason = protectedSettingsBlockReason\(\)/);
  assert.match(source, /function openSettingsPage\(\)[\s\S]{0,260}requestScan\(\{ forceContext: true \}\)/);
  assert.match(html, /openSettingsPage\(\);[\s\S]{0,120}batch-collector:refresh/);
});

test("移除前后都明确磁盘文件不会删除，而且自动整理会暂停", () => {
  assert.match(source, /从不搬动名单移除“[\s\S]{0,360}不会删除磁盘文件夹或里面的素材[\s\S]{0,120}所有工程都会暂停/);
  assert.match(source, /pauseWorkspaceProjects\(\)/);
  assert.match(source, /已从名单移除“[\s\S]{0,260}没有删除磁盘文件或素材；同一工程文件夹内的所有工程已暂停/);
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
  assert.match(source, /refreshContext\(\{ force: true \}\)[\s\S]{0,360}validateChosenProtectedFolder\(rootPath, existingLibraryId\)/);
  assert.match(source, /var currentLibrary = projectState\.protectedLibraries\.find/);
  assert.match(source, /if \(!currentLibrary\) throw new Error\("不搬动名单已经变化/);
});

test("预览提供设置页入口，返回只切换页面而不触发交接", () => {
  assert.match(previewHtml, /data-view="settings">不搬动文件夹/);
  assert.match(html, /id="closeSettingsButton"[^>]*aria-label="返回整理界面"/);
  assert.match(html, /qs\('closeSettingsButton'\)\.addEventListener\('click', closeSettingsPage\)/);
  assert.match(html, /window\.addEventListener\('batch-collector:close-settings', closeSettingsPage\)/);
  assert.match(html, /qs\('panelRoot'\)\.hidden = true/);
  assert.match(html, /qs\('panelRoot'\)\.hidden = false/);
  assert.match(html, /qs\('settingsScroll'\)\.scrollTop = 0/);
  assert.match(html, /params\.get\('view'\) === 'settings'/);
  assert.doesNotMatch(html, /closeSettingsPage[\s\S]{0,180}batch-collector:handoff/);
});

test("预览切换名单状态时会同步数量，并始终在列表项内显示完整路径", () => {
  assert.match(html, /const settingsPreviewCount = \{ empty: '0 个', connected: '1 个', unresolved: '1 个', mixed: '3 个' \}/);
  assert.match(html, /qs\('protectedListCount'\)\.textContent = settingsPreviewCount\[name\] \|\| settingsPreviewCount\.mixed/);
  const listStart = html.indexOf('<div class="protected-list" id="protectedList"');
  const listEnd = html.indexOf('id="finishProtectionButton"', listStart);
  assert.ok(listStart >= 0 && listEnd > listStart, "设置页必须直接显示当前名单");
  const listMarkup = html.slice(listStart, listEnd);
  assert.match(listMarkup, /class="protected-path">I:[^<]*【后期包 ver10\.0】/);
  assert.match(listMarkup, /这台电脑还没有选择这个文件夹/);
});

test("Premiere UXP 主界面只使用稳定的普通区块布局", () => {
  assert.doesNotMatch(html, /<(?:ul|li|details|summary)\b/i);
  assert.doesNotMatch(source, /createElement\("(?:ul|li|details|summary)"\)/);
  assert.doesNotMatch(styles, /display:\s*grid/);
});

test("主页用文字说明当前工程、整理开关、交接文件夹和重新检查动作", () => {
  assert.match(html, /class="context-label">当前工程<\/span>/);
  assert.doesNotMatch(html, /class="status-dot"/);
  assert.match(html, /class="toggle-label">自动整理<\/span>/);
  assert.doesNotMatch(styles, /\.toggle-label\s*\{[^}]*display:\s*none/s);
  assert.match(html, /id="batchHeading">当前交接文件夹<\/h2>/);
  assert.match(html, /<div class="destination-path"[^>]*>[\s\S]*?<span>磁盘位置<\/span>/);
  assert.match(html, /id="refreshButton"[^>]*>重新检查<\/button>/);
});

test("已整理统计不再暗示打开旧工程后还会重新归集", () => {
  assert.match(html, /class="batch-summary">已完成整理/);
  assert.doesNotMatch(html, /目前已有/);
  assert.match(html, /id="batchLegacyNote"[^>]*hidden>这是旧版已存在的文件夹，名称不会自动修改。<\/p>/);
  assert.match(source, /var batchLegacyNote = element\("batchLegacyNote"\)/);
  assert.match(source, /var legacyBatchName = batch && \/\^\\d\{3\}_\/\.test\(String\(batch\.name \|\| ""\)\) \? String\(batch\.name\) : "";/);
  assert.match(source, /batchLegacyNote\.hidden = !legacyBatchName;/);
  assert.match(source, /batchLegacyNote\.textContent = legacyBatchName[\s\S]*?是旧版已经创建的文件夹，本次不会改名。/);
  assert.match(styles, /\.batch-legacy-note\s*\{[^}]*color:\s*var\(--text-tertiary\);/s);
  assert.match(styles, /\.batch-legacy-note\[hidden\]\s*\{[^}]*display:\s*none\s*!important;/s);
});

test("首次使用先确认不搬动文件夹，再允许开启自动整理", () => {
  assert.match(html, /id="autoCollectControl"/);
  assert.match(html, /id="finishProtectionButton"[\s\S]*?没有需要不搬动的文件夹，继续/);
  assert.match(source, /protectedRevisionByProject/);
  assert.match(source, /machine\.v2/);
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
  assert.match(styles, /\.settings-scroll\s*\{[^}]*height:\s*100%;[^}]*overflow-y:\s*auto;/s);
  assert.ok(html.indexOf('id="closeSettingsButton"') < html.indexOf('id="settingsHeading"'));
  assert.ok(html.indexOf('id="addProtectedButton"') < html.indexOf('id="settingsWorkspacePath"'));
  assert.match(styles, /\.settings-back\s*\{[^}]*min-height:\s*36px;/s);
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
