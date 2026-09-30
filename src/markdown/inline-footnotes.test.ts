import { describe, expect, test } from "bun:test";
import type { PhrasingContent, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { extractInlineFootnotes } from "./inline-footnotes";

/** Parse a paragraph's phrasing children the way remark would, then run the pass. */
function run(source: string, startCounter = 0) {
	const tree = fromMarkdown(source) as Root;
	const paragraph = tree.children.find((node) => node.type === "paragraph") as {
		children: PhrasingContent[];
	};
	const result = extractInlineFootnotes(paragraph.children, startCounter);
	return {
		defs: result.defs,
		html: result.children
			.map((node) => {
				if (node.type === "text") return node.value;
				if (node.type === "html") return `<${node.value}>`;
				return `[${node.type}]`;
			})
			.join(""),
	};
}

describe("extractInlineFootnotes", () => {
	test("a simple inline footnote", () => {
		const { defs, html } = run("Text ^[plain] rest.");
		expect(defs).toEqual([{ id: "inline-1", content: "plain" }]);
		expect(html).toContain("Text ");
		expect(html).toContain("rest.");
	});

	test("content with bold markdown spanning nodes", () => {
		const { defs } = run("Text ^[with **bold** here].");
		expect(defs).toEqual([{ id: "inline-1", content: "with **bold** here" }]);
	});

	test("content with a wikilink", () => {
		const { defs } = run("Text ^[see [[guide]] here].");
		expect(defs).toEqual([{ id: "inline-1", content: "see [[guide]] here" }]);
	});

	test("content with a markdown link", () => {
		const { defs } = run("Text ^[see [docs](https://x.dev) here].");
		expect(defs).toEqual([{ id: "inline-1", content: "see [docs](https://x.dev) here" }]);
	});

	test("content with inline code", () => {
		const { defs } = run("Text ^[with `code` here].");
		expect(defs).toEqual([{ id: "inline-1", content: "with `code` here" }]);
	});

	test("multiple footnotes in one paragraph", () => {
		const { defs } = run("A ^[one] and B ^[two] and C ^[three].");
		expect(defs.map((def) => def.content)).toEqual(["one", "two", "three"]);
		expect(defs.map((def) => def.id)).toEqual(["inline-1", "inline-2", "inline-3"]);
	});

	test("continues a document-wide counter", () => {
		const { defs } = run("A ^[only].", 7);
		expect(defs[0]?.id).toBe("inline-8");
	});

	test("leaves an unclosed construct as written", () => {
		const { defs, html } = run("Text ^[dangling");
		expect(defs).toEqual([]);
		expect(html).toContain("^[dangling");
	});

	test("nested inside emphasis", () => {
		const { defs } = run("**wrapped ^[note] here**");
		expect(defs.map((def) => def.content)).toEqual(["note"]);
	});

	test("keeps a strikethrough span's markdown", () => {
		const { defs } = run("Text ^[a ~~gone~~ word].");
		expect(defs).toEqual([{ id: "inline-1", content: "a ~~gone~~ word" }]);
	});

	test("keeps an image and a hard break inside the content", () => {
		const { defs } = run("Text ![shot](a.png)^[see ![shot](a.png)\nhere].");
		expect(defs[0]?.content).toBe("see ![shot](a.png)\nhere");
	});

	test("keeps raw html inside the content", () => {
		const { defs } = run("Text ^[a <b>bold</b> claim].");
		expect(defs[0]?.content).toBe("a <b>bold</b> claim");
	});

	test("falls back to a node's own text for a type it cannot model", () => {
		// A remark extension can add inline node types this pass has never heard
		// of. Whatever the node's text is, the footnote must not lose it.
		const tree = fromMarkdown("Text ^[see ref here].") as Root;
		const paragraph = tree.children.find((node) => node.type === "paragraph") as {
			children: PhrasingContent[];
		};
		const text = paragraph.children.find((node) => node.type === "text") as
			| { type: string; value: string }
			| undefined;
		if (text) text.type = "someExtensionNode";
		const result = extractInlineFootnotes(paragraph.children, 0);

		expect(result.defs).toEqual([{ id: "inline-1", content: "see ref here" }]);
	});

	test("emphasis inside the footnote content", () => {
		const { defs } = run("Text ^[a *b* c].");
		expect(defs).toEqual([{ id: "inline-1", content: "a *b* c" }]);
	});

	// The rebuild used to walk only the flattened character stream, so a node
	// with no characters of its own — a `footnoteReference` once remark-gfm has
	// parsed one — was silently dropped, and a sibling `strong` run was
	// flattened to its text.
	test("keeps a node that owns no characters", () => {
		const tree = fromMarkdown("A claim[^1] and an aside^[note].") as Root;
		const paragraph = tree.children.find((node) => node.type === "paragraph") as {
			children: PhrasingContent[];
		};
		paragraph.children.push({ type: "footnoteReference", identifier: "1" } as PhrasingContent);

		const result = extractInlineFootnotes(paragraph.children, 0);

		expect(result.children.filter((node) => node.type === "footnoteReference")).toHaveLength(1);
		expect(result.defs).toEqual([{ id: "inline-1", content: "note" }]);
	});

	test("keeps a sibling emphasis run as a node instead of flattening it", () => {
		const { html } = run("Text ^[note] and **bold** here.");

		expect(html).toContain("[strong]");
	});
});
