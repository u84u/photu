// The bash completion script (src/cli/completion.ts) is generated text, so
// the real assertion is behavioral: source it in a real bash and drive
// _photu_completions the same way bash's own readline would, by setting
// COMP_WORDS/COMP_CWORD and reading COMPREPLY back out. Skipped where bash
// isn't available (e.g. some Windows CI runners) - this is a bash-specific
// feature, not a photu-portability one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateBashCompletion } from "../src/cli/completion.ts";

const bashAvailable = spawnSync("bash", ["-c", "true"]).status === 0;

/** Runs _photu_completions with COMP_WORDS built from `words` (the full,
 * space-split invocation, last word is the one being completed) and
 * returns COMPREPLY, space-split. */
function complete(...words: string[]): string[] {
  const script = generateBashCompletion();
  const compWords = words.map((w) => `'${w.replaceAll("'", `'\\''`)}'`).join(" ");
  const bash = `
    ${script}
    COMP_WORDS=(${compWords})
    COMP_CWORD=$((${'$'}{#COMP_WORDS[@]} - 1))
    _photu_completions
    printf '%s\\n' "${'$'}{COMPREPLY[@]}"
  `;
  const res = spawnSync("bash", ["-c", bash], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  return res.stdout.split("\n").filter(Boolean);
}

test("the generated script is syntactically valid bash", { skip: !bashAvailable }, () => {
  const res = spawnSync("bash", ["-n"], { input: generateBashCompletion(), encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
});

test("completes command names at word 1, filtered by prefix", { skip: !bashAvailable }, () => {
  assert.deepEqual(complete("photu", "re").sort(), ["read", "resize"]);
});

test("completes option keys and flags for a known command", { skip: !bashAvailable }, () => {
  assert.deepEqual(complete("photu", "resize", "800", "").sort(), ["fit=", "upscale"]);
});

test("completes enum values after key=, keeping the key= prefix", { skip: !bashAvailable }, () => {
  assert.deepEqual(complete("photu", "resize", "800", "fit=cov"), ["fit=cover"]);
  assert.deepEqual(
    complete("photu", "overlay", "logo.png", "gravity=nor").sort(),
    ["gravity=north", "gravity=northeast", "gravity=northwest"],
  );
});

test("read/info fall back to filename completion", { skip: !bashAvailable }, () => {
  // node --test runs from the repo root, where README.md lives.
  assert.deepEqual(complete("photu", "read", "READM"), ["README.md"]);
});

test("commands and options with no completions return nothing, not an error", { skip: !bashAvailable }, () => {
  assert.deepEqual(complete("photu", "explain", ""), []);
  assert.deepEqual(complete("photu", "nope", ""), []);
});
