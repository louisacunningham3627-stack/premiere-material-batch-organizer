(function (root, factory) {
  "use strict";
  var api = factory(typeof module !== "undefined" && module.exports ? require("./transaction") : root.MaterialBatchTransaction,
    typeof module !== "undefined" && module.exports ? require("./sha256") : root.MaterialBatchSha256);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.MaterialBatchFileService = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (Transaction, Hash) {
  "use strict";

  function createHostFileSystem(nativeFs, readIdentity) {
    var adapted = { constants: nativeFs.constants, lstatSupportsBigInt: false };
    ["lstat", "open", "close", "read", "write", "readFile", "writeFile", "mkdir", "rename", "unlink", "copyFile", "link"].forEach(function (name) {
      var method = nativeFs[name];
      if (typeof method === "function") adapted[name] = method.bind(nativeFs);
    });
    if (typeof readIdentity === "function") adapted.materialIdentity = readIdentity;
    return adapted;
  }

  async function compareFiles(options) {
    var fs = options.fs;
    var paths = [options.sourcePath, options.targetPath];
    var handles = [];
    var fingerprints = [];
    var chunkSize = 1024 * 1024;
    var hasher = Hash.createHasher();
    var pause = options.wait || function () { return new Promise(function (resolve) { setTimeout(resolve, 0); }); };
    async function validate() {
      if (options.cancelled && options.cancelled()) throw new Error("核验已取消，两处文件均未改动");
      if (options.validate && await options.validate() === false) throw new Error("工程已切换，核验已停止");
    }
    async function read(handle, length) {
      var buffer = new Uint8Array(length);
      var result;
      if (typeof handle === "number") result = await fs.read(handle, buffer.buffer, 0, length, -1);
      else if (handle && typeof handle.read === "function") result = await handle.read(buffer, 0, length, null);
      else throw new Error("当前文件系统不支持分块核验，未继续整理");
      var count = result && result.bytesRead;
      if (!Number.isInteger(count) || count < 0 || count > length) throw new Error("分块读取结果无效");
      var output = result.buffer || buffer;
      var bytes = output instanceof ArrayBuffer ? new Uint8Array(output) : new Uint8Array(output.buffer, output.byteOffset, output.byteLength);
      if (bytes.length < count) throw new Error("分块读取内容不完整");
      return bytes.subarray(0, count);
    }
    async function fill(handle, length) {
      var bytes = new Uint8Array(length);
      var offset = 0;
      while (offset < length) {
        await validate();
        var part = await read(handle, length - offset);
        if (!part.length) throw new Error("文件提前结束，未继续整理");
        bytes.set(part, offset);
        offset += part.length;
      }
      return bytes;
    }
    try {
      await validate();
      for (var path of paths) {
        var stat = await Transaction.lstatForIdentity(fs, path);
        var fingerprint = Transaction.fingerprintFromStat(stat);
        if (!stat || typeof stat.isFile !== "function" || !stat.isFile() || !Transaction.hasStrongFileIdentity(fingerprint)) {
          throw new Error("无法取得普通文件的可靠身份，未继续整理");
        }
        fingerprints.push(fingerprint);
        handles.push(await fs.open(path, "r"));
      }
      if (fingerprints[0].size !== fingerprints[1].size) throw new Error("两处文件大小不同，已保留两份文件");
      var total = fingerprints[0].size;
      if (!Number.isSafeInteger(total) || total < 0) throw new Error("文件大小无法可靠核验");
      for (var offset = 0; offset < total;) {
        var length = Math.min(chunkSize, total - offset);
        var left = await fill(handles[0], length);
        var right = await fill(handles[1], length);
        for (var i = 0; i < length; i += 1) {
          if (left[i] !== right[i]) throw new Error("两处文件内容不同，已保留两份文件");
        }
        hasher.update(left);
        offset += length;
        if (options.onProgress) options.onProgress({ checkedBytes: offset, totalBytes: total });
        await pause();
      }
      for (var index = 0; index < paths.length; index += 1) {
        if ((await read(handles[index], 1)).length) throw new Error("文件在核验期间增长，未继续整理");
        var after = Transaction.fingerprintFromStat(await Transaction.lstatForIdentity(fs, paths[index]));
        if (!Transaction.sameStrongPathFingerprint(fingerprints[index], after)) throw new Error("文件在核验期间变化，未继续整理");
      }
      await validate();
      var digest = hasher.digestHex();
      fingerprints.forEach(function (fingerprint) { fingerprint.sha256 = digest; });
      return { sourceFingerprint: fingerprints[0], targetFingerprint: fingerprints[1], byteCount: total, verifiedAt: new Date().toISOString() };
    } finally {
      var closeError = null;
      for (var handle of handles) {
        try {
          if (typeof handle === "number") await fs.close(handle);
          else await handle.close();
        } catch (error) { closeError = error; }
      }
      if (closeError) throw closeError;
    }
  }

  async function recycleSource(options, request) {
    if (typeof options.recycle !== "function") {
      var unavailable = new Error("回收站助手不可用，原素材已保留；不会永久删除");
      unavailable.code = "MATERIAL_BATCH_RECYCLE_UNAVAILABLE";
      throw unavailable;
    }
    var receipt = await options.recycle(request);
    if (!receipt || receipt.status !== "recycled" || receipt.id !== request.id || receipt.path !== request.path) {
      throw new Error("回收结果未确认，原记录已保留，禁止自动重试");
    }
    return receipt;
  }
  return { createHostFileSystem: createHostFileSystem, compareFiles: compareFiles, recycleSource: recycleSource };
});
