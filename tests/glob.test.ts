import { expect, test } from "vitest";
import { matchesGlob } from "../src/lib/glob.ts";

test("* does not cross a path separator", () => {
	expect(matchesGlob("src/*.ts", "src/a.ts")).toBe(true);
	expect(matchesGlob("src/*.ts", "src/nested/a.ts")).toBe(false);
});

test("** crosses path separators", () => {
	expect(matchesGlob("src/**", "src/nested/deep/a.ts")).toBe(true);
	expect(matchesGlob("src/**/*.ts", "src/nested/a.ts")).toBe(true);
});

test("bare wildcards match everything", () => {
	expect(matchesGlob("**", "any/path/at/all.go")).toBe(true);
	expect(matchesGlob("*", "any/path/at/all.go")).toBe(true);
});

test("dots are literal, not regex wildcards", () => {
	expect(matchesGlob("src/a.ts", "src/axts")).toBe(false);
});

test("a non-matching prefix does not match", () => {
	expect(matchesGlob("src/**", "tests/a.ts")).toBe(false);
});
