const test = require("node:test");
const assert = require("node:assert/strict");
const ScanPolicy = require("../src/scan-policy");

test("文件必须在多次扫描间保持不变后才可处理", () => {
  const tracker = ScanPolicy.createStabilityTracker({ stableForMs: 8000, minimumAgeMs: 5000 });
  const path = "C:\\Downloads\\large.mp4";
  const fingerprint = { size: 1000, mtimeMs: 1000, ctimeMs: 1000 };

  assert.equal(tracker.observe(path, fingerprint, 10000).ready, false);
  assert.equal(tracker.observe(path, fingerprint, 17000).ready, false);
  assert.equal(tracker.observe(path, fingerprint, 18000).ready, true);
});

test("文件发生变化时重新计算稳定窗口，而不是判定失败", () => {
  const tracker = ScanPolicy.createStabilityTracker({ stableForMs: 8000, minimumAgeMs: 5000 });
  const path = "C:\\Downloads\\large.mp4";

  tracker.observe(path, { size: 1000, mtimeMs: 1000 }, 10000);
  assert.equal(tracker.observe(path, { size: 2000, mtimeMs: 12000 }, 17000).ready, false);
  assert.equal(tracker.observe(path, { size: 2000, mtimeMs: 12000 }, 24000).ready, false);
  assert.equal(tracker.observe(path, { size: 2000, mtimeMs: 12000 }, 25000).ready, true);
});

test("缺少修改时间的文件绝不会被信任并自动删除", () => {
  const tracker = ScanPolicy.createStabilityTracker({ stableForMs: 1000, minimumAgeMs: 1000 });
  const outcome = tracker.observe("C:\\Downloads\\unknown.mov", { size: 500 }, 10000);

  assert.deepEqual(outcome, { ready: false, status: "unverifiable", stableForMs: 0 });
});

test("映射目标必须具有已存储且匹配的可移植指纹", () => {
  const actual = { size: 1024, mtimeMs: 9000, ino: 77 };

  assert.equal(ScanPolicy.mappingTargetStatus({}, true, actual), "unverified");
  assert.equal(ScanPolicy.mappingTargetStatus({ targetFingerprint: actual }, false, null), "missing");
  assert.equal(ScanPolicy.mappingTargetStatus({ targetFingerprint: actual }, true, { size: 1024 }), "unavailable");
  assert.equal(ScanPolicy.mappingTargetStatus({ targetFingerprint: actual }, true, { size: 2048, mtimeMs: 9000 }), "mismatch");
  assert.equal(ScanPolicy.mappingTargetStatus({ targetFingerprint: actual }, true, { size: 1024, mtimeMs: 9000, ino: 99 }), "match");
});

test("只有面板可见且工程解析完整时才会监控", () => {
  const ready = {
    panelVisible: true,
    autoEnabled: true,
    hasProject: true,
    pendingTransaction: false,
    pendingProjectSave: false,
    unresolvedProtectedCount: 0,
  };

  assert.equal(ScanPolicy.shouldMonitor(ready), true);
  assert.equal(ScanPolicy.shouldMonitor({ ...ready, panelVisible: false }), false);
  assert.equal(ScanPolicy.shouldMonitor({ ...ready, autoEnabled: false }), false);
  assert.equal(ScanPolicy.shouldMonitor({ ...ready, pendingTransaction: true }), false);
  assert.equal(ScanPolicy.shouldMonitor({ ...ready, pendingProjectSave: true }), false);
  assert.equal(ScanPolicy.shouldMonitor({ ...ready, unresolvedProtectedCount: 1 }), false);
});

test("只有当前工作区内实际存在的保护目录才可使用", async () => {
  const stats = new Map([
    ["D:\\Libraries\\Music", { isDirectory: () => true }],
    ["D:\\Libraries\\NotAFolder.wav", { isDirectory: () => false }],
  ]);
  const fakeFs = {
    async lstat(nativePath) {
      if (!stats.has(nativePath)) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      return stats.get(nativePath);
    },
  };
  const libraries = [
    { libraryId: "music", label: "音乐库" },
    { libraryId: "missing", label: "丢失库" },
    { libraryId: "file", label: "错误路径" },
    { libraryId: "relative", label: "相对路径" },
  ];
  const mappings = [
    { libraryId: "music", rootPath: "D:\\Libraries\\Music" },
    { libraryId: "missing", rootPath: "D:\\Libraries\\Gone" },
    { libraryId: "file", rootPath: "D:\\Libraries\\NotAFolder.wav" },
    { libraryId: "relative", rootPath: "Libraries\\Relative" },
    { libraryId: "other-workspace", rootPath: "D:\\Libraries\\Other" },
  ];

  const result = await ScanPolicy.validateProtectedMappings(fakeFs, libraries, mappings, {
    mediaRoot: "E:\\Project\\素材",
  });

  assert.deepEqual(result.validMappings.map((mapping) => mapping.libraryId), ["music"]);
  assert.deepEqual(result.unresolved.map((library) => library.libraryId), ["missing", "file", "relative"]);
  assert.equal(Object.hasOwn(result.statusById, "other-workspace"), false);
});

test("受管素材目录不能同时作为保护素材库", async () => {
  let statCalls = 0;
  const result = await ScanPolicy.validateProtectedMappings({
    async lstat() {
      statCalls += 1;
      return { isDirectory: () => true };
    },
  }, [{ libraryId: "managed", label: "素材" }], [{
    libraryId: "managed",
    rootPath: "E:\\Project\\素材\\Shared",
  }], { mediaRoot: "E:\\Project\\素材" });

  assert.equal(result.validMappings.length, 0);
  assert.match(result.unresolved[0].reason, /已经整理的素材目录/);
  assert.equal(statCalls, 0);
});

test("旧版保护素材库 ID 不能静默共用同一本地文件夹", async () => {
  const fakeFs = {
    async lstat() {
      return { isDirectory: () => true };
    },
  };
  const libraries = [
    { libraryId: "library-a", label: "后期包 A" },
    { libraryId: "library-b", label: "后期包 B" },
  ];
  const mappings = [
    { libraryId: "library-a", rootPath: "D:\\Libraries\\Shared" },
    { libraryId: "library-b", rootPath: "d:\\libraries\\shared\\" },
  ];

  const result = await ScanPolicy.validateProtectedMappings(fakeFs, libraries, mappings, {
    mediaRoot: "E:\\Project\\素材",
  });

  assert.deepEqual(result.validMappings.map((mapping) => mapping.libraryId), ["library-a"]);
  assert.deepEqual(result.unresolved.map((library) => library.libraryId), ["library-b"]);
  assert.match(result.unresolved[0].reason, /另一个不搬动素材库/);
});
