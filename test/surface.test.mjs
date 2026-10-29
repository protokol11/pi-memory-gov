// Run: node --test test/surface.test.mjs
// Merged memory surface (ADR-0044, spec-9). Two declared tools, two tiers,
// trusted-only reads, groom as a hook. These tests are the contract; they are
// expected to fail until core/surface.ts exists.
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { CAPTURE_SOURCES, INBOX_FILE, validateCaptureLine } from "../core/capture.ts";
import {
  MEMORY_LAYERS,
  MEMORY_ACTIONS,
  buildWriteLine,
  resolveStorePaths,
  searchTrusted,
  validateMemoryWrite,
} from "../core/surface.ts";
import memoryGov from "../index.ts";

const DEPS = { now: () => "2026-10-25T00:00:00.000Z", seq: () => 0 };

function line(over = {}) {
  return {
    id: "e1",
    ts: "2026-10-25T00:00:00.000Z",
    text: "prefers Russian replies",
    layer: "user",
    verifier: "ask the user",
    source: "user-said",
    trusted: true,
    judgment_id: "j1",
    supersedes: null,
    ...over,
  };
}

function stubPi() {
  const tools = {};
  const handlers = {};
  memoryGov({
    registerTool: (def) => (tools[def.name] = def),
    on: (event, fn) => (handlers[event] = fn),
  });
  return { tools, handlers };
}

// --- storage tiers (spec-9 "Storage") -------------------------------------

test("user tier lives under the home directory and ignores cwd", () => {
  const home = join("C:", "Users", "someone");
  const paths = resolveStorePaths({ layer: "user", cwd: join("C:", "repo"), homeDir: home });
  assert.equal(paths.inbox, join(home, ".pi", "memory", "inbox.jsonl"));
  assert.equal(paths.corpus, join(home, ".pi", "memory", "corpus.jsonl"));
});

test("project tier lives inside the repository", () => {
  const cwd = join("C:", "repo");
  const paths = resolveStorePaths({ layer: "project", cwd, homeDir: join("C:", "someone") });
  assert.equal(paths.inbox, join(cwd, ".pi", "memory", "inbox.jsonl"));
  assert.equal(paths.corpus, join(cwd, ".pi", "memory", "corpus.jsonl"));
});

test("only the two tiers exist", () => {
  assert.deepEqual([...MEMORY_LAYERS], ["user", "project"]);
  assert.deepEqual([...MEMORY_ACTIONS], ["save", "update", "forget"]);
});

// --- write contract (spec-9 decision 1-3) --------------------------------

test("save requires text, verifier and a tier", () => {
  assert.deepEqual(validateMemoryWrite({ action: "save", layer: "user", text: "t", verifier: "v", source: "user-said" }), []);
  assert.ok(validateMemoryWrite({ action: "save", layer: "user", verifier: "v", source: "user-said" }).join().includes("text"));
  assert.ok(validateMemoryWrite({ action: "save", layer: "user", text: "t", source: "user-said" }).join().includes("verifier"));
  assert.ok(validateMemoryWrite({ action: "save", text: "t", verifier: "v", source: "user-said" }).join().includes("layer"));
});

test("update and forget must name the entry they supersede", () => {
  assert.deepEqual(validateMemoryWrite({ action: "update", layer: "user", supersedes: "e1", text: "t" }), []);
  assert.deepEqual(validateMemoryWrite({ action: "forget", layer: "user", supersedes: "e1" }), []);
  assert.ok(validateMemoryWrite({ action: "update", layer: "user", text: "t" }).join().includes("supersedes"));
  assert.ok(validateMemoryWrite({ action: "forget", layer: "user" }).join().includes("supersedes"));
});

test("an unknown action is rejected, not silently coerced", () => {
  assert.ok(validateMemoryWrite({ action: "search", layer: "user", text: "t", verifier: "v" }).join().includes("action"));
});

test("the model cannot write an import-sourced line (import is a script, not a tool)", () => {
  const errors = validateMemoryWrite({
    action: "save",
    layer: "user",
    text: "t",
    verifier: "v",
    source: "imported-hermes",
  });
  assert.ok(errors.join().includes("imported-hermes"), `expected a rejection, got: ${errors.join()}`);
});

test("save builds an untrusted candidate line", () => {
  const built = buildWriteLine(
    { action: "save", layer: "project", text: "uses pnpm", verifier: "check package.json", source: "agent-inferred" },
    DEPS
  );
  assert.equal(built.trusted, false);
  assert.equal(built.judgment_id, null);
  assert.equal(built.supersedes, null);
  assert.equal(built.layer, "project");
  assert.equal(validateCaptureLine(built).length, 0);
});

test("forget appends a superseding line and keeps the text for the audit trail", () => {
  const built = buildWriteLine({ action: "forget", layer: "user", supersedes: "e1", text: "prefers Russian replies" }, DEPS);
  assert.equal(built.supersedes, "e1");
  assert.equal(built.trusted, false);
  assert.equal(built.text, "prefers Russian replies");
  assert.notEqual(built.id, "e1");
});

test("the import source is a valid capture source but never a tool source", () => {
  assert.ok(CAPTURE_SOURCES.includes("imported-hermes"));
  const imported = line({ source: "imported-hermes", trusted: false, judgment_id: null });
  assert.deepEqual(validateCaptureLine(imported), []);
});

// --- read contract (spec-9 decision 3) -----------------------------------

test("untrusted candidates are never returned", () => {
  const rows = [line({ id: "a", trusted: false, judgment_id: null, text: "russian replies" })];
  assert.deepEqual(searchTrusted(rows, { query: "russian", k: 5 }), []);
});

test("superseded entries are never returned", () => {
  const rows = [line({ id: "a", text: "old russian reply" }), line({ id: "b", text: "new russian reply", supersedes: "a" })];
  const ids = searchTrusted(rows, { query: "russian", k: 5 }).map((r) => r.id);
  assert.deepEqual(ids, ["b"]);
});

test("layer narrows the result set", () => {
  const rows = [
    line({ id: "u", layer: "user", text: "russian replies" }),
    line({ id: "p", layer: "project", text: "russian replies in repo" }),
  ];
  assert.deepEqual(searchTrusted(rows, { query: "russian", k: 5, layer: "project" }).map((r) => r.id), ["p"]);
  assert.deepEqual(searchTrusted(rows, { query: "russian", k: 5, layer: "user" }).map((r) => r.id), ["u"]);
});

test("k caps the result and results are ordered by score", () => {
  const rows = [
    line({ id: "a", text: "russian" }),
    line({ id: "b", text: "russian russian russian replies" }),
    line({ id: "c", text: "russian replies" }),
  ];
  const top = searchTrusted(rows, { query: "russian replies", k: 2 });
  assert.equal(top.length, 2);
  assert.ok(top[0].score >= top[1].score);
});

test("a query with no lexical overlap returns an empty list", () => {
  assert.deepEqual(searchTrusted([line({ text: "russian replies" })], { query: "kubernetes", k: 5 }), []);
});

// --- declared surface (spec-9 acceptance) --------------------------------

test("exactly two memory tools are declared", () => {
  const { tools } = stubPi();
  assert.deepEqual(Object.keys(tools).sort(), ["memory", "memory_recall"]);
  for (const gone of ["memory_capture", "memory_context", "memory_groom", "memory_relevance", "memory_search"]) {
    assert.equal(tools[gone], undefined, `${gone} must not be declared`);
  }
});

test("groom is a session_start hook, not a tool", () => {
  const { tools, handlers } = stubPi();
  assert.equal(tools.memory_groom, undefined);
  assert.equal(typeof handlers.session_start, "function", "groom must run on session_start");
});

// --- two tiers at the tool boundary --------------------------------------

test("memory_recall without a layer spans both tiers", async () => {
  const { tools } = stubPi();
  const project = mkdtempSync(join(tmpdir(), "mgov-proj-"));
  const home = mkdtempSync(join(tmpdir(), "mgov-home-"));
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    const write = (dir, tier) => {
      mkdirSync(join(dir, ".pi", "memory"), { recursive: true });
      writeFileSync(
        join(dir, ".pi", "memory", INBOX_FILE),
        JSON.stringify(line({ id: tier, layer: tier, text: "russian replies" })) + "\n",
        "utf8"
      );
    };
    write(project, "project");
    write(home, "user");
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    const ctx = { cwd: project, executeTool: async () => ({ isError: true }) };
    const res = await tools.memory_recall.execute("c1", { query: "russian replies" }, new AbortController().signal, () => {}, ctx);
    const layers = res.details.entries.map((e) => e.layer).sort();
    assert.deepEqual(layers, ["project", "user"], `both tiers must be read, got ${JSON.stringify(layers)}`);
  } finally {
    process.env.HOME = prev.HOME;
    process.env.USERPROFILE = prev.USERPROFILE;
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
