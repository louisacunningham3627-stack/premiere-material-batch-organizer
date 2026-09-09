import { cp, copyFile, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { spawnSync } from "node:child_process";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const pluginDirectory = path.join(projectRoot, "plugin");
const sourceDirectory = path.join(projectRoot, "src");
const distDirectory = path.join(projectRoot, "dist");
const sourceFiles = [
  "core.js",
  "scan-policy.js",
  "state.js",
  "transaction.js",
  "recovery.js",
  "coordination.js",
  "premiere-adapter.js",
  "storage.js",
  "main.js",
  "sha256.js",
  "file-service.js",
  "recycle-bridge.js",
  "confirmation.js",
];

if (path.dirname(distDirectory) !== projectRoot || path.basename(distDirectory) !== "dist") {
  throw new Error(`拒绝替换异常路径：${distDirectory}`);
}

await rm(distDirectory, { recursive: true, force: true });
await mkdir(path.join(distDirectory, "src"), { recursive: true });
await cp(pluginDirectory, distDirectory, { recursive: true });
for (const fileName of sourceFiles) {
  await copyFile(path.join(sourceDirectory, fileName), path.join(distDirectory, "src", fileName));
}
if (process.platform === "win32") {
  const output = path.join(distDirectory, "native", "windows");
  const built = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    path.join(projectRoot, "scripts", "build-material-helper.ps1"), "-OutputDirectory", output], { encoding: "utf8", windowsHide: true });
  if (built.status !== 0) throw new Error("原生回收助手构建失败：" + built.stderr);
}

console.log(`UXP 插件构建完成：${distDirectory}`);
