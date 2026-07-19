// Assembles the static playground site for Netlify into site/:
//   playground files + dist/core (run `npm run build` first) + the
//   wasm-vips browser runtime + a _headers file with the COOP/COEP
//   headers wasm-vips needs.

import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const site = join(root, "site");

if (!existsSync(join(root, "dist", "core", "plan.js"))) {
  console.error("dist/core missing - run `npm run build` first");
  process.exit(1);
}

rmSync(site, { recursive: true, force: true });
mkdirSync(join(site, "core"), { recursive: true });
mkdirSync(join(site, "vips"), { recursive: true });

for (const f of ["index.html", "app.js", "exec-wasm.js"]) {
  cpSync(join(root, "playground", f), join(site, f));
}
cpSync(join(root, "dist", "core"), join(site, "core"), { recursive: true });

const vipsLib = join(root, "node_modules", "wasm-vips", "lib");
for (const f of ["vips-es6.js", "vips.wasm", "vips-heif.wasm", "vips-jxl.wasm", "vips-resvg.wasm"]) {
  cpSync(join(vipsLib, f), join(site, "vips", f));
}

writeFileSync(
  join(site, "_headers"),
  `/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
`,
);

console.log("site/ ready");
