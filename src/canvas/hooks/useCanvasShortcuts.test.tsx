// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { KeyboardEvent } from "react";
import {
	type CanvasShortcuts,
	KEY_STEP,
	NUDGE_STEP,
	useCanvasShortcuts,
} from "./useCanvasShortcuts";

afterEach(cleanup);

type Actions = Omit<CanvasShortcuts, "editable" | "selectedNodeIds" | "selectedEdgeId">;

function actions() {
	return {
		escape: mock(() => {}),
		undo: mock(() => {}),
		redo: mock(() => {}),
		exportCanvas: mock(() => {}),
		deleteSelectedEdge: mock(() => {}),
		deleteSelected: mock(() => {}),
		startEditing: mock((_id: string) => {}),
		nudgeSelected: mock((_dx: number, _dy: number) => {}),
		panBy: mock((_dx: number, _dy: number) => {}),
		zoomIn: mock(() => {}),
		zoomOut: mock(() => {}),
		resetZoom: mock(() => {}),
		fitToView: mock(() => {}),
	} satisfies Actions;
}

type Handler = (event: KeyboardEvent) => void;

function Board({
	onHandler,
	...props
}: CanvasShortcuts & { onHandler?: (handler: Handler) => void }) {
	const handleKeyDown = useCanvasShortcuts(props);
	onHandler?.(handleKeyDown);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: a stand-in for the focusable canvas viewport
		<div data-testid="board" tabIndex={-1} onKeyDown={handleKeyDown}>
			<textarea data-testid="field" />
		</div>
	);
}

function setup(state: Partial<CanvasShortcuts> = {}) {
	const spies = actions();
	render(<Board editable selectedNodeIds={[]} selectedEdgeId={null} {...spies} {...state} />);
	return spies;
}

/** Press `key` on the board; true when the handler claimed it (prevented the default). */
const press = (key: string, init: Record<string, unknown> = {}) =>
	!fireEvent.keyDown(screen.getByTestId("board"), { key, ...init });

describe("useCanvasShortcuts", () => {
	test("Escape works even from a text field", () => {
		const spies = setup();
		fireEvent.keyDown(screen.getByTestId("field"), { key: "Escape" });
		expect(spies.escape).toHaveBeenCalledTimes(1);
	});

	test("keys typed into a text field are left to it", () => {
		const spies = setup({ selectedNodeIds: ["a"] });
		const field = screen.getByTestId("field");
		fireEvent.keyDown(field, { key: "Backspace" });
		fireEvent.keyDown(field, { key: "z", ctrlKey: true });
		fireEvent.keyDown(field, { key: "f" });
		expect(spies.deleteSelected).not.toHaveBeenCalled();
		expect(spies.undo).not.toHaveBeenCalled();
		expect(spies.fitToView).not.toHaveBeenCalled();
	});

	test("Ctrl/⌘ shortcuts undo, redo and export in the editor", () => {
		const spies = setup();
		expect(press("z", { ctrlKey: true })).toBe(true);
		expect(spies.undo).toHaveBeenCalledTimes(1);
		press("Z", { metaKey: true, shiftKey: true });
		press("y", { ctrlKey: true });
		expect(spies.redo).toHaveBeenCalledTimes(2);
		expect(press("s", { metaKey: true })).toBe(true);
		expect(spies.exportCanvas).toHaveBeenCalledTimes(1);
	});

	test("the read-only viewer has no editing shortcuts", () => {
		const spies = setup({ editable: false, selectedNodeIds: ["a"] });
		expect(press("z", { ctrlKey: true })).toBe(false);
		expect(press("s", { ctrlKey: true })).toBe(false);
		press("Delete");
		press("Enter");
		expect(spies.undo).not.toHaveBeenCalled();
		expect(spies.exportCanvas).not.toHaveBeenCalled();
		expect(spies.deleteSelected).not.toHaveBeenCalled();
		expect(spies.startEditing).not.toHaveBeenCalled();
	});

	test("modified view keys stay with the browser", () => {
		const spies = setup();
		expect(press("f", { ctrlKey: true })).toBe(false);
		expect(press("0", { metaKey: true })).toBe(false);
		expect(press("ArrowLeft", { altKey: true })).toBe(false);
		expect(spies.fitToView).not.toHaveBeenCalled();
		expect(spies.resetZoom).not.toHaveBeenCalled();
		expect(spies.panBy).not.toHaveBeenCalled();
	});

	test("Delete removes the selected edge, else the selected cards", () => {
		const withEdge = setup({ selectedEdgeId: "ab" });
		expect(press("Delete")).toBe(true);
		expect(withEdge.deleteSelectedEdge).toHaveBeenCalledTimes(1);
		expect(withEdge.deleteSelected).not.toHaveBeenCalled();
		cleanup();

		const withCards = setup({ selectedNodeIds: ["a"] });
		press("Backspace");
		expect(withCards.deleteSelected).toHaveBeenCalledTimes(1);
	});

	test("Enter edits the one selected card", () => {
		const one = setup({ selectedNodeIds: ["a"] });
		expect(press("Enter")).toBe(true);
		expect(one.startEditing).toHaveBeenCalledWith("a");
		cleanup();

		const two = setup({ selectedNodeIds: ["a", "b"] });
		press("Enter");
		expect(two.startEditing).not.toHaveBeenCalled();
	});

	test("arrows nudge the selection in the editor, Shift by five steps", () => {
		const spies = setup({ selectedNodeIds: ["a"] });
		expect(press("ArrowRight")).toBe(true);
		press("ArrowUp", { shiftKey: true });
		expect(spies.nudgeSelected.mock.calls).toEqual([
			[NUDGE_STEP, 0],
			[0, -NUDGE_STEP * 5],
		]);
		expect(spies.panBy).not.toHaveBeenCalled();
	});

	test("arrows pan the board otherwise, Shift by four steps", () => {
		const spies = setup({ editable: false, selectedNodeIds: ["a"] });
		press("ArrowRight");
		press("ArrowDown", { shiftKey: true });
		expect(spies.panBy.mock.calls).toEqual([
			[-KEY_STEP, -0],
			[-0, -KEY_STEP * 4],
		]);
		expect(spies.nudgeSelected).not.toHaveBeenCalled();
	});

	test("bare keys zoom, reset and fit the view", () => {
		const spies = setup();
		press("+");
		press("=");
		press("-");
		press("0");
		press("F");
		expect(spies.zoomIn).toHaveBeenCalledTimes(2);
		expect(spies.zoomOut).toHaveBeenCalledTimes(1);
		expect(spies.resetZoom).toHaveBeenCalledTimes(1);
		expect(spies.fitToView).toHaveBeenCalledTimes(1);
	});

	test("the handler keeps one identity and acts on the latest state", () => {
		const handlers: Handler[] = [];
		const onHandler = (handler: Handler) => handlers.push(handler);
		const spies = actions();
		const { rerender } = render(
			<Board
				editable
				selectedNodeIds={[]}
				selectedEdgeId={null}
				onHandler={onHandler}
				{...spies}
			/>,
		);
		rerender(
			<Board
				editable
				selectedNodeIds={["b"]}
				selectedEdgeId={null}
				onHandler={onHandler}
				{...spies}
			/>,
		);
		expect(handlers[1]).toBe(handlers[0]);
		press("Enter");
		expect(spies.startEditing).toHaveBeenCalledWith("b");
	});
});
