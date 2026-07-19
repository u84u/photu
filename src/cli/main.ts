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

import { readFileSync } from "node:fs";
import { glob } from "node:fs/promises";
import { resolve } from "node:path";
import {
  Panic,
  type Plan,
  errorPlan,
  isErrorPlan,
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

/** Returns null when the failure was already handled. */
function stdinPlan(command: string): Plan | null {
  if (process.stdin.isTTY) {
    creatorFail(
      command,
      "ENOSTDIN",
      `${command} expects a plan on stdin - start a pipeline with: photu read "<glob>"`,
    );
    return null;
  }
  let text: string;
  try {
    text = readFileSync(0, "utf8");
  } catch {
    text = "";
  }
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

async function doRead(tokens: string[]): Promise<void> {
  let pattern: string;
  try {
    pattern = globPattern("read", tokens);
  } catch (err) {
    if (err instanceof Panic) return creatorFail("read", err.code, err.message);
    throw err;
  }
  const files = await expandGlob(pattern);
  if (files.length === 0) {
    return creatorFail("read", "EEMPTY", `read: '${pattern}' matched no files`);
  }
  emit(newPlan(files));
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

function doTransform(command: string, tokens: string[]): void {
  const plan = stdinPlan(command);
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
  const plan = stdinPlan("write");
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

function doExplain(tokens: string[]): void {
  if (tokens.length > 0) {
    stderr(`explain takes no arguments, got '${tokens[0]}'`);
    process.exitCode = 1;
    return;
  }
  const plan = stdinPlan("explain");
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

  photu read "<glob>"        start a pipeline from matching files
  ${COMMANDS.filter((c) => c !== "write").join(", ")}
                             transform stages (photu <command> to see usage)
  photu write <template>     execute the pipeline and write output files
  photu explain              pretty-print the plan arriving on stdin
  photu info "<glob>"        show format, dimensions, size of matching files
  photu formats              list readable/writable formats

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
  if (COMMANDS.includes(command)) return doTransform(command, tokens);
  stderr(`unknown command '${command}' - run 'photu help'`);
  process.exitCode = 1;
}

await main();
