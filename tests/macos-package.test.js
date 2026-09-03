const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

test("macOS 安装链路使用自包含中文脚本且不依赖 Node", () => {
  const scriptFiles = [
    "scripts/install-user-plugin-macos.sh",
    "scripts/uninstall-user-plugin-macos.sh",
    "scripts/restore-user-plugin-macos.sh",
  ];
  for (const relative of scriptFiles) {
    const source = fs.readFileSync(path.join(projectRoot, relative), "utf8");
    assert.match(source, /^#!\/bin\/bash/);
    assert.doesNotMatch(source, /\bnode\s+-e\b/);
    assert.match(source, /Adobe Premiere Pro/);
  }
  const uninstallSource = fs.readFileSync(path.join(projectRoot, "scripts/uninstall-user-plugin-macos.sh"), "utf8");
  assert.match(uninstallSource, /恢复-macOS\.sh/);
  assert.match(uninstallSource, /restore-user-plugin-macos\.sh/);
  assert.match(fs.readFileSync(path.join(projectRoot, "scripts/package-macos.mjs"), "utf8"), /plugin/);
  assert.match(fs.readFileSync(path.join(projectRoot, "docs/macOS使用说明.md"), "utf8"), /安装|恢复/);
});

test("已生成的 macOS ZIP 具有真实自包含结构和外部 SHA-256", { skip: !fs.existsSync(path.join(projectRoot, "dist-macos")) }, () => {
  const outputRoot = path.join(projectRoot, "dist-macos");
  const zipName = fs.readdirSync(outputRoot).find((name) => name.endsWith(".zip"));
  assert.ok(zipName);
  const packageRoot = path.join(outputRoot, zipName.slice(0, -4));
  for (const relative of ["plugin/manifest.json", "安装-macOS.sh", "卸载-macOS.sh", "恢复-macOS.sh", "使用说明.md", "SHA256SUMS.txt"]) {
    assert.equal(fs.existsSync(path.join(packageRoot, relative)), true, relative);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "plugin/manifest.json"), "utf8"));
  assert.equal(manifest.id, "com.hechao.premiere.material-batch-organizer");
  const checksumText = fs.readFileSync(path.join(outputRoot, "SHA256SUMS.txt"), "utf8").trim().split(/\s+/);
  const actual = crypto.createHash("sha256").update(fs.readFileSync(path.join(outputRoot, zipName))).digest("hex");
  assert.equal(checksumText[0], actual);
  assert.equal(checksumText[1], zipName);
});
