import { getAgentByName } from "agents";
// The `agents/mcp` barrel also pulls in the MCP *client*, which this Worker
// never uses and which fails to resolve at bundle time. The server subpath is
// the stateless handler on its own.
import { createMcpHandler } from "agents/mcp/server";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { CodexAgent } from "../agents/codex-agent.ts";
import { formatVerdict, providerFor, reviewInline } from "../codex/review.ts";
import { describeCodex, getRule } from "../codex/rules.ts";
import { buildChangeSet } from "../lib/diff.ts";
import { repoSlug } from "../lib/repo.ts";

/**
 * Sentinel as an MCP server.
 *
 * This is the part that changes how the codex is actually used. A gate that
 * only speaks in CI tells you about a violation after you have pushed, opened a
 * PR, and context-switched to something else. The same rules exposed as MCP
 * tools mean the coding agent that is *writing* the change can check it before
 * the commit, read the rationale, and fix it in the same turn.
 *
 * The tools are deliberately named `codex_*` and described in terms of what an
 * agent would want: a model choosing between tools reads the description, so
 * the description is the interface.
 */

function agentFor(env: Env, repo: string) {
	return getAgentByName<Env, CodexAgent>(env.CodexAgent, repoSlug(repo));
}

/** One Agent instance per repo; `getAgentByName` resolves (and wakes) the stub. */

function text(body: string) {
	return { content: [{ type: "text" as const, text: body }] };
}

export function createSentinelMcpServer(env: Env): McpServer {
	const server = new McpServer(
		{ name: "sentinel-codex", version: "0.1.0" },
		{
			instructions: [
				"Sentinel enforces an Engineering Codex: a versioned set of engineering standards, half of them decided by static analysis and half judged by an LLM.",
				"Before proposing a diff for a repository covered by Sentinel, call codex_review_diff on the unified diff and fix anything blocking.",
				"Use codex_explain_rule when a finding is unclear, and codex_request_waiver only when a rule genuinely should not apply - never to silence a finding you could fix.",
			].join("\n"),
		},
	);

	server.registerTool(
		"codex_list_rules",
		{
			title: "List codex rules",
			description:
				"List every rule in the Engineering Codex with its id, severity, whether it is checked deterministically or judged by a model, and why it exists. Call this to understand what Sentinel will enforce before writing code.",
			inputSchema: z.object({}),
		},
		async () => {
			const codex = describeCodex();
			const lines = codex.rules.map(
				(r) => `${r.id} [${r.severity}/${r.kind}] ${r.title}\n    ${r.rationale}\n    Fix: ${r.remediation}`,
			);
			return text(`Engineering Codex ${codex.version} - ${codex.rules.length} rules\n\n${lines.join("\n\n")}`);
		},
	);

	server.registerTool(
		"codex_explain_rule",
		{
			title: "Explain one codex rule",
			description:
				"Get the full rationale and the concrete remediation for a single rule id (for example CDX-002). Use this when a review finding is unclear or when you need to know what would satisfy the rule.",
			inputSchema: z.object({
				ruleId: z.string().describe("Rule id, e.g. CDX-001"),
			}),
		},
		async ({ ruleId }) => {
			const rule = getRule(ruleId.toUpperCase());
			if (!rule) return text(`No rule with id ${ruleId}. Call codex_list_rules to see the valid ids.`);

			const detail =
				rule.kind === "judged"
					? `\n\nThe model is asked: ${rule.question}\n\nFlagged: ${rule.violationExample}\n\nNot flagged: ${rule.compliantExample}`
					: "";

			return text(
				`${rule.id} - ${rule.title}\nSeverity: ${rule.severity} (${rule.kind})\n\nWhy: ${rule.rationale}\n\nFix: ${rule.remediation}${detail}`,
			);
		},
	);

	server.registerTool(
		"codex_review_diff",
		{
			title: "Review a diff against the codex",
			description:
				"Run the full Engineering Codex against a unified diff and return every finding with its severity, location, and fix. Run this before committing. A 'block' decision means the change must not be merged as-is.",
			inputSchema: z.object({
				repo: z.string().describe("Repository slug, e.g. acme/api"),
				patch: z.string().describe("Unified diff, as produced by `git diff` or `git diff --cached`"),
				pr: z.number().int().optional().describe("Pull request number, if there is one"),
				title: z.string().optional().describe("Change title, used by rules that reason about intent"),
				author: z.string().optional(),
			}),
		},
		async ({ repo, patch, pr, title, author }) => {
			const change = buildChangeSet({
				repo,
				pr: pr ?? 0,
				title: title ?? "(untitled change)",
				author: author ?? "unknown",
				patch,
			});

			if (change.files.length === 0) {
				return text("No files parsed from that patch. Sentinel expects unified diff format (`git diff`).");
			}

			const agent = await agentFor(env, repo);
			const verdict = await reviewInline({
				reviewId: crypto.randomUUID(),
				change,
				provider: providerFor(env),
				waivers: await agent.getActiveWaivers(),
			});

			// Record it even though this path did not go through the Workflow -
			// adoption metrics should reflect every review, not only the CI ones.
			await agent.persistVerdict(verdict);

			return text(formatVerdict(verdict));
		},
	);

	server.registerTool(
		"codex_request_waiver",
		{
			title: "Record an exception to a rule",
			description:
				"Record a time-boxed, attributed exception to one rule for one path pattern. Use only when the rule genuinely does not apply to this code - the reason is stored and reviewed. Waivers expire after 90 days by default.",
			inputSchema: z.object({
				repo: z.string(),
				ruleId: z.string().describe("Rule to waive, e.g. CDX-004"),
				pathGlob: z.string().describe("Paths the waiver covers, e.g. src/legacy/**"),
				reason: z.string().describe("Why this rule should not apply here. A full sentence someone can evaluate later."),
				requestedBy: z.string().describe("Who is accountable for this exception"),
				expiresInDays: z.number().int().positive().optional().describe("Defaults to 90"),
			}),
		},
		async ({ repo, ruleId, pathGlob, reason, requestedBy, expiresInDays }) => {
			try {
				const waiver = await (await agentFor(env, repo)).grantWaiver({
					ruleId: ruleId.toUpperCase(),
					pathGlob,
					reason,
					grantedBy: requestedBy,
					expiresInDays: expiresInDays ?? 90,
				});
				return text(
					`Waiver recorded.\n${waiver.ruleId} on \`${waiver.pathGlob}\` until ${waiver.expiresAt ?? "never"}\nReason: ${waiver.reason}\nId: ${waiver.id}`,
				);
			} catch (error) {
				return text(`Waiver rejected: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	);

	server.registerTool(
		"codex_list_waivers",
		{
			title: "List a repository's waivers",
			description: "Show every recorded exception for a repository, with its reason, owner, and expiry.",
			inputSchema: z.object({ repo: z.string() }),
		},
		async ({ repo }) => {
			const waivers = await (await agentFor(env, repo)).listWaivers();
			if (waivers.length === 0) return text(`${repo} has no recorded waivers.`);

			const lines = waivers.map(
				(w) => `${w.ruleId} on \`${w.pathGlob}\` - ${w.grantedBy}, expires ${w.expiresAt ?? "never"}\n    "${w.reason}"`,
			);
			return text(`${waivers.length} waiver(s) for ${repo}:\n\n${lines.join("\n")}`);
		},
	);

	server.registerTool(
		"codex_adoption_report",
		{
			title: "Codex adoption for a repository",
			description:
				"Per-rule compliance over a trailing window, worst first, with the direction of travel. Use this to find which standards a repository is actually struggling with rather than guessing.",
			inputSchema: z.object({
				repo: z.string(),
				days: z.number().int().positive().max(365).optional().describe("Window length, default 30"),
			}),
		},
		async ({ repo, days }) => {
			const report = await (await agentFor(env, repo)).adoptionReport(days ?? 30);
			if (report.reviews === 0) return text(`No reviews recorded for ${repo} in the last ${report.windowDays} days.`);

			const lines = report.rules.map(
				(r) => `${(r.compliance * 100).toFixed(0).padStart(3)}%  ${r.ruleId}  ${r.title}  (${r.findings} finding(s), ${r.trend})`,
			);
			return text(
				`Codex ${report.codexVersion} adoption for ${repo} - ${report.reviews} review(s) over ${report.windowDays} days\n\n${lines.join("\n")}`,
			);
		},
	);

	return server;
}

/**
 * Serve one MCP request.
 *
 * The handler is built per request rather than once per isolate because the
 * server factory needs `env`, and `McpRequestContext` deliberately does not
 * carry it - the stateless handler has no isolate-wide environment to close
 * over. Construction is cheap (tool registration only), and building it here
 * keeps `env` flowing from the one place the runtime actually hands it to us.
 */
export function handleMcpRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	return createMcpHandler(() => createSentinelMcpServer(env))(request, env, ctx);
}
