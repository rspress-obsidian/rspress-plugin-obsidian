import { describe, expect, test } from "bun:test";
import type { Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { toMarkdown } from "mdast-util-to-markdown";
import {
	blankCommentRanges,
	filterCommentedToc,
	findCommentRanges,
	stripComments,
} from "./comments";

/** Parse, strip, and serialize — the shape the remark pass operates on. */
function strip(source: string): string {
	const tree = fromMarkdown(source) as unknown as Root;
	stripComments(tree, source);
	return toMarkdown(tree).trim();
}

describe("findCommentRanges", () => {
	test("pairs delimiters across paragraphs", () => {
		expect(findCommentRanges("a %%\nhidden\n%% b")).toEqual([{ start: 2, end: 14 }]);
	});

	test("leaves an unclosed delimiter alone", () => {
		expect(findCommentRanges("a %% dangling")).toEqual([]);
	});

	test("ignores delimiters inside code fences and inline code", () => {
		expect(findCommentRanges("```\n%% fenced %%\n```")).toEqual([]);
		expect(findCommentRanges("use `%%` literally")).toEqual([]);
	});

	test("handles CRLF sources", () => {
		expect(findCommentRanges("a %%\r\nhidden\r\n%% b")).toEqual([{ start: 2, end: 16 }]);
	});

	test("ignores delimiters inside an inline code span that spans lines", () => {
		// Both %% pairs sit inside the span opened on line one. A scanner that
		// forgot the state would pair the line-two delimiters into a false
		// comment and blank real prose.
		expect(findCommentRanges("start `code %% still\n%% a `b` c %%")).toEqual([]);
	});

	test("state from an earlier line only covers the span up to its closer", () => {
		const source = "opened `on line one\nclosed ` %%hidden%% end";
		const ranges = findCommentRanges(source);
		expect(ranges).toHaveLength(1);
		expect(source.slice(ranges[0]?.start, ranges[0]?.end)).toBe("%%hidden%%");
	});

	test("an unclosed backtick stops at the blank line, not the rest of the file", () => {
		const source = "stray ` tick\n\n%%hidden%%";
		expect(findCommentRanges(source)).toEqual([{ start: 14, end: 24 }]);
	});

	test("an unpaired backtick does not silence a later comment", () => {
		// The stray run never finds an equal-length match, so it is literal
		// text (CommonMark) — the delimiters after it are still a comment.
		expect(findCommentRanges("stray ` tick %%hidden%% end")).toEqual([{ start: 13, end: 23 }]);
	});

	test("an unpaired backtick does not silence the next line", () => {
		expect(findCommentRanges("stray ` tick\n%%hidden%% end")).toEqual([{ start: 13, end: 23 }]);
	});

	test("an unpaired run of one length does not cancel a run of another", () => {
		// The final single backtick has no match, but the first two already
		// paired into a code span that hides nothing outside it.
		const source = "`a `b` %%hidden%%";
		const ranges = findCommentRanges(source);
		expect(ranges).toHaveLength(1);
		expect(source.slice(ranges[0]?.start, ranges[0]?.end)).toBe("%%hidden%%");
	});

	test("handles adjacent delimiters", () => {
		expect(findCommentRanges("a %%%% b")).toEqual([{ start: 2, end: 6 }]);
	});

	test("still strips when the document opens with a thematic break", () => {
		// A leading `---` with no closing delimiter is a thematic break, not
		// frontmatter — treating it as frontmatter would disable stripping.
		const source = "---\n\nvisible %% hidden %% b";
		const ranges = findCommentRanges(source);

		expect(ranges).toHaveLength(1);
		expect(source.slice(ranges[0]?.start, ranges[0]?.end)).toBe("%% hidden %%");
	});

	test("ignores delimiters inside frontmatter", () => {
		expect(findCommentRanges("---\ndescription: '%% not a comment %%'\n---\nbody")).toEqual([]);
	});
});

describe("stripComments", () => {
	test("removes the content between delimiters, containers included", () => {
		expect(strip("Before.\n\n%%\n## Private\n\nDraft text.\n%%\n\nAfter.")).toBe(
			"Before.\n\nAfter.",
		);
	});

	test("keeps text that surrounds an inline comment", () => {
		expect(strip("Visible %%hidden%% text.")).toBe("Visible  text.");
	});

	test("leaves fenced code and inline code untouched", () => {
		expect(strip("```\n%% not a comment %%\n```")).toContain("%% not a comment %%");
		expect(strip("Use `%%` literally.")).toContain("%%");
		expect(strip("Use `code %% not a comment\nspan%%` here.")).toContain("%% not a comment");
	});

	test("leaves an unclosed delimiter as written", () => {
		expect(strip("Visible %% dangling text.")).toContain("%% dangling text.");
	});

	test("strips inside a file that opens with a thematic break", () => {
		expect(strip("---\n\nvisible %% hidden %% b")).not.toContain("hidden");
	});

	test("removes a list item a comment swallowed", () => {
		const out = strip("Visible.\n\n- keep\n- %% drop %%\n- keep two");

		expect(out).not.toContain("drop");
		expect(out).toContain("keep");
		expect(out).toContain("keep two");
	});

	test("empties a commented-out table cell without shifting the columns", () => {
		const out = strip("| a | b |\n| - | - |\n| %% x %% | y |");

		expect(out).not.toContain("x");
		expect(out).toContain("| a | b |");
		expect(out).toContain("|  | y |");
	});
});

describe("blankCommentRanges", () => {
	test("blanks a range without moving any offset", () => {
		const source = "Visible %%hidden%% text.";
		const blanked = blankCommentRanges(source, findCommentRanges(source));

		expect(blanked).toHaveLength(source.length);
		expect(blanked).toBe(`Visible ${" ".repeat(10)} text.`);
		expect(blanked.slice(0, 8)).toBe("Visible ");
		expect(blanked.slice(18)).toBe(" text.");
	});

	test("keeps the newlines inside a multi-line comment", () => {
		const source = "a %%\nhidden\n%% b";
		const blanked = blankCommentRanges(source, findCommentRanges(source));

		expect(blanked).toHaveLength(source.length);
		expect(blanked.split("\n")).toHaveLength(source.split("\n").length);
		expect(blanked).not.toContain("hidden");
		expect(blanked).toContain("a ");
		expect(blanked).toContain(" b");
	});

	test("returns the source unchanged when there is nothing to blank", () => {
		expect(blankCommentRanges("plain text", [])).toBe("plain text");
	});
});

describe("filterCommentedToc", () => {
	interface Entry {
		id: string;
		text: string;
		depth: number;
		charIndex: number;
	}

	test("drops an entry whose offset falls inside a comment", () => {
		// The comment spans offsets 13-29, so the heading's own offset falls in it.
		const source = "Intro text.\n\n%%\n## Private\n\n%%\n";
		const toc: Entry[] = [{ id: "private", text: "Private", depth: 2, charIndex: 17 }];

		expect(filterCommentedToc(toc, source)).toEqual([]);
	});

	test("keeps a live heading that shares its text with a commented one", () => {
		// Live and commented headings have the same text and id, so only the count
		// tells them apart — and the survivor is the live entry.
		const source = "%%\n## Dup\n%%\n\n## Dup\n";
		const toc: Entry[] = [
			{ id: "dup", text: "Dup", depth: 2, charIndex: -1 },
			{ id: "dup", text: "Dup", depth: 2, charIndex: -1 },
		];

		const kept = filterCommentedToc(toc, source);

		expect(kept).toHaveLength(1);
	});

	test("drops only the commented entry when offsets are unavailable", () => {
		// Rspress records `charIndex: -1` for every entry when the search index
		// is disabled, so identity reconciliation removes the commented heading.
		const source = "## One\n\n%%\n## Two\n%%\n\n## Three\n";
		const toc: Entry[] = [
			{ id: "one", text: "One", depth: 2, charIndex: -1 },
			{ id: "two", text: "Two", depth: 2, charIndex: -1 },
			{ id: "three", text: "Three", depth: 2, charIndex: -1 },
		];

		expect(filterCommentedToc(toc, source).map((entry) => entry.id)).toEqual(["one", "three"]);
	});

	test("matches a commented heading written with markdown when offsets are absent", () => {
		// The outline stores the text without its markdown and an id slugged from
		// that text, so both identity forms have to resolve to the source heading.
		const source = "%%\n## **Bold** private\n%%\n";
		const toc: Entry[] = [{ id: "bold-private", text: "Bold private", depth: 2, charIndex: -1 }];

		expect(filterCommentedToc(toc, source)).toEqual([]);
	});

	test("resolves a wikilink heading through its anchor id", () => {
		// `stripMarkdownFormatting` leaves a wikilink in place, so the source text
		// and the outline text differ; the anchor id Rspress slugged still matches.
		const source = "## Live\n\n%%\n## See [[guide]] here\n%%\n";
		const toc: Entry[] = [
			{ id: "live", text: "Live", depth: 2, charIndex: 3 },
			{ id: "see-guide-here", text: "See guide here", depth: 2, charIndex: -1 },
		];

		expect(filterCommentedToc(toc, source).map((entry) => entry.id)).toEqual(["live"]);
	});

	test("leaves an entry with no counterpart in the source alone", () => {
		// A stale outline entry (an id, text and offset that all miss) cannot be
		// attributed to a heading, so it is kept rather than guessed at.
		const source = "%%\n## Gone\n%%\n";
		const toc: Entry[] = [{ id: "stale", text: "Stale", depth: 2, charIndex: -1 }];

		expect(filterCommentedToc(toc, source).map((entry) => entry.id)).toEqual(["stale"]);
	});

	test("returns the outline untouched when no heading is commented out", () => {
		const source = "## Public\n\n%%\nhidden text\n%%\n";
		const toc: Entry[] = [{ id: "public", text: "Public", depth: 2, charIndex: 3 }];

		expect(filterCommentedToc(toc, source)).toBe(toc);
	});

	test("returns an empty outline unchanged", () => {
		expect(filterCommentedToc([], "%%\n## Gone\n%%\n")).toEqual([]);
	});
});
