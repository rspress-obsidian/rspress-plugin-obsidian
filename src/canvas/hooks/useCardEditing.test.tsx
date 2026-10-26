// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useRef } from "react";
import type { CanvasData, CanvasNode } from "../types";
import { useCanvasEditor } from "./useCanvasEditor";
import { useCardEditing } from "./useCardEditing";

afterEach(cleanup);

function board(): CanvasData {
	return {
		nodes: [
			{ id: "t", type: "text", x: 0, y: 0, width: 100, height: 50, text: "hello" },
			{ id: "l", type: "link", x: 200, y: 0, width: 100, height: 50, url: "https://example.com" },
		],
		edges: [],
	};
}

function setup(editable = true) {
	return renderHook(() => {
		const editor = useCanvasEditor(board());
		const canvasRef = useRef(editor.canvas);
		canvasRef.current = editor.canvas;
		return { editor, editing: useCardEditing({ editable, canvasRef, commit: editor.commit }) };
	});
}

const textOf = (canvas: CanvasData, id: string) => {
	const node = canvas.nodes.find((item) => item.id === id);
	return node?.type === "text" ? node.text : undefined;
};

describe("useCardEditing", () => {
	test("opens a text card with its text as the draft", () => {
		const { result } = setup();
		act(() => result.current.editing.startEditing("t"));
		expect(result.current.editing.editingNodeId).toBe("t");
		expect(result.current.editing.draftText).toBe("hello");
		expect(result.current.editing.editingRef.current).toEqual({ id: "t", draft: "hello" });
	});

	test("ignores cards that are not text, unknown ids, and a read-only board", () => {
		const editable = setup();
		act(() => editable.result.current.editing.startEditing("l"));
		act(() => editable.result.current.editing.startEditing("missing"));
		expect(editable.result.current.editing.editingNodeId).toBeNull();

		const readOnly = setup(false);
		act(() => readOnly.result.current.editing.startEditing("t"));
		expect(readOnly.result.current.editing.editingNodeId).toBeNull();
	});

	test("committing a changed draft updates the card as one undoable edit", () => {
		const { result } = setup();
		act(() => result.current.editing.startEditing("t"));
		act(() => result.current.editing.setDraftText("bye"));
		act(() => result.current.editing.commitEdit());
		expect(result.current.editing.editingNodeId).toBeNull();
		expect(result.current.editing.editingRef.current).toBeNull();
		expect(textOf(result.current.editor.canvas, "t")).toBe("bye");
		expect(result.current.editor.canUndo).toBe(true);

		act(() => result.current.editor.undo());
		expect(textOf(result.current.editor.canvas, "t")).toBe("hello");
	});

	test("leaving the editor without a change records nothing", () => {
		const { result } = setup();
		act(() => result.current.editing.startEditing("t"));
		act(() => result.current.editing.commitEdit());
		expect(result.current.editing.editingNodeId).toBeNull();
		expect(result.current.editor.canUndo).toBe(false);
	});

	test("committing with no editor open does nothing", () => {
		const { result } = setup();
		act(() => result.current.editing.commitEdit());
		expect(result.current.editor.canUndo).toBe(false);
	});

	test("opens a text card handed over directly, even one not on the board yet", () => {
		const { result } = setup();
		const fresh: CanvasNode = {
			id: "n",
			type: "text",
			x: 0,
			y: 0,
			width: 1,
			height: 1,
			text: "new",
		};
		act(() => result.current.editing.editNode(fresh));
		expect(result.current.editing.editingNodeId).toBe("n");
		expect(result.current.editing.draftText).toBe("new");
	});
});
