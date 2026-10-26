import type { PointerEvent, RefObject } from "react";
import { useCallback, useRef, useState } from "react";
import type { CanvasData, CanvasNode } from "../types.js";
import type { CanvasEditor, NodeMove } from "./useCanvasEditor.js";
import type { Viewport } from "./usePanZoom.js";

/**
 * Movement, in screen pixels, after which a pointer press on a card becomes a
 * drag and claims pointer capture.
 *
 * Capturing on pointerdown instead would retarget the compatibility click to
 * the wrapper, and the click target is the common ancestor of the retargeted
 * mouseup and the mousedown — so every link inside a card (file labels, link
 * nodes, wikilinks in rendered markdown) would stop navigating. Capture is
 * only needed once the gesture is known to be a drag.
 */
export const DRAG_CAPTURE_THRESHOLD = 3;

/** The smallest box a resize leaves a card, in world pixels. */
export const MIN_NODE_WIDTH = 80;
export const MIN_NODE_HEIGHT = 60;

interface DragState {
	pointerId: number;
	startX: number;
	startY: number;
	/**
	 * Every node this gesture moves: the dragged node alone, or a group together
	 * with the members it holds. Captured once at pointerdown so a member that
	 * leaves the group mid-drag still finishes the gesture with it.
	 */
	origins: { id: string; x: number; y: number }[];
}

interface ResizeState {
	id: string;
	startX: number;
	startY: number;
	/** The node's size at pointerdown, and the origin of the resize delta. */
	originX: number;
	originY: number;
}

/** A press on a card, held until the pointer moves far enough to be a drag. */
interface PendingCapture {
	element: Element;
	pointerId: number;
	x: number;
	y: number;
}

export interface NodeGestureOptions extends Pick<CanvasEditor, "commit" | "preview"> {
	/** The latest board: read when a gesture starts and when it ends. */
	canvasRef: RefObject<CanvasData>;
	/** The latest viewport: its zoom turns screen travel into world travel. */
	viewportRef: RefObject<Viewport>;
}

export interface NodeGesture {
	/** True once a press has travelled far enough to be a drag, until it ends. */
	isDragging: boolean;
	/** Arm a drag of `nodeIds` (the pressed node first) from this press. */
	startDrag: (nodeIds: readonly string[], event: PointerEvent<Element>) => void;
	/** Start resizing `node` from its handle, which claims the pointer at once. */
	startResize: (node: CanvasNode, event: PointerEvent<Element>) => void;
	/** Apply a pointermove to the running gesture, as a preview frame. */
	updateGesture: (event: PointerEvent) => void;
	/** End the gesture and commit it to the history as one action, if it changed anything. */
	finishGesture: () => void;
}

/**
 * Dragging and resizing cards. Each frame is a `preview` that leaves the
 * history alone; the whole gesture is committed once, when it ends. Every
 * returned callback keeps one identity for the component's lifetime.
 */
export function useNodeGesture({
	canvasRef,
	viewportRef,
	commit,
	preview,
}: NodeGestureOptions): NodeGesture {
	// True while a drag is moving cards: group membership is frozen for its
	// duration rather than recomputed on every frame.
	const [isDragging, setIsDragging] = useState(false);
	const dragRef = useRef<DragState | null>(null);
	const resizeRef = useRef<ResizeState | null>(null);
	const pendingCaptureRef = useRef<PendingCapture | null>(null);

	const startDrag = useCallback(
		(nodeIds: readonly string[], event: PointerEvent<Element>) => {
			const nodes = canvasRef.current.nodes;
			const dragged = nodeIds
				.map((id) => nodes.find((item) => item.id === id))
				.filter((item): item is CanvasNode => item !== undefined);
			dragRef.current = {
				pointerId: event.pointerId,
				startX: event.clientX,
				startY: event.clientY,
				origins: dragged.map((item) => ({ id: item.id, x: item.x, y: item.y })),
			};
			pendingCaptureRef.current = {
				element: event.currentTarget,
				pointerId: event.pointerId,
				x: event.clientX,
				y: event.clientY,
			};
		},
		[canvasRef],
	);

	const startResize = useCallback((node: CanvasNode, event: PointerEvent<Element>) => {
		event.stopPropagation();
		event.currentTarget.setPointerCapture?.(event.pointerId);
		resizeRef.current = {
			id: node.id,
			startX: event.clientX,
			startY: event.clientY,
			originX: node.width,
			originY: node.height,
		};
	}, []);

	const finishGesture = useCallback(() => {
		const drag = dragRef.current;
		const resize = resizeRef.current;
		dragRef.current = null;
		resizeRef.current = null;
		pendingCaptureRef.current = null;
		setIsDragging(false);
		const current = canvasRef.current;
		if (drag) {
			const moves = drag.origins
				.map((origin) => {
					const node = current.nodes.find((item) => item.id === origin.id);
					return node && (node.x !== origin.x || node.y !== origin.y)
						? {
								id: origin.id,
								from: { x: origin.x, y: origin.y },
								to: { x: node.x, y: node.y },
							}
						: null;
				})
				.filter((move): move is NodeMove => move !== null);
			// One entry for the whole gesture, however many nodes moved with it.
			if (moves.length) commit({ type: "move", moves }, current);
		}
		if (resize) {
			const node = current.nodes.find((item) => item.id === resize.id);
			if (node && (node.width !== resize.originX || node.height !== resize.originY)) {
				commit(
					{
						type: "resize",
						id: resize.id,
						from: { width: resize.originX, height: resize.originY },
						to: { width: node.width, height: node.height },
					},
					current,
				);
			}
		}
	}, [canvasRef, commit]);

	const updateGesture = useCallback(
		(event: PointerEvent) => {
			const resize = resizeRef.current;
			// The two gestures are mutually exclusive; a resize wins if both refs are set.
			const drag = resize ? null : dragRef.current;
			if (!resize && !drag) return;
			if (drag && drag.pointerId !== event.pointerId) return;
			// A press only becomes a drag once it moves: claim the pointer then, so a
			// plain click still reaches the links inside the card.
			const pending = pendingCaptureRef.current;
			if (drag && pending) {
				const travelled = Math.max(
					Math.abs(event.clientX - pending.x),
					Math.abs(event.clientY - pending.y),
				);
				if (travelled < DRAG_CAPTURE_THRESHOLD) return;
				pendingCaptureRef.current = null;
				pending.element.setPointerCapture?.(event.pointerId);
				setIsDragging(true);
			}
			const zoom = viewportRef.current.zoom || 1;
			preview((current) => {
				if (resize) {
					const index = current.nodes.findIndex((item) => item.id === resize.id);
					const node = current.nodes[index];
					if (!node) return current;
					const width = Math.max(
						MIN_NODE_WIDTH,
						Math.round(resize.originX + (event.clientX - resize.startX) / zoom),
					);
					const height = Math.max(
						MIN_NODE_HEIGHT,
						Math.round(resize.originY + (event.clientY - resize.startY) / zoom),
					);
					if (width === node.width && height === node.height) return current;
					const nodes = current.nodes.slice();
					nodes[index] = { ...node, width, height };
					return { ...current, nodes };
				}
				if (!drag) return current;
				// Every node in the gesture — a group and the members it holds — moves
				// by the same pointer delta.
				const moved: { index: number; node: CanvasNode }[] = [];
				for (const origin of drag.origins) {
					const index = current.nodes.findIndex((item) => item.id === origin.id);
					const node = current.nodes[index];
					if (!node) continue;
					const x = Math.round(origin.x + (event.clientX - drag.startX) / zoom);
					const y = Math.round(origin.y + (event.clientY - drag.startY) / zoom);
					if (x === node.x && y === node.y) continue;
					moved.push({ index, node: { ...node, x, y } });
				}
				// Sub-pixel movement rounds to the same box: returning the same board
				// leaves the editor state as it was, so React bails out of the render.
				if (moved.length === 0) return current;
				// Only the dragged nodes are new objects; every other node, the edges
				// and the asset/note/link maps keep their identity, so only the moving
				// cards and the edges touching them re-render.
				const nodes = current.nodes.slice();
				for (const change of moved) nodes[change.index] = change.node;
				return { ...current, nodes };
			});
		},
		[preview, viewportRef],
	);

	return { isDragging, startDrag, startResize, updateGesture, finishGesture };
}
