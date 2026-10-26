// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { CanvasEdgeData, CanvasNode } from "../types";
import { type CanvasGroupsOptions, useCanvasGroups } from "./useCanvasGroups";

afterEach(cleanup);

function card(id: string, x: number, y: number): CanvasNode {
	return { id, type: "text", x, y, width: 100, height: 50, text: id };
}

const group: CanvasNode = { id: "g", type: "group", x: 0, y: 0, width: 400, height: 300 };
const nodes: CanvasNode[] = [group, card("a", 20, 20), card("b", 200, 200), card("c", 800, 0)];
const edges: CanvasEdgeData[] = [
	{ id: "ab", fromNode: "a", toNode: "b" },
	{ id: "bc", fromNode: "b", toNode: "c" },
];
const ids = (items: { id: string }[]) => items.map((item) => item.id);

function setup(overrides: Partial<CanvasGroupsOptions> = {}) {
	const onHide = mock((_hidden: ReadonlySet<string>) => {});
	const view = renderHook((props: CanvasGroupsOptions) => useCanvasGroups(props), {
		initialProps: { nodes, edges, isDragging: false, onHide, ...overrides },
	});
	return { ...view, onHide };
}

describe("useCanvasGroups", () => {
	test("each group holds the nodes inside its box", () => {
		const { result } = setup();
		expect(result.current.groupMembers.get("g")).toEqual(["a", "b"]);
		expect(result.current.membersOf("g")).toEqual(["a", "b"]);
		expect(result.current.membersOf("a")).toEqual([]);
	});

	test("collapsing hides the members and the edges wholly inside, and reports the hidden ids", () => {
		const { result, onHide } = setup();
		act(() => result.current.toggleGroupCollapse("g"));
		expect(result.current.collapsedGroupIds).toEqual(["g"]);
		expect(ids(result.current.visibleNodes)).toEqual(["g", "c"]);
		// An edge with one visible endpoint stays: it still points at the group's box.
		expect(ids(result.current.visibleEdges)).toEqual(["bc"]);
		expect(onHide).toHaveBeenCalledTimes(1);
		expect([...(onHide.mock.calls[0]?.[0] ?? [])]).toEqual(["a", "b"]);

		act(() => result.current.toggleGroupCollapse("g"));
		expect(result.current.collapsedGroupIds).toEqual([]);
		expect(result.current.visibleNodes).toBe(nodes);
		expect(result.current.visibleEdges).toBe(edges);
	});

	test("membership stays frozen while a drag runs and follows the nodes once it ends", () => {
		const { result, rerender, onHide } = setup();
		const moved = nodes.map((node) => (node.id === "a" ? card("a", 600, 600) : node));
		rerender({ nodes: moved, edges, isDragging: true, onHide });
		expect(result.current.membersOf("g")).toEqual(["a", "b"]);
		rerender({ nodes: moved, edges, isDragging: false, onHide });
		expect(result.current.membersOf("g")).toEqual(["b"]);
	});

	test("forgets a collapsed group once it leaves the board", () => {
		const { result, rerender, onHide } = setup();
		act(() => result.current.toggleGroupCollapse("g"));
		const withoutGroup = nodes.filter((node) => node.id !== "g");
		rerender({ nodes: withoutGroup, edges, isDragging: false, onHide });
		expect(result.current.collapsedGroupIds).toEqual([]);
		// A new group taking the freed id starts expanded.
		rerender({ nodes, edges, isDragging: false, onHide });
		expect(ids(result.current.visibleNodes)).toEqual(["g", "a", "b", "c"]);
	});

	test("the callbacks keep one identity across board changes", () => {
		const { result, rerender, onHide } = setup();
		const { membersOf, toggleGroupCollapse } = result.current;
		rerender({ nodes: [...nodes], edges, isDragging: false, onHide });
		expect(result.current.membersOf).toBe(membersOf);
		expect(result.current.toggleGroupCollapse).toBe(toggleGroupCollapse);
	});
});
