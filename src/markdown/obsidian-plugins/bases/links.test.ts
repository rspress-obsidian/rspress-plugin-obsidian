/**
 * A note's links as Obsidian's metadata cache lists them for `file.links` and
 * `file.embeds`, read from the note's source and frontmatter.
 */
import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "../../../shared/frontmatter.js";
import { noteLinks } from "./links.js";

function linksOf(markdown: string) {
	return noteLinks(markdown, parseFrontmatter(markdown).data);
}

describe("noteLinks", () => {
	test("frontmatter links first, then body links in source order, then embeds; repeats kept", () => {
		const { links, embeds } = linksOf(
			[
				"---",
				'up: "[[Parent|The parent]]"',
				"related:",
				'  - "[[A]]"',
				'  - "[Docs](Docs.md)"',
				"nested: {deep: '[[Deep]]'}",
				"when: 2024-01-01",
				'prose: "not [[a whole]] link"',
				"---",
				"See [B](B.md), [[A]] and ![[pic.png]] then [[A#Intro]] and ![Shot](Shot%20One.png).",
			].join("\n"),
		);
		expect(links.map((link) => `${link.isEmbed ? "!" : ""}${link.path}|${link.display}`)).toEqual([
			"Parent|The parent",
			"A|A",
			"Docs.md|Docs",
			"Deep|Deep",
			"B.md|B",
			"A|A",
			"A#Intro|A > Intro",
			"!pic.png|pic.png",
			"!Shot One.png|Shot",
		]);
		expect(embeds.map((link) => link.path)).toEqual(["pic.png", "Shot One.png"]);
	});

	test("the display Obsidian gives a link without an alias", () => {
		const { links } = linksOf(
			"[[Folder/Note]] [[Note.md]] [[Note#^block]] [[Note#Section | Shown ]] [[Report.pdf]] [[ ]]",
		);
		expect(links.map((link) => [link.path, link.display])).toEqual([
			["Folder/Note", "Folder/Note"],
			["Note.md", "Note"],
			["Note#^block", "Note > ^block"],
			["Note#Section", "Shown"],
			["Report.pdf", "Report.pdf"],
		]);
	});

	test("markdown destinations: decodeURI, angle brackets, parentheses; URLs and same-note anchors are not links", () => {
		const { links } = linksOf(
			[
				"[a](Caf%C3%A9%20%26%20Bar.md) [b](<My Note.md>) [c](Plan%20(v2).md)",
				"[web](https://example.com) [mail](mailto:x@y.z) [top](#heading) [bad](100%zz.md)",
				'[titled](Titled.md "A title")',
			].join("\n"),
		);
		expect(links.map((link) => link.path)).toEqual([
			"Café %26 Bar.md",
			"My Note.md",
			"Plan (v2).md",
			"100%zz.md",
			"Titled.md",
		]);
	});

	test("links in code, comments or a fenced block are not the note's links", () => {
		const { links } = linksOf(
			[
				"`[[InCode]]` %%[[InComment]]%%",
				"```",
				"[[InFence]] [x](Fence.md)",
				"```",
				"[[Real]]",
			].join("\n"),
		);
		expect(links.map((link) => link.path)).toEqual(["Real"]);
	});
});
