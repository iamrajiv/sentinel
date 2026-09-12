import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import agents from "agents/vite";
import { defineConfig } from "vite";

/**
 * Workers AI has no local implementation - the `AI` binding always proxies to
 * Cloudflare, which means `vite dev` cannot even start without an API token.
 *
 * Making that the default would mean `git clone && npm run dev` fails for
 * anyone who has not logged in, so it is opt-in:
 *
 *   npm run dev      remote bindings off. Boots instantly with no account.
 *                    Deterministic rules run in full; judged rules report
 *                    themselves as degraded, which is the same path a real
 *                    inference outage takes.
 *   npm run dev:ai   remote bindings on. Real Llama 3.3 on Workers AI.
 *                    Requires `wrangler login` or CLOUDFLARE_API_TOKEN.
 */
const remoteBindings = process.env.SENTINEL_REMOTE_AI === "1";

export default defineConfig({
	plugins: [agents(), react(), tailwindcss(), cloudflare({ remoteBindings })],
	resolve: {
		alias: {
			"@": path.resolve(import.meta.dirname, "./src"),
		},
	},
});
