// The playground's pipeline autocomplete is a pure function of text +
// cursor position, so it gets real test coverage - unlike the dropdown UI
// itself (playground/app.js), which has no DOM test harness in this repo
// and is verified manually in a browser instead.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS } from "../src/core/ops.ts";
import { COMMAND_META } from "../src/core/completion-meta.ts";
import { configure, getSuggestions } from "../playground/completions.js";

before(() => configure(COMMANDS, COMMAND_META));

function labels(text: string, cursorPos = text.length) {
  return getSuggestions(text, cursorPos).items.map((i) => i.label);
}

test("suggests every command at the start of a segment", () => {
  const items = labels("");
  assert.ok(items.includes("resize"));
  assert.ok(items.includes("write"));
  assert.equal(items.length, COMMANDS.length);
});

test("command suggestions filter by prefix and exclude read/info/explain/formats", () => {
  assert.deepEqual(labels("re"), ["resize"]);
  assert.deepEqual(labels("g"), ["grayscale"]);
  assert.ok(!labels("").includes("read"), "read is not a valid playground command");
});

test("suggests commands after a pipe, not just at segment 0", () => {
  assert.deepEqual(labels("resize 800 | gr"), ["grayscale"]);
});

test("suggests option keys and flags for the current command", () => {
  const items = labels("resize 800 ");
  assert.ok(items.includes("fit="));
  assert.ok(items.includes("upscale"));
});

test("already-used option keys and flags are not suggested again", () => {
  const items = labels("resize 800 upscale fit=cover ");
  assert.ok(!items.includes("upscale"));
  assert.ok(!items.includes("fit="));
});

test("suggests enum values for fit= and gravity=, filtered by partial value", () => {
  assert.deepEqual(labels("resize 800 fit=cov"), ["fit=cover"]);
  assert.deepEqual(labels("resize 800 fit=co"), ["fit=cover", "fit=contain"]);
  assert.deepEqual(labels("overlay logo.png gravity=nor"), ["gravity=north", "gravity=northeast", "gravity=northwest"]);
});

test("free-text option values (background=, color=) get no value suggestions", () => {
  assert.deepEqual(labels("rotate 90 background=wh"), []);
});

test("an unknown command in the segment suggests nothing for later tokens", () => {
  assert.deepEqual(labels("nope 800 f"), []);
});

test("editing the middle of a pipeline suggests for the token under the cursor, not the end", () => {
  const text = "resize 800 | write out.webp";
  const cursor = text.indexOf("resize") + "res".length;
  const result = getSuggestions(text, cursor);
  assert.deepEqual(result.items.map((i) => i.label), ["resize"]);
  assert.equal(result.tokenStart, 0);
  assert.equal(result.tokenEnd, "resize".length);
});

test("insertText for a key completion has no trailing space, so a value can follow immediately", () => {
  const items = getSuggestions("resize 800 fi", "resize 800 fi".length).items;
  assert.deepEqual(
    items.find((i) => i.label === "fit="),
    { label: "fit=", insertText: "fit=" },
  );
});
