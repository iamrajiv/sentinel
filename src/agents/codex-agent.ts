import { Agent, callable, type StreamingResponse } from "agents";
import { buildChangeSet } from "../lib/diff.ts";
import type { ReviewProgress, Verdict, Waiver } from "../lib/types.ts";
import { CODEX, CODEX_VERSION, describeCodex, getRule } from "../codex/rules.ts";

/**
 * The durable half of Sentinel.
 *
 * One instance per repository. That partitioning is the whole reason this is an
 * Agent and not a stateless Worker: a codex is only useful if it *remembers* -
 * which exceptions this repo was granted, which rules it keeps tripping, whether
 * adoption is improving. All of that is per-repo, all of it is small, and none
 * of it wants to be a shared database with a tenant column.
 *
 * The instance name is the repo slug, so `/agents/codex-agent/acme-api` is the
 * codex memory for acme/api and nothing else can see it.
 */

export interface ReviewRequest {
	repo: string;
	pr: number;
	title: string;
	author: string;
	patch: string;
}

export interface CodexState {
	repo: string;
	codexVersion: string;
	/** Live progress of the running review, or null when idle. */
	active: ReviewProgress | null;
	/** The most recent completed verdict, kept small enough to broadcast. */
	lastVerdict: Verdict | null;
	reviewCount: number;
	waiverCount: number;
}

interface ReviewRow {
	id: string;
	pr: number;
	decision: string;
	blocking: number;
	warning: number;
	advisory: number;
	waived: number;
	model: string;
	created_at: string;
	verdict_json: string;
}

interface WaiverRow {
	id: string;
	rule_id: string;
	path_glob: string;
	reason: string;
	granted_by: string;
	expires_at: string | null;
	created_at: string;
}

export class CodexAgent extends Agent<Env, CodexState> {
	initialState: CodexState = {
		repo: "unknown",
		codexVersion: CODEX_VERSION,
		active: null,
		lastVerdict: null,
		reviewCount: 0,
		waiverCount: 0,
	};

	async onStart() {
		// Each Agent instance owns a private SQLite database, so this is DDL against
		// one repo's data - no tenant column, no cross-repo query to get wrong.
		this.sql`
			CREATE TABLE IF NOT EXISTS reviews (
				id           TEXT PRIMARY KEY,
				pr           INTEGER NOT NULL,
				decision     TEXT NOT NULL,
				blocking     INTEGER NOT NULL DEFAULT 0,
				warning      INTEGER NOT NULL DEFAULT 0,
				advisory     INTEGER NOT NULL DEFAULT 0,
				waived       INTEGER NOT NULL DEFAULT 0,
				model        TEXT NOT NULL,
				created_at   TEXT NOT NULL,
				verdict_json TEXT NOT NULL
			)`;

		this.sql`
			CREATE TABLE IF NOT EXISTS findings (
				id         INTEGER PRIMARY KEY AUTOINCREMENT,
				review_id  TEXT NOT NULL,
				rule_id    TEXT NOT NULL,
				severity   TEXT NOT NULL,
				source     TEXT NOT NULL,
				path       TEXT NOT NULL,
				line       INTEGER,
				message    TEXT NOT NULL,
				created_at TEXT NOT NULL
			)`;

		this.sql`
			CREATE TABLE IF NOT EXISTS waivers (
				id         TEXT PRIMARY KEY,
				rule_id    TEXT NOT NULL,
				path_glob  TEXT NOT NULL,
				reason     TEXT NOT NULL,
				granted_by TEXT NOT NULL,
				expires_at TEXT,
				created_at TEXT NOT NULL
			)`;

		// Adoption reporting always filters by time then groups by rule.
		this.sql`CREATE INDEX IF NOT EXISTS idx_findings_created ON findings (created_at)`;
		this.sql`CREATE INDEX IF NOT EXISTS idx_findings_rule ON findings (rule_id)`;
	}

	// -----------------------------------------------------------------------
	// Reviews
	// -----------------------------------------------------------------------

	/**
	 * Start a review. Returns immediately with an id; the verdict arrives over
	 * the WebSocket as state updates.
	 *
	 * The actual work goes to a Workflow rather than running inline because a
	 * judged review is four-plus model calls. Inline, one transient 500 from the
	 * inference API loses the whole review. As Workflow steps, each rule retries
	 * independently and the review survives.
	 */
	@callable()
	async reviewDiff(request: ReviewRequest): Promise<{ reviewId: string; workflowId: string }> {
		const change = buildChangeSet(request);
		if (change.files.length === 0) {
			throw new Error("No files found in the supplied patch - is it a unified diff?");
		}

		const reviewId = crypto.randomUUID();

		this.setState({
			...this.state,
			repo: request.repo,
			active: {
				reviewId,
				phase: "parsing",
				label: "Parsing diff",
				percent: 0.05,
				detail: `${change.files.length} file(s)`,
			},
		});

		const workflowId = await this.runWorkflow("REVIEW_WORKFLOW", {
			reviewId,
			change,
			confidenceThreshold: 0.55,
		});

		return { reviewId, workflowId };
	}

	/** Called by the Workflow over RPC once a verdict is final. */
	async persistVerdict(verdict: Verdict): Promise<void> {
		this.sql`
			INSERT OR REPLACE INTO reviews
				(id, pr, decision, blocking, warning, advisory, waived, model, created_at, verdict_json)
			VALUES (
				${verdict.reviewId}, ${verdict.pr}, ${verdict.decision},
				${verdict.stats.blocking}, ${verdict.stats.warning}, ${verdict.stats.advisory},
				${verdict.stats.waived}, ${verdict.model}, ${verdict.finishedAt},
				${JSON.stringify(verdict)}
			)`;

		for (const f of verdict.findings) {
			this.sql`
				INSERT INTO findings (review_id, rule_id, severity, source, path, line, message, created_at)
				VALUES (${verdict.reviewId}, ${f.ruleId}, ${f.severity}, ${f.source}, ${f.path}, ${f.line}, ${f.message}, ${verdict.finishedAt})`;
		}

		const [row] = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM reviews`;

		this.setState({
			...this.state,
			repo: verdict.repo,
			active: null,
			lastVerdict: verdict,
			reviewCount: row?.n ?? this.state.reviewCount + 1,
		});
	}

	@callable()
	getVerdict(reviewId: string): Verdict | null {
		const [row] = this.sql<Pick<ReviewRow, "verdict_json">>`
			SELECT verdict_json FROM reviews WHERE id = ${reviewId}`;
		return row ? (JSON.parse(row.verdict_json) as Verdict) : null;
	}

	@callable()
	listReviews(limit = 20): Array<Omit<ReviewRow, "verdict_json">> {
		return this.sql<Omit<ReviewRow, "verdict_json">>`
			SELECT id, pr, decision, blocking, warning, advisory, waived, model, created_at
			FROM reviews ORDER BY created_at DESC LIMIT ${limit}`;
	}

	// -----------------------------------------------------------------------
	// Waivers - the recorded exception workflow
	// -----------------------------------------------------------------------

	/** Every non-expired waiver. Read by the Workflow before it decides. */
	getActiveWaivers(): Waiver[] {
		const now = new Date().toISOString();
		return this.sql<WaiverRow>`
			SELECT * FROM waivers
			WHERE expires_at IS NULL OR expires_at > ${now}
			ORDER BY created_at DESC`.map(toWaiver);
	}

	@callable()
	listWaivers(): Waiver[] {
		return this.sql<WaiverRow>`SELECT * FROM waivers ORDER BY created_at DESC`.map(toWaiver);
	}

	/**
	 * Record an exception to a rule.
	 *
	 * `expiresInDays` defaults to 90 rather than never: an exception that cannot
	 * expire is indistinguishable from deleting the rule, and the whole point of
	 * routing exceptions through here is that someone has to look at them again.
	 */
	@callable()
	grantWaiver(input: {
		ruleId: string;
		pathGlob: string;
		reason: string;
		grantedBy: string;
		expiresInDays?: number | null;
	}): Waiver {
		if (!getRule(input.ruleId)) {
			throw new Error(`Unknown rule ${input.ruleId}. Valid ids: ${CODEX.map((r) => r.id).join(", ")}`);
		}
		if (input.reason.trim().length < 10) {
			throw new Error("A waiver needs a reason someone can evaluate later - at least a sentence.");
		}

		const days = input.expiresInDays === null ? null : (input.expiresInDays ?? 90);
		const waiver: Waiver = {
			id: crypto.randomUUID(),
			ruleId: input.ruleId,
			pathGlob: input.pathGlob,
			reason: input.reason.trim(),
			grantedBy: input.grantedBy,
			expiresAt: days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString(),
			createdAt: new Date().toISOString(),
		};

		this.sql`
			INSERT INTO waivers (id, rule_id, path_glob, reason, granted_by, expires_at, created_at)
			VALUES (${waiver.id}, ${waiver.ruleId}, ${waiver.pathGlob}, ${waiver.reason}, ${waiver.grantedBy}, ${waiver.expiresAt}, ${waiver.createdAt})`;

		this.setState({ ...this.state, waiverCount: this.listWaivers().length });
		return waiver;
	}

	@callable()
	revokeWaiver(id: string): boolean {
		const before = this.listWaivers().length;
		this.sql`DELETE FROM waivers WHERE id = ${id}`;
		const after = this.listWaivers().length;
		this.setState({ ...this.state, waiverCount: after });
		return after < before;
	}

	// -----------------------------------------------------------------------
	// Adoption - "is the codex actually working?"
	// -----------------------------------------------------------------------

	/**
	 * Per-rule adoption over a trailing window.
	 *
	 * The number that matters is not how many findings a rule produced - it is
	 * what fraction of reviews it was clean on, and whether that fraction is
	 * moving. A rule stuck at 40% compliance is either badly specified or
	 * genuinely hard to satisfy, and both need a human, not a stricter gate.
	 */
	@callable()
	adoptionReport(days = 30) {
		const since = new Date(Date.now() - days * 86_400_000).toISOString();
		const midpoint = new Date(Date.now() - (days / 2) * 86_400_000).toISOString();

		const [totals] = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM reviews WHERE created_at >= ${since}`;
		const total = totals?.n ?? 0;

		const hit = this.sql<{ rule_id: string; reviews_hit: number; findings: number }>`
			SELECT rule_id,
			       COUNT(DISTINCT review_id) AS reviews_hit,
			       COUNT(*) AS findings
			FROM findings WHERE created_at >= ${since}
			GROUP BY rule_id`;

		const recent = this.sql<{ rule_id: string; reviews_hit: number }>`
			SELECT rule_id, COUNT(DISTINCT review_id) AS reviews_hit
			FROM findings WHERE created_at >= ${midpoint}
			GROUP BY rule_id`;

		const [recentTotals] = this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM reviews WHERE created_at >= ${midpoint}`;
		const recentTotal = recentTotals?.n ?? 0;

		const rules = CODEX.map((rule) => {
			const all = hit.find((h) => h.rule_id === rule.id);
			const late = recent.find((h) => h.rule_id === rule.id);

			const compliance = total === 0 ? 1 : 1 - (all?.reviews_hit ?? 0) / total;
			const recentCompliance = recentTotal === 0 ? compliance : 1 - (late?.reviews_hit ?? 0) / recentTotal;

			return {
				ruleId: rule.id,
				title: rule.title,
				kind: rule.kind,
				severity: rule.severity,
				findings: all?.findings ?? 0,
				reviewsHit: all?.reviews_hit ?? 0,
				compliance: round(compliance),
				trend: total === 0 ? "flat" : describeTrend(recentCompliance - compliance),
			};
		}).sort((a, b) => a.compliance - b.compliance);

		return { windowDays: days, reviews: total, codexVersion: CODEX_VERSION, rules };
	}

	@callable()
	getCodex() {
		return describeCodex();
	}

	// -----------------------------------------------------------------------
	// Chat - the human interface to all of the above
	// -----------------------------------------------------------------------

	/**
	 * Answer questions about this repo's codex, its findings, and its waivers.
	 *
	 * The interesting part is not the model call, it is what goes into the
	 * prompt. A general "explain this rule" answer is worthless - engineers can
	 * read the rule. What they actually ask is "why did *this* fail on *my* PR
	 * when the same pattern is everywhere else", and answering that needs the
	 * verdict, the waivers and the adoption history in context. That assembly is
	 * the whole feature.
	 */
	@callable({ streaming: true })
	async chat(stream: StreamingResponse, message: string): Promise<void> {
		try {
			const system = this.buildChatContext();

			const raw = (await this.env.AI.run(
				this.env.SENTINEL_MODEL as keyof AiModels,
				{
					messages: [
						{ role: "system", content: system },
						{ role: "user", content: message },
					],
					max_tokens: 800,
					temperature: 0.3,
					stream: true,
				} as never,
			)) as unknown as ReadableStream<Uint8Array>;

			let answered = false;
			for await (const token of readServerSentText(raw)) {
				answered = true;
				stream.send(token);
			}

			stream.end(answered ? "" : "(no response from the model)");
		} catch (error) {
			stream.error(error instanceof Error ? error.message : "Chat failed");
		}
	}

	/** Assemble everything the model needs to answer questions about this repo. */
	private buildChatContext(): string {
		const verdict = this.state.lastVerdict;
		const waivers = this.getActiveWaivers();
		const adoption = this.adoptionReport(30);

		const codexLines = CODEX.map((r) => `${r.id} [${r.severity}/${r.kind}] ${r.title} - ${r.rationale}`);

		const findingLines = verdict
			? verdict.findings.map(
					(f) => `${f.ruleId} ${f.severity} ${f.path}:${f.line ?? "?"} - ${f.message} (via ${f.source}, confidence ${f.confidence})`,
				)
			: [];

		const waiverLines = waivers.map(
			(w) => `${w.ruleId} on \`${w.pathGlob}\` until ${w.expiresAt ?? "never"} - "${w.reason}" (granted by ${w.grantedBy})`,
		);

		const weakest = adoption.rules
			.slice(0, 3)
			.map((r) => `${r.ruleId} at ${Math.round(r.compliance * 100)}% compliance (${r.trend})`);

		return [
			`You are Sentinel, the Engineering Codex assistant for the repository "${this.state.repo}".`,
			"",
			"Answer using only the context below. If the answer is not in it, say so and name what you would need.",
			"Be concrete and brief. Quote rule ids. When someone asks how to fix something, give the remediation, not a lecture.",
			"You cannot grant waivers yourself - if one is warranted, say which rule and path glob to request and why.",
			"",
			`## Codex ${CODEX_VERSION}`,
			...codexLines,
			"",
			verdict
				? `## Most recent review (PR #${verdict.pr}, decision: ${verdict.decision}, ${verdict.stats.filesChanged} files)`
				: "## Most recent review\n(none yet)",
			...(findingLines.length > 0 ? findingLines : verdict ? ["(no findings - clean)"] : []),
			...(verdict && verdict.waived.length > 0
				? ["", "Waived on this review:", ...verdict.waived.map((w) => `${w.ruleId} ${w.path} - waived because "${w.waiverReason}"`)]
				: []),
			"",
			"## Active waivers",
			...(waiverLines.length > 0 ? waiverLines : ["(none)"]),
			"",
			`## Adoption over the last 30 days (${adoption.reviews} reviews)`,
			...(weakest.length > 0 ? ["Weakest rules:", ...weakest] : ["(not enough history)"]),
		].join("\n");
	}

	// -----------------------------------------------------------------------
	// Workflow callbacks
	// -----------------------------------------------------------------------

	async onWorkflowProgress(_workflow: string, _id: string, progress: unknown): Promise<void> {
		this.setState({ ...this.state, active: progress as ReviewProgress });
	}

	async onWorkflowError(_workflow: string, _id: string, error: string): Promise<void> {
		const active = this.state.active;
		this.setState({
			...this.state,
			active: active ? { ...active, phase: "failed", label: "Review failed", detail: error } : null,
		});
	}
}

function toWaiver(row: WaiverRow): Waiver {
	return {
		id: row.id,
		ruleId: row.rule_id,
		pathGlob: row.path_glob,
		reason: row.reason,
		grantedBy: row.granted_by,
		expiresAt: row.expires_at,
		createdAt: row.created_at,
	};
}

function round(n: number): number {
	return Math.round(n * 1000) / 1000;
}

function describeTrend(delta: number): "improving" | "declining" | "flat" {
	if (delta > 0.05) return "improving";
	if (delta < -0.05) return "declining";
	return "flat";
}

/**
 * Turn Workers AI's SSE byte stream into plain text tokens.
 *
 * Chunk boundaries do not respect event boundaries, so a naive decode-and-split
 * drops roughly one token in twenty. The trailing partial line is carried into
 * the next chunk.
 */
async function* readServerSentText(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				if (!line.startsWith("data:")) continue;
				const payload = line.slice(5).trim();
				if (payload === "" || payload === "[DONE]") continue;

				try {
					const parsed = JSON.parse(payload) as { response?: string };
					if (parsed.response) yield parsed.response;
				} catch {
					// A malformed SSE frame costs one token, not the stream.
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
}
