import { renderForPrompt } from "../lib/diff.ts";
import type { ChangedFile, ChangeSet, Finding } from "../lib/types.ts";
import { changeTouchesTests, type JudgedRule } from "./rules.ts";

/**
 * The LLM half of the codex.
 *
 * Design constraints that shaped this file:
 *
 *  1. **One rule per call.** It is tempting to hand the model all four judged
 *     rules and one diff. In practice a single call asked to apply four
 *     criteria applies whichever one the diff most obviously violates and stays
 *     quiet about the rest. Separate calls also mean a rule that fails or times
 *     out degrades only itself, and each becomes an independently retryable
 *     Workflow step.
 *
 *  2. **The model never decides severity.** Severity is a property of the rule,
 *     set by the humans who wrote the codex. The model answers one narrow
 *     question: does this diff violate this rule, and how sure are you.
 *
 *  3. **The provider is injectable.** Evals run the exact same prompt
 *     construction against recorded fixtures, so the harness scores the real
 *     prompt rather than an approximation of it.
 */

export interface CompletionRequest {
	system: string;
	prompt: string;
	maxTokens?: number;
	temperature?: number;
	/** Stable identifier for the (rule, target) pair, used by the replay provider. */
	cacheKey: string;
}

export interface ModelProvider {
	readonly name: string;
	complete(request: CompletionRequest): Promise<string>;
}

/** Workers AI, called through the `AI` binding. No API keys, no egress. */
export class WorkersAIProvider implements ModelProvider {
	readonly name: string;

	constructor(
		private readonly ai: Ai,
		model: string,
	) {
		this.name = model;
	}

	async complete(request: CompletionRequest): Promise<string> {
		const response = (await this.ai.run(this.name as keyof AiModels, {
			messages: [
				{ role: "system", content: request.system },
				{ role: "user", content: request.prompt },
			],
			max_tokens: request.maxTokens ?? 700,
			// Judgement should be reproducible run to run. The eval harness measures
			// stability across repeats, and anything above ~0.2 makes that number
			// meaningless without telling us anything useful about the code.
			temperature: request.temperature ?? 0.1,
		} as never)) as { response?: string } | string;

		if (typeof response === "string") return response;
		return response.response ?? "";
	}
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are Sentinel, a code review gate that enforces one engineering standard at a time.

You will be given exactly one rule and one code change. Decide only whether the change violates that one rule. Ignore every other quality concern, however obvious - another rule owns it.

Rules of engagement:
- Judge only lines marked with "+". Lines marked "-" or unmarked are there for context and must never be reported.
- Report a violation only when the evidence is visible in the diff. Never infer what the rest of the file probably does.
- When you are not sure, return no violations. A missed finding costs one review; a false one costs the reviewer's trust in every future review.
- Do not assign severity, and do not comment on style, naming, or formatting.

Reply with JSON only - no prose, no markdown fence:
{"violations":[{"line":<number from the diff gutter>,"message":"<one sentence, present tense, addressed to the author>","evidence":"<the offending line, verbatim>","confidence":<0.0-1.0>}]}

An empty list is a valid and common answer: {"violations":[]}`;

function buildPrompt(rule: JudgedRule, body: string, extraContext?: string): string {
	return [
		`# Rule ${rule.id}: ${rule.title}`,
		"",
		`Why this rule exists: ${rule.rationale}`,
		"",
		`## The question`,
		rule.question,
		"",
		`## Report a violation when`,
		rule.violationExample,
		"",
		`## Do NOT report when`,
		rule.compliantExample,
		...(extraContext ? ["", `## Changeset context`, extraContext] : []),
		"",
		`## The change`,
		"```diff",
		body,
		"```",
		"",
		"JSON:",
	].join("\n");
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

interface RawViolation {
	line?: unknown;
	message?: unknown;
	evidence?: unknown;
	confidence?: unknown;
}

/**
 * Pull the JSON object out of a model response.
 *
 * Instruction-tuned models add a fence or a sentence of preamble often enough
 * that treating that as an error would throw away a usable answer. We take the
 * outermost braces and parse those.
 */
export function extractViolations(raw: string): RawViolation[] {
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start === -1 || end <= start) return [];

	try {
		const parsed = JSON.parse(raw.slice(start, end + 1)) as { violations?: unknown };
		return Array.isArray(parsed.violations) ? (parsed.violations as RawViolation[]) : [];
	} catch {
		return [];
	}
}

function toFinding(rule: JudgedRule, path: string, raw: RawViolation): Finding | null {
	const message = typeof raw.message === "string" ? raw.message.trim() : "";
	if (message.length === 0) return null;

	const line = typeof raw.line === "number" && Number.isFinite(raw.line) ? Math.trunc(raw.line) : null;
	const confidence =
		typeof raw.confidence === "number" && raw.confidence >= 0 && raw.confidence <= 1 ? raw.confidence : 0.5;

	return {
		ruleId: rule.id,
		ruleTitle: rule.title,
		severity: rule.severity,
		source: "judged",
		path,
		line,
		message,
		remediation: rule.remediation,
		evidence: typeof raw.evidence === "string" ? raw.evidence.slice(0, 200) : undefined,
		confidence,
	};
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Ask the judge about one rule against one file. */
export async function judgeFile(
	provider: ModelProvider,
	rule: JudgedRule,
	file: ChangedFile,
): Promise<Finding[]> {
	const raw = await provider.complete({
		system: SYSTEM_PROMPT,
		prompt: buildPrompt(rule, renderForPrompt(file)),
		cacheKey: `${rule.id}:${file.path}`,
	});

	return extractViolations(raw)
		.map((v) => toFinding(rule, file.path, v))
		.filter((f): f is Finding => f !== null);
}

/** Ask the judge about one rule against the whole changeset. */
export async function judgeChange(
	provider: ModelProvider,
	rule: JudgedRule,
	change: ChangeSet,
): Promise<Finding[]> {
	const relevant = change.files.filter((f) => rule.appliesTo(f));
	if (relevant.length === 0) return [];

	// Change-scoped rules need the shape of the whole PR, not just the source
	// files they apply to. CDX-101 in particular is unanswerable without knowing
	// that no test file was touched - a fact that lives outside `relevant`.
	const manifest = change.files.map((f) => `${f.status.padEnd(8)} ${f.path} (+${f.additions}/-${f.deletions})`).join("\n");

	const context = [
		`PR title: ${change.title}`,
		`Files in this changeset:`,
		manifest,
		`Any test file touched: ${changeTouchesTests(change) ? "yes" : "no"}`,
	].join("\n");

	const body = relevant.map((f) => renderForPrompt(f, 80)).join("\n\n");

	const raw = await provider.complete({
		system: SYSTEM_PROMPT,
		prompt: buildPrompt(rule, body, context),
		cacheKey: `${rule.id}:__change__`,
		maxTokens: 900,
	});

	return extractViolations(raw)
		.map((v) => toFinding(rule, relevant[0]!.path, v))
		.filter((f): f is Finding => f !== null);
}

/** Run one judged rule, dispatching on its scope. */
export async function judgeRule(
	provider: ModelProvider,
	rule: JudgedRule,
	change: ChangeSet,
): Promise<Finding[]> {
	if (rule.scope === "change") return judgeChange(provider, rule, change);

	const targets = change.files.filter((f) => rule.appliesTo(f));
	const results = await Promise.all(targets.map((file) => judgeFile(provider, rule, file)));
	return results.flat();
}

/** Exposed so the eval harness can assert on the exact prompt text that ships. */
export const __promptInternals = { SYSTEM_PROMPT, buildPrompt };
