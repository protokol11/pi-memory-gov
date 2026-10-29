// Run: node --test test/corpus.test.mjs
// Feature capture (spec-8): the trust seam records judged features in a
// sidecar keyed by judgment_id, because the ledger keeps only state_hash.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CORPUS_FILE, buildCorpusLine, validateCorpusLine } from "../core/corpus.ts";
import { runMemoryRelevance } from "../index.ts";

const ENTRY = { layer: "user", text: "prefers Russian replies", verifier: "ask the user" };
const SITUATION = "user asked to review a chat reply";

test("buildCorpusLine returns the fixed feature shape (RTL-03)", () => {
  const line = buildCorpusLine(
    { judgmentId: "memory-relevance:e1-abc-1-0", entryId: "e1", situation: SITUATION, entry: ENTRY },
    { now: () => "2026-10-14T00:00:00.000Z" }
  );
  assert.deepEqual(line, {
    judgment_id: "memory-relevance:e1-abc-1-0",
    entry_id: "e1",
    ts: "2026-10-14T00:00:00.000Z",
    situation: SITUATION,
    entry: ENTRY,
  });
  assert.equal(validateCorpusLine(line).length, 0);
});

test("validation rejects a missing judgment_id, empty situation, empty text", () => {
  const line = buildCorpusLine(
    { judgmentId: "j1", entryId: "e1", situation: SITUATION, entry: ENTRY },
    { now: () => "t" }
  );
  assert.ok(validateCorpusLine({ ...line, judgment_id: "" }).join().includes("judgment_id"));
  assert.ok(validateCorpusLine({ ...line, situation: "  " }).join().includes("situation"));
  assert.ok(validateCorpusLine({ ...line, entry: { ...ENTRY, text: "" } }).join().includes("entry.text"));
});

test("CORPUS_FILE constant", () => {
  assert.equal(CORPUS_FILE, "corpus.jsonl");
});

const okJudge = (p) => ({
  isError: false,
  result: {
    content: [{ type: "text", text: `judged 1 question(s). memory-relevance:e1=yes (p=${p})` }],
    details: {
      answers: { "memory-relevance:e1": { value: p >= 0.5 ? "yes" : "no", confidence: p } },
      judgment_ids: ["memory-relevance:e1-abc-1-0"],
      errors: [],
    },
  },
});

function setup(stubExecuteTool) {
  const dir = mkdtempSync(join(tmpdir(), "memory-gov-corpus-"));
  // The sidecar follows the entry's own tier, so a user-tier entry writes under
  // HOME: point HOME at a temp dir or the test would touch the real memory.
  const home = mkdtempSync(join(tmpdir(), "memory-gov-corpus-home-"));
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const ctx = { cwd: dir, executeTool: stubExecuteTool };
  const invoke = (params) => runMemoryRelevance(ctx, params, new AbortController().signal);
  const cleanup = () => {
    for (const key of ["HOME", "USERPROFILE"]) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  };
  return { dir, home, invoke, cleanup };
}

test("tool: a judged call appends one corpus line to the entry's own tier", async () => {
  const { home, invoke, cleanup } = setup(async () => okJudge(0.9));
  try {
    await invoke({ entryId: "e1", situation: SITUATION, entry: ENTRY });
    // ENTRY.layer is "user", so the features land in the user-tier sidecar.
    const path = join(home, ".pi", "memory", CORPUS_FILE);
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const line = JSON.parse(lines[0]);
    assert.equal(line.judgment_id, "memory-relevance:e1-abc-1-0");
    assert.equal(line.entry_id, "e1");
    assert.equal(line.situation, SITUATION);
    assert.deepEqual(line.entry, ENTRY);
    assert.equal(validateCorpusLine(line).length, 0);
  } finally {
    cleanup();
  }
});

test("tool: a judge error writes no corpus line (nothing judged, nothing captured)", async () => {
  const { dir, home, invoke, cleanup } = setup(async () => ({
    isError: true,
    result: { content: [{ type: "text", text: "boom" }] },
  }));
  try {
    await invoke({ entryId: "e1", situation: SITUATION, entry: ENTRY });
    assert.equal(existsSync(join(dir, ".pi", "memory", CORPUS_FILE)), false);
    assert.equal(existsSync(join(home, ".pi", "memory", CORPUS_FILE)), false);
  } finally {
    cleanup();
  }
});

test("core/corpus.ts is pure (no fs, no model)", async () => {
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../core/corpus.ts", import.meta.url), "utf8")
  );
  assert.doesNotMatch(src, /from "node:fs"|appendFile|readFileSync/);
});
