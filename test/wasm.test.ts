// Verifies the playground's wasm-vips executor using the same normalized
// ops the CLI produces. Results are decoded with sharp to check them.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import Vips from "wasm-vips";
import { normalizeOp } from "../src/core/ops.ts";
import { renderPipeline, parseColor, ExecError } from "../playground/exec-wasm.js";

sharp.cache(false);

let vips: Awaited<ReturnType<typeof Vips>>;
let red: Buffer;
let semi: Buffer;

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
});
after(() => vips.shutdown());

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
  let out = renderPipeline(vips, red, ops(["resize", ["50"]]));
  assert.equal(`${out.width}x${out.height}`, "50x30");

  out = renderPipeline(vips, red, ops(["resize", ["400"]]));
  assert.equal(out.width, 100, "no upscale");

  out = renderPipeline(vips, red, ops(["resize", ["400", "upscale"]]));
  assert.equal(out.width, 400);
});

test("resize cover fills both dimensions", () => {
  const out = renderPipeline(vips, red, ops(["resize", ["40x40", "fit=cover", "upscale"]]));
  assert.equal(`${out.width}x${out.height}`, "40x40");
});

test("crop cuts without scaling and enforces bounds", () => {
  const out = renderPipeline(vips, red, ops(["crop", ["20x30"]]));
  assert.equal(`${out.width}x${out.height}`, "20x30");

  const region = renderPipeline(vips, red, ops(["crop", ["30x30+70+30"]]));
  assert.equal(`${region.width}x${region.height}`, "30x30");

  assert.throws(
    () => renderPipeline(vips, red, ops(["crop", ["30x30+80+40"]])),
    (e: ExecError) => e.code === "ERUNTIME" && /exceeds image 100x60/.test(e.message),
  );
});

test("rotate 90 swaps dimensions; arbitrary angles run", () => {
  const out = renderPipeline(vips, red, ops(["rotate", ["90"]]));
  assert.equal(`${out.width}x${out.height}`, "60x100");

  const skew = renderPipeline(vips, red, ops(["rotate", ["45", "background=white"]]));
  assert.ok(skew.width > 100, "bounding box grows");
});

test("flip, mirror, grayscale, adjust, blur, sharpen all execute", () => {
  const out = renderPipeline(
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

test("pad extends dimensions with a color", () => {
  const out = renderPipeline(vips, red, ops(["pad", ["10", "color=#00ff00"]]));
  assert.equal(`${out.width}x${out.height}`, "120x80");
});

test("write controls format; jpeg flattens alpha", async () => {
  const webp = renderPipeline(vips, red, ops(["resize", ["50"]], ["write", ["o.webp", "quality=70"]]));
  assert.equal(webp.ext, "webp");
  assert.equal((await sharp(Buffer.from(webp.bytes)).metadata()).format, "webp");

  const jpg = renderPipeline(vips, semi, ops(["write", ["o.jpg"]]));
  const m = await sharp(Buffer.from(jpg.bytes)).metadata();
  assert.equal(m.format, "jpeg");
  assert.equal(m.channels, 3, "alpha flattened");

  const avif = renderPipeline(vips, red, ops(["write", ["o.avif", "quality=50"]]));
  assert.equal((await sharp(Buffer.from(avif.bytes)).metadata()).format, "heif");
});

test("write {ext} keeps the source format via the file name", async () => {
  const out = renderPipeline(vips, red, ops(["write", ["out/{name}.{ext}"]]), "photo.png");
  assert.equal(out.ext, "png");
  assert.equal((await sharp(Buffer.from(out.bytes)).metadata()).format, "png");
});

test("no write op defaults to png preview", async () => {
  const out = renderPipeline(vips, red, ops(["resize", ["30"]]));
  assert.equal(out.ext, "png");
  assert.equal((await sharp(Buffer.from(out.bytes)).metadata()).format, "png");
});

test("overlay reports itself unsupported", () => {
  assert.throws(
    () => renderPipeline(vips, red, ops(["overlay", ["logo.png"]])),
    (e: ExecError) => e.code === "EUNSUPPORTED",
  );
});
