// Pipeline autocomplete for the playground. Pure (no DOM, no imports of its
// own) so it's directly testable - see test/completions.test.ts. The caller
// hands in COMMANDS/FITS/GRAVITIES via configure() rather than this module
// importing "/core/ops.js" itself, since that's a browser-only URL path
// that Node can't resolve when a test imports this file directly.
//
// Mirrors ops.ts's SPECS: which option keys and bare flags each command
// accepts, and which of those keys are a closed enum (vs free text like
// background=/color=, which get key completion but no value suggestions).
// ops.ts has no declarative schema to read this from - if a command's
// options change there, update this table too.
let COMMANDS = [];
let COMMAND_META = {};

export function configure(commands, fits, gravities) {
  COMMANDS = commands;
  COMMAND_META = {
    resize: { flags: ["upscale"], options: { fit: fits } },
    crop: { flags: [], options: { gravity: gravities } },
    rotate: { flags: [], options: { background: null } },
    flip: { flags: [], options: {} },
    mirror: { flags: [], options: {} },
    grayscale: { flags: [], options: {} },
    adjust: { flags: [], options: { brightness: null, saturation: null, hue: null } },
    blur: { flags: [], options: {} },
    sharpen: { flags: [], options: {} },
    overlay: { flags: [], options: { gravity: gravities, opacity: null } },
    pad: { flags: [], options: { color: null } },
    write: { flags: ["lossless"], options: { quality: null } },
  };
}

/** Which pipe segment (by absolute offsets) cursorPos falls in. */
function findSegment(text, cursorPos) {
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i === text.length || text[i] === "|") {
      if (cursorPos <= i || i === text.length) {
        return { segText: text.slice(start, i), segStart: start };
      }
      start = i + 1;
    }
  }
  return { segText: text.slice(start), segStart: start };
}

/** Quote-aware tokenizer that keeps each token's absolute [start, end). */
function tokenizeWithPositions(segText, segStart) {
  const tokens = [];
  let cur = "";
  let curStart = null;
  let quoted = false;
  for (let i = 0; i < segText.length; i++) {
    const ch = segText[i];
    if (ch === '"') {
      quoted = !quoted;
      if (curStart === null) curStart = segStart + i;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      if (cur) tokens.push({ text: cur, start: curStart, end: segStart + i });
      cur = "";
      curStart = null;
      continue;
    }
    if (curStart === null) curStart = segStart + i;
    cur += ch;
  }
  if (cur) tokens.push({ text: cur, start: curStart, end: segStart + segText.length });
  return tokens;
}

/** The token the cursor is editing - existing token (replace it whole) or,
 * if the cursor sits in whitespace, a fresh empty one at cursorPos. */
function currentToken(tokens, cursorPos) {
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (cursorPos >= tok.start && cursorPos <= tok.end) {
      return { partial: tok.text.slice(0, cursorPos - tok.start), start: tok.start, end: tok.end, index: i };
    }
  }
  const index = tokens.filter((t) => t.end <= cursorPos).length;
  return { partial: "", start: cursorPos, end: cursorPos, index };
}

function byPrefix(candidates, partial) {
  const p = partial.toLowerCase();
  return candidates.filter((c) => c.toLowerCase().startsWith(p));
}

/**
 * text/cursorPos -> { items: [{label, insertText}], tokenStart, tokenEnd }
 * Replacing text[tokenStart:tokenEnd] with an item's insertText applies it.
 */
export function getSuggestions(text, cursorPos) {
  const { segText, segStart } = findSegment(text, cursorPos);
  const tokens = tokenizeWithPositions(segText, segStart);
  const tok = currentToken(tokens, cursorPos);
  const empty = { items: [], tokenStart: tok.start, tokenEnd: tok.end };

  if (tok.index === 0) {
    const items = byPrefix(COMMANDS, tok.partial).map((c) => ({ label: c, insertText: `${c} ` }));
    return { items, tokenStart: tok.start, tokenEnd: tok.end };
  }

  const command = tokens[0]?.text;
  const meta = COMMAND_META[command];
  if (!meta) return empty;

  const usedKeys = new Set(
    tokens
      .filter((_, i) => i !== tok.index && i > 0)
      .map((t) => (t.text.includes("=") ? t.text.slice(0, t.text.indexOf("=")) : t.text)),
  );

  const eq = tok.partial.indexOf("=");
  if (eq !== -1) {
    const key = tok.partial.slice(0, eq);
    const valuePartial = tok.partial.slice(eq + 1);
    const enumValues = meta.options[key];
    if (!enumValues) return empty;
    const items = byPrefix(enumValues, valuePartial).map((v) => ({ label: `${key}=${v}`, insertText: `${key}=${v} ` }));
    return { items, tokenStart: tok.start, tokenEnd: tok.end };
  }

  const candidates = [
    ...Object.keys(meta.options)
      .filter((k) => !usedKeys.has(k))
      .map((k) => ({ label: `${k}=`, insertText: `${k}=` })),
    ...meta.flags.filter((f) => !usedKeys.has(f)).map((f) => ({ label: f, insertText: `${f} ` })),
  ];
  const p = tok.partial.toLowerCase();
  const items = candidates.filter((c) => c.label.toLowerCase().startsWith(p));
  return { items, tokenStart: tok.start, tokenEnd: tok.end };
}
