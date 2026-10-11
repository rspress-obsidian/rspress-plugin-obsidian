import type { CanvasEdgeData, CanvasNode } from "../types.js";
import { facingSides } from "./geometry.js";

function createNodeId(nodes: CanvasNode[]): string {
	let index = nodes.length + 1;
	while (nodes.some((node) => node.id === `node-${index}`)) index += 1;
	return `node-${index}`;
}

function createEdgeId(edges: CanvasEdgeData[]): string {
	let index = edges.length + 1;
	while (edges.some((edge) => edge.id === `edge-${index}`)) index += 1;
	return `edge-${index}`;
}

export function createTextNode(nodes: CanvasNode[], x: number, y: number): CanvasNode {
	return {
		id: createNodeId(nodes),
		type: "text",
		x: Math.round(x),
		y: Math.round(y),
		width: 280,
		height: 160,
		text: "New card",
	};
}

export function createFileNode(
	nodes: CanvasNode[],
	x: number,
	y: number,
	file = "Note.md",
): CanvasNode {
	return {
		id: createNodeId(nodes),
		type: "file",
		x: Math.round(x),
		y: Math.round(y),
		width: 250,
		height: 100,
		file,
	};
}

export function createLinkNode(
	nodes: CanvasNode[],
	x: number,
	y: number,
	url = "https://",
): CanvasNode {
	return {
		id: createNodeId(nodes),
		type: "link",
		x: Math.round(x),
		y: Math.round(y),
		width: 300,
		height: 80,
		url,
	};
}

export function createGroupNode(nodes: CanvasNode[], x: number, y: number): CanvasNode {
	return {
		id: createNodeId(nodes),
		type: "group",
		x: Math.round(x),
		y: Math.round(y),
		width: 480,
		height: 320,
		label: "Group",
	};
}

/**
 * A new edge between two nodes, attached on the sides they face — what
 * Obsidian records when you draw one — so the arrow lands on the target's
 * border instead of under it.
 */
export function createEdge(
	edges: CanvasEdgeData[],
	fromNode: CanvasNode,
	toNode: CanvasNode,
): CanvasEdgeData {
	const { fromSide, toSide } = facingSides(fromNode, toNode);
	return {
		id: createEdgeId(edges),
		fromNode: fromNode.id,
		fromSide,
		fromEnd: "none",
		toNode: toNode.id,
		toSide,
		toEnd: "arrow",
	};
}
