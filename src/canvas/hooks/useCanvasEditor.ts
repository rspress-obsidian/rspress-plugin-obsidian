import { useCallback, useReducer } from "react";
import type { CanvasData, CanvasEdgeData, CanvasNode } from "../types.js";

/** One node's travel within a move action. */
export interface NodeMove {
	id: string;
	from: { x: number; y: number };
	to: { x: number; y: number };
}

/** An item removed by a delete, with the array slot it is restored to. */
interface Placed<T> {
	item: T;
	index: number;
}

/** One undoable edit. Each carries both directions, so undo needs no snapshot. */
export type EditorAction =
	// A drag that moves several nodes — a group and the members it holds — is one
	// action, so undo restores the whole gesture in a single step.
	| { type: "move"; moves: NodeMove[] }
	| {
			type: "resize";
			id: string;
			from: { width: number; height: number };
			to: { width: number; height: number };
	  }
	| { type: "update"; id: string; from: CanvasNode; to: CanvasNode }
	| { type: "add-node"; node: CanvasNode }
	// Array order is z-order, so a delete remembers where each item sat and
	// undo puts it back there rather than on top of everything.
	| { type: "delete-nodes"; nodes: Placed<CanvasNode>[]; edges: Placed<CanvasEdgeData>[] }
	| { type: "delete-edge"; edge: Placed<CanvasEdgeData> }
	| { type: "add-edge"; edge: CanvasEdgeData };

/** Actions that change what a card renders (as opposed to where it sits). */
const CONTENT_ACTIONS: Record<EditorAction["type"], boolean> = {
	move: false,
	resize: false,
	update: true,
	"add-node": true,
	"delete-nodes": true,
	"delete-edge": false,
	"add-edge": false,
};

export interface EditorState {
	canvas: CanvasData;
	/** Applied actions, oldest first; undo takes the last. */
	history: EditorAction[];
	/** Undone actions, oldest undo first; redo takes the last. */
	future: EditorAction[];
	/**
	 * Bumped by every change to what a card renders, so diagrams and math are
	 * re-scanned then and not on every drag frame.
	 */
	contentVersion: number;
}

export type EditorMessage =
	/** Record `action`, whose result the caller already computed as `next`. */
	| { type: "commit"; action: EditorAction; next: CanvasData }
	| { type: "undo" }
	| { type: "redo" }
	/**
	 * A live gesture frame (drag, resize): replaces the board without touching
	 * the history. The gesture is committed once, when it ends. Returning the
	 * same board from `update` changes nothing, so React skips the render.
	 */
	| { type: "preview"; update: (canvas: CanvasData) => CanvasData };

/**
 * Copy the parts an action mutates. The asset, note and link maps are never
 * edited, so they keep their identity and no card's markdown memo breaks.
 */
function cloneData(data: CanvasData): CanvasData {
	return {
		...data,
		nodes: data.nodes.map((node) => ({ ...node })),
		edges: data.edges.map((edge) => ({ ...edge })),
	};
}

/** Insert items back at their recorded slots, lowest slot first. */
function restoreAt<T>(list: T[], placed: Placed<T>[]): T[] {
	const result = list.slice();
	for (const { item, index } of [...placed].sort((a, b) => a.index - b.index)) {
		result.splice(Math.min(index, result.length), 0, { ...item });
	}
	return result;
}

/** The board after `action`, or before it when `reverse`. `source` is not modified. */
export function applyEditorAction(
	source: CanvasData,
	action: EditorAction,
	reverse = false,
): CanvasData {
	const next = cloneData(source);
	switch (action.type) {
		case "move":
			for (const move of action.moves) {
				const node = next.nodes.find((item) => item.id === move.id);
				if (node) Object.assign(node, reverse ? move.from : move.to);
			}
			break;
		case "resize": {
			const node = next.nodes.find((item) => item.id === action.id);
			if (node) Object.assign(node, reverse ? action.from : action.to);
			break;
		}
		case "update": {
			const index = next.nodes.findIndex((item) => item.id === action.id);
			if (index !== -1) next.nodes[index] = reverse ? { ...action.from } : { ...action.to };
			break;
		}
		case "add-node":
			if (reverse) next.nodes = next.nodes.filter((node) => node.id !== action.node.id);
			else next.nodes.push({ ...action.node });
			break;
		case "delete-nodes": {
			if (reverse) {
				next.nodes = restoreAt(next.nodes, action.nodes);
				next.edges = restoreAt(next.edges, action.edges);
			} else {
				const ids = new Set(action.nodes.map(({ item }) => item.id));
				const edgeIds = new Set(action.edges.map(({ item }) => item.id));
				next.nodes = next.nodes.filter((node) => !ids.has(node.id));
				next.edges = next.edges.filter((edge) => !edgeIds.has(edge.id));
			}
			break;
		}
		case "add-edge":
			if (reverse) next.edges = next.edges.filter((edge) => edge.id !== action.edge.id);
			else next.edges.push({ ...action.edge });
			break;
		case "delete-edge":
			if (reverse) next.edges = restoreAt(next.edges, [action.edge]);
			else next.edges = next.edges.filter((edge) => edge.id !== action.edge.item.id);
			break;
	}
	return next;
}

export function initEditorState(data: CanvasData): EditorState {
	return { canvas: cloneData(data), history: [], future: [], contentVersion: 0 };
}

function bump(state: EditorState, action: EditorAction): number {
	return CONTENT_ACTIONS[action.type] ? state.contentVersion + 1 : state.contentVersion;
}

export function editorReducer(state: EditorState, message: EditorMessage): EditorState {
	switch (message.type) {
		case "commit":
			return {
				canvas: message.next,
				history: [...state.history, message.action],
				future: [],
				contentVersion: bump(state, message.action),
			};
		case "undo": {
			const action = state.history.at(-1);
			if (!action) return state;
			return {
				canvas: applyEditorAction(state.canvas, action, true),
				history: state.history.slice(0, -1),
				future: [...state.future, action],
				contentVersion: bump(state, action),
			};
		}
		case "redo": {
			const action = state.future.at(-1);
			if (!action) return state;
			return {
				canvas: applyEditorAction(state.canvas, action),
				history: [...state.history, action],
				future: state.future.slice(0, -1),
				contentVersion: bump(state, action),
			};
		}
		case "preview": {
			const canvas = message.update(state.canvas);
			return canvas === state.canvas ? state : { ...state, canvas };
		}
	}
}

export interface CanvasEditor {
	canvas: CanvasData;
	canUndo: boolean;
	canRedo: boolean;
	contentVersion: number;
	commit: (action: EditorAction, next: CanvasData) => void;
	undo: () => void;
	redo: () => void;
	preview: (update: (canvas: CanvasData) => CanvasData) => void;
}

/**
 * The editor's board and its undo history, as one reducer: every edit is an
 * {@link EditorAction}, and undo/redo replay it in either direction. The
 * returned callbacks keep one identity for the component's lifetime.
 */
export function useCanvasEditor(data: CanvasData): CanvasEditor {
	const [state, dispatch] = useReducer(editorReducer, data, initEditorState);
	const commit = useCallback(
		(action: EditorAction, next: CanvasData) => dispatch({ type: "commit", action, next }),
		[],
	);
	const undo = useCallback(() => dispatch({ type: "undo" }), []);
	const redo = useCallback(() => dispatch({ type: "redo" }), []);
	const preview = useCallback(
		(update: (canvas: CanvasData) => CanvasData) => dispatch({ type: "preview", update }),
		[],
	);
	return {
		canvas: state.canvas,
		canUndo: state.history.length > 0,
		canRedo: state.future.length > 0,
		contentVersion: state.contentVersion,
		commit,
		undo,
		redo,
		preview,
	};
}
