// Type declarations for playground/exec-wasm.js
export class ExecError extends Error {
  constructor(code: string, message: string);
  code: string;
}
export function parseColor(str: string): [number, number, number];
export function renderPipeline(
  vips: unknown,
  inputBytes: Uint8Array | Buffer,
  ops: { op: string; [key: string]: unknown }[],
  fileName?: string,
): { bytes: Uint8Array; ext: string; width: number; height: number };
