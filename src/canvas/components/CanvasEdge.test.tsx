// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { CanvasEdgeData, CanvasNode } from "../types";
import { CanvasEdge, markerIds } from "./CanvasEdge";

// Two non-square nodes so a half-width / half-height mistake changes the geometry.
const nodeA: CanvasNode = { id: "a", type: "text", x: 0, y: 0, width: 200, height: 60, text: "A" };
const nodeB: CanvasNode = {
	id: "b",
	type: "text",
	x: 400,
	y: 300,
	width: 80,
	height: 40,
	text: "B",
};
const nodeMap = new Map<string, CanvasNode>([
	[nodeA.id, nodeA],
	[nodeB.id, nodeB],
]);

function endpoints(edge: CanvasEdgeData, nodes: Map<string, CanvasNode>) {
	const fromNode = nodes.get(edge.fromNode);
	const toNode = nodes.get(edge.toNode);
	if (!fromNode || !toNode) throw new Error("test edge names a missing node");
	return { fromNode, toNode };
}

const baseEdge: CanvasEdgeData = { id: "e1", fromNode: "a", toNode: "b" };

afterEach(cleanup);

function renderEdge(
	edgeOverrides: Partial<CanvasEdgeData> = {},
	props: { isHighlighted?: boolean; isSelected?: boolean; onSelect?: (id: string) => void } = {},
	nodes: Map<string, CanvasNode> = nodeMap,
) {
	const edge = { ...baseEdge, ...edgeOverrides };
	const { container } = render(
		<svg role="img" aria-label="canvas edges">
			<CanvasEdge edge={edge} {...endpoints(edge, nodes)} markerPrefix="m" {...props} />
		</svg>,
	);
	const path = container.querySelector("path.canvas-edge-path");
	if (!path) throw new Error("CanvasEdge rendered no <path>");
	const group = container.querySelector<SVGGElement>("g");
	if (!group) throw new Error("CanvasEdge rendered no <g>");
	return { container, path, group };
}

test("anchors a right-to-left edge to the facing sides and curves between them", () => {
	const { path } = renderEdge({ fromSide: "right", toSide: "left" });
	// a.right = (200, 30), b.left = (400, 320); dist = 352.28 -> tension capped at 120
	expect(path.getAttribute("d")).toBe("M 200 30 C 320 30, 280 320, 400 320");
});

test("anchors a top-to-bottom edge and pushes both control points along their sides", () => {
	const { path } = renderEdge({ fromSide: "top", toSide: "bottom" });
	// a.top = (100, 0), b.bottom = (440, 340); tension 120
	expect(path.getAttribute("d")).toBe("M 100 0 C 100 -120, 440 460, 440 340");
});

test("anchors a left-to-right edge to the facing sides", () => {
	const { path } = renderEdge({ fromSide: "left", toSide: "right" });
	// a.left = (0, 30), b.right = (480, 320); tension 120
	expect(path.getAttribute("d")).toBe("M 0 30 C -120 30, 600 320, 480 320");
});

test("anchors a bottom-to-top edge (upward curve) to the facing sides", () => {
	const { path } = renderEdge({ fromSide: "bottom", toSide: "top" });
	// a.bottom = (100, 60), b.top = (440, 300); tension 120
	expect(path.getAttribute("d")).toBe("M 100 60 C 100 180, 440 180, 440 300");
});

test("attaches to the facing sides when sides are absent, not the node centres", () => {
	// b sits mostly below a: |dy| 290 > |dx| 340? no — dx 340 dominates, so
	// a.right = (200, 30) and b.left = (400, 320), as Obsidian draws it.
	const { path } = renderEdge();
	expect(path.getAttribute("d")).toBe("M 200 30 C 320 30, 280 320, 400 320");
});

test("picks the facing sides in reverse when the target sits to the left", () => {
	const { path } = renderEdge({ fromNode: "b", toNode: "a" });
	// b.left = (400, 320), a.right = (200, 30)
	expect(path.getAttribute("d")).toBe("M 400 320 C 280 320, 320 30, 200 30");
});

test("scales the curve tension with short edges instead of always using the cap", () => {
	const near = new Map<string, CanvasNode>([
		["a", { id: "a", type: "text", x: 0, y: 0, width: 100, height: 100, text: "A" }],
		["b", { id: "b", type: "text", x: 140, y: 0, width: 100, height: 100, text: "B" }],
	]);
	const { path } = renderEdge({ fromSide: "right", toSide: "left" }, {}, near);
	// a.right = (100, 50), b.left = (140, 50); dist 40 -> tension 20, not 120
	expect(path.getAttribute("d")).toBe("M 100 50 C 120 50, 120 50, 140 50");
});

test("draws a self loop between opposite sides of the same node", () => {
	const solo = new Map<string, CanvasNode>([["a", nodeA]]);
	const { path } = renderEdge(
		{ fromNode: "a", toNode: "a", fromSide: "right", toSide: "left" },
		{},
		solo,
	);
	// a.right = (200, 30) -> a.left = (0, 30); dist 200 -> tension 100
	expect(path.getAttribute("d")).toBe("M 200 30 C 300 30, -100 30, 0 30");
});

test("adds an end marker only when the target end is an arrow", () => {
	const plain = renderEdge({ fromEnd: "none", toEnd: "none" });
	expect(plain.path.getAttribute("marker-end")).toBeNull();
	expect(plain.path.getAttribute("marker-start")).toBeNull();

	const arrowEnd = renderEdge({ toEnd: "arrow" });
	expect(arrowEnd.path.getAttribute("marker-end")).toBe("url(#m-arrow-e1)");
	expect(arrowEnd.path.getAttribute("marker-start")).toBeNull();

	const arrowStart = renderEdge({ fromEnd: "arrow", toEnd: "none" });
	expect(arrowStart.path.getAttribute("marker-start")).toBe("url(#m-arrow-start-e1)");
	expect(arrowStart.path.getAttribute("marker-end")).toBeNull();
});

test("defaults to an end arrow when toEnd is omitted", () => {
	expect(renderEdge().path.getAttribute("marker-end")).toBe("url(#m-arrow-e1)");
});

test("strokes the edge with its resolved colour", () => {
	expect(renderEdge({ color: "#ff0000" }).path.getAttribute("stroke")).toBe("#ff0000");
	expect(renderEdge({ color: "3" }).path.getAttribute("stroke")).toBe("var(--canvas-color-3)");
	expect(renderEdge({ color: "not-a-color" }).path.getAttribute("stroke")).toBe(
		"var(--canvas-edge-color)",
	);
	expect(renderEdge().path.getAttribute("stroke")).toBe("var(--canvas-edge-color)");
});

test("draws a muted edge normally and a brighter, thicker one when highlighted", () => {
	const plain = renderEdge();
	expect(plain.path.getAttribute("stroke-width")).toBe("2");
	expect(plain.path.getAttribute("stroke-opacity")).toBe("0.75");
	expect(plain.group.getAttribute("class")).toBe("canvas-edge");

	const highlighted = renderEdge({}, { isHighlighted: true });
	expect(highlighted.path.getAttribute("stroke-width")).toBe("3");
	expect(highlighted.path.getAttribute("stroke-opacity")).toBe("1");
	expect(highlighted.group.getAttribute("class")).toBe("canvas-edge canvas-edge-highlighted");
});

test("emphasises the selected edge over the hover highlight", () => {
	const selected = renderEdge({}, { isSelected: true });
	expect(selected.path.getAttribute("stroke-width")).toBe("4");
	expect(selected.path.getAttribute("stroke-opacity")).toBe("1");

	const both = renderEdge({}, { isSelected: true, isHighlighted: true });
	expect(both.path.getAttribute("stroke-width")).toBe("4");
});

test("centres the label on the curve's own midpoint, in a themed box that wraps", () => {
	const { container } = renderEdge({ label: "depends\non" });
	const box = container.querySelector("foreignObject");
	const label = container.querySelector(".canvas-edge-label");
	expect(label?.textContent).toBe("depends\non");
	// B(0.5) of M 200 30 C 320 30, 280 320, 400 320 is (300, 175); the 240x120
	// box is centred on it.
	expect(box?.getAttribute("x")).toBe("180");
	expect(box?.getAttribute("y")).toBe("115");
	// Colours come from the theme variables, not hard-coded greys.
	expect(container.innerHTML).not.toContain("#666666");
});

test("renders no label element when the edge has no label", () => {
	const { container } = renderEdge();
	expect(container.querySelector(".canvas-edge-label")).toBeNull();
});

test("prefixes marker ids per renderer instance so two boards on a page never share one", () => {
	expect(markerIds("one", "edge-1")).not.toEqual(markerIds("two", "edge-1"));
	expect(markerIds("one", "edge 1").end).toBe("one-arrow-edge_1");
});

test("selects the edge on click without triggering the parent canvas handler", () => {
	const parentClick = mock(() => {});
	const onSelect = mock((id: string) => void id);
	const { container } = render(
		<button type="button" onClick={parentClick}>
			<svg role="img" aria-label="canvas edges">
				<CanvasEdge
					edge={baseEdge}
					{...endpoints(baseEdge, nodeMap)}
					markerPrefix="m"
					onSelect={onSelect}
				/>
			</svg>
		</button>,
	);
	const path = container.querySelector("path.canvas-edge-path");
	if (!path) throw new Error("CanvasEdge rendered no <path>");
	fireEvent.click(path);
	expect(onSelect).toHaveBeenCalledTimes(1);
	expect(onSelect.mock.calls[0]?.[0]).toBe("e1");
	expect(parentClick).not.toHaveBeenCalled();
});

test("is only an interactive control when a select handler is supplied", () => {
	const interactive = renderEdge({}, { onSelect: () => {} });
	expect(interactive.group.getAttribute("role")).toBe("button");
	expect(interactive.group.style.cursor).toBe("pointer");

	const staticEdge = renderEdge();
	expect(staticEdge.group.getAttribute("role")).toBeNull();
	expect(staticEdge.group.style.cursor).toBe("");
});

test("takes focus and selects with Enter or Space when interactive", () => {
	const onSelect = mock((id: string) => void id);
	const { group } = renderEdge({}, { onSelect });

	// An SVG <g> is not focusable by default, so a pointer-free user could not
	// reach the edge at all without this.
	expect(group.getAttribute("tabindex")).toBe("0");

	fireEvent.keyDown(group, { key: "Enter" });
	fireEvent.keyDown(group, { key: " " });
	expect(onSelect.mock.calls.map((call) => call[0])).toEqual(["e1", "e1"]);
});

test("names the edge for assistive tech and stays out of the tab order when static", () => {
	const labelled = renderEdge({ label: "depends on" }, { onSelect: () => {} });
	expect(labelled.group.getAttribute("aria-label")).toBe("depends on");

	const unlabelled = renderEdge({}, { onSelect: () => {} });
	expect(unlabelled.group.getAttribute("aria-label")).toBe("Canvas edge");

	const staticEdge = renderEdge();
	expect(staticEdge.group.getAttribute("tabindex")).toBeNull();
	expect(staticEdge.group.getAttribute("aria-label")).toBeNull();
});

test("ignores keyboard activation when the edge is not interactive", () => {
	const onSelect = mock((id: string) => void id);
	const { group } = renderEdge({}, {});
	fireEvent.keyDown(group, { key: "Enter" });
	expect(onSelect).not.toHaveBeenCalled();
});
