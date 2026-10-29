# pi-memory-gov

Memory capture and recall for pi agents, where trust comes from calibrated judgments, not model self-assessment. Published as [`@protokol11/pi-memory-gov`](https://www.npmjs.com/package/@protokol11/pi-memory-gov) on npm; the source of truth lives in the [`agent-governance`](https://github.com/protokol11/agent-governance) monorepo (`extensions/memory-gov`).

## Why

Agent memory fails at the same root in both directions: writing is a decision left to the model. A strong model writes duplicates until the store grows without bound; a weak model skips the write instruction entirely. A prompt-level agreement ("write what matters") is not a mechanism.

The fix is a separation of powers. Capture is dumb and deterministic — every write lands in an inbox as `trusted: false`. Retrieval is semantic — token-ranked search over the trusted tier. Trust is a judgment, and it lives outside this extension. memory-gov never decides what is true; it asks the judgment primitive through its tool interface and calibrates against how those judgments resolve (ADR-0038). A line becomes memory only by being judged and confirmed, never by being written or read.

Scope: an adaptive layer that selects relevant context for the current situation. Non-scope: vocabulary and writing policy (owned by principled-write / STE conventions), skill triggers and modes (owned by skills).

## How it works

Two declared tools and one scheduled groom pass:

- **`memory`** — `save | update | forget`. Appends a candidate JSONL line to the inbox of the chosen tier (user: `~/.pi/memory/inbox.jsonl`, project: `<cwd>/.pi/memory/inbox.jsonl`). Every write returns `trusted: false`.
- **`memory_recall`** — token-ranked search over trusted, non-superseded lines across both tiers. After the trusted result is fixed, the top untrusted candidates (up to 3, deduplicated by entry + situation) are sent to the judge as an internal feature-capture step. This judging can never change the trusted set returned.
- **groom** (`session_start` hook) — scans the project inbox against the judgment ledger and appends promotion lines for entries whose judgments resolved true. Bounded at 50 promotions per pass.

The relevance seam (ADR-0038, spec-9 decision 5) stays undeclared: the extension invokes the `judge` tool of the judgment extension through `ctx.executeTool("judge", ...)` — through validation, without imports. The judge's confidence `p` feeds `decideInjection(p, { threshold: 0.7, minSample: 3 })`: inject above threshold, ask a human while fewer than 3 resolved rows exist (cold start escalates instead of guessing), and record the judged features in a per-tier `corpus.jsonl` sidecar keyed by `judgment_id`. A failed, malformed, or aborted judge call escalates and is reported — it is never silently read as "no".

```
capture (deterministic)            recall (semantic)              trust (judgment, external)
──────────────────────             ──────────────────             ──────────────────────────
memory save ──► inbox.jsonl        token rank over trusted        judge("memory-relevance:<id>")
  trusted:false    (both tiers)   lines, top-k + context block        │
                   │                  │                               ▼
                   │                  │ (fixed result)          p vs threshold 0.7
                   ▼                  ▼                          min-sample 3 ⇒ ask human
              groom @ session_start: ledger ⇒ promote            │
                   │                                             ▼
                   └──────── trusted lines ◄── resolve_judgment → ledger → calibration corpus
```

Failure handling follows one rule: a failed write, an unreadable inbox, a malformed judge payload, or an unwritable sidecar is surfaced as an error or an escalation note — never swallowed.

## Quick start

Prerequisite: the [`pi-judgment`](https://www.npmjs.com/package/@protokol11/pi-judgment) extension installed and loaded — memory-gov calls its `judge` tool for every relevance decision.

```sh
npm install @protokol11/pi-judgment
npm install @protokol11/pi-memory-gov
```

Or from clones of these repos:

```sh
cp -r pi-judgment ~/.pi/agent/extensions/pi-judgment
cp -r pi-memory-gov ~/.pi/agent/extensions/pi-memory-gov
```

Restart the agent session. On the first `session_start` in a project, groom creates `<cwd>/.pi/memory/`; a missing inbox is a cold start, not an error.

## Contributing

File issues in the [agent-governance](https://github.com/protokol11/agent-governance) monorepo under `extensions/memory-gov` (this repo is a publish mirror). Run `npm test` (Node's built-in test runner over `test/*.test.mjs`) before submitting a change. Design constraints to respect: the extension never judges on its own, trust is never granted at write time, and any failure that used to be a silent skip must be reported.

## License

MIT — see [LICENSE](./LICENSE).
