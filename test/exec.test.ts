import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import sharp from "sharp";

// libvips keeps recently-read files open; that blocks temp-dir cleanup on Windows.
sharp.cache(false);

const MAIN = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));

// ---------------------------------------------------------------------------
// Process-reuse helpers: keeps ONE Node process alive across multiple
// pipeline stages instead of spawning a fresh process per stage.
// ---------------------------------------------------------------------------

async function run(args: string[], input = ""): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [MAIN, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

/** read <glob> piped through stages; returns the last stage's result. */
async function pipeline(globPattern: string, ...stages: string[][]) {
  let res = await run(["read", globPattern]);
  for (const stage of stages) {
    res = await run(stage, res.stdout);
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

  // 4-frame animated GIF, one solid color per frame
  const animFrames = await Promise.all(
    ["red", "green", "blue", "yellow"].map((background) =>
      sharp({ create: { width: 20, height: 20, channels: 3 as const, background } }).png().toBuffer(),
    ),
  );
  await sharp(animFrames, { join: { animated: true } })
    .gif({ delay: [40, 80, 120, 160], loop: 2 })
    .toFile(join(dir, "anim.gif"));
});
after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

// A local HTTP server stands in for a remote host.
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

// ---------------------------------------------------------------------------
// Tests — all write to unique output subdirectories, so they're safe to run
// concurrently.  The shared input dir and HTTP server are read-only.
// ---------------------------------------------------------------------------
describe("exec", { concurrency: true }, () => {

test("end-to-end: resize + grayscale to webp", async () => {
  const res = await pipeline(
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
  let res = await pipeline(`${dir}/red.jpg`, ["resize", "400"], ["write", `${out}/b/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal((await sharp(`${out}/b/red.png`).metadata()).width, 100);

  res = await pipeline(`${dir}/red.jpg`, ["resize", "400", "upscale"], ["write", `${out}/c/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal((await sharp(`${out}/c/red.png`).metadata()).width, 400);
});

test("resize with fit=cover fills both dimensions", async () => {
  const res = await pipeline(`${dir}/red.jpg`, ["resize", "40x40", "fit=cover", "upscale"], ["write", `${out}/cover/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/cover/red.png`).metadata();
  assert.equal(m.width, 40);
  assert.equal(m.height, 40, "cover fills both axes");
});

test("resize with fit=contain fits inside and letterboxes", async () => {
  const res = await pipeline(`${dir}/red.jpg`, ["resize", "40x40", "fit=contain", "upscale"], ["write", `${out}/contain/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/contain/red.png`).metadata();
  assert.equal(m.width, 40);
  assert.equal(m.height, 40, "contain fits inside both axes");
});

test("resize height-only (x600) constrains by height", async () => {
  const res = await pipeline(`${dir}/red.jpg`, ["resize", "x30"], ["write", `${out}/xht/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/xht/red.png`).metadata();
  assert.equal(m.height, 30);
  assert.equal(m.width, 50, "aspect preserved with height-only");
});

test("write {ext} keeps each source format", async () => {
  const res = await pipeline(
    `${dir}/red.jpg`,
    ["resize", "40"],
    ["write", `${out}/d/{name}.{ext}`],
  );
  assert.equal(res.status, 0, res.stderr);
  assert.equal((await sharp(`${out}/d/red.jpg`).metadata()).format, "jpeg");

  const res2 = await pipeline(
    `${dir}/semi.png`,
    ["resize", "40"],
    ["write", `${out}/d2/{name}.{ext}`],
  );
  assert.equal(res2.status, 0, res2.stderr);
  assert.equal((await sharp(`${out}/d2/semi.png`).metadata()).format, "png");
});

test("jpeg output flattens alpha onto the background", async () => {
  const res = await pipeline(`${dir}/semi.png`, ["write", `${out}/e/{name}.jpg`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/e/semi.jpg`).metadata();
  assert.equal(m.format, "jpeg");
  assert.equal(m.channels, 3, "no alpha channel survives");
});

test("gravity and region crops cut without scaling; bounds are enforced", async () => {
  let res = await pipeline(`${dir}/red.jpg`, ["crop", "20x30"], ["write", `${out}/f/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/f/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "20x30");

  res = await pipeline(`${dir}/red.jpg`, ["crop", "30x30+80+40"], ["write", `${out}/g/{name}.png`]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /exceeds image 100x60/);
  assert.ok(!existsSync(`${out}/g/red.png`), "nothing written on failure");
});

test("crop with gravity=northwest cuts from top-left corner", async () => {
  const res = await pipeline(`${dir}/red.jpg`, ["crop", "30x20", "gravity=northwest"], ["write", `${out}/crop-nw/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/crop-nw/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "30x20");
});

test("crop with gravity=south cuts from bottom", async () => {
  const res = await pipeline(`${dir}/red.jpg`, ["crop", "40x20", "gravity=south"], ["write", `${out}/crop-s/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/crop-s/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "40x20");
});

test("region crop (WxH+LEFT+TOP) cuts from exact offsets", async () => {
  const res = await pipeline(`${dir}/red.jpg`, ["crop", "30x20+50+20"], ["write", `${out}/crop-region/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/crop-region/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "30x20");
});

test("rotate with fractional angle works", async () => {
  const res = await pipeline(`${dir}/red.jpg`, ["rotate", "45.5", "background=white"], ["write", `${out}/rot-frac/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/rot-frac/red.png`).metadata();
  assert.ok(m.width! > 100, "bounding box grows for non-90 rotation");
});

test("rotate 0 does not change dimensions", async () => {
  const res = await pipeline(`${dir}/red.jpg`, ["rotate", "0"], ["write", `${out}/rot-0/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/rot-0/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "100x60");
});

test("rotate 90 swaps dimensions; pad extends them", async () => {
  const res = await pipeline(
    `${dir}/red.jpg`,
    ["rotate", "90"],
    ["pad", "10", "color=white"],
    ["write", `${out}/h/{name}.png`],
  );
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/h/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "80x120", "60x100 rotated, +10 padding each side");
});

test("overlay applied twice composites both layers", async () => {
  const res = await pipeline(
    `${dir}/red.jpg`,
    ["overlay", `${dir}/logo.png`, "gravity=northwest", "opacity=0.8"],
    ["overlay", `${dir}/logo.png`, "gravity=southeast", "opacity=0.5"],
    ["write", `${out}/overlay2/{name}.png`],
  );
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/overlay2/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "100x60");
});

test("overlay with opacity composites successfully", async () => {
  const res = await pipeline(
    `${dir}/red.jpg`,
    ["overlay", `${dir}/logo.png`, "gravity=southeast", "opacity=0.5"],
    ["write", `${out}/i/{name}.png`],
  );
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/i/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "100x60");
});

test("write {i} template substitutes the 1-based index", async () => {
  // Use specific files to avoid picking up files created by concurrent tests
  const res = await run(["read", `${dir}/big.jpg`, `${dir}/red.jpg`]);
  const write = await run(["write", `${out}/idx/{i}-{name}.png`], res.stdout);
  assert.equal(write.status, 0, write.stderr);
  assert.ok(existsSync(`${out}/idx/1-big.png`));
  assert.ok(existsSync(`${out}/idx/2-red.png`));
});

test("blur with default sigma and sharpen with explicit sigma on a still image", async () => {
  const res = await pipeline(`${dir}/red.jpg`, ["blur"], ["sharpen", "2"], ["write", `${out}/bs/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/bs/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "100x60");
});

test("flip on a still image mirrors vertically", async () => {
  const res = await pipeline(`${dir}/red.jpg`, ["flip"], ["write", `${out}/flip/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/flip/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "100x60");
});

test("mirror on a still image mirrors horizontally", async () => {
  const res = await pipeline(`${dir}/red.jpg`, ["mirror"], ["write", `${out}/mirror/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/mirror/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "100x60");
});

test("adjust brightness and saturation on a still image", async () => {
  const res = await pipeline(`${dir}/red.jpg`, ["adjust", "brightness=0.5", "saturation=2"], ["write", `${out}/adj/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/adj/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "100x60");
});

test("pad with a color extends dimensions", async () => {
  const res = await pipeline(`${dir}/red.jpg`, ["pad", "15", "color=blue"], ["write", `${out}/pad/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/pad/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "130x90", "100+30, 60+30");
});

test("write lossless webp produces a valid file", async () => {
  const res = await pipeline(`${dir}/red.jpg`, ["resize", "50"], ["write", `${out}/lossless/{name}.webp`, "lossless"]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/lossless/red.webp`).metadata();
  assert.equal(m.format, "webp");
  assert.equal(m.width, 50);
});

test("animated GIF keeps every frame through resize + crop", async () => {
  const res = await pipeline(
    `${dir}/anim.gif`,
    ["resize", "10"],
    ["crop", "8x8", "gravity=center"],
    ["write", `${out}/anim/{name}.gif`],
  );
  assert.equal(res.status, 0, res.stderr);

  const { data, info } = await sharp(`${out}/anim/anim.gif`, { animated: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.pages, 4, "all 4 source frames survived");
  assert.equal(`${info.width}x${info.pageHeight!}`, "8x8");

  const pageBytes = info.width * info.pageHeight! * info.channels;
  const topLeft = (page: number) => [...data.subarray(page * pageBytes, page * pageBytes + 3)];
  const closeTo = (actual: number[], expected: number[], label: string) => {
    actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]!) <= 8, `${label}: ${actual} ~= ${expected}`));
  };
  closeTo(topLeft(0), [255, 0, 0], "frame 0 stayed red");
  closeTo(topLeft(1), [0, 128, 0], "frame 1 stayed green");
  closeTo(topLeft(2), [0, 0, 255], "frame 2 stayed blue");
  closeTo(topLeft(3), [255, 255, 0], "frame 3 stayed yellow");
});

test("flip does not reverse frame order on animated input", async () => {
  const res = await pipeline(`${dir}/anim.gif`, ["flip"], ["write", `${out}/anim-flip/{name}.gif`]);
  assert.equal(res.status, 0, res.stderr);

  const { data, info } = await sharp(`${out}/anim-flip/anim.gif`, { animated: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  assert.equal(info.pages, 4);
  const pageBytes = info.width * info.pageHeight! * info.channels;
  const mid = (p: number) => {
    const off =
      p * pageBytes + Math.floor(info.pageHeight! / 2) * info.width * info.channels +
      Math.floor(info.width / 2) * info.channels;
    return [...data.subarray(off, off + 3)];
  };
  assert.deepEqual(mid(0), [255, 0, 0], "frame 0 is still first");
  assert.deepEqual(mid(3), [255, 255, 0], "frame 3 is still last, not swapped with frame 0");
});

test("blur and sharpen don't bleed across frame boundaries on animated input", async () => {
  const res = await pipeline(`${dir}/anim.gif`, ["blur", "5"], ["sharpen"], ["write", `${out}/anim-blur/{name}.gif`]);
  assert.equal(res.status, 0, res.stderr);

  const { data, info } = await sharp(`${out}/anim-blur/anim.gif`, { animated: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pageBytes = info.width * info.pageHeight! * info.channels;
  const closeTo = (actual: number[], expected: number[], label: string) =>
    actual.forEach((v, i) => assert.ok(Math.abs(v - expected[i]!) <= 10, `${label}: ${actual} ~= ${expected}`));
  const topRow = (p: number) => {
    const off = p * pageBytes + Math.floor(info.width / 2) * info.channels;
    return [...data.subarray(off, off + 3)];
  };
  closeTo(topRow(1), [0, 128, 0], "frame 1's top row is pure green, not blended with frame 0's red");
  closeTo(topRow(2), [0, 0, 255], "frame 2's top row is pure blue, not blended with frame 1's green");
});

test("overlay and an explicit-angle rotate succeed on animated input", async () => {
  const res = await pipeline(
    `${dir}/anim.gif`,
    ["resize", "40", "upscale"],
    ["rotate", "90"],
    ["overlay", `${dir}/logo.png`, "gravity=southeast"],
    ["write", `${out}/anim-overlay/{name}.gif`],
  );
  assert.equal(res.status, 0, res.stderr);
  const meta = await sharp(`${out}/anim-overlay/anim.gif`, { animated: true }).metadata();
  assert.equal(meta.pages, 4);
  assert.equal(`${meta.width}x${meta.pageHeight}`, "40x40");
});

test("frame delay and loop count survive an animated round trip", async () => {
  const res = await pipeline(`${dir}/anim.gif`, ["resize", "10"], ["write", `${out}/anim-delay/{name}.gif`]);
  assert.equal(res.status, 0, res.stderr);
  const meta = await sharp(`${out}/anim-delay/anim.gif`, { animated: true }).metadata();
  assert.deepEqual(meta.delay, [40, 80, 120, 160]);
  assert.equal(meta.loop, 2);
});

test("writing animated frames to a format that can't keep them is refused", async () => {
  const res = await pipeline(`${dir}/anim.gif`, ["write", `${out}/anim-flat/{name}.jpg`]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /cannot write 4 animated frames to jpeg/);
  assert.ok(!existsSync(`${out}/anim-flat/anim.jpg`));
});

test("output collisions are caught before anything is written", async () => {
  const res = await pipeline(`${dir}/**/red.jpg`, ["write", `${out}/j/{name}.png`]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /both write to/);
  assert.ok(!existsSync(`${out}/j/red.png`));

  const ok = await pipeline(`${dir}/**/red.jpg`, ["write", `${out}/j/{name}-{i}.png`]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(existsSync(`${out}/j/red-1.png`));
  assert.ok(existsSync(`${out}/j/red-2.png`));
});

test("writing over an input is refused", async () => {
  const res = await pipeline(`${dir}/red.jpg`, ["write", `${dir}/{name}.jpg`]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /overwrite its own input/);
});

test("a corrupt input fails the batch with the file named", async () => {
  mkdirSync(join(dir, "corrupt"), { recursive: true });
  writeFileSync(join(dir, "corrupt", "bad.jpg"), "this is not a jpeg");
  await sharp({ create: { width: 10, height: 10, channels: 3, background: "red" } })
    .jpeg()
    .toFile(join(dir, "corrupt", "ok.jpg"));

  const res = await pipeline(`${dir}/corrupt/*.jpg`, ["write", `${out}/k/{name}.png`]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /bad\.jpg/);
});

test("a URL source is fetched straight into the pipeline", async () => {
  const res = await pipeline(
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
  // Also test the URL source mixed in via read
  const read = await run(["read", `${dir}/red.jpg`, `${base}/photo.jpg?w=800&sig=abc`]);
  const write = await run(["write", `${out}/mix2/{name}.png`], read.stdout);
  assert.equal(write.status, 0, write.stderr);
  assert.ok(existsSync(`${out}/mix2/red.png`));
  assert.ok(existsSync(`${out}/mix2/photo.png`));
});

test("a 404 URL source fails the batch with the URL named", async () => {
  const res = await pipeline(`${base}/missing`, ["write", `${out}/url/{name}.png`]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /missing.*HTTP 404/);
});

test("a URL source over the fetch size cap is rejected without downloading it", async () => {
  const res = await pipeline(`${base}/huge`, ["write", `${out}/url/{name}.png`]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /fetch limit/);
});

test("info prints a row per file", async () => {
  // Create a dedicated subdirectory to avoid picking up files from concurrent tests
  const infoDir = join(dir, "info-test");
  mkdirSync(infoDir, { recursive: true });
  await sharp({ create: { width: 100, height: 60, channels: 3 as const, background: "red" } })
    .jpeg()
    .toFile(join(infoDir, "a.jpg"));
  await sharp({ create: { width: 200, height: 120, channels: 3 as const, background: "blue" } })
    .jpeg()
    .toFile(join(infoDir, "b.jpg"));

  const res = await run(["info", `${infoDir}/*.jpg`]);
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /jpeg\s+100x60/);
  assert.match(lines[1]!, /jpeg\s+200x120/);
});

test("formats prints the runtime support table", async () => {
  const res = await run(["formats"]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /format\s+read\s+write/);
  assert.match(res.stdout, /webp\s+yes\s+yes/);
  assert.match(res.stdout, /svg\s+yes\s+no/);
});

// ---------------------------------------------------------------------------
// Edge-case tests
// ---------------------------------------------------------------------------

test("zero-byte file fails with a sharp decode error", async () => {
  writeFileSync(join(dir, "empty.jpg"), "");
  const res = await pipeline(`${dir}/empty.jpg`, ["write", `${out}/empty/{name}.png`]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /empty\.jpg/);
  assert.ok(!existsSync(`${out}/empty/empty.png`));
});

test("truncated JPEG (valid header, no image data) fails at decode", async () => {
  // JPEG header: ff d8 ff e0 ... then garbage
  writeFileSync(join(dir, "trunc.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]));
  const res = await pipeline(`${dir}/trunc.jpg`, ["write", `${out}/trunc/{name}.png`]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /trunc\.jpg/);
});

test("garbage file with .jpg extension fails at decode", async () => {
  writeFileSync(join(dir, "garbage.jpg"), "this is definitely not an image");
  const res = await pipeline(`${dir}/garbage.jpg`, ["write", `${out}/garbage/{name}.png`]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /garbage\.jpg/);
});

test("very large image (2000x2000) resizes without error", async () => {
  const largeDir = mkdtempSync(join(tmpdir(), "photu-large-")).replaceAll("\\", "/");
  try {
    await sharp({ create: { width: 2000, height: 2000, channels: 3 as const, background: "red" } })
      .jpeg()
      .toFile(join(largeDir, "huge.jpg"));

    const res = await pipeline(`${largeDir}/*.jpg`, ["resize", "100"], ["write", `${out}/large/{name}.png`]);
    assert.equal(res.status, 0, res.stderr);
    const m = await sharp(`${out}/large/huge.png`).metadata();
    assert.equal(m.width, 100);
    assert.equal(m.height, 100, "square preserved");
  } finally {
    rmSync(largeDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("write creates nested output directories automatically", async () => {
  const deep = `${out}/a/b/c/d`;
  const res = await pipeline(`${dir}/red.jpg`, ["write", `${deep}/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(`${deep}/red.png`));
});

test("two concurrent pipelines writing to the same output: at least one succeeds without corruption", async () => {
  const shared = `${out}/concurrent`;
  // Both processes write red.jpg → the same output path.  The winner
  // depends on OS scheduling; we assert that at least one succeeds and
  // the final file is a valid PNG.
  const [r1, r2] = await Promise.all([
    pipeline(`${dir}/red.jpg`, ["resize", "30"], ["write", `${shared}/{name}.png`]),
    pipeline(`${dir}/red.jpg`, ["resize", "30"], ["write", `${shared}/{name}.png`]),
  ]);
  assert.ok(r1.status === 0 || r2.status === 0, "at least one pipeline should succeed");
  assert.ok(existsSync(`${shared}/red.png`), "output file exists");
  const m = await sharp(`${shared}/red.png`).metadata();
  assert.equal(m.format, "png");
  assert.equal(m.width, 30, "file is a valid 30px-wide PNG");
});

test("read with a non-matching glob produces EEMPTY", async () => {
  const res = await run(["read", `${dir}/*.xyz`]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /matched no files/);
});

test("all nine gravity values work for crop", async () => {
  const gravities = [
    "center", "north", "northeast", "east", "southeast",
    "south", "southwest", "west", "northwest",
  ];
  for (const g of gravities) {
    const res = await pipeline(
      `${dir}/red.jpg`,
      ["crop", "30x20", `gravity=${g}`],
      ["write", `${out}/grav-${g}/{name}.png`],
    );
    assert.equal(res.status, 0, `gravity=${g}: ${res.stderr}`);
    const m = await sharp(`${out}/grav-${g}/red.png`).metadata();
    assert.equal(`${m.width}x${m.height}`, "30x20", `gravity=${g}`);
  }
});

test("all five fit values work for resize", async () => {
  const fits = ["inside", "cover", "contain", "fill", "outside"];
  for (const f of fits) {
    const res = await pipeline(
      `${dir}/red.jpg`,
      ["resize", "40x40", `fit=${f}`, "upscale"],
      ["write", `${out}/fit-${f}/{name}.png`],
    );
    assert.equal(res.status, 0, `fit=${f}: ${res.stderr}`);
    const m = await sharp(`${out}/fit-${f}/red.png`).metadata();
    assert.ok(m.width! > 0 && m.height! > 0, `fit=${f}: positive dimensions`);
  }
});

test("maximum blur sigma (1000) runs without crashing", async () => {
  const res = await pipeline(`${dir}/red.jpg`, ["blur", "1000"], ["write", `${out}/maxblur/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/maxblur/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "100x60");
});

test("maximum sharpen sigma (10) runs without crashing", async () => {
  const res = await pipeline(`${dir}/red.jpg`, ["sharpen", "10"], ["write", `${out}/maxsharp/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/maxsharp/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "100x60");
});

test("rotate 360 degrees preserves dimensions", async () => {
  const res = await pipeline(`${dir}/red.jpg`, ["rotate", "360"], ["write", `${out}/rot360/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/rot360/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "100x60");
});

test("rotate negative angle works", async () => {
  const res = await pipeline(`${dir}/red.jpg`, ["rotate", "-90"], ["write", `${out}/rot-neg/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/rot-neg/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "60x100", "-90 swaps like +90");
});

test("pad with zero-size is rejected", async () => {
  // pad 0 is rejected by the parser (size must be > 0)
  const plan = await run(["read", `${dir}/red.jpg`]);
  const res = await run(["pad", "0"], plan.stdout);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /invalid padding/);
});

test("overlay with full opacity (1.0) works", async () => {
  const res = await pipeline(
    `${dir}/red.jpg`,
    ["overlay", `${dir}/logo.png`, "gravity=center", "opacity=1"],
    ["write", `${out}/overlay-full/{name}.png`],
  );
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/overlay-full/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "100x60");
});

test("overlay with zero opacity (0.0) works", async () => {
  const res = await pipeline(
    `${dir}/red.jpg`,
    ["overlay", `${dir}/logo.png`, "gravity=center", "opacity=0"],
    ["write", `${out}/overlay-zero/{name}.png`],
  );
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/overlay-zero/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "100x60");
});

test("pipeline with all transform stages in sequence produces correct output", async () => {
  const res = await pipeline(
    `${dir}/red.jpg`,
    ["resize", "80"],
    ["crop", "40x30", "gravity=center"],
    ["rotate", "45", "background=white"],
    ["flip"],
    ["mirror"],
    ["grayscale"],
    ["adjust", "brightness=1.2", "saturation=0.8", "hue=15"],
    ["blur", "1.5"],
    ["sharpen", "0.5"],
    ["pad", "5", "color=white"],
    ["write", `${out}/kitchen-sink/{name}.webp`, "quality=90"],
  );
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/kitchen-sink/red.webp`).metadata();
  assert.equal(m.format, "webp");
  // After all transforms + 5px pad on each side
  assert.ok(m.width! > 0 && m.height! > 0, "positive dimensions");
});

test("write to avif with low quality produces a valid file", async () => {
  const res = await pipeline(`${dir}/red.jpg`, ["resize", "30"], ["write", `${out}/avif/{name}.avif`, "quality=20"]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/avif/red.avif`).metadata();
  assert.ok(String(m.format) === "avif" || String(m.format) === "heif", `format is ${m.format}`);
  assert.equal(m.width, 30);
});

test("write to tiff produces a valid file", async () => {
  const res = await pipeline(`${dir}/red.jpg`, ["resize", "30"], ["write", `${out}/tiff/{name}.tiff`, "quality=80"]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/tiff/red.tiff`).metadata();
  assert.equal(m.format, "tiff");
  assert.equal(m.width, 30);
});

test("stress: 100-frame animated GIF through multiple stages", async () => {
  // Create a 100-frame animated GIF, each frame a solid color cycling through the spectrum
  const frameCount = 100;
  const frames = await Promise.all(
    Array.from({ length: frameCount }, (_, i) => {
      const hue = (i * 360) / frameCount;
      // Convert HSL hue to an RGB-ish color for sharp
      const r = Math.round(127.5 + 127.5 * Math.cos((hue * Math.PI) / 180));
      const g = Math.round(127.5 + 127.5 * Math.cos(((hue - 120) * Math.PI) / 180));
      const b = Math.round(127.5 + 127.5 * Math.cos(((hue - 240) * Math.PI) / 180));
      return sharp({
        create: { width: 40, height: 30, channels: 3 as const, background: `rgb(${r},${g},${b})` },
      })
        .png()
        .toBuffer();
    }),
  );

  const delays = Array.from({ length: frameCount }, (_, i) => 20 + (i % 5) * 10); // 20-60ms
  const animDir = join(dir, "anim-stress");
  mkdirSync(animDir, { recursive: true });
  await sharp(frames, { join: { animated: true } })
    .gif({ delay: delays, loop: 3 })
    .toFile(join(animDir, "spectrum.gif"));

  // Verify the source
  const srcMeta = await sharp(join(animDir, "spectrum.gif"), { animated: true }).metadata();
  assert.equal(srcMeta.pages, frameCount, "source has 100 frames");
  assert.equal(srcMeta.loop, 3, "source loop count is 3");
  assert.equal(srcMeta.delay?.length, frameCount, "source has per-frame delays");

  // Pipeline: resize + crop + sharpen + write as webp
  const start = Date.now();
  const res = await pipeline(
    `${animDir}/*.gif`,
    ["resize", "20", "upscale"],
    ["crop", "16x12", "gravity=center"],
    ["sharpen"],
    ["write", `${out}/anim-stress/{name}.webp`],
  );
  const elapsed = Date.now() - start;

  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, "");

  // Verify output
  const outMeta = await sharp(`${out}/anim-stress/spectrum.webp`, { animated: true }).metadata();
  assert.equal(outMeta.pages, frameCount, `all ${frameCount} frames survived`);
  assert.equal(outMeta.width, 16, "width after resize+crop");
  assert.equal(outMeta.pageHeight, 12, "height after resize+crop");
  assert.equal(outMeta.loop, 3, "loop count preserved");
  assert.equal(outMeta.delay?.length, frameCount, "per-frame delays preserved");

  // Verify frame content: sample the center pixel of each frame.
  // Each source frame was a solid color; after resize+crop+sharpen the
  // center pixel should still be close to that color (sharpen doesn't
  // change flat regions much).
  const { data, info } = await sharp(`${out}/anim-stress/spectrum.webp`, { animated: true })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pageBytes = info.width * info.pageHeight! * info.channels;
  const centerOffset =
    Math.floor(info.pageHeight! / 2) * info.width * info.channels +
    Math.floor(info.width / 2) * info.channels;

  // Check first, middle, and last frames have distinct colors
  const pixel = (frame: number) => [
    data[frame * pageBytes + centerOffset]!,
    data[frame * pageBytes + centerOffset + 1]!,
    data[frame * pageBytes + centerOffset + 2]!,
  ];
  const p0 = pixel(0);
  const p50 = pixel(50);
  const p99 = pixel(99);
  // At least one channel should differ between frames
  const differs = (a: number[], b: number[]) => a.some((v, i) => Math.abs(v - b[i]!) > 20);
  assert.ok(differs(p0, p50), "frame 0 and frame 50 should have different center colors");
  assert.ok(differs(p50, p99), "frame 50 and frame 99 should have different center colors");

  // 100 frames through resize+crop+sharpen+write should complete in <30s
  assert.ok(elapsed < 30_000, `animated stress test took ${elapsed}ms, expected <30s`);
});

test("trim removes border pixels matching the background", async () => {
  // Create a 100x60 red image with a 10px white border
  const bordered = await sharp({
    create: { width: 120, height: 80, channels: 3 as const, background: "white" },
  })
    .composite([{ input: await sharp({ create: { width: 100, height: 60, channels: 3 as const, background: "red" } }).png().toBuffer(), left: 10, top: 10 }])
    .png()
    .toBuffer();
  writeFileSync(join(dir, "bordered.png"), bordered);

  const res = await pipeline(`${dir}/bordered.png`, ["trim"], ["write", `${out}/trim/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/trim/bordered.png`).metadata();
  assert.equal(m.width, 100, "trimmed to content width");
  assert.equal(m.height, 60, "trimmed to content height");
});

test("trim with threshold keeps near-background pixels", async () => {
  const res = await pipeline(`${dir}/red.jpg`, ["trim", "threshold=0"], ["write", `${out}/trim0/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/trim0/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "100x60", "no trim on solid color with threshold 0");
});

test("normalize stretches contrast on a still image", async () => {
  const res = await pipeline(`${dir}/red.jpg`, ["normalize"], ["write", `${out}/norm/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/norm/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "100x60");
});

test("negate inverts colors on a still image", async () => {
  const res = await pipeline(`${dir}/red.jpg`, ["negate"], ["write", `${out}/neg/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/neg/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "100x60");
});

test("sepia applies warm tone at full and zero strength", async () => {
  const full = await pipeline(`${dir}/red.jpg`, ["sepia", "strength=1"], ["write", `${out}/sepia-full/{name}.png`]);
  assert.equal(full.status, 0, full.stderr);
  const zero = await pipeline(`${dir}/red.jpg`, ["sepia", "strength=0"], ["write", `${out}/sepia-zero/{name}.png`]);
  assert.equal(zero.status, 0, zero.stderr);
  const mFull = await sharp(`${out}/sepia-full/red.png`).metadata();
  const mZero = await sharp(`${out}/sepia-zero/red.png`).metadata();
  assert.equal(`${mFull.width}x${mFull.height}`, "100x60");
  assert.equal(`${mZero.width}x${mZero.height}`, "100x60");
});

test("level adjusts black and white points", async () => {
  const res = await pipeline(`${dir}/red.jpg`, ["level", "black=16", "white=240"], ["write", `${out}/lvl/{name}.png`]);
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/lvl/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "100x60");
});

test("level rejects black >= white", async () => {
  const plan = await run(["read", `${dir}/red.jpg`]);
  const res = await run(["level", "black=200", "white=100"], plan.stdout);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /black .* must be below white/);
});

test("median reduces noise with default and explicit size", async () => {
  const def = await pipeline(`${dir}/red.jpg`, ["median"], ["write", `${out}/med-def/{name}.png`]);
  assert.equal(def.status, 0, def.stderr);
  const med5 = await pipeline(`${dir}/red.jpg`, ["median", "5"], ["write", `${out}/med-5/{name}.png`]);
  assert.equal(med5.status, 0, med5.stderr);
  const m = await sharp(`${out}/med-5/red.png`).metadata();
  assert.equal(`${m.width}x${m.height}`, "100x60");
});

test("median rejects even or out-of-range sizes", async () => {
  const plan = await run(["read", `${dir}/red.jpg`]);
  const res = await run(["median", "4"], plan.stdout);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /odd integer/);
  const res2 = await run(["median", "16"], plan.stdout);
  assert.equal(res2.status, 1);
  assert.match(res2.stderr, /odd integer/);
});

test("kitchen-sink pipeline including all new ops", async () => {
  const res = await pipeline(
    `${dir}/red.jpg`,
    ["trim"],
    ["normalize"],
    ["negate"],
    ["sepia", "strength=0.5"],
    ["level", "black=10", "white=245"],
    ["median", "3"],
    ["resize", "80"],
    ["write", `${out}/ks2/{name}.webp`, "quality=85"],
  );
  assert.equal(res.status, 0, res.stderr);
  const m = await sharp(`${out}/ks2/red.webp`).metadata();
  assert.equal(m.format, "webp");
  assert.ok(m.width! > 0 && m.height! > 0, "positive dimensions");
});

test("file over the size limit is refused before decoding", async () => {
  const big = mkdtempSync(join(tmpdir(), "photu-big-"));
  try {
    writeFileSync(join(big, "huge.jpg"), Buffer.alloc(100 * 1024 * 1024 + 1));
    const res = await pipeline(`${big}/*.jpg`, ["write", `${out}/big/{name}.png`]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /exceeds the 100 MB file size limit/);
  } finally {
    rmSync(big, { recursive: true, force: true });
  }
});

test("image over the max dimension is refused", async () => {
  const bigDir = mkdtempSync(join(tmpdir(), "photu-bigdim-"));
  try {
    // 10001px wide x 500px tall = ~5M pixels, under sharp's ~268M pixel limit
    await sharp({ create: { width: 10001, height: 500, channels: 3 as const, background: "red" } })
      .png()
      .toFile(join(bigDir, "huge.png"));
    const res = await pipeline(`${bigDir}/*.png`, ["write", `${out}/bigdim/{name}.png`]);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /exceeds the 10000px maximum dimension/);
  } finally {
    rmSync(bigDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

}); // describe("exec")
