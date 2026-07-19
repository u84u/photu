// Command-line token parsing for photu stages: positionals + key=value
// options + bare boolean flags. No --dashes. Pure module, no Node APIs.

import { Panic } from "./plan.ts";

export type ArgValue = string | number | boolean;

export type ParsedArgs = {
  /** Bare tokens, in order. The op spec decides how many it accepts. */
  positionals: string[];
  /** key=value tokens, values coerced. */
  options: Map<string, ArgValue>;
};

const KEY_RE = /^[a-z][a-z0-9-]*$/;
const INT_RE = /^-?\d+$/;
const FLOAT_RE = /^-?\d+\.\d+$/;

/** "80" -> 80, "0.5" -> 0.5, "true"/"false" -> boolean, anything else stays a string. */
export function coerce(raw: string): ArgValue {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (INT_RE.test(raw)) return Number(raw);
  if (FLOAT_RE.test(raw)) return Number(raw);
  return raw;
}

export function parseArgs(tokens: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options = new Map<string, ArgValue>();

  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq === -1) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(0, eq);
    const raw = token.slice(eq + 1);
    if (!KEY_RE.test(key)) {
      throw new Panic("EBADARG", `invalid option name in '${token}'`);
    }
    if (raw === "") {
      throw new Panic("EBADARG", `option '${key}' has an empty value`);
    }
    if (options.has(key)) {
      throw new Panic("EBADARG", `duplicate option '${key}'`);
    }
    options.set(key, coerce(raw));
  }

  return { positionals, options };
}

export type Dimension = {
  width: number | null;
  height: number | null;
  left: number | null;
  top: number | null;
};

const DIM_HINT =
  "expected WIDTH, WIDTHxHEIGHT, xHEIGHT, or WIDTHxHEIGHT+LEFT+TOP";

function positiveInt(raw: string, what: string, spec: string): number {
  if (!INT_RE.test(raw) || Number(raw) <= 0) {
    throw new Panic("EBADARG", `invalid ${what} in '${spec}' - ${DIM_HINT}`);
  }
  return Number(raw);
}

function offsetInt(raw: string, what: string, spec: string): number {
  if (!INT_RE.test(raw) || Number(raw) < 0) {
    throw new Panic("EBADARG", `invalid ${what} in '${spec}' - offsets must be >= 0`);
  }
  return Number(raw);
}

/**
 * "1600"            -> fit by width
 * "800x600"         -> both axes
 * "x600"            -> fit by height
 * "800x600+40+10"   -> exact region (offsets require both axes)
 * "800x"            -> panic: trailing x is always a typo
 */
export function parseDimension(spec: string, opts?: { region?: boolean }): Dimension {
  let sizePart = spec;
  let left: number | null = null;
  let top: number | null = null;

  const plus = spec.indexOf("+");
  if (plus !== -1) {
    if (!opts?.region) {
      throw new Panic("EBADARG", `offsets are not allowed here: '${spec}'`);
    }
    sizePart = spec.slice(0, plus);
    const offsets = spec.slice(plus + 1).split("+");
    if (offsets.length !== 2) {
      throw new Panic("EBADARG", `invalid region '${spec}' - ${DIM_HINT}`);
    }
    left = offsetInt(offsets[0], "left offset", spec);
    top = offsetInt(offsets[1], "top offset", spec);
  }

  let width: number | null = null;
  let height: number | null = null;

  const x = sizePart.indexOf("x");
  if (x === -1) {
    if (sizePart === "") {
      throw new Panic("EBADARG", `invalid dimension '${spec}' - ${DIM_HINT}`);
    }
    width = positiveInt(sizePart, "width", spec);
  } else {
    const w = sizePart.slice(0, x);
    const h = sizePart.slice(x + 1);
    if (h === "") {
      throw new Panic("EBADARG", `invalid dimension '${spec}' - ${DIM_HINT}`);
    }
    if (w !== "") width = positiveInt(w, "width", spec);
    height = positiveInt(h, "height", spec);
  }

  if (left !== null && (width === null || height === null)) {
    throw new Panic("EBADARG", `region '${spec}' needs both width and height`);
  }

  return { width, height, left, top };
}
