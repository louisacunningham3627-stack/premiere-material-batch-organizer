import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const distDirectory = path.join(projectRoot, "dist");

if (path.dirname(distDirectory) !== projectRoot || path.basename(distDirectory) !== "dist") {
  throw new Error(`拒绝清理异常路径：${distDirectory}`);
}

await rm(distDirectory, { recursive: true, force: true });
console.log(`清理完成：${distDirectory}`);
