const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
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
  assert.match(source, /-before-/);
  assert.match(source, /-failed-/);
  assert.doesNotMatch(source, /Remove-Item/);
});

test("卸载脚本只移动到可恢复备份而不删除", () => {
  const source = readScript(uninstallPath).text;
  assert.match(source, /PluginBackups/);
  assert.match(source, /-uninstalled-/);
  assert.match(source, /Move-Item/);
  assert.doesNotMatch(source, /Remove-Item/);
});
