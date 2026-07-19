// Dev server for the photu playground. Zero dependencies.
// wasm-vips needs SharedArrayBuffer, which needs cross-origin isolation,
// so every response carries COOP/COEP headers. Routes:
//   /            -> playground/index.html
//   /app.js etc. -> playground/
//   /core/*      -> dist/core/*        (run `npm run build` first)
//   /vips/*      -> node_modules/wasm-vips/lib/*
// Usage: node playground/serve.mjs [port]

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, normalize, extname } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const port = Number(process.argv[2]) || 8787;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".json": "application/json",
};

function resolvePath(url) {
  const clean = normalize(decodeURIComponent(url.split("?")[0])).replaceAll("\\", "/");
  if (clean.includes("..")) return null;
  if (clean === "/" || clean === "/index.html") return join(root, "playground", "index.html");
  if (clean.startsWith("/core/")) return join(root, "dist", "core", clean.slice(6));
  if (clean.startsWith("/vips/")) return join(root, "node_modules", "wasm-vips", "lib", clean.slice(6));
  return join(root, "playground", clean.slice(1));
}

const server = createServer((req, res) => {
  const path = resolvePath(req.url ?? "/");
  if (path === null || !existsSync(path)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": MIME[extname(path)] ?? "application/octet-stream",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
    "cache-control": "no-cache",
  });
  res.end(readFileSync(path));
});

server.listen(port, () => {
  if (!existsSync(join(root, "dist", "core", "plan.js"))) {
    console.log("note: dist/core missing - run `npm run build` first");
  }
  console.log(`photu playground: http://localhost:${port}`);
});
