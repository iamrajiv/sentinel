import { addedLines, visibleAfterText } from "../lib/diff.ts";
import type { ChangedFile, ChangeSet, Severity } from "../lib/types.ts";

/**
 * The Engineering Codex, as code.
 *
 * Every control an engineering org wants to enforce falls into one of two
 * buckets, and the split matters more than the rules themselves:
 *
 *   - Some controls are *decidable*. "Is this GitHub Action pinned to a SHA?"
 *     has one correct answer and a regex can find it. These run for free, in
 *     microseconds, with zero false negatives, and they are the ones you are
 *     allowed to block a merge on without argument.
 *
 *   - Some controls are *judgements*. "Does this change hide a failure from
 *     the on-call?" cannot be regexed, which is exactly why most codices state
 *     the rule in a wiki page and then never enforce it. These go to an LLM.
 *
 * Sentinel runs both and labels which is which on every finding, because an
 * engineer's trust in the bot depends on knowing whether they are arguing with
 * a regex or with a model.
 */

export interface RuleHit {
	path: string;
	line: number | null;
	message: string;
	evidence?: string;
}

interface RuleBase {
	id: string;
	title: string;
	severity: Severity;
	/** Why the control exists. Shown to engineers and given to the judge as context. */
	rationale: string;
	/** The concrete fix. Deliberately imperative - never "consider refactoring". */
	remediation: string;
}

export interface DeterministicRule extends RuleBase {
	kind: "deterministic";
	appliesTo(file: ChangedFile): boolean;
	check(file: ChangedFile, change: ChangeSet): RuleHit[];
}

export interface JudgedRule extends RuleBase {
	kind: "judged";
	/**
	 * `file` rules are asked once per matching file; `change` rules are asked
	 * once for the whole PR because the answer depends on what *else* changed.
	 */
	scope: "file" | "change";
	appliesTo(file: ChangedFile): boolean;
	/** The single question put to the model. One rule, one question. */
	question: string;
	/** Behaviour that must be flagged. Anchors the judge's threshold. */
	violationExample: string;
	/** Behaviour that must NOT be flagged. This is what suppresses false positives. */
	compliantExample: string;
}

export type Rule = DeterministicRule | JudgedRule;

// ---------------------------------------------------------------------------
// Path predicates
// ---------------------------------------------------------------------------

const SOURCE_EXT = /\.(ts|tsx|js|jsx|go|py|rs|java)$/;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$|_test\.go$/;
const WORKFLOW_PATH = /^\.github\/workflows\/.+\.ya?ml$/;
const MIGRATION_PATH = /(^|\/)migrations?\//;

const isSource = (f: ChangedFile) =>
	SOURCE_EXT.test(f.path) && !TEST_PATH.test(f.path) && f.status !== "deleted";
const isTest = (f: ChangedFile) => TEST_PATH.test(f.path);

/** Text-like files where an embedded credential is actually a credential. */
const isTextual = (f: ChangedFile) =>
	f.status !== "deleted" && !/\.(png|jpg|jpeg|gif|svg|ico|woff2?|pdf|lock)$/.test(f.path);

// ---------------------------------------------------------------------------
// CDX-001 - Secrets in source
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: Array<{ label: string; re: RegExp }> = [
	{ label: "AWS access key id", re: /\bAKIA[0-9A-Z]{16}\b/ },
	{ label: "GitHub token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
	{ label: "Slack token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
	{ label: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
	{ label: "private key block", re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/ },
	{ label: "Stripe secret key", re: /\bsk_live_[A-Za-z0-9]{16,}\b/ },
	{
		label: "hardcoded credential assignment",
		re: /\b(?:api[_-]?key|secret|password|passwd|token|client[_-]?secret)\b\s*[:=]\s*["'`][^"'`\n]{12,}["'`]/i,
	},
];

/**
 * Strings that look like secrets but are not. Without this list the rule fires
 * on every `.env.example`, test fixture and docs snippet in the repo, and a
 * blocking rule that cries wolf gets switched off within a week.
 */
const SECRET_ALLOWLIST =
	/(process\.env|import\.meta\.env|os\.getenv|env\.|Deno\.env|\$\{|<[a-z-]+>|xxx+|\.\.\.|example|placeholder|redacted|dummy|fake|changeme|\byour[_-])/i;

const secretsInSource: DeterministicRule = {
	id: "CDX-001",
	title: "No credentials committed to source",
	kind: "deterministic",
	severity: "blocking",
	rationale:
		"A credential in git history is compromised permanently, not until the next force-push. Rotation is the only remedy and it is always more expensive than the commit that caused it.",
	remediation:
		"Move the value to a secret store and read it from the environment at runtime (`wrangler secret put`, or your platform's equivalent). Then rotate the exposed credential - deleting the line does not un-leak it.",
	appliesTo: isTextual,
	check(file) {
		const hits: RuleHit[] = [];
		for (const line of addedLines(file)) {
			if (SECRET_ALLOWLIST.test(line.text)) continue;
			for (const { label, re } of SECRET_PATTERNS) {
				if (re.test(line.text)) {
					hits.push({
						path: file.path,
						line: line.line,
						message: `Possible ${label} committed to source.`,
						evidence: redact(line.text.trim()),
					});
					break; // One finding per line; the first match is enough to act on.
				}
			}
		}
		return hits;
	},
};

/**
 * Never echo a suspected secret back in full.
 *
 * The evidence string is persisted in the review record, broadcast to every
 * connected UI client, and returned over MCP - so a rule that catches a leaked
 * token and then reproduces it verbatim has moved the secret, not contained it.
 *
 * Masking long token-like runs rather than quoted strings is deliberate: the
 * first version only handled `key = "..."`, which meant an unquoted YAML value
 * (`NPM_TOKEN: ghp_...`) - the single most common way a token actually reaches
 * a repository - passed straight through.
 */
function redact(text: string): string {
	return text.replace(/[A-Za-z0-9_\-+/=]{16,}/g, (t) => `${t.slice(0, 4)}...${t.slice(-2)}`).slice(0, 160);
}

// ---------------------------------------------------------------------------
// CDX-002 - Pinned CI actions
// ---------------------------------------------------------------------------

const USES_LINE = /^\s*-?\s*uses:\s*["']?([^"'\s]+)["']?/;
const FULL_SHA = /^[0-9a-f]{40}$/;

const pinnedCiActions: DeterministicRule = {
	id: "CDX-002",
	title: "CI actions pinned to an immutable SHA",
	kind: "deterministic",
	severity: "blocking",
	rationale:
		"A tag is a mutable pointer. An attacker who moves `v3` moves it inside every workflow that trusts it, and CI runs with repository credentials. This is the supply-chain control with the worst effort-to-impact ratio to skip.",
	remediation:
		"Replace the tag with the full 40-character commit SHA and keep the tag in a trailing comment: `uses: actions/checkout@8f4b7f8... # v4.2.2`. Dependabot will still bump it.",
	appliesTo: (f) => WORKFLOW_PATH.test(f.path),
	check(file) {
		const hits: RuleHit[] = [];
		for (const line of addedLines(file)) {
			const m = USES_LINE.exec(line.text);
			if (!m) continue;

			const ref = m[1]!;
			// Local (`./.github/actions/x`) and Docker (`docker://`) uses have no SHA to pin.
			if (ref.startsWith("./") || ref.startsWith("docker://")) continue;

			const at = ref.lastIndexOf("@");
			const version = at === -1 ? "" : ref.slice(at + 1);
			if (FULL_SHA.test(version)) continue;

			hits.push({
				path: file.path,
				line: line.line,
				message:
					at === -1
						? `Action \`${ref}\` has no version pin at all.`
						: `Action \`${ref}\` is pinned to the mutable ref \`${version}\` instead of a commit SHA.`,
				evidence: line.text.trim(),
			});
		}
		return hits;
	},
};

// ---------------------------------------------------------------------------
// CDX-003 - Bounded outbound calls
// ---------------------------------------------------------------------------

const NETWORK_CALL = /\b(?:fetch|axios\.(?:get|post|put|delete)|http\.(?:Get|Post|Do)|requests\.(?:get|post))\s*\(/;
const BOUND_MARKER = /\b(?:signal|AbortSignal|AbortController|timeout|Timeout|deadline|WithTimeout|WithDeadline)\b/;

const boundedNetworkCalls: DeterministicRule = {
	id: "CDX-003",
	title: "Outbound calls are bounded by a timeout",
	kind: "deterministic",
	severity: "warning",
	rationale:
		"An unbounded call turns a slow dependency into an outage in your service: connections pile up until the pool is exhausted, and the failure surfaces far from its cause. Timeouts convert a latency problem into a fast, attributable error.",
	remediation:
		"Attach `AbortSignal.timeout(ms)` to the fetch options (or a `context.WithTimeout` in Go), and decide what the caller should see when it fires.",
	appliesTo: isSource,
	check(file) {
		const hits: RuleHit[] = [];
		const added = addedLines(file);

		for (let i = 0; i < added.length; i++) {
			const line = added[i]!;
			if (!NETWORK_CALL.test(line.text)) continue;

			// The options object is usually on the same line or the next few, so
			// look at a small forward window before concluding the call is unbounded.
			const window = added
				.slice(i, i + 6)
				.map((l) => l.text)
				.join("\n");
			if (BOUND_MARKER.test(window)) continue;

			hits.push({
				path: file.path,
				line: line.line,
				message: "Outbound call has no timeout or abort signal.",
				evidence: line.text.trim().slice(0, 160),
			});
		}
		return hits;
	},
};

// ---------------------------------------------------------------------------
// CDX-004 - Reversible migrations
// ---------------------------------------------------------------------------

// Only an explicit reverse section counts. An earlier version of this rule also
// accepted a bare `DROP TABLE` as evidence of reversibility, which inverted the
// rule: the most destructive migrations were the ones that passed it.
const ROLLBACK_MARKER = /(--\s*rollback|--\s*\+goose\s+Down|^\s*--\s*down\b|^\s*-{2,}\s*DOWN\b|def\s+downgrade)/im;

const reversibleMigrations: DeterministicRule = {
	id: "CDX-004",
	title: "Schema migrations ship with a rollback path",
	kind: "deterministic",
	severity: "blocking",
	rationale:
		"A migration without a down path makes the deploy one-way. When the release that needed it gets rolled back at 02:00, the schema does not roll back with it, and the previous version no longer boots.",
	remediation:
		"Add the reverse statements under a `-- rollback` (or `-- +goose Down`) section. If the change is genuinely irreversible, say so explicitly in the file and request a CDX-004 waiver with that reasoning.",
	appliesTo: (f) => MIGRATION_PATH.test(f.path) && f.status === "added",
	check(file) {
		if (ROLLBACK_MARKER.test(visibleAfterText(file))) return [];
		return [
			{
				path: file.path,
				line: addedLines(file)[0]?.line ?? null,
				message: "New migration has no rollback section.",
			},
		];
	},
};

// ---------------------------------------------------------------------------
// CDX-005 - Documented public surface
// ---------------------------------------------------------------------------

const EXPORTED_SYMBOL = /^\s*export\s+(?:async\s+)?(?:function|class|interface|type|const|enum)\s+([A-Za-z_$][\w$]*)/;
const DOC_LINE = /^\s*(\*|\/\*\*|\/\/|@)/;

const documentedPublicApi: DeterministicRule = {
	id: "CDX-005",
	title: "New exported symbols carry a doc comment",
	kind: "deterministic",
	severity: "advisory",
	rationale:
		"An export is a contract with every other team. The cost of writing one sentence now is paid back the first time someone reads the symbol without reading its implementation.",
	remediation: "Add a short doc comment above the export saying what it does and what the caller is responsible for.",
	appliesTo: (f) => isSource(f) && /\.tsx?$/.test(f.path),
	check(file) {
		const hits: RuleHit[] = [];

		// A symbol that also appears on a removed line is being edited, not
		// introduced. Its missing doc comment is pre-existing debt, and charging
		// this PR for it is how an advisory rule becomes background noise.
		const preexisting = new Set(
			file.lines
				.filter((l) => l.kind === "removed")
				.map((l) => EXPORTED_SYMBOL.exec(l.text)?.[1])
				.filter((name): name is string => name !== undefined),
		);

		// Walk the whole diff, not just added lines: a doc comment that already
		// existed shows up as context and must still count as documentation.
		for (let i = 0; i < file.lines.length; i++) {
			const line = file.lines[i]!;
			if (line.kind !== "added") continue;

			const m = EXPORTED_SYMBOL.exec(line.text);
			if (!m) continue;
			if (preexisting.has(m[1]!)) continue;

			const previous = file.lines[i - 1];
			if (previous && DOC_LINE.test(previous.text)) continue;

			hits.push({
				path: file.path,
				line: line.line,
				message: `Exported \`${m[1]}\` has no doc comment.`,
				evidence: line.text.trim().slice(0, 120),
			});
		}
		return hits;
	},
};

// ---------------------------------------------------------------------------
// Judged rules - the controls a regex cannot decide
// ---------------------------------------------------------------------------

const errorHandling: JudgedRule = {
	id: "CDX-100",
	title: "Failures are not silently swallowed",
	kind: "judged",
	severity: "warning",
	scope: "file",
	rationale:
		"Code that catches an error and continues as though nothing happened converts a loud failure into a silent wrong answer. The incident then starts hours later, in a different service, with no stack trace.",
	remediation:
		"Either handle the error meaningfully (retry, fall back, return a typed failure) or let it propagate. If it is genuinely ignorable, log it at warn with enough context to identify the case, and say in a comment why it is safe.",
	appliesTo: isSource,
	question:
		"Does this change introduce a code path that catches or checks an error and then continues without handling it, logging it, or propagating it?",
	violationExample:
		"`try { await save(record) } catch (e) {}` - or a catch block whose only body is `return null` / `return []`, discarding the reason the operation failed.",
	compliantExample:
		"A catch block that logs with context and rethrows, converts the error into a typed result the caller must handle, or falls back to a documented default with a comment explaining why that is safe.",
};

const observability: JudgedRule = {
	id: "CDX-102",
	title: "New failure paths are observable",
	kind: "judged",
	severity: "warning",
	scope: "file",
	rationale:
		"Whoever is paged for this code at 02:00 will not have the author available. A failure path with no log line and no metric costs an hour of bisecting to reach a conclusion the code could have stated directly.",
	remediation:
		"Emit a structured log or increment a counter on the new failure branch, including the identifiers needed to find the affected request - not just the message.",
	appliesTo: isSource,
	question:
		"Does this change add a failure, retry, or degradation path that produces no log line, metric, or trace event an on-call engineer could find it by?",
	violationExample:
		"A new `if (!response.ok) return fallbackValue` branch that emits nothing, so the fallback is invisible in production until someone notices the data is wrong.",
	compliantExample:
		"The same branch with `logger.warn({ status, requestId }, 'upstream degraded, serving fallback')`, or an existing metric already covering it.",
};

const breakingChange: JudgedRule = {
	id: "CDX-103",
	title: "Public contracts change behind a deprecation path",
	kind: "judged",
	severity: "blocking",
	scope: "file",
	rationale:
		"Internal platforms have callers the author cannot see. A renamed field or a narrowed parameter type breaks them at deploy time, and the blast radius is discovered by the consumers rather than the producer.",
	remediation:
		"Keep the old surface working for one release: add the new field alongside the old, mark the old one deprecated, and remove it only after consumers have migrated.",
	appliesTo: isSource,
	question:
		"Does this change remove, rename, or narrow an already-exported symbol, function parameter, or response field without leaving a backward-compatible path?",
	violationExample:
		"A removed line `export function getUser(id: string)` replaced by `export function getUser(opts: {id: string, tenant: string})` - every existing caller now fails to compile, and every deployed caller fails at runtime.",
	compliantExample:
		"Adding an optional parameter, adding a new field to a response, or introducing `getUserV2` while leaving `getUser` in place with a deprecation comment.",
};

const testCoverage: JudgedRule = {
	id: "CDX-101",
	title: "Behavioural changes ship with tests",
	kind: "judged",
	severity: "blocking",
	scope: "change",
	rationale:
		"An untested behavioural change is a change nobody can refactor later without fear. The test is not proof the code works today - it is permission for the next person to touch it.",
	remediation:
		"Add or update a test that fails against the previous behaviour. If the change is genuinely untestable in isolation, say why in the PR description and request a CDX-101 waiver.",
	appliesTo: isSource,
	question:
		"Taking the whole changeset together: does it alter runtime behaviour without any corresponding addition or change to a test file?",
	violationExample:
		"A new branch in pricing logic, a changed default value, or a fixed off-by-one - with every changed file under `src/` and none under `tests/`.",
	compliantExample:
		"A pure rename, a comment or documentation change, a formatting pass, a dependency bump, or any behavioural change that also touches a test file.",
};

// ---------------------------------------------------------------------------
// The codex
// ---------------------------------------------------------------------------

export const CODEX: Rule[] = [
	secretsInSource,
	pinnedCiActions,
	boundedNetworkCalls,
	reversibleMigrations,
	documentedPublicApi,
	errorHandling,
	observability,
	breakingChange,
	testCoverage,
];

export const CODEX_VERSION = "2026.09.1";

export function getRule(id: string): Rule | undefined {
	return CODEX.find((r) => r.id === id);
}

export function deterministicRules(): DeterministicRule[] {
	return CODEX.filter((r): r is DeterministicRule => r.kind === "deterministic");
}

export function judgedRules(): JudgedRule[] {
	return CODEX.filter((r): r is JudgedRule => r.kind === "judged");
}

/** Exported for CDX-101, which needs to know whether the PR touched any test. */
export function changeTouchesTests(change: ChangeSet): boolean {
	return change.files.some(isTest);
}

/** A serialisable view of the codex, for the UI and the MCP `codex_list_rules` tool. */
export function describeCodex() {
	return {
		version: CODEX_VERSION,
		rules: CODEX.map((r) => ({
			id: r.id,
			title: r.title,
			kind: r.kind,
			severity: r.severity,
			rationale: r.rationale,
			remediation: r.remediation,
		})),
	};
}
