import type { KeyboardEvent } from "react";
import { useCallback, useRef } from "react";

/** Screen pixels an arrow key pans the board by; world pixels it nudges a card by. */
export const KEY_STEP = 40;
export const NUDGE_STEP = 10;

const ARROWS: Record<string, [number, number]> = {
	ArrowLeft: [-1, 0],
	ArrowRight: [1, 0],
	ArrowUp: [0, -1],
	ArrowDown: [0, 1],
};

export interface CanvasShortcuts {
	editable: boolean;
	selectedNodeIds: readonly string[];
	selectedEdgeId: string | null;
	/** Escape: leave whatever is in progress (editing, connecting, help, selection). */
	escape: () => void;
	undo: () => void;
	redo: () => void;
	exportCanvas: () => void;
	deleteSelectedEdge: () => void;
	deleteSelected: () => void;
	startEditing: (nodeId: string) => void;
	nudgeSelected: (dx: number, dy: number) => void;
	panBy: (dx: number, dy: number) => void;
	zoomIn: () => void;
	zoomOut: () => void;
	resetZoom: () => void;
	fitToView: () => void;
}

function isTypingTarget(target: EventTarget | null): boolean {
	const element = target as HTMLElement | null;
	return Boolean(
		element?.isContentEditable ||
			(element?.tagName && /^(?:input|textarea|select)$/i.test(element.tagName)),
	);
}

/**
 * The board's keyboard bindings, as one `keydown` handler for the viewport. The
 * handler reads the latest `shortcuts` and keeps one identity for the
 * component's lifetime.
 */
export function useCanvasShortcuts(shortcuts: CanvasShortcuts): (event: KeyboardEvent) => void {
	const shortcutsRef = useRef(shortcuts);
	shortcutsRef.current = shortcuts;

	return useCallback((event: KeyboardEvent) => {
		const { editable, selectedNodeIds, selectedEdgeId, ...run } = shortcutsRef.current;
		// Escape is the one key that must work while editing: it commits the
		// draft and leaves the editor (the textarea unmounting fires no blur in
		// every browser, so the commit cannot be left to onBlur).
		if (event.key === "Escape") {
			run.escape();
			return;
		}
		// Keys typed into the inline card editor belong to the text field: without
		// this, Backspace/Delete deletes the card being edited, `f`/`0`/`+`/`-`
		// refit or zoom the viewport, and Ctrl+Z undoes a canvas action instead of
		// the text. The guard sits above every other binding for that reason.
		if (isTypingTarget(event.target)) return;
		const modifier = event.ctrlKey || event.metaKey;
		const key = event.key.toLowerCase();
		if (editable && modifier && !event.altKey) {
			if (key === "z") {
				event.preventDefault();
				event.shiftKey ? run.redo() : run.undo();
				return;
			}
			if (key === "y") {
				event.preventDefault();
				run.redo();
				return;
			}
			if (key === "s") {
				event.preventDefault();
				run.exportCanvas();
				return;
			}
		}
		// Every other binding is a bare key: Ctrl/⌘+F is the browser's find, and
		// Ctrl+0 its zoom reset, and both must reach the browser untouched.
		if (modifier || event.altKey) return;
		if (editable && (event.key === "Delete" || event.key === "Backspace")) {
			event.preventDefault();
			if (selectedEdgeId) run.deleteSelectedEdge();
			else run.deleteSelected();
			return;
		}
		if (editable && event.key === "Enter" && selectedNodeIds.length === 1) {
			const [id] = selectedNodeIds;
			if (id) {
				event.preventDefault();
				run.startEditing(id);
			}
			return;
		}
		const arrow = ARROWS[event.key];
		if (arrow) {
			event.preventDefault();
			// In the editor the arrows move the selection; otherwise they pan.
			if (editable && selectedNodeIds.length > 0) {
				const step = event.shiftKey ? NUDGE_STEP * 5 : NUDGE_STEP;
				run.nudgeSelected(arrow[0] * step, arrow[1] * step);
			} else {
				const step = event.shiftKey ? KEY_STEP * 4 : KEY_STEP;
				run.panBy(-arrow[0] * step, -arrow[1] * step);
			}
			return;
		}
		if (event.key === "+" || event.key === "=") run.zoomIn();
		else if (event.key === "-") run.zoomOut();
		else if (event.key === "0") run.resetZoom();
		else if (key === "f") run.fitToView();
	}, []);
}
