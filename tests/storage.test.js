const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const Storage = require("../src/storage");
const State = require("../src/state");

async function withFolder(run) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "premiere-state-test-"));
  try {
    await run(path.join(folder, Storage.STATE_FILE_NAME));
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
}

function lockPayload({
  owner = "test-worker",
  token = "test-lock-token",
  status = "active",
  phase = status === "active" ? "writing" : "committed",
  createdAtMs,
  releasedAtMs = createdAtMs,
}) {
  const payload = {
    schemaVersion: Storage.LOCK_SCHEMA_VERSION,
    owner,
    token,
    status,
    phase,
    createdAtMs,
    createdAtUtc: new Date(createdAtMs).toISOString(),
  };
  if (status === "released") {
    payload.releasedAtMs = releasedAtMs;
    payload.releasedAtUtc = new Date(releasedAtMs).toISOString();
  }
  return payload;
}

async function writeLock(statePath, payload) {
  const json = JSON.stringify(payload);
  const padding = Storage.LOCK_RECORD_BYTES - Buffer.byteLength(json, "utf8") - 1;
  assert.ok(padding >= 0);
  await fs.writeFile(statePath + ".lock", json + " ".repeat(padding) + "\n", "utf8");
}

async function readLock(statePath) {
  return JSON.parse(await fs.readFile(statePath + ".lock", "utf8"));
}

function translateExclusiveCreateError(makeReplacement) {
  return new Proxy(fs, {
    get(target, property) {
      if (property !== "open") return target[property];
      return async (nativePath, flags, ...rest) => {
        try {
          return await target.open(nativePath, flags, ...rest);
        } catch (error) {
          if (flags === "wx" && error && error.code === "EEXIST") {
            throw makeReplacement(nativePath, error);
          }
          throw error;
        }
      };
    },
  });
}

test("仅当状态文件和备份都不存在时才报告缺失", async () => {
  await withFolder(async (statePath) => {
    const loaded = await Storage.readJsonWithBackup(fs, statePath);
    assert.deepEqual(loaded, {
      value: null,
      recovered: false,
      missing: true,
      revision: Storage.MISSING_REVISION,
    });
  });
});

test("UXP 只在消息中报告文件不存在时仍按首次使用处理", async () => {
  await withFolder(async (statePath) => {
    const uxpMissingFs = new Proxy(fs, {
      get(target, property) {
        if (property !== "readFile") return target[property];
        return async () => { throw new Error("no such file or directory"); };
      },
    });
    const loaded = await Storage.readJsonWithBackup(uxpMissingFs, statePath);
    assert.deepEqual(loaded, {
      value: null,
      recovered: false,
      missing: true,
      revision: Storage.MISSING_REVISION,
    });
  });
});

test("状态文件权限错误不会伪装成首次使用", async () => {
  await withFolder(async (statePath) => {
    const deniedFs = new Proxy(fs, {
      get(target, property) {
        if (property !== "readFile") return target[property];
        return async () => {
          const error = new Error("permission denied");
          error.code = "EACCES";
          throw error;
        };
      },
    });
    await assert.rejects(
      Storage.readJsonWithBackup(deniedFs, statePath),
      (error) => error.code === "MATERIAL_BATCH_STORAGE_CORRUPT"
        && error.primaryError.code === "EACCES"
        && error.backupError.code === "EACCES",
    );
  });
});

test("状态文件和备份都不可用时抛出明确的损坏错误", async () => {
  await withFolder(async (statePath) => {
    await fs.writeFile(statePath, "{broken", "utf8");
    await fs.writeFile(statePath + ".bak", "also broken", "utf8");
    await assert.rejects(
      Storage.readJsonWithBackup(fs, statePath),
      (error) => error.code === "MATERIAL_BATCH_STORAGE_CORRUPT"
        && /状态文件损坏/.test(error.message)
        && Boolean(error.primaryError)
        && Boolean(error.backupError),
    );
  });
});

test("主状态损坏时恢复有效备份", async () => {
  await withFolder(async (statePath) => {
    await fs.writeFile(statePath, "{broken", "utf8");
    await fs.writeFile(statePath + ".bak", JSON.stringify({ version: 7 }), "utf8");
    const loaded = await Storage.readJsonWithBackup(fs, statePath);
    assert.deepEqual(loaded.value, { version: 7 });
    assert.equal(loaded.recovered, true);
    assert.equal(loaded.missing, false);
    assert.equal(typeof loaded.revision, "string");
  });
});

test("首次原子写入会创建可恢复同一状态的永久备份", async () => {
  await withFolder(async (statePath) => {
    await Storage.writeJsonAtomic(fs, statePath, { version: 1, ready: true });
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), { version: 1, ready: true });
    assert.deepEqual(JSON.parse(await fs.readFile(statePath + ".bak", "utf8")), { version: 1, ready: true });

    await fs.writeFile(statePath, "{broken", "utf8");
    const loaded = await Storage.readJsonWithBackup(fs, statePath);
    assert.deepEqual(loaded.value, { version: 1, ready: true });
    assert.equal(loaded.recovered, true);
  });
});

test("主状态无法读取时恢复有效备份", async () => {
  await withFolder(async (statePath) => {
    await fs.writeFile(statePath + ".bak", JSON.stringify({ version: 8 }), "utf8");
    const unreadableFs = new Proxy(fs, {
      get(target, property) {
        if (property !== "readFile") return target[property];
        return async (nativePath, ...args) => {
          if (nativePath === statePath) {
            const error = new Error("access denied");
            error.code = "EACCES";
            throw error;
          }
          return target.readFile(nativePath, ...args);
        };
      },
    });
    const loaded = await Storage.readJsonWithBackup(unreadableFs, statePath);
    assert.deepEqual(loaded.value, { version: 8 });
    assert.equal(loaded.recovered, true);
    assert.equal(loaded.revision, undefined);
  });
});

test("恢复后的写入会保留有效备份，而不会轮换损坏的主状态内容", async () => {
  await withFolder(async (statePath) => {
    await Storage.writeJsonAtomic(fs, statePath, { version: 1 });
    await Storage.writeJsonAtomic(fs, statePath, { version: 2 });
    await fs.writeFile(statePath, "{corrupt", "utf8");

    const loaded = await Storage.readJsonWithBackup(fs, statePath);
    assert.deepEqual(loaded.value, { version: 1 });
    await Storage.writeJsonAtomic(
      fs,
      statePath,
      { version: 3 },
      { expectedRevision: loaded.revision, recovered: loaded.recovered },
    );

    assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), { version: 3 });
    assert.deepEqual(JSON.parse(await fs.readFile(statePath + ".bak", "utf8")), { version: 1 });
  });
});

test("原子写入将先前有效状态保留为 .bak，并留下已释放的规范锁", async () => {
  await withFolder(async (statePath) => {
    const first = await Storage.writeJsonAtomic(fs, statePath, { version: 1 });
    assert.equal(typeof first.revision, "string");
    await Storage.writeJsonAtomic(fs, statePath, { version: 2 });

    assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), { version: 2 });
    assert.deepEqual(JSON.parse(await fs.readFile(statePath + ".bak", "utf8")), { version: 1 });
    await assert.rejects(fs.lstat(statePath + ".tmp"));
    assert.equal((await readLock(statePath)).status, "released");
    assert.equal((await readLock(statePath)).phase, "committed");

    await Storage.writeJsonAtomic(fs, statePath, { version: 3 });
    assert.deepEqual(JSON.parse(await fs.readFile(statePath + ".bak", "utf8")), { version: 2 });
  });
});

test("UXP 无 code 的 File exists 异常不阻断首次写入后的立即再次写入", async () => {
  await withFolder(async (statePath) => {
    let translatedCollisions = 0;
    const uxpFs = translateExclusiveCreateError(() => {
      translatedCollisions += 1;
      return new Error("File exists");
    });
    const options = { lockRecheckWait: async () => {} };

    await Storage.writeJsonAtomic(uxpFs, statePath, { version: 1 }, options);
    await Storage.writeJsonAtomic(uxpFs, statePath, { version: 2 }, options);

    assert.equal(translatedCollisions, 1);
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), { version: 2 });
    assert.deepEqual(JSON.parse(await fs.readFile(statePath + ".bak", "utf8")), { version: 1 });
    assert.equal((await readLock(statePath)).status, "released");
    assert.equal((await readLock(statePath)).phase, "committed");
    const leftovers = (await fs.readdir(path.dirname(statePath))).filter((name) => name.includes(".lock.released-"));
    assert.deepEqual(leftovers, []);
  });
});

test("UXP 可通过 name、errno、message 或 String(error) 表达文件已存在", async (t) => {
  const variants = [
    ["name", () => Object.assign(new Error("open failed"), { name: "FileExistsError" })],
    ["文本 errno", () => Object.assign(new Error("open failed"), { errno: "EEXIST" })],
    ["数值 errno", () => Object.assign(new Error("open failed"), { errno: -4075 })],
    ["message", () => new Error("File already exists")],
    ["String(error)", () => ({ toString() { return "Error: Already exists"; } })],
  ];

  for (const [label, makeError] of variants) {
    await t.test(label, async () => {
      await withFolder(async (statePath) => {
        await Storage.writeJsonAtomic(fs, statePath, { version: 1 });
        const uxpFs = translateExclusiveCreateError(makeError);
        await Storage.writeJsonAtomic(uxpFs, statePath, { version: 2 }, { lockRecheckWait: async () => {} });
        assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), { version: 2 });
      });
    });
  }
});

test("明确的权限或 IO 错误不会因为消息提到 File exists 而被当作锁冲突", async (t) => {
  const variants = [
    ["权限错误优先", () => Object.assign(new Error("File exists"), { code: "EACCES", errno: -4075 })],
    ["无 code 的 IO 错误", () => new Error("I/O error while opening lock: File already exists")],
    ["无 code 的 IO failure", () => new Error("I/O failure while checking whether file exists")],
  ];

  for (const [label, makeError] of variants) {
    await t.test(label, async () => {
      await withFolder(async (statePath) => {
        await Storage.writeJsonAtomic(fs, statePath, { version: 1 });
        const originalLock = await fs.readFile(statePath + ".lock", "utf8");
        const failingFs = translateExclusiveCreateError(makeError);
        await assert.rejects(Storage.writeJsonAtomic(failingFs, statePath, { version: 2 }));
        assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), { version: 1 });
        assert.equal(await fs.readFile(statePath + ".lock", "utf8"), originalLock);
      });
    });
  }
});

test("乐观修订号会拒绝过期写入者，而不会覆盖较新的状态", async () => {
  await withFolder(async (statePath) => {
    await Storage.writeJsonAtomic(fs, statePath, { version: 1 });
    const snapshot = await Storage.readJsonWithBackup(fs, statePath);
    await Storage.writeJsonAtomic(fs, statePath, { version: 2 }, { expectedRevision: snapshot.revision });

    await assert.rejects(
      Storage.writeJsonAtomic(fs, statePath, { version: 3 }, { expectedRevision: snapshot.revision }),
      (error) => error.code === "MATERIAL_BATCH_STORAGE_CONFLICT",
    );
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), { version: 2 });
  });
});

test("其他进程持有存储锁时，并发写入者会失败", async () => {
  await withFolder(async (statePath) => {
    let releaseFirstWrite;
    let firstWriteStarted;
    const firstWriteGate = new Promise((resolve) => { releaseFirstWrite = resolve; });
    const started = new Promise((resolve) => { firstWriteStarted = resolve; });
    let delayed = true;
    const lockedFs = new Proxy(fs, {
      get(target, property) {
        if (property !== "writeFile") return target[property];
        return async (...args) => {
          if (delayed) {
            delayed = false;
            firstWriteStarted();
            await firstWriteGate;
          }
          return target.writeFile(...args);
        };
      },
    });

    const first = Storage.writeJsonAtomic(lockedFs, statePath, { version: 1 });
    await started;
    await assert.rejects(
      Storage.writeJsonAtomic(fs, statePath, { version: 2 }),
      (error) => error.code === "MATERIAL_BATCH_STORAGE_LOCKED",
    );
    releaseFirstWrite();
    await first;
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), { version: 1 });
  });
});

test("活动锁会记录所有者和令牌，且不能被抢占", async () => {
  await withFolder(async (statePath) => {
    const now = Date.now();
    const payload = lockPayload({
      owner: "premiere-live-owner",
      token: "live-owner-token",
      createdAtMs: now,
    });
    await writeLock(statePath, payload);

    await assert.rejects(
      Storage.writeJsonAtomic(fs, statePath, { version: 2 }, {
        now: () => now,
        lockRecheckWait: async () => {},
      }),
      (error) => error.code === "MATERIAL_BATCH_STORAGE_LOCKED"
        && error.lockReason === "active"
        && error.lockOwner === payload.owner,
    );
    assert.deepEqual(JSON.parse(await fs.readFile(statePath + ".lock", "utf8")), payload);
    await assert.rejects(fs.lstat(statePath));
  });
});

test("陈旧活动锁会以关闭方式失败，绝不写入或隔离状态", async () => {
  await withFolder(async (statePath) => {
    const now = Date.now();
    const payload = lockPayload({
      owner: "crashed-premiere",
      token: "crashed-owner-token",
      createdAtMs: now - Storage.LOCK_STALE_MS - 1000,
    });
    await writeLock(statePath, payload);
    await assert.rejects(
      Storage.writeJsonAtomic(fs, statePath, { version: 3 }, {
        expectedRevision: Storage.MISSING_REVISION,
        now: () => now,
        lockOwner: "recovery-owner",
        lockToken: "recovery-owner-token",
        lockRecheckWait: async () => { throw new Error("active lock must not enter reclaim"); },
      }),
      (error) => error.code === "MATERIAL_BATCH_STORAGE_STALE_LOCK"
        && error.lockReason === "active-stale"
        && error.lockPath === statePath + ".lock"
        && /关闭所有 Premiere 进程/.test(error.message)
        && error.message.includes(statePath + ".lock"),
    );

    assert.deepEqual(await readLock(statePath), payload);
    await assert.rejects(fs.lstat(statePath));
    const leftovers = (await fs.readdir(path.dirname(statePath))).filter((name) => name.includes(".lock.released-"));
    assert.deepEqual(leftovers, []);
  });
});

test("明确释放的锁仅在重新核对身份后才会被回收", async () => {
  await withFolder(async (statePath) => {
    const now = Date.now();
    const payload = lockPayload({
      owner: "finished-premiere",
      token: "released-owner-token",
      status: "released",
      phase: "committed",
      createdAtMs: now - 1000,
      releasedAtMs: now - 500,
    });
    await writeLock(statePath, payload);
    let rechecks = 0;

    const result = await Storage.writeJsonAtomic(fs, statePath, { version: 3 }, {
      expectedRevision: Storage.MISSING_REVISION,
      now: () => now,
      lockOwner: "next-owner",
      lockToken: "next-owner-token",
      lockRecheckWait: async () => { rechecks += 1; },
    });

    assert.equal(result.committed, true);
    assert.equal(rechecks, 1);
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), { version: 3 });
    const finalLock = await readLock(statePath);
    assert.equal(finalLock.owner, "next-owner");
    assert.equal(finalLock.token, "next-owner-token");
    assert.equal(finalLock.status, "released");
    assert.equal(finalLock.phase, "committed");
    const leftovers = (await fs.readdir(path.dirname(statePath))).filter((name) => name.includes(".lock.released-"));
    assert.deepEqual(leftovers, []);
  });
});

test("格式错误或时间来自未来的锁会以关闭方式失败，并提供可恢复原因", async () => {
  await withFolder(async (statePath) => {
    const now = Date.now();
    await fs.writeFile(statePath + ".lock", "{broken", "utf8");
    await assert.rejects(
      Storage.writeJsonAtomic(fs, statePath, { version: 4 }, {
        now: () => now,
        lockRecheckWait: async () => {},
      }),
      (error) => error.code === "MATERIAL_BATCH_STORAGE_LOCKED"
        && error.lockReason === "invalid-format"
        && /手动删除 \.lock/.test(error.message),
    );
    assert.equal(await fs.readFile(statePath + ".lock", "utf8"), "{broken");

    await fs.unlink(statePath + ".lock");
    const future = lockPayload({
      owner: "future-owner",
      token: "future-owner-token",
      createdAtMs: now + 10 * 60 * 1000,
    });
    await writeLock(statePath, future);
    await assert.rejects(
      Storage.writeJsonAtomic(fs, statePath, { version: 5 }, {
        now: () => now,
        lockRecheckWait: async () => {},
      }),
      (error) => error.code === "MATERIAL_BATCH_STORAGE_LOCKED"
        && error.lockReason === "future-time"
        && /系统时间/.test(error.message),
    );
    assert.deepEqual(JSON.parse(await fs.readFile(statePath + ".lock", "utf8")), future);
  });
});

test("两个已释放锁的回收者绝不会从同一修订号同时提交", async () => {
  await withFolder(async (statePath) => {
    const now = Date.now();
    await writeLock(statePath, lockPayload({
      owner: "released-owner",
      token: "released-race-token",
      status: "released",
      phase: "committed",
      createdAtMs: now - 2000,
      releasedAtMs: now - 1000,
    }));

    let arrivals = 0;
    let releaseRecheck;
    const recheckBarrier = new Promise((resolve) => { releaseRecheck = resolve; });
    const waitTogether = async () => {
      arrivals += 1;
      if (arrivals === 2) releaseRecheck();
      await recheckBarrier;
    };
    const common = {
      expectedRevision: Storage.MISSING_REVISION,
      now: () => now,
      lockRecheckWait: waitTogether,
    };

    const outcomes = await Promise.allSettled([
      Storage.writeJsonAtomic(fs, statePath, { writer: "A" }, {
        ...common,
        lockOwner: "owner-A",
        lockToken: "reclaimer-token-A",
      }),
      Storage.writeJsonAtomic(fs, statePath, { writer: "B" }, {
        ...common,
        lockOwner: "owner-B",
        lockToken: "reclaimer-token-B",
      }),
    ]);

    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok([
      "MATERIAL_BATCH_STORAGE_LOCKED",
      "MATERIAL_BATCH_STORAGE_CONFLICT",
    ].includes(rejected[0].reason.code));
    const stored = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.ok(stored.writer === "A" || stored.writer === "B");
    const finalLock = await readLock(statePath);
    assert.equal(finalLock.status, "released");
    assert.ok(finalLock.owner === "owner-A" || finalLock.owner === "owner-B");
  });
});

test("旧所有者通过自身句柄释放锁，绝不会触碰替换后的规范锁", async () => {
  await withFolder(async (statePath) => {
    const now = Date.now();
    const nextOwner = lockPayload({
      owner: "next-owner",
      token: "next-owner-token",
      createdAtMs: now,
    });
    let installedNextOwner = false;
    let lockWrites = 0;
    const displacedPath = statePath + ".old-owner-inode";
    const replacingFs = new Proxy(fs, {
      get(target, property) {
        if (property !== "open") return target[property];
        return async (nativePath, flags) => {
          const handle = await target.open(nativePath, flags);
          if (nativePath !== statePath + ".lock") return handle;
          return {
            write: async (...args) => {
              lockWrites += 1;
              if (lockWrites === 2) {
                await target.rename(statePath + ".lock", displacedPath);
                await writeLock(statePath, nextOwner);
                installedNextOwner = true;
              }
              return handle.write(...args);
            },
            close: () => handle.close(),
          };
        };
      },
    });

    const result = await Storage.writeJsonAtomic(replacingFs, statePath, { version: 6 }, {
      now: () => now,
      lockOwner: "old-owner",
      lockToken: "old-owner-token",
    });

    assert.equal(result.committed, true);
    assert.equal(installedNextOwner, true);
    assert.equal(lockWrites, 2);
    assert.match(result.lockReleaseWarning, /旧 owner/);
    assert.deepEqual(await readLock(statePath), nextOwner);
    assert.equal((await fs.stat(displacedPath)).size, Storage.LOCK_RECORD_BYTES);
  });
});

test("活动锁身份被替换后，所有者绝不会提升状态文件", async () => {
  await withFolder(async (statePath) => {
    const now = Date.now();
    const nextOwner = lockPayload({
      owner: "next-owner",
      token: "next-owner-token",
      createdAtMs: now,
    });
    let replaced = false;
    const replacingFs = new Proxy(fs, {
      get(target, property) {
        if (property !== "writeFile") return target[property];
        return async (nativePath, ...args) => {
          const result = await target.writeFile(nativePath, ...args);
          if (!replaced && String(nativePath).includes(".tmp-")) {
            replaced = true;
            await target.rename(statePath + ".lock", statePath + ".displaced-active");
            await writeLock(statePath, nextOwner);
          }
          return result;
        };
      },
    });

    await assert.rejects(
      Storage.writeJsonAtomic(replacingFs, statePath, { version: 6 }, {
        now: () => now,
        lockOwner: "old-owner",
        lockToken: "old-owner-token",
      }),
      (error) => error.code === "MATERIAL_BATCH_STORAGE_LOCKED"
        && error.lockReason === "ownership-lost",
    );
    assert.equal(replaced, true);
    await assert.rejects(fs.lstat(statePath));
    assert.deepEqual(await readLock(statePath), nextOwner);
  });
});

test("锁元数据兼容 UXP 风格的数字文件描述符和零值成功码", async () => {
  await withFolder(async (statePath) => {
    let nextDescriptor = 40;
    const handles = new Map();
    const numericFs = new Proxy(fs, {
      get(target, property) {
        if (property === "open") {
          return async (nativePath, flags) => {
            const handle = await target.open(nativePath, flags);
            const descriptor = nextDescriptor++;
            handles.set(descriptor, handle);
            return descriptor;
          };
        }
        if (property === "write") {
          return async (descriptor, arrayBuffer, offset, length, position) => {
            const bytes = new Uint8Array(arrayBuffer, offset, length);
            const result = await handles.get(descriptor).write(bytes, 0, bytes.byteLength, position);
            return { bytesWritten: result.bytesWritten, buffer: arrayBuffer };
          };
        }
        if (property === "close") {
          return async (descriptor) => {
            const handle = handles.get(descriptor);
            handles.delete(descriptor);
            await handle.close();
            return 0;
          };
        }
        if (property === "rename" || property === "unlink") {
          return async (...args) => {
            await target[property](...args);
            return 0;
          };
        }
        return target[property];
      },
    });

    const result = await Storage.writeJsonAtomic(numericFs, statePath, { version: 7 }, {
      lockOwner: "uxp-owner",
      lockToken: "uxp-owner-token",
    });

    assert.equal(result.committed, true);
    assert.equal(handles.size, 0);
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), { version: 7 });
    const finalLock = await readLock(statePath);
    assert.equal(finalLock.status, "released");
    assert.equal(finalLock.phase, "committed");
  });
});

test("锁清理失败不会把已提交写入误报为失败", async () => {
  await withFolder(async (statePath) => {
    let realLockHandle;
    const closeFailingFs = new Proxy(fs, {
      get(target, property) {
        if (property !== "open") return target[property];
        return async (nativePath, flags) => {
          const handle = await target.open(nativePath, flags);
          if (!nativePath.endsWith(".lock")) return handle;
          realLockHandle = handle;
          return {
            write: (...args) => handle.write(...args),
            close: async () => { throw new Error("simulated close failure"); },
          };
        };
      },
    });

    const result = await Storage.writeJsonAtomic(closeFailingFs, statePath, { version: 1 });
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), { version: 1 });
    assert.match(result.lockReleaseWarning, /关闭状态写锁失败/);
    await realLockHandle.close();
    await fs.unlink(statePath + ".lock").catch(() => {});
  });
});

test("提升后的 lstat 失败会返回已提交写入及可用警告", async () => {
  await withFolder(async (statePath) => {
    let promoted = false;
    const lstatFailingFs = new Proxy(fs, {
      get(target, property) {
        if (property === "rename") {
          return async (from, to) => {
            const result = await target.rename(from, to);
            if (to === statePath) promoted = true;
            return result;
          };
        }
        if (property !== "lstat") return target[property];
        return async (nativePath) => {
          if (promoted && nativePath === statePath) {
            const error = new Error("simulated post-promote lstat failure");
            error.code = "EIO";
            throw error;
          }
          return target.lstat(nativePath);
        };
      },
    });

    const result = await Storage.writeJsonAtomic(lstatFailingFs, statePath, { version: 9 });
    assert.equal(result.committed, true);
    assert.equal(typeof result.revision, "string");
    assert.match(result.warning, /提交后的复核失败/);
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), { version: 9 });
  });
});

test("提升后的回读失败会返回已提交写入及可用警告", async () => {
  await withFolder(async (statePath) => {
    let promoted = false;
    const readFailingFs = new Proxy(fs, {
      get(target, property) {
        if (property === "rename") {
          return async (from, to) => {
            const result = await target.rename(from, to);
            if (to === statePath) promoted = true;
            return result;
          };
        }
        if (property !== "readFile") return target[property];
        return async (nativePath, ...args) => {
          if (promoted && nativePath === statePath) {
            const error = new Error("simulated post-promote readback failure");
            error.code = "EIO";
            throw error;
          }
          return target.readFile(nativePath, ...args);
        };
      },
    });

    const result = await Storage.writeJsonAtomic(readFailingFs, statePath, { version: 10 });
    assert.equal(result.committed, true);
    assert.equal(typeof result.revision, "string");
    assert.match(result.warning, /提交后的复核失败/);
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), { version: 10 });
  });
});

test("校验器拒绝主状态时会回退到兼容备份", async () => {
  await withFolder(async (statePath) => {
    await fs.writeFile(statePath, JSON.stringify({ version: 1 }), "utf8");
    await fs.writeFile(statePath + ".bak", JSON.stringify({ version: 2 }), "utf8");

    const loaded = await Storage.readJsonWithBackup(fs, statePath, {
      validate: (value) => value && value.version === 2,
    });
    assert.deepEqual(loaded.value, { version: 2 });
    assert.equal(loaded.recovered, true);
  });
});

test("校验器拒绝两份状态时会以关闭方式失败并报告兼容性错误", async () => {
  await withFolder(async (statePath) => {
    await fs.writeFile(statePath, JSON.stringify({ version: 1 }), "utf8");
    await fs.writeFile(statePath + ".bak", JSON.stringify({ version: 2 }), "utf8");

    await assert.rejects(
      Storage.readJsonWithBackup(fs, statePath, { validate: () => false }),
      (error) => error.code === "MATERIAL_BATCH_STORAGE_CORRUPT"
        && /格式不兼容或已损坏/.test(error.message)
        && Boolean(error.primaryError)
        && Boolean(error.backupError),
    );
  });
});

test("主状态模式版本来自未来时绝不会回退或覆盖旧版备份", async () => {
  await withFolder(async (statePath) => {
    const current = State.createState("I:\\项目", new Date("2026-09-02T02:00:00.000Z"));
    const future = { ...current, schemaVersion: State.SCHEMA_VERSION + 1 };
    await fs.writeFile(statePath, JSON.stringify(future), "utf8");
    await fs.writeFile(statePath + ".bak", JSON.stringify(current), "utf8");

    await assert.rejects(
      Storage.readJsonWithBackup(fs, statePath, { validate: State.validateStoredState }),
      (error) => error.code === "MATERIAL_BATCH_STATE_SCHEMA_UNSUPPORTED",
    );
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, "utf8")), future);
    assert.deepEqual(JSON.parse(await fs.readFile(statePath + ".bak", "utf8")), current);
  });
});
