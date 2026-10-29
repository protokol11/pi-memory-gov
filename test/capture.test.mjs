// Run: node --test test/capture.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPTURE_SOURCES,
  INBOX_FILE,
  buildCaptureLine,
  validateCaptureInput,
  validateCaptureLine,
} from "../core/capture.ts";
import memoryGov from "../index.ts";

const deps = { now: () => "2026-10-11T00:00:00.000Z", seq: () => 7 };
const VALID = { text: "prefers Russian replies", layer: "user", verifier: "ask the user", source: "user-said" };

test("buildCaptureLine returns the fixed schema with trusted:false (RTL-03)", () => {
  const line = buildCaptureLine(VALID, deps);
  assert.deepEqual(line, {
    id: "2026-10-11T00:00:00.000Z-7",
    ts: "2026-10-11T00:00:00.000Z",
    text: VALID.text,
    layer: "user",
    verifier: "ask the user",
    source: "user-said",
    trusted: false,
    judgment_id: null,
    supersedes: null,
  });
  assert.equal(validateCaptureLine(line).length, 0);
});

test("id and ts come from the same timestamp (one now() call)", () => {
  let calls = 0;
  const line = buildCaptureLine(VALID, { now: () => `t${++calls}`, seq: () => 1 });
  assert.equal(line.ts, "t1");
  assert.ok(line.id.startsWith("t1-"));
});

test("supersede is a new line carrying the old id", () => {
  const line = buildCaptureLine(VALID, deps, "2026-10-11T00:00:00.000Z-6");
  assert.equal(line.supersedes, "2026-10-11T00:00:00.000Z-6");
});

test("validation rejects empty text, missing verifier, bad source", () => {
  assert.ok(validateCaptureInput({ ...VALID, text: "  " }).join().includes("text"));
  assert.ok(validateCaptureInput({ ...VALID, verifier: "" }).join().includes("verifier"));
  assert.ok(validateCaptureInput({ ...VALID, source: "guess" }).join().includes("source"));
});

test("validation enforces trusted:false and judgment_id:null (HUMAN-JUDGMENT-FINAL)", () => {
  const line = buildCaptureLine(VALID, deps);
  assert.ok(validateCaptureLine({ ...line, trusted: true }).join().includes("trusted"));
  assert.ok(validateCaptureLine({ ...line, judgment_id: "x" }).join().includes("judgment_id"));
});

test("CAPTURE_SOURCES and INBOX_FILE constants", () => {
  assert.deepEqual([...CAPTURE_SOURCES], ["user-said", "agent-inferred", "doc-anchor", "imported-hermes"]);
  assert.equal(INBOX_FILE, "inbox.jsonl");
});

function setup() {
  let tools = {};
  memoryGov({ registerTool: (def) => (tools[def.name] = def), on: () => {} });
  const dir = mkdtempSync(join(tmpdir(), "memory-gov-"));
  // layer=user resolves under the home directory: point it at a mkdtemp dir so
  // the test never touches the real ~/.pi/memory store.
  const home = mkdtempSync(join(tmpdir(), "memory-gov-home-"));
  const prevEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const ctx = { cwd: dir, executeTool: async () => ({ isError: true }) };
  const invoke = (name, params) =>
    tools[name].execute("call-1", params, new AbortController().signal, () => {}, ctx);
  const cleanup = () => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    for (const [key, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  return { tools, dir, home, invoke, cleanup };
}

test("tool: memory_capture appends exactly one valid line and returns its id", async () => {
  const { home, invoke, cleanup } = setup();
  try {
    const res = await invoke("memory", { ...VALID, action: "save" });
    assert.equal(res.isError, false);
    const inboxPath = join(home, ".pi", "memory", INBOX_FILE);
    assert.equal(res.details.path, inboxPath);
    const lines = readFileSync(inboxPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const line = JSON.parse(lines[0]);
    assert.equal(line.id, res.details.id);
    assert.equal(line.trusted, false);
    assert.equal(validateCaptureLine(line).length, 0);
  } finally {
    cleanup();
  }
});

test("tool: invalid input is rejected and writes nothing", async () => {
  const { home, invoke, cleanup } = setup();
  try {
    const res = await invoke("memory", { ...VALID, action: "save", verifier: "" });
    assert.equal(res.isError, true);
    assert.match(res.details.error, /verifier/);
    assert.throws(() => readFileSync(join(home, ".pi", "memory", INBOX_FILE), "utf8"));
  } finally {
    cleanup();
  }
});

test("tool: unwritable inbox returns an error result, not a swallowed write (PS-FIXER-03)", async () => {
  // home is an existing FILE: mkdir of <file>/.pi fails ENOTDIR → error result.
  const { cleanup } = setup();
  try {
    const asFile = join(tmpdir(), `memory-gov-as-file-${Date.now()}`);
    writeFileSync(asFile, "x", "utf8");
    const prevHome = process.env.HOME;
    const prevUserProfile = process.env.USERPROFILE;
    process.env.HOME = asFile;
    process.env.USERPROFILE = asFile;
    let tools2 = {};
    memoryGov({ registerTool: (def) => (tools2[def.name] = def), on: () => {} });
    const res = await tools2["memory"].execute(
      "call-1",
      { ...VALID, action: "save" },
      new AbortController().signal,
      () => {},
      { cwd: asFile, executeTool: async () => ({ isError: true }) }
    );
    process.env.HOME = prevHome;
    process.env.USERPROFILE = prevUserProfile;
    assert.equal(res.isError, true);
    assert.match(res.details.error, /inbox not writable/);
    rmSync(asFile, { force: true });
  } finally {
    cleanup();
  }
});
