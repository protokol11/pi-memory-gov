// Run: node --test test/inject-graduation.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EMPTY_MEMORY_CONTEXT, MEMORY_CONTEXT_HEADER, renderMemoryContext } from "../core/inject.ts";
import { buildPromotionLine, buildTrueResolutionIndex, findPromotions } from "../core/graduation.ts";
import { INBOX_FILE } from "../core/capture.ts";
import memoryGov from "../index.ts";

const entry = (over) => ({ id: "e1", text: "t", layer: "user", score: 0.5, ...over });

test("render: header + one `- [layer] text (id: id)` line per entry", () => {
  const block = renderMemoryContext([entry({ id: "a", text: "prefers examples", layer: "user" }), entry({ id: "b", layer: "project" })]);
  assert.ok(block.startsWith(MEMORY_CONTEXT_HEADER));
  assert.ok(block.includes("- [user] prefers examples (id: a)"));
  assert.ok(block.includes("- [project] t (id: b)"));
});

test("render: empty input → fixed sentence, no error shape", () => {
  assert.equal(renderMemoryContext([]), EMPTY_MEMORY_CONTEXT);
});

const line = (over) => ({
  id: "x-" + Math.random().toString(36).slice(2, 8),
  ts: "2026-10-11T00:00:00.000Z",
  text: "some memory",
  layer: "user",
  verifier: "v",
  source: "user-said",
  trusted: false,
  judgment_id: null,
  supersedes: null,
  ...over,
});

const JID = "memory-relevance:e1-abc-1-0";

test("graduation rule: true resolution promotes, unresolved/false/trusted/superseded do not", () => {
  const confirmed = line({ id: "e1" });
  const unresolved = line({ id: "e2" });
  const rejected = line({ id: "e3" });
  const trusted = line({ id: "e4", trusted: true });
  const dead = line({ id: "e5" });
  const replacement = line({ id: "e6", supersedes: "e5" });
  const lines = [confirmed, unresolved, rejected, trusted, dead, replacement];

  const resolutions = {
    e1: { judgmentId: JID },
    e3: null, // rejected: ledger holds outcome:false
  };
  const promotions = findPromotions(lines, (id) => resolutions[id] ?? null);
  assert.deepEqual(promotions.map((p) => p.entry.id), ["e1"]);
  assert.equal(promotions[0].judgmentId, JID);
});

test("buildPromotionLine: superseding line carries trusted, judgment_id, supersedes", () => {
  const src = line({ id: "e1" });
  const promoted = buildPromotionLine(src, { now: () => "2026-10-11T01:00:00.000Z", seq: () => 3 }, JID);
  assert.equal(promoted.trusted, true);
  assert.equal(promoted.judgment_id, JID);
  assert.equal(promoted.supersedes, "e1");
  assert.equal(promoted.text, src.text);
  assert.equal(promoted.id, "2026-10-11T01:00:00.000Z-3");
});

test("ledger index: joins resolution rows back to question ids by judgment_id", () => {
  const rows = [
    { kind: "judgment", judgment_id: JID, question_id: "memory-relevance:e1", outcome: null },
    { kind: "resolution", judgment_id: JID, outcome: true },
    { kind: "judgment", judgment_id: "memory-relevance:e2-x-1-0", question_id: "memory-relevance:e2", outcome: null },
    { kind: "resolution", judgment_id: "memory-relevance:e2-x-1-0", outcome: false },
    { kind: "judgment", judgment_id: "scope:y-1-0", question_id: "scope:y", outcome: null }, // other family ignored
    { kind: "resolution", judgment_id: "scope:y-1-0", outcome: true },
  ];
  const index = buildTrueResolutionIndex(rows);
  assert.deepEqual(index.get("e1"), { judgmentId: JID });
  assert.equal(index.has("e2"), false); // false resolution never promotes
  assert.equal(index.has("y"), false); // non-memory-relevance family ignored
});

function setup({ inboxLines = [], ledgerLines = [] } = {}) {
  const tools = {};
  const handlers = {};
  memoryGov({
    registerTool: (def) => (tools[def.name] = def),
    on: (event, fn) => (handlers[event] = fn),
  });
  const dir = mkdtempSync(join(tmpdir(), "memory-gov-"));
  mkdirSync(join(dir, ".pi", "memory"), { recursive: true });
  if (inboxLines.length) writeFileSync(join(dir, ".pi", "memory", INBOX_FILE), inboxLines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  if (ledgerLines.length) writeFileSync(join(dir, ".pi", "judgments.jsonl"), ledgerLines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  const ctx = { cwd: dir, executeTool: async () => ({ isError: true }) };
  const invoke = (name, params) => tools[name].execute("call-1", params, new AbortController().signal, () => {}, ctx);
  const groom = () => handlers.session_start({}, ctx);
  return { tools, handlers, dir, invoke, groom, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const DEMO_LINE = line({ id: "e1", text: "user prefers examples first", layer: "user" });
const DEMO_JUDGMENT = { kind: "judgment", judgment_id: JID, question_id: "memory-relevance:e1", outcome: null };
const DEMO_RESOLUTION = { kind: "resolution", judgment_id: JID, outcome: true };

test("tool: memory_groom promotes a confirmed entry by superseding append", async () => {
  const { dir, groom, cleanup } = setup({ inboxLines: [DEMO_LINE], ledgerLines: [DEMO_JUDGMENT, DEMO_RESOLUTION] });
  try {
    await groom();
    const all = readInboxLines(join(dir, ".pi", "memory", INBOX_FILE));
    assert.equal(all.length, 2); // original + superseding
    const promoted = all[1];
    assert.equal(promoted.trusted, true);
    assert.equal(promoted.supersedes, "e1");
    assert.equal(promoted.judgment_id, JID);
  } finally {
    cleanup();
  }
});

test("tool: after groom, memory_context includes the promoted entry", async () => {
  const { invoke, groom, cleanup } = setup({ inboxLines: [DEMO_LINE], ledgerLines: [DEMO_JUDGMENT, DEMO_RESOLUTION] });
  try {
    await groom();
    const res = await invoke("memory_recall", { query: "how to explain things to the user" });
    assert.equal(res.isError, false);
    assert.ok(res.details.context.startsWith(MEMORY_CONTEXT_HEADER));
    assert.match(res.details.context, /user prefers examples first/);
    assert.equal(res.details.entries.length, 1);
  } finally {
    cleanup();
  }
});

test("tool: memory_context with no trusted entries returns the empty sentence", async () => {
  const { invoke, cleanup } = setup({ inboxLines: [DEMO_LINE] }); // untrusted only, no ledger
  try {
    const res = await invoke("memory_recall", { query: "explain" });
    assert.equal(res.isError, false);
    assert.equal(res.details.context, EMPTY_MEMORY_CONTEXT);
    assert.deepEqual(res.details.entries, []);
  } finally {
    cleanup();
  }
});

test("tool: unreadable inbox is an error result, not an empty-looking success (PS-FIXER-03)", async () => {
  // inbox path exists but is a DIRECTORY: readFileSync fails (EISDIR/EPERM),
  // unlike ENOENT which honestly means "cold project, no inbox yet".
  const dir = mkdtempSync(join(tmpdir(), "memory-gov-"));
  mkdirSync(join(dir, ".pi", "memory", INBOX_FILE), { recursive: true });
  const tools = {};
  memoryGov({ registerTool: (def) => (tools[def.name] = def), on: () => {} });
  const res = await tools["memory_recall"].execute(
    "call-1", { query: "x" }, new AbortController().signal, () => {},
    { cwd: dir, executeTool: async () => ({ isError: true }) }
  );
  assert.equal(res.isError, true);
  rmSync(dir, { recursive: true, force: true });
});

function readInboxLines(path) {
  return readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}
