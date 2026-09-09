import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
const source = path.join(projectRoot, "dist");
const outputRoot = path.join(projectRoot, "dist-macos");
const folderName = `${packageJson.name}-macos-${packageJson.version}`;
const folder = path.join(outputRoot, folderName);
const pluginFolder = path.join(folder, "plugin");
const archive = path.join(outputRoot, `${folderName}.zip`);
const checksum = path.join(outputRoot, "SHA256SUMS.txt");

if (!existsSync(path.join(source, "manifest.json"))) throw new Error("找不到 dist/manifest.json，请先运行 npm run build");
async function findSymlink(root, relative = "") {
  const current = path.join(root, relative);
  const currentStat = await lstat(current);
  if (currentStat.isSymbolicLink()) return current;
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) return path.join(root, child);
    if (entry.isDirectory()) {
      const nested = await findSymlink(root, child);
      if (nested) return nested;
    }
  }
  return null;
}
async function assertNoSymlinks(root, label) {
  const link = await findSymlink(root);
  if (link) throw new Error(label + "包含符号链接：" + link);
}
await assertNoSymlinks(source, "dist 构建树");
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await mkdir(pluginFolder, { recursive: true });
await cp(source, pluginFolder, { recursive: true, filter: (entry) => path.relative(source, entry).split(path.sep)[0] !== "native" });
const bundleSources = [
  ["scripts/install-user-plugin-macos.sh", "安装-macOS.sh"],
  ["scripts/uninstall-user-plugin-macos.sh", "卸载-macOS.sh"],
  ["scripts/restore-user-plugin-macos.sh", "恢复-macOS.sh"],
  ["docs/macOS使用说明.md", "使用说明.md"],
];
for (const [relative, target] of bundleSources) {
  const sourcePath = path.join(projectRoot, relative);
  const sourceStat = await lstat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) throw new Error("macOS 包源文件必须是普通文件：" + sourcePath);
  await cp(sourcePath, path.join(folder, target));
}
await assertNoSymlinks(folder, "macOS 交付树");

async function filesUnder(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error("交付树只允许普通文件和目录，发现符号链接：" + path.join(root, child));
    if (entry.isDirectory()) files.push(...await filesUnder(root, child));
    else if (entry.isFile()) files.push(child);
    else if (!entry.isFile()) throw new Error("交付树包含非普通文件：" + path.join(root, child));
  }
  return files;
}

const packageFiles = (await filesUnder(folder)).sort();
if (packageFiles.length === 0) throw new Error("macOS 交付树不能为空");
const packageHashes = [];
for (const relative of packageFiles) {
  const bytes = await readFile(path.join(folder, relative));
  packageHashes.push(`${createHash("sha256").update(bytes).digest("hex")}  ${relative.replaceAll(path.sep, "/")}`);
}
await writeFile(path.join(folder, "SHA256SUMS.txt"), `${packageHashes.join("\n")}\n`, "utf8");

let zip = spawnSync("zip", ["-qr", archive, folderName], { cwd: outputRoot, encoding: "utf8" });
if (zip.status !== 0) {
  zip = spawnSync("powershell.exe", ["-NoProfile", "-Command", `Compress-Archive -Path '${folderName}' -DestinationPath '${path.basename(archive)}' -Force`], { cwd: outputRoot, encoding: "utf8" });
}
if (zip.status !== 0) throw new Error(`创建 macOS ZIP 失败：${zip.stderr || zip.stdout || "没有可用的 ZIP 工具"}`);
const archiveBytes = await readFile(archive);
const hashValue = createHash("sha256").update(archiveBytes).digest("hex");
await writeFile(checksum, `${hashValue}  ${path.basename(archive)}\n`, "utf8");

const verifyRoot = path.join(outputRoot, ".zip-verify");
await rm(verifyRoot, { recursive: true, force: true });
let extracted;
if (spawnSync("unzip", ["-t", archive], { encoding: "utf8" }).status === 0) {
  const extract = spawnSync("unzip", ["-q", archive, "-d", verifyRoot], { encoding: "utf8" });
  extracted = extract.status === 0;
} else {
  const extract = spawnSync("powershell.exe", ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${path.basename(archive)}' -DestinationPath '.zip-verify' -Force`], { cwd: outputRoot, encoding: "utf8" });
  extracted = extract.status === 0;
}
if (!extracted) throw new Error("macOS ZIP 解压校验失败");
const packageRoot = path.join(verifyRoot, folderName);
await assertNoSymlinks(packageRoot, "macOS ZIP 交付树");
const required = ["plugin/manifest.json", "安装-macOS.sh", "卸载-macOS.sh", "恢复-macOS.sh", "使用说明.md", "SHA256SUMS.txt"];
for (const relative of required) {
  if (!existsSync(path.join(packageRoot, relative))) throw new Error(`macOS ZIP 缺少必要文件：${relative}`);
}
const zippedManifest = JSON.parse(await readFile(path.join(packageRoot, "plugin", "manifest.json"), "utf8"));
if (zippedManifest.id !== "com.hechao.premiere.material-batch-organizer"
  || zippedManifest.version !== packageJson.version
  || zippedManifest.host?.app !== "premierepro") {
  throw new Error("macOS ZIP 中 manifest 身份、版本或宿主不正确");
}
const listedHashes = (await readFile(path.join(packageRoot, "SHA256SUMS.txt"), "utf8"))
  .split(/\r?\n/).filter((line) => line.length > 0);
if (listedHashes.length === 0) throw new Error("macOS ZIP 的 SHA256SUMS.txt 不能为空");
const listedFiles = new Map();
function isSafePackagePath(relative) {
  if (!relative || relative.startsWith("/") || relative.includes("\\") || /^[A-Za-z]:[\\/]/.test(relative)) return false;
  if (/[\u0000\r\n]/.test(relative)) return false;
  return relative.split("/").every((part) => part && part !== "." && part !== "..");
}
for (const line of listedHashes) {
  const match = line.match(/^([0-9a-f]{64})  (.+)$/i);
  if (!match || !isSafePackagePath(match[2])) throw new Error("macOS ZIP 的 SHA256SUMS.txt 格式不安全：" + line);
  if (listedFiles.has(match[2])) throw new Error("macOS ZIP 的 SHA256SUMS.txt 存在重复文件：" + match[2]);
  const listedFile = path.join(packageRoot, ...match[2].split("/"));
  const listedStat = await lstat(listedFile).catch(() => null);
  if (!listedStat || !listedStat.isFile() || listedStat.isSymbolicLink()) throw new Error("macOS ZIP 的 SHA256SUMS.txt 缺少普通文件：" + match[2]);
  const listedHash = createHash("sha256").update(await readFile(listedFile)).digest("hex");
  if (listedHash.toLowerCase() !== match[1].toLowerCase()) throw new Error("macOS ZIP 文件 SHA-256 不匹配：" + match[2]);
  listedFiles.set(match[2], match[1].toLowerCase());
}
const actualPackageFiles = (await filesUnder(packageRoot))
  .filter((relative) => relative !== "SHA256SUMS.txt")
  .map((relative) => relative.replaceAll(path.sep, "/"))
  .sort();
if (actualPackageFiles.length !== listedFiles.size) throw new Error("SHA-256 清单没有完整覆盖 ZIP 中的普通文件");
for (const relative of actualPackageFiles) {
  if (!listedFiles.has(relative)) throw new Error("ZIP 中普通文件未列入 SHA-256 清单：" + relative);
}
await rm(verifyRoot, { recursive: true, force: true });
console.log(`macOS 交付目录：${folder}`);
console.log(`macOS 交付 ZIP：${archive}`);
console.log(`ZIP SHA-256：${hashValue}`);
