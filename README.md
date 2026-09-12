# Sentinel

An AI-powered Engineering Codex guardrail, running entirely on Cloudflare.

Most engineering organisations have standards. Almost none of them are enforced,
because the standards worth having are the ones a linter cannot check — "don't
swallow errors", "make new failure paths observable", "don't break a published
contract without a deprecation path". So they live in a wiki page, get cited in
code review when someone remembers, and quietly stop being true.

Sentinel takes that wiki page and makes it executable. Half the codex is
decidable and runs as static analysis; the other half is judged by Llama 3.3 on
Workers AI. Both halves produce the same shaped finding, every finding says which
half it came from, and the whole thing is addressable from CI, from a browser,
and — most usefully — from the coding agent that is writing the change.

---

## What it does

```
                      ┌──────────────────────────────────────────┐
  git diff ──────────▶│  /api/review    synchronous, for CI      │
                      ├──────────────────────────────────────────┤
  coding agent ──────▶│  /mcp           6 tools, for the editor  │
                      ├──────────────────────────────────────────┤
  browser ───────────▶│  /agents/*      WebSocket, live verdict  │
                      └────────────────────┬─────────────────────┘
                                           │
                          ┌────────────────▼─────────────────┐
                          │        the codex engine          │
                          │                                  │
                          │  5 deterministic rules   pure    │
                          │  4 judged rules          Llama   │
                          └────────────────┬─────────────────┘
                                           │
              ┌────────────────────────────┴──────────────────────┐
              │                                                   │
  ┌───────────▼────────────┐                        ┌─────────────▼───────────┐
  │   ReviewWorkflow       │                        │      CodexAgent         │
  │   (durable, for CI)    │  ◀── waivers, RPC ──▶  │  (Durable Object, 1/repo)│
  │                        │                        │                         │
  │  step: deterministic   │                        │  SQLite:  reviews       │
  │  step: judge CDX-100   │  ── progress ──▶       │           findings      │
  │  step: judge CDX-101   │                        │           waivers       │
  │  step: judge CDX-102   │                        │                         │
  │  step: judge CDX-103   │                        │  chat, adoption report  │
  │  step: apply waivers   │                        │                         │
  │  step: persist         │                        └─────────────────────────┘
  └────────────────────────┘
```

**The assignment's four components, mapped:**

| Required | Here |
| --- | --- |
| LLM | Llama 3.3 70B on Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`) as a per-rule judge |
| Workflow / coordination | A Cloudflare Workflow driving the review, one durable retried step per rule |
| User input via chat | React UI over the Agents SDK WebSocket, with a streaming chat surface |
| Memory or state | A Durable Object Agent per repository — SQLite for reviews, findings and waivers; synced state for live progress |

Plus the parts this particular team cares about: an **MCP server**, an **eval
harness** with precision/recall scoring, and the codex itself as
**policy-as-code**.

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
```

No Cloudflare account needed. Workers AI has no local implementation, so
`npm run dev` starts with remote bindings off: the five deterministic rules run
in full and the four judged rules report themselves as *degraded* — which is
exactly the path a real inference outage takes, so it is worth seeing.

For the judged rules against real Llama 3.3:

```bash
wrangler login       # or export CLOUDFLARE_API_TOKEN
npm run dev:ai
```

Other commands:

```bash
npm test             # 61 unit tests, no bindings, ~250ms
npm run evals        # score the codex against the golden fixtures
npm run typecheck
npm run build
npm run deploy       # your account; nothing is deployed for you
```

---

## The codex

Nine rules, versioned as `2026.09.1`, defined in
[`src/codex/rules.ts`](src/codex/rules.ts).

| Rule | Severity | Kind | What it catches |
| --- | --- | --- | --- |
| CDX-001 | blocking | static | Credentials committed to source |
| CDX-002 | blocking | static | CI actions pinned to a mutable tag instead of a SHA |
| CDX-003 | warning | static | Outbound calls with no timeout or abort signal |
| CDX-004 | blocking | static | Schema migrations with no rollback path |
| CDX-005 | advisory | static | New exported symbols with no doc comment |
| CDX-100 | warning | judged | Errors caught and silently discarded |
| CDX-101 | blocking | judged | Behavioural change with no test touched |
| CDX-102 | warning | judged | New failure paths with no log, metric or trace |
| CDX-103 | blocking | judged | Public contracts narrowed with no deprecation path |

The split is the design, not an implementation detail:

- **Decidable rules run as pure functions.** Free, instant, reproducible, zero
  false negatives. These are the ones you can block a merge on without argument.
- **Judgements go to the model.** One rule per call, because a single call asked
  to apply four criteria applies whichever the diff most obviously violates and
  stays quiet about the rest.

**The model never decides severity.** It answers one narrow question — does this
diff violate this one rule, and how sure are you. Severity belongs to the humans
who wrote the codex. A judged finding below the confidence threshold is demoted
to advisory rather than dropped: the author still sees it, but an unsure model
cannot stop a merge.

---

## Two orchestrations, one engine

The same rules run two ways, and the difference is about who is waiting.

**`ReviewWorkflow`** — CI and the browser. Each rule is a checkpointed,
independently retried step. A judged rule that stays broken after its retry
budget is marked `degraded` on the verdict and excluded from the decision, so the
failure mode of the gate is *"CDX-102 did not run"* rather than *"nobody can
merge"*. Progress streams to connected clients as the steps complete.

**`reviewInline`** — MCP and `/api/review`. Judged rules run concurrently, there
are no retries, and a failure degrades immediately. Someone is staring at this
before they push; a slow answer is the same as no answer.

Both persist to the same memory, so a pre-push check from the editor still counts
toward adoption.

---

## Memory

One `CodexAgent` instance per repository, addressed as
`/agents/codex-agent/<repo-slug>`. Each instance owns a private SQLite database —
no tenant column, no cross-repo query to get wrong.

**Waivers** are the part that makes a blocking codex politically survivable. A
team that cannot ship because of a control they have a real reason to break needs
an escape hatch that is *recorded* rather than one achieved by deleting the rule.
So a waiver requires a reason of at least a sentence, an accountable owner, and
an expiry — 90 days by default, because an exception that cannot expire is
indistinguishable from a disabled rule.

**Adoption** is reported per rule, worst first, with direction of travel. The
number that matters is not how many findings a rule produced; it is what fraction
of reviews it was clean on, and whether that is moving. A rule stuck at 40%
compliance is either badly specified or genuinely expensive to satisfy — and both
need a human, not a stricter gate.

---

## MCP

Six tools, at `POST /mcp`:

| Tool | Purpose |
| --- | --- |
| `codex_list_rules` | What Sentinel will enforce, before writing code |
| `codex_explain_rule` | Full rationale and remediation for one rule |
| `codex_review_diff` | Review a unified diff, get findings with fixes |
| `codex_request_waiver` | Record a time-boxed, attributed exception |
| `codex_list_waivers` | A repository's standing exceptions |
| `codex_adoption_report` | Per-rule compliance, worst first |

This is the surface that changes how the codex is actually used. A gate that only
speaks in CI tells you about a violation after you have pushed, opened a PR, and
context-switched. The same rules as MCP tools mean the agent *writing* the change
checks it before the commit and fixes it in the same turn.

```jsonc
// Claude Code / Cursor
{
  "mcpServers": {
    "sentinel": { "url": "http://localhost:5173/mcp" }
  }
}
```

Or point the inspector at it: `npx @modelcontextprotocol/inspector@latest`.

---

## Evals

A codex nobody measures is a wiki page with a CI job attached. The harness in
[`evals/`](evals) scores the rules against golden fixtures that carry both an
`expect` list and a `forbid` list — the second being the false-positive traps.

```bash
npm run evals            # deterministic rules only. Hermetic, no credentials.
npm run evals:record     # run against live Workers AI, save recordings
npm run evals:replay     # score those recordings, reproducibly
npm run evals:live       # straight to Workers AI
npm run evals -- --replay --repeat 5   # judge stability across repeats
```

All modes drive the *real* prompt-construction code in `src/codex/judge.ts`. A
harness that reimplements the prompt scores a prompt that never ships.

**Precision is weighted above recall on purpose.** A gate that misses a violation
costs one bad merge. A gate that invents one costs the reviewer's trust — and an
engineer who has been wrongly blocked once will argue with every finding
afterwards, including the correct ones. A fixture's forbidden rule firing fails
the run outright; a missed finding is reported but does not.

Current deterministic baseline, 5 fixtures:

```
rule       TP  FP  FN   precision  recall      f1
--------------------------------------------------------
CDX-001     1   0   0     100.0%  100.0%  100.0%
CDX-002     1   0   0     100.0%  100.0%  100.0%
CDX-003     1   0   0     100.0%  100.0%  100.0%
CDX-004     1   0   0     100.0%  100.0%  100.0%
CDX-005     1   0   0     100.0%  100.0%  100.0%
--------------------------------------------------------
overall     5   0   0     100.0%  100.0%  100.0%
```

Judged-rule numbers depend on the model and are not baked into the repo; run
`npm run evals:record` once to produce a corpus you can diff against later.

---

## Layout

```
src/
  codex/
    rules.ts        the codex - policy-as-code, 9 rules
    engine.ts       deterministic runner, waivers, demotion, decision
    judge.ts        prompt construction, model providers, response parsing
    review.ts       the inline (low-latency) orchestration
  agents/
    codex-agent.ts  Durable Object: SQLite memory, waivers, adoption, chat
  workflows/
    review-workflow.ts   the durable orchestration
  mcp/server.ts     6 MCP tools
  lib/              diff parser, glob matcher, domain types
  fixtures/         golden changesets, shared by the UI demo and the evals
  client/           React + shadcn/ui console
evals/              scoring harness, model providers, recordings
tests/              61 unit tests
```

The engine is free of every binding — no `env`, no Agent, no model — which is
what lets the tests and the default eval run in Node in under a second.

---

## Design decisions worth arguing with

**Why a Durable Object per repo rather than D1.** Codex memory is small,
per-repo, and read on every review. A DO gives it a private SQLite database with
no tenant column to get wrong, plus the WebSocket the UI needs for live progress,
plus the RPC surface the Workflow calls. D1 would have needed all three bolted on.

**Why one model call per rule.** Four criteria in one call gets you the most
obvious violation and silence on the rest. Separate calls also make each rule an
independently retryable Workflow step and let one rule degrade alone.

**Why waivers expire by default.** An exception that cannot expire is a deleted
rule with extra ceremony. The expiry is what forces it back in front of a human.

**Why low-confidence findings are demoted, not dropped.** Dropping them loses
signal the author might want; keeping them blocking lets an unsure model stop a
correct PR. Advisory is the honest middle.

**Why `npm run dev` does not talk to Workers AI.** Because `git clone && npm run
dev` should work. The degraded path it exercises is one you want to have seen
before it happens in production.

---

## What I would do next

- **Recordings in the repo.** The replay corpus needs one live run to generate;
  committing it would make judged-rule scores reproducible for everyone.
- **A real GitHub App.** Today CI posts a diff to `/api/review`. A proper check
  run with inline annotations is the version engineers would actually use.
- **Codex versioning with migration.** Rules change; a finding should record
  which codex version produced it so adoption trends survive a rule rewrite.
- **Per-rule confidence thresholds.** One global 0.55 is a placeholder. The eval
  harness is what would tune them per rule.
- **AI Gateway** in front of Workers AI for caching, rate limiting, and per-rule
  cost attribution.
