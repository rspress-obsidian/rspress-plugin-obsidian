// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { afterEach, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useCanvasSelection } from "./useCanvasSelection";

afterEach(cleanup);

test("selecting a node replaces the selection; extending toggles it in and out", () => {
	const { result } = renderHook(() => useCanvasSelection());
	act(() => result.current.selectNode("a", false));
	act(() => result.current.selectNode("b", true));
	expect(result.current.selectedNodeIds).toEqual(["a", "b"]);
	act(() => result.current.selectNode("a", true));
	expect(result.current.selectedNodeIds).toEqual(["b"]);
	act(() => result.current.selectNode("c", false));
	expect(result.current.selectedNodeIds).toEqual(["c"]);
});

test("re-selecting the only selected node keeps the same selection", () => {
	const { result } = renderHook(() => useCanvasSelection());
	act(() => result.current.selectNode("a", false));
	const before = result.current.selectedNodeIds;
	act(() => result.current.selectNode("a", false));
	expect(result.current.selectedNodeIds).toBe(before);
});

test("node and edge selection are exclusive", () => {
	const { result } = renderHook(() => useCanvasSelection());
	act(() => result.current.selectNode("a", false));
	act(() => result.current.selectEdge("ab"));
	expect(result.current.selectedNodeIds).toEqual([]);
	expect(result.current.selectedEdgeId).toBe("ab");
	act(() => result.current.selectNode("b", false));
	expect(result.current.selectedEdgeId).toBeNull();
	expect(result.current.selectedNodeIds).toEqual(["b"]);
});

test("clearing drops both kinds of selection", () => {
	const { result } = renderHook(() => useCanvasSelection());
	act(() => result.current.selectNode("a", false));
	act(() => result.current.clearSelection());
	expect(result.current.selectedNodeIds).toEqual([]);
	act(() => result.current.selectEdge("ab"));
	act(() => result.current.clearSelection());
	expect(result.current.selectedEdgeId).toBeNull();
});

test("the callbacks keep one identity across selection changes", () => {
	const { result } = renderHook(() => useCanvasSelection());
	const { selectNode, selectEdge, clearSelection } = result.current;
	act(() => result.current.selectNode("a", false));
	expect(result.current.selectNode).toBe(selectNode);
	expect(result.current.selectEdge).toBe(selectEdge);
	expect(result.current.clearSelection).toBe(clearSelection);
});
