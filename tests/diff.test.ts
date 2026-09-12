import { describe, expect, test } from "vitest";
import { addedLines, parseUnifiedDiff, renderForPrompt } from "../src/lib/diff.ts";

describe("parseUnifiedDiff", () => {
	test("tracks post-change line numbers across multiple hunks", () => {
		const [file] = parseUnifiedDiff(`diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 const a = 1;
+const b = 2;
 const c = 3;
@@ -20,2 +21,3 @@
 const x = 1;
+const y = 2;
`);

		expect(file!.path).toBe("src/a.ts");
		expect(addedLines(file!).map((l) => [l.line, l.text])).toEqual([
			[2, "const b = 2;"],
			[22, "const y = 2;"],
		]);
	});

	test("removed lines carry no post-change line number", () => {
		const [file] = parseUnifiedDiff(`diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1,2 +1,1 @@
-const gone = 1;
 const stays = 2;
`);

		expect(file!.deletions).toBe(1);
		expect(file!.lines.find((l) => l.kind === "removed")!.line).toBeNull();
		// The context line keeps the number it has *after* the removal.
		expect(file!.lines.find((l) => l.kind === "context")!.line).toBe(1);
	});

	test("detects added, deleted and renamed files", () => {
		const files = parseUnifiedDiff(`diff --git a/new.ts b/new.ts
new file mode 100644
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,1 @@
+export const x = 1;
diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-export const y = 2;
diff --git a/from.ts b/to.ts
similarity index 90%
rename from from.ts
rename to to.ts
`);

		expect(files.map((f) => [f.path, f.status])).toEqual([
			["new.ts", "added"],
			["old.ts", "deleted"],
			["to.ts", "renamed"],
		]);
	});

	test("ignores the no-newline marker rather than reading it as content", () => {
		const [file] = parseUnifiedDiff(`diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1 +1 @@
-old
\\ No newline at end of file
+new
\\ No newline at end of file
`);

		expect(addedLines(file!).map((l) => l.text)).toEqual(["new"]);
	});

	test("returns nothing for input that is not a diff", () => {
		expect(parseUnifiedDiff("just some prose\nover two lines")).toEqual([]);
	});
});

describe("renderForPrompt", () => {
	test("truncates long files and says how much was hidden", () => {
		const patch = [
			"diff --git a/big.ts b/big.ts",
			"--- a/big.ts",
			"+++ b/big.ts",
			"@@ -1,0 +1,50 @@",
			...Array.from({ length: 50 }, (_, i) => `+line ${i}`),
		].join("\n");

		const rendered = renderForPrompt(parseUnifiedDiff(patch)[0]!, 10);
		expect(rendered).toContain("(40 more lines truncated)");
		expect(rendered.split("\n").length).toBeLessThan(15);
	});
});
