import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import sharp from "sharp";

// libvips keeps recently-read files open; that blocks temp-dir cleanup on Windows.
sharp.cache(false);

const MAIN = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));

function run(args: string[], input = "") {
  const res = spawnSync(process.execPath, [MAIN, ...args], { input, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** read <glob> piped through stages; returns the last stage's result. */
function pipeline(globPattern: string, ...stages: string[][]) {
  let res = run(["read", globPattern]);
  for (const stage of stages) {
    res = run(stage, res.stdout);
  }
  return res;
}

/** Async counterpart of run(): spawnSync blocks this process's event loop
 * for the child's whole lifetime, which would starve the in-process test
 * HTTP server below of the chance to answer the child's fetch. Only the
 * URL-source tests need this. */
function runAsync(args: string[], input = ""): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

async function pipelineAsync(globPattern: string, ...stages: string[][]) {
  let res = await runAsync(["read", globPattern]);
  for (const stage of stages) {
    res = await runAsync(stage, res.stdout);
  }
  return res;
}

const dir = mkdtempSync(join(tmpdir(), "photu-exec-")).replaceAll("\\", "/");
const out = join(dir, "out").replaceAll("\\", "/");

before(async () => {
  const red = { width: 100, height: 60, channels: 3 as const, background: "red" };
  await sharp({ create: red }).jpeg().toFile(join(dir, "red.jpg"));
  await sharp({ create: { ...red, width: 200, height: 120 } }).jpeg().toFile(join(dir, "big.jpg"));
  await sharp({
    create: { width: 80, height: 80, channels: 4 as const, background: { r: 0, g: 0, b: 255, alpha: 0.5 } },
  }).png().toFile(join(dir, "semi.png"));
  await sharp({ create: { ...red, width: 20, height: 20, background: "green" } })
    .png()
    .toFile(join(dir, "logo.png"));
  mkdirSync(join(dir, "nested"));
  await sharp({ create: red }).jpeg().toFile(join(dir, "nested", "red.jpg"));
});
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

// A local HTTP server stands in for a remote host, so URL-source tests
// don't depend on outbound internet access.
let server: ReturnType<typeof createServer>;
let base: string;

before(async () => {
  const photo = await sharp({ create: { width: 64, height: 40, channels: 3 as const, background: "blue" } })
    .jpeg()
    .toBuffer();
  const huge = Buffer.alloc(51 * 1024 * 1024);

  server = createServer((req, res) => {
    if (req.url === "/photo.jpg?w=800&sig=abc") {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(photo);
    } else if (req.url === "/huge") {
      res.writeHead(200, { "content-type": "image/jpeg", "content-length": String(huge.length) });
      res.end(huge);
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test("end-to-end: resize + grayscale to webp", async () => {
  const res = pipeline(
    `${dir}/*.jpg`,
    ["resize", "50"],
    ["grayscale"],
    ["write", `${out}/a/{name}.webp`, "quality=70"],
  );
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, "", "sink is silent on success");
  assert.equal(res.stderr, "");

  const m = await sharp(`${out}/a/red.webp`).metadata();
  assert.equal(m.format, "webp");
  assert.equal(m.width, 50);
  assert.equal(m.height, 30, "aspect preserved");
  const big = await sharp(`${out}/a/big.webp`).metadata();
  assert.equal(big.width, 50);
});

test("resize does not upscale by default, does with the flag", async () => {
  let res = pipeline(`${dir}/red.jpg`, ["resize", "400"], ["write", `${out}/b/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal((await sharp(`${out}/b/red.png`).metadata()).width, 100);

  res = pipeline(`${dir}/red.jpg`, ["resize", "400", "upscale"], ["write", `${out}/c/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal((await sharp(`${out}/c/red.png`).metadata()).width, 400);
});

test("write {ext} keeps each source format", async () => {
  const res = pipeline(`${dir}/*.{jpg,png}`, ["resize", "40"], [
    "write",
    `${out}/d/{name}.{ext}`,
  ]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal((await sharp(`${out}/d/red.jpg`).metadata()).format, "jpeg");
  assert.equal((await sharp(`${out}/d/semi.png`).metadata()).format, "png");
});

test("jpeg output flattens alpha onto the background", async () => {
  const res = pipeline(`${dir}/semi.png`, ["write", `${out}/e/{name}.jpg`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/e/semi.jpg`).metadata();
  assert.equal(m.format, "jpeg");
  assert.equal(m.channels, 3, "no alpha channel survives");
});

test("gravity and region crops cut without scaling; bounds are enforced", async () => {
  let res = pipeline(`${dir}/red.jpg`, ["crop", "20x30"], ["write", `${out}/f/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/f/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "20x30");

  res = pipeline(`${dir}/red.jpg`, ["crop", "30x30+80+40"], ["write", `${out}/g/{name}.png`]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /exceeds image 100x60/);
  assert.ok(!existsSync(`${out}/g/red.png`), "nothing written on failure");
});

test("rotate 90 swaps dimensions; pad extends them", async () => {
  const res = pipeline(
    `${dir}/red.jpg`,
    ["rotate", "90"],
    ["pad", "10", "color=white"],
    ["write", `${out}/h/{name}.png`],
  );
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/h/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "80x120", "60x100 rotated, +10 padding each side");
});

test("overlay with opacity composites successfully", async () => {
  const res = pipeline(
    `${dir}/red.jpg`,
    ["overlay", `${dir}/logo.png`, "gravity=southeast", "opacity=0.5"],
    ["write", `${out}/i/{name}.png`],
  );
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/i/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "100x60");
});

test("output collisions are caught before anything is written", () => {
  const res = pipeline(`${dir}/**/red.jpg`, ["write", `${out}/j/{name}.png`]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /both write to/);
  assert.ok(!existsSync(`${out}/j/red.png`));

  const ok = pipeline(`${dir}/**/red.jpg`, ["write", `${out}/j/{name}-{i}.png`]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(existsSync(`${out}/j/red-1.png`));
  assert.ok(existsSync(`${out}/j/red-2.png`));
});

test("writing over an input is refused", () => {
  const res = pipeline(`${dir}/red.jpg`, ["write", `${dir}/{name}.jpg`]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /overwrite its own input/);
});

test("a corrupt input fails the batch with the file named", async () => {
  mkdirSync(join(dir, "corrupt"), { recursive: true });
  writeFileSync(join(dir, "corrupt", "bad.jpg"), "this is not a jpeg");
  await sharp({ create: { width: 10, height: 10, channels: 3, background: "red" } })
    .jpeg()
    .toFile(join(dir, "corrupt", "ok.jpg"));

  const res = pipeline(`${dir}/corrupt/*.jpg`, ["write", `${out}/k/{name}.png`]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /bad\.jpg/);
});

test("a URL source is fetched straight into the pipeline, no disk round trip", async () => {
  const res = await pipelineAsync(
    `${base}/photo.jpg?w=800&sig=abc`,
    ["resize", "32"],
    ["write", `${out}/url/{name}.webp`],
  );
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/url/photo.webp`).metadata();
  assert.equal(m.format, "webp");
  assert.equal(m.width, 32, "the query string didn't leak into {name}");
});

test("a batch can mix local files and URLs", async () => {
  const read = await runAsync(["read", `${dir}/red.jpg`, `${base}/photo.jpg?w=800&sig=abc`]);
  const write = await runAsync(["write", `${out}/mix/{name}.png`], read.stdout);
  assert.equal(write.status, 0, write.stderr);
  assert.ok(existsSync(`${out}/mix/red.png`));
  assert.ok(existsSync(`${out}/mix/photo.png`));
});

test("a 404 URL source fails the batch with the URL named", async () => {
  const res = await pipelineAsync(`${base}/missing`, ["write", `${out}/url/{name}.png`]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /missing.*HTTP 404/);
});

test("a URL source over the fetch size cap is rejected without downloading it", async () => {
  const res = await pipelineAsync(`${base}/huge`, ["write", `${out}/url/{name}.png`]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /fetch limit/);
});

test("info prints a row per file", () => {
  const res = run(["info", `${dir}/*.jpg`]);
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /jpeg\s+200x120/);
  assert.match(lines[1], /jpeg\s+100x60/);
});

test("formats prints the runtime support table", () => {
  const res = run(["formats"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /format\s+read\s+write/);
  assert.match(res.stdout, /webp\s+yes\s+yes/);
  assert.match(res.stdout, /svg\s+yes\s+no/);
});
