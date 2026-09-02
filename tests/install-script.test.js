const test = require("node:test");
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const installPath = path.join(projectRoot, "scripts", "install-user-plugin.ps1");
const uninstallPath = path.join(projectRoot, "scripts", "uninstall-user-plugin.ps1");
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "plugin", "manifest.json"), "utf8"));
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8"));

function readScript(filePath) {
  const bytes = fs.readFileSync(filePath);
  return {
    bytes,
    text: bytes.toString("utf8").replace(/^\uFEFF/, ""),
  };
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function createBuildFixture(root, payload = "新版") {
  const buildPath = path.join(root, "dist");
  fs.mkdirSync(buildPath, { recursive: true });
  fs.writeFileSync(
    path.join(buildPath, "manifest.json"),
    JSON.stringify({ id: manifest.id, version: manifest.version, host: { app: "premierepro" } }),
  );
  fs.writeFileSync(path.join(buildPath, "payload.txt"), payload);
  return buildPath;
}

function createInstalledFixture(targetRoot, pluginId = manifest.id, payload = "旧版") {
  const targetPath = path.join(targetRoot, manifest.id);
  fs.mkdirSync(targetPath, { recursive: true });
  fs.writeFileSync(
    path.join(targetPath, "manifest.json"),
    JSON.stringify({ id: pluginId, version: "0.0.1", host: { app: "premierepro" } }),
  );
  fs.writeFileSync(path.join(targetPath, "payload.txt"), payload);
  return targetPath;
}

function runInstallerScript(scriptPath, parameters, prelude = "") {
  const mockedProcessLookup = [
    "function Get-Process {",
    "  [CmdletBinding()]",
    "  param([string]$Name)",
    "  return @()",
    "}",
  ].join("\n");
  const argumentsText = Object.entries(parameters)
    .map(([name, value]) => `-${name} ${quotePowerShell(value)}`)
    .join(" ");
  const command = `${mockedProcessLookup}\n${prelude}\n& ${quotePowerShell(scriptPath)} ${argumentsText}`;
  return childProcess.spawnSync(
    "powershell.exe",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
    { encoding: "utf8", windowsHide: true },
  );
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "premiere-material-installer-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("安装和卸载命令均指向受控脚本", () => {
  assert.equal(
    packageJson.scripts["install:user"],
    "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install-user-plugin.ps1",
  );
  assert.equal(
    packageJson.scripts["uninstall:user"],
    "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/uninstall-user-plugin.ps1",
  );
});

test("中文安装脚本带 UTF-8 BOM，兼容 Windows PowerShell 5.1", () => {
  for (const filePath of [installPath, uninstallPath]) {
    assert.deepEqual([...readScript(filePath).bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  }
});

test("安装与卸载脚本只处理当前插件标识", () => {
  for (const filePath of [installPath, uninstallPath]) {
    assert.match(readScript(filePath).text, new RegExp(`\\$pluginId = "${manifest.id.replaceAll(".", "\\.")}"`));
  }
});

test("Premiere 进程门禁位于任何安装目录写入之前", () => {
  const source = readScript(installPath).text;
  assert.ok(source.indexOf('Get-Process -Name "Adobe Premiere Pro"') >= 0);
  assert.ok(source.indexOf('Get-Process -Name "Adobe Premiere Pro"') < source.indexOf("New-Item -ItemType Directory"));
});

test("安装脚本使用暂存、逐文件哈希、备份和失败恢复", () => {
  const source = readScript(installPath).text;
  assert.match(source, /PluginStaging/);
  assert.match(source, /PluginBackups/);
  assert.match(source, /Get-Sha256/);
  assert.match(source, /Compare-Object/);
  assert.match(source, /Get-ChildItem -File -Recurse -Force/);
  assert.match(source, /-before-/);
  assert.match(source, /-failed-/);
  assert.match(source, /\$previousInstallMoved/);
  assert.match(source, /\$newInstallMoved/);
  assert.doesNotMatch(source, /Remove-Item/);
});

test("卸载脚本只移动到可恢复备份而不删除", () => {
  const source = readScript(uninstallPath).text;
  assert.match(source, /PluginBackups/);
  assert.match(source, /-uninstalled-/);
  assert.match(source, /Move-Item/);
  assert.doesNotMatch(source, /Remove-Item/);
});

test("可在隔离目录中完成真实安装和可恢复卸载", { skip: process.platform !== "win32" }, (t) => {
  const root = temporaryDirectory(t);
  const buildPath = createBuildFixture(root);
  const targetRoot = path.join(root, "Adobe", "UXP", "Plugins", "External");
  const targetPath = path.join(targetRoot, manifest.id);

  const installResult = runInstallerScript(installPath, { BuildPath: buildPath, TargetRoot: targetRoot });
  assert.equal(installResult.status, 0, installResult.stderr || installResult.stdout);
  assert.equal(fs.readFileSync(path.join(targetPath, "payload.txt"), "utf8"), "新版");

  const uninstallResult = runInstallerScript(uninstallPath, { TargetRoot: targetRoot });
  assert.equal(uninstallResult.status, 0, uninstallResult.stderr || uninstallResult.stdout);
  assert.equal(fs.existsSync(targetPath), false);

  const backupRoot = path.join(root, "Adobe", "UXP", "PluginBackups");
  const backups = fs.readdirSync(backupRoot).filter((name) => name.includes("-uninstalled-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(backupRoot, backups[0], "payload.txt"), "utf8"), "新版");
});

test("旧版移入备份失败时不会把旧版再次当作失败的新版本移动", { skip: process.platform !== "win32" }, (t) => {
  const root = temporaryDirectory(t);
  const buildPath = createBuildFixture(root);
  const targetRoot = path.join(root, "Adobe", "UXP", "Plugins", "External");
  const targetPath = createInstalledFixture(targetRoot);
  const normalizedTarget = path.resolve(targetPath);
  const prelude = [
    "$global:targetMoveAttempts = 0",
    "function Move-Item {",
    "  [CmdletBinding()]",
    "  param([string]$LiteralPath, [string]$Destination)",
    `  if ([IO.Path]::GetFullPath($LiteralPath) -eq [IO.Path]::GetFullPath(${quotePowerShell(normalizedTarget)})) {`,
    "    $global:targetMoveAttempts += 1",
    "    if ($global:targetMoveAttempts -eq 1) { throw '模拟旧版移动失败' }",
    "  }",
    "  Microsoft.PowerShell.Management\\Move-Item -LiteralPath $LiteralPath -Destination $Destination",
    "}",
  ].join("\n");

  const result = runInstallerScript(installPath, { BuildPath: buildPath, TargetRoot: targetRoot }, prelude);
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(targetPath, "payload.txt"), "utf8"), "旧版");
  const backupRoot = path.join(root, "Adobe", "UXP", "PluginBackups");
  assert.deepEqual(fs.readdirSync(backupRoot), []);
});

test("安装目标是普通文件时会拒绝覆盖并保留原内容", { skip: process.platform !== "win32" }, (t) => {
  const root = temporaryDirectory(t);
  const buildPath = createBuildFixture(root);
  const targetRoot = path.join(root, "Adobe", "UXP", "Plugins", "External");
  fs.mkdirSync(targetRoot, { recursive: true });
  const targetPath = path.join(targetRoot, manifest.id);
  fs.writeFileSync(targetPath, "不可覆盖");

  const result = runInstallerScript(installPath, { BuildPath: buildPath, TargetRoot: targetRoot });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(targetPath, "utf8"), "不可覆盖");
  assert.equal(fs.existsSync(path.join(root, "Adobe", "UXP", "PluginStaging")), false);
});

test("卸载时会拒绝移动伪装成当前插件目录的其他插件", { skip: process.platform !== "win32" }, (t) => {
  const root = temporaryDirectory(t);
  const targetRoot = path.join(root, "Adobe", "UXP", "Plugins", "External");
  const targetPath = createInstalledFixture(targetRoot, "com.example.other-plugin");

  const result = runInstallerScript(uninstallPath, { TargetRoot: targetRoot });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(targetPath), true);
  assert.equal(fs.readFileSync(path.join(targetPath, "payload.txt"), "utf8"), "旧版");
});
