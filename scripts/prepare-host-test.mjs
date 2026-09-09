import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("..", import.meta.url));
const root = path.join(project, "work", "host-acceptance");
await mkdir(root, { recursive: true });
const run = await mkdtemp(path.join(root, "candidate-"));
const rate = 48000, samples = rate * 2;
const wav = Buffer.alloc(44 + samples * 2);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / rate) * 1500), 44 + i * 2);
for (const name of ["测试工程", "外部新增", "不搬动测试库"]) await mkdir(path.join(run, name));
for (const [folder, name] of [["外部新增", "独立测试音频.wav"], ["不搬动测试库", "保持原位.wav"], ["测试工程", "工程内已有.wav"]]) {
  await writeFile(path.join(run, folder, name), wav, { flag: "wx" });
}
console.log(JSON.stringify({ 测试目录: run, 工程保存位置: path.join(run, "测试工程"), 单个文件字节: wav.length }, null, 2));
