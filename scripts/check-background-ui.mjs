import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const output = path.join(root, `work/ui-background-${version}`);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
try {
  for (const [width, height] of [[300, 420], [540, 480], [760, 850]]) {
    const page = await browser.newPage({ viewport: { width, height } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(pathToFileURL(path.join(root, "plugin/index.html")).href + "?preview=1&state=background");
    await page.locator("#backgroundStatus").waitFor({ state: "visible" });
    assert.equal(await page.locator("#recoveryDetails").isVisible(), false);
    assert.equal(await page.locator("#autoCollectToggle").isEnabled(), true);
    assert.equal(await page.locator("#openBatchButton").isEnabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const status = await page.locator("#backgroundStatus").boundingBox();
    const batch = await page.locator("#batchSection").boundingBox();
    assert.ok(status.y + status.height <= batch.y + 1, "等待提示不得盖住素材文件夹");
    await page.screenshot({ path: path.join(output, `${width}x${height}.png`), fullPage: true });
    await page.locator("#protectedCount").click();
    await page.locator("#closeSettingsButton").click();
    assert.equal(await page.locator("#backgroundStatus").isVisible(), true);
    await page.locator("#autoCollectToggle").uncheck();
    assert.equal(await page.locator("#autoCollectToggle").isChecked(), false);
    assert.match(await page.locator("#backgroundStatus").textContent(), /等待继续整理/);
    assert.equal(await page.locator("#recoveryDetails").isVisible(), false);
    await page.locator("#autoCollectToggle").check();
    assert.match(await page.locator("#backgroundStatus").textContent(), /等待原件释放/);
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`${width}x${height}: 等待提示、无恢复遮挡、按钮及返回检查通过`);
  }
} finally { await browser.close(); }
