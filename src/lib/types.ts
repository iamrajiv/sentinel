/**
 * Core domain types for Sentinel.
 *
 * The vocabulary here is deliberately small: a *review* runs a *codex* (a set of
 * rules) against a *change* (a parsed diff) and produces a *verdict* made of
 * *findings*. Everything else in the system is plumbing around those five nouns.
 */

/** How much a violation matters. Only `blocking` can fail a build. */
export type Severity = "blocking" | "warning" | "advisory";

/**
 * How a rule reaches its conclusion.
 *
 * `deterministic` rules are pure functions over the diff — same input, same
 * output, no model call, free and instant. `judged` rules ask an LLM, because
 * the thing being checked ("does this swallow errors?") has no regex.
 */
export type RuleKind = "deterministic" | "judged";

/** Final decision for a review. `block` means at least one unwaived blocking finding. */
export type Decision = "pass" | "warn" | "block";

/** A single line touched by the diff. */
export interface DiffLine {
	/** Line number in the post-change file. Null for removed lines. */
	line: number | null;
	kind: "added" | "removed" | "context";
	text: string;
}

/** One file's worth of change, parsed out of a unified diff. */
export interface ChangedFile {
	path: string;
	/** Previous path when the file was renamed, otherwise identical to `path`. */
	previousPath: string;
	status: "added" | "modified" | "deleted" | "renamed";
	lines: DiffLine[];
	additions: number;
	deletions: number;
}

/** The full unit of work a review operates on. */
export interface ChangeSet {
	repo: string;
	pr: number;
	title: string;
	author: string;
	files: ChangedFile[];
}

/** A single rule violation. */
export interface Finding {
	ruleId: string;
	ruleTitle: string;
	severity: Severity;
	source: RuleKind;
	path: string;
	line: number | null;
	/** What is wrong, in one sentence, addressed to the engineer who wrote it. */
	message: string;
	/** The concrete next action. Never "consider improving this". */
	remediation: string;
	/** The offending snippet, so the finding can be trusted without opening the file. */
	evidence?: string;
	/** Judge confidence in [0,1]. Deterministic findings are always 1. */
	confidence: number;
}

/** A finding that matched a live waiver and was therefore demoted. */
export interface WaivedFinding extends Finding {
	waiverId: string;
	waiverReason: string;
	waiverExpiresAt: string | null;
}

/** A standing exception to a rule, scoped to a path pattern. */
export interface Waiver {
	id: string;
	ruleId: string;
	/** Glob matched against the file path. `*` and `**` supported. */
	pathGlob: string;
	reason: string;
	grantedBy: string;
	/** ISO timestamp, or null for a permanent waiver. */
	expiresAt: string | null;
	createdAt: string;
}

/** The output of a completed review. */
export interface Verdict {
	reviewId: string;
	repo: string;
	pr: number;
	decision: Decision;
	findings: Finding[];
	waived: WaivedFinding[];
	stats: {
		filesChanged: number;
		rulesEvaluated: number;
		blocking: number;
		warning: number;
		advisory: number;
		waived: number;
	};
	model: string;
	startedAt: string;
	finishedAt: string;
	/** Populated when one or more judged rules failed to evaluate. */
	degraded?: string[];
}

/** Progress event streamed from the workflow to connected UI clients. */
export interface ReviewProgress {
	reviewId: string;
	phase: "parsing" | "deterministic" | "judging" | "waivers" | "persisting" | "done" | "failed";
	label: string;
	/** Fraction complete in [0,1]. */
	percent: number;
	detail?: string;
}
