/**
 * `visit` from `unist-util-visit`, for the plugin's own passes.
 *
 * The upstream walker builds a closure and redefines its `name` (a colored
 * debug label) for every node it passes, matched or not, which made tree
 * walking the bulk of the plugin's per-page cost: a page runs dozens of
 * passes. This one has the same traversal semantics — pre-order, the
 * `parent.children` array re-read after every visitor so splices are seen,
 * `"skip"`, `false` (exit), a returned index or `[action, index]` — and the
 * same types; tests are limited to a node type, which is all the passes use.
 */
import type { Node, Parent } from "unist";
import type { BuildVisitor, VisitorResult } from "unist-util-visit";

type AnyVisitor = (
	node: Node,
	index: number | undefined,
	parent: Parent | undefined,
) => VisitorResult;

export function visit<Tree extends Node, Check extends string>(
	tree: Tree,
	type: Check,
	visitor: BuildVisitor<Tree, Check>,
): undefined;
export function visit<Tree extends Node>(tree: Tree, visitor: BuildVisitor<Tree>): undefined;
export function visit(
	tree: Node,
	typeOrVisitor: string | AnyVisitor,
	maybeVisitor?: AnyVisitor,
): undefined {
	if (typeof typeOrVisitor === "function")
		walk(tree, undefined, undefined, undefined, typeOrVisitor);
	else if (maybeVisitor) walk(tree, undefined, undefined, typeOrVisitor, maybeVisitor);
	return undefined;
}

/** `false` ends the whole walk; a number is the index the parent continues at. */
function walk(
	node: Node,
	index: number | undefined,
	parent: Parent | undefined,
	type: string | undefined,
	visitor: AnyVisitor,
): false | number | undefined {
	let action: VisitorResult;
	let next: number | undefined;
	if (type === undefined || node.type === type) {
		const result = visitor(node, index, parent);
		if (Array.isArray(result)) {
			action = result[0];
			next = result[1] ?? undefined;
		} else if (typeof result === "number") {
			next = result;
		} else {
			action = result;
		}
		if (action === false) return false;
	}
	const children = (node as Partial<Parent>).children;
	if (children && action !== "skip") {
		const self = node as Parent;
		let offset = 0;
		while (offset > -1 && offset < self.children.length) {
			const child = self.children[offset] as Node;
			const sub = walk(child, offset, self, type, visitor);
			if (sub === false) return false;
			offset = typeof sub === "number" ? sub : offset + 1;
		}
	}
	return next;
}
