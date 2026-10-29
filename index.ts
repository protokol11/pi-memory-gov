// memory-gov — the merged memory surface (spec-9, ADR-0044).
//
// Two declared tools: `memory` writes a candidate line to one of two tiers,
// `memory_recall` reads trusted entries. Groom is a session_start hook. The
// extension never judges by itself; the relevance step asks the judgment
// primitive through ctx.executeTool("judge", ...) and stays undeclared.
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readFileSync } from "node:fs";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import {
  MEMORY_RELEVANCE_PREFIX,
  buildRelevanceQuestion,
  buildRelevanceState,
  countResolvedRelevanceRows,
  decideInjection,
} from "./core/relevance.ts";
import type { CorpusLine, JudgeAnswer, JudgeResult, LedgerRow } from "./core/types.ts";
import type { MemoryEntry } from "./core/relevance.ts";
import { buildCorpusLine, validateCorpusLine } from "./core/corpus.ts";
import { tokenize } from "./core/retrieval.ts";
import type { CaptureLine } from "./core/types.ts";
import { renderMemoryContext } from "./core/inject.ts";
import { buildPromotionLine, buildTrueResolutionIndex, findPromotions } from "./core/graduation.ts";
import {
  buildWriteLine,
  resolveStorePaths,
  searchTrusted,
  validateMemoryWrite,
} from "./core/surface.ts";
import type { MemoryLayer, MemoryWriteInput } from "./core/surface.ts";

/** Standard baked in by spec-1: cold start escalates until 3 resolved rows. */
export const MIN_SAMPLE = 3;
/** Default operating point; the caller may pass its own per call. */
export const DEFAULT_THRESHOLD = 0.7;
/** Groom bound: promotions per session_start pass. */
const GROOM_LIMIT = 50;
/** Judge bound: candidates judged per recall call (spec-9 decision 6). */
const JUDGE_CANDIDATE_LIMIT = 3;

let captureSeq = 0;
let groomSeq = 0;

export default function memoryGov(pi: ExtensionAPI): void {
  // --- memory: save | update | forget (spec-9 decision 1-3) ----------------
  pi.registerTool({
    name: "memory",
    label: "Memory",
    description:
      "Write a candidate memory to the user tier (~/.pi/memory/) or the project tier " +
      "(<cwd>/.pi/memory/). action=save needs text and verifier; update needs supersedes " +
      "and text; forget needs supersedes. Every write is trusted:false — trust comes only " +
      "from a judged, confirmed resolution. Returns {id, trusted, path}.",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("save"), Type.Literal("update"), Type.Literal("forget")]),
      layer: Type.Union([Type.Literal("user"), Type.Literal("project")]),
      text: Type.Optional(Type.String({ description: "The memory content (required for save/update)" })),
      verifier: Type.Optional(Type.String({ description: "How a human would confirm this entry is true" })),
      source: Type.Optional(
        Type.Union([Type.Literal("user-said"), Type.Literal("agent-inferred"), Type.Literal("doc-anchor")])
      ),
      supersedes: Type.Optional(Type.String({ description: "Entry id this line supersedes (update/forget)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionToolContext) {
      const input = params as MemoryWriteInput;
      const errors = validateMemoryWrite(input);
      if (errors.length) {
        return writeResult(null, null, `invalid memory write: ${errors.join("; ")}`);
      }
      const layer = input.layer as MemoryLayer;
      const paths = resolveStorePaths({ layer, cwd: ctx.cwd, homeDir: homedir() });
      const line = buildWriteLine(input, {
        now: () => new Date().toISOString(),
        seq: () => captureSeq++,
      });
      try {
        mkdirSync(dirname(paths.inbox), { recursive: true });
        appendFileSync(paths.inbox, JSON.stringify(line) + "\n", "utf8");
      } catch (err) {
        // PS-FIXER-03: a failed write is an error, never a swallowed capture.
        return writeResult(null, paths.inbox, `inbox not writable: ${String(err)}`);
      }
      return writeResult(line.id, paths.inbox);
    },
  });

  // --- memory_recall: trusted only, never the inbox as a trust shortcut ----
  pi.registerTool({
    name: "memory_recall",
    label: "Memory search",
    description:
      "Search trusted memories by query. Returns up to k entries {id, text, layer, score} " +
      "plus a ready-to-read context block. Untrusted candidates and superseded lines are " +
      "excluded. An optional layer narrows the result to user or project.",
    parameters: Type.Object({
      query: Type.String({ description: "What to look for" }),
      k: Type.Optional(Type.Number({ description: "Max entries returned (default 5)" })),
      layer: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("project")])),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionToolContext) {
      const query = String(params.query ?? "");
      const k = typeof params.k === "number" && params.k > 0 ? Math.floor(params.k) : 5;
      const layer = typeof params.layer === "string" ? (params.layer as MemoryLayer) : undefined;
      // Two tiers exist, so a read without a selector must span both: a user
      // preference lives nowhere near the repo you ask from. A layer parameter
      // narrows the read to that tier AND filters the ranked result.
      const tiers: MemoryLayer[] = layer ? [layer] : ["project", "user"];
      let lines: CaptureLine[] = [];
      for (const tier of tiers) {
        const paths = resolveStorePaths({ layer: tier, cwd: ctx.cwd, homeDir: homedir() });
        try {
          lines = lines.concat(readInbox(paths.inbox));
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `memory inbox unreadable: ${String(err)}` }],
            isError: true,
            details: { entries: [], context: "", error: String(err) },
          };
        }
      }
      const entries = searchTrusted(lines, { query, k, layer });
      // Internal relevance step (spec-9 decision 6): judge the best untrusted
      // candidates so the ledger and the spec-8 sidecar keep learning. Judging
      // runs after the trusted set is fixed and can never change it.
      const { judged, notes } = await judgeCandidates(ctx, lines, query, signal);
      const context = renderMemoryContext(entries);
      return {
        content: [{ type: "text" as const, text: context }],
        isError: false,
        details: { entries, context, judged, notes },
      };
    },
  });

  // --- groom is a schedule, not an interface (spec-9 decision 4) -----------
  pi.on("session_start", (_event, ctx) => {
    const configDir = join(ctx.cwd, CONFIG_DIR_NAME);
    const inboxPath = resolveStorePaths({ layer: "project", cwd: ctx.cwd, homeDir: homedir() }).inbox;
    let lines: CaptureLine[];
    try {
      lines = readInbox(inboxPath);
    } catch (err) {
      console.error(`memory groom: inbox unreadable: ${String(err)}`);
      return;
    }
    const ledgerRows = readLedger(join(configDir, "judgments.jsonl"));
    const index = buildTrueResolutionIndex(ledgerRows);
    const all = findPromotions(lines, (entryId) => index.get(entryId) ?? null);
    const promotions = all.slice(0, GROOM_LIMIT);
    for (const p of promotions) {
      const line = buildPromotionLine(
        p.entry,
        { now: () => new Date().toISOString(), seq: () => groomSeq++ },
        p.judgmentId
      );
      try {
        mkdirSync(dirname(inboxPath), { recursive: true });
        appendFileSync(inboxPath, JSON.stringify(line) + "\n", "utf8");
      } catch (err) {
        // PS-FIXER-03: name the entry that failed — no silent skip.
        console.error(`memory groom: failed promoting ${p.entry.id}: ${String(err)}`);
        return;
      }
    }
  });
}

/**
 * Relevance judging (ADR-0038, spec-9 decision 5). Not a declared tool: the
 * judgment step stays internal and is invoked with the caller's ctx.
 */
export async function runMemoryRelevance(
  ctx: ExtensionToolContext,
  params: { entryId: string; situation: string; entry: MemoryEntry; threshold?: number },
  signal?: AbortSignal
) {
  const entryId = String(params.entryId);
  const questionId = `${MEMORY_RELEVANCE_PREFIX}${entryId}`;
  const threshold = typeof params.threshold === "number" ? params.threshold : DEFAULT_THRESHOLD;

  const resolvedCount = countResolvedRelevanceRows(readLedger(join(ctx.cwd, CONFIG_DIR_NAME, "judgments.jsonl")));

  // The impure edge. A failed judge call is a fact, not a silent "no":
  // it escalates before any injection decision is made.
  let judgeResult: JudgeResult;
  try {
    const outcome = await ctx.executeTool(
      "judge",
      {
        state: buildRelevanceState(String(params.situation), params.entry),
        questions: { [questionId]: buildRelevanceQuestion(entryId) },
      },
      { signal }
    );
    const result = (outcome.result ?? {}) as {
      content?: Array<{ type: string; text?: string }>;
      details?: unknown;
    };
    const blocks = Array.isArray(result.content) ? result.content : [];
    const text = blocks.map((b) => (b && typeof b.text === "string" ? b.text : "")).join("");
    if (outcome.isError || result.details === undefined || result.details === null) {
      return relevanceResult("escalate", null, null, `judge unavailable: ${text || "no details"}`);
    }
    // The details cross a wire; a malformed payload is a fact, not a throw.
    const read = readJudgeDetails(result.details);
    if (!read.result) {
      return relevanceResult("escalate", null, null, `judge result malformed: ${read.error}`);
    }
    judgeResult = read.result;
  } catch (err) {
    return relevanceResult("escalate", null, null, `judge threw: ${String(err)}`);
  }

  const answer = judgeResult.answers[questionId];
  if (judgeResult.errors.length || !answer) {
    return relevanceResult(
      "escalate",
      null,
      null,
      `judge errors: ${judgeResult.errors.join("; ") || "no answer"}`
    );
  }
  if (typeof answer.confidence !== "number" || !Number.isFinite(answer.confidence)) {
    return relevanceResult("escalate", null, null, "judge answer malformed: confidence is not a number");
  }

  const p = answer.confidence;
  const judgmentId = judgeResult.judgment_ids[0] ?? null;
  const decision = decideInjection(p, { threshold, resolvedCount, minSample: MIN_SAMPLE });

  // Feature capture (spec-8): the ledger keeps only state_hash, so record the
  // judged features in the sidecar, keyed by judgment_id. A write failure
  // degrades training data — surface it, never swallow (PS-FIXER-03).
  let note = "";
  if (judgmentId) {
    const line = buildCorpusLine(
      { judgmentId, entryId, situation: String(params.situation), entry: params.entry },
      { now: () => new Date().toISOString() }
    );
    const lineErrors = validateCorpusLine(line);
    if (lineErrors.length) {
      note = `corpus line invalid: ${lineErrors.join("; ")}`;
    } else {
      try {
        // The sidecar belongs to the candidate's own tier: an entry's features
        // live beside the inbox that captured it (spec-9 storage lists both).
        const corpusLayer: MemoryLayer = params.entry.layer === "user" ? "user" : "project";
        const corpusPath = resolveStorePaths({ layer: corpusLayer, cwd: ctx.cwd, homeDir: homedir() }).corpus;
        mkdirSync(dirname(corpusPath), { recursive: true });
        appendFileSync(corpusPath, JSON.stringify(line) + "\n", "utf8");
      } catch (err) {
        note = `corpus not writable: ${String(err)}`;
      }
    }
  }
  return relevanceResult(decision, judgmentId, p, note);
}

/**
 * Untrusted, non-superseded lines are judge candidates, not memory. The
 * supersession rule matches filterRetrievable; trust is inverted, because a
 * line becomes memory only by being judged, never by being read.
 */
export function selectJudgeCandidates(lines: CaptureLine[], query: string, limit: number): CaptureLine[] {
  const superseded = new Set(lines.map((l) => l.supersedes).filter((s): s is string => s !== null));
  const trustedIds = new Set(lines.filter((l) => l.trusted === true).map((l) => l.id));
  const seen = new Set<string>();
  const candidates: CaptureLine[] = [];
  for (const line of lines) {
    if (line.trusted === true) continue;
    if (superseded.has(line.id)) continue;
    if (trustedIds.has(line.id)) continue;
    if (seen.has(line.id)) continue;
    seen.add(line.id);
    candidates.push(line);
  }

  // Token overlap over the query (the same v1 normalizer as the ranker).
  // Zero-overlap candidates are skipped: no signal, no judge call.
  const queryTokens = new Set(tokenize(query));
  if (queryTokens.size === 0) return [];
  return candidates
    .map((line) => {
      const tokens = new Set(tokenize(line.text));
      let hits = 0;
      for (const t of queryTokens) if (tokens.has(t)) hits++;
      return { line, score: hits / queryTokens.size };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.line.id.localeCompare(b.line.id))
    .slice(0, Math.max(0, limit))
    .map((s) => s.line);
}

/**
 * The judge's `details` is an untyped wire payload. Normalize what we need and
 * name what is missing, so a garbage response escalates instead of throwing
 * out of the relevance step (PS-FIXER-03: report, never crash).
 */
function readJudgeDetails(details: unknown): { result: JudgeResult | null; error: string } {
  if (typeof details !== "object" || details === null) {
    return { result: null, error: "details is not an object" };
  }
  const d = details as Record<string, unknown>;
  if (typeof d.answers !== "object" || d.answers === null) {
    return { result: null, error: "details.answers is missing" };
  }
  if (!Array.isArray(d.errors)) {
    return { result: null, error: "details.errors is missing" };
  }
  return {
    result: {
      answers: d.answers as Record<string, JudgeAnswer>,
      judgment_ids: Array.isArray(d.judgment_ids) ? (d.judgment_ids as string[]) : [],
      errors: d.errors as string[],
    },
    error: "",
  };
}

/** Dedup key for one judged pair. The situation is part of it on purpose. */
function corpusKey(entryId: string, situation: string): string {
  return `${entryId}\u0000${situation}`;
}

/**
 * Which (entry, situation) pairs already have features. Both tier sidecars are
 * read because an entry's features live in its own tier. An unreadable or
 * absent sidecar degrades to "nothing judged yet": dedup must never block
 * recall, and the dedup key cannot be the ledger's question_id — that carries
 * the entry id only, so it would forbid judging the same entry against a new,
 * narrower situation, which is how the corpus is meant to grow.
 */
function readJudgedPairs(ctx: ExtensionToolContext): Set<string> {
  const pairs = new Set<string>();
  for (const layer of ["project", "user"] as MemoryLayer[]) {
    const corpusPath = resolveStorePaths({ layer, cwd: ctx.cwd, homeDir: homedir() }).corpus;
    let text: string;
    try {
      text = readFileSync(corpusPath, "utf8");
    } catch {
      continue; // missing or unreadable sidecar: judge anyway
    }
    for (const row of parseJsonl(text)) {
      const r = row as Partial<CorpusLine> | null;
      if (typeof r?.entry_id === "string" && typeof r.situation === "string") {
        pairs.add(corpusKey(r.entry_id, r.situation));
      }
    }
  }
  return pairs;
}

export interface JudgedCandidate {
  entry_id: string;
  decision: string;
  judgment_id: string | null;
  p: number | null;
  note: string;
}

/**
 * Judge the top candidates on the retrieval path. This is feature capture, not
 * recall: a judge failure, a cold-start escalation or an unwritable sidecar is
 * reported in `notes` and never raised (PS-FIXER-03).
 */
async function judgeCandidates(
  ctx: ExtensionToolContext,
  lines: CaptureLine[],
  query: string,
  signal?: AbortSignal
): Promise<{ judged: JudgedCandidate[]; notes: string[] }> {
  const judged: JudgedCandidate[] = [];
  const notes: string[] = [];
  // A function, not a property read: TS would narrow `signal.aborted` to false
  // across the loop and lose the mid-call abort.
  const aborted = (): boolean => signal?.aborted === true;
  const alreadyJudged = readJudgedPairs(ctx);
  // Select without the cap, drop pairs that already have features, then cap: the
  // bound is on judge calls actually spent, not on candidates considered.
  const candidates = selectJudgeCandidates(lines, query, lines.length)
    .filter((candidate) => !alreadyJudged.has(corpusKey(candidate.id, query)))
    .slice(0, JUDGE_CANDIDATE_LIMIT);
  for (const candidate of candidates) {
    if (aborted()) break; // the caller withdrew before this candidate
    try {
      const outcome = await runMemoryRelevance(
        ctx,
        {
          entryId: candidate.id,
          situation: query,
          entry: { layer: candidate.layer, text: candidate.text, verifier: candidate.verifier },
        },
        signal
      );
      const { decision, judgment_id, p, note } = outcome.details;
      if (aborted()) {
        // Aborting mid-call reads as a judge failure inside runMemoryRelevance;
        // keep the real decision, label the abort honestly, and stop paying for
        // calls nobody waits on.
        const abortNote = note.includes("judge threw") ? "judging aborted" : note;
        judged.push({ entry_id: candidate.id, decision, judgment_id, p, note: abortNote });
        if (abortNote) notes.push(`${candidate.id}: ${abortNote}`);
        notes.push(`${candidate.id}: judging aborted — remaining candidates skipped`);
        break;
      }
      judged.push({ entry_id: candidate.id, decision, judgment_id, p, note });
      if (note) notes.push(`${candidate.id}: ${note}`);
    } catch (err) {
      if (aborted()) {
        // An abort is the caller withdrawing, not a judge failure: stop paying
        // for calls nobody waits on, and keep the recall result intact.
        judged.push({
          entry_id: candidate.id,
          decision: "escalate",
          judgment_id: null,
          p: null,
          note: "judging aborted",
        });
        notes.push(`${candidate.id}: judging aborted — remaining candidates skipped`);
        break;
      }
      const note = `judge threw: ${String(err)}`;
      judged.push({ entry_id: candidate.id, decision: "escalate", judgment_id: null, p: null, note });
      notes.push(`${candidate.id}: ${note}`);
    }
  }
  return { judged, notes };
}

function writeResult(id: string | null, path: string | null, error: string | null = null) {
  if (error) {
    return {
      content: [{ type: "text" as const, text: error }],
      isError: true,
      details: { id: null, trusted: false as const, path: null, error },
    };
  }
  return {
    content: [{ type: "text" as const, text: `captured ${id}` }],
    isError: false,
    details: { id, trusted: false as const, path, error: null },
  };
}

/**
 * Parse the inbox. A missing file is an empty pipeline (cold start, not an
 * error); any other read failure throws, so callers can distinguish
 * "nothing trusted" from "cannot read" (PS-FIXER-03).
 */
function readInbox(inboxPath: string): CaptureLine[] {
  let text: string;
  try {
    text = readFileSync(inboxPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return parseJsonl(text) as CaptureLine[];
}

/** Parse the judgment ledger; missing or corrupt rows are skipped, not fatal. */
function readLedger(ledgerPath: string): LedgerRow[] {
  try {
    return parseJsonl(readFileSync(ledgerPath, "utf8")) as LedgerRow[];
  } catch {
    return [];
  }
}

function parseJsonl(text: string): unknown[] {
  const rows: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // a corrupt line is skipped; grooming owns repair
    }
  }
  return rows;
}

function relevanceResult(decision: string, judgmentId: string | null, p: number | null, note = "") {
  const base =
    decision === "escalate"
      ? `memory relevance: escalate`
      : `memory relevance: ${decision} (p=${p?.toFixed(3)}, judgment_id=${judgmentId})`;
  const text = note ? `${base} (${note})` : base;
  return {
    content: [{ type: "text" as const, text }],
    isError: false,
    details: { decision, judgment_id: judgmentId, p, note },
  };
}
