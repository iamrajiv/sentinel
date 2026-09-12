import { describe, expect, test } from "vitest";
import { applyWaivers, decide, demoteLowConfidence } from "../src/codex/engine.ts";
import type { Finding, Waiver } from "../src/lib/types.ts";

const finding = (over: Partial<Finding> = {}): Finding => ({
	ruleId: "CDX-001",
	ruleTitle: "No credentials committed to source",
	severity: "blocking",
	source: "deterministic",
	path: "src/config.ts",
	line: 4,
	message: "Possible credential.",
	remediation: "Move it to a secret store.",
	confidence: 1,
	...over,
});

const waiver = (over: Partial<Waiver> = {}): Waiver => ({
	id: "w1",
	ruleId: "CDX-001",
	pathGlob: "src/**",
	reason: "Fixture credentials for the integration test suite.",
	grantedBy: "platform-team",
	expiresAt: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	...over,
});

describe("applyWaivers", () => {
	test("moves a matching finding out of the blocking set", () => {
		const { findings, waived } = applyWaivers([finding()], [waiver()]);
		expect(findings).toHaveLength(0);
		expect(waived[0]!.waiverReason).toContain("Fixture credentials");
	});

	test("does not waive a different rule", () => {
		const { findings, waived } = applyWaivers([finding({ ruleId: "CDX-002" })], [waiver()]);
		expect(findings).toHaveLength(1);
		expect(waived).toHaveLength(0);
	});

	test("does not waive a path outside the glob", () => {
		const { findings } = applyWaivers([finding({ path: "infra/config.ts" })], [waiver()]);
		expect(findings).toHaveLength(1);
	});

	test("an expired waiver stops protecting", () => {
		const expired = waiver({ expiresAt: "2026-01-02T00:00:00.000Z" });
		const { findings } = applyWaivers([finding()], [expired], new Date("2026-06-01T00:00:00.000Z"));
		expect(findings).toHaveLength(1);
	});

	test("a waiver that has not yet expired still protects", () => {
		const live = waiver({ expiresAt: "2026-12-01T00:00:00.000Z" });
		const { waived } = applyWaivers([finding()], [live], new Date("2026-06-01T00:00:00.000Z"));
		expect(waived).toHaveLength(1);
	});
});

describe("demoteLowConfidence", () => {
	test("demotes an unsure judged finding to advisory", () => {
		const [out] = demoteLowConfidence([finding({ source: "judged", confidence: 0.3 })], 0.55);
		expect(out!.severity).toBe("advisory");
	});

	test("leaves a confident judged finding alone", () => {
		const [out] = demoteLowConfidence([finding({ source: "judged", confidence: 0.9 })], 0.55);
		expect(out!.severity).toBe("blocking");
	});

	test("never demotes a deterministic finding, whatever the threshold", () => {
		const [out] = demoteLowConfidence([finding({ source: "deterministic", confidence: 1 })], 2);
		expect(out!.severity).toBe("blocking");
	});
});

describe("decide", () => {
	test("any blocking finding blocks", () => {
		expect(decide([finding({ severity: "warning" }), finding({ severity: "blocking" })])).toBe("block");
	});

	test("warnings alone warn", () => {
		expect(decide([finding({ severity: "warning" }), finding({ severity: "advisory" })])).toBe("warn");
	});

	test("advisories alone pass", () => {
		expect(decide([finding({ severity: "advisory" })])).toBe("pass");
	});

	test("no findings pass", () => {
		expect(decide([])).toBe("pass");
	});
});
