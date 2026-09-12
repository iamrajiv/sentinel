import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompletionRequest, ModelProvider } from "../src/codex/judge.ts";

/**
 * Model providers for the eval harness.
 *
 * The harness must be able to run three ways, and the difference between them is
 * the only reason this abstraction exists:
 *
 *   replay  - default. Scores recorded model output. Hermetic, free, runnable in
 *             CI, and the numbers do not move unless the prompt moves.
 *   live    - calls Workers AI over the REST API. Needed to produce recordings,
 *             and to answer "did upgrading the model change anything".
 *   record  - live, plus writes every response to disk for replay.
 *
 * Crucially all three drive the *real* prompt-construction code in
 * `src/codex/judge.ts`. A harness that reimplements the prompt scores a prompt
 * that never ships.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDINGS = join(HERE, "recordings");

/** Recordings key on the prompt itself, so editing a prompt invalidates its recording. */
function recordingKey(request: CompletionRequest): string {
	const digest = createHash("sha256").update(`${request.system}\n---\n${request.prompt}`).digest("hex").slice(0, 16);
	return `${request.cacheKey.replace(/[^a-zA-Z0-9._-]/g, "_")}.${digest}.json`;
}

export class MissingRecordingError extends Error {
	constructor(readonly key: string) {
		super(`No recording for ${key}`);
		this.name = "MissingRecordingError";
	}
}

export class ReplayProvider implements ModelProvider {
	readonly name: string;
	/** Keys that were asked for and not found, so the run can report them once. */
	readonly missing: string[] = [];

	constructor(model: string) {
		this.name = model;
	}

	async complete(request: CompletionRequest): Promise<string> {
		const key = recordingKey(request);
		try {
			const file = readFileSync(join(RECORDINGS, key), "utf8");
			return (JSON.parse(file) as { response: string }).response;
		} catch {
			this.missing.push(key);
			throw new MissingRecordingError(key);
		}
	}
}

/**
 * Workers AI over the REST API.
 *
 * The harness runs in Node, not in workerd, so there is no `AI` binding to use -
 * the same model is reached over HTTP with an account-scoped token.
 */
export class RestApiProvider implements ModelProvider {
	readonly name: string;
	readonly latencies: number[] = [];

	constructor(
		model: string,
		private readonly accountId: string,
		private readonly token: string,
		private readonly record = false,
	) {
		this.name = model;
	}

	static fromEnv(model: string, record = false): RestApiProvider {
		const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
		const token = process.env.CLOUDFLARE_API_TOKEN;

		if (!accountId || !token) {
			throw new Error(
				"Live evals need CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in the environment.\n" +
					"Create a token with the 'Workers AI: Read' permission at\n" +
					"https://dash.cloudflare.com/profile/api-tokens",
			);
		}

		return new RestApiProvider(model, accountId, token, record);
	}

	async complete(request: CompletionRequest): Promise<string> {
		const started = performance.now();

		const response = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${this.accountId}/ai/run/${this.name}`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					messages: [
						{ role: "system", content: request.system },
						{ role: "user", content: request.prompt },
					],
					max_tokens: request.maxTokens ?? 700,
					temperature: request.temperature ?? 0.1,
				}),
				signal: AbortSignal.timeout(60_000),
			},
		);

		this.latencies.push(performance.now() - started);

		if (!response.ok) {
			throw new Error(`Workers AI returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
		}

		const body = (await response.json()) as { result?: { response?: string }; errors?: unknown[] };
		const text = body.result?.response ?? "";

		if (this.record) {
			mkdirSync(RECORDINGS, { recursive: true });
			writeFileSync(
				join(RECORDINGS, recordingKey(request)),
				`${JSON.stringify({ model: this.name, cacheKey: request.cacheKey, response: text }, null, 2)}\n`,
			);
		}

		return text;
	}
}
