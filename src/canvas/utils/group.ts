import type { CanvasNode } from "../types.js";

/**
 * Obsidian's membership rule: a node belongs to a group when its rectangle is
 * fully contained in the group's.
 *
 * Membership is derived from geometry on every render rather than stored: the
 * `.canvas` format has no parent field, so dragging a card in or out of a group
 * must re-parent it — a sticky membership computed once would leave a card
 * dragging its old group around after it left the box.
 */
export function isContainedIn(group: CanvasNode, node: CanvasNode): boolean {
	return (
		node.id !== group.id &&
		node.x >= group.x &&
		node.y >= group.y &&
		node.x + node.width <= group.x + group.width &&
		node.y + node.height <= group.y + group.height
	);
}

/**
 * Every group's member ids, keyed by group id, in canvas order. Nested groups
 * fall out of the same geometric rule: a group inside a group is a member, and
 * so is everything it holds.
 */
export function membersByGroup(nodes: CanvasNode[]): Map<string, string[]> {
	const members = new Map<string, string[]>();
	for (const node of nodes) {
		if (node.type === "group") {
			members.set(
				node.id,
				nodes.filter((other) => isContainedIn(node, other)).map((other) => other.id),
			);
		}
	}
	return members;
}
