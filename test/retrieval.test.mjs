// Run: node --test test/retrieval.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filterRetrievable, lexicalRetriever, tokenize } from "../core/retrieval.ts";
import { INBOX_FILE } from "../core/capture.ts";
import memoryGov from "../index.ts";

const line = (over) => ({
  id: "id-" + Math.random().toString(36).slice(2, 8),
  ts: "2026-10-11T00:00:00.000Z",
  text: "",
  layer: "memory",
  verifier: "v",
  source: "agent-inferred",
  trusted: false,
  judgment_id: null,
  supersedes: null,
  ...over,
});

test("tokenize: one normalizer, lowercase, 2+ char tokens", () => {
  assert.deepEqual(tokenize("Memory-Gov, ADR-0038!"), ["memory", "gov", "adr", "0038"]);
  assert.deepEqual(tokenize("a b"), []);
  assert.equal(tokenize.toString(), tokenize.toString()); // single definition checked by grep
});

test("filterRetrievable drops untrusted and superseded lines", () => {
  const dead = line({ text: "old", trusted: true });
  const rows = [
    line({ text: "untrusted" }),
    dead,
    line({ text: "replacement", trusted: true, supersedes: dead.id }),
    line({ text: "live", trusted: true }),
  ];
  const kept = filterRetrievable(rows);
  assert.deepEqual(kept.map((r) => r.text), ["replacement", "live"]);
});

test("topK orders by descending score; layer breaks ties", () => {
  const rows = filterRetrievable([
    line({ id: "a", text: "user prefers Russian replies", layer: "user", trusted: true }),
    line({ id: "b", text: "project uses pnpm workspaces", layer: "project", trusted: true }),
    line({ id: "c", text: "unrelated note about weather", layer: "memory", trusted: true }),
  ]);
  const r = lexicalRetriever(rows);
  const top = r.topK("what language does the user prefer for chat replies", 10);
  assert.deepEqual(top.map((t) => t.id), ["a"]); // b and c score 0 and drop out
  for (let i = 1; i < top.length; i++) assert.ok(top[i - 1].score >= top[i].score);
});

test("layer breaks exact score ties (user > project > memory)", () => {
  const rows = filterRetrievable([
    line({ id: "m", text: "same words here", layer: "memory", trusted: true }),
    line({ id: "p", text: "same words here", layer: "project", trusted: true }),
    line({ id: "u", text: "same words here", layer: "user", trusted: true }),
  ]);
  const ids = lexicalRetriever(rows).topK("same words", 3).map((t) => t.id);
  assert.deepEqual(ids, ["u", "p", "m"]);
});

test("idf: a rare token beats a common one", () => {
  const rows = filterRetrievable([
    line({ id: "rare", text: "zelkova tree pruning schedule", trusted: true }),
    line({ id: "common1", text: "the memory the project the user", trusted: true }),
    line({ id: "common2", text: "memory project user stuff", trusted: true }),
  ]);
  const top = lexicalRetriever(rows).topK("zelkova", 5);
  assert.equal(top[0]?.id, "rare");
});

test("k bound is caller-owned; zero scores drop out", () => {
  const rows = filterRetrievable([
    line({ id: "x", text: "alpha beta", trusted: true }),
    line({ id: "y", text: "gamma delta", trusted: true }),
  ]);
  const r = lexicalRetriever(rows);
  assert.equal(r.topK("alpha", 1).length, 1);
  assert.equal(r.topK("nothing matches", 5).length, 0);
});

test("empty entry set: topK returns []", () => {
  assert.deepEqual(lexicalRetriever([]).topK("anything", 3), []);
});

function setup(inboxLines) {
  const tools = {};
  memoryGov({ registerTool: (def) => (tools[def.name] = def), on: () => {} });
  const dir = mkdtempSync(join(tmpdir(), "memory-gov-"));
  if (inboxLines !== null) {
    mkdirSync(join(dir, ".pi", "memory"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "memory", INBOX_FILE),
      inboxLines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf8"
    );
  }
  const ctx = { cwd: dir, executeTool: async () => ({ isError: true }) };
  const invoke = (params) =>
    tools["memory_recall"].execute("call-1", params, new AbortController().signal, () => {}, ctx);
  return { invoke, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("tool: memory_recall returns trusted top-k with fixed shape (RTL-03)", async () => {
  const { invoke, cleanup } = setup([
    line({ id: "t1", text: "capture seam is append-only", layer: "project", trusted: true }),
    line({ id: "u1", text: "capture seam append-only but untrusted", layer: "project" }),
  ]);
  try {
    const res = await invoke({ query: "is capture append-only", k: 5 });
    assert.equal(res.isError, false);
    assert.equal(res.details.entries.length, 1);
    assert.deepEqual(Object.keys(res.details.entries[0]).sort(), ["id", "layer", "score", "text"]);
    assert.equal(res.details.entries[0].id, "t1");
  } finally {
    cleanup();
  }
});

test("tool: missing inbox returns empty, not an error", async () => {
  const { invoke, cleanup } = setup(null);
  try {
    const res = await invoke({ query: "anything" });
    assert.equal(res.isError, false);
    assert.deepEqual(res.details.entries, []);
  } finally {
    cleanup();
  }
});

test("core/retrieval.ts is read-only (PS-TV-04)", async () => {
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("../core/retrieval.ts", import.meta.url), "utf8")
  );
  assert.doesNotMatch(src, /appendFile|writeFile|node:fs/);
});
