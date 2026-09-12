/**
 * Minimal glob matching for waiver path patterns.
 *
 * Waivers are written by humans in a UI and in MCP tool calls, so the pattern
 * language has to be the one they already expect from .gitignore and CODEOWNERS:
 * `*` stops at a path separator, `**` crosses them. Pulling in a full glob
 * library for that would be 40kB of Worker bundle for one function.
 */
const GLOBSTAR = "__SENTINEL_GLOBSTAR__";

export function matchesGlob(pattern: string, path: string): boolean {
	if (pattern === "**" || pattern === "*") return true;

	// Escape regex metacharacters, then re-expand the wildcards we support.
	// The placeholder avoids the classic bug where `**` is rewritten to `.*` and
	// then its constituent `*`s are rewritten a second time.
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replaceAll("**", GLOBSTAR)
		.replaceAll("*", "[^/]*")
		.replaceAll(GLOBSTAR, ".*")
		.replaceAll("?", "[^/]");

	return new RegExp(`^${escaped}$`).test(path);
}
