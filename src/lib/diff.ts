import type { ChangedFile, ChangeSet, DiffLine } from "./types.ts";

/**
 * A small unified-diff parser.
 *
 * We parse rather than regex the raw patch because almost every rule needs to
 * distinguish an *added* line from a line that merely sits near the change.
 * Flagging pre-existing code is the fastest way to make a review bot ignored,
 * so `added` is the only thing rules are allowed to judge by default.
 *
 * This handles the subset of unified diff that `git diff` and the GitHub
 * "patch" field actually emit: file headers, rename/new/delete markers, and
 * multiple hunks per file. It is deliberately tolerant - an unparseable hunk
 * header is skipped rather than thrown, because a review that fails closed on
 * a malformed patch is worse than one that reviews the rest of the files.
 */

const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(patch: string): ChangedFile[] {
	const files: ChangedFile[] = [];
	const lines = patch.split("\n");

	let current: ChangedFile | null = null;
	let nextLineNumber = 0;
	let inHunk = false;

	const flush = () => {
		if (current) files.push(current);
		current = null;
		inHunk = false;
	};

	for (const raw of lines) {
		const header = FILE_HEADER.exec(raw);
		if (header) {
			flush();
			const from = header[1]!;
			const to = header[2]!;
			current = {
				path: to,
				previousPath: from,
				status: from === to ? "modified" : "renamed",
				lines: [],
				additions: 0,
				deletions: 0,
			};
			continue;
		}

		if (!current) continue;

		// File-level metadata lines. These appear between the `diff --git` header
		// and the first hunk, and they are the only reliable signal for
		// added/deleted files (a new file still shows `a/path b/path`).
		if (!inHunk) {
			if (raw.startsWith("new file mode")) {
				current.status = "added";
				continue;
			}
			if (raw.startsWith("deleted file mode")) {
				current.status = "deleted";
				continue;
			}
			if (raw.startsWith("rename from ")) {
				current.previousPath = raw.slice("rename from ".length).trim();
				current.status = "renamed";
				continue;
			}
			if (raw.startsWith("rename to ")) {
				current.path = raw.slice("rename to ".length).trim();
				current.status = "renamed";
				continue;
			}
		}

		const hunk = HUNK_HEADER.exec(raw);
		if (hunk) {
			nextLineNumber = Number.parseInt(hunk[1]!, 10);
			inHunk = true;
			continue;
		}

		if (!inHunk) continue;

		// "\ No newline at end of file" is metadata, not content.
		if (raw.startsWith("\\")) continue;

		const marker = raw[0];
		const text = raw.slice(1);

		if (marker === "+") {
			current.lines.push({ line: nextLineNumber, kind: "added", text });
			current.additions += 1;
			nextLineNumber += 1;
		} else if (marker === "-") {
			current.lines.push({ line: null, kind: "removed", text });
			current.deletions += 1;
		} else if (marker === " ") {
			current.lines.push({ line: nextLineNumber, kind: "context", text });
			nextLineNumber += 1;
		}
		// Anything else (blank trailing line, index lines inside a hunk) is ignored.
	}

	flush();
	return files;
}

/** Convenience: the added lines of a file, which is what most rules care about. */
export function addedLines(file: ChangedFile): DiffLine[] {
	return file.lines.filter((l) => l.kind === "added");
}

/** The full post-change text of the hunks we can see, for whole-file reasoning. */
export function visibleAfterText(file: ChangedFile): string {
	return file.lines
		.filter((l) => l.kind !== "removed")
		.map((l) => l.text)
		.join("\n");
}

/**
 * Render a file's diff back to unified format, capped at `maxLines`.
 *
 * Judged rules get this rather than the raw patch: it keeps the prompt inside
 * the model's context window and strips the file headers the model does not
 * need, which measurably reduces the judge's tendency to comment on filenames
 * instead of code.
 */
export function renderForPrompt(file: ChangedFile, maxLines = 160): string {
	const body = file.lines
		.slice(0, maxLines)
		.map((l) => {
			const prefix = l.kind === "added" ? "+" : l.kind === "removed" ? "-" : " ";
			const number = l.line === null ? "    " : String(l.line).padStart(4, " ");
			return `${number} ${prefix}${l.text}`;
		})
		.join("\n");

	const hidden = file.lines.length - maxLines;
	const truncated = hidden > 0 ? `\n... (${hidden} more lines truncated)` : "";
	return `--- ${file.path} (${file.status}, +${file.additions}/-${file.deletions})\n${body}${truncated}`;
}

/** Build a ChangeSet from a raw patch plus the surrounding PR metadata. */
export function buildChangeSet(input: {
	repo: string;
	pr: number;
	title: string;
	author: string;
	patch: string;
}): ChangeSet {
	return {
		repo: input.repo,
		pr: input.pr,
		title: input.title,
		author: input.author,
		files: parseUnifiedDiff(input.patch),
	};
}
