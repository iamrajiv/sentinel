import { AgentWorkflow, type AgentWorkflowEvent, type AgentWorkflowStep } from "agents/workflows";
import type { CodexAgent } from "../agents/codex-agent.ts";
import { applyWaivers, demoteLowConfidence, runDeterministic, summarise } from "../codex/engine.ts";
import { judgeRule } from "../codex/judge.ts";
import { WorkersAIProvider } from "../codex/judge.ts";
import { CODEX, judgedRules } from "../codex/rules.ts";
import type { ChangeSet, Finding, ReviewProgress, Verdict, Waiver } from "../lib/types.ts";

/**
 * The review, as a durable multi-step job.
 *
 * A review is four to six inference calls plus a database write. Run inline in
 * the Agent, a single transient failure from the inference API loses all of it,
 * and the engineer waiting on the merge gate sees a spinner that never resolves.
 *
 * As a Workflow each rule is its own step: it retries on its own budget, its
 * result is checkpointed so a retry of a later step does not re-run it, and a
 * rule that stays broken degrades that one control instead of failing the
 * review. That last property is what makes a blocking gate acceptable to run -
 * the failure mode of the gate itself is "this rule did not run", printed on
 * the verdict, rather than "nobody can merge".
 */

export interface ReviewParams {
	reviewId: string;
	change: ChangeSet;
	/** Judged findings below this confidence are demoted to advisory. */
	confidenceThreshold: number;
}

/** Retry budget for a model call. Inference 5xx is common and almost always transient. */
const JUDGE_RETRIES = {
	retries: { limit: 3, delay: "2 seconds" as const, backoff: "exponential" as const },
	timeout: "2 minutes" as const,
};

export class ReviewWorkflow extends AgentWorkflow<CodexAgent, ReviewParams, ReviewProgress> {
	async run(event: AgentWorkflowEvent<ReviewParams>, step: AgentWorkflowStep): Promise<Verdict> {
		const { reviewId, change, confidenceThreshold } = event.payload;
		const startedAt = new Date().toISOString();
		const model = this.env.SENTINEL_MODEL;

		const progress = (patch: Omit<ReviewProgress, "reviewId">) => this.reportProgress({ reviewId, ...patch });

		// ---- 1. Decidable rules -------------------------------------------
		// Free, instant, and deterministic, so they run first: if the diff has a
		// hardcoded credential we want that on screen before any model is called.
		await progress({
			phase: "deterministic",
			label: "Running deterministic controls",
			percent: 0.15,
			detail: `${change.files.length} file(s)`,
		});

		const deterministic = await step.do("deterministic-rules", async () => runDeterministic(change));

		// ---- 2. Judged rules, one durable step each ------------------------
		const judged = judgedRules();
		const provider = new WorkersAIProvider(this.env.AI, model);

		const judgedFindings: Finding[] = [];
		const degraded: string[] = [];

		for (const [index, rule] of judged.entries()) {
			await progress({
				phase: "judging",
				label: `Judging ${rule.id}`,
				percent: 0.2 + (0.6 * index) / judged.length,
				detail: rule.title,
			});

			try {
				const findings = await step.do(`judge-${rule.id}`, JUDGE_RETRIES, async () =>
					judgeRule(provider, rule, change),
				);
				judgedFindings.push(...findings);
			} catch (error) {
				// Retries are exhausted. Record the gap on the verdict rather than
				// failing the review - a reviewer who knows CDX-102 did not run can
				// decide what to do; a review that never returns tells them nothing.
				degraded.push(`${rule.id} (${error instanceof Error ? error.message : "unknown error"})`);
			}
		}

		// ---- 3. Standing exceptions ---------------------------------------
		await progress({ phase: "waivers", label: "Applying waivers", percent: 0.85 });

		const waivers = await step.do("load-waivers", async () => {
			return (await this.agent.getActiveWaivers()) as Waiver[];
		});

		const all = demoteLowConfidence([...deterministic, ...judgedFindings], confidenceThreshold);
		const { findings, waived } = applyWaivers(all, waivers);

		const verdict = summarise({
			reviewId,
			change,
			findings,
			waived,
			rulesEvaluated: CODEX.length - degraded.length,
			model,
			startedAt,
			degraded,
		});

		// ---- 4. Persist and publish ---------------------------------------
		await progress({
			phase: "persisting",
			label: "Recording verdict",
			percent: 0.95,
			detail: `${verdict.decision} - ${verdict.findings.length} finding(s)`,
		});

		await step.do("persist-verdict", async () => {
			await this.agent.persistVerdict(verdict);
		});

		await step.reportComplete(verdict);
		return verdict;
	}
}
