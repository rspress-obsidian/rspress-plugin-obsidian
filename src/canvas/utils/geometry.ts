import type { CanvasNodeData, NodeSide } from "../types.js";

export interface Point {
	x: number;
	y: number;
}

type Box = Pick<CanvasNodeData, "x" | "y" | "width" | "height">;

function center(node: Box): Point {
	return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
}

/**
 * The sides two nodes face each other on. JSON Canvas makes `fromSide` and
 * `toSide` optional, and Obsidian then attaches the edge to the facing sides:
 * along the dominant axis between the two centres. Anchoring at the centre
 * instead buried the arrowhead under the target card.
 */
export function facingSides(from: Box, to: Box): { fromSide: NodeSide; toSide: NodeSide } {
	const a = center(from);
	const b = center(to);
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	if (Math.abs(dx) >= Math.abs(dy)) {
		return dx >= 0 ? { fromSide: "right", toSide: "left" } : { fromSide: "left", toSide: "right" };
	}
	return dy >= 0 ? { fromSide: "bottom", toSide: "top" } : { fromSide: "top", toSide: "bottom" };
}

export function sidePoint(node: Box, side: NodeSide): Point {
	switch (side) {
		case "top":
			return { x: node.x + node.width / 2, y: node.y };
		case "right":
			return { x: node.x + node.width, y: node.y + node.height / 2 };
		case "bottom":
			return { x: node.x + node.width / 2, y: node.y + node.height };
		default:
			return { x: node.x, y: node.y + node.height / 2 };
	}
}

const SIDE_DIRECTION: Record<NodeSide, Point> = {
	top: { x: 0, y: -1 },
	right: { x: 1, y: 0 },
	bottom: { x: 0, y: 1 },
	left: { x: -1, y: 0 },
};

export interface EdgeCurve {
	start: Point;
	end: Point;
	cp1: Point;
	cp2: Point;
	/** The curve's own midpoint, B(0.5) — where Obsidian puts the label. */
	mid: Point;
}

/**
 * The cubic bezier an edge is drawn as. Each control point leaves its node
 * perpendicular to the side, so the curve meets the card square on.
 */
export function edgeCurve(
	from: Box,
	to: Box,
	fromSide: NodeSide | undefined,
	toSide: NodeSide | undefined,
): EdgeCurve {
	const facing = facingSides(from, to);
	const startSide = fromSide ?? facing.fromSide;
	const endSide = toSide ?? facing.toSide;
	const start = sidePoint(from, startSide);
	const end = sidePoint(to, endSide);
	const tension = Math.min(Math.hypot(end.x - start.x, end.y - start.y) * 0.5, 120);
	const cp1 = {
		x: start.x + SIDE_DIRECTION[startSide].x * tension,
		y: start.y + SIDE_DIRECTION[startSide].y * tension,
	};
	const cp2 = {
		x: end.x + SIDE_DIRECTION[endSide].x * tension,
		y: end.y + SIDE_DIRECTION[endSide].y * tension,
	};
	const mid = {
		x: (start.x + 3 * cp1.x + 3 * cp2.x + end.x) / 8,
		y: (start.y + 3 * cp1.y + 3 * cp2.y + end.y) / 8,
	};
	return { start, end, cp1, cp2, mid };
}
