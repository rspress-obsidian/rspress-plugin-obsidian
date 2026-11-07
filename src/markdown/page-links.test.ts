import { describe, expect, test } from "bun:test";
import { extractPageLinks } from "./page-links.js";

describe("fileLinks", () => {
	test("records a markdown destination the way Obsidian's file cache does", () => {
		const links = extractPageLinks(
			[
				"[b](<My Note.md>)",
				"[c](Plan%20(v2).md)",
				'[d](Note.md "Title")',
				"[e](100%zz.md)",
				"[x](obsidian://open?file=Note.md)",
				"[q](Note.md?x=1#top)",
				"[m](mailto:a@b.c)",
				"[h](#heading)",
				"[u](https://example.com/z.md)",
				"	",
			].join("\n"),
		);

		expect(links.fileLinks).toEqual([
			{ target: "My Note.md", display: "b", isEmbed: false, origin: "body" },
			{ target: "Plan (v2).md", display: "c", isEmbed: false, origin: "body" },
			{ target: "Note.md", display: "d", isEmbed: false, origin: "body" },
			{ target: "100%zz.md", display: "e", isEmbed: false, origin: "body" },
			{ target: "Note.md", display: "x", isEmbed: false, origin: "body" },
			{ target: "Note.md", display: "q", isEmbed: false, origin: "body" },
		]);
	});
});
