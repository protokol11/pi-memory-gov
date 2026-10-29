// core/retrieval.ts — the pure retrieval seam (spec-3).
//
// Trusted inbox entries only, ranked against a situation string. Read-only:
// no fs, no pi import — index.ts binds the file read. The Retriever interface
// is the seam; v1 is lexical (BM25-style). An embedding Retriever is a
// drop-in implementation and must not change the trust seam (spec-1).
import type { CaptureLine } from "./types.ts";

export interface RankedEntry {
  id: string;
  text: string;
  layer: string;
  score: number;
}

/** The fixed seam. Callers own `k`; the ranker only orders, never thresholds. */
export interface Retriever {
  topK(situation: string, k: number): RankedEntry[];
}

/** Untrusted lines are judge candidates, not memory; superseded lines are dead content. */
export function filterRetrievable(lines: CaptureLine[]): CaptureLine[] {
  const superseded = new Set(lines.map((l) => l.supersedes).filter((s): s is string => s !== null));
  return lines.filter((l) => l.trusted === true && !superseded.has(l.id));
}

const LAYER_ORDER: Record<string, number> = { user: 3, project: 2, memory: 1 };

/**
 * The one normalizer, used by both index and query sides (DRY).
 * Lowercase, alphanumeric tokens of 2+ chars — keeps "c++"/"js"-style tokens out;
 * retrieval v1 favors recall stability over token precision.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9а-яё]+/u)
    .filter((t) => t.length >= 2);
}

/** BM25-style: per-inbox idf, saturation k1, no length norm beyond average. */
export function lexicalRetriever(entries: CaptureLine[]): Retriever {
  const docs = entries.map((e) => ({ entry: e, tokens: tokenize(`${e.text} ${e.layer}`) }));
  const docFreq = new Map<string, number>();
  for (const d of docs) {
    for (const t of new Set(d.tokens)) docFreq.set(t, (docFreq.get(t) ?? 0) + 1);
  }
  const N = docs.length || 1;
  const idf = (t: string) => Math.log(1 + (N - (docFreq.get(t) ?? 0) + 0.5) / ((docFreq.get(t) ?? 0) + 0.5));
  const avgLen = docs.reduce((s, d) => s + d.tokens.length, 0) / (docs.length || 1) || 1;
  const K1 = 1.2;

  function score(situationTokens: string[], docTokens: string[]): number {
    const counts = new Map<string, number>();
    for (const t of docTokens) counts.set(t, (counts.get(t) ?? 0) + 1);
    let s = 0;
    for (const t of new Set(situationTokens)) {
      const f = counts.get(t) ?? 0;
      if (!f) continue;
      s += idf(t) * ((f * (K1 + 1)) / (f + K1 * (1 - 0.75 + (0.75 * docTokens.length) / avgLen)));
    }
    return s;
  }

  return {
    topK(situation: string, k: number): RankedEntry[] {
      const st = tokenize(situation);
      return docs
        .map((d) => ({ id: d.entry.id, text: d.entry.text, layer: d.entry.layer, score: score(st, d.tokens) }))
        .filter((r) => r.score > 0)
        .sort(
          (a, b) =>
            b.score - a.score || (LAYER_ORDER[b.layer] ?? 0) - (LAYER_ORDER[a.layer] ?? 0) || a.id.localeCompare(b.id)
        )
        .slice(0, Math.max(0, k));
    },
  };
}
