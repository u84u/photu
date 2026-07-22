// Shared metadata for autocomplete - the playground's pipeline input and
// the CLI's bash completions both need "which option keys and bare flags
// does this command accept, and which of those keys are a closed enum" and
// neither can get that from ops.ts's SPECS, which parses each stage
// imperatively rather than describing it declaratively. This is the one
// place that mirrors it - update it alongside any change to SPECS.

import { FITS, GRAVITIES } from "./ops.ts";

/** An option's allowed values, or null for free text (e.g. background=,
 * color=) which gets key completion but no value suggestions. */
export type OptionMeta = readonly string[] | null;

export type CommandMeta = {
  flags: readonly string[];
  options: Record<string, OptionMeta>;
};

export const COMMAND_META: Record<string, CommandMeta> = {
  resize: { flags: ["upscale"], options: { fit: FITS } },
  crop: { flags: [], options: { gravity: GRAVITIES } },
  rotate: { flags: [], options: { background: null } },
  flip: { flags: [], options: {} },
  mirror: { flags: [], options: {} },
  grayscale: { flags: [], options: {} },
  adjust: { flags: [], options: { brightness: null, saturation: null, hue: null } },
  blur: { flags: [], options: {} },
  sharpen: { flags: [], options: {} },
  overlay: { flags: [], options: { gravity: GRAVITIES, opacity: null } },
  pad: { flags: [], options: { color: null } },
  write: { flags: ["lossless"], options: { quality: null } },
};
