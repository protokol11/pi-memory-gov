// core/corpus.ts — the relevance feature-capture contract (spec-8).
//
// The judgment ledger stores only a state_hash, never the state (found live,
// 2026-10-14: 0 of 1145 rows carried `state`). A resolved row therefore cannot
// be turned into training features by a join alone. The trust seam records the
// features it judged in a sidecar, keyed by judgment_id; the label still comes
// from the ledger resolution. One store for decisions, one for features
// (PS-TV-04, read vs write). No model, no fs here — the impure edge appends.

import type { CorpusLine } from "./types.ts";
import type { MemoryEntry } from "./relevance.ts";

/** Sidecar filename inside <cwd>/<config-dir>/; the string exists once (DRY). */
export const CORPUS_FILE = "corpus.jsonl";

export interface CorpusDeps {
  now: () => string; // ISO timestamp
}

export interface CorpusInput {
  judgmentId: string;
  entryId: string;
  situation: string;
  entry: MemoryEntry;
}

/** Build the fixed-shape feature line for one judged (entry, situation) pair. */
export function buildCorpusLine(input: CorpusInput, deps: CorpusDeps): CorpusLine {
  return {
    judgment_id: input.judgmentId,
    entry_id: input.entryId,
    ts: deps.now(),
    situation: input.situation,
    entry: { layer: input.entry.layer, text: input.entry.text, verifier: input.entry.verifier },
  };
}

/** String errors, empty when valid. Lint before any write: a bad line costs nothing. */
export function validateCorpusLine(line: unknown): string[] {
  const errors: string[] = [];
  if (typeof line !== "object" || line === null) return ["line is not an object"];
  const l = line as Record<string, unknown>;
  if (typeof l.judgment_id !== "string" || !l.judgment_id) errors.push("judgment_id must be a non-empty string");
  if (typeof l.entry_id !== "string" || !l.entry_id) errors.push("entry_id must be a non-empty string");
  if (typeof l.ts !== "string" || !l.ts) errors.push("ts must be a non-empty string");
  if (typeof l.situation !== "string" || !l.situation.trim()) errors.push("situation must be non-empty");
  if (typeof l.entry !== "object" || l.entry === null) {
    errors.push("entry must be an object");
    return errors;
  }
  const e = l.entry as Record<string, unknown>;
  if (typeof e.layer !== "string" || !e.layer) errors.push("entry.layer must be a non-empty string");
  if (typeof e.text !== "string" || !e.text.trim()) errors.push("entry.text must be non-empty");
  if (typeof e.verifier !== "string" || !e.verifier.trim()) errors.push("entry.verifier must be non-empty");
  return errors;
}
