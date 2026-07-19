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

const FORMAT_EXT = {
  jpeg: ".jpg",
  png: ".png",
  webp: ".webp",
  gif: ".gif",
  tiff: ".tif",
  avif: ".avif",
};

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

/**
 * Execute normalized ops against one image.
 * Returns { bytes, ext, width, height } of the encoded result.
 * `fileName` stands in for the CLI's source path ({ext} resolution).
 */
export function renderPipeline(vips, inputBytes, ops, fileName = "image.png") {
  let im = vips.Image.newFromBuffer(inputBytes);
  try {
    im = im.autorot();
  } catch {
    // loaders without orientation support: nothing to do
  }

  let write = null;
  for (const op of ops) {
    switch (op.op) {
      case "resize":
        im = applyResize(im, op);
        break;
      case "crop":
        im = applyCrop(im, op);
        break;
      case "rotate":
        im = applyRotate(im, op);
        break;
      case "flip":
        im = im.flipVer();
        break;
      case "mirror":
        im = im.flipHor();
        break;
      case "grayscale":
        im = im.colourspace("b-w");
        break;
      case "adjust":
        im = applyAdjust(im, op);
        break;
      case "blur":
        im = im.gaussblur(op.sigma === null ? 0.75 : op.sigma);
        break;
      case "sharpen":
        im = op.sigma === null ? im.sharpen() : im.sharpen({ sigma: op.sigma });
        break;
      case "pad": {
        const bg = parseColor(op.color);
        im = im.embed(op.size, op.size, im.width + 2 * op.size, im.height + 2 * op.size, {
          extend: "background",
          background: bg,
        });
        break;
      }
      case "overlay":
        fail("EUNSUPPORTED", "overlay is not available in the playground yet - try the CLI");
        break;
      case "write":
        write = op;
        break;
      default:
        fail("EUNKNOWN", `op '${op.op}' is not supported in the playground`);
    }
  }

  const format = write === null || write.format === "source"
    ? (write === null ? ".png" : sourceExt(fileName))
    : FORMAT_EXT[write.format];

  const opts = {};
  if (write !== null) {
    if (format === ".jpg") {
      im = im.flatten({ background: parseColor(write.background) });
    }
    if (write.quality !== null && format !== ".png" && format !== ".gif") {
      opts.Q = write.quality;
    }
    if (write.lossless && (format === ".webp" || format === ".avif")) {
      opts.lossless = true;
    }
  }

  const width = im.width;
  const height = im.height;
  const bytes = im.writeToBuffer(format, opts);
  return { bytes, ext: format.slice(1), width, height };
}
