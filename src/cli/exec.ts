// Plan execution over sharp. Loaded lazily by the CLI so that pure
// plan-building stages (resize, crop, ...) never pay sharp's startup
// or require it to be installable.

import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import sharp, {
  type Sharp as SharpInstance,
  type FormatEnum,
  type Metadata,
  type FitEnum,
  type OverlayOptions,
} from "sharp";
import { Panic, isUrl, type Op, type OkPlan } from "../core/plan.ts";

// Each input is read exactly once per run, so libvips' file cache buys
// nothing here - it only holds memory and keeps files locked on Windows.
sharp.cache(false);
import { EXT_TO_FORMAT } from "../core/ops.ts";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const VERSION = pkg.version;

const CONCURRENCY = 4;

// Safety limits: prevent memory bombs and runaway processing.
const MAX_DIMENSION = 10_000;
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

function checkDimension(file: string, w: number | null, h: number | null): void {
  if ((w ?? 0) > MAX_DIMENSION || (h ?? 0) > MAX_DIMENSION) {
    runtimeFail(file, `image ${w}x${h} exceeds the ${MAX_DIMENSION}px maximum dimension`);
  }
}

function runtimeFail(file: string, message: string): never {
  throw new Panic("ERUNTIME", `${file}: ${message}`);
}

// --------------------------------------------------------------------------
// URL sources: fetched straight into memory and handed to sharp as a
// buffer, so a remote image gets exactly one network round trip and never
// touches disk - the fetch just replaces the initial decode step that
// `sharp(path)` would otherwise do from a local file.

const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_BYTES = 50 * 1024 * 1024;
const FETCH_RETRIES = 2;

async function fetchBuffer(url: string): Promise<Buffer> {
  const userAgent = `photu/${VERSION}`;
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { signal: controller.signal, headers: { "user-agent": userAgent } });
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < FETCH_RETRIES) continue;
      const reason =
        (err as Error).name === "AbortError"
          ? `timed out after ${FETCH_TIMEOUT_MS / 1000}s`
          : (err as Error).message;
      throw new Panic("EFETCH", `${url}: could not fetch - ${reason}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      lastErr = null;
      throw new Panic("EFETCH", `${url}: HTTP ${res.status} ${res.statusText}`);
    }
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > FETCH_MAX_BYTES) {
      throw new Panic(
        "EFETCH",
        `${url}: ${declared} bytes exceeds the ${FETCH_MAX_BYTES / (1024 * 1024)} MB fetch limit`,
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > FETCH_MAX_BYTES) {
      throw new Panic(
        "EFETCH",
        `${url}: ${buf.length} bytes exceeds the ${FETCH_MAX_BYTES / (1024 * 1024)} MB fetch limit`,
      );
    }
    if (buf.length === 0) {
      throw new Panic("EFETCH", `${url}: empty response`);
    }
    return buf;
  }
  throw lastErr ? new Panic("EFETCH", `${url}: could not fetch - ${(lastErr as Error).message}`) : new Panic("EFETCH", `${url}: could not fetch`);
}

// --------------------------------------------------------------------------
// Output path templating: {name}, {ext}, {i}

function splitName(file: string): { name: string; ext: string } {
  let base: string;
  if (isUrl(file)) {
    const path = new URL(file).pathname;
    base = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)) || "image";
  } else {
    base = file.slice(file.lastIndexOf("/") + 1);
  }
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
async function materialize(img: SharpInstance) {
  const { data, info } = await img.png().toBuffer({ resolveWithObject: true });
  return { img: sharp(data), width: info.width, height: info.height };
}

/** Trims border pixels that match the background (corner pixel colour within
 * `threshold`). Analyses a downsampled copy for speed, then extracts the
 * content bounding box from the original-resolution image. */
async function applyTrim(img: SharpInstance, threshold: number): Promise<SharpInstance> {
  const meta = await img.metadata();
  const W = meta.width!;
  const H = meta.height!;

  const analysisSize = 200;
  const scale = Math.min(1, analysisSize / Math.max(W, H));
  const analW = Math.max(1, Math.round(W * scale));
  const analH = Math.max(1, Math.round(H * scale));

  const { data, info } = await img
    .resize(analW, analH, { fit: "inside", withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels as 1 | 2 | 3 | 4;
  const hasAlpha = channels === 2 || channels === 4;

  const bgR = data[0]!;
  const bgG = data[1]!;
  const bgB = data[2]!;

  let minX = analW, minY = analH, maxX = 0, maxY = 0;
  for (let y = 0; y < analH; y++) {
    const rowBase = y * analW * channels;
    for (let x = 0; x < analW; x++) {
      const i = rowBase + x * channels;
      const r = data[i]!;
      const g = data[i + 1]!;
      const b = data[i + 2]!;
      const a = hasAlpha ? data[i + 3]! : 255;

      const isBg =
        a < 128 ||
        (Math.abs(r - bgR) <= threshold && Math.abs(g - bgG) <= threshold && Math.abs(b - bgB) <= threshold);
      if (!isBg) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX) return img; // nothing to trim

  const left = Math.max(0, Math.floor(minX / scale));
  const top = Math.max(0, Math.floor(minY / scale));
  const width = Math.min(W - left, Math.ceil((maxX - minX + 1) / scale));
  const height = Math.min(H - top, Math.ceil((maxY - minY + 1) / scale));
  return img.extract({ left, top, width, height });
}

async function applyCrop(img: SharpInstance, op: Op, file: string): Promise<SharpInstance> {
  const m = await materialize(img);
  const w = op["width"] as number;
  const h = op["height"] as number;
  if (op["mode"] === "region") {
    const left = op["left"] as number;
    const top = op["top"] as number;
    if (left + w > m.width || top + h > m.height) {
      runtimeFail(file, `crop ${w}x${h}+${left}+${top} exceeds image ${m.width}x${m.height}`);
    }
    return m.img.extract({ left, top, width: w, height: h });
  }
  if (w > m.width || h > m.height) {
    runtimeFail(file, `crop ${w}x${h} exceeds image ${m.width}x${m.height}`);
  }
  const { left, top } = gravityOffsets(op["gravity"] as string, m.width, m.height, w, h);
  return m.img.extract({ left, top, width: w, height: h });
}

async function overlayInput(op: Op): Promise<OverlayOptions> {
  const opacity = op["opacity"] as number;
  if (opacity >= 1) {
    return { input: op["path"] as string, gravity: gravity(op["gravity"] as string) };
  }
  const { data, info } = await sharp(op["path"] as string)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (let i = 3; i < data.length; i += 4) {
    data[i]! = Math.round(data[i]! * opacity);
  }
  return {
    input: data,
    raw: { width: info.width, height: info.height, channels: 4 },
    gravity: gravity(op["gravity"] as string),
  };
}

function outputFormat(op: Op, file: string): string {
  if (op["format"] !== "source") return op["format"] as string;
  const { ext } = splitName(file);
  const format = EXT_TO_FORMAT[ext.toLowerCase()];
  if (!format) runtimeFail(file, `cannot keep source format: unrecognized extension '.${ext}'`);
  return format;
}

/** Applies one transform stage (everything except `write`) to a single,
 * ordinary (non-animated) sharp pipeline. Shared by the still-image path
 * and, per split-out frame, by the animated path below - so every op only
 * has to be correct for a single flat image, never for a page stack. */
async function applyOp(img: SharpInstance, op: Op, file: string): Promise<SharpInstance> {
  switch (op.op) {
    case "resize":
      return img.resize({
        width: (op["width"] as number | null) ?? undefined,
        height: (op["height"] as number | null) ?? undefined,
        fit: op["fit"] as keyof FitEnum,
        withoutEnlargement: !op["upscale"],
      });
    case "crop":
      return applyCrop(img, op, file);
    case "rotate":
      return img.rotate(op["angle"] as number, { background: op["background"] as string });
    case "flip":
      return img.flip();
    case "mirror":
      return img.flop();
    case "grayscale":
      return img.grayscale();
    case "adjust":
      return img.modulate({
        brightness: op["brightness"] as number,
        saturation: op["saturation"] as number,
        hue: op["hue"] as number,
      });
    case "blur":
      return op["sigma"] === null ? img.blur() : img.blur(op["sigma"] as number);
    case "sharpen":
      return op["sigma"] === null ? img.sharpen() : img.sharpen({ sigma: op["sigma"] as number });
    case "overlay":
      return img.composite([await overlayInput(op)]);
    case "pad": {
      const s = op["size"] as number;
      return img.extend({ top: s, bottom: s, left: s, right: s, background: op["color"] as string });
    }
    case "trim": {
      const threshold = op["threshold"] as number;
      return applyTrim(img, threshold);
    }
    case "normalize":
      return img.normalize();
    case "negate":
      return img.negate();
    case "sepia": {
      const strength = op["strength"] as number;
      if (strength === 0) return img;
      return img.toColourspace("lch").linear([1, 1 + strength * 0.5, 1], [0, strength * 20, 0]).toColourspace("srgb");
    }
    case "level": {
      const black = op["black"] as number;
      const white = op["white"] as number;
      const gamma = op["gamma"] as number;
      const scale = 255 / (white - black);
      const offset = -black * scale;
      return img.linear([scale, scale, scale], [offset, offset, offset]).gamma(1 / gamma);
    }
    case "median": {
      const size = op["size"] as number | null;
      return size === null ? img.median() : img.median(size);
    }
    default:
      throw new Panic(
        "EUNKNOWN",
        `plan contains op '${op.op}' which this photu does not know - version mismatch in your pipeline?`,
      );
  }
}

function toFormatOpts(writeOp: Op, format: string): Record<string, unknown> {
  const quality = writeOp["quality"] as number | null;
  const opts: Record<string, unknown> = {};
  if (quality !== null && format !== "png" && format !== "gif") opts["quality"] = quality;
  if (writeOp["lossless"] && (format === "webp" || format === "avif")) opts["lossless"] = true;
  return opts;
}

async function writeStill(img: SharpInstance, writeOp: Op, file: string, outPath: string): Promise<void> {
  const format = outputFormat(writeOp, file);
  if (format === "jpeg") img = img.flatten({ background: writeOp["background"] as string });
  img = img.toFormat(format as keyof FormatEnum, toFormatOpts(writeOp, format));
  await img.toFile(outPath);
}

// Formats this libvips build actually keeps multi-frame through a
// re-encode. jpeg/png/avif accept a page-stacked pipeline without erroring
// but silently flatten every frame into one tall still image, so animated
// output is limited to the formats that round-tripped correctly in testing.
const ANIMATED_OUTPUT_FORMATS = new Set(["gif", "webp", "tiff"]);
const DELAY_AWARE_FORMATS = new Set(["gif", "webp"]);

/** Animated sources (multi-frame GIF/WebP/TIFF) are split into independent
 * per-frame images so every op above runs on a single flat frame - resize's
 * resampling kernel, blur/sharpen's convolution and any op that needs
 * current dimensions (crop, via materialize) would otherwise blend pixels
 * across the frame boundary if run on the frames-stacked-into-one-tall-image
 * view libvips uses internally. The frames are re-joined after processing. */
async function processAnimated(
  img: SharpInstance,
  transformOps: Op[],
  writeOp: Op,
  file: string,
  outPath: string,
  pages: number,
  meta: Metadata,
): Promise<void> {
  const format = outputFormat(writeOp, file);
  if (!ANIMATED_OUTPUT_FORMATS.has(format)) {
    runtimeFail(
      file,
      `cannot write ${pages} animated frames to ${format} - gif, webp and tiff are the only ` +
        "formats this build keeps animated",
    );
  }

  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const pageHeight = info.pageHeight ?? info.height;
  const channels = info.channels as 1 | 2 | 3 | 4;
  const frameBytes = info.width * pageHeight * channels;

  const frames = await Promise.all(
    Array.from({ length: pages }, async (_, p) => {
      const raw = data.subarray(p * frameBytes, (p + 1) * frameBytes);
      let frame = sharp(raw, { raw: { width: info.width, height: pageHeight, channels } });
      for (const op of transformOps) frame = await applyOp(frame, op, file);
      return frame.png().toBuffer(); // lossless, self-describing - safe to rejoin from
    }),
  );

  let joined = sharp(frames, { join: { animated: true } });
  const opts = toFormatOpts(writeOp, format);
  if (DELAY_AWARE_FORMATS.has(format)) {
    if (meta["delay"]) opts["delay"] = meta["delay"];
    if (meta["loop"] !== undefined) opts["loop"] = meta["loop"];
  }
  joined = joined.toFormat(format as keyof FormatEnum, opts);
  await joined.toFile(outPath);
}

async function processFile(file: string, ops: Op[], outPath: string): Promise<void> {
  const input = isUrl(file) ? await fetchBuffer(file) : file;
  if (!isUrl(file)) {
    const size = statSync(file).size;
    if (size > MAX_FILE_SIZE) {
      runtimeFail(file, `${size} bytes exceeds the ${MAX_FILE_SIZE / (1024 * 1024)} MB file size limit`);
    }
  }
  // {animated: true} reads every frame of a GIF/WebP/TIFF source instead of
  // just the first; it's a no-op for formats without pages.
  const img = sharp(input, { animated: true }).rotate(); // EXIF auto-orient, always
  const meta = await img.metadata();
  const pages = meta.pages ?? 1;
  checkDimension(file, meta.width, meta.height);

  // `write` is always the last op (execute() below relies on the same
  // invariant), so everything before it is a transform stage.
  const writeOp = ops[ops.length - 1]!;
  const transformOps = ops.slice(0, -1);

  if (pages === 1) {
    let still = img;
    for (const op of transformOps) still = await applyOp(still, op, file);
    return writeStill(still, writeOp, file, outPath);
  }
  return processAnimated(img, transformOps, writeOp, file, outPath, pages, meta);
}

// --------------------------------------------------------------------------
// The sink: validate outputs, then run files through a fail-fast pool.

export async function execute(plan: OkPlan): Promise<void> {
  const writeOp = plan.ops[plan.ops.length - 1]!;
  const template = writeOp["template"] as string;

  const outputs = plan.files.map((f, i) =>
    resolve(renderTemplate(template, f, i)).replaceAll("\\", "/"),
  );

  const seen = new Map<string, string>();
  for (let i = 0; i < outputs.length; i++) {
    const key = process.platform === "win32" ? outputs[i]!.toLowerCase() : outputs[i]!;
    const prior = seen.get(key);
    if (prior !== undefined) {
      throw new Panic(
        "ECOLLIDE",
        `'${prior}' and '${plan.files[i]!}' both write to '${outputs[i]!}' - ` +
          "disambiguate the template with {i}",
      );
    }
    seen.set(key, plan.files[i]!);
    const inputKey = process.platform === "win32" ? plan.files[i]!.toLowerCase() : plan.files[i]!;
    if (key === inputKey) {
      throw new Panic("EOVERWRITE", `'${outputs[i]!}' would overwrite its own input`);
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
        await processFile(plan.files[i]!, plan.ops, outputs[i]!);
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
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((r) => r[c]!.length)));
  for (const row of rows) {
    process.stdout.write(row.map((cell, c) => cell.padEnd(widths[c]!)).join("  ").trimEnd() + "\n");
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
