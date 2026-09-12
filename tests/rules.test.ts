import { describe, expect, test } from "vitest";
import { runDeterministic } from "../src/codex/engine.ts";
import { CODEX } from "../src/codex/rules.ts";
import { FIXTURES } from "../src/fixtures/diffs.ts";
import { buildChangeSet } from "../src/lib/diff.ts";

/** The deterministic half of each fixture's expectation. Judged rules are CDX-1xx. */
const deterministicExpectation = (ids: string[]) => ids.filter((id) => !id.startsWith("CDX-1"));

describe.each(FIXTURES)("$id", (fixture) => {
	const findings = runDeterministic(buildChangeSet(fixture));
	const fired = [...new Set(findings.map((f) => f.ruleId))].sort();

	test("reports exactly the expected deterministic rules", () => {
		expect(fired).toEqual(deterministicExpectation(fixture.expect).sort());
	});

	test("reports none of the forbidden rules", () => {
		for (const forbidden of fixture.forbid) {
			expect(fired).not.toContain(forbidden);
		}
	});

	test("every finding carries a location and a remediation", () => {
		for (const f of findings) {
			expect(f.path).not.toBe("");
			expect(f.remediation.length).toBeGreaterThan(20);
			expect(f.confidence).toBe(1);
		}
	});
});

describe("CDX-001 secret detection", () => {
	const scan = (line: string) =>
		runDeterministic(
			buildChangeSet({
				repo: "t",
				pr: 1,
				title: "t",
				author: "t",
				patch: `diff --git a/src/config.ts b/src/config.ts\n--- a/src/config.ts\n+++ b/src/config.ts\n@@ -1,0 +1,1 @@\n+${line}\n`,
			}),
		).filter((f) => f.ruleId === "CDX-001");

	test("flags a hardcoded credential", () => {
		expect(scan('const apiKey = "sk_live_4eC39HqLyjWDarjtT1zdp7dc";')).toHaveLength(1);
	});

	test("does not flag a value read from the environment", () => {
		expect(scan("const apiKey = process.env.STRIPE_SECRET_KEY;")).toHaveLength(0);
	});

	test("does not flag an obvious placeholder", () => {
		expect(scan('const apiKey = "your-api-key-here";')).toHaveLength(0);
	});

	test("redacts the secret it reports so the verdict is safe to log", () => {
		const [finding] = scan('const token = "ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";');
		expect(finding!.evidence).not.toContain("A1b2C3d4E5f6G7h8");
	});

	test("redacts an unquoted value too", () => {
		// Regression: the first redactor only masked quoted strings, so a token in
		// a YAML value - the most common way one actually lands in a repo - was
		// echoed verbatim into the verdict, the UI and the MCP response.
		const findings = runDeterministic(
			buildChangeSet({
				repo: "t",
				pr: 1,
				title: "t",
				author: "t",
				patch:
					"diff --git a/.github/workflows/x.yml b/.github/workflows/x.yml\n--- a/.github/workflows/x.yml\n+++ b/.github/workflows/x.yml\n@@ -1,0 +1,1 @@\n+          NPM_TOKEN: ghp_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8\n",
			}),
		).filter((f) => f.ruleId === "CDX-001");

		expect(findings).toHaveLength(1);
		expect(findings[0]!.evidence).not.toContain("A1b2C3d4E5f6G7h8");
		// The prefix survives so the engineer can still tell which token leaked.
		expect(findings[0]!.evidence).toContain("ghp_");
	});
});

describe("CDX-002 action pinning", () => {
	const scan = (step: string) =>
		runDeterministic(
			buildChangeSet({
				repo: "t",
				pr: 1,
				title: "t",
				author: "t",
				patch: `diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml\n--- a/.github/workflows/ci.yml\n+++ b/.github/workflows/ci.yml\n@@ -1,0 +1,1 @@\n+${step}\n`,
			}),
		).filter((f) => f.ruleId === "CDX-002");

	test("flags a tag", () => expect(scan("      - uses: actions/checkout@v4")).toHaveLength(1));
	test("flags a branch", () => expect(scan("      - uses: actions/checkout@main")).toHaveLength(1));
	test("flags a missing ref", () => expect(scan("      - uses: actions/checkout")).toHaveLength(1));

	test("accepts a full SHA", () =>
		expect(scan("      - uses: actions/checkout@8f4b7f84864484a7bf31766abe9204da3cbe65b3")).toHaveLength(0));

	test("skips local and docker actions, which have no SHA to pin", () => {
		expect(scan("      - uses: ./.github/actions/setup")).toHaveLength(0);
		expect(scan("      - uses: docker://alpine:3.20")).toHaveLength(0);
	});
});

describe("CDX-004 migration rollback", () => {
	const scan = (body: string) =>
		runDeterministic(
			buildChangeSet({
				repo: "t",
				pr: 1,
				title: "t",
				author: "t",
				patch: `diff --git a/migrations/001.sql b/migrations/001.sql\nnew file mode 100644\n--- /dev/null\n+++ b/migrations/001.sql\n@@ -0,0 +1,2 @@\n${body
					.split("\n")
					.map((l) => `+${l}`)
					.join("\n")}\n`,
			}),
		).filter((f) => f.ruleId === "CDX-004");

	test("flags a migration with no down path", () => {
		expect(scan("ALTER TABLE users ADD COLUMN email TEXT;")).toHaveLength(1);
	});

	test("accepts an explicit rollback section", () => {
		expect(scan("ALTER TABLE users ADD COLUMN email TEXT;\n-- rollback\nALTER TABLE users DROP COLUMN email;")).toHaveLength(0);
	});

	test("a destructive statement is not itself a rollback", () => {
		// Regression: an earlier version accepted any DROP as evidence of a down
		// path, which exempted exactly the migrations that most needed one.
		expect(scan("DROP TABLE sessions;")).toHaveLength(1);
	});
});

describe("the codex itself", () => {
	test("rule ids are unique", () => {
		const ids = CODEX.map((r) => r.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("every rule states a rationale and a remediation", () => {
		for (const rule of CODEX) {
			expect(rule.rationale.length).toBeGreaterThan(40);
			expect(rule.remediation.length).toBeGreaterThan(30);
		}
	});
});
