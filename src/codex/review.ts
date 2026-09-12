import type { ChangeSet, Verdict, Waiver } from "../lib/types.ts";
import { applyWaivers, demoteLowConfidence, runDeterministic, summarise } from "./engine.ts";
import { judgeRule, WorkersAIProvider, type ModelProvider } from "./judge.ts";
import { CODEX, judgedRules } from "./rules.ts";

/**
 * A review run to completion in a single request.
 *
 * Sentinel has two orchestrations over the same engine, and the difference is
 * about who is waiting:
 *
 *   - The **Workflow** path (CI, webhooks) optimises for never losing a review.
 *     Each rule is a checkpointed, independently retried step. It can take
 *     minutes and nobody is watching.
 *
 *   - This path (MCP, from the engineer's editor) optimises for latency. The
 *     judged rules run concurrently, there are no retries, and a rule that
 *     fails is reported as degraded immediately. Someone is staring at it
 *     before they push, and a slow answer is the same as no answer.
 *
 * Both produce the same `Verdict` from the same rules, and both persist to the
 * same memory - so a pre-push check in the editor still counts toward adoption.
 */
export async function reviewInline(options: {
	reviewId: string;
	change: ChangeSet;
	provider: ModelProvider;
	waivers: Waiver[];
	confidenceThreshold?: number;
}): Promise<Verdict> {
	const { reviewId, change, provider, waivers } = options;
	const startedAt = new Date().toISOString();

	const deterministic = runDeterministic(change);

	const settled = await Promise.allSettled(judgedRules().map((rule) => judgeRule(provider, rule, change)));

	const judged = settled.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
	const degraded = settled.flatMap((r, i) =>
		r.status === "rejected" ? [`${judgedRules()[i]!.id} (${describeError(r.reason)})`] : [],
	);

	const all = demoteLowConfidence([...deterministic, ...judged], options.confidenceThreshold ?? 0.55);
	const { findings, waived } = applyWaivers(all, waivers);

	return summarise({
		reviewId,
		change,
		findings,
		waived,
		rulesEvaluated: CODEX.length - degraded.length,
		model: provider.name,
		startedAt,
		degraded,
	});
}

export function providerFor(env: Env): ModelProvider {
	return new WorkersAIProvider(env.AI, env.SENTINEL_MODEL);
}

function describeError(reason: unknown): string {
	return reason instanceof Error ? reason.message : String(reason);
}

/** Render a verdict as the plain text an engineer reads in a terminal or chat. */
export function formatVerdict(verdict: Verdict): string {
	const icon = { pass: "PASS", warn: "WARN", block: "BLOCK" }[verdict.decision];
	const lines: string[] = [
		`${icon} - ${verdict.repo}#${verdict.pr}`,
		`${verdict.stats.filesChanged} file(s), ${verdict.stats.rulesEvaluated} rule(s) evaluated, model ${verdict.model}`,
		"",
	];

	if (verdict.findings.length === 0) {
		lines.push("No findings. The change satisfies every rule in the codex.");
	} else {
		for (const f of verdict.findings) {
			const where = f.line === null ? f.path : `${f.path}:${f.line}`;
			const via = f.source === "judged" ? ` [judged, confidence ${f.confidence.toFixed(2)}]` : "";
			lines.push(`${f.severity.toUpperCase()} ${f.ruleId} ${where}${via}`);
			lines.push(`  ${f.message}`);
			lines.push(`  Fix: ${f.remediation}`);
			if (f.evidence) lines.push(`  > ${f.evidence}`);
			lines.push("");
		}
	}

	if (verdict.waived.length > 0) {
		lines.push(`Waived (${verdict.waived.length}):`);
		for (const w of verdict.waived) {
			lines.push(`  ${w.ruleId} ${w.path} - "${w.waiverReason}" (expires ${w.waiverExpiresAt ?? "never"})`);
		}
		lines.push("");
	}

	if (verdict.degraded && verdict.degraded.length > 0) {
		lines.push(`Degraded - these rules did not run: ${verdict.degraded.join(", ")}`);
	}

	return lines.join("\n").trimEnd();
}
