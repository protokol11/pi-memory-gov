// core/surface.ts — the merged memory surface contract (spec-9, ADR-0044).
//
// Two tools over one append-only format: `memory` writes a candidate line to
// one of two tiers, `memory_search` ranks only trusted lines. This module is
// pure: no fs, no pi import, no model. index.ts binds paths, reads and appends.
import { join } from "node:path";
import { CAPTURE_SOURCES, INBOX_FILE, buildCaptureLine } from "./capture.ts";
import type { CaptureDeps } from "./capture.ts";
import { CORPUS_FILE } from "./corpus.ts";
import { filterRetrievable, lexicalRetriever } from "./retrieval.ts";
import type { RankedEntry } from "./retrieval.ts";
import type { CaptureLine, CaptureSource } from "./types.ts";

/** The two storage tiers. A write without a tier has no address. */
export const MEMORY_LAYERS = ["user", "project"] as const;
export type MemoryLayer = (typeof MEMORY_LAYERS)[number];

/** One tool dispatches on the verb; a second schema per verb re-adds token cost. */
export const MEMORY_ACTIONS = ["save", "update", "forget"] as const;
export type MemoryAction = (typeof MEMORY_ACTIONS)[number];

/** Sources a tool may claim. `imported-hermes` exists only for the import script. */
export const TOOL_SOURCES = ["user-said", "agent-inferred", "doc-anchor"] as const;

export interface StoreLocation {
  layer: MemoryLayer;
  cwd: string;
  homeDir: string;
}

export interface StorePaths {
  inbox: string;
  corpus: string;
}

/**
 * tier=user lives under the home directory (global, shared by every repo);
 * tier=project lives inside the repository. Filenames are owned by
 * capture.ts/corpus.ts so the strings exist once.
 */
export function resolveStorePaths({ layer, cwd, homeDir }: StoreLocation): StorePaths {
  const base = layer === "user" ? join(homeDir, ".pi", "memory") : join(cwd, ".pi", "memory");
  return { inbox: join(base, INBOX_FILE), corpus: join(base, CORPUS_FILE) };
}

export interface MemoryWriteInput {
  action: MemoryAction | string;
  layer: MemoryLayer | string;
  text?: string;
  verifier?: string;
  source?: CaptureSource | string;
  supersedes?: string;
}

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** String errors, empty when valid. Unknown verbs and tiers are rejected, never coerced. */
export function validateMemoryWrite(input: MemoryWriteInput): string[] {
  const errors: string[] = [];

  if (!MEMORY_ACTIONS.includes(input.action as MemoryAction)) {
    errors.push(`action must be one of ${MEMORY_ACTIONS.join(", ")}`);
  }
  if (!MEMORY_LAYERS.includes(input.layer as MemoryLayer)) {
    errors.push(`layer must be one of ${MEMORY_LAYERS.join(", ")}`);
  }

  if (input.source !== undefined) {
    if (input.source === "imported-hermes") {
      // ADR-0044: import is a script, not a tool; a tool write must not launder
      // free-choice Markdown into the same inbox path.
      errors.push(`source "imported-hermes" cannot be written by a tool — import is a script, not a tool`);
    } else if (!CAPTURE_SOURCES.includes(input.source as CaptureSource)) {
      errors.push(`source must be one of ${TOOL_SOURCES.join(", ")}`);
    }
  }

  if (input.action === "save") {
    if (!nonEmpty(input.text)) errors.push("text must be non-empty");
    if (!nonEmpty(input.verifier)) errors.push("verifier must be non-empty — grooming needs something to check against");
  }
  if (input.action === "update") {
    if (!nonEmpty(input.supersedes)) errors.push("supersedes must name the entry being replaced");
    if (!nonEmpty(input.text)) errors.push("text must be non-empty");
  }
  if (input.action === "forget") {
    if (!nonEmpty(input.supersedes)) errors.push("supersedes must name the entry being forgotten");
  }

  return errors;
}

/** Build the append-only line. Trust is never a tool's to write (ADR-0038). */
export function buildWriteLine(input: MemoryWriteInput, deps: CaptureDeps): CaptureLine {
  const source = (input.source ?? "agent-inferred") as CaptureSource;
  const supersedes = input.action === "save" ? null : (input.supersedes ?? null);
  return buildCaptureLine(
    {
      text: input.text ?? "",
      layer: input.layer,
      verifier: input.verifier ?? "",
      source,
    },
    deps,
    supersedes
  );
}

export interface SearchRequest {
  query: string;
  k: number;
  layer?: MemoryLayer | string;
}

/**
 * Trusted-only ranking: untrusted candidates and superseded lines drop out,
 * then an optional tier filter, then lexical ranking. `k` caps; score 0 drops.
 */
export function searchTrusted(lines: CaptureLine[], { query, k, layer }: SearchRequest): RankedEntry[] {
  let candidates = filterRetrievable(lines);
  if (layer !== undefined) candidates = candidates.filter((l) => l.layer === layer);
  const cap = typeof k === "number" && Number.isFinite(k) && k > 0 ? Math.floor(k) : 0;
  if (cap === 0 || candidates.length === 0) return [];
  return lexicalRetriever(candidates).topK(query, cap);
}
