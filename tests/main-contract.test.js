const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "..", "src", "main.js"), "utf8");

test("面板显示和隐藏时，UI 绑定与监控生命周期保持分离", () => {
  assert.match(source, /var panelVisible = false;/);
  assert.match(source, /var uiBound = false;/);
  assert.match(source, /if \(!uiBound\)\s*\{\s*uiBound = true;\s*bindUi\(\);/s);
  assert.match(source, /refreshContext\(\{ force: true \}\)/);
  assert.match(source, /function panelHide\(\)\s*\{\s*panelVisible = false;\s*stopMonitor\(false\);\s*stabilityTracker\.clear\(\);/s);
  assert.doesNotMatch(source, /if \(initialized\) return;/);
});

test("状态写入使用乐观修订号和已恢复备份的上下文", () => {
  assert.match(source, /stateRevision = loaded\.revision;/);
  assert.match(source, /expectedRevision: stateRevision/);
  assert.match(source, /recovered: stateRecoveredFromBackup/);
  assert.match(source, /MATERIAL_BATCH_STORAGE_CONFLICT/);
  assert.match(source, /MATERIAL_BATCH_STORAGE_STALE_LOCK/);
  assert.match(source, /validate:\s*function \(value\) \{ return State\.validateStoredState\(value\); \}/);
  assert.match(source, /loaded\.missing\s*\? State\.createState/);
});

test("映射重链接会在操作前后检查已记录的目标", () => {
  assert.match(source, /inspectMappingTarget\(mapping\)/);
  assert.match(source, /Transaction\.samePortableFingerprint\(mapping\.targetFingerprint, targetFingerprint\)/);
  assert.match(source, /var afterRelink = await inspectMappingTarget\(mapping\);/);
  assert.match(source, /mapping-target-unverified/);
  assert.match(source, /mapping-target-mismatch/);
  const journalStart = source.indexOf("State.beginProjectSave");
  const journalPersist = source.indexOf("await persistState();", journalStart);
  const relink = source.indexOf("await Transaction.relinkExisting", journalPersist);
  assert.ok(journalStart >= 0 && journalPersist > journalStart && relink > journalPersist);
  assert.match(source, /State\.failProjectSave/);
  assert.match(source, /State\.clearPendingProjectSave/);
  assert.match(source, /Premiere 工程还有一处补链没有确认保存/);
});

test("不稳定文件保持等待状态且不会进入文件事务", () => {
  const stabilityGate = source.indexOf("if (!group.stability || group.stability.ready !== true) continue;");
  const processCall = source.indexOf("await processGroup(group, lifecycleGeneration);");
  const transactionStart = source.indexOf("State.beginTransaction");
  const immediateVerification = source.indexOf("verifyStableFile(sourcePath, group.sourceFingerprint, lifecycleGeneration)");

  assert.ok(stabilityGate >= 0 && stabilityGate < processCall);
  assert.ok(immediateVerification >= 0 && immediateVerification < transactionStart);
  assert.match(source, /error\.code === "MATERIAL_BATCH_FILE_NOT_READY"\) continue;/);
});

test("审核操作通过不透明 ID 定位，而不信任 DOM 路径", () => {
  assert.match(source, /batch-collector:review-action/);
  assert.match(source, /candidate\.id === reviewId/);
  assert.match(source, /State\.setProjectBaselineEntry/);
  assert.match(source, /State\.removeProjectBaselineEntry/);
  assert.match(source, /State\.updateMappingTargetFingerprint/);
  assert.doesNotMatch(source, /dataset\.(?:path|sourcePath|targetPath)/);
  assert.match(source, /!ScanPolicy\.hasPortableFingerprint\(review\.targetFingerprint\)/);
  assert.match(source, /请在 Premiere 中重新链接或移除这条离线素材/);
});

test("工程重新加载失败后仍可重试，轮询会处理异步拒绝", () => {
  assert.match(source, /catch \(error\) \{\s*stateReloadRequired = true;\s*panelError = error\.message/s);
  assert.match(source, /function requestScan\(options\)[\s\S]*operationQueue\.run[\s\S]*\.catch\(function \(error\)/);
});

test("运行时统一使用兼容 UXP 的缺失路径判断", () => {
  assert.match(source, /Core\.isMissingPathError\(error\)/);
  assert.doesNotMatch(source, /function isMissingPathError\(/);
  assert.match(source, /工程路径已识别/);
  assert.doesNotMatch(source, /工程已保存/);
});

test("同一保护文件夹不能重新映射到第二个素材库 ID", () => {
  assert.match(source, /samePathMapping && samePathMapping\.libraryId !== libraryId/);
  assert.match(source, /这个目录已经在不搬动列表中/);
});

test("缺少可移植指纹的文件会成为可处理的审核项", () => {
  const unavailableGate = source.indexOf("if (!ScanPolicy.hasPortableFingerprint(group.sourceFingerprint))");
  const pendingIncrement = source.indexOf("pendingCount += 1;", unavailableGate);
  assert.ok(unavailableGate >= 0 && pendingIncrement > unavailableGate);
  assert.match(source.slice(unavailableGate, pendingIncrement), /recordReview\(group, "source-unavailable"/);
});
