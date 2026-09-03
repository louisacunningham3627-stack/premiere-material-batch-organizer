import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
await mkdir(pluginFolder, { recursive: true });
await cp(source, pluginFolder, { recursive: true });
await cp(path.join(projectRoot, "scripts", "install-user-plugin-macos.sh"), path.join(folder, "安装-macOS.sh"));
await cp(path.join(projectRoot, "scripts", "uninstall-user-plugin-macos.sh"), path.join(folder, "卸载-macOS.sh"));
await cp(path.join(projectRoot, "scripts", "restore-user-plugin-macos.sh"), path.join(folder, "恢复-macOS.sh"));
await cp(path.join(projectRoot, "docs", "macOS使用说明.md"), path.join(folder, "使用说明.md"));

async function filesUnder(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...await filesUnder(root, child));
    else if (entry.isFile() && entry.name !== "SHA256SUMS.txt") files.push(child);
  }
  return files;
}

const packageFiles = (await filesUnder(folder)).sort();
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
const required = ["plugin/manifest.json", "安装-macOS.sh", "卸载-macOS.sh", "恢复-macOS.sh", "使用说明.md", "SHA256SUMS.txt"];
for (const relative of required) {
  if (!existsSync(path.join(packageRoot, relative))) throw new Error(`macOS ZIP 缺少必要文件：${relative}`);
}
const zippedManifest = JSON.parse(await readFile(path.join(packageRoot, "plugin", "manifest.json"), "utf8"));
if (zippedManifest.id !== "com.hechao.premiere.material-batch-organizer" || zippedManifest.version !== packageJson.version) {
  throw new Error("macOS ZIP 中 manifest 身份或版本不正确");
}
const listedHashes = (await readFile(path.join(packageRoot, "SHA256SUMS.txt"), "utf8"))
  .split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
for (const line of listedHashes) {
  const match = line.match(/^([0-9a-f]{64})\s{2}(.+)$/i);
  if (!match || path.isAbsolute(match[2]) || match[2].split(/[\\/]/).includes("..")) throw new Error(`macOS ZIP 的 SHA256SUMS.txt 格式不安全：${line}`);
  const listedFile = path.join(packageRoot, match[2]);
  if (!existsSync(listedFile)) throw new Error(`macOS ZIP 的 SHA256SUMS.txt 缺少文件：${match[2]}`);
  const listedHash = createHash("sha256").update(await readFile(listedFile)).digest("hex");
  if (listedHash.toLowerCase() !== match[1].toLowerCase()) throw new Error(`macOS ZIP 文件 SHA-256 不匹配：${match[2]}`);
}
await rm(verifyRoot, { recursive: true, force: true });
console.log(`macOS 交付目录：${folder}`);
console.log(`macOS 交付 ZIP：${archive}`);
console.log(`ZIP SHA-256：${hashValue}`);
