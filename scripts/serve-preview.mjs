import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const port = Number(process.env.PREMIERE_BATCH_PREVIEW_PORT || 4174);
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    const relative = decodeURIComponent(requestUrl.pathname === "/" ? "/preview/index.html" : requestUrl.pathname);
    const target = path.resolve(projectRoot, `.${relative}`);
    if (target !== projectRoot && !target.startsWith(projectRoot + path.sep)) {
      response.writeHead(403).end("禁止访问");
      return;
    }
    const info = await stat(target);
    if (!info.isFile()) throw new Error("目标不是文件");
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": mimeTypes[path.extname(target).toLowerCase()] || "application/octet-stream",
    });
    createReadStream(target).pipe(response);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("未找到");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`预览地址：http://127.0.0.1:${port}/preview/index.html?state=ready`);
});
