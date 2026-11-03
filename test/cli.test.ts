import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePlan, isErrorPlan, type OkPlan, type ErrPlan } from "../src/core/plan.ts";

const MAIN = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));

// ---------------------------------------------------------------------------
// Process-reuse helpers: each keeps ONE Node process alive across multiple
// pipeline stages instead of spawning a fresh process per stage.  This cuts
// the ~150 ms V8/module-load overhead per invocation.
// ---------------------------------------------------------------------------

/** Run a single photu stage in a long-lived child process. */
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

/**
 * Run a full pipeline (read → stage1 → stage2 → … → write/explain) in a
 * single long-lived process per stage, reusing the plan output between stages.
 */
async function pipeline(
  globPattern: string,
  ...stages: string[][]
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  let res = await run(["read", globPattern]);
  for (const stage of stages) {
    if (res.status !== 0) return res;
    res = await run(stage, res.stdout);
  }
  return res;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const dir = mkdtempSync(join(tmpdir(), "photu-test-"));
writeFileSync(join(dir, "a.jpg"), "");
writeFileSync(join(dir, "b.jpg"), "");
writeFileSync(join(dir, "c.png"), "");
mkdirSync(join(dir, "sub.jpg")); // a directory that matches the glob
after(() => rmSync(dir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("read expands a glob into a sorted, absolute, slash-normalized plan", async () => {
  const { status, stdout } = await run(["read", join(dir, "*.jpg")]);
  assert.equal(status, 0);
  const plan = parsePlan(stdout) as OkPlan;
  assert.ok(!isErrorPlan(plan));
  assert.equal(plan.files.length, 2, "two files, directory match excluded");
  assert.ok(plan.files[0]!.endsWith("/a.jpg"));
  assert.ok(plan.files[1]!.endsWith("/b.jpg"));
  assert.ok(plan.files.every((f) => !f.includes("\\")));
  assert.deepEqual(plan.ops, []);
});

test("read panics on a glob that matches nothing", async () => {
  const { status, stdout, stderr } = await run(["read", join(dir, "*.bmp")]);
  assert.equal(status, 1);
  assert.match(stderr, /matched no files/);
  const plan = parsePlan(stdout) as ErrPlan;
  assert.ok(isErrorPlan(plan));
  assert.equal(plan.error.code, "EEMPTY");
});

test("read takes multiple sources and mixes globs with URLs", async () => {
  const { status, stdout } = await run([
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

test("read never touches the network for a syntactically bad URL", async () => {
  const { status, stdout, stderr } = await run(["read", "http://"]);
  assert.equal(status, 1);
  assert.match(stderr, /not a valid URL/);
  const plan = parsePlan(stdout) as ErrPlan;
  assert.equal(plan.error.code, "EBADARG");
});

test("a full pipeline accumulates normalized ops", async () => {
  const plan = parsePlan(
    (await pipeline(join(dir, "*.jpg"), ["resize", "1600"], ["grayscale"])).stdout,
  ) as OkPlan;
  assert.deepEqual(plan.ops, [
    { op: "resize", width: 1600, height: null, fit: "inside", upscale: false },
    { op: "grayscale" },
  ]);
});

test("a live OS pipe between freshly spawned stages is not raced", async () => {
  // Regression: readFileSync(0) could throw EAGAIN before the upstream
  // stage had written anything.  Run several times — the bug was a
  // startup race, not deterministic.
  for (let i = 0; i < 8; i++) {
    const { status, stdout } = await new Promise<{
      status: number | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const procs = [
        ["read", join(dir, "*.jpg")],
        ["resize", "1600"],
        ["grayscale"],
      ].map((args) => spawn(process.execPath, [MAIN, ...args]));
      for (let j = 0; j < procs.length - 1; j++) procs[j]!.stdout!.pipe(procs[j + 1]!.stdin!);
      const last = procs[procs.length - 1]!;
      let stdout = "";
      let stderr = "";
      last!.stdout!.on("data", (d: Buffer) => (stdout += d));
      for (const p of procs) p.stderr!.on("data", (d: Buffer) => (stderr += d));
      for (const p of procs) p.on("error", reject);
      last!.on("close", (code) => resolve({ status: code, stdout, stderr }));
    });
    assert.equal(status, 0);
    const plan = parsePlan(stdout) as OkPlan;
    assert.ok(!isErrorPlan(plan));
    assert.deepEqual(plan.ops, [
      { op: "resize", width: 1600, height: null, fit: "inside", upscale: false },
      { op: "grayscale" },
    ]);
  }
});

test("garbage stdin becomes an ENOTPLAN error plan", async () => {
  const { status, stdout, stderr } = await run(["resize", "800"], "not json at all");
  assert.equal(status, 1);
  assert.match(stderr, /not a photu plan/);
  const plan = parsePlan(stdout) as ErrPlan;
  assert.equal(plan.error.code, "ENOTPLAN");
  assert.equal(plan.error.stage, "resize");
});

test("error plans pass through later stages silently", async () => {
  const read = await run(["read", join(dir, "*.jpg")]);
  const bad = await run(["resize", "800x"], read.stdout);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /invalid dimension/);
  const badPlan = parsePlan(bad.stdout) as ErrPlan;
  assert.equal(badPlan.error.stage, "resize");

  const gray = await run(["grayscale"], bad.stdout);
  assert.equal(gray.status, 1);
  assert.equal(gray.stderr, "", "passers do not re-print");
  assert.equal(gray.stdout, bad.stdout, "error plan passes through verbatim");
});

test("the sink exits nonzero on a received error plan without re-printing", async () => {
  const read = await run(["read", join(dir, "*.jpg")]);
  const bad = await run(["resize", "800x"], read.stdout);
  const write = await run(["write", "out/{name}.webp"], bad.stdout);
  assert.equal(write.status, 1);
  assert.equal(write.stderr, "");
  assert.equal(write.stdout, "");
});

test("explain pretty-prints a plan", async () => {
  const { status, stdout } = await pipeline(
    join(dir, "*.jpg"),
    ["resize", "800x600", "fit=cover"],
    ["explain"],
  );
  assert.equal(status, 0);
  assert.match(stdout, /files \(2\):/);
  assert.match(stdout, /1\. resize {2}width=800 height=600 fit="cover" upscale=false/);
});

test("explain of an error plan prints it and exits nonzero", async () => {
  // blur 9000 fails at parse time — explain must still receive the error
  // plan on stdin, so don't use pipeline()'s early-exit-on-error.
  const read = await run(["read", join(dir, "*.jpg")]);
  const bad = await run(["blur", "9000"], read.stdout);
  const explain = await run(["explain"], bad.stdout);
  assert.equal(explain.status, 1);
  assert.match(explain.stdout, /ERROR in stage 'blur' \[EBADARG\]/);
});

test("unknown command and bare invocation fail with usage pointers", async () => {
  const unknown = await run(["vignette"]);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown command 'vignette'/);
  assert.equal(unknown.stdout, "");

  const bare = await run([]);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /usage: photu/);

  const help = await run(["help"]);
  assert.equal(help.status, 0);
});

test("completion prints a bash script to stdout, not stderr", async () => {
  const res = await run(["completion"]);
  assert.equal(res.status, 0);
  assert.equal(res.stderr, "");
  assert.match(res.stdout, /complete -F _photu_completions photu/);
});

test("read with multiple glob patterns merges results in order", async () => {
  const { status, stdout } = await run(["read", join(dir, "*.jpg"), join(dir, "*.png")]);
  assert.equal(status, 0);
  const plan = parsePlan(stdout) as OkPlan;
  assert.ok(!isErrorPlan(plan));
  assert.equal(plan.files.length, 3, "two jpgs plus one png");
  assert.ok(plan.files[0]!.endsWith("/a.jpg"));
  assert.ok(plan.files[1]!.endsWith("/b.jpg"));
  assert.ok(plan.files[2]!.endsWith("/c.png"));
});

test("a long pipeline accumulates many ops in order", async () => {
  const { stdout } = await pipeline(
    join(dir, "*.jpg"),
    ["resize", "800"],
    ["crop", "400x300"],
    ["rotate", "90"],
    ["flip"],
    ["mirror"],
    ["grayscale"],
    ["blur", "2.5"],
    ["sharpen", "1"],
    ["pad", "10"],
  );
  const plan = parsePlan(stdout) as OkPlan;
  assert.equal(plan.ops.length, 9);
  assert.equal(plan.ops[0]!.op, "resize");
  assert.equal(plan.ops[8]!.op, "pad");
});

test("info on corrupt files exits nonzero with the file named", async () => {
  const infoDir = mkdtempSync(join(tmpdir(), "photu-info-"));
  writeFileSync(join(infoDir, "empty.jpg"), "");
  const res = await run(["info", join(infoDir, "*.jpg")]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /empty\.jpg/);
  rmSync(infoDir, { recursive: true, force: true });
});

test("explain with no args on a plan with multiple ops shows them all", async () => {
  const { status, stdout } = await pipeline(
    join(dir, "*.jpg"),
    ["resize", "800"],
    ["crop", "400x300", "gravity=north"],
    ["explain"],
  );
  assert.equal(status, 0);
  assert.match(stdout, /ops \(2\):/);
  assert.match(stdout, /1\. resize/);
  assert.match(stdout, /2\. crop/);
  assert.match(stdout, /gravity="north"/);
});
