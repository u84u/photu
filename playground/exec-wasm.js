// Plan execution over wasm-vips, for the photu playground. Standalone
// plain-JS ESM: runs in the browser and in Node (tests). Takes ops
// already normalized by the shared core, so validation and defaults
// are identical to the CLI - only the pixel backend differs.

export class ExecError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new ExecError(code, message);
};

const NAMED_COLORS = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  yellow: [255, 255, 0],
  cyan: [0, 255, 255],
  magenta: [255, 0, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  orange: [255, 165, 0],
};

export function parseColor(str) {
  const named = NAMED_COLORS[str.toLowerCase()];
  if (named) return named;
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(str);
  if (!m) fail("EBADARG", `unsupported color '${str}' - use a name or #rrggbb`);
  const hex = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function gravityOffsets(g, W, H, w, h) {
  let left = Math.floor((W - w) / 2);
  let top = Math.floor((H - h) / 2);
  if (g.includes("west")) left = 0;
  if (g.includes("east")) left = W - w;
  if (g.includes("north")) top = 0;
  if (g.includes("south")) top = H - h;
  return { left, top };
}

function tryGetInt(im, name) {
  try {
    return im.getInt(name);
  } catch {
    return 0;
  }
}

function tryGetArrayDouble(im, name) {
  try {
    return im.getArrayDouble(name);
  } catch {
    return null;
  }
}

const FORMAT_EXT = {
  jpeg: ".jpg",
  png: ".png",
  webp: ".webp",
  gif: ".gif",
  tiff: ".tif",
  avif: ".avif",
};

const ANIMATED_OUTPUT_FORMATS = new Set([".gif", ".tif"]);

function applyResize(im, op) {
  const W = im.width;
  const H = im.height;
  const w = op.width;
  const h = op.height;
  const sw = w === null ? Infinity : w / W;
  const sh = h === null ? Infinity : h / H;
  const both = w !== null && h !== null;

  if (op.fit === "fill" && both) {
    let hs = sw;
    let vs = sh;
    if (!op.upscale) {
      hs = Math.min(hs, 1);
      vs = Math.min(vs, 1);
    }
    return im.resize(hs, { vscale: vs });
  }

  let scale;
  if (both && (op.fit === "cover" || op.fit === "outside")) {
    scale = Math.max(sw, sh);
  } else {
    scale = Math.min(sw, sh);
  }
  if (!op.upscale) scale = Math.min(scale, 1);
  let out = scale === 1 ? im : im.resize(scale);

  if (both && op.fit === "cover") {
    const cw = Math.min(w, out.width);
    const ch = Math.min(h, out.height);
    const { left, top } = gravityOffsets("center", out.width, out.height, cw, ch);
    out = out.extractArea(left, top, cw, ch);
  }
  if (both && op.fit === "contain" && (out.width < w || out.height < h)) {
    out = out.embed(
      Math.floor((w - out.width) / 2),
      Math.floor((h - out.height) / 2),
      w,
      h,
      { extend: "background", background: [0, 0, 0] },
    );
  }
  return out;
}

function applyCrop(im, op) {
  const W = im.width;
  const H = im.height;
  if (op.mode === "region") {
    if (op.left + op.width > W || op.top + op.height > H) {
      fail("ERUNTIME", `crop ${op.width}x${op.height}+${op.left}+${op.top} exceeds image ${W}x${H}`);
    }
    return im.extractArea(op.left, op.top, op.width, op.height);
  }
  if (op.width > W || op.height > H) {
    fail("ERUNTIME", `crop ${op.width}x${op.height} exceeds image ${W}x${H}`);
  }
  const { left, top } = gravityOffsets(op.gravity, W, H, op.width, op.height);
  return im.extractArea(left, top, op.width, op.height);
}

function applyRotate(im, op) {
  const a = ((op.angle % 360) + 360) % 360;
  if (a === 0) return im;
  if (a === 90) return im.rot90();
  if (a === 180) return im.rot180();
  if (a === 270) return im.rot270();
  return im.rotate(op.angle, { background: parseColor(op.background) });
}

function applyAdjust(im, op) {
  const hasAlpha = im.hasAlpha();
  let flat = hasAlpha ? im.flatten({ background: [0, 0, 0] }) : im;
  const out = flat
    .colourspace("lch")
    .linear([op.brightness, op.saturation, 1], [0, 0, op.hue])
    .colourspace("srgb");
  return out;
}

function sourceExt(name) {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) fail("ERUNTIME", `cannot keep source format: '${name}' has no extension`);
  const ext = "." + name.slice(dot + 1).toLowerCase();
  const known = Object.values(FORMAT_EXT).concat([".jpeg", ".tiff"]);
  if (!known.includes(ext)) {
    fail("ERUNTIME", `cannot keep source format: unrecognized extension '${ext}'`);
  }
  return ext === ".jpeg" ? ".jpg" : ext === ".tiff" ? ".tif" : ext;
}

/** Load an overlay image. Local paths can't be read in the browser, so
 * overlay in the playground requires an http(s) URL. Returns the overlay
 * as a wasm-vips Image. */
async function loadOverlay(vips, path) {
  if (!path.startsWith("http://") && !path.startsWith("https://")) {
    fail("EUNSUPPORTED", `overlay with local path '${path}' is not supported in the playground - use a URL or the CLI`);
  }
  const res = await fetch(path);
  if (!res.ok) fail("EFETCH", `could not fetch overlay ${path}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let overlay = vips.Image.newFromBuffer(bytes);
  try {
    overlay = overlay.autorot();
  } catch {}
  return overlay;
}

/** Apply an overlay (watermark) image onto `im` with gravity and opacity. */
async function applyOverlay(vips, im, op) {
  let overlay = await loadOverlay(vips, op.path);
  const opacity = op.opacity;

  let result = im;
  if (opacity < 1) {
    if (overlay.bands < 4) {
      const alpha = overlay.extractBand(0, { n: 1 }).multiply(0).add(255);
      overlay = overlay.bandjoin(alpha);
    }
    const alpha = overlay.extractBand(3, { n: 1 }).multiply(opacity);
    overlay = overlay.extractBand(0, { n: 3 }).bandjoin(alpha);
  }

  const W = im.width;
  const H = im.height;
  const ow = overlay.width;
  const oh = overlay.height;
  const { left, top } = gravityOffsets(op.gravity, W, H, ow, oh);
  result = im.composite(overlay, 2, { x: left, y: top }); // 2 = BlendMode.over
  return result;
}

/** Split a multi-page image into per-frame images. Each page is loaded
 * separately from the input buffer, since libvips does not stack pages
 * vertically in the image data. */
function splitFrames(vips, inputBytes) {
  const im = vips.Image.newFromBuffer(inputBytes);
  const pages = tryGetInt(im, "n-pages") || 1;
  if (pages <= 1) return [im];
  const frames = [];
  for (let p = 0; p < pages; p++) {
    frames.push(vips.Image.newFromBuffer(inputBytes, `page=${p}`));
  }
  return frames;
}

/** Rejoin processed frames into a multi-page animated image. */
function joinFrames(vips, frames, pageHeight, delays, loop) {
  const joined = vips.Image.arrayjoin(frames, { across: 1 });
  joined.setInt("page-height", pageHeight);
  if (delays && delays.length > 0) joined.setArrayDouble("delay", delays);
  if (loop !== undefined) joined.setInt("loop", loop);
  return joined;
}

/**
 * Execute normalized ops against one image.
 * Returns { bytes, ext, width, height } of the encoded result.
 * `fileName` stands in for the CLI's source path ({ext} resolution).
 */
export async function renderPipeline(vips, inputBytes, ops, fileName = "image.png") {
  let im = vips.Image.newFromBuffer(inputBytes);
  try {
    im = im.autorot();
  } catch {
    // loaders without orientation support: nothing to do
  }

  const pages = tryGetInt(im, "n-pages") || 1;
  const animated = pages > 1;
  const pageHeight = animated ? (tryGetInt(im, "page-height") || im.height) : im.height;
  const delays = animated ? tryGetArrayDouble(im, "delay") : null;
  const loop = animated ? tryGetInt(im, "loop") : undefined;

  const frames = animated ? splitFrames(vips, inputBytes) : [im];

  const writeOp = ops.find((op) => op.op === "write");
  const transformOps = ops.filter((op) => op.op !== "write");

  const processedFrames = await Promise.all(
    frames.map(async (frame) => {
      let out = frame;
      for (const op of transformOps) {
        switch (op.op) {
          case "resize":
            out = applyResize(out, op);
            break;
          case "crop":
            out = applyCrop(out, op);
            break;
          case "rotate":
            out = applyRotate(out, op);
            break;
          case "flip":
            out = out.flipVer();
            break;
          case "mirror":
            out = out.flipHor();
            break;
          case "grayscale":
            out = out.colourspace("b-w");
            break;
          case "adjust":
            out = applyAdjust(out, op);
            break;
          case "blur":
            out = out.gaussblur(op.sigma === null ? 0.75 : op.sigma);
            break;
          case "sharpen":
            out = op.sigma === null ? out.sharpen() : out.sharpen({ sigma: op.sigma });
            break;
      case "pad": {
        const bg = parseColor(op.color);
        const bgWithAlpha = out.hasAlpha() ? [...bg, 255] : bg;
        out = out.embed(op.size, op.size, out.width + 2 * op.size, out.height + 2 * op.size, {
          extend: "background",
          background: bgWithAlpha,
        });
        break;
      }
          case "trim":
            fail("EUNSUPPORTED", "trim is not available in the playground yet - try the CLI");
          case "normalize":
            out = out.normalize();
            break;
          case "negate":
            out = out.negate();
            break;
          case "sepia": {
            const strength = op.strength;
            if (strength !== 0) {
              out = out.colourspace("lch").linear([1, 1 + strength * 0.5, 1], [0, strength * 20, 0]).colourspace("srgb");
            }
            break;
          }
          case "level": {
            const black = op.black;
            const white = op.white;
            const gamma = op.gamma;
            const scale = 255 / (white - black);
            const offset = -black * scale;
            out = out.linear([scale, scale, scale], [offset, offset, offset]).gamma(1 / gamma);
            break;
          }
          case "median": {
            const size = op.size;
            out = size === null ? out.median() : out.median(size);
            break;
          }
          case "overlay":
            out = await applyOverlay(vips, out, op);
            break;
          case "write":
            break;
          default:
            fail("EUNKNOWN", `op '${op.op}' is not supported in the playground`);
        }
      }
      return out;
    }),
  );

  let format;
  if (writeOp == null) {
    format = animated ? ".gif" : ".png";
  } else if (writeOp.format === "source") {
    format = sourceExt(fileName);
  } else {
    const f = FORMAT_EXT[writeOp.format];
    if (!f) fail("ERUNTIME", `unknown output format '${writeOp.format}'`);
    format = f;
  }

  let final;
  if (processedFrames.length === 1) {
    final = processedFrames[0];
  } else {
    const outFmt = writeOp != null ? FORMAT_EXT[writeOp.format] : format;
    if (!ANIMATED_OUTPUT_FORMATS.has(outFmt)) {
      fail("ERUNTIME", `animated output requires gif or tiff format`);
    }
    final = joinFrames(vips, processedFrames, pageHeight, delays, loop);
  }

  const frameWidth = processedFrames[0].width;
  const frameHeight = pageHeight;

  let bytes;
  if (animated && format === ".gif") {
    // wasm-vips' gifsaveBuffer doesn't accept a `delay` option, so store
    // per-frame delays as image metadata before saving.
    final.setArrayDouble("delay", delays ?? []);
    bytes = final.gifsaveBuffer({ page_height: frameHeight });
  } else {
    const opts = {};
    if (writeOp != null) {
      if (format === ".jpg") {
        final = final.flatten({ background: parseColor(writeOp.background) });
      }
      if (writeOp.quality !== null && format !== ".png" && format !== ".gif") {
        opts.Q = writeOp.quality;
      }
      if (writeOp.lossless && (format === ".webp" || format === ".avif")) {
        opts.lossless = true;
      }
    }
    bytes = final.writeToBuffer(format, opts);
  }

  const width = animated ? frameWidth : final.width;
  const height = animated ? frameHeight : final.height;
  return { bytes, ext: format.slice(1), width, height };
}
