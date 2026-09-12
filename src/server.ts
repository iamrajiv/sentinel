import { routeAgentRequest } from "agents";
import { CodexAgent } from "./agents/codex-agent.ts";
import { handleMcpRequest } from "./mcp/server.ts";
import { describeCodex } from "./codex/rules.ts";
import { formatVerdict, providerFor, reviewInline } from "./codex/review.ts";
import { buildChangeSet } from "./lib/diff.ts";
import { repoSlug } from "./lib/repo.ts";
import { getAgentByName } from "agents";

export { CodexAgent } from "./agents/codex-agent.ts";
export { ReviewWorkflow } from "./workflows/review-workflow.ts";

/**
 * Sentinel's entrypoint.
 *
 * Four surfaces onto one engine, because a guardrail is only adopted if it
 * meets engineers where they already are:
 *
 *   /mcp           - the coding agent, before the commit exists
 *   /api/review    - CI, as a blocking merge check
 *   /agents/*      - the browser UI, over WebSocket
 *   everything else - the static UI itself
 */
export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/mcp") {
			return handleMcpRequest(request, env, ctx);
		}

		if (url.pathname === "/api/codex") {
			return Response.json(describeCodex());
		}

		if (url.pathname === "/api/review" && request.method === "POST") {
			return handleReview(request, env);
		}

		// The Agents SDK owns /agents/:agent/:instance, including the WebSocket
		// upgrade and the RPC protocol behind `agent.stub.*`.
		const routed = await routeAgentRequest(request, env);
		if (routed) return routed;

		// Anything else is the single-page UI, served from the assets binding.
		return env.ASSETS.fetch(request);
	},
} satisfies ExportedHandler<Env>;

/**
 * The CI-facing review endpoint.
 *
 * Synchronous by design: a merge check has to return a verdict in the response,
 * not a job id a GitHub Action would then have to poll. The durable Workflow
 * path is what the browser UI drives, where nobody is blocking on the answer.
 */
async function handleReview(request: Request, env: Env): Promise<Response> {
	let body: { repo?: string; pr?: number; title?: string; author?: string; patch?: string };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return Response.json({ error: "Body must be JSON." }, { status: 400 });
	}

	if (!body.repo || !body.patch) {
		return Response.json({ error: "`repo` and `patch` are required." }, { status: 400 });
	}

	const change = buildChangeSet({
		repo: body.repo,
		pr: body.pr ?? 0,
		title: body.title ?? "(untitled change)",
		author: body.author ?? "unknown",
		patch: body.patch,
	});

	if (change.files.length === 0) {
		return Response.json({ error: "No files parsed - `patch` must be a unified diff." }, { status: 400 });
	}

	const agent = await getAgentByName<Env, CodexAgent>(env.CodexAgent, repoSlug(body.repo));

	const verdict = await reviewInline({
		reviewId: crypto.randomUUID(),
		change,
		provider: providerFor(env),
		waivers: await agent.getActiveWaivers(),
	});

	await agent.persistVerdict(verdict);

	// A CI job reads the status code; a human reads the body. Serve both.
	return Response.json(
		{ verdict, summary: formatVerdict(verdict) },
		{ status: verdict.decision === "block" ? 422 : 200 },
	);
}
