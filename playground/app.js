// photu playground: parses the typed pipeline with the SAME core modules
// the CLI ships (dist/core), then executes the normalized ops with
// wasm-vips. Validation, defaults, and error messages are identical to
// the terminal experience by construction.

import Vips from "/vips/vips-es6.js";
import { normalizeOp } from "/core/ops.js";
import { newPlan, serializePlan, Panic } from "/core/plan.js";
import { renderPipeline, ExecError } from "/exec-wasm.js";

const $ = (id) => document.getElementById(id);
const status = $("status");
const errorBox = $("error");
const planBox = $("plan");

let vips = null;
let inputBytes = null;
let inputName = "image.png";
let beforeURL = null;
let afterURL = null;

const NOT_HERE = {
  read: "the dropped image is your `read` - just type the transforms",
  info: "info is a CLI utility - the before/after panes show it here",
  explain: "the plan box below is a permanent `explain`",
  formats: "this playground writes jpeg, png, webp, gif, tiff, avif",
};

function tokenize(text) {
  const tokens = [];
  let cur = "";
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (cur) tokens.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function parsePipeline(text) {
  const ops = [];
  for (const segment of text.split("|")) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;
    const [command, ...rest] = tokens;
    if (command in NOT_HERE) {
      throw new Panic("EBADARG", `${command}: ${NOT_HERE[command]}`);
    }
    ops.push(normalizeOp(command, rest));
  }
  return ops;
}

function showError(message) {
  errorBox.textContent = `photu: ${message}`;
  errorBox.style.display = "block";
  $("after").removeAttribute("src");
  $("after-meta").textContent = "";
  $("download").style.display = "none";
}

function clearError() {
  errorBox.style.display = "none";
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderPlanBox(ops) {
  const plan = newPlan([inputName]);
  plan.ops = ops;
  planBox.innerHTML = "";
  const b = document.createElement("b");
  b.textContent = "on the pipe: ";
  planBox.append(b, serializePlan(plan).trimEnd());
}

function outputName(ops) {
  const write = ops.find((op) => op.op === "write");
  const dot = inputName.lastIndexOf(".");
  const name = dot > 0 ? inputName.slice(0, dot) : inputName;
  const ext = dot > 0 ? inputName.slice(dot + 1) : "";
  if (!write) return `${name}.png`;
  const rendered = write.template
    .replaceAll("{name}", name)
    .replaceAll("{ext}", ext)
    .replaceAll("{i}", "1");
  return rendered.slice(rendered.lastIndexOf("/") + 1);
}

function run() {
  if (!vips || !inputBytes) return;
  let ops;
  try {
    ops = parsePipeline($("pipeline").value);
  } catch (err) {
    if (err instanceof Panic) return showError(err.message);
    throw err;
  }
  clearError();
  renderPlanBox(ops);
  try {
    const t0 = performance.now();
    const result = renderPipeline(vips, inputBytes, ops, inputName);
    const ms = Math.round(performance.now() - t0);
    const blob = new Blob([result.bytes], { type: `image/${result.ext === "jpg" ? "jpeg" : result.ext}` });
    if (afterURL) URL.revokeObjectURL(afterURL);
    afterURL = URL.createObjectURL(blob);
    $("after").src = afterURL;
    $("after-meta").textContent =
      `${result.width}x${result.height} · ${result.ext} · ${human(result.bytes.length)} · ${ms} ms`;
    const dl = $("download");
    dl.href = afterURL;
    dl.download = outputName(ops);
    dl.style.display = "inline";
  } catch (err) {
    if (err instanceof ExecError || err instanceof Panic) return showError(err.message);
    showError(`libvips: ${err.message}`);
  }
}

async function setImage(bytes, name) {
  inputBytes = new Uint8Array(bytes);
  inputName = name;
  const blob = new Blob([inputBytes]);
  if (beforeURL) URL.revokeObjectURL(beforeURL);
  beforeURL = URL.createObjectURL(blob);
  const img = $("before");
  img.src = beforeURL;
  await img.decode().catch(() => {});
  $("before-meta").textContent =
    `${name} · ${img.naturalWidth}x${img.naturalHeight} · ${human(inputBytes.length)}`;
  run();
}

function makeSample() {
  const c = document.createElement("canvas");
  c.width = 1200;
  c.height = 800;
  const g = c.getContext("2d");
  const grad = g.createLinearGradient(0, 0, 1200, 800);
  grad.addColorStop(0, "#ff8c42");
  grad.addColorStop(0.5, "#c04cfd");
  grad.addColorStop(1, "#2d9cdb");
  g.fillStyle = grad;
  g.fillRect(0, 0, 1200, 800);
  for (let i = 0; i < 24; i++) {
    g.beginPath();
    g.arc(80 + (i % 8) * 150, 140 + Math.floor(i / 8) * 260, 46, 0, Math.PI * 2);
    g.fillStyle = `hsla(${i * 15}, 85%, 65%, 0.85)`;
    g.fill();
  }
  g.fillStyle = "rgba(255,255,255,0.92)";
  g.font = "bold 110px system-ui, sans-serif";
  g.fillText("photu ફોટુ", 340, 430);
  c.toBlob(async (blob) => setImage(await blob.arrayBuffer(), "sample.jpg"), "image/jpeg", 0.92);
}

// --- wiring -----------------------------------------------------------

const drop = $("drop");
drop.addEventListener("click", (e) => {
  if (e.target.id !== "sample") $("file").click();
});
$("file").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (f) setImage(await f.arrayBuffer(), f.name);
});
$("sample").addEventListener("click", makeSample);
for (const ev of ["dragover", "dragenter"]) {
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.add("hover");
  });
}
for (const ev of ["dragleave", "drop"]) {
  drop.addEventListener(ev, (e) => {
    e.preventDefault();
    drop.classList.remove("hover");
  });
}
drop.addEventListener("drop", async (e) => {
  const f = e.dataTransfer.files[0];
  if (f) setImage(await f.arrayBuffer(), f.name);
});

let timer = null;
$("pipeline").addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(run, 300);
});

try {
  vips = await Vips();
  status.textContent = `libvips ${vips.version(0)}.${vips.version(1)}.${vips.version(2)} ready - drop an image to start`;
  status.classList.add("ready");
  run();
} catch (err) {
  status.textContent = `failed to load libvips wasm: ${err.message}`;
}
