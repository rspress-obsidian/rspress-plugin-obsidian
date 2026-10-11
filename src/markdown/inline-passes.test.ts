import { beforeAll, describe, expect, test } from "bun:test";
import type { Root } from "mdast";
import { prepareMathEngine } from "../math";
import { processMath } from "./inline-passes";

beforeAll(async () => {
	await prepareMathEngine("katex");
});

/** A paragraph of inline math, an inline `$$`, and a block `$$`. */
function formulas(): Root {
	return {
		type: "root",
		children: [
			{
				type: "paragraph",
				children: [
					{ type: "inlineMath", value: "x^2" },
					{ type: "inlineMath", value: "y", data: { obsidianDisplay: true } },
				],
			},
			{ type: "math", value: "z" },
		],
	} as unknown as Root;
}

interface JsxNode {
	type: string;
	name: string;
	attributes: Array<{ name: string; value: unknown }>;
	children: unknown[];
}

function attributeOf(node: JsxNode, name: string): unknown {
	return node.attributes.find((attribute) => attribute.name === name)?.value;
}

/** The markup MDX will compile into `dangerouslySetInnerHTML={{ __html }}`. */
function markupOf(node: JsxNode): unknown {
	const expression = attributeOf(node, "dangerouslySetInnerHTML") as {
		data: {
			estree: { body: Array<{ expression: { properties: Array<{ value: { value: unknown } }> } }> };
		};
	};
	return expression.data.estree.body[0]?.expression.properties[0]?.value.value;
}

describe("processMath", () => {
	test("by default a formula is an html node the compiler will parse", () => {
		const tree = formulas();
		expect(processMath(tree, "katex")).toBe(3);

		const paragraph = tree.children[0] as unknown as {
			children: Array<{ type: string; value: string }>;
		};
		expect(paragraph.children.map((child) => child.type)).toEqual(["html", "html"]);
		expect(paragraph.children[0]?.value).toStartWith(
			'<span class="obsidian-math"><span class="katex">',
		);
		expect(paragraph.children[1]?.value).toStartWith('<span class="obsidian-math-display">');
		expect((tree.children[1] as unknown as { value: string }).value).toStartWith(
			'<div class="obsidian-math-display">',
		);
	});

	test("with `jsx` a formula is one element carrying the markup", () => {
		const tree = formulas();
		expect(processMath(tree, "katex", { jsx: true })).toBe(3);

		const paragraph = tree.children[0] as unknown as { children: JsxNode[] };
		const [inline, inlineDisplay] = paragraph.children;
		const block = tree.children[1] as unknown as JsxNode;

		// Inline formulas sit in a paragraph (text elements); `$$` on its own is flow.
		expect([inline?.type, inlineDisplay?.type, block.type]).toEqual([
			"mdxJsxTextElement",
			"mdxJsxTextElement",
			"mdxJsxFlowElement",
		]);
		expect([inline?.name, inlineDisplay?.name, block.name]).toEqual(["span", "span", "div"]);
		expect(
			[inline, inlineDisplay, block].map((node) => attributeOf(node as JsxNode, "className")),
		).toEqual(["obsidian-math", "obsidian-math-display", "obsidian-math-display"]);
		for (const node of [inline, inlineDisplay, block]) {
			expect(node?.children).toEqual([]);
			expect(markupOf(node as JsxNode)).toContain('<span class="katex">');
		}
	});

	test("input the engine rejects stays as written in either mode", () => {
		for (const options of [{}, { jsx: true }]) {
			const tree = {
				type: "root",
				children: [{ type: "paragraph", children: [{ type: "inlineMath", value: "   " }] }],
			} as unknown as Root;
			expect(processMath(tree, "katex", options)).toBe(0);
			const paragraph = tree.children[0] as unknown as {
				children: Array<{ type: string; value: string }>;
			};
			expect(paragraph.children[0]).toEqual({ type: "text", value: "$   $" });
		}
	});
});
