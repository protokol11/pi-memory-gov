// core/inject.ts — the pure injection seam (spec-4).
//
// Renders recalled trusted entries as the block the model reads. No fs, no
// pi import; index.ts binds recall + this render. The block carries layer and
// id per entry so a stale entry is traceable to its inbox line.
import type { RankedEntry } from "./retrieval.ts";

export const MEMORY_CONTEXT_HEADER = "Trusted memory for this situation:";
export const EMPTY_MEMORY_CONTEXT = "No trusted memory for this situation.";

/** One line per entry: `- [<layer>] <text> (id: <id>)`. Empty → fixed sentence. */
export function renderMemoryContext(entries: RankedEntry[]): string {
  if (entries.length === 0) return EMPTY_MEMORY_CONTEXT;
  const lines = entries.map((e) => `- [${e.layer}] ${e.text} (id: ${e.id})`);
  return [MEMORY_CONTEXT_HEADER, ...lines].join("\n");
}
