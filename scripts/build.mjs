// Build: strip TypeScript types from src/ into dist/ using Node's own
// stripper - no compiler dependency. Import specifiers are rewritten
// from .ts to .js.

import { stripTypeScriptTypes } from "node:module";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const srcDir = join(root, "src");
const distDir = join(root, "dist");

rmSync(distDir, { recursive: true, force: true });

let count = 0;
for (const entry of readdirSync(srcDir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
  const srcPath = join(entry.parentPath, entry.name);
  const rel = srcPath.slice(srcDir.length + 1);
  const outPath = join(distDir, rel.replace(/\.ts$/, ".js"));

  const source = readFileSync(srcPath, "utf8");
  const stripped = stripTypeScriptTypes(source, { mode: "strip" });
  const rewritten = stripped.replaceAll('.ts"', '.js"');

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, rewritten);
  count++;
}

console.log(`built ${count} files into dist/`);
