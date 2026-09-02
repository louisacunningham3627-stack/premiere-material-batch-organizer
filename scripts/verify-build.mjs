import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
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
];

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function digest(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

const manifest = JSON.parse(await readFile(path.join(distDirectory, "manifest.json"), "utf8"));
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
assert.equal(manifest.manifestVersion, 5);
assert.equal(manifest.host.app, "premierepro");
assert.equal(manifest.host.minVersion, "25.6.0");
assert.equal(manifest.requiredPermissions.localFileSystem, "fullAccess");
assert.deepEqual(manifest.requiredPermissions.launchProcess.schemes, ["file"]);
assert.equal(manifest.entrypoints[0].id, "materialBatchOrganizer");
assert.equal(manifest.version, packageJson.version);

const requiredFiles = [
  "index.html",
  "styles.css",
  "icons/dark.svg",
  "icons/light.svg",
  ...sourceFiles.map((fileName) => `src/${fileName}`),
];
for (const relativePath of requiredFiles) {
  assert.equal(await exists(path.join(distDirectory, relativePath)), true, `缺少文件：${relativePath}`);
}

for (const fileName of sourceFiles) {
  assert.equal(
    await digest(path.join(projectRoot, "src", fileName)),
    await digest(path.join(distDirectory, "src", fileName)),
    `dist/src/${fileName} 与源码不一致`,
  );
}

const html = await readFile(path.join(distDirectory, "index.html"), "utf8");
const mainSource = await readFile(path.join(distDirectory, "src", "main.js"), "utf8");
const transactionSource = await readFile(path.join(distDirectory, "src", "transaction.js"), "utf8");
for (const fileName of sourceFiles) {
  assert.match(html, new RegExp(`<script\\s+src=["']src/${fileName.replace(".", "\\.")}["']`));
}
for (const id of new Set([...mainSource.matchAll(/element\("([^"]+)"\)/g)].map((match) => match[1]))) {
  assert.match(html, new RegExp(`id=["']${id}["']`), `缺少界面元素：#${id}`);
}

assert.doesNotMatch(mainSource, /require\(["']path["']\)/, "UXP 不得加载 Node 的 path 模块");
assert.match(mainSource, /fs\.lstat\s*\(/, "稳定性检查必须使用 fs.lstat");
assert.match(mainSource, /deleteSource:\s*true/, "整理操作必须请求删除源文件");
assert.doesNotMatch(mainSource, /deleteSourceByMediaSpace|currentDeleteSourceSetting/, "不得把保留源文件设为可配置项");
assert.match(html, /整理后，原位置不保留文件/, "设置中必须显示固定移动策略");
assert.doesNotMatch(html, /id=["']deleteSourceToggle["']/, "固定移动策略不得提供关闭开关");
assert.match(transactionSource, /fs\.copyFile\s*\(/);
assert.match(transactionSource, /fs\.unlink\s*\(/);
assert.match(transactionSource, /MATERIAL_BATCH_RETAIN_SOURCE_BLOCKED/, "文件事务层必须拒绝保留源文件");
assert.match(transactionSource, /pending-delete/, "跨盘清理必须使用当前事务专属的隔离路径");
assert.match(mainSource, /cleanupPath:\s*cleanupPath/, "必须持久化清理路径以支持恢复");
assert.match(await readFile(path.join(distDirectory, "src", "premiere-adapter.js"), "utf8"), /getRootItem\s*\(/);

const topLevel = (await readdir(distDirectory)).sort();
assert.deepEqual(topLevel, ["icons", "index.html", "manifest.json", "src", "styles.css"]);
console.log("UXP 构建校验通过：清单、界面契约、源码哈希和安全接口均有效。");
