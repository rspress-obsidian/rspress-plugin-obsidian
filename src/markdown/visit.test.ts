/**
 * The plugin's walker must traverse exactly like `unist-util-visit`, mutations
 * included: each case runs the same visitor through both on copies of one tree
 * and compares what was visited and the tree left behind.
 */
import { describe, expect, test } from "bun:test";
import type { Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Node, Parent } from "unist";
import { visit as upstream, type VisitorResult } from "unist-util-visit";
import { visit } from "./visit";

const SOURCE = `# Title *em*

Para **strong _nested_** and \`code\`.

- one
- two **bold**
  - deep

> quote
`;

type TestVisitor = (
	node: Node,
	index: number | undefined,
	parent: Parent | undefined,
) => VisitorResult;

function both(visitor: TestVisitor, type?: string): void {
	const run = (walk: (tree: Root, visitor: TestVisitor) => void) => {
		const tree = fromMarkdown(SOURCE);
		const seen: string[] = [];
		walk(tree, (node, index, parent) => {
			seen.push(`${node.type}@${index}<${parent?.type}`);
			return visitor(node, index, parent);
		});
		return { seen, tree };
	};
	const expected = run((tree, fn) =>
		type === undefined ? upstream(tree, fn as never) : upstream(tree, type, fn as never),
	);
	const actual = run((tree, fn) =>
		type === undefined ? visit(tree, fn as never) : visit(tree, type, fn as never),
	);
	expect(actual.seen.length).toBeGreaterThan(0);
	expect(actual).toEqual(expected);
}

describe("visit", () => {
	test("visits every node in pre-order with its index and parent", () => {
		both(() => undefined);
	});

	test("filters by node type", () => {
		both(() => undefined, "strong");
		both(() => undefined, "text");
	});

	test('"skip" leaves the children unvisited', () => {
		both((node) => (node.type === "list" ? "skip" : undefined));
	});

	test("false ends the whole walk", () => {
		both((node) => node.type !== "inlineCode");
	});

	test("a returned index continues there, after a splice", () => {
		both((_node, index, parent) => {
			if (!parent || index === undefined) return;
			const text = (value: string): Node => ({ type: "text", value }) as Node;
			parent.children.splice(index, 1, text("a"), text("b"));
			return index + 2;
		}, "emphasis");
	});

	test("a removed node's own children are still walked", () => {
		both((node, index, parent) => {
			if (node.type !== "strong" || !parent || index === undefined) return;
			parent.children.splice(index, 1);
			return index;
		});
	});

	test("an [action, index] tuple is honoured", () => {
		both((node, index) =>
			node.type === "listItem" && index === 0 ? ["skip", (index ?? 0) + 1] : undefined,
		);
	});
});
