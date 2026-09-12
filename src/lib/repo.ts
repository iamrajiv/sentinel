/**
 * Map a repository name to an Agent instance name.
 *
 * The instance name becomes part of a URL (`/agents/codex-agent/<slug>`), so it
 * has to survive routing while still round-tripping to something a human
 * recognises in a log line.
 */
export function repoSlug(repo: string): string {
	const slug = repo
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");

	return slug.length > 0 ? slug.slice(0, 63) : "default";
}
