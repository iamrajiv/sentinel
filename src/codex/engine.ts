import { matchesGlob } from "../lib/glob.ts";
import type { ChangeSet, Decision, Finding, Severity, Verdict, WaivedFinding, Waiver } from "../lib/types.ts";
import { deterministicRules, type RuleHit } from "./rules.ts";

/**
 * The parts of a review that are pure functions: run the decidable rules,
 * subtract standing exceptions, and turn what is left into a decision.
 *
 * Keeping these free of the Agent, the Workflow and the model is what makes the
 * eval harness possible - the same functions run in CI with no bindings at all.
 */

/** Run every deterministic rule that applies, across every file in the change. */
export function runDeterministic(change: ChangeSet): Finding[] {
	const findings: Finding[] = [];

	for (const rule of deterministicRules()) {
		for (const file of change.files) {
			if (!rule.appliesTo(file)) continue;

			let hits: RuleHit[];
			try {
				hits = rule.check(file, change);
			} catch (error) {
				// A rule that throws is a bug in the rule, not in the PR under review.
				// Skipping it degrades this one control rather than failing the review.
				console.error(`rule ${rule.id} threw on ${file.path}:`, error);
				continue;
			}

			for (const hit of hits) {
				findings.push({
					ruleId: rule.id,
					ruleTitle: rule.title,
					severity: rule.severity,
					source: "deterministic",
					path: hit.path,
					line: hit.line,
					message: hit.message,
					remediation: rule.remediation,
					evidence: hit.evidence,
					confidence: 1,
				});
			}
		}
	}

	return findings;
}

/**
 * Split findings into those that stand and those covered by a live waiver.
 *
 * Waivers are the pressure valve that keeps a blocking codex politically
 * survivable: a team that cannot ship because of a control they have a real
 * reason to break needs an escape hatch that is *recorded* rather than one that
 * is achieved by deleting the rule.
 */
export function applyWaivers(
	findings: Finding[],
	waivers: Waiver[],
	now: Date = new Date(),
): { findings: Finding[]; waived: WaivedFinding[] } {
	const live = waivers.filter((w) => w.expiresAt === null || new Date(w.expiresAt) > now);

	const kept: Finding[] = [];
	const waived: WaivedFinding[] = [];

	for (const finding of findings) {
		const match = live.find((w) => w.ruleId === finding.ruleId && matchesGlob(w.pathGlob, finding.path));
		if (match) {
			waived.push({
				...finding,
				waiverId: match.id,
				waiverReason: match.reason,
				waiverExpiresAt: match.expiresAt,
			});
		} else {
			kept.push(finding);
		}
	}

	return { findings: kept, waived };
}

/**
 * Demote findings the judge was not confident about.
 *
 * A model that reports a blocking violation at 0.4 confidence should not be able
 * to stop a merge. Demoting rather than dropping keeps the signal visible to the
 * author while making the failure mode "slightly noisy" instead of "blocks a
 * correct PR", which is the only trade-off worth making in a merge gate.
 */
export function demoteLowConfidence(findings: Finding[], threshold: number): Finding[] {
	return findings.map((f) => {
		if (f.source !== "judged" || f.confidence >= threshold) return f;
		return { ...f, severity: "advisory" as Severity };
	});
}

export function decide(findings: Finding[]): Decision {
	if (findings.some((f) => f.severity === "blocking")) return "block";
	if (findings.some((f) => f.severity === "warning")) return "warn";
	return "pass";
}

export function summarise(input: {
	reviewId: string;
	change: ChangeSet;
	findings: Finding[];
	waived: WaivedFinding[];
	rulesEvaluated: number;
	model: string;
	startedAt: string;
	degraded?: string[];
}): Verdict {
	const { findings, waived } = input;

	const verdict: Verdict = {
		reviewId: input.reviewId,
		repo: input.change.repo,
		pr: input.change.pr,
		decision: decide(findings),
		findings: [...findings].sort(bySeverityThenPath),
		waived,
		stats: {
			filesChanged: input.change.files.length,
			rulesEvaluated: input.rulesEvaluated,
			blocking: findings.filter((f) => f.severity === "blocking").length,
			warning: findings.filter((f) => f.severity === "warning").length,
			advisory: findings.filter((f) => f.severity === "advisory").length,
			waived: waived.length,
		},
		model: input.model,
		startedAt: input.startedAt,
		finishedAt: new Date().toISOString(),
	};

	if (input.degraded && input.degraded.length > 0) verdict.degraded = input.degraded;
	return verdict;
}

const SEVERITY_ORDER: Record<Severity, number> = { blocking: 0, warning: 1, advisory: 2 };

function bySeverityThenPath(a: Finding, b: Finding): number {
	const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
	if (bySeverity !== 0) return bySeverity;
	if (a.path !== b.path) return a.path.localeCompare(b.path);
	return (a.line ?? 0) - (b.line ?? 0);
}
