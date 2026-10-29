// core/graduation.ts — the pure graduation rule (spec-5).
//
// Which untrusted entries have earned trust: a confirming resolution
// (outcome: true) for their memory-relevance question in the judgment ledger.
// Deterministic — no model here. The impure edge (ledger/inbox reads, the
// superseding append) lives in index.ts.
import { MEMORY_RELEVANCE_PREFIX } from "./relevance.ts";
import type { CaptureLine, LedgerRow } from "./types.ts";

export interface Promotion {
  entry: CaptureLine;
  judgmentId: string;
}

/**
 * Promotion rule: untrusted, non-superseded inbox line + a true resolution
 * for `memory-relevance:<entry-id>` in the ledger. `hasTrueResolution` is
 * injected so the rule is testable with a stub.
 */
export function findPromotions(
  lines: CaptureLine[],
  hasTrueResolution: (entryId: string) => { judgmentId: string } | null
): Promotion[] {
  const superseded = new Set(lines.map((l) => l.supersedes).filter((s): s is string => s !== null));
  const promotions: Promotion[] = [];
  for (const line of lines) {
    if (line.trusted !== false || superseded.has(line.id)) continue;
    const hit = hasTrueResolution(line.id);
    if (hit) promotions.push({ entry: line, judgmentId: hit.judgmentId });
  }
  return promotions;
}

/** The promoted line: same content, trusted, carrying its resolution link. */
export function buildPromotionLine(
  line: CaptureLine,
  deps: { now: () => string; seq: () => number },
  judgmentId: string
): CaptureLine {
  const ts = deps.now();
  return {
    ...line,
    id: `${ts}-${deps.seq()}`,
    ts,
    trusted: true,
    judgment_id: judgmentId,
    supersedes: line.id,
  };
}

/** Ledger rows → the entry ids that hold a true resolution, with the judgment id. */
export function buildTrueResolutionIndex(rows: LedgerRow[]): Map<string, { judgmentId: string }> {
  const resolved = new Map<string, { judgmentId: string; outcome: boolean }>();
  for (const row of rows) {
    if (row.kind !== "resolution" || row.outcome !== true || !row.judgment_id) continue;
    resolved.set(row.judgment_id, { judgmentId: row.judgment_id, outcome: true });
  }
  const index = new Map<string, { judgmentId: string }>();
  for (const row of rows) {
    if (row.kind !== "judgment" || row.outcome !== null || !row.question_id) continue;
    if (!resolved.has(row.judgment_id ?? "")) continue;
    const entryId = row.question_id.startsWith(MEMORY_RELEVANCE_PREFIX)
      ? row.question_id.slice(MEMORY_RELEVANCE_PREFIX.length)
      : null;
    if (entryId && !index.has(entryId)) index.set(entryId, { judgmentId: row.judgment_id! });
  }
  return index;
}
