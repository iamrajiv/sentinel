/**
 * Golden changesets.
 *
 * These are the project's ground truth: the UI loads them as demo input and the
 * eval harness scores the codex against `expect`. Keeping one copy means a
 * fixture can never drift from the case that measures it.
 *
 * `expect` lists the rule ids a correct review must report. `forbid` lists rules
 * that must NOT fire - these are the false-positive traps, and they are the
 * reason the harness reports precision separately from recall.
 */

export interface Fixture {
	id: string;
	label: string;
	description: string;
	repo: string;
	pr: number;
	title: string;
	author: string;
	patch: string;
	expect: string[];
	forbid: string[];
}

const ciPinning: Fixture = {
	id: "ci-secrets",
	label: "Unpinned action + leaked token",
	description: "A CI change that pins to a mutable tag and pastes a real token into the workflow.",
	repo: "acme/edge-api",
	pr: 418,
	title: "Add nightly deploy workflow",
	author: "dana",
	patch: `diff --git a/.github/workflows/deploy.yml b/.github/workflows/deploy.yml
new file mode 100644
index 0000000..1a2b3c4
--- /dev/null
+++ b/.github/workflows/deploy.yml
@@ -0,0 +1,18 @@
+name: nightly-deploy
+on:
+  schedule:
+    - cron: "0 2 * * *"
+jobs:
+  deploy:
+    runs-on: ubuntu-latest
+    steps:
+      - uses: actions/checkout@v4
+      - uses: actions/setup-node@v4
+        with:
+          node-version: 20
+      - name: Publish
+        env:
+          NPM_TOKEN: ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8
+        run: npm publish
+      - uses: actions/upload-artifact@8f4b7f84864484a7bf31766abe9204da3cbe65b3
+        with: { name: build, path: dist }
`,
	expect: ["CDX-001", "CDX-002"],
	// The third action IS pinned to a full SHA - CDX-002 must not fire on it, and
	// a rule that reports "2 findings" here instead of one is over-reporting.
	forbid: ["CDX-004"],
};

const unboundedFetch: Fixture = {
	id: "unbounded-fetch",
	label: "Unbounded call, swallowed error",
	description: "A new upstream call with no timeout, wrapped in a catch block that discards the failure.",
	repo: "acme/edge-api",
	pr: 421,
	title: "Fetch pricing from the billing service",
	author: "sam",
	patch: `diff --git a/src/pricing.ts b/src/pricing.ts
index 7d3f1a2..9e4c2b1 100644
--- a/src/pricing.ts
+++ b/src/pricing.ts
@@ -12,6 +12,19 @@ export function basePrice(sku: string): number {
   return CATALOG[sku] ?? 0;
 }
 
+export async function livePrice(sku: string): Promise<number> {
+  try {
+    const response = await fetch(\`https://billing.internal/prices/\${sku}\`);
+    const body = await response.json();
+    return body.amount;
+  } catch (e) {
+    return basePrice(sku);
+  }
+}
+
+export function applyDiscount(price: number, pct: number): number {
+  return price * (1 - pct / 100);
+}
+
 export function formatPrice(cents: number): string {
   return \`$\${(cents / 100).toFixed(2)}\`;
 }
`,
	expect: ["CDX-003", "CDX-005", "CDX-100"],
	forbid: ["CDX-001", "CDX-002", "CDX-004"],
};

const migrationNoRollback: Fixture = {
	id: "migration-no-rollback",
	label: "One-way migration",
	description: "A destructive schema change with no down path, shipped alongside a test.",
	repo: "acme/edge-api",
	pr: 430,
	title: "Drop the legacy sessions table",
	author: "kim",
	patch: `diff --git a/migrations/0042_drop_sessions.sql b/migrations/0042_drop_sessions.sql
new file mode 100644
index 0000000..3c4d5e6
--- /dev/null
+++ b/migrations/0042_drop_sessions.sql
@@ -0,0 +1,3 @@
+ALTER TABLE accounts ADD COLUMN session_token TEXT;
+UPDATE accounts SET session_token = (SELECT token FROM sessions WHERE sessions.account_id = accounts.id);
+ALTER TABLE sessions RENAME TO sessions_deprecated;
diff --git a/tests/migrations.test.ts b/tests/migrations.test.ts
index 1111111..2222222 100644
--- a/tests/migrations.test.ts
+++ b/tests/migrations.test.ts
@@ -4,3 +4,8 @@ test("0041 applies cleanly", async () => {
   await expect(apply("0041")).resolves.toBeUndefined();
 });
 
+test("0042 moves tokens onto accounts", async () => {
+  await apply("0042");
+  const [row] = await db.query("SELECT session_token FROM accounts LIMIT 1");
+  expect(row.session_token).toBeTruthy();
+});
`,
	expect: ["CDX-004"],
	// A test file IS touched here, so CDX-101 must stay quiet. This is the trap
	// that catches a judge which pattern-matches "migration" to "risky".
	forbid: ["CDX-101", "CDX-001", "CDX-002"],
};

const breakingChange: Fixture = {
	id: "breaking-change",
	label: "Narrowed public signature",
	description: "An exported function's signature is replaced in place, with no tests touched anywhere.",
	repo: "acme/edge-api",
	pr: 433,
	title: "Require tenant on user lookup",
	author: "rowan",
	patch: `diff --git a/src/users.ts b/src/users.ts
index aaa1111..bbb2222 100644
--- a/src/users.ts
+++ b/src/users.ts
@@ -18,9 +18,9 @@ const cache = new Map<string, User>();
 
-export async function getUser(id: string): Promise<User> {
-  const cached = cache.get(id);
-  if (cached) return cached;
-  return db.users.findById(id);
-}
+export async function getUser(opts: { id: string; tenant: string }): Promise<User> {
+  const key = \`\${opts.tenant}:\${opts.id}\`;
+  const cached = cache.get(key);
+  if (cached) return cached;
+  return db.users.findById(opts.id, opts.tenant);
+}
 
 export function clearUserCache(): void {
   cache.clear();
 }
`,
	expect: ["CDX-101", "CDX-103"],
	forbid: ["CDX-001", "CDX-002", "CDX-004"],
};

const cleanRefactor: Fixture = {
	id: "clean-refactor",
	label: "Clean change (control)",
	description:
		"A documented, tested, timeout-bounded addition. Every rule must stay silent - this is the false-positive control.",
	repo: "acme/edge-api",
	pr: 436,
	title: "Add health probe with timeout",
	author: "dana",
	patch: `diff --git a/src/health.ts b/src/health.ts
index 4444444..5555555 100644
--- a/src/health.ts
+++ b/src/health.ts
@@ -1,5 +1,24 @@
 import { logger } from "./logger";
 
+/**
+ * Probe an upstream dependency and report whether it is serving.
+ *
+ * Bounded at 2s: the probe runs on the readiness path, so a hung upstream must
+ * not hold the check open past the platform's own deadline.
+ */
+export async function probe(url: string): Promise<boolean> {
+  try {
+    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
+    if (!response.ok) {
+      logger.warn({ url, status: response.status }, "health probe returned non-2xx");
+      return false;
+    }
+    return true;
+  } catch (error) {
+    logger.warn({ url, error: String(error) }, "health probe failed");
+    return false;
+  }
+}
+
 export function uptimeSeconds(): number {
   return Math.floor(process.uptime());
 }
diff --git a/tests/health.test.ts b/tests/health.test.ts
index 6666666..7777777 100644
--- a/tests/health.test.ts
+++ b/tests/health.test.ts
@@ -1,4 +1,12 @@
 import { probe, uptimeSeconds } from "../src/health";
 
+test("probe reports false on a non-2xx response", async () => {
+  globalThis.fetch = async () => new Response("nope", { status: 503 });
+  expect(await probe("https://upstream.test/health")).toBe(false);
+});
+
 test("uptime is non-negative", () => {
   expect(uptimeSeconds()).toBeGreaterThanOrEqual(0);
 });
`,
	expect: [],
	forbid: ["CDX-001", "CDX-002", "CDX-003", "CDX-004", "CDX-005", "CDX-100", "CDX-101", "CDX-102", "CDX-103"],
};

export const FIXTURES: Fixture[] = [ciPinning, unboundedFetch, migrationNoRollback, breakingChange, cleanRefactor];

export function getFixture(id: string): Fixture | undefined {
	return FIXTURES.find((f) => f.id === id);
}
