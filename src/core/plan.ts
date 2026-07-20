// The photu wire format: one compact line of ASCII-safe JSON per pipe.
// This module is pure — no Node APIs, no sharp — so it runs unchanged in
// the CLI and the browser playground.

export const PROTOCOL = 1;

export type Op = { op: string; [key: string]: unknown };

export type PlanError = { stage: string; code: string; message: string };

export type OkPlan = { photu: number; files: string[]; ops: Op[] };
export type ErrPlan = { photu: number; error: PlanError };
export type Plan = OkPlan | ErrPlan;

/** A plan's `files` entries are either local paths or, since photu also
 * reads over the network, http(s) URLs. This is the one place that says
 * which. */
export function isUrl(file: string): boolean {
  return /^https?:\/\//i.test(file);
}

/** A fatal photu error. `code` is stable and machine-readable. */
export class Panic extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "Panic";
    this.code = code;
  }
}

export function newPlan(files: string[]): OkPlan {
  return { photu: PROTOCOL, files, ops: [] };
}

export function errorPlan(stage: string, code: string, message: string): ErrPlan {
  return { photu: PROTOCOL, error: { stage, code, message } };
}

export function isErrorPlan(plan: Plan): plan is ErrPlan {
  return "error" in plan;
}

/** Compact single line + newline. Non-ASCII code units are backslash-u
 * escaped so the plan survives shells that re-encode pipe text
 * (PowerShell < 7.4). Escaping per UTF-16 code unit keeps surrogate
 * pairs valid JSON. */
export function serializePlan(plan: Plan): string {
  const s = JSON.stringify(plan);
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    out += code < 128 ? s[i] : "\\u" + code.toString(16).padStart(4, "0");
  }
  return out + "\n";
}

const NOT_A_PLAN = "stdin is not a photu plan - did you pipe an image into me?";

export function parsePlan(text: string): Plan {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Panic("ENOTPLAN", NOT_A_PLAN);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Panic("ENOTPLAN", NOT_A_PLAN);
  }
  const obj = value as Record<string, unknown>;
  if (!("photu" in obj) || !Number.isInteger(obj.photu)) {
    throw new Panic("ENOTPLAN", NOT_A_PLAN);
  }
  if (obj.photu !== PROTOCOL) {
    throw new Panic(
      "EVERSION",
      `plan is protocol v${obj.photu} but this photu speaks v${PROTOCOL} - ` +
        "is another photu version in this pipeline?",
    );
  }

  if ("error" in obj) {
    const err = obj.error as Record<string, unknown> | null;
    if (
      typeof err !== "object" || err === null ||
      typeof err.stage !== "string" ||
      typeof err.code !== "string" ||
      typeof err.message !== "string"
    ) {
      throw new Panic("EMALFORMED", "plan has a malformed error object");
    }
    return { photu: PROTOCOL, error: err as unknown as PlanError };
  }

  const { files, ops } = obj;
  if (!Array.isArray(files) || files.some((f) => typeof f !== "string")) {
    throw new Panic("EMALFORMED", "plan.files must be an array of strings");
  }
  if (
    !Array.isArray(ops) ||
    ops.some(
      (o) =>
        typeof o !== "object" || o === null || Array.isArray(o) ||
        typeof (o as Record<string, unknown>).op !== "string",
    )
  ) {
    throw new Panic("EMALFORMED", 'plan.ops must be an array of objects each with an "op" string');
  }
  return { photu: PROTOCOL, files: files as string[], ops: ops as Op[] };
}
