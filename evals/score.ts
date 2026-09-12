import type { Finding } from "../src/lib/types.ts";
import type { Fixture } from "../src/fixtures/diffs.ts";

/**
 * Scoring for the codex.
 *
 * The single number that matters for a merge gate is **precision**, not recall.
 * A gate that misses a violation costs one bad merge. A gate that invents one
 * costs the reviewer's trust, and an engineer who has been wrongly blocked once
 * will argue with every finding afterwards - including the correct ones.
 *
 * So the harness reports both, per rule, and separately counts the
 * false-positive traps each fixture plants via `forbid`.
 */

export interface RuleScore {
	ruleId: string;
	truePositives: number;
	falsePositives: number;
	falseNegatives: number;
	precision: number;
	recall: number;
	f1: number;
}

export interface EvalOutcome {
	fixtureId: string;
	expected: string[];
	fired: string[];
	missed: string[];
	spurious: string[];
	/** Rules the fixture explicitly forbids that fired anyway. The worst failure. */
	trapped: string[];
	degraded: string[];
	decision: string;
}

export function scoreFixture(fixture: Fixture, findings: Finding[], degraded: string[], decision: string): EvalOutcome {
	const fired = [...new Set(findings.map((f) => f.ruleId))].sort();
	const expected = [...fixture.expect].sort();

	// A rule that could not run is neither a hit nor a miss - counting a degraded
	// rule as a false negative would make an outage look like a quality problem.
	const evaluated = expected.filter((id) => !degraded.some((d) => d.startsWith(id)));

	return {
		fixtureId: fixture.id,
		expected,
		fired,
		missed: evaluated.filter((id) => !fired.includes(id)),
		spurious: fired.filter((id) => !expected.includes(id)),
		trapped: fired.filter((id) => fixture.forbid.includes(id)),
		degraded,
		decision,
	};
}

export function aggregate(outcomes: EvalOutcome[], ruleIds: string[]): RuleScore[] {
	return ruleIds
		.map((ruleId) => {
			let truePositives = 0;
			let falsePositives = 0;
			let falseNegatives = 0;

			for (const outcome of outcomes) {
				if (outcome.degraded.some((d) => d.startsWith(ruleId))) continue;

				const shouldFire = outcome.expected.includes(ruleId);
				const didFire = outcome.fired.includes(ruleId);

				if (shouldFire && didFire) truePositives += 1;
				else if (!shouldFire && didFire) falsePositives += 1;
				else if (shouldFire && !didFire) falseNegatives += 1;
			}

			const precision = safeRatio(truePositives, truePositives + falsePositives);
			const recall = safeRatio(truePositives, truePositives + falseNegatives);
			const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

			return { ruleId, truePositives, falsePositives, falseNegatives, precision, recall, f1 };
		})
		.filter((s) => s.truePositives + s.falsePositives + s.falseNegatives > 0);
}

/**
 * A rule with nothing to score is 1.0, not 0.0.
 *
 * A rule that was never expected and never fired behaved perfectly; reporting it
 * as zero precision would drag the headline number down for good behaviour.
 */
function safeRatio(numerator: number, denominator: number): number {
	return denominator === 0 ? 1 : numerator / denominator;
}

export function overall(scores: RuleScore[]) {
	const tp = sum(scores.map((s) => s.truePositives));
	const fp = sum(scores.map((s) => s.falsePositives));
	const fn = sum(scores.map((s) => s.falseNegatives));

	const precision = safeRatio(tp, tp + fp);
	const recall = safeRatio(tp, tp + fn);

	return {
		truePositives: tp,
		falsePositives: fp,
		falseNegatives: fn,
		precision,
		recall,
		f1: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
	};
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export const pct = (n: number) => `${(n * 100).toFixed(1).padStart(5)}%`;
