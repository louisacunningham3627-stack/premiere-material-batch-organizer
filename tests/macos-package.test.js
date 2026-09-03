const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const os = require("node:os");

const projectRoot = path.resolve(__dirname, "..");
const installPath = path.join(projectRoot, "scripts", "install-user-plugin-macos.sh");
const uninstallPath = path.join(projectRoot, "scripts", "uninstall-user-plugin-macos.sh");
const restorePath = path.join(projectRoot, "scripts", "restore-user-plugin-macos.sh");
const packagePath = path.join(projectRoot, "scripts", "package-macos.mjs");
const installScript = fs.readFileSync(installPath, "utf8");
const uninstallScript = fs.readFileSync(uninstallPath, "utf8");
const restoreScript = fs.readFileSync(restorePath, "utf8");
const packageScript = fs.readFileSync(packagePath, "utf8");

function regularFilesUnder(root, relative = "") {
  const files = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    assert.equal(entry.isSymbolicLink(), false, `交付树不能包含符号链接：${child}`);
    if (entry.isDirectory()) files.push(...regularFilesUnder(root, child));
    else if (entry.isFile()) files.push(child.replaceAll(path.sep, "/"));
    else assert.fail(`交付树只能包含普通文件和目录：${child}`);
  }
  return files;
}

test("macOS 安装链路使用自包含中文脚本且不依赖 Node", () => {
  for (const source of [installScript, uninstallScript, restoreScript]) {
    assert.match(source, /^#!\/bin\/bash/);
    assert.doesNotMatch(source, /\bnode\s+-e\b/);
    assert.match(source, /Adobe Premiere Pro/);
  }
  assert.match(restoreScript, /validate_plugin_directory "\$BACKUP_PATH" "插件备份"/);
  assert.match(uninstallScript, /恢复-macOS\.sh/);
  assert.match(uninstallScript, /restore-user-plugin-macos\.sh/);
  assert.match(packageScript, /plugin/);
  assert.match(fs.readFileSync(path.join(projectRoot, "docs/macOS使用说明.md"), "utf8"), /安装|恢复/);
});

test("macOS 安装链拒绝符号链接并完整校验交付清单", () => {
  for (const source of [installScript, uninstallScript, restoreScript]) {
    assert.match(source, /path_present\(\) \{ \[\[ -e "\$1" \|\| -L "\$1" \]\]; \}/);
    assert.match(source, /PLUTIL_BIN="\$\{PLUTIL_BIN:-\$\(command -v plutil \|\| true\)\}"/);
    assert.match(source, /"\$PLUTIL_BIN" -extract/);
    assert.doesNotMatch(source, /-print -quit/);
    assert.match(source, /validate_plugin_directory/);
    assert.ok(source.includes('*//*|*/./*|*/../*|*/.|*/..'), "目标根目录必须拒绝重复分隔符和点段");
  }

  const targetCheck = installScript.indexOf('validate_plugin_directory "$TARGET_PATH" "既有安装目标"');
  const targetMove = installScript.indexOf('mv "$TARGET_PATH" "$BACKUP_PATH"');
  assert.ok(targetCheck >= 0 && targetCheck < targetMove, "移动旧版前必须拒绝目标目录内部的符号链接");
  assert.match(installScript, /自包含安装包缺少 SHA256SUMS\.txt，已拒绝安装/);
  assert.match(installScript, /package_file_count/);
  assert.match(installScript, /未列入 SHA-256 清单/);
  assert.match(installScript, /安装切换前目标路径再次出现/);
  assert.match(installScript, /切换前安装目标/);
  assert.match(installScript, /切换前备份路径再次出现/);
  assert.match(installScript, /自包含安装包不允许改用外部构建目录/);
  assert.match(installScript, /安装目标根目录必须是绝对路径/);
  assert.match(uninstallScript, /卸载切换前安装目标/);
  assert.match(uninstallScript, /卸载切换前备份路径再次出现/);
  assert.match(uninstallScript, /卸载目标根目录必须是绝对路径/);
  assert.match(restoreScript, /恢复切换前插件备份/);
  assert.match(restoreScript, /恢复目标根目录必须是绝对路径/);
  const restoreBackupCheck = restoreScript.indexOf('validate_plugin_directory "$BACKUP_PATH" "恢复切换前插件备份"');
  const restoreTargetCheck = restoreScript.indexOf('path_present "$TARGET_PATH" && fail "恢复切换前目标路径再次出现');
  const restoreMove = restoreScript.indexOf('mv "$BACKUP_PATH" "$TARGET_PATH"');
  assert.ok(restoreBackupCheck >= 0 && restoreBackupCheck < restoreTargetCheck && restoreTargetCheck < restoreMove,
    "恢复前必须先重验备份，再紧邻移动检查目标竞态");
  assert.match(restoreScript, /validate_plugin_directory "\$TARGET_PATH" "恢复结果"/);
  assert.match(installScript, /find \. -type f ! -path '\.\/SHA256SUMS\.txt'/);
  assert.doesNotMatch(installScript, /! -name SHA256SUMS\.txt/);

  assert.match(packageScript, /isSymbolicLink/);
  assert.match(packageScript, /SHA256SUMS\.txt 不能为空/);
  assert.match(packageScript, /完整覆盖 ZIP 中的普通文件/);
  assert.match(packageScript, /只允许普通文件和目录/);
  assert.match(packageScript, /assertNoSymlinks\(packageRoot, "macOS ZIP 交付树"\)/);
  assert.match(packageScript, /relative !== "SHA256SUMS\.txt"/);
  assert.doesNotMatch(packageScript, /entry\.name !== "SHA256SUMS\.txt"/);
});

test("macOS 恢复脚本运行时拒绝符号链接备份路径", { skip: process.platform === "win32" }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-material-macos-restore-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const realBackup = path.join(root, "real-backup");
  const symlinkBackup = path.join(root, "backup-link");
  fs.mkdirSync(realBackup);
  fs.writeFileSync(path.join(realBackup, "manifest.json"), JSON.stringify({ id: "com.hechao.premiere.material-batch-organizer" }));
  fs.symlinkSync(realBackup, symlinkBackup, "dir");
  const targetRoot = path.join(root, "External");
  const result = childProcess.spawnSync("bash", [restorePath, "--backup-path", symlinkBackup, "--target-root", targetRoot], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(path.join(targetRoot, "com.hechao.premiere.material-batch-organizer")), false);
  assert.equal(fs.existsSync(realBackup), true);
});

test("已生成的 macOS ZIP 具有自包含结构和完整 SHA-256 清单", { skip: !fs.existsSync(path.join(projectRoot, "dist-macos")) }, () => {
  const outputRoot = path.join(projectRoot, "dist-macos");
  const zipName = fs.readdirSync(outputRoot).find((name) => name.endsWith(".zip"));
  assert.ok(zipName);
  const packageRoot = path.join(outputRoot, zipName.slice(0, -4));
  for (const relative of ["plugin/manifest.json", "安装-macOS.sh", "卸载-macOS.sh", "恢复-macOS.sh", "使用说明.md", "SHA256SUMS.txt"]) {
    assert.equal(fs.existsSync(path.join(packageRoot, relative)), true, relative);
  }
  for (const [bundledName, sourcePath] of [["安装-macOS.sh", installPath], ["卸载-macOS.sh", uninstallPath], ["恢复-macOS.sh", restorePath]]) {
    assert.deepEqual(fs.readFileSync(path.join(packageRoot, bundledName)), fs.readFileSync(sourcePath), `${bundledName} 必须与源码一致`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "plugin/manifest.json"), "utf8"));
  assert.equal(manifest.id, "com.hechao.premiere.material-batch-organizer");
  assert.equal(manifest.version, require("../package.json").version);
  assert.equal(manifest.host.app, "premierepro");

  const internalLines = fs.readFileSync(path.join(packageRoot, "SHA256SUMS.txt"), "utf8")
    .split(/\r?\n/).filter(Boolean);
  const listedFiles = new Map();
  for (const line of internalLines) {
    const match = line.match(/^([0-9a-f]{64})  (.+)$/i);
    assert.ok(match, `包内 SHA-256 行格式错误：${line}`);
    assert.equal(listedFiles.has(match[2]), false, `包内 SHA-256 路径重复：${match[2]}`);
    listedFiles.set(match[2], match[1].toLowerCase());
  }
  const actualFiles = regularFilesUnder(packageRoot)
    .filter((relative) => relative !== "SHA256SUMS.txt")
    .sort();
  assert.deepEqual([...listedFiles.keys()].sort(), actualFiles);
  for (const [relative, expectedHash] of listedFiles) {
    const actualHash = crypto.createHash("sha256")
      .update(fs.readFileSync(path.join(packageRoot, ...relative.split("/"))))
      .digest("hex");
    assert.equal(actualHash, expectedHash, relative);
  }

  const checksumText = fs.readFileSync(path.join(outputRoot, "SHA256SUMS.txt"), "utf8").trim().split(/\s+/);
  const actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(outputRoot, zipName))).digest("hex");
  assert.equal(checksumText[0], actual);
  assert.equal(checksumText[1], zipName);
});
