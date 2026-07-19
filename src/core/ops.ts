// The photu command registry: turns argv tokens for one stage into a
// fully-normalized op object (every default explicit, args validated).
// Pure module — no Node APIs, no sharp. Execution lives in the CLI/playground.

import { Panic, type Op } from "./plan.ts";
import { type ArgValue, parseArgs, parseDimension } from "./args.ts";

export const GRAVITIES = [
  "center",
  "north",
  "northeast",
  "east",
  "southeast",
  "south",
  "southwest",
  "west",
  "northwest",
] as const;

export const FITS = ["inside", "cover", "contain", "fill", "outside"] as const;

/** Formats photu can write, keyed by template extension. */
export const EXT_TO_FORMAT: Record<string, string> = {
  jpg: "jpeg",
  jpeg: "jpeg",
  png: "png",
  webp: "webp",
  gif: "gif",
  tif: "tiff",
  tiff: "tiff",
  avif: "avif",
};

const QUALITY_FORMATS = new Set(["jpeg", "webp", "avif", "tiff", "source"]);
const LOSSLESS_FORMATS = new Set(["webp", "avif", "source"]);

// ---------------------------------------------------------------------------
// Per-stage parsing context: tracks which options a spec consumed so that
// anything left over panics as an unknown option.

class Stage {
  command: string;
  positionals: string[];
  private options: Map<string, ArgValue>;

  constructor(command: string, tokens: string[]) {
    const parsed = parseArgs(tokens);
    this.command = command;
    this.positionals = parsed.positionals;
    this.options = parsed.options;
  }

  fail(message: string): never {
    throw new Panic("EBADARG", `${this.command}: ${message}`);
  }

  /** Pull known bare-word flags (e.g. "upscale") out of the positionals. */
  flag(name: string): boolean {
    const i = this.positionals.indexOf(name);
    if (i === -1) return false;
    this.positionals.splice(i, 1);
    return true;
  }

  positional(what: string): string {
    if (this.positionals.length === 0) this.fail(`missing ${what}`);
    return this.positionals.shift()!;
  }

  maybePositional(): string | null {
    return this.positionals.shift() ?? null;
  }

  private take(key: string): ArgValue | undefined {
    const v = this.options.get(key);
    this.options.delete(key);
    return v;
  }

  str(key: string, def: string): string {
    const v = this.take(key);
    if (v === undefined) return def;
    return String(v);
  }

  num(key: string, def: number, min: number, max: number, opts?: { int?: boolean }): number {
    const v = this.take(key);
    if (v === undefined) return def;
    if (typeof v !== "number" || (opts?.int && !Number.isInteger(v))) {
      this.fail(`option '${key}' must be ${opts?.int ? "an integer" : "a number"}, got '${v}'`);
    }
    if (v < min || v > max) {
      this.fail(`option '${key}' must be between ${min} and ${max}, got ${v}`);
    }
    return v;
  }

  enum<T extends readonly string[]>(key: string, def: T[number], allowed: T): T[number] {
    const v = this.take(key);
    if (v === undefined) return def;
    if (typeof v !== "string" || !allowed.includes(v)) {
      this.fail(`option '${key}' must be one of ${allowed.join("|")}, got '${v}'`);
    }
    return v;
  }

  has(key: string): boolean {
    return this.options.has(key);
  }

  /** Every spec must end with this: leftovers are user typos. */
  finish(op: Op): Op {
    if (this.positionals.length > 0) {
      this.fail(`unexpected argument '${this.positionals[0]}'`);
    }
    const leftover = this.options.keys().next();
    if (!leftover.done) {
      this.fail(`unknown option '${leftover.value}'`);
    }
    return op;
  }
}

// ---------------------------------------------------------------------------
// Specs. Each returns a fully-normalized op: all defaults written out.

type Spec = (s: Stage) => Op;

const SPECS: Record<string, Spec> = {
  resize(s) {
    const upscale = s.flag("upscale");
    const dim = parseDimension(s.positional("dimension (e.g. 1600 or 800x600)"));
    const fit = s.enum("fit", "inside", FITS);
    return s.finish({ op: "resize", width: dim.width, height: dim.height, fit, upscale });
  },

  crop(s) {
    const dim = parseDimension(s.positional("dimension (e.g. 800x600 or 800x600+40+10)"), {
      region: true,
    });
    const width = dim.width ?? dim.height!;
    const height = dim.height ?? dim.width!;
    if (dim.left !== null) {
      if (s.has("gravity")) s.fail("a region crop (WxH+LEFT+TOP) does not take gravity");
      return s.finish({ op: "crop", mode: "region", width, height, left: dim.left, top: dim.top });
    }
    const gravity = s.enum("gravity", "center", GRAVITIES);
    return s.finish({ op: "crop", mode: "gravity", width, height, gravity });
  },

  rotate(s) {
    const raw = s.positional("angle in degrees");
    const angle = Number(raw);
    if (!Number.isFinite(angle)) s.fail(`invalid angle '${raw}'`);
    const background = s.str("background", "black");
    return s.finish({ op: "rotate", angle, background });
  },

  flip(s) {
    return s.finish({ op: "flip" });
  },

  mirror(s) {
    return s.finish({ op: "mirror" });
  },

  grayscale(s) {
    return s.finish({ op: "grayscale" });
  },

  adjust(s) {
    const given = ["brightness", "saturation", "hue"].some((k) => s.has(k));
    if (!given) s.fail("needs at least one of brightness=, saturation=, hue=");
    const brightness = s.num("brightness", 1, 0, 100);
    const saturation = s.num("saturation", 1, 0, 100);
    const hue = s.num("hue", 0, -360, 360, { int: true });
    return s.finish({ op: "adjust", brightness, saturation, hue });
  },

  blur(s) {
    const raw = s.maybePositional();
    let sigma: number | null = null;
    if (raw !== null) {
      sigma = Number(raw);
      if (!Number.isFinite(sigma) || sigma < 0.3 || sigma > 1000) {
        s.fail(`sigma must be a number between 0.3 and 1000, got '${raw}'`);
      }
    }
    return s.finish({ op: "blur", sigma });
  },

  sharpen(s) {
    const raw = s.maybePositional();
    let sigma: number | null = null;
    if (raw !== null) {
      sigma = Number(raw);
      if (!Number.isFinite(sigma) || sigma <= 0 || sigma > 10) {
        s.fail(`sigma must be a number between 0 and 10, got '${raw}'`);
      }
    }
    return s.finish({ op: "sharpen", sigma });
  },

  overlay(s) {
    const path = s.positional("overlay image path");
    const gravity = s.enum("gravity", "center", GRAVITIES);
    const opacity = s.num("opacity", 1, 0, 1);
    return s.finish({ op: "overlay", path, gravity, opacity });
  },

  pad(s) {
    const raw = s.positional("padding in pixels");
    const size = Number(raw);
    if (!Number.isInteger(size) || size <= 0) s.fail(`invalid padding '${raw}'`);
    const color = s.str("color", "black");
    return s.finish({ op: "pad", size, color });
  },

  write(s) {
    const lossless = s.flag("lossless");
    const template = s.positional("output template (e.g. out/{name}.webp)");
    const format = formatFromTemplate(s, template);
    if (s.has("quality") && !QUALITY_FORMATS.has(format)) {
      s.fail(`${format} does not take quality=`);
    }
    if (lossless && !LOSSLESS_FORMATS.has(format)) {
      s.fail(`${format} has no lossless mode`);
    }
    const quality = QUALITY_FORMATS.has(format) ? s.num("quality", 80, 1, 100, { int: true }) : null;
    const background = s.str("background", "white");
    return s.finish({ op: "write", template, format, quality, lossless, background });
  },
};

function formatFromTemplate(s: Stage, template: string): string {
  const base = template.slice(Math.max(template.lastIndexOf("/"), template.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  if (dot === -1 || dot === base.length - 1) {
    s.fail(`cannot infer format: '${template}' has no file extension`);
  }
  const ext = base.slice(dot + 1).toLowerCase();
  if (ext === "{ext}") return "source";
  const format = EXT_TO_FORMAT[ext];
  if (!format) {
    const known = [...new Set(Object.values(EXT_TO_FORMAT))].join(", ");
    s.fail(`cannot write '.${ext}' - supported: ${known} (or {ext} to keep the source format)`);
  }
  return format;
}

export const COMMANDS = Object.keys(SPECS);

/** Normalize one pipeline stage: command name + its argv tokens -> op. */
export function normalizeOp(command: string, tokens: string[]): Op {
  const spec = SPECS[command];
  if (!spec) {
    throw new Panic("EUNKNOWN", `unknown command '${command}' - commands: ${COMMANDS.join(", ")}`);
  }
  return spec(new Stage(command, tokens));
}
