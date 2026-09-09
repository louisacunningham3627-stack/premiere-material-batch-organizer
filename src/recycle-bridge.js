(function (root, factory) {
  "use strict";
  var api = factory(typeof module !== "undefined" && module.exports ? require("./core") : root.MaterialBatchCore);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MaterialBatchRecycleBridge = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Core) {
  "use strict";

  var SCHEME = "hechao-material-recycle";
  var MAX_LIFETIME_MS = 6 * 60 * 60 * 1000;
  var COMMIT_WINDOW_MS = 1500;

  function text(value) { return value == null ? "" : String(value); }
  function join(dir, name) {
    return text(dir).replace(/[\\/]+$/, "") + "\\" + text(name).replace(/^[\\/]+/, "");
  }
  function issuedCredentialPath(request, jobId) {
    return join(join(request.workspaceRoot, ".premiere-material-recycle"), jobId + ".issued");
  }
  async function ensureDirectory(fs, nativePath) {
    if (!fs || typeof fs.mkdir !== "function") return;
    try { await fs.mkdir(nativePath, { recursive: true }); }
    catch (error) {
      if (!(await exists(fs, nativePath))) throw error;
    }
  }
  async function removeCompletedCredential(fs, request, jobId) {
    if (!fs || typeof fs.unlink !== "function") return;
    var paths = [
      issuedCredentialPath(request, jobId),
      request.statePath + ".recycle-" + jobId + ".issued",
    ];
    for (var index = 0; index < paths.length; index += 1) {
      try { if (await exists(fs, paths[index])) await fs.unlink(paths[index]); } catch (_) {}
    }
  }
  function plainPath(value) {
    var path = text(value).trim();
    return /^[A-Za-z]:\\/.test(path) && path.indexOf("/") < 0 && path.indexOf(":", 2) < 0
      && !/(?:^|[\\])\.\.?(?:[\\]|$)/.test(path);
  }
  function id(value) {
    var result = text(value).toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(result)) throw new Error("素材回收请求身份无效");
    return result;
  }
  function finite(value, allowZero) {
    var number = Number(value);
    return Number.isFinite(number) && (allowZero ? number >= 0 : number > 0);
  }
  function fingerprint(value) {
    var item = value && typeof value === "object" ? value : {};
    if (!finite(item.size, true) || !finite(item.mtimeMs, false) || !finite(item.birthtimeMs, false)
      || !/^[0-9a-f]{64}$/i.test(text(item.sha256))
      || !/^\d+$/.test(text(item.dev)) || !/^[1-9]\d*$/.test(text(item.ino))) {
      throw new Error("素材回收请求缺少完整文件指纹");
    }
    return {
      size: Number(item.size), mtimeMs: Number(item.mtimeMs), birthtimeMs: Number(item.birthtimeMs),
      sha256: text(item.sha256).toLowerCase(),
      dev: item.dev == null ? "" : text(item.dev), ino: item.ino == null ? "" : text(item.ino),
    };
  }
  function validateRequest(request) {
    if (!request || typeof request !== "object") throw new Error("素材回收请求无效");
    var result = Object.assign({}, request, { id: id(request.id) });
    ["path", "targetPath", "workspaceRoot", "statePath"].forEach(function (field) {
      if (!plainPath(result[field])) throw new Error("素材回收路径无效：" + field);
    });
    if (result.path.toLowerCase() === result.targetPath.toLowerCase()) throw new Error("回收源和目标不能相同");
    result.sourceFingerprint = fingerprint(result.sourceFingerprint);
    result.targetFingerprint = fingerprint(result.targetFingerprint);
    return result;
  }
  function exists(fs, path) {
    return fs.lstat(path).then(function () { return true; }, function (error) {
      if (Core.isMissingPathError(error)) return false;
      throw error;
    });
  }
  async function readJson(fs, path) {
    return JSON.parse(String(await fs.readFile(path, { encoding: "utf-8" })));
  }
  async function writeNew(fs, path, value) {
    await fs.writeFile(path, JSON.stringify(value), { encoding: "utf-8", flag: "wx" });
  }
  function defaultWait(milliseconds) {
    return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
  }
  function statSignature(stat) {
    var value = stat || {};
    return ["size", "mtimeMs", "birthtimeMs", "dev", "ino"].map(function (field) {
      var item = value[field];
      if (item instanceof Date) item = item.getTime();
      return text(item);
    }).join(":");
  }
  function compareStat(stat, expected) {
    var value = stat || {};
    var size = Number(value.size);
    var mtime = value.mtimeMs != null ? Number(value.mtimeMs) : Number(value.mtime && new Date(value.mtime).getTime());
    var birth = value.birthtimeMs != null ? Number(value.birthtimeMs) : Number(value.birthtime && new Date(value.birthtime).getTime());
    return Number.isFinite(size) && size === expected.size && Number.isFinite(mtime) && mtime === expected.mtimeMs
      && Number.isFinite(birth) && birth === expected.birthtimeMs
      && (!expected.dev || text(value.dev) === expected.dev) && (!expected.ino || text(value.ino) === expected.ino);
  }
  function protocolError(code, message, details) {
    var error = new Error(message);
    error.code = code;
    if (details) Object.assign(error, details);
    return error;
  }
  function create(options) {
    options = options || {};
    var fs = options.fs;
    if (!fs || typeof fs.readFile !== "function" || typeof fs.writeFile !== "function" || typeof fs.lstat !== "function") {
      throw new Error("素材回收桥接缺少文件接口");
    }
    var wait = typeof options.wait === "function" ? options.wait : defaultWait;
    var now = typeof options.now === "function" ? options.now : Date.now;
    async function bridge() {
      if (typeof options.bridge === "function") return options.bridge();
      var locationPath = join(options.pluginPath, "native\\windows\\bridge-location.json");
      var location = JSON.parse(String(await fs.readFile(locationPath, { encoding: "utf-8" })));
      var directory = text(location.directory).trim();
      if (!plainPath(directory)) throw new Error("素材回收 Bridge 目录无效");
      var token = text(await fs.readFile(join(directory, "token.txt"), { encoding: "utf-8" })).trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(token)) throw new Error("素材回收助手凭据无效");
      return { directory: directory, token: token };
    }
    async function launch(uri) {
      if (typeof options.launch === "function") return options.launch(uri);
      var match = /^hechao-material-recycle:\/\/(job|query|probe|identity|reveal)\/([0-9a-f]{32})$/.exec(uri);
      if (!match) throw protocolError("MATERIAL_RECYCLE_PROTOCOL", "本地助手请求类型无效");
      var info = await bridge();
      var service;
      try { service = await readJson(fs, join(info.directory, "service.current.json")); }
      catch (_) { throw protocolError("MATERIAL_RECYCLE_LAUNCH_FAILED", "本地文件助手未启动，请运行插件安装器修复；原文件保留"); }
      if (service.token !== info.token || !/^[0-9a-f]{32}$/.test(text(service.session)) || service.version !== 1
        || (options.pluginPath && !Core.samePath(service.executable, join(options.pluginPath, "native\\windows\\MaterialFileHelper.exe"))))
        throw protocolError("MATERIAL_RECYCLE_PROTOCOL", "本地文件助手身份或版本不匹配，素材未处理");
      var ticket = Array.from({ length: 4 }, function () { return Math.floor(Math.random() * 4294967296).toString(16).padStart(8, "0"); }).join("");
      var prefix = join(info.directory, ticket), deadline = now() + 10000;
      await writeNew(fs, prefix + ".dispatch.json", { ticket: ticket, id: match[2], verb: match[1], token: info.token, session: service.session, expiresAt: deadline });
      while (now() <= deadline) {
        if (options.cancelled && options.cancelled()) throw protocolError("MATERIAL_RECYCLE_CANCELLED", "操作已取消，未继续处理");
        if (await exists(fs, prefix + ".dispatch-result.json")) {
          var response = await readJson(fs, prefix + ".dispatch-result.json");
          if (response.ticket !== ticket || response.id !== match[2] || response.verb !== match[1] || response.token !== info.token || response.session !== service.session || response.status !== "dispatched")
            throw protocolError("MATERIAL_RECYCLE_PROTOCOL", "本地助手响应身份不匹配");
          return;
        }
        await wait(100);
      }
      throw protocolError("MATERIAL_RECYCLE_LAUNCH_FAILED", "本地文件助手未运行或正在忙，原文件保留；请运行插件安装器修复助手");
    }
    async function poll(job, bridgeInfo) {
      var deadline = job.expiresAt;
      var readyPath = job.prefix + ".ready.json";
      var resultPath = job.prefix + ".result.json";
      var commitPath = job.prefix + ".commit.json";
      var ready = null;
      var lastActivity = now();
      var lastProgress = "";
      while (now() <= deadline) {
        if (!job.committed && options.cancelled && options.cancelled()) {
          if (!(await exists(fs, job.prefix + ".cancel"))) await writeNew(fs, job.prefix + ".cancel", { id: job.id });
          throw protocolError("MATERIAL_RECYCLE_CANCELLED", "核验已取消，未提交回收");
        }
        var reconciledPath = job.prefix + ".reconciled.json";
        var currentResultPath = await exists(fs, reconciledPath) ? reconciledPath : resultPath;
        if (await exists(fs, currentResultPath)) {
          var result = await readJson(fs, currentResultPath);
          if (text(result.id) !== job.id || text(result.token) !== bridgeInfo.token || text(result.path) !== job.request.path) {
            throw protocolError("MATERIAL_RECYCLE_PROTOCOL", "素材回收响应身份不匹配");
          }
          if (result.status === "recycled" && (!text(result.receiptId) || !/^[0-9a-f]{64}$/i.test(text(result.receiptId)))) {
            throw protocolError("MATERIAL_RECYCLE_PROTOCOL", "素材回收缺少可核对的回收站凭据");
          }
          if (result.status === "uncertain") throw protocolError("MATERIAL_RECYCLE_UNCERTAIN", text(result.message || "回收结果不确定"), { committed: true });
          if (result.status !== "recycled") throw protocolError("MATERIAL_RECYCLE_FAILED", text(result.message || "回收失败"), {
            win32Error: Number(result.win32Error) || 0, failureKind: text(result.failureKind), committed: false,
          });
          if (result.status === "recycled") await removeCompletedCredential(fs, job.request, job.id);
          return result;
        }
        if (!job.committed && !ready && await exists(fs, readyPath)) {
          ready = await readJson(fs, readyPath);
          if (text(ready.id) !== job.id || text(ready.token) !== bridgeInfo.token || ready.status !== "ready") {
            throw protocolError("MATERIAL_RECYCLE_PROTOCOL", "素材回收 ready 响应身份不匹配");
          }
          if (typeof options.validate === "function" && (await options.validate()) === false) {
            throw protocolError("MATERIAL_RECYCLE_CANCELLED", "回收前工程状态已变化");
          }
          var issuedPath = issuedCredentialPath(job.request, job.id);
          var credential = typeof options.beforeCommit === "function"
            ? await options.beforeCommit({ jobId: job.id, request: job.request, ready: ready, receiptId: "", issuedPath: issuedPath }) : null;
          if (credential === false) throw protocolError("MATERIAL_RECYCLE_CANCELLED", "回收最终确认未通过");
          var at = now();
          if (typeof options.validate === "function" && await options.validate() === false) throw protocolError("MATERIAL_RECYCLE_CANCELLED", "提交前工程状态已变化");
          if (at > deadline - COMMIT_WINDOW_MS) {
            throw protocolError("MATERIAL_RECYCLE_EXPIRED", "素材回收最终确认已过期");
          }
          await ensureDirectory(fs, join(job.request.workspaceRoot, ".premiere-material-recycle"));
          job.committed = true;
          await writeNew(fs, commitPath, { id: job.id, token: bridgeInfo.token, at: at, statePath: job.request.statePath, issuedPath: issuedPath, credential: credential || null });
          if (typeof options.onProgress === "function") options.onProgress("committed", { id: job.id, path: job.request.path });
        }
        if (typeof options.onProgress === "function") {
          var progress = { id: job.id, path: job.request.path };
          try { if (await exists(fs, job.prefix + ".progress.json")) progress = await readJson(fs, job.prefix + ".progress.json"); } catch (_) {}
          options.onProgress(job.committed ? "committed" : ready ? "ready" : "waiting", progress);
        }
        if (!job.committed && !ready) {
          var activity = "";
          try {
            if (await exists(fs, job.prefix + ".progress.json")) activity = JSON.stringify(await readJson(fs, job.prefix + ".progress.json"));
          } catch (_) {}
          if (activity && activity !== lastProgress) { lastProgress = activity; lastActivity = now(); }
          if (now() - lastActivity > 30000) throw protocolError("MATERIAL_RECYCLE_NOT_COMMITTED", "回收助手 30 秒内未响应或核验停滞，原文件保留，可稍后重试", { committed: false, id: job.id });
        }
        await wait(100);
      }
      if (job.committed) throw protocolError("MATERIAL_RECYCLE_UNCERTAIN", "回收已提交但结果未确认；禁止自动重发", { committed: true, id: job.id });
      throw protocolError("MATERIAL_RECYCLE_NOT_COMMITTED", "回收助手未响应，未提交回收", { committed: false, id: job.id });
    }
    async function readIdentity(path) {
      if (!plainPath(path)) throw new Error("文件身份路径无效");
      var info = await bridge(), jobId = Array.from({ length: 4 }, function () { return Math.floor(Math.random() * 4294967296).toString(16).padStart(8, "0"); }).join("");
      var prefix = join(info.directory, jobId), deadline = now() + 15000;
      await writeNew(fs, prefix + ".identity-request.json", { id: jobId, token: info.token, version: 1, path: path, expiresAt: deadline });
      await launch(SCHEME + "://identity/" + jobId);
      while (now() <= deadline) {
        if (await exists(fs, prefix + ".identity-result.json")) {
          var response = await readJson(fs, prefix + ".identity-result.json");
          if (response.id !== jobId || response.token !== info.token || response.path !== path || response.status !== "identified"
            || !/^[1-9]\d*$/.test(response.ino) || !/^[1-9]\d*$/.test(response.dev)) throw new Error("原生文件身份响应不匹配");
          return response;
        }
        await wait(100);
      }
      throw new Error("原生文件身份助手未响应，素材未处理");
    }
    async function revealDirectory(directory) {
      if (!plainPath(directory)) throw new Error("文件夹路径无效");
      var info = await bridge();
      var jobId = Array.from({ length: 4 }, function () { return Math.floor(Math.random() * 4294967296).toString(16).padStart(8, "0"); }).join("");
      var prefix = join(info.directory, jobId), deadline = now() + 15000;
      await writeNew(fs, prefix + ".reveal-request.json", { id: jobId, token: info.token, version: 1, directory: directory, expiresAt: deadline });
      await launch(SCHEME + "://reveal/" + jobId);
      while (now() <= deadline) {
        if (await exists(fs, prefix + ".reveal-result.json")) {
          var response = await readJson(fs, prefix + ".reveal-result.json");
          if (response.id !== jobId || response.token !== info.token || response.status !== "opened")
            throw new Error("打开文件夹的助手响应不匹配");
          return;
        }
        await wait(100);
      }
      throw new Error("打开文件夹的助手未响应，文件未改动");
    }
    async function checkAvailability() {
      var info = await bridge();
      var probeId = Array.from({ length: 4 }, function () { return Math.floor(Math.random() * 4294967296).toString(16).padStart(8, "0"); }).join("");
      var prefix = join(info.directory, probeId);
      var deadline = now() + 15000;
      await writeNew(fs, prefix + ".probe-request.json", { id: probeId, token: info.token, version: 1, expiresAt: deadline });
      await launch(SCHEME + "://probe/" + probeId);
      while (now() <= deadline) {
        if (options.cancelled && options.cancelled()) throw protocolError("MATERIAL_RECYCLE_CANCELLED", "助手检查已取消，素材未处理");
        if (await exists(fs, prefix + ".probe-result.json")) {
          var response = await readJson(fs, prefix + ".probe-result.json");
          if (response.id !== probeId || response.token !== info.token || response.version !== 1 || response.status !== "available")
            throw protocolError("MATERIAL_RECYCLE_PROTOCOL", "助手检查响应不匹配，素材未处理");
          return { status: "available" };
        }
        await wait(100);
      }
      throw protocolError("MATERIAL_RECYCLE_NOT_COMMITTED", "系统回收助手未响应，请重新安装当前版本；素材未处理");
    }
    async function recycle(rawRequest) {
      var request = validateRequest(rawRequest);
      if (typeof options.validate === "function" && (await options.validate()) === false) {
        throw protocolError("MATERIAL_RECYCLE_CANCELLED", "回收前工程状态已变化");
      }
      var bridgeInfo = await bridge();
      var expiresAt = now() + MAX_LIFETIME_MS;
      var prefix = join(bridgeInfo.directory, request.id);
      var requestPath = prefix + ".request.json";
      if (await exists(fs, prefix + ".reconciled.json") || await exists(fs, prefix + ".result.json")) {
        return poll({ id: request.id, prefix: prefix, request: request, expiresAt: expiresAt, committed: true }, bridgeInfo);
      }
      if (await exists(fs, prefix + ".commit.json")) {
        return poll({ id: request.id, prefix: prefix, request: request, expiresAt: expiresAt, committed: true }, bridgeInfo);
      }
      if (await exists(fs, requestPath)) throw protocolError("MATERIAL_RECYCLE_REQUEST_EXISTS", "旧回收请求仍在，未覆盖或重发");
      var payload = Object.assign({}, request, { version: 1, token: bridgeInfo.token, expiresAt: expiresAt });
      await writeNew(fs, requestPath, payload);
      var job = { id: request.id, prefix: prefix, request: request, expiresAt: expiresAt, committed: false };
      try {
        await launch(SCHEME + "://job/" + request.id);
        return await poll(job, bridgeInfo);
      }
      catch (error) {
        if (!job.committed) {
          try { if (!(await exists(fs, prefix + ".cancel"))) await writeNew(fs, prefix + ".cancel", { id: request.id }); } catch (_) {}
        }
        throw error;
      }
    }
    async function query(rawRequest) {
      var request = validateRequest(rawRequest);
      var bridgeInfo = await bridge();
      var prefix = join(bridgeInfo.directory, request.id);
      for (var suffix of [".reconciled.json", ".result.json", ".commit.json", ".ready.json", ".request.json"]) {
        var path = prefix + suffix;
        if (await exists(fs, path)) {
          var value = await readJson(fs, path);
          if (text(value.id) !== request.id || text(value.token) !== bridgeInfo.token) throw protocolError("MATERIAL_RECYCLE_PROTOCOL", "旧回收请求身份不匹配");
          if ((suffix === ".result.json" || suffix === ".reconciled.json") && text(value.path) !== request.path)
            throw protocolError("MATERIAL_RECYCLE_PROTOCOL", "回收结果路径不匹配");
          if (suffix === ".commit.json" || ((suffix === ".result.json" || suffix === ".reconciled.json") && value.status === "uncertain")) {
            await launch(SCHEME + "://query/" + request.id);
            var queryDeadline = now() + MAX_LIFETIME_MS;
            var activityAt = now(), lastQueryProgress = "";
            while (now() < queryDeadline) {
              if (await exists(fs, prefix + ".reconciled.json")) {
                var checked = await readJson(fs, prefix + ".reconciled.json");
                if (text(checked.id) !== request.id || text(checked.token) !== bridgeInfo.token || text(checked.path) !== request.path)
                  throw protocolError("MATERIAL_RECYCLE_PROTOCOL", "恢复回执身份不匹配");
                if (suffix !== ".reconciled.json" || JSON.stringify(checked) !== JSON.stringify(value)) return { state: "result", value: checked };
              }
              var queryProgress = "";
              try { if (await exists(fs, prefix + ".progress.json")) queryProgress = String(await fs.readFile(prefix + ".progress.json", { encoding: "utf-8" })); } catch (_) {}
              if (queryProgress && queryProgress !== lastQueryProgress) {
                activityAt = now(); lastQueryProgress = queryProgress;
                if (options.onProgress) { try { options.onProgress("committed", JSON.parse(queryProgress)); } catch (_) {} }
              }
              if (now() - activityAt > 30000) break;
              await wait(100);
            }
            throw protocolError("MATERIAL_RECYCLE_UNCERTAIN", "回收结果核对尚未完成，未重复回收", { committed: true });
          }
          if ((suffix === ".ready.json" || suffix === ".request.json") && await exists(fs, prefix + ".cancel")) {
            return { state: "cancelled", value: { status: "cancelled", message: "旧请求已取消且未提交回收" } };
          }
          return { state: suffix === ".reconciled.json" ? "result" : suffix.slice(1, -5), value: value };
        }
      }
      return { state: "missing", value: null };
    }
    return { recycle: recycle, query: query, checkAvailability: checkAvailability, revealDirectory: revealDirectory, readIdentity: readIdentity };
  }
  return { SCHEME: SCHEME, MAX_LIFETIME_MS: MAX_LIFETIME_MS, create: create, validateRequest: validateRequest, compareStat: compareStat, statSignature: statSignature };
});
