const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const Bridge = require("../src/recycle-bridge");
const Service = require("../src/file-service");
const enabled = process.platform === "win32" && process.env.MATERIAL_NATIVE_SMOKE === "1";

test("后台助手不经过宿主启动接口完成精确读取、真实回收、凭据复核和安全停机", { skip: !enabled, timeout: 40000 }, async () => {
  const root = path.resolve(__dirname, "../work/service-smoke");
  await fs.mkdir(root, { recursive: true });
  const folder = await fs.mkdtemp(path.join(root, "run-"));
  const native = path.join(folder, "native/windows"); await fs.mkdir(native, { recursive: true });
  const helper = path.join(native, "MaterialFileHelper.exe");
  await fs.copyFile(path.resolve(__dirname, "../work/native-candidate/MaterialFileHelper.exe"), helper);
  const token = crypto.randomBytes(32).toString("hex");
  await fs.writeFile(path.join(native, "bridge-location.json"), JSON.stringify({ directory: folder }));
  await fs.writeFile(path.join(folder, "token.txt"), token);
  const process = spawn(helper, ["--serve"], { windowsHide: true });
  const done = new Promise((resolve, reject) => { process.once("error", reject); process.once("close", resolve); });
  const readEventually = async file => {
    for (let n=0;n<100;n++) {
      try { return JSON.parse(await fs.readFile(file,"utf8")); }
      catch(e) { if(e.code!=="ENOENT" && !(e instanceof SyntaxError)) throw e; }
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw new Error("No service response: " + path.basename(file));
  };
  let session;
  try {
    session = await readEventually(path.join(folder,"service.current.json"));
    const uxp = { shell: { openExternal() { assert.fail("必须不使用外部启动授权"); }, openPath() { assert.fail("必须不使用宿主目录授权"); } } };
    const workspaceRoot = path.join(folder,"project"); await fs.mkdir(workspaceRoot);
    const sourcePath = path.join(folder,"独立测试素材.bin"), targetPath = path.join(workspaceRoot,"独立测试素材.bin");
    await fs.writeFile(sourcePath,"local-file-service-independent-fixture"); await fs.copyFile(sourcePath,targetPath);
    const statePath = path.join(workspaceRoot,".premiere-material-space.json");
    const verified = await Service.compareFiles({fs,sourcePath,targetPath});
    const request = { id:crypto.randomBytes(16).toString("hex"),path:sourcePath,targetPath,workspaceRoot,statePath,sourceFingerprint:verified.sourceFingerprint,targetFingerprint:verified.targetFingerprint };
    await fs.writeFile(statePath,JSON.stringify({pendingTransaction:{id:request.id,sourcePath,targetRelativePath:path.basename(targetPath),recycleRequest:request}}));
    const api = Bridge.create({fs,pluginPath:folder,uxp,beforeCommit:async job=>{
      await fs.writeFile(job.issuedPath,JSON.stringify({id:job.jobId,transactionId:request.id}),{flag:"wx"}); return true;
    }});
    assert.deepEqual(await api.checkAvailability(),{status:"available"});
    const exact = await api.readIdentity(sourcePath);
    assert.equal(exact.ino,String((await fs.lstat(sourcePath,{bigint:true})).ino));
    // Poll immediately to catch publishing a result before the writer closes it.
    for (let attempt = 0; attempt < 12; attempt++) {
      assert.deepEqual(await api.checkAvailability(), {status:"available"});
      assert.equal((await api.readIdentity(sourcePath)).ino, exact.ino);
    }
    // Invalid-session tickets cannot invoke even the harmless probe operation.
    const badId=crypto.randomBytes(16).toString("hex"),ticket=crypto.randomBytes(16).toString("hex");
    await fs.writeFile(path.join(folder,badId+".probe-request.json"),JSON.stringify({id:badId,token,version:1,expiresAt:Date.now()+5000}));
    await fs.writeFile(path.join(folder,ticket+".dispatch.json"),JSON.stringify({ticket,id:badId,verb:"probe",token,session:"0".repeat(32),expiresAt:Date.now()+5000}));
    const receipt=await api.recycle(request);
    assert.equal(receipt.status,"recycled");
    assert.match(receipt.receiptId,/^[0-9a-f]{64}$/);
    assert.equal((await api.recycle(request)).receiptId,receipt.receiptId);
    await assert.rejects(fs.stat(sourcePath),{code:"ENOENT"});
    await assert.rejects(fs.stat(path.join(folder,badId+".probe-result.json")),{code:"ENOENT"});
    assert.equal(await fs.readFile(targetPath,"utf8"),"local-file-service-independent-fixture");
  } finally {
    if(session) {
      await fs.writeFile(path.join(folder,"service-"+session.session+".stop.json"),JSON.stringify({token,session:session.session}));
      await readEventually(path.join(folder,"service-"+session.session+".stopped.json"));
      assert.equal(await done,0);
    } else { process.kill(); await done; }
  }
});
