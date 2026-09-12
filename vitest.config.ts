import { defineConfig } from "vitest/config";

/**
 * A plugin-free config for the unit tests.
 *
 * `vite.config.ts` loads the Cloudflare and Agents plugins, which pull in the
 * Workers runtime and the decorator transform. The engine, the diff parser and
 * the rules are deliberately free of every binding, so testing them needs none
 * of that - and keeping the test run out of workerd is what makes it fast
 * enough to sit in a pre-commit hook.
 */
export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		environment: "node",
	},
});
