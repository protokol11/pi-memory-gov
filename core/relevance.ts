// core/relevance.ts — the pure memory-relevance contract (ADR-0038).
//
// One typed noul question per candidate entry, id `memory-relevance:<entry-id>`.
// The client consumes only `p` and `judgment_id` from the judge answer and owns
// its own threshold and cold-start rule. No model, no fs, no pi import: the
// impure edge lives in index.ts.
import type { LedgerRow, Question } from "./types.ts";

/** Question-id prefix that marks the memory-relevance family. */
export const MEMORY_RELEVANCE_PREFIX = "memory-relevance:";

export function isMemoryRelevanceQuestion(id: string): boolean {
  return id.startsWith(MEMORY_RELEVANCE_PREFIX);
}

/** All-or-nothing, mirroring the cp-review routing predicate. */
export function isMemoryRelevanceRequest(questions: Record<string, { type: string }>): boolean {
  const ids = Object.keys(questions);
  return ids.length > 0 && ids.every(isMemoryRelevanceQuestion);
}

/** The one question asked for a candidate entry. */
export function buildRelevanceQuestion(entryId: string): Question {
  return {
    type: "noul",
    instructions:
      `A candidate memory entry "${entryId}" was captured. Judge whether it is relevant ` +
      "to the current situation described in the state: would recalling this entry now " +
      "change what the agent does or how it interprets the request? yes/no with probability.",
    criteria: ["yes", "no"],
  };
}

export interface MemoryEntry {
  layer: string;
  text: string;
  verifier: string;
}

/** Trust and retrieval must not share a feature shape with cp-review. */
export function buildRelevanceState(situation: string, entry: MemoryEntry): { situation: string; entry: MemoryEntry } {
  return { situation, entry };
}

/**
 * Cold-start count: resolution rows joined to memory-relevance judgments by
 * judgment_id. Resolution rows carry no question_id, so a naive prefix count
 * is always zero — a perpetual cold start (found live, 2026-10-11).
 */
export function countResolvedRelevanceRows(
  rows: Array<Partial<Pick<LedgerRow, "kind" | "judgment_id" | "question_id" | "outcome">>>
): number {
  const family = new Set(
    rows.filter((r) => r.kind === "judgment" && r.question_id?.startsWith(MEMORY_RELEVANCE_PREFIX)).map((r) => r.judgment_id)
  );
  return rows.filter((r) => r.kind === "resolution" && family.has(r.judgment_id)).length;
}

export type InjectionDecision = "inject" | "silent" | "escalate";

/**
 * Caller-owned operating point. Cold start (below minSample resolved rows)
 * escalates — never inject, never silent: a thin bucket makes `p` noise
 * (ADR-0033, matches decide() in judgment core/policy.ts).
 */
export function decideInjection(
  p: number,
  opts: { threshold: number; resolvedCount: number; minSample: number }
): InjectionDecision {
  if (opts.resolvedCount < opts.minSample) return "escalate";
  return p >= opts.threshold ? "inject" : "silent";
}
