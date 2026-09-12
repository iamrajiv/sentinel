import { describe, expect, test } from "vitest";
import { extractViolations, judgeRule, type ModelProvider } from "../src/codex/judge.ts";
import { judgedRules } from "../src/codex/rules.ts";
import { buildChangeSet } from "../src/lib/diff.ts";
import { getFixture } from "../src/fixtures/diffs.ts";

describe("extractViolations", () => {
	test("parses a bare JSON object", () => {
		expect(extractViolations('{"violations":[{"line":3,"message":"x","confidence":0.8}]}')).toHaveLength(1);
	});

	test("parses through a markdown fence", () => {
		const raw = 'Here is my analysis:\n```json\n{"violations":[{"line":3,"message":"x"}]}\n```';
		expect(extractViolations(raw)).toHaveLength(1);
	});

	test("an empty list is a valid answer, not a parse failure", () => {
		expect(extractViolations('{"violations":[]}')).toEqual([]);
	});

	test("unparseable output degrades to no findings rather than throwing", () => {
		expect(extractViolations("I could not analyse this diff.")).toEqual([]);
		expect(extractViolations('{"violations": [broken')).toEqual([]);
	});
});

describe("judgeRule", () => {
	/** A provider that replays one canned response for every call. */
	const canned = (response: string): ModelProvider => ({
		name: "stub",
		complete: async () => response,
	});

	const change = buildChangeSet(getFixture("unbounded-fetch")!);
	const rule = judgedRules().find((r) => r.id === "CDX-100")!;

	test("maps a model violation onto the rule's own severity and remediation", async () => {
		const [found] = await judgeRule(
			canned('{"violations":[{"line":18,"message":"The catch discards the error.","confidence":0.9}]}'),
			rule,
			change,
		);

		expect(found!.ruleId).toBe("CDX-100");
		// Severity comes from the codex, never from the model.
		expect(found!.severity).toBe(rule.severity);
		expect(found!.remediation).toBe(rule.remediation);
		expect(found!.source).toBe("judged");
		expect(found!.confidence).toBe(0.9);
	});

	test("drops a violation with no message", async () => {
		expect(await judgeRule(canned('{"violations":[{"line":3,"confidence":0.9}]}'), rule, change)).toEqual([]);
	});

	test("defaults a missing confidence rather than trusting it blindly", async () => {
		const [found] = await judgeRule(canned('{"violations":[{"line":3,"message":"x"}]}'), rule, change);
		expect(found!.confidence).toBe(0.5);
	});

	test("a provider failure propagates so the caller can mark the rule degraded", async () => {
		const failing: ModelProvider = {
			name: "stub",
			complete: async () => {
				throw new Error("inference 503");
			},
		};
		await expect(judgeRule(failing, rule, change)).rejects.toThrow("inference 503");
	});
});
