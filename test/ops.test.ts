import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOp, COMMANDS } from "../src/core/ops.ts";
import { Panic } from "../src/core/plan.ts";

const panicWith = (code: string) => (err: unknown) =>
  err instanceof Panic && err.code === code;

test("unknown command panics EUNKNOWN and lists commands", () => {
  assert.throws(() => normalizeOp("vignette", []), (err: unknown) => {
    return err instanceof Panic && err.code === "EUNKNOWN" &&
      COMMANDS.every((c) => err.message.includes(c));
  });
});

test("resize normalizes with explicit defaults", () => {
  assert.deepEqual(normalizeOp("resize", ["1600"]), {
    op: "resize",
    width: 1600,
    height: null,
    fit: "inside",
    upscale: false,
  });
  assert.deepEqual(normalizeOp("resize", ["800x600", "fit=cover", "upscale"]), {
    op: "resize",
    width: 800,
    height: 600,
    fit: "cover",
    upscale: true,
  });
});

test("resize rejects bad input", () => {
  assert.throws(() => normalizeOp("resize", []), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("resize", ["800x"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("resize", ["800", "fit=stretch"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("resize", ["800", "quality=80"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("resize", ["800", "600"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("resize", ["800x600+40+10"]), panicWith("EBADARG"));
});

test("crop: gravity mode, square shorthand, region mode", () => {
  assert.deepEqual(normalizeOp("crop", ["800x600"]), {
    op: "crop",
    mode: "gravity",
    width: 800,
    height: 600,
    gravity: "center",
  });
  assert.deepEqual(normalizeOp("crop", ["512", "gravity=northwest"]), {
    op: "crop",
    mode: "gravity",
    width: 512,
    height: 512,
    gravity: "northwest",
  });
  assert.deepEqual(normalizeOp("crop", ["800x600+40+10"]), {
    op: "crop",
    mode: "region",
    width: 800,
    height: 600,
    left: 40,
    top: 10,
  });
  assert.throws(
    () => normalizeOp("crop", ["800x600+40+10", "gravity=north"]),
    panicWith("EBADARG"),
  );
});

test("rotate takes any finite angle plus background", () => {
  assert.deepEqual(normalizeOp("rotate", ["90"]), { op: "rotate", angle: 90, background: "black" });
  assert.deepEqual(normalizeOp("rotate", ["-13.5", "background=white"]), {
    op: "rotate",
    angle: -13.5,
    background: "white",
  });
  assert.throws(() => normalizeOp("rotate", ["ninety"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("rotate", []), panicWith("EBADARG"));
});

test("no-arg commands reject stray arguments", () => {
  assert.deepEqual(normalizeOp("flip", []), { op: "flip" });
  assert.deepEqual(normalizeOp("mirror", []), { op: "mirror" });
  assert.deepEqual(normalizeOp("grayscale", []), { op: "grayscale" });
  assert.throws(() => normalizeOp("flip", ["vertical"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("grayscale", ["fast=true"]), panicWith("EBADARG"));
});

test("adjust requires at least one knob, fills the rest", () => {
  assert.deepEqual(normalizeOp("adjust", ["brightness=1.1"]), {
    op: "adjust",
    brightness: 1.1,
    saturation: 1,
    hue: 0,
  });
  assert.deepEqual(normalizeOp("adjust", ["saturation=0.8", "hue=30"]), {
    op: "adjust",
    brightness: 1,
    saturation: 0.8,
    hue: 30,
  });
  assert.throws(() => normalizeOp("adjust", []), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("adjust", ["hue=0.5"]), panicWith("EBADARG"));
});

test("blur and sharpen: optional sigma with ranges", () => {
  assert.deepEqual(normalizeOp("blur", []), { op: "blur", sigma: null });
  assert.deepEqual(normalizeOp("blur", ["2.5"]), { op: "blur", sigma: 2.5 });
  assert.deepEqual(normalizeOp("sharpen", ["1.2"]), { op: "sharpen", sigma: 1.2 });
  assert.throws(() => normalizeOp("blur", ["0.1"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("blur", ["huge"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("sharpen", ["50"]), panicWith("EBADARG"));
});

test("overlay normalizes path, gravity, opacity", () => {
  assert.deepEqual(normalizeOp("overlay", ["logo.png"]), {
    op: "overlay",
    path: "logo.png",
    gravity: "center",
    opacity: 1,
  });
  assert.deepEqual(normalizeOp("overlay", ["logo.png", "gravity=southeast", "opacity=0.5"]), {
    op: "overlay",
    path: "logo.png",
    gravity: "southeast",
    opacity: 0.5,
  });
  assert.throws(() => normalizeOp("overlay", ["logo.png", "opacity=1.5"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("overlay", []), panicWith("EBADARG"));
});

test("pad normalizes size and color", () => {
  assert.deepEqual(normalizeOp("pad", ["20"]), { op: "pad", size: 20, color: "black" });
  assert.deepEqual(normalizeOp("pad", ["20", "color=white"]), {
    op: "pad",
    size: 20,
    color: "white",
  });
  assert.throws(() => normalizeOp("pad", ["-5"]), panicWith("EBADARG"));
});

test("write infers format from the template extension", () => {
  assert.deepEqual(normalizeOp("write", ["out/{name}.webp", "quality=90"]), {
    op: "write",
    template: "out/{name}.webp",
    format: "webp",
    quality: 90,
    lossless: false,
    background: "white",
  });
  assert.equal(normalizeOp("write", ["x.jpg"]).format, "jpeg");
  assert.equal(normalizeOp("write", ["x.tif"]).format, "tiff");
  assert.equal(normalizeOp("write", ["out/{name}.{ext}"]).format, "source");
  assert.equal(normalizeOp("write", ["out.PNG"]).quality, null);
});

test("write rejects format/option mismatches", () => {
  assert.throws(() => normalizeOp("write", ["out/{name}"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("write", ["x.bmp"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("write", ["x.png", "quality=80"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("write", ["x.jpg", "lossless"]), panicWith("EBADARG"));
  assert.deepEqual(normalizeOp("write", ["x.webp", "lossless"]).lossless, true);
});
