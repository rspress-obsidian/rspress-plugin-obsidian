// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import type { CanvasData, CanvasEdgeData, CanvasTextData } from "../types";
import {
	applyEditorAction,
	type CanvasEditor,
	type EditorAction,
	type EditorState,
	editorReducer,
	initEditorState,
	useCanvasEditor,
} from "./useCanvasEditor";

afterEach(cleanup);

function text(id: string, x = 0, y = 0): CanvasTextData {
	return { id, type: "text", x, y, width: 100, height: 50, text: id };
}

function edge(id: string, fromNode: string, toNode: string): CanvasEdgeData {
	return { id, fromNode, toNode };
}

function board(): CanvasData {
	return {
		nodes: [text("a"), text("b", 200), text("c", 400)],
		edges: [edge("ab", "a", "b"), edge("bc", "b", "c")],
		notes: { "n.md": "body" },
	};
}

function commit(state: EditorState, action: EditorAction): EditorState {
	return editorReducer(state, {
		type: "commit",
		action,
		next: applyEditorAction(state.canvas, action),
	});
}

const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe("applyEditorAction", () => {
	const actions: [string, EditorAction][] = [
		[
			"move",
			{
				type: "move",
				moves: [
					{ id: "a", from: { x: 0, y: 0 }, to: { x: 10, y: 20 } },
					{ id: "b", from: { x: 200, y: 0 }, to: { x: 210, y: 20 } },
				],
			},
		],
		[
			"resize",
			{ type: "resize", id: "c", from: { width: 100, height: 50 }, to: { width: 300, height: 90 } },
		],
		[
			"update",
			{ type: "update", id: "b", from: text("b", 200), to: { ...text("b", 200), text: "new" } },
		],
		["add-node", { type: "add-node", node: text("d", 600) }],
		[
			"delete-nodes",
			{
				type: "delete-nodes",
				nodes: [{ item: text("b", 200), index: 1 }],
				edges: [
					{ item: edge("ab", "a", "b"), index: 0 },
					{ item: edge("bc", "b", "c"), index: 1 },
				],
			},
		],
		["delete-edge", { type: "delete-edge", edge: { item: edge("ab", "a", "b"), index: 0 } }],
		["add-edge", { type: "add-edge", edge: edge("ca", "c", "a") }],
	];

	for (const [name, action] of actions) {
		test(`${name} applied then reversed restores the board, slots and order included`, () => {
			const source = board();
			const forward = applyEditorAction(source, action);
			expect(forward).not.toEqual(source);
			expect(applyEditorAction(forward, action, true)).toEqual(source);
			// The source is never modified, and the maps keep their identity.
			expect(source).toEqual(board());
			expect(forward.notes).toBe(source.notes);
		});
	}

	test("a delete removes the nodes and the edges it recorded", () => {
		const [, action] = actions.find(([name]) => name === "delete-nodes") ?? [];
		const next = applyEditorAction(board(), action as EditorAction);
		expect(ids(next.nodes)).toEqual(["a", "c"]);
		expect(next.edges).toEqual([]);
	});
});

describe("editorReducer", () => {
	const move: EditorAction = {
		type: "move",
		moves: [{ id: "a", from: { x: 0, y: 0 }, to: { x: 5, y: 5 } }],
	};
	const add: EditorAction = { type: "add-node", node: text("d") };

	test("starts from a copy of the board with no history", () => {
		const data = board();
		const state = initEditorState(data);
		expect(state.canvas).toEqual(data);
		expect(state.canvas.nodes[0]).not.toBe(data.nodes[0]);
		expect(state).toMatchObject({ history: [], future: [], contentVersion: 0 });
	});

	test("undo and redo walk the history and leave nothing to do at either end", () => {
		const start = initEditorState(board());
		expect(editorReducer(start, { type: "undo" })).toBe(start);
		expect(editorReducer(start, { type: "redo" })).toBe(start);

		const moved = commit(commit(start, move), add);
		expect(ids(moved.canvas.nodes)).toEqual(["a", "b", "c", "d"]);

		const undone = editorReducer(moved, { type: "undo" });
		expect(ids(undone.canvas.nodes)).toEqual(["a", "b", "c"]);
		expect(undone.history).toEqual([move]);
		expect(undone.future).toEqual([add]);

		const back = editorReducer(editorReducer(undone, { type: "undo" }), { type: "undo" });
		expect(back.canvas).toEqual(start.canvas);
		expect(back.future).toEqual([add, move]);

		const redone = editorReducer(back, { type: "redo" });
		expect(redone.canvas.nodes[0]).toMatchObject({ x: 5, y: 5 });
		expect(redone.future).toEqual([add]);
	});

	test("a new edit clears the redo stack", () => {
		const undone = editorReducer(commit(initEditorState(board()), add), { type: "undo" });
		expect(undone.future).toHaveLength(1);
		expect(commit(undone, move).future).toEqual([]);
	});

	test("only edits that change what a card renders bump the content version", () => {
		const moved = commit(initEditorState(board()), move);
		expect(moved.contentVersion).toBe(0);
		const added = commit(moved, add);
		expect(added.contentVersion).toBe(1);
		expect(editorReducer(added, { type: "undo" }).contentVersion).toBe(2);
		const undoneMove = editorReducer(editorReducer(added, { type: "undo" }), { type: "undo" });
		expect(undoneMove.contentVersion).toBe(2);
		expect(editorReducer(undoneMove, { type: "redo" }).contentVersion).toBe(2);
	});

	test("a preview frame replaces the board without recording history", () => {
		const start = initEditorState(board());
		const unchanged = editorReducer(start, { type: "preview", update: (canvas) => canvas });
		expect(unchanged).toBe(start);
		const framed = editorReducer(start, {
			type: "preview",
			update: (canvas) => ({ ...canvas, nodes: [text("z")] }),
		});
		expect(ids(framed.canvas.nodes)).toEqual(["z"]);
		expect(framed.history).toEqual([]);
		expect(framed.contentVersion).toBe(0);
	});
});

function Harness({
	data,
	onEditor,
}: {
	data: CanvasData;
	onEditor: (editor: CanvasEditor) => void;
}) {
	onEditor(useCanvasEditor(data));
	return null;
}

describe("useCanvasEditor", () => {
	test("exposes the reducer through callbacks that keep their identity", () => {
		const seen: CanvasEditor[] = [];
		render(<Harness data={board()} onEditor={(editor) => seen.push(editor)} />);
		const first = seen.at(-1) as CanvasEditor;
		expect(first).toMatchObject({ canUndo: false, canRedo: false, contentVersion: 0 });

		const action: EditorAction = { type: "add-node", node: text("d") };
		act(() => first.commit(action, applyEditorAction(first.canvas, action)));
		expect(seen.at(-1)).toMatchObject({ canUndo: true, canRedo: false, contentVersion: 1 });

		act(() => first.undo());
		expect(seen.at(-1)).toMatchObject({ canUndo: false, canRedo: true });
		act(() => first.redo());
		expect(ids(seen.at(-1)?.canvas.nodes ?? [])).toEqual(["a", "b", "c", "d"]);

		act(() => first.preview((canvas) => ({ ...canvas, nodes: [] })));
		const last = seen.at(-1) as CanvasEditor;
		expect(last.canvas.nodes).toEqual([]);
		expect(last.canUndo).toBe(true);
		for (const key of ["commit", "undo", "redo", "preview"] as const) {
			expect(last[key]).toBe(first[key]);
		}
	});
});
