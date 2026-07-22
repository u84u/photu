import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlan, isErrorPlan, type OkPlan, type ErrPlan } from "../src/core/plan.ts";

const MAIN = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));

function run(args: string[], input = "") {
  const res = spawnSync(process.execPath, [MAIN, ...args], { input, encoding: "utf8" });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const dir = mkdtempSync(join(tmpdir(), "photu-test-"));
writeFileSync(join(dir, "a.jpg"), "");
writeFileSync(join(dir, "b.jpg"), "");
writeFileSync(join(dir, "c.png"), "");
mkdirSync(join(dir, "sub.jpg")); // a directory that matches the glob
after(() => rmSync(dir, { recursive: true, force: true }));

test("read expands a glob into a sorted, absolute, slash-normalized plan", () => {
  const { status, stdout } = run(["read", join(dir, "*.jpg")]);
  assert.equal(status, 0);
  const plan = parsePlan(stdout) as OkPlan;
  assert.ok(!isErrorPlan(plan));
  assert.equal(plan.files.length, 2, "two files, directory match excluded");
  assert.ok(plan.files[0].endsWith("/a.jpg"));
  assert.ok(plan.files[1].endsWith("/b.jpg"));
  assert.ok(plan.files.every((f) => !f.includes("\\")));
  assert.deepEqual(plan.ops, []);
});

test("read panics on a glob that matches nothing", () => {
  const { status, stdout, stderr } = run(["read", join(dir, "*.bmp")]);
  assert.equal(status, 1);
  assert.match(stderr, /matched no files/);
  const plan = parsePlan(stdout) as ErrPlan;
  assert.ok(isErrorPlan(plan));
  assert.equal(plan.error.code, "EEMPTY");
});

test("read takes multiple sources and mixes globs with URLs", () => {
  const { status, stdout } = run([
    "read",
    join(dir, "*.jpg"),
    "https://cdn.example.com/logo.png?w=800&sig=abc",
  ]);
  assert.equal(status, 0);
  const plan = parsePlan(stdout) as OkPlan;
  assert.ok(!isErrorPlan(plan));
  assert.deepEqual(plan.files.slice(-1), ["https://cdn.example.com/logo.png?w=800&sig=abc"]);
  assert.equal(plan.files.length, 3, "two local matches plus the URL, order preserved");
});

test("read never touches the network for a syntactically bad URL", () => {
  const { status, stdout, stderr } = run(["read", "http://"]);
  assert.equal(status, 1);
  assert.match(stderr, /not a valid URL/);
  const plan = parsePlan(stdout) as ErrPlan;
  assert.equal(plan.error.code, "EBADARG");
});

test("a full pipeline accumulates normalized ops", () => {
  const read = run(["read", join(dir, "*.jpg")]);
  const resize = run(["resize", "1600"], read.stdout);
  assert.equal(resize.status, 0);
  const gray = run(["grayscale"], resize.stdout);
  assert.equal(gray.status, 0);

  const plan = parsePlan(gray.stdout) as OkPlan;
  assert.deepEqual(plan.ops, [
    { op: "resize", width: 1600, height: null, fit: "inside", upscale: false },
    { op: "grayscale" },
  ]);
});

test("garbage stdin becomes an ENOTPLAN error plan", () => {
  const { status, stdout, stderr } = run(["resize", "800"], "not json at all");
  assert.equal(status, 1);
  assert.match(stderr, /not a photu plan/);
  const plan = parsePlan(stdout) as ErrPlan;
  assert.equal(plan.error.code, "ENOTPLAN");
  assert.equal(plan.error.stage, "resize");
});

test("error plans pass through later stages silently", () => {
  const read = run(["read", join(dir, "*.jpg")]);
  const bad = run(["resize", "800x"], read.stdout);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /invalid dimension/);
  const badPlan = parsePlan(bad.stdout) as ErrPlan;
  assert.equal(badPlan.error.stage, "resize");

  const gray = run(["grayscale"], bad.stdout);
  assert.equal(gray.status, 1);
  assert.equal(gray.stderr, "", "passers do not re-print");
  assert.equal(gray.stdout, bad.stdout, "error plan passes through verbatim");
});

test("the sink exits nonzero on a received error plan without re-printing", () => {
  const read = run(["read", join(dir, "*.jpg")]);
  const bad = run(["resize", "800x"], read.stdout);
  const write = run(["write", "out/{name}.webp"], bad.stdout);
  assert.equal(write.status, 1);
  assert.equal(write.stderr, "");
  assert.equal(write.stdout, "");
});

test("explain pretty-prints a plan", () => {
  const read = run(["read", join(dir, "*.jpg")]);
  const resize = run(["resize", "800x600", "fit=cover"], read.stdout);
  const explain = run(["explain"], resize.stdout);
  assert.equal(explain.status, 0);
  assert.match(explain.stdout, /files \(2\):/);
  assert.match(explain.stdout, /1\. resize {2}width=800 height=600 fit="cover" upscale=false/);
});

test("explain of an error plan prints it and exits nonzero", () => {
  const read = run(["read", join(dir, "*.jpg")]);
  const bad = run(["blur", "9000"], read.stdout);
  const explain = run(["explain"], bad.stdout);
  assert.equal(explain.status, 1);
  assert.match(explain.stdout, /ERROR in stage 'blur' \[EBADARG\]/);
});

test("unknown command and bare invocation fail with usage pointers", () => {
  const unknown = run(["vignette"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown command 'vignette'/);
  assert.equal(unknown.stdout, "");

  const bare = run([]);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /usage: photu/);

  const help = run(["help"]);
  assert.equal(help.status, 0);
});

test("completion prints a bash script to stdout, not stderr", () => {
  const res = run(["completion"]);
  assert.equal(res.status, 0);
  assert.equal(res.stderr, "");
  assert.match(res.stdout, /complete -F _photu_completions photu/);
});
