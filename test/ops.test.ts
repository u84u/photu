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

test("resize normalizes height-only (x600)", () => {
  assert.deepEqual(normalizeOp("resize", ["x600"]), {
    op: "resize",
    width: null,
    height: 600,
    fit: "inside",
    upscale: false,
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
  assert.deepEqual(normalizeOp("crop", ["200x200", "gravity=northeast"]), {
    op: "crop",
    mode: "gravity",
    width: 200,
    height: 200,
    gravity: "northeast",
  });
  assert.throws(
    () => normalizeOp("crop", ["800x600+40+10", "gravity=north"]),
    panicWith("EBADARG"),
  );
  assert.throws(
    () => normalizeOp("crop", ["800x600", "fit=cover"]),
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
  assert.deepEqual(normalizeOp("rotate", ["0"]), { op: "rotate", angle: 0, background: "black" });
  assert.deepEqual(normalizeOp("rotate", ["360"]), { op: "rotate", angle: 360, background: "black" });
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
  assert.deepEqual(normalizeOp("adjust", ["brightness=0", "saturation=0", "hue=-360"]), {
    op: "adjust",
    brightness: 0,
    saturation: 0,
    hue: -360,
  });
  assert.deepEqual(normalizeOp("adjust", ["brightness=100", "saturation=100", "hue=360"]), {
    op: "adjust",
    brightness: 100,
    saturation: 100,
    hue: 360,
  });
  assert.throws(() => normalizeOp("adjust", []), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("adjust", ["hue=0.5"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("adjust", ["brightness=200"]), panicWith("EBADARG"));
});

test("blur and sharpen: optional sigma with ranges", () => {
  assert.deepEqual(normalizeOp("blur", []), { op: "blur", sigma: null });
  assert.deepEqual(normalizeOp("blur", ["2.5"]), { op: "blur", sigma: 2.5 });
  assert.deepEqual(normalizeOp("sharpen", []), { op: "sharpen", sigma: null });
  assert.deepEqual(normalizeOp("sharpen", ["1.2"]), { op: "sharpen", sigma: 1.2 });
  assert.deepEqual(normalizeOp("blur", ["0.3"]), { op: "blur", sigma: 0.3 });
  assert.deepEqual(normalizeOp("blur", ["1000"]), { op: "blur", sigma: 1000 });
  assert.deepEqual(normalizeOp("sharpen", ["0.01"]), { op: "sharpen", sigma: 0.01 });
  assert.deepEqual(normalizeOp("sharpen", ["10"]), { op: "sharpen", sigma: 10 });
  assert.throws(() => normalizeOp("blur", ["0.1"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("blur", ["1001"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("blur", ["huge"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("sharpen", ["-1"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("sharpen", ["50"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("sharpen", ["abc"]), panicWith("EBADARG"));
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
  assert.equal(normalizeOp("write", ["x.jpg"])["format"], "jpeg");
  assert.equal(normalizeOp("write", ["x.tif"])["format"], "tiff");
  assert.equal(normalizeOp("write", ["out/{name}.{ext}"])["format"], "source");
  assert.equal(normalizeOp("write", ["out.PNG"])["quality"], null);
});

test("write rejects format/option mismatches", () => {
  assert.throws(() => normalizeOp("write", ["out/{name}"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("write", ["x.bmp"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("write", ["x.png", "quality=80"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("write", ["x.jpg", "lossless"]), panicWith("EBADARG"));
  assert.deepEqual(normalizeOp("write", ["x.webp", "lossless"])["lossless"], true);
});

test("write normalizes background and lossless with defaults", () => {
  const op = normalizeOp("write", ["out/{name}.jpg"]) as Record<string, unknown>;
  assert.equal(op["background"], "white");
  assert.equal(op["lossless"], false);
  assert.equal(op["quality"], 80, "jpeg default quality is 80");

  const webp = normalizeOp("write", ["out/{name}.webp"]) as Record<string, unknown>;
  assert.equal(webp["quality"], 80, "webp default quality is 80");
  assert.equal(webp["lossless"], false);

  const losslessWebp = normalizeOp("write", ["out/{name}.webp", "lossless"]) as Record<string, unknown>;
  assert.equal(losslessWebp["lossless"], true);
});

test("write loses quality for png and gif", () => {
  assert.equal(normalizeOp("write", ["x.png"])["quality"], null);
  assert.equal(normalizeOp("write", ["x.gif"])["quality"], null);
  assert.equal(normalizeOp("write", ["x.avif", "quality=60"])["quality"], 60);
  assert.equal(normalizeOp("write", ["x.tiff", "quality=50"])["quality"], 50);
});

test("write rejects lossless for jpeg, png, gif, tiff", () => {
  assert.throws(() => normalizeOp("write", ["x.jpg", "lossless"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("write", ["x.png", "lossless"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("write", ["x.gif", "lossless"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("write", ["x.tiff", "lossless"]), panicWith("EBADARG"));
  // webp and avif accept lossless
  assert.equal(normalizeOp("write", ["x.webp", "lossless"])["lossless"], true);
  assert.equal(normalizeOp("write", ["x.avif", "lossless"])["lossless"], true);
});

test("trim normalizes with threshold default and custom", () => {
  assert.deepEqual(normalizeOp("trim", []), { op: "trim", threshold: 10 });
  assert.deepEqual(normalizeOp("trim", ["threshold=30"]), { op: "trim", threshold: 30 });
  assert.throws(() => normalizeOp("trim", ["threshold=256"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("trim", ["threshold=-1"]), panicWith("EBADARG"));
});

test("normalize and negate take no arguments", () => {
  assert.deepEqual(normalizeOp("normalize", []), { op: "normalize" });
  assert.deepEqual(normalizeOp("negate", []), { op: "negate" });
  assert.throws(() => normalizeOp("normalize", ["800"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("negate", ["fast=true"]), panicWith("EBADARG"));
});

test("sepia normalizes strength", () => {
  assert.deepEqual(normalizeOp("sepia", []), { op: "sepia", strength: 0.8 });
  assert.deepEqual(normalizeOp("sepia", ["strength=0.5"]), { op: "sepia", strength: 0.5 });
  assert.deepEqual(normalizeOp("sepia", ["strength=0"]), { op: "sepia", strength: 0 });
  assert.deepEqual(normalizeOp("sepia", ["strength=1"]), { op: "sepia", strength: 1 });
  assert.throws(() => normalizeOp("sepia", ["strength=1.5"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("sepia", ["strength=-0.1"]), panicWith("EBADARG"));
});

test("level normalizes black, white, gamma and enforces black < white", () => {
  assert.deepEqual(normalizeOp("level", []), {
    op: "level",
    black: 0,
    white: 255,
    gamma: 1,
  });
  assert.deepEqual(normalizeOp("level", ["black=16", "white=240", "gamma=2.2"]), {
    op: "level",
    black: 16,
    white: 240,
    gamma: 2.2,
  });
  assert.throws(() => normalizeOp("level", ["black=200", "white=100"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("level", ["gamma=0.05"]), panicWith("EBADARG"));
});

test("median takes an optional odd size between 3 and 15", () => {
  assert.deepEqual(normalizeOp("median", []), { op: "median", size: null });
  assert.deepEqual(normalizeOp("median", ["3"]), { op: "median", size: 3 });
  assert.deepEqual(normalizeOp("median", ["15"]), { op: "median", size: 15 });
  assert.throws(() => normalizeOp("median", ["2"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("median", ["16"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("median", ["4"]), panicWith("EBADARG"));
  assert.throws(() => normalizeOp("median", ["abc"]), panicWith("EBADARG"));
});

test("completion-meta.ts has an entry for every command and vice versa", async () => {
  const { COMMAND_META } = await import("../src/core/completion-meta.ts");
  for (const cmd of COMMANDS) {
    assert.ok(cmd in COMMAND_META, `completion-meta missing entry for '${cmd}'`);
  }
  for (const cmd of Object.keys(COMMAND_META)) {
    assert.ok(COMMANDS.includes(cmd), `completion-meta has unknown command '${cmd}'`);
  }
});
