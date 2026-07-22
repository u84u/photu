#!/usr/bin/env node
// The photu CLI stage driver. Every subcommand is one pipeline stage:
// it reads a plan from stdin (except `read`), transforms it, and emits
// exactly one line of plan JSON on stdout. stdout carries plans and
// nothing else, ever.
//
// Error protocol: the stage that *creates* an error prints it to stderr
// (all stages share the terminal's stderr) and emits an error plan so
// the failure propagates in-band; stages that *receive* an error plan
// pass it through verbatim and exit nonzero without re-printing.

import { glob } from "node:fs/promises";
import { resolve } from "node:path";
import {
  Panic,
  type Plan,
  errorPlan,
  isErrorPlan,
  isUrl,
  newPlan,
  parsePlan,
  serializePlan,
} from "../core/plan.ts";
import { parseArgs } from "../core/args.ts";
import { COMMANDS, normalizeOp } from "../core/ops.ts";

const stderr = (msg: string) => process.stderr.write(`photu: ${msg}\n`);
const emit = (plan: Plan) => process.stdout.write(serializePlan(plan));

/** This stage is the origin of the failure: tell the human, tell the pipe. */
function creatorFail(stage: string, code: string, message: string): void {
  stderr(message);
  emit(errorPlan(stage, code, message));
  process.exitCode = 1;
}

/** Reads all of stdin to completion. Unlike a synchronous read of fd 0, this
 * waits for data rather than racing the upstream stage: a live pipe between
 * two freshly-spawned processes has no data queued yet when the reader
 * starts, and a sync read of a non-blocking pipe fd fails in that case
 * instead of blocking. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Returns null when the failure was already handled. */
async function stdinPlan(command: string): Promise<Plan | null> {
  if (process.stdin.isTTY) {
    creatorFail(
      command,
      "ENOSTDIN",
      `${command} expects a plan on stdin - start a pipeline with: photu read "<glob>"`,
    );
    return null;
  }
  const text = await readStdin();
  try {
    return parsePlan(text);
  } catch (err) {
    if (err instanceof Panic) {
      creatorFail(command, err.code, err.message);
      return null;
    }
    throw err;
  }
}

function globPattern(command: string, tokens: string[]): string {
  const args = parseArgs(tokens);
  if (args.positionals.length !== 1 || args.options.size > 0) {
    throw new Panic("EBADARG", `${command}: usage: photu ${command} "<glob>"`);
  }
  return args.positionals[0].replaceAll("\\", "/");
}

async function expandGlob(pattern: string): Promise<string[]> {
  const files: string[] = [];
  for await (const entry of glob(pattern, { withFileTypes: true })) {
    if (entry.isFile()) {
      files.push(resolve(entry.parentPath, entry.name).replaceAll("\\", "/"));
    }
  }
  files.sort();
  return files;
}

/** URLs are passed through as-is; the actual fetch happens per-file inside
 * `write`, in the same process (and worker pool) that runs sharp - so
 * nothing here ever touches the network. Only syntax gets checked. */
function checkUrl(spec: string): void {
  try {
    new URL(spec);
  } catch {
    throw new Panic("EBADARG", `read: '${spec}' is not a valid URL`);
  }
}

async function doRead(tokens: string[]): Promise<void> {
  let specs: string[];
  try {
    const args = parseArgs(tokens);
    if (args.positionals.length === 0 || args.options.size > 0) {
      throw new Panic(
        "EBADARG",
        `read: usage: photu read "<glob-or-url>" ["<glob-or-url>" ...]`,
      );
    }
    specs = args.positionals;
    for (const spec of specs) if (isUrl(spec)) checkUrl(spec);
  } catch (err) {
    if (err instanceof Panic) return creatorFail("read", err.code, err.message);
    throw err;
  }

  const perSpec: string[][] = new Array(specs.length);
  try {
    for (let i = 0; i < specs.length; i++) {
      if (isUrl(specs[i])) {
        perSpec[i] = [specs[i]];
        continue;
      }
      const matches = await expandGlob(specs[i].replaceAll("\\", "/"));
      if (matches.length === 0) {
        throw new Panic("EEMPTY", `read: '${specs[i]}' matched no files`);
      }
      perSpec[i] = matches;
    }
  } catch (err) {
    if (err instanceof Panic) return creatorFail("read", err.code, err.message);
    throw err;
  }
  emit(newPlan(perSpec.flat()));
}

async function doInfo(tokens: string[]): Promise<void> {
  try {
    const pattern = globPattern("info", tokens);
    const files = await expandGlob(pattern);
    if (files.length === 0) {
      throw new Panic("EEMPTY", `info: '${pattern}' matched no files`);
    }
    const exec = await import("./exec.ts");
    await exec.info(files);
  } catch (err) {
    if (err instanceof Panic) {
      stderr(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

async function doTransform(command: string, tokens: string[]): Promise<void> {
  const plan = await stdinPlan(command);
  if (plan === null) return;
  if (isErrorPlan(plan)) {
    emit(plan);
    process.exitCode = 1;
    return;
  }
  try {
    plan.ops.push(normalizeOp(command, tokens));
  } catch (err) {
    if (err instanceof Panic) return creatorFail(command, err.code, err.message);
    throw err;
  }
  emit(plan);
}

async function doWrite(tokens: string[]): Promise<void> {
  const plan = await stdinPlan("write");
  if (plan === null) return;
  if (isErrorPlan(plan)) {
    process.exitCode = 1;
    return;
  }
  try {
    plan.ops.push(normalizeOp("write", tokens));
    const exec = await import("./exec.ts");
    await exec.execute(plan);
  } catch (err) {
    if (err instanceof Panic) {
      stderr(err.message);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

async function doExplain(tokens: string[]): Promise<void> {
  if (tokens.length > 0) {
    stderr(`explain takes no arguments, got '${tokens[0]}'`);
    process.exitCode = 1;
    return;
  }
  const plan = await stdinPlan("explain");
  if (plan === null) return;
  const out: string[] = [`photu plan (protocol ${plan.photu})`];
  if (isErrorPlan(plan)) {
    out.push(`ERROR in stage '${plan.error.stage}' [${plan.error.code}]: ${plan.error.message}`);
    process.exitCode = 1;
  } else {
    out.push(`files (${plan.files.length}):`);
    for (const f of plan.files) out.push(`  ${f}`);
    out.push(`ops (${plan.ops.length}):`);
    plan.ops.forEach((op, i) => {
      const args = Object.entries(op)
        .filter(([k]) => k !== "op")
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(" ");
      out.push(`  ${i + 1}. ${op.op}${args ? "  " + args : ""}`);
    });
  }
  process.stdout.write(out.join("\n") + "\n");
}

const USAGE = `usage: photu <command> [args]

  photu read "<glob-or-url>" [...]  start a pipeline from matching files and/or URLs
  ${COMMANDS.filter((c) => c !== "write").join(", ")}
                             transform stages (photu <command> to see usage)
  photu write <template>     execute the pipeline and write output files
  photu explain              pretty-print the plan arriving on stdin
  photu info "<glob>"        show format, dimensions, size of matching files
  photu formats              list readable/writable formats
  photu completion           print a bash completion script (see its output for install)

example:
  photu read "*.jpg" | photu resize 1600 | photu write "out/{name}.webp"`;

async function main(): Promise<void> {
  const [command, ...tokens] = process.argv.slice(2);
  if (!command || command === "help") {
    process.stderr.write(USAGE + "\n");
    process.exitCode = command ? 0 : 1;
    return;
  }
  if (command === "read") return doRead(tokens);
  if (command === "write") return doWrite(tokens);
  if (command === "explain") return doExplain(tokens);
  if (command === "info") return doInfo(tokens);
  if (command === "formats") {
    const exec = await import("./exec.ts");
    return exec.formats();
  }
  if (command === "completion") {
    const { generateBashCompletion } = await import("./completion.ts");
    process.stdout.write(generateBashCompletion());
    return;
  }
  if (COMMANDS.includes(command)) return doTransform(command, tokens);
  stderr(`unknown command '${command}' - run 'photu help'`);
  process.exitCode = 1;
}

await main();
