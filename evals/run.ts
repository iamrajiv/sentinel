import { parseArgs } from "node:util";
import { applyWaivers, decide, demoteLowConfidence, runDeterministic } from "../src/codex/engine.ts";
import { judgeRule, type ModelProvider } from "../src/codex/judge.ts";
import { CODEX, judgedRules } from "../src/codex/rules.ts";
import { FIXTURES } from "../src/fixtures/diffs.ts";
import { buildChangeSet } from "../src/lib/diff.ts";
import type { Finding } from "../src/lib/types.ts";
import { MissingRecordingError, ReplayProvider, RestApiProvider } from "./providers.ts";
import { aggregate, overall, pct, scoreFixture, type EvalOutcome } from "./score.ts";

/**
 * The eval harness.
 *
 * A codex that nobody measures is a wiki page with a CI job attached. This is
 * the thing that says whether changing a prompt, a threshold or a model made the
 * gate better or worse, and it is deliberately runnable three ways:
 *
 *   npm run evals                  deterministic rules only, hermetic, no creds
 *   npm run evals -- --replay      adds judged rules from recorded output
 *   npm run evals -- --live        adds judged rules from live Workers AI
 *   npm run evals -- --record      live, and saves recordings for --replay
 *
 * The default is the hermetic one on purpose: it runs in CI on every commit to
 * the rules, in under a second, with no account and no spend.
 */

const MODEL = process.env.SENTINEL_MODEL ?? "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const CONFIDENCE_THRESHOLD = Number(process.env.SENTINEL_CONFIDENCE ?? 0.55);

const { values } = parseArgs({
	options: {
		live: { type: "boolean", default: false },
		record: { type: "boolean", default: false },
		replay: { type: "boolean", default: false },
		repeat: { type: "string", default: "1" },
		verbose: { type: "boolean", default: false },
	},
});

const useJudge = values.live || values.record || values.replay;
const repeat = Math.max(1, Number.parseInt(values.repeat, 10) || 1);

function makeProvider(): ModelProvider | null {
	if (values.live || values.record) return RestApiProvider.fromEnv(MODEL, values.record);
	if (values.replay) return new ReplayProvider(MODEL);
	return null;
}

async function runOnce(provider: ModelProvider | null): Promise<EvalOutcome[]> {
	const outcomes: EvalOutcome[] = [];

	for (const fixture of FIXTURES) {
		const change = buildChangeSet(fixture);
		const findings: Finding[] = runDeterministic(change);
		const degraded: string[] = [];

		if (provider) {
			for (const rule of judgedRules()) {
				try {
					findings.push(...(await judgeRule(provider, rule, change)));
				} catch (error) {
					degraded.push(
						`${rule.id}: ${error instanceof MissingRecordingError ? "no recording" : describeError(error)}`,
					);
				}
			}
		} else {
			// Judged rules were not evaluated at all in the default mode. Marking
			// them degraded keeps them out of the score rather than scoring them
			// as misses, which would report a hermetic run as a broken codex.
			degraded.push(...judgedRules().map((r) => `${r.id}: not evaluated (run with --replay or --live)`));
		}

		const demoted = demoteLowConfidence(findings, CONFIDENCE_THRESHOLD);
		const { findings: kept } = applyWaivers(demoted, []);

		outcomes.push(scoreFixture(fixture, kept, degraded, decide(kept)));
	}

	return outcomes;
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------

const provider = makeProvider();
const mode = values.live || values.record ? "live" : values.replay ? "replay" : "deterministic-only";

console.log(`\nSentinel evals - ${FIXTURES.length} fixtures, ${CODEX.length} rules, mode: ${mode}`);
if (useJudge) console.log(`model: ${MODEL}   confidence threshold: ${CONFIDENCE_THRESHOLD}`);
if (repeat > 1) console.log(`repeating ${repeat}x to measure judge stability`);
console.log("");

const runs: EvalOutcome[][] = [];
for (let i = 0; i < repeat; i++) runs.push(await runOnce(provider));

const outcomes = runs[0]!;
const scores = aggregate(
	runs.flat(),
	CODEX.map((r) => r.id),
);
const totals = overall(scores);

// ---- Per fixture -----------------------------------------------------------

for (const outcome of outcomes) {
	const clean = outcome.missed.length === 0 && outcome.spurious.length === 0 && outcome.trapped.length === 0;
	console.log(`${clean ? "PASS" : "FAIL"}  ${outcome.fixtureId.padEnd(22)} decision=${outcome.decision}`);

	if (outcome.missed.length > 0) console.log(`        missed:   ${outcome.missed.join(", ")}`);
	if (outcome.spurious.length > 0) console.log(`        spurious: ${outcome.spurious.join(", ")}`);
	if (outcome.trapped.length > 0) console.log(`        TRAPPED:  ${outcome.trapped.join(", ")}  <- explicit false positive`);
	if (values.verbose && outcome.degraded.length > 0) console.log(`        degraded: ${outcome.degraded.join("; ")}`);
}

// ---- Per rule --------------------------------------------------------------

console.log("\nrule       TP  FP  FN   precision  recall      f1");
console.log("-".repeat(56));
for (const s of scores) {
	console.log(
		`${s.ruleId.padEnd(10)} ${String(s.truePositives).padStart(2)}  ${String(s.falsePositives).padStart(2)}  ${String(
			s.falseNegatives,
		).padStart(2)}     ${pct(s.precision)}  ${pct(s.recall)}  ${pct(s.f1)}`,
	);
}

console.log("-".repeat(56));
console.log(
	`${"overall".padEnd(10)} ${String(totals.truePositives).padStart(2)}  ${String(totals.falsePositives).padStart(
		2,
	)}  ${String(totals.falseNegatives).padStart(2)}     ${pct(totals.precision)}  ${pct(totals.recall)}  ${pct(totals.f1)}`,
);

// ---- Stability -------------------------------------------------------------

if (repeat > 1) {
	const signatures = runs.map((run) => run.map((o) => o.fired.join(",")).join("|"));
	const identical = signatures.every((s) => s === signatures[0]);
	console.log(`\nstability over ${repeat} runs: ${identical ? "identical" : "DIVERGED - the judge is not reproducible"}`);
}

if (!useJudge) {
	console.log(
		"\nJudged rules (CDX-1xx) were not evaluated in this mode.\n" +
			"  npm run evals -- --record   run against Workers AI and save recordings\n" +
			"  npm run evals -- --replay   score those recordings, hermetically",
	);
}

// ---- Exit code -------------------------------------------------------------
// A trapped false positive fails the run outright. Everything else is reported
// but does not fail the build, because recall on judged rules is expected to
// wobble and a flaky gate on the gate helps nobody.

const traps = outcomes.flatMap((o) => o.trapped);
if (traps.length > 0) {
	console.error(`\nFAILED: ${traps.length} forbidden rule(s) fired: ${traps.join(", ")}`);
	process.exit(1);
}

console.log("");
