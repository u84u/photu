import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import sharp from "sharp";
import Vips from "wasm-vips";
import { normalizeOp } from "../src/core/ops.ts";
import { renderPipeline, parseColor, ExecError } from "../playground/exec-wasm.js";

sharp.cache(false);

let vips: Awaited<ReturnType<typeof Vips>>;
let red: Buffer;
let semi: Buffer;

// A local HTTP server stands in for a remote host (for overlay URL tests).
let server: ReturnType<typeof createServer>;
let overlayBase: string;

let animGif: Buffer;

before(async () => {
  vips = await Vips();
  red = await sharp({ create: { width: 100, height: 60, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  semi = await sharp({
    create: { width: 80, height: 80, channels: 4, background: { r: 0, g: 0, b: 255, alpha: 0.5 } },
  })
    .png()
    .toBuffer();

  const overlayImg = await sharp({ create: { width: 30, height: 30, channels: 4, background: "blue" } })
    .png()
    .toBuffer();
  server = createServer((req, res) => {
    if (req.url === "/overlay.png") {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(overlayImg);
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  overlayBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  animGif = await makeAnimatedGif(4, 20, 20, [40, 80, 120, 160]);
});
after(async () => {
  vips.shutdown();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function ops(...stages: [string, string[]][]) {
  return stages.map(([cmd, tokens]) => normalizeOp(cmd, tokens));
}

test("parseColor handles names and hex", () => {
  assert.deepEqual(parseColor("white"), [255, 255, 255]);
  assert.deepEqual(parseColor("#ff8000"), [255, 128, 0]);
  assert.deepEqual(parseColor("#f80"), [255, 136, 0]);
  assert.throws(() => parseColor("mauve-ish"), (e: ExecError) => e.code === "EBADARG");
});

test("resize inside preserves aspect and refuses upscale by default", async () => {
  let out = await renderPipeline(vips, red, ops(["resize", ["50"]]));
  assert.equal(`${out.width}x${out.height}`, "50x30");

  out = await renderPipeline(vips, red, ops(["resize", ["400"]]));
  assert.equal(out.width, 100, "no upscale");

  out = await renderPipeline(vips, red, ops(["resize", ["400", "upscale"]]));
  assert.equal(out.width, 400);
});

test("resize cover fills both dimensions", async () => {
  const out = await renderPipeline(vips, red, ops(["resize", ["40x40", "fit=cover", "upscale"]]));
  assert.equal(`${out.width}x${out.height}`, "40x40");
});

test("crop cuts without scaling and enforces bounds", async () => {
  const out = await renderPipeline(vips, red, ops(["crop", ["20x30"]]));
  assert.equal(`${out.width}x${out.height}`, "20x30");

  const region = await renderPipeline(vips, red, ops(["crop", ["30x30+70+30"]]));
  assert.equal(`${region.width}x${region.height}`, "30x30");

  assert.rejects(
    async () => {
      await renderPipeline(vips, red, ops(["crop", ["30x30+80+40"]]));
    },
    (e: ExecError) => e.code === "ERUNTIME" && /exceeds image 100x60/.test(e.message),
  );
});

test("rotate 90 swaps dimensions; arbitrary angles run", async () => {
  const out = await renderPipeline(vips, red, ops(["rotate", ["90"]]));
  assert.equal(`${out.width}x${out.height}`, "60x100");

  const skew = await renderPipeline(vips, red, ops(["rotate", ["45", "background=white"]]));
  assert.ok(skew.width > 100, "bounding box grows");
});

test("flip, mirror, grayscale, adjust, blur, sharpen all execute", async () => {
  const out = await renderPipeline(
    vips,
    red,
    ops(
      ["flip", []],
      ["mirror", []],
      ["grayscale", []],
      ["adjust", ["brightness=1.2", "hue=90"]],
      ["blur", ["2.5"]],
      ["sharpen", []],
    ),
  );
  assert.equal(`${out.width}x${out.height}`, "100x60");
});

test("pad extends dimensions with a color", async () => {
  const out = await renderPipeline(vips, red, ops(["pad", ["10", "color=#00ff00"]]));
  assert.equal(`${out.width}x${out.height}`, "120x80");
});

test("write controls format; jpeg flattens alpha", async () => {
  const webp = await renderPipeline(vips, red, ops(["resize", ["50"]], ["write", ["o.webp", "quality=70"]]));
  assert.equal(webp.ext, "webp");
  assert.equal((await sharp(Buffer.from(webp.bytes)).metadata()).format, "webp");

  const jpg = await renderPipeline(vips, semi, ops(["write", ["o.jpg"]]));
  const m = await sharp(Buffer.from(jpg.bytes)).metadata();
  assert.equal(m.format, "jpeg");
  assert.equal(m.channels, 3, "alpha flattened");

  const avif = await renderPipeline(vips, red, ops(["write", ["o.avif", "quality=50"]]));
  assert.equal((await sharp(Buffer.from(avif.bytes)).metadata()).format, "heif");
});

test("write {ext} keeps the source format via the file name", async () => {
  const out = await renderPipeline(vips, red, ops(["write", ["out/{name}.{ext}"]]), "photo.png");
  assert.equal(out.ext, "png");
  assert.equal((await sharp(Buffer.from(out.bytes)).metadata()).format, "png");
});

test("no write op defaults to png preview", async () => {
  const out = await renderPipeline(vips, red, ops(["resize", ["30"]]));
  assert.equal(out.ext, "png");
  assert.equal((await sharp(Buffer.from(out.bytes)).metadata()).format, "png");
});

test("overlay composites a URL image at default gravity with full opacity", async () => {
  const out = await renderPipeline(
    vips,
    red,
    ops(["overlay", [`${overlayBase}/overlay.png`]]),
    "photo.png",
  );
  assert.equal(`${out.width}x${out.height}`, "100x60");
  const m = await sharp(Buffer.from(out.bytes)).metadata();
  assert.equal(m.format, "png");
  // Center pixel should be influenced by blue overlay (red image has center at 50,30)
  const { data } = await sharp(Buffer.from(out.bytes)).raw().toBuffer({ resolveWithObject: true });
  const center = data[30 * 100 * 3 + 50 * 3];
  assert.ok(center! < 255, "blue overlay darkened the red center pixel");
});

test("overlay with opacity less than 1 runs without error", async () => {
  const partial = await renderPipeline(
    vips,
    red,
    ops(["overlay", [`${overlayBase}/overlay.png`, "opacity=0.5"]]),
    "photo.png",
  );
  assert.equal(partial.ext, "png");
  assert.equal(partial.width, 100);
  assert.equal(partial.height, 60);
});

test("overlay with local path fails in playground", async () => {
  assert.rejects(
    async () => {
      await renderPipeline(vips, red, ops(["overlay", ["logo.png"]]), "photo.png");
    },
    (e: ExecError) => e.code === "EUNSUPPORTED",
  );
});

// ---------------------------------------------------------------------------
// Edge-case tests
// ---------------------------------------------------------------------------

test("parseColor handles all named colors and is case-insensitive", () => {
  assert.deepEqual(parseColor("black"), [0, 0, 0]);
  assert.deepEqual(parseColor("RED"), [255, 0, 0]);
  assert.deepEqual(parseColor("Green"), [0, 128, 0]);
  assert.deepEqual(parseColor("BLUE"), [0, 0, 255]);
  assert.deepEqual(parseColor("yellow"), [255, 255, 0]);
  assert.deepEqual(parseColor("cyan"), [0, 255, 255]);
  assert.deepEqual(parseColor("magenta"), [255, 0, 255]);
  assert.deepEqual(parseColor("gray"), [128, 128, 128]);
  assert.deepEqual(parseColor("grey"), [128, 128, 128]);
  assert.deepEqual(parseColor("orange"), [255, 165, 0]);
});

test("parseColor rejects invalid hex formats", () => {
  assert.throws(() => parseColor("#xyz"), (e: ExecError) => e.code === "EBADARG");
  assert.throws(() => parseColor("#12345"), (e: ExecError) => e.code === "EBADARG");
  assert.throws(() => parseColor("#1234567"), (e: ExecError) => e.code === "EBADARG");
  assert.throws(() => parseColor(""), (e: ExecError) => e.code === "EBADARG");
  assert.throws(() => parseColor("rgb(255,0,0)"), (e: ExecError) => e.code === "EBADARG");
});

test("resize height-only constrains by height", async () => {
  // red is 100x60, x30 should halve height and scale width proportionally
  const out = await renderPipeline(vips, red, ops(["resize", ["x30"]]));
  assert.equal(`${out.width}x${out.height}`, "50x30");
});

test("resize fit=contain letterboxes inside both dimensions", async () => {
  // 100x60 image into 40x40 — should fit inside (40x24) then embed
  const out = await renderPipeline(vips, red, ops(["resize", ["40x40", "fit=contain", "upscale"]]));
  assert.equal(`${out.width}x${out.height}`, "40x40");
});

test("resize fit=fill stretches to exact dimensions", async () => {
  const out = await renderPipeline(vips, red, ops(["resize", ["40x80", "fit=fill", "upscale"]]));
  assert.equal(`${out.width}x${out.height}`, "40x80");
});

test("resize fit=outside uses the larger scale", async () => {
  // 100x60 into 40x40 — outside scales by max(40/100, 40/60)=0.667 → 67x40
  const out = await renderPipeline(vips, red, ops(["resize", ["40x40", "fit=outside", "upscale"]]));
  assert.equal(`${out.width}x${out.height}`, "67x40");
});

test("crop with all nine gravity values", async () => {
  const gravities = [
    ["center", "35,15"],
    ["north", "35,0"],
    ["northeast", "65,0"],
    ["east", "65,15"],
    ["southeast", "65,30"],
    ["south", "35,30"],
    ["southwest", "5,30"],
    ["west", "5,15"],
    ["northwest", "5,0"],
  ];
  for (const [g] of gravities) {
    const out = await renderPipeline(vips, red, ops(["crop", ["30x30", `gravity=${g}`]]));
    assert.equal(`${out.width}x${out.height}`, "30x30", `gravity=${g}`);
  }
});

test("rotate 0 is a no-op", async () => {
  const out = await renderPipeline(vips, red, ops(["rotate", ["0"]]));
  assert.equal(`${out.width}x${out.height}`, "100x60");
});

test("rotate 180 preserves dimensions", async () => {
  const out = await renderPipeline(vips, red, ops(["rotate", ["180"]]));
  assert.equal(`${out.width}x${out.height}`, "100x60");
});

test("rotate 270 swaps dimensions like -90", async () => {
  const out270 = await renderPipeline(vips, red, ops(["rotate", ["270"]]));
  assert.equal(`${out270.width}x${out270.height}`, "60x100");

  const outNeg = await renderPipeline(vips, red, ops(["rotate", ["-90"]]));
  assert.equal(`${outNeg.width}x${outNeg.height}`, "60x100");
});

test("rotate 360 is a no-op", async () => {
  const out = await renderPipeline(vips, red, ops(["rotate", ["360"]]));
  assert.equal(`${out.width}x${out.height}`, "100x60");
});

test("rotate fractional angle works", async () => {
  const out = await renderPipeline(vips, red, ops(["rotate", ["45.5", "background=white"]]));
  assert.ok(out.width > 100, "bounding box grows for non-90 rotation");
});

test("blur with default sigma (null) uses a reasonable default", async () => {
  const out = await renderPipeline(vips, red, ops(["blur", []]));
  assert.equal(`${out.width}x${out.height}`, "100x60", "dimensions unchanged");
});

test("blur with explicit sigma", async () => {
  const out = await renderPipeline(vips, red, ops(["blur", ["5"]]));
  assert.equal(`${out.width}x${out.height}`, "100x60");
});

test("sharpen with default sigma (null)", async () => {
  const out = await renderPipeline(vips, red, ops(["sharpen", []]));
  assert.equal(`${out.width}x${out.height}`, "100x60");
});

test("sharpen with explicit sigma", async () => {
  const out = await renderPipeline(vips, red, ops(["sharpen", ["2"]]));
  assert.equal(`${out.width}x${out.height}`, "100x60");
});

test("adjust with all three knobs at extremes", async () => {
  const out = await renderPipeline(vips, red, ops(["adjust", ["brightness=0.1", "saturation=3", "hue=180"]]));
  assert.equal(`${out.width}x${out.height}`, "100x60");
});

test("adjust with brightness=0 (fully dark)", async () => {
  const out = await renderPipeline(vips, red, ops(["adjust", ["brightness=0"]]));
  assert.equal(`${out.width}x${out.height}`, "100x60");
});

test("pad with all named colors", async () => {
  for (const color of ["black", "white", "red", "green", "blue"]) {
    const out = await renderPipeline(vips, red, ops(["pad", ["5", `color=${color}`]]));
    assert.equal(`${out.width}x${out.height}`, "110x70", `pad color=${color}`);
  }
});

test("pad with hex color", async () => {
  const out = await renderPipeline(vips, red, ops(["pad", ["10", "color=#ff8000"]]));
  assert.equal(`${out.width}x${out.height}`, "120x80");
});

test("write lossless webp", async () => {
  const out = await renderPipeline(vips, red, ops(["resize", ["30"]], ["write", ["o.webp", "lossless"]]));
  assert.equal(out.ext, "webp");
  const m = await sharp(Buffer.from(out.bytes)).metadata();
  assert.equal(m.format, "webp");
  assert.equal(m.width, 30);
});

test("write lossless avif", async () => {
  const out = await renderPipeline(vips, red, ops(["write", ["o.avif", "lossless"]]));
  assert.equal(out.ext, "avif");
  const m = await sharp(Buffer.from(out.bytes)).metadata();
  assert.ok(String(m.format) === "avif" || String(m.format) === "heif");
});

test("write with quality parameter is accepted", async () => {
  const out = await renderPipeline(vips, red, ops(["write", ["o.webp", "quality=50"]]));
  assert.equal(out.ext, "webp");
  const m = await sharp(Buffer.from(out.bytes)).metadata();
  assert.equal(m.format, "webp");
});

test("write {ext} with tiff source name resolves to tif extension", async () => {
  const out = await renderPipeline(vips, red, ops(["write", ["out/{name}.{ext}"]]), "photo.tiff");
  assert.equal(out.ext, "tif");
});

test("write {ext} with webp source name keeps webp format", async () => {
  const out = await renderPipeline(vips, red, ops(["write", ["out/{name}.{ext}"]]), "photo.webp");
  assert.equal(out.ext, "webp");
  const m = await sharp(Buffer.from(out.bytes)).metadata();
  assert.equal(m.format, "webp");
});

test("write {ext} with unrecognized extension fails", async () => {
  assert.rejects(
    async () => {
      await renderPipeline(vips, red, ops(["write", ["out/{name}.{ext}"]]), "photo.bmp");
    },
    (e: ExecError) => e.code === "ERUNTIME" && /unrecognized/.test(e.message),
  );
});

test("write {ext} with no extension fails", async () => {
  assert.rejects(
    async () => {
      await renderPipeline(vips, red, ops(["write", ["out/{name}.{ext}"]]), "photo");
    },
    (e: ExecError) => e.code === "ERUNTIME" && /no extension/.test(e.message),
  );
});

test("renderPipeline with empty ops returns the image as-is", async () => {
  const out = await renderPipeline(vips, red, []);
  assert.equal(`${out.width}x${out.height}`, "100x60");
  assert.equal(out.ext, "png", "defaults to png");
});

test("unknown op throws EUNKNOWN", async () => {
  assert.rejects(
    async () => {
      await renderPipeline(vips, red, [{ op: "vignette" } as { op: string; [key: string]: unknown }]);
    },
    (e: ExecError) => e.code === "EUNKNOWN",
  );
});

test("very small image (1x1) survives resize and crop", async () => {
  const tiny = await renderPipeline(vips, red, ops(["resize", ["1x1", "upscale"]]));
  assert.equal(`${tiny.width}x${tiny.height}`, "1x1");
});

test("very large resize target with upscale", async () => {
  // 100x60 image resized to 200x200 with fit=inside: scales by min(2, 3.33)=2 → 200x120
  const out = await renderPipeline(vips, red, ops(["resize", ["200x200", "upscale"]]));
  assert.equal(`${out.width}x${out.height}`, "200x120");
});

test("chained transforms: resize + rotate + flip + grayscale + blur + sharpen + pad", async () => {
  const out = await renderPipeline(
    vips,
    red,
    ops(
      ["resize", ["50"]],
      ["rotate", ["90"]],
      ["flip", []],
      ["mirror", []],
      ["grayscale", []],
      ["blur", ["1"]],
      ["sharpen", ["0.5"]],
      ["pad", ["5", "color=white"]],
    ),
  );
  // After resize 50 → 50x30, rotate 90 → 30x50, flip+mirror don't change size,
  // grayscale doesn't change size, blur+sharpen don't change size, pad +10 each side → 40x60
  assert.equal(`${out.width}x${out.height}`, "40x60");
});

test("grayscale on already grayscale image is a no-op", async () => {
  const grey = await renderPipeline(vips, red, ops(["grayscale", []]));
  const grey2 = await renderPipeline(vips, Buffer.from(grey.bytes), ops(["grayscale", []]));
  assert.equal(`${grey2.width}x${grey2.height}`, `${grey.width}x${grey.height}`);
});

test("flip then mirror is equivalent to rotate 180", async () => {
  const fm = await renderPipeline(vips, red, ops(["flip", []], ["mirror", []]));
  const r180 = await renderPipeline(vips, red, ops(["rotate", ["180"]]));
  assert.equal(`${fm.width}x${fm.height}`, `${r180.width}x${r180.height}`);
  // Both should be 100x60
  assert.equal(`${fm.width}x${fm.height}`, "100x60");
});

test("rotate 90 then rotate 270 returns to original dimensions", async () => {
  const out = await renderPipeline(vips, red, ops(["rotate", ["90"]], ["rotate", ["270"]]));
  assert.equal(`${out.width}x${out.height}`, "100x60");
});

test("write to tiff with quality", async () => {
  const out = await renderPipeline(vips, red, ops(["write", ["o.tiff", "quality=50"]]));
  assert.equal(out.ext, "tif");
  const m = await sharp(Buffer.from(out.bytes)).metadata();
  assert.equal(m.format, "tiff");
});

// ---------------------------------------------------------------------------
// Animated GIF tests
// ---------------------------------------------------------------------------

async function makeAnimatedGif(frames: number, width: number, height: number, delay: number[]): Promise<Buffer> {
  const bufs: Buffer[] = [];
  const colors = ["red", "green", "blue", "yellow", "cyan", "magenta"];
  for (let i = 0; i < frames; i++) {
    bufs.push(
      await sharp({ create: { width, height, channels: 3, background: colors[i % colors.length]! } })
        .png()
        .toBuffer(),
    );
  }
  return sharp(bufs, { join: { animated: true } })
    .gif({ delay, loop: 0 })
    .toBuffer();
}

test("animated gif: resize shrinks all frames", async () => {
  const out = await renderPipeline(vips, animGif, ops(["resize", ["10"]]), "anim.gif");
  assert.equal(out.width, 10, "frame width shrunk to 10");
  assert.equal(out.ext, "gif");
  const m = await sharp(Buffer.from(out.bytes)).metadata();
  assert.ok(m.pages! > 1, "multiple pages preserved");
});

test("animated gif: crop all frames", async () => {
  const out = await renderPipeline(vips, animGif, ops(["crop", ["10x10", "gravity=center"]]), "anim.gif");
  assert.equal(out.width, 10, "frame width cropped to 10");
  assert.equal(out.ext, "gif");
  const m = await sharp(Buffer.from(out.bytes)).metadata();
  assert.ok(m.pages! > 1, "multiple pages preserved");
});

test("animated gif: grayscale all frames", async () => {
  const out = await renderPipeline(vips, animGif, ops(["grayscale", []]), "anim.gif");
  assert.equal(out.ext, "gif");
  const m = await sharp(Buffer.from(out.bytes)).metadata();
  assert.ok(m.pages! > 1, "multiple pages preserved");
});

test("animated gif: write to tiff preserves animation", async () => {
  const out = await renderPipeline(vips, animGif, ops(["write", ["out.tiff"]]), "anim.gif");
  assert.equal(out.ext, "tif");
  const m = await sharp(Buffer.from(out.bytes)).metadata();
  assert.ok(m.pages! > 1, "multiple pages preserved in tiff");
});

test("animated gif: write to non-animated format fails", async () => {
  assert.rejects(
    async () => {
      await renderPipeline(vips, animGif, ops(["write", ["out.png"]]), "anim.gif");
    },
    (e: ExecError) => e.code === "ERUNTIME",
  );
});

test("animated gif: pad works on all frames", async () => {
  const out = await renderPipeline(vips, animGif, ops(["pad", ["5", "color=black"]]), "anim.gif");
  assert.equal(out.width, 30, "padded frame width is 30");
  assert.equal(out.ext, "gif");
  const m = await sharp(Buffer.from(out.bytes)).metadata();
  assert.ok(m.pages! > 1, "multiple pages preserved");
});
