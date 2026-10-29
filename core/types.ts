// Minimal question/record shapes, copied structurally from the judgment
// extension. memory-gov must not import judgment internals (ADR-0038); these
// types are the wire contract only.
export interface Question {
  type: "noul" | "choice" | "score";
  instructions: string;
  criteria?: string[] | Record<string, string>;
}

export interface JudgeAnswer {
  value: string;
  confidence: number;
}

export interface JudgeResult {
  answers: Record<string, JudgeAnswer>;
  judgment_ids: string[];
  errors: string[];
}

export interface LedgerRow {
  kind?: string;
  judgment_id?: string;
  question_id?: string;
  outcome?: boolean | null;
}

export type CaptureSource = "user-said" | "agent-inferred" | "doc-anchor" | "imported-hermes";

export interface CaptureLine {
  id: string;
  ts: string;
  text: string;
  layer: string;
  verifier: string;
  source: CaptureSource;
  trusted: boolean;
  judgment_id: string | null;
  supersedes: string | null;
}

/**
 * One judged (entry, situation) pair's features (spec-8). Written to the
 * memory-gov sidecar, keyed by judgment_id; the ledger holds only the
 * decision and its resolution. The entry shape is inline, not `MemoryEntry`,
 * to keep this wire module free of the relevance module (no cycle).
 */
export interface CorpusLine {
  judgment_id: string;
  entry_id: string;
  ts: string;
  situation: string;
  entry: { layer: string; text: string; verifier: string };
}
