// core/capture.ts — the pure capture contract (spec-2).
//
// Capture is a fact, not a decision: build the line, validate it, let the
// impure edge append it. No model, no judge here — trust is spec-1's seam.
// The inbox is append-only; corrections are new lines that supersede by id.

import type { CaptureLine, CaptureSource } from "./types.ts";

/** Inbox filename inside <cwd>/<config-dir>/; the string exists once (DRY). */
export const INBOX_FILE = "inbox.jsonl";

export const CAPTURE_SOURCES: readonly CaptureSource[] = [
  "user-said",
  "agent-inferred",
  "doc-anchor",
  "imported-hermes",
];

export interface CaptureInput {
  text: string;
  layer: string;
  verifier: string;
  source: CaptureSource;
}

export interface CaptureDeps {
  now: () => string; // ISO timestamp
  seq: () => number; // per-process counter for collision-free ids
}

/** Build the fixed-shape inbox line. `trusted` always starts false — only the
 * trust seam / resolution path may flip it (HUMAN-JUDGMENT-FINAL). */
export function buildCaptureLine(
  input: CaptureInput,
  deps: CaptureDeps,
  supersedes: string | null = null
): CaptureLine {
  const ts = deps.now();
  return {
    id: `${ts}-${deps.seq()}`,
    ts,
    text: input.text,
    layer: input.layer,
    verifier: input.verifier,
    source: input.source,
    trusted: false,
    judgment_id: null,
    supersedes,
  };
}

/** String errors, empty when valid. Lint before any write: a bad line costs nothing. */
export function validateCaptureLine(line: unknown): string[] {
  const errors: string[] = [];
  if (typeof line !== "object" || line === null) return ["line is not an object"];
  const l = line as Record<string, unknown>;
  if (typeof l.id !== "string" || !l.id) errors.push("id must be a non-empty string");
  if (typeof l.ts !== "string" || !l.ts) errors.push("ts must be a non-empty string");
  if (typeof l.text !== "string" || !l.text.trim()) errors.push("text must be non-empty");
  if (typeof l.layer !== "string" || !l.layer) errors.push("layer must be a non-empty string");
  if (typeof l.verifier !== "string" || !l.verifier.trim())
    errors.push("verifier must be non-empty — grooming needs something to check against");
  if (!CAPTURE_SOURCES.includes(l.source as CaptureSource))
    errors.push(`source must be one of ${CAPTURE_SOURCES.join(", ")}`);
  if (l.trusted !== false) errors.push("trusted must start false; the trust seam flips it");
  if (l.judgment_id !== null) errors.push("judgment_id starts null until the trust seam judges it");
  if (l.supersedes !== null && typeof l.supersedes !== "string")
    errors.push("supersedes must be null or an entry id");
  return errors;
}

export function validateCaptureInput(input: CaptureInput): string[] {
  return validateCaptureLine({ ...input, id: "x", ts: "x", trusted: false, judgment_id: null, supersedes: null });
}
