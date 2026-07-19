// Plan execution over sharp. Loaded lazily by the CLI so that pure
// plan-building stages (resize, crop, ...) never pay sharp's startup
// or require it to be installable.

import { mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import sharp from "sharp";
import { Panic, type Op, type OkPlan } from "../core/plan.ts";

// Each input is read exactly once per run, so libvips' file cache buys
// nothing here - it only holds memory and keeps files locked on Windows.
sharp.cache(false);
import { EXT_TO_FORMAT } from "../core/ops.ts";

const CONCURRENCY = 4;

function runtimeFail(file: string, message: string): never {
  throw new Panic("ERUNTIME", `${file}: ${message}`);
}

// --------------------------------------------------------------------------
// Output path templating: {name}, {ext}, {i}

function splitName(file: string): { name: string; ext: string } {
  const base = file.slice(file.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return { name: base, ext: "" };
  return { name: base.slice(0, dot), ext: base.slice(dot + 1) };
}

function renderTemplate(template: string, file: string, index: number): string {
  const { name, ext } = splitName(file);
  return template
    .replaceAll("{name}", name)
    .replaceAll("{ext}", ext)
    .replaceAll("{i}", String(index + 1));
}

// --------------------------------------------------------------------------
// Per-op execution

const SHARP_GRAVITY: Record<string, string> = { center: "centre" };
const gravity = (g: string) => SHARP_GRAVITY[g] ?? g;

function gravityOffsets(g: string, W: number, H: number, w: number, h: number) {
  let left = Math.floor((W - w) / 2);
  let top = Math.floor((H - h) / 2);
  if (g.includes("west")) left = 0;
  if (g.includes("east")) left = W - w;
  if (g.includes("north")) top = 0;
  if (g.includes("south")) top = H - h;
  return { left, top };
}

/** Crops need the current dimensions, which a sharp chain does not expose,
 * so materialize the pipeline losslessly and start a fresh chain. */
async function materialize(img: sharp.Sharp) {
  const { data, info } = await img.png().toBuffer({ resolveWithObject: true });
  return { img: sharp(data), width: info.width, height: info.height };
}

async function applyCrop(img: sharp.Sharp, op: Op, file: string): Promise<sharp.Sharp> {
  const m = await materialize(img);
  const w = op.width as number;
  const h = op.height as number;
  if (op.mode === "region") {
    const left = op.left as number;
    const top = op.top as number;
    if (left + w > m.width || top + h > m.height) {
      runtimeFail(file, `crop ${w}x${h}+${left}+${top} exceeds image ${m.width}x${m.height}`);
    }
    return m.img.extract({ left, top, width: w, height: h });
  }
  if (w > m.width || h > m.height) {
    runtimeFail(file, `crop ${w}x${h} exceeds image ${m.width}x${m.height}`);
  }
  const { left, top } = gravityOffsets(op.gravity as string, m.width, m.height, w, h);
  return m.img.extract({ left, top, width: w, height: h });
}

async function overlayInput(op: Op): Promise<sharp.OverlayOptions> {
  const opacity = op.opacity as number;
  if (opacity >= 1) {
    return { input: op.path as string, gravity: gravity(op.gravity as string) };
  }
  const { data, info } = await sharp(op.path as string)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) {
    data[i] = Math.round(data[i] * opacity);
  }
  return {
    input: data,
    raw: { width: info.width, height: info.height, channels: 4 },
    gravity: gravity(op.gravity as string),
  };
}

function outputFormat(op: Op, file: string): string {
  if (op.format !== "source") return op.format as string;
  const { ext } = splitName(file);
  const format = EXT_TO_FORMAT[ext.toLowerCase()];
  if (!format) runtimeFail(file, `cannot keep source format: unrecognized extension '.${ext}'`);
  return format;
}

async function processFile(file: string, ops: Op[], outPath: string): Promise<void> {
  let img = sharp(file).rotate(); // EXIF auto-orient, always

  for (const op of ops) {
    switch (op.op) {
      case "resize":
        img = img.resize({
          width: (op.width as number | null) ?? undefined,
          height: (op.height as number | null) ?? undefined,
          fit: op.fit as keyof sharp.FitEnum,
          withoutEnlargement: !op.upscale,
        });
        break;
      case "crop":
        img = await applyCrop(img, op, file);
        break;
      case "rotate":
        img = img.rotate(op.angle as number, { background: op.background as string });
        break;
      case "flip":
        img = img.flip();
        break;
      case "mirror":
        img = img.flop();
        break;
      case "grayscale":
        img = img.grayscale();
        break;
      case "adjust":
        img = img.modulate({
          brightness: op.brightness as number,
          saturation: op.saturation as number,
          hue: op.hue as number,
        });
        break;
      case "blur":
        img = op.sigma === null ? img.blur() : img.blur(op.sigma as number);
        break;
      case "sharpen":
        img = op.sigma === null ? img.sharpen() : img.sharpen({ sigma: op.sigma as number });
        break;
      case "overlay":
        img = img.composite([await overlayInput(op)]);
        break;
      case "pad": {
        const s = op.size as number;
        img = img.extend({
          top: s,
          bottom: s,
          left: s,
          right: s,
          background: op.color as string,
        });
        break;
      }
      case "write": {
        const format = outputFormat(op, file);
        if (format === "jpeg") {
          img = img.flatten({ background: op.background as string });
        }
        const quality = op.quality as number | null;
        const opts: Record<string, unknown> = {};
        if (quality !== null && format !== "png" && format !== "gif") opts.quality = quality;
        if (op.lossless && (format === "webp" || format === "avif")) opts.lossless = true;
        img = img.toFormat(format as keyof sharp.FormatEnum, opts);
        await img.toFile(outPath);
        return;
      }
      default:
        throw new Panic(
          "EUNKNOWN",
          `plan contains op '${op.op}' which this photu does not know - version mismatch in your pipeline?`,
        );
    }
  }
}

// --------------------------------------------------------------------------
// The sink: validate outputs, then run files through a fail-fast pool.

export async function execute(plan: OkPlan): Promise<void> {
  const writeOp = plan.ops[plan.ops.length - 1];
  const template = writeOp.template as string;

  const outputs = plan.files.map((f, i) =>
    resolve(renderTemplate(template, f, i)).replaceAll("\\", "/"),
  );

  const seen = new Map<string, string>();
  for (let i = 0; i < outputs.length; i++) {
    const key = process.platform === "win32" ? outputs[i].toLowerCase() : outputs[i];
    const prior = seen.get(key);
    if (prior !== undefined) {
      throw new Panic(
        "ECOLLIDE",
        `'${prior}' and '${plan.files[i]}' both write to '${outputs[i]}' - ` +
          "disambiguate the template with {i}",
      );
    }
    seen.set(key, plan.files[i]);
    const inputKey = process.platform === "win32" ? plan.files[i].toLowerCase() : plan.files[i];
    if (key === inputKey) {
      throw new Panic("EOVERWRITE", `'${outputs[i]}' would overwrite its own input`);
    }
  }

  for (const dir of new Set(outputs.map((o) => dirname(o)))) {
    mkdirSync(dir, { recursive: true });
  }

  let next = 0;
  let failure: unknown = null;
  async function worker(): Promise<void> {
    while (failure === null) {
      const i = next++;
      if (i >= plan.files.length) return;
      try {
        await processFile(plan.files[i], plan.ops, outputs[i]);
      } catch (err) {
        failure = err instanceof Panic
          ? err
          : new Panic("ERUNTIME", `${plan.files[i]}: ${(err as Error).message}`);
        return;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, plan.files.length) }, worker));
  if (failure !== null) throw failure;
}

// --------------------------------------------------------------------------
// Utilities that need sharp: info and formats.

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function info(files: string[]): Promise<void> {
  const rows = await Promise.all(
    files.map(async (f) => {
      try {
        const m = await sharp(f).metadata();
        const oriented = (m.orientation ?? 1) >= 5;
        const w = oriented ? m.height : m.width;
        const h = oriented ? m.width : m.height;
        return [f, m.format ?? "?", `${w}x${h}`, `${m.channels}ch`, humanSize(statSync(f).size)];
      } catch (err) {
        runtimeFail(f, (err as Error).message);
      }
    }),
  );
  const widths = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  for (const row of rows) {
    process.stdout.write(row.map((cell, c) => cell.padEnd(widths[c])).join("  ").trimEnd() + "\n");
  }
}

export function formats(): void {
  const yes = (b: boolean) => (b ? "yes" : "no");
  process.stdout.write("format  read  write\n");
  for (const [name, f] of Object.entries(sharp.format)) {
    const read = Boolean(f.input?.file || f.input?.buffer || f.input?.stream);
    const write = Boolean(f.output?.file || f.output?.buffer || f.output?.stream);
    if (!read && !write) continue;
    process.stdout.write(`${name.padEnd(6)}  ${yes(read).padEnd(4)}  ${yes(write)}\n`);
  }
}
