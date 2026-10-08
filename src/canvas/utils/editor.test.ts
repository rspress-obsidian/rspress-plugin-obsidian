import { expect, test } from "bun:test";
import type { CanvasNode } from "../types";
import {
	createEdge,
	createFileNode,
	createGroupNode,
	createLinkNode,
	createTextNode,
} from "./editor";

test("creates text node with unique id", () => {
	const node = createTextNode([], 10, 20);
	expect(node.type).toBe("text");
	expect(node.x).toBe(10);
	expect(node.y).toBe(20);
	expect(node.id).toBe("node-1");
});

test("creates file node", () => {
	const node = createFileNode([], 0, 0);
	expect(node.type).toBe("file");
	if (node.type === "file") expect(node.file).toBe("Note.md");
});

test("creates link node", () => {
	const node = createLinkNode([], 0, 0);
	expect(node.type).toBe("link");
	if (node.type === "link") expect(node.url).toBe("https://");
});

test("creates group node", () => {
	const node = createGroupNode([], 0, 0);
	expect(node.type).toBe("group");
	if (node.type === "group") expect(node.label).toBe("Group");
});

function box(id: string, x: number, y: number): CanvasNode {
	return { id, type: "text", x, y, width: 100, height: 60, text: "" };
}

test("creates edge with unique id and arrow toEnd", () => {
	const edge = createEdge([], box("a", 0, 0), box("b", 300, 0));
	expect(edge.id).toBe("edge-1");
	expect(edge.fromNode).toBe("a");
	expect(edge.toNode).toBe("b");
	expect(edge.toEnd).toBe("arrow");
	expect(edge.fromEnd).toBe("none");
});

test("a drawn edge attaches on the sides the two nodes face", () => {
	expect(createEdge([], box("a", 0, 0), box("b", 300, 0))).toMatchObject({
		fromSide: "right",
		toSide: "left",
	});
	expect(createEdge([], box("a", 0, 400), box("b", 20, 0))).toMatchObject({
		fromSide: "top",
		toSide: "bottom",
	});
});

test("avoids id collisions", () => {
	const existing: CanvasNode[] = [
		{ id: "node-1", type: "text", x: 0, y: 0, width: 1, height: 1, text: "" },
	];
	const node = createTextNode(existing, 0, 0);
	expect(node.id).toBe("node-2");
});
