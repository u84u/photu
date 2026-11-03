// Type declarations for playground/completions.js
export type CompletionItem = { label: string; insertText: string };
export type SuggestionResult = {
  items: CompletionItem[];
  tokenStart: number;
  tokenEnd: number;
};
export function configure(
  commands: string[],
  commandMeta: Record<string, { flags: readonly string[]; options: Record<string, readonly string[] | null> }>,
): void;
export function getSuggestions(text: string, cursorPos: number): SuggestionResult;
