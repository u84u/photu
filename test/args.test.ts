import { test } from "node:test";
import assert from "node:assert/strict";
import { coerce, parseArgs, parseDimension } from "../src/core/args.ts";
import { Panic } from "../src/core/plan.ts";

const panicWith = (code: string) => (err: unknown) =>
  err instanceof Panic && err.code === code;

test("coerce maps raw strings to typed values", () => {
  assert.equal(coerce("80"), 80);
  assert.equal(coerce("-90"), -90);
  assert.equal(coerce("0.5"), 0.5);
  assert.equal(coerce("true"), true);
  assert.equal(coerce("false"), false);
  assert.equal(coerce("white"), "white");
  assert.equal(coerce("out/{name}.webp"), "out/{name}.webp");
  assert.equal(coerce("007"), 7);
  assert.equal(coerce("0x10"), "0x10");
  assert.equal(coerce(".5"), ".5");
});

test("parseArgs splits positionals and options", () => {
  const args = parseArgs(["800x600", "fit=cover", "quality=80", "upscale", "lossless"]);
  assert.deepEqual(args.positionals, ["800x600", "upscale", "lossless"]);
  assert.equal(args.options.get("fit"), "cover");
  assert.equal(args.options.get("quality"), 80);
});

test("option values may contain '='", () => {
  const args = parseArgs(["name=a=b"]);
  assert.equal(args.options.get("name"), "a=b");
});

test("a URL token is always one positional, even with '=' in the query string", () => {
  const args = parseArgs(["https://cdn.example.com/a.jpg?w=800&sig=abc", "gravity=center"]);
  assert.deepEqual(args.positionals, ["https://cdn.example.com/a.jpg?w=800&sig=abc"]);
  assert.equal(args.options.get("gravity"), "center");
});

test("parseArgs rejects bad options", () => {
  assert.throws(() => parseArgs(["fit=cover", "fit=fill"]), panicWith("EBADARG"));
  assert.throws(() => parseArgs(["quality="]), panicWith("EBADARG"));
  assert.throws(() => parseArgs(["9lives=x"]), panicWith("EBADARG"));
  assert.throws(() => parseArgs(["=cover"]), panicWith("EBADARG"));
});

test("parseDimension handles the four valid shapes", () => {
  assert.deepEqual(parseDimension("1600"), { width: 1600, height: null, left: null, top: null });
  assert.deepEqual(parseDimension("800x600"), { width: 800, height: 600, left: null, top: null });
  assert.deepEqual(parseDimension("x600"), { width: null, height: 600, left: null, top: null });
  assert.deepEqual(parseDimension("800x600+40+10", { region: true }), {
    width: 800,
    height: 600,
    left: 40,
    top: 10,
  });
  assert.deepEqual(parseDimension("800x600+0+0", { region: true }), {
    width: 800,
    height: 600,
    left: 0,
    top: 0,
  });
});

test("parseDimension rejects malformed specs", () => {
  const bad = ["800x", "", "x", "0", "-5", "axb", "800x-600", "1.5", "800x600x400"];
  for (const spec of bad) {
    assert.throws(() => parseDimension(spec, { region: true }), panicWith("EBADARG"), spec);
  }
});

test("parseDimension rejects misplaced or malformed offsets", () => {
  assert.throws(() => parseDimension("800x600+40+10"), panicWith("EBADARG"));
  assert.throws(() => parseDimension("800+40+10", { region: true }), panicWith("EBADARG"));
  assert.throws(() => parseDimension("800x600+40", { region: true }), panicWith("EBADARG"));
  assert.throws(() => parseDimension("800x600+40+10+5", { region: true }), panicWith("EBADARG"));
  assert.throws(() => parseDimension("800x600+-1+0", { region: true }), panicWith("EBADARG"));
});
