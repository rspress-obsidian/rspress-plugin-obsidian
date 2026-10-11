import { describe, expect, test } from "bun:test";
import type { PhrasingContent, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import {
	extractInlineFootnotes,
	type InlineFootnoteNode,
	replaceInlineFootnotes,
} from "./inline-footnotes";

function paragraphOf(tree: Root): { children: PhrasingContent[] } {
	return tree.children.find((node) => node.type === "paragraph") as {
		children: PhrasingContent[];
	};
}

/** Footnote contents found in a node list, in order. */
function contentsOf(nodes: PhrasingContent[]): string[] {
	return nodes
		.filter((node): node is InlineFootnoteNode => node.type === "inlineFootnote")
		.map((node) => node.content);
}

/** Parse a paragraph's phrasing children the way remark would, then run the pass. */
function run(source: string) {
	const children = extractInlineFootnotes(paragraphOf(fromMarkdown(source) as Root).children);
	return {
		contents: contentsOf(children),
		shape: children
			.map((node) => {
				if (node.type === "text") return node.value;
				if (node.type === "inlineFootnote") return `<fn:${node.content}>`;
				return `[${node.type}]`;
			})
			.join(""),
	};
}

describe("extractInlineFootnotes", () => {
	test("a simple inline footnote", () => {
		const { contents, shape } = run("Text ^[plain] rest.");
		expect(contents).toEqual(["plain"]);
		expect(shape).toBe("Text <fn:plain> rest.");
	});

	test("content with bold markdown spanning nodes", () => {
		expect(run("Text ^[with **bold** here].").contents).toEqual(["with **bold** here"]);
	});

	test("content with a wikilink", () => {
		expect(run("Text ^[see [[guide]] here].").contents).toEqual(["see [[guide]] here"]);
	});

	test("content with a markdown link", () => {
		expect(run("Text ^[see [docs](https://x.dev) here].").contents).toEqual([
			"see [docs](https://x.dev) here",
		]);
	});

	test("content with inline code", () => {
		expect(run("Text ^[with `code` here].").contents).toEqual(["with `code` here"]);
	});

	test("multiple footnotes in one paragraph", () => {
		expect(run("A ^[one] and B ^[two] and C ^[three].").contents).toEqual(["one", "two", "three"]);
	});

	test("leaves an unclosed construct as written", () => {
		const { contents, shape } = run("Text ^[dangling");
		expect(contents).toEqual([]);
		expect(shape).toContain("^[dangling");
	});

	test("keeps a strikethrough span's markdown", () => {
		expect(run("Text ^[a ~~gone~~ word].").contents).toEqual(["a ~~gone~~ word"]);
	});

	test("keeps an image and a hard break inside the content", () => {
		expect(run("Text ![shot](a.png)^[see ![shot](a.png)\nhere].").contents).toEqual([
			"see ![shot](a.png)\nhere",
		]);
	});

	test("keeps raw html inside the content", () => {
		expect(run("Text ^[a <b>bold</b> claim].").contents).toEqual(["a <b>bold</b> claim"]);
	});

	test("never reads a footnote out of a code span", () => {
		const { contents, shape } = run("Code `x^[y]` stays.");
		expect(contents).toEqual([]);
		expect(shape).toBe("Code [inlineCode] stays.");
	});

	test("falls back to a node's own text for a type it cannot model", () => {
		// A remark extension can add inline node types this pass has never heard
		// of. Whatever the node's text is, the footnote must not lose it.
		const paragraph = paragraphOf(fromMarkdown("Text ^[see ref here].") as Root);
		const text = paragraph.children.find((node) => node.type === "text") as
			| { type: string; value: string }
			| undefined;
		if (text) text.type = "someExtensionNode";
		expect(contentsOf(extractInlineFootnotes(paragraph.children))).toEqual(["see ref here"]);
	});

	test("emphasis inside the footnote content", () => {
		expect(run("Text ^[a *b* c].").contents).toEqual(["a *b* c"]);
	});

	// The rebuild used to walk only the flattened character stream, so a node
	// with no characters of its own — a `footnoteReference` once remark-gfm has
	// parsed one — was silently dropped, and a sibling `strong` run was
	// flattened to its text.
	test("keeps a node that owns no characters", () => {
		const paragraph = paragraphOf(fromMarkdown("A claim[^1] and an aside^[note].") as Root);
		paragraph.children.push({ type: "footnoteReference", identifier: "1" } as PhrasingContent);
		const children = extractInlineFootnotes(paragraph.children);
		expect(children.filter((node) => node.type === "footnoteReference")).toHaveLength(1);
		expect(contentsOf(children)).toEqual(["note"]);
	});

	test("keeps a sibling emphasis run as a node instead of flattening it", () => {
		expect(run("Text ^[note] and **bold** here.").shape).toContain("[strong]");
	});

	test("keeps a run that directly follows a footnote as a node", () => {
		expect(run("Text ^[note]**bold** here.").shape).toBe("Text <fn:note>[strong] here.");
	});
});

describe("replaceInlineFootnotes", () => {
	// A footnote inside `**…**` used to be taken at the paragraph level, which
	// rebuilt the bold run as literal `**` text around the reference.
	test("keeps the formatting around a footnote written inside emphasis", () => {
		const tree = fromMarkdown("Some **bold claim^[source]** here and *it ^[x]*.") as Root;
		replaceInlineFootnotes(tree);
		const paragraph = paragraphOf(tree);
		expect(paragraph.children.map((node) => node.type)).toEqual([
			"text",
			"strong",
			"text",
			"emphasis",
			"text",
		]);
		const strong = paragraph.children[1] as { children: PhrasingContent[] };
		const emphasis = paragraph.children[3] as { children: PhrasingContent[] };
		expect(contentsOf(strong.children)).toEqual(["source"]);
		expect(contentsOf(emphasis.children)).toEqual(["x"]);
	});
});
