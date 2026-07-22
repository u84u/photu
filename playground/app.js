// photu playground: parses the typed pipeline with the SAME core modules
// the CLI ships (dist/core), then executes the normalized ops with
// wasm-vips. Validation, defaults, and error messages are identical to
// the terminal experience by construction.

import Vips from "/vips/vips-es6.js";
import { normalizeOp, COMMANDS } from "/core/ops.js";
import { newPlan, errorPlan, isErrorPlan, serializePlan, Panic } from "/core/plan.js";
import { renderPipeline, ExecError } from "/exec-wasm.js";
import { COMMAND_META } from "/core/completion-meta.js";
import { configure as configureCompletions, getSuggestions } from "/completions.js";

configureCompletions(COMMANDS, COMMAND_META);

const $ = (id) => document.getElementById(id);
const status = $("status");
const errorBox = $("error");
const planBox = $("plan");
const pipelineInput = $("pipeline");
const suggestBox = $("suggest");

let vips = null;
let inputBytes = null;
let inputName = "image.png";
let beforeURL = null;
let afterURL = null;

const NOT_HERE = {
  read: "there is no read here; the image you dropped is the input",
  info: "info is not available in the playground",
  explain: "the plan is already shown below the images",
  formats: "the playground writes jpeg, png, webp, gif, tiff and avif",
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
  const segments = text.split("|");
  for (let i = 0; i < segments.length; i++) {
    const tokens = tokenize(segments[i]);
    if (tokens.length === 0) {
      // A trailing "|" is someone mid-typing; an empty stage anywhere
      // else is a leftover the shell would reject too.
      if (i === segments.length - 1) continue;
      const err = new Panic("EBADARG", "empty stage between pipes - remove the extra '|'");
      err.stage = "photu";
      throw err;
    }
    const [command, ...rest] = tokens;
    try {
      if (command in NOT_HERE) {
        throw new Panic("EBADARG", `${command}: ${NOT_HERE[command]}`);
      }
      ops.push(normalizeOp(command, rest));
    } catch (err) {
      if (err instanceof Panic) err.stage = command;
      throw err;
    }
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

let planMode = "wire";
let lastPlan = null;

function explainText(plan) {
  const lines = [`photu plan (protocol ${plan.photu})`];
  if (isErrorPlan(plan)) {
    lines.push(`ERROR in stage '${plan.error.stage}' [${plan.error.code}]: ${plan.error.message}`);
  } else {
    lines.push(`files (${plan.files.length}):`);
    for (const f of plan.files) lines.push(`  ${f}`);
    lines.push(`ops (${plan.ops.length}):`);
    plan.ops.forEach((op, i) => {
      const args = Object.entries(op)
        .filter(([k]) => k !== "op")
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(" ");
      lines.push(`  ${i + 1}. ${op.op}${args ? "  " + args : ""}`);
    });
  }
  return lines.join("\n");
}

function drawPlan() {
  if (lastPlan === null) return;
  planBox.textContent =
    planMode === "wire" ? serializePlan(lastPlan).trimEnd() : explainText(lastPlan);
}

function renderPlanBox(ops) {
  const plan = newPlan([inputName]);
  plan.ops = ops;
  lastPlan = plan;
  drawPlan();
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
    if (err instanceof Panic) {
      lastPlan = errorPlan(err.stage ?? "photu", err.code, err.message);
      drawPlan();
      return showError(err.message);
    }
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
pipelineInput.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(run, 300);
});

// --- autocomplete -------------------------------------------------------

let suggestItems = [];
let suggestRange = null;
let suggestIndex = -1;

function renderSuggest() {
  suggestBox.innerHTML = "";
  suggestBox.classList.toggle("open", suggestItems.length > 0);
  suggestItems.forEach((item, i) => {
    const li = document.createElement("li");
    li.textContent = item.label;
    li.classList.toggle("active", i === suggestIndex);
    // mousedown (not click) fires before the input's blur, so selecting a
    // suggestion never steals focus away from the pipeline field first.
    li.addEventListener("mousedown", (e) => {
      e.preventDefault();
      acceptSuggestion(i);
    });
    suggestBox.appendChild(li);
  });
}

function closeSuggest() {
  suggestItems = [];
  suggestIndex = -1;
  renderSuggest();
}

function updateSuggestions() {
  const { items, tokenStart, tokenEnd } = getSuggestions(pipelineInput.value, pipelineInput.selectionStart);
  suggestItems = items;
  suggestRange = { tokenStart, tokenEnd };
  suggestIndex = -1;
  renderSuggest();
}

function acceptSuggestion(i) {
  const item = suggestItems[i];
  if (!item || !suggestRange) return;
  const { tokenStart, tokenEnd } = suggestRange;
  const value = pipelineInput.value;
  pipelineInput.value = value.slice(0, tokenStart) + item.insertText + value.slice(tokenEnd);
  const cursor = tokenStart + item.insertText.length;
  pipelineInput.setSelectionRange(cursor, cursor);
  closeSuggest();
  pipelineInput.focus();
  pipelineInput.dispatchEvent(new Event("input"));
}

const SUGGEST_KEYDOWN_KEYS = ["Escape", "Enter", "Tab", "ArrowUp", "ArrowDown"];
for (const ev of ["input", "click", "keyup"]) {
  pipelineInput.addEventListener(ev, (e) => {
    // Escape/Enter/Tab/Arrow* are handled in keydown below - re-running
    // suggestions on their keyup would re-open a dropdown just closed.
    if (ev === "keyup" && SUGGEST_KEYDOWN_KEYS.includes(e.key)) return;
    updateSuggestions();
  });
}
pipelineInput.addEventListener("keydown", (e) => {
  if (suggestItems.length === 0) return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    suggestIndex = (suggestIndex + 1) % suggestItems.length;
    renderSuggest();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    suggestIndex = (suggestIndex - 1 + suggestItems.length) % suggestItems.length;
    renderSuggest();
  } else if (e.key === "Enter" || e.key === "Tab") {
    e.preventDefault();
    acceptSuggestion(suggestIndex === -1 ? 0 : suggestIndex);
  } else if (e.key === "Escape") {
    closeSuggest();
  }
});
pipelineInput.addEventListener("blur", closeSuggest);

for (const mode of ["wire", "explain"]) {
  $(`mode-${mode}`).addEventListener("click", () => {
    planMode = mode;
    $("mode-wire").classList.toggle("on", mode === "wire");
    $("mode-explain").classList.toggle("on", mode === "explain");
    drawPlan();
  });
}

try {
  // heif = avif support, resvg = svg input. Skipping the jxl module
  // saves ~2 MB of transfer; the playground never advertised jxl.
  vips = await Vips({ dynamicLibraries: ["vips-heif.wasm", "vips-resvg.wasm"] });
  status.textContent = `libvips ${vips.version(0)}.${vips.version(1)}.${vips.version(2)} loaded`;
  status.classList.add("ready");
  run();
} catch (err) {
  status.textContent = `failed to load libvips wasm: ${err.message}`;
}
