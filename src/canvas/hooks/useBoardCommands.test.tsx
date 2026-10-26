// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useRef } from "react";
import type { CanvasData, CanvasNode } from "../types";
import { exportFileName, useBoardCommands } from "./useBoardCommands";
import { useCanvasEditor } from "./useCanvasEditor";
import { useCanvasSelection } from "./useCanvasSelection";

afterEach(() => {
	cleanup();
	document.body.replaceChildren();
});

function board(): CanvasData {
	return {
		nodes: [
			{ id: "a", type: "text", x: 0, y: 0, width: 100, height: 50, text: "a" },
			{ id: "b", type: "text", x: 200, y: 0, width: 100, height: 50, text: "b" },
			{ id: "c", type: "text", x: 400, y: 0, width: 100, height: 50, text: "c" },
		],
		edges: [
			{ id: "ab", fromNode: "a", toNode: "b" },
			{ id: "bc", fromNode: "b", toNode: "c" },
		],
	};
}

/** A viewport element measuring 800×600, panned to (100, 50) at zoom 2. */
function viewportElement(): HTMLElement {
	const element = document.createElement("div");
	element.tabIndex = 0;
	element.getBoundingClientRect = () => ({ width: 800, height: 600 }) as DOMRect;
	document.body.append(element);
	return element;
}

function setup() {
	const element = viewportElement();
	const editNode = mock((_node: CanvasNode) => {});
	const view = renderHook(() => {
		const editor = useCanvasEditor(board());
		const selection = useCanvasSelection();
		const canvasRef = useRef(editor.canvas);
		canvasRef.current = editor.canvas;
		const commands = useBoardCommands({
			canvasRef,
			viewportRef: { current: { x: 100, y: 50, zoom: 2 } },
			containerRef: { current: element },
			commit: editor.commit,
			selectedNodeIds: selection.selectedNodeIds,
			selectedEdgeId: selection.selectedEdgeId,
			setSelectedNodeIds: selection.setSelectedNodeIds,
			setSelectedEdgeId: selection.setSelectedEdgeId,
			editNode,
			boardId: "notes/Plan.canvas",
			editorTitle: "Canvas editor",
		});
		return { editor, selection, commands };
	});
	return { ...view, element, editNode };
}

const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe("exportFileName", () => {
	test("names the file after the board, else after the editor title", () => {
		expect(exportFileName("vault/Plans/Roadmap.canvas", "Canvas editor")).toBe("Roadmap.canvas");
		expect(exportFileName(undefined, "My Big Board")).toBe("my-big-board.canvas");
		expect(exportFileName(undefined, "")).toBe("canvas.canvas");
	});
});

describe("useBoardCommands", () => {
	test("a new card lands centred in view and becomes the selection", () => {
		const { result } = setup();
		act(() => result.current.selection.selectEdge("ab"));
		act(() => result.current.commands.createFileCard());
		const created = result.current.editor.canvas.nodes.at(-1);
		if (!created) throw new Error("no card created");
		// The view centre (400, 300) on screen is ((400-100)/2, (300-50)/2) in the world.
		expect(created.x + created.width / 2).toBe(150);
		expect(created.y + created.height / 2).toBe(125);
		expect(result.current.selection.selectedNodeIds).toEqual([created.id]);
		expect(result.current.selection.selectedEdgeId).toBeNull();
		expect(result.current.editor.canUndo).toBe(true);
	});

	test("a new text card opens in the editor; other cards do not", () => {
		const { result, editNode } = setup();
		act(() => result.current.commands.createLinkCard());
		act(() => result.current.commands.createGroupCard());
		expect(editNode.mock.calls.length).toBe(0);
		act(() => result.current.commands.createTextCard());
		expect(editNode.mock.calls[0]?.[0]).toEqual(result.current.editor.canvas.nodes.at(-1));
	});

	test("deleting the selection removes the cards and every edge touching them, undoably", () => {
		const { result, element } = setup();
		act(() => result.current.selection.selectNode("b", false));
		act(() => result.current.commands.deleteSelected());
		expect(ids(result.current.editor.canvas.nodes)).toEqual(["a", "c"]);
		expect(result.current.editor.canvas.edges).toEqual([]);
		expect(result.current.selection.selectedNodeIds).toEqual([]);
		expect(document.activeElement).toBe(element);

		act(() => result.current.editor.undo());
		expect(ids(result.current.editor.canvas.nodes)).toEqual(["a", "b", "c"]);
		expect(ids(result.current.editor.canvas.edges)).toEqual(["ab", "bc"]);
	});

	test("deleting the selected edge removes only that edge", () => {
		const { result } = setup();
		act(() => result.current.selection.selectEdge("bc"));
		act(() => result.current.commands.deleteSelectedEdge());
		expect(ids(result.current.editor.canvas.edges)).toEqual(["ab"]);
		expect(result.current.selection.selectedEdgeId).toBeNull();
	});

	test("deleting with nothing selected records nothing", () => {
		const { result } = setup();
		act(() => result.current.commands.deleteSelected());
		act(() => result.current.commands.deleteSelectedEdge());
		expect(result.current.editor.canUndo).toBe(false);
	});

	test("nudging moves every selected card as one undo step", () => {
		const { result } = setup();
		act(() => result.current.selection.selectNode("a", false));
		act(() => result.current.selection.selectNode("c", true));
		act(() => result.current.commands.nudgeSelected(10, -5));
		const [a, b, c] = result.current.editor.canvas.nodes;
		expect([a?.x, a?.y, b?.x, c?.x, c?.y]).toEqual([10, -5, 200, 410, -5]);
		act(() => result.current.editor.undo());
		expect(result.current.editor.canvas.nodes.map((node) => node.x)).toEqual([0, 200, 400]);
	});

	test("connecting adds an edge between two distinct cards", () => {
		const { result } = setup();
		act(() => result.current.commands.connectEdge("a", "a"));
		act(() => result.current.commands.connectEdge("a", "missing"));
		expect(result.current.editor.canvas.edges).toHaveLength(2);
		act(() => result.current.commands.connectEdge("c", "a"));
		const added = result.current.editor.canvas.edges.at(-1);
		expect([added?.fromNode, added?.toNode]).toEqual(["c", "a"]);
	});

	test("exporting downloads the serialised board under the board's name", async () => {
		const blobs: Blob[] = [];
		const names: string[] = [];
		const originalCreate = URL.createObjectURL;
		const originalRevoke = URL.revokeObjectURL;
		const originalClick = HTMLAnchorElement.prototype.click;
		URL.createObjectURL = (blob: Blob) => {
			blobs.push(blob);
			return "blob:canvas";
		};
		URL.revokeObjectURL = () => {};
		HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
			names.push(this.download);
		};
		try {
			const { result } = setup();
			act(() => result.current.commands.exportCanvas());
			expect(names).toEqual(["Plan.canvas"]);
			const exported = JSON.parse(await (blobs[0] as Blob).text()) as CanvasData;
			expect(ids(exported.nodes)).toEqual(["a", "b", "c"]);
		} finally {
			URL.createObjectURL = originalCreate;
			URL.revokeObjectURL = originalRevoke;
			HTMLAnchorElement.prototype.click = originalClick;
		}
	});
});
