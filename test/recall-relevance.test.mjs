// Run: node --test test/recall-relevance.test.mjs
// spec-9 decision 6: relevance survives as an internal step of the retrieval
// path. `memory_recall` still returns trusted entries only; untrusted
// candidates are judged (at most three) so the ledger and the spec-8 sidecar
// keep learning. Judging never changes the result.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_FILE } from "../core/capture.ts";
import { CORPUS_FILE } from "../core/corpus.ts";
import { MEMORY_RELEVANCE_PREFIX } from "../core/relevance.ts";
import memoryGov from "../index.ts";

// Marker tokens keep the query clear of the real user inbox and of stop words.
const QUERY = "zorblat flux";

function line(over = {}) {
  return {
    id: "x",
    ts: "2026-10-25T00:00:00.000Z",
    text: "zorblat flux",
    layer: "project",
    verifier: "ask the user",
    source: "agent-inferred",
    trusted: false,
    judgment_id: null,
    supersedes: null,
    ...over,
  };
}

/** Mixed inbox: trusted + untrusted + superseded, across both tiers. */
function mixedInbox() {
  const project = [
    line({ id: "t1", text: "zorblat flux project notes", trusted: true, judgment_id: "j-t1" }),
    line({ id: "t2", text: "zorblat flux replacement", trusted: true, judgment_id: "j-t2", supersedes: "s1" }),
    line({ id: "s1", text: "zorblat flux stale line", trusted: false }),
    line({ id: "c1", text: "zorblat flux candidate one", trusted: false }),
    line({ id: "c2", text: "zorblat flux candidate two", trusted: false }),
  ];
  const user = [
    line({ id: "u1", layer: "user", text: "zorblat flux user preference", trusted: true, judgment_id: "j-u1" }),
    line({ id: "u2", layer: "user", text: "zorblat flux user candidate", trusted: false }),
  ];
  return { project, user };
}

const entryIdOf = (call) => Object.keys(call.args.questions)[0].slice(MEMORY_RELEVANCE_PREFIX.length);

/** Canned judge, answering whatever question it is asked (relevance.test.mjs style). */
function okJudge(calls, p = 0.9) {
  return async (name, args) => {
    calls.push({ name, args });
    const questionId = Object.keys(args.questions)[0];
    return {
      isError: false,
      result: {
        content: [{ type: "text", text: `judged ${questionId}` }],
        details: {
          answers: { [questionId]: { value: p >= 0.5 ? "yes" : "no", confidence: p } },
          judgment_ids: [`${questionId}-1-0`],
          errors: [],
        },
      },
    };
  };
}

/** Fake pi registration + temp tiers. The user tier follows HOME/USERPROFILE. */
function setup({ projectLines = [], userLines = [], executeTool, signal }) {
  const project = mkdtempSync(join(tmpdir(), "mgov-rr-proj-"));
  const home = mkdtempSync(join(tmpdir(), "mgov-rr-home-"));
  const writeInbox = (dir, lines) => {
    mkdirSync(join(dir, ".pi", "memory"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "memory", INBOX_FILE),
      lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
      "utf8"
    );
  };
  writeInbox(project, projectLines);
  writeInbox(home, userLines);
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  const tools = {};
  memoryGov({ registerTool: (def) => (tools[def.name] = def), on: () => {} });
  const ctx = { cwd: project, executeTool };
  const recall = (params = {}) =>
    tools.memory_recall.execute(
      "call-1",
      { query: QUERY, ...params },
      signal ?? new AbortController().signal,
      () => {},
      ctx
    );
  const cleanup = () => {
    for (const key of ["HOME", "USERPROFILE"]) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
    rmSync(project, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  };
  return { recall, cleanup, project, home };
}

test("only untrusted, non-superseded candidates reach the judge", async () => {
  const calls = [];
  const { project, user } = mixedInbox();
  const { recall, cleanup } = setup({ projectLines: project, userLines: user, executeTool: okJudge(calls) });
  try {
    const res = await recall();
    const judgedIds = calls.map(entryIdOf).sort();
    assert.deepEqual(judgedIds, ["c1", "c2", "u2"], "trusted and superseded lines must not be judged");
    for (const call of calls) {
      assert.equal(call.name, "judge");
      assert.equal(call.args.state.situation, QUERY);
      assert.ok(call.args.state.entry.text, "the candidate entry carries its text");
      assert.ok(call.args.state.entry.layer, "the candidate entry carries its layer");
      assert.ok(call.args.state.entry.verifier, "the candidate entry carries its verifier");
    }
    const judged = res.details.judged.map((j) => j.entry_id).sort();
    assert.deepEqual(judged, ["c1", "c2", "u2"]);
  } finally {
    cleanup();
  }
});

test("recall content is unchanged: trusted entries only", async () => {
  const calls = [];
  const { project, user } = mixedInbox();
  const { recall, cleanup } = setup({ projectLines: project, userLines: user, executeTool: okJudge(calls) });
  try {
    const res = await recall();
    assert.equal(res.isError, false);
    const ids = res.details.entries.map((e) => e.id).sort();
    assert.deepEqual(ids, ["t1", "t2", "u1"], "untrusted and superseded lines must stay out of the result");
    assert.deepEqual(res.details.notes, [], "a clean judge run reports no notes");
    assert.equal(res.content[0].text, res.details.context);
  } finally {
    cleanup();
  }
});

test("a judge failure surfaces in details and never fails the recall", async () => {
  const { project, user } = mixedInbox();
  const { recall, cleanup } = setup({
    projectLines: project,
    userLines: user,
    executeTool: async () => {
      throw new Error("network down");
    },
  });
  try {
    const res = await recall();
    assert.equal(res.isError, false, "judging must not fail recall");
    assert.deepEqual(res.details.entries.map((e) => e.id).sort(), ["t1", "t2", "u1"]);
    assert.ok(res.details.judged.length > 0, "the failure is recorded per candidate");
    for (const j of res.details.judged) {
      assert.equal(j.decision, "escalate");
      assert.match(j.note, /judge threw/);
    }
    assert.ok(res.details.notes.length > 0, "PS-FIXER-03: the failure is surfaced, not swallowed");
    assert.match(res.details.notes.join(";"), /judge threw: Error: network down/);
  } finally {
    cleanup();
  }
});

test("at most three candidates are judged per recall call", async () => {
  const calls = [];
  const candidates = Array.from({ length: 6 }, (_, i) =>
    line({ id: `c${i}`, text: `zorblat flux candidate ${i}` })
  );
  const { recall, cleanup } = setup({ projectLines: candidates, executeTool: okJudge(calls) });
  try {
    const res = await recall();
    assert.equal(calls.length, 3, "the cap bounds judge calls per recall");
    assert.equal(res.details.judged.length, 3);
    assert.equal(res.details.entries.length, 0, "freshly captured entries stay invisible");
  } finally {
    cleanup();
  }
});

test("a candidate with no lexical overlap is not judged", async () => {
  const calls = [];
  const { recall, cleanup } = setup({
    projectLines: [line({ id: "off-topic", text: "kubernetes ingress tuning" })],
    executeTool: okJudge(calls),
  });
  try {
    await recall();
    assert.equal(calls.length, 0);
  } finally {
    cleanup();
  }
});

test("a judged candidate writes one corpus line to its own tier's sidecar (spec-8)", async () => {
  const calls = [];
  const { project, user } = mixedInbox();
  const { recall, cleanup, project: projectDir, home: homeDir } = setup({
    projectLines: project,
    userLines: user,
    executeTool: okJudge(calls),
  });
  const rowsAt = (base) => {
    const path = join(base, ".pi", "memory", CORPUS_FILE);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  };
  try {
    await recall();
    const projectRows = rowsAt(projectDir);
    const userRows = rowsAt(homeDir);
    // A user-tier candidate must not leak into the project sidecar.
    assert.deepEqual(projectRows.map((r) => r.entry_id).sort(), ["c1", "c2"]);
    assert.deepEqual(userRows.map((r) => r.entry_id), ["u2"]);
    assert.equal(projectRows.length + userRows.length, 3, "one corpus line per judgment");
    for (const row of [...projectRows, ...userRows]) {
      assert.equal(row.situation, QUERY);
      assert.ok(row.judgment_id.startsWith(MEMORY_RELEVANCE_PREFIX));
      assert.ok(row.entry.text && row.entry.layer && row.entry.verifier);
    }
    assert.ok(projectRows.every((r) => r.entry.layer === "project"));
    assert.ok(userRows.every((r) => r.entry.layer === "user"));
  } finally {
    cleanup();
  }
});

test("the same (entry, situation) is judged once across recall calls", async () => {
  const calls = [];
  const { project, user } = mixedInbox();
  const { recall, cleanup } = setup({ projectLines: project, userLines: user, executeTool: okJudge(calls) });
  try {
    const first = await recall();
    assert.equal(first.details.judged.length, 3);
    assert.equal(calls.length, 3);

    const second = await recall();
    assert.equal(second.isError, false);
    assert.equal(calls.length, 3, "the sidecar already holds these pairs: no second judge call");
    assert.deepEqual(second.details.judged, []);
    assert.deepEqual(second.details.entries.map((e) => e.id).sort(), ["t1", "t2", "u1"]);
  } finally {
    cleanup();
  }
});

test("a different situation still judges the same entry (corpus growth)", async () => {  const calls = [];
  const candidates = [line({ id: "c1", text: "zorblat flux candidate one" })];
  const { recall, cleanup } = setup({ projectLines: candidates, executeTool: okJudge(calls) });
  try {
    await recall();
    assert.equal(calls.length, 1);
    await recall({ query: "zorblat" });
    assert.equal(calls.length, 2, "dedup is per (entry, situation), not per entry");
  } finally {
    cleanup();
  }
});

test("an unreadable sidecar degrades to judging, never blocks recall", async () => {
  const calls = [];
  const { recall, cleanup, project: projectDir } = setup({
    projectLines: [line({ id: "c1" })],
    executeTool: okJudge(calls),
  });
  try {
    // corpus.jsonl as a DIRECTORY: the dedup read fails, so the pair is not a
    // known duplicate and the candidate is still judged.
    mkdirSync(join(projectDir, ".pi", "memory", CORPUS_FILE), { recursive: true });
    const res = await recall();
    assert.equal(res.isError, false);
    assert.equal(calls.length, 1, "an unreadable dedup source must not suppress judging");
    assert.equal(res.details.judged.length, 1);
    assert.match(res.details.notes.join("; "), /corpus not writable/, "the failed write is still surfaced");
  } finally {
    cleanup();
  }
});

test("a malformed judge result escalates instead of throwing", async () => {
  const { project, user } = mixedInbox();
  const { recall, cleanup } = setup({
    projectLines: project,
    userLines: user,
    executeTool: async () => ({ isError: false, result: { content: [], details: { garbage: true } } }),
  });
  try {
    const res = await recall();
    assert.equal(res.isError, false, "a garbage judge payload must not fail recall");
    assert.deepEqual(res.details.entries.map((e) => e.id).sort(), ["t1", "t2", "u1"]);
    assert.ok(res.details.judged.length > 0);
    for (const j of res.details.judged) assert.equal(j.decision, "escalate");
    const notes = res.details.notes.join("; ");
    assert.doesNotMatch(notes, /judge threw: TypeError/);
    assert.match(notes, /judge result malformed: details\.answers is missing/);
  } finally {
    cleanup();
  }
});

test("an abort stops the judging loop and the recall still returns", async () => {
  const controller = new AbortController();
  const calls = [];
  const candidates = Array.from({ length: 6 }, (_, i) =>
    line({ id: `c${i}`, text: `zorblat flux candidate ${i}` })
  );
  const { recall, cleanup } = setup({
    projectLines: candidates,
    signal: controller.signal,
    executeTool: async (name, args) => {
      calls.push({ name, args });
      controller.abort();
      throw new Error("aborted");
    },
  });
  try {
    const res = await recall();
    assert.equal(res.isError, false);
    assert.equal(calls.length, 1, "no judge calls after the abort");
    assert.equal(res.details.judged.length, 1);
    assert.equal(res.details.judged[0].decision, "escalate");
    assert.match(res.details.notes.join("; "), /judging aborted/);
  } finally {
    cleanup();
  }
});
