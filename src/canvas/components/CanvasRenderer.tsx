import type { KeyboardEvent, PointerEvent } from "react";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { disposeMermaid, renderMermaidBlocks, retainMermaid } from "../../mermaid/blocks.js";
import { MIN_ZOOM, usePanZoom, viewportStorageKey } from "../hooks/usePanZoom.js";
import { serializeCanvas } from "../parser.js";
import type { CanvasData, CanvasEdgeData, CanvasNode } from "../types.js";
import {
	createEdge,
	createFileNode,
	createGroupNode,
	createLinkNode,
	createTextNode,
} from "../utils/editor.js";
import { membersByGroup } from "../utils/group.js";
import { renderCanvasMath } from "../utils/math-render.js";
import { CanvasEdge, edgeColor, markerIds } from "./CanvasEdge.js";
import { CanvasNodeComponent, cardLabel } from "./CanvasNode.js";

export interface CanvasRendererProps {
	data: CanvasData;
	/**
	 * Identity of the board (its vault path). Keys the remembered viewport and
	 * names the exported file; without it the viewport is not remembered.
	 */
	boardId?: string;
	fileRoutePrefix?: string;
	linkPreview?: boolean;
	editable?: boolean;
	editorTitle?: string;
	iframeSandbox?: string;
	/** Whether a bare wheel zooms (see `usePanZoom`). @default true */
	wheelZoom?: boolean;
}

/** One node's travel within a move action. */
interface NodeMove {
	id: string;
	from: { x: number; y: number };
	to: { x: number; y: number };
}

/** An item removed by a delete, with the array slot it is restored to. */
interface Placed<T> {
	item: T;
	index: number;
}

type EditorAction =
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

interface DragState {
	id: string;
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
const DRAG_CAPTURE_THRESHOLD = 3;

/** Screen pixels an arrow key pans the board by; world pixels it nudges a card by. */
const KEY_STEP = 40;
const NUDGE_STEP = 10;

/** Content inside a card that handles its own click (and so does not select the card). */
const INTERACTIVE_CONTENT =
	"a[href], button, input, textarea, select, summary, label, iframe, video, audio, [contenteditable]";

function isTypingTarget(target: EventTarget | null): boolean {
	const element = target as HTMLElement | null;
	return Boolean(
		element?.isContentEditable ||
			(element?.tagName && /^(?:input|textarea|select)$/i.test(element.tagName)),
	);
}

/** The file name an export downloads as: the board's own name. */
function exportFileName(boardId: string | undefined, editorTitle: string): string {
	const name = boardId
		?.split("/")
		.pop()
		?.replace(/\.canvas$/i, "");
	return `${name || editorTitle.toLowerCase().replace(/\s+/g, "-") || "canvas"}.canvas`;
}

export function CanvasRenderer({
	data,
	boardId,
	fileRoutePrefix,
	linkPreview,
	editable = false,
	editorTitle = "Canvas editor",
	iframeSandbox = "allow-scripts allow-same-origin allow-popups",
	wheelZoom = true,
}: CanvasRendererProps) {
	const [canvas, setCanvas] = useState(() => cloneData(data));
	const [history, setHistory] = useState<EditorAction[]>([]);
	const [future, setFuture] = useState<EditorAction[]>([]);
	const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
	const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
	const [showGrid, setShowGrid] = useState(true);
	const [showHelp, setShowHelp] = useState(false);
	const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
	const [draftText, setDraftText] = useState("");
	const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
	const [edgeSourceId, setEdgeSourceId] = useState<string | null>(null);
	// Bumped by every action that changes what a card renders, so diagrams and
	// math are re-scanned then and not on every drag frame.
	const [contentVersion, setContentVersion] = useState(0);
	// True while a drag is moving cards: group membership is frozen for its
	// duration rather than recomputed on every frame.
	const [isDragging, setIsDragging] = useState(false);
	// Collapsed groups are view state, never canvas data: the `.canvas` format has
	// nowhere to record them and export must stay faithful to the source.
	const [collapsedGroupIds, setCollapsedGroupIds] = useState<string[]>([]);
	const helpButtonRef = useRef<HTMLButtonElement>(null);
	const helpCloseRef = useRef<HTMLButtonElement>(null);
	const helpTitleId = useId();
	const instanceId = useId().replace(/[^A-Za-z0-9_-]/g, "");
	const dragRef = useRef<DragState | null>(null);
	const resizeRef = useRef<ResizeState | null>(null);
	// A press on a card, held until the pointer moves far enough to be a drag.
	const pendingCaptureRef = useRef<{
		element: Element;
		pointerId: number;
		x: number;
		y: number;
	} | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	// Set when this visit has no remembered viewport to restore, which is what
	// the one-off fit on mount waits for.
	const needsInitialFit = useRef(false);

	const {
		viewport,
		setViewport,
		transform,
		containerRef,
		setContainerRef,
		handlePointerDown,
		handlePointerMove,
		handlePointerUp,
		isSpaceHeld,
		zoomIn,
		zoomOut,
		resetZoom,
		panBy,
	} = usePanZoom({
		storageKey: boardId ? viewportStorageKey(boardId) : undefined,
		wheelZoom,
		onRestore: (restored) => {
			// A board the reader has already positioned reopens where they left it;
			// only a first visit (or one whose stored viewport was unusable) fits.
			if (!restored) needsInitialFit.current = true;
		},
	});

	// The latest values, for callbacks that must keep one identity across
	// renders: a handler that changed with `canvas` would re-render every card
	// on every drag frame.
	const canvasRef = useRef(canvas);
	canvasRef.current = canvas;
	const viewportRef = useRef(viewport);
	viewportRef.current = viewport;
	const edgeSourceRef = useRef(edgeSourceId);
	edgeSourceRef.current = edgeSourceId;
	const editingRef = useRef<{ id: string; draft: string } | null>(null);
	editingRef.current = editingNodeId ? { id: editingNodeId, draft: draftText } : null;

	const nodeMap = useMemo(
		() => new Map(canvas.nodes.map((node) => [node.id, node])),
		[canvas.nodes],
	);
	// Which nodes each group holds, by containment. Frozen while a drag runs,
	// recomputed when it ends so membership follows a card dragged out of (or
	// into) a group.
	const membershipNodesRef = useRef(canvas.nodes);
	if (!isDragging) membershipNodesRef.current = canvas.nodes;
	const membershipNodes = membershipNodesRef.current;
	const groupMembers = useMemo(() => membersByGroup(membershipNodes), [membershipNodes]);
	const groupMembersRef = useRef(groupMembers);
	groupMembersRef.current = groupMembers;
	// Members of collapsed groups, and the edges wholly inside them. Edges with one
	// visible endpoint stay: the format keeps them, and the line still points at
	// the group's box.
	const hiddenNodeIds = useMemo(() => {
		const hidden = new Set<string>();
		for (const groupId of collapsedGroupIds) {
			for (const memberId of groupMembers.get(groupId) ?? []) hidden.add(memberId);
		}
		return hidden;
	}, [collapsedGroupIds, groupMembers]);
	const visibleEdges = useMemo(
		() =>
			hiddenNodeIds.size === 0
				? canvas.edges
				: canvas.edges.filter(
						(edge) => !(hiddenNodeIds.has(edge.fromNode) && hiddenNodeIds.has(edge.toNode)),
					),
		[canvas.edges, hiddenNodeIds],
	);
	// Stacking: groups at the bottom, then the edges, then every other card, each
	// band in the board's array order (JSON Canvas: array order is z-order).
	const { zIndexById, edgeLayer, topLayer } = useMemo(() => {
		const ranks = new Map<string, number>();
		let rank = 0;
		for (const node of canvas.nodes) if (node.type === "group") ranks.set(node.id, ++rank);
		const edges = ++rank;
		for (const node of canvas.nodes) if (node.type !== "group") ranks.set(node.id, ++rank);
		return { zIndexById: ranks, edgeLayer: edges, topLayer: rank + 1 };
	}, [canvas.nodes]);
	const connectedEdgeIds = useMemo(() => {
		const activeIds = new Set(selectedNodeIds);
		if (hoveredNodeId) activeIds.add(hoveredNodeId);
		if (activeIds.size === 0) return new Set<string>();
		return new Set(
			canvas.edges
				.filter((edge) => activeIds.has(edge.fromNode) || activeIds.has(edge.toNode))
				.map((edge) => edge.id),
		);
	}, [canvas.edges, hoveredNodeId, selectedNodeIds]);

	const commit = useCallback((action: EditorAction, next: CanvasData) => {
		setCanvas(next);
		setHistory((previous) => [...previous, action]);
		setFuture([]);
		if (CONTENT_ACTIONS[action.type]) setContentVersion((version) => version + 1);
	}, []);

	const applyAction = useCallback(
		(source: CanvasData, action: EditorAction, reverse = false): CanvasData => {
			const next = cloneData(source);
			if (action.type === "move") {
				for (const move of action.moves) {
					const node = next.nodes.find((item) => item.id === move.id);
					if (node) Object.assign(node, reverse ? move.from : move.to);
				}
			} else if (action.type === "resize") {
				const node = next.nodes.find((item) => item.id === action.id);
				if (node) Object.assign(node, reverse ? action.from : action.to);
			} else if (action.type === "update") {
				const index = next.nodes.findIndex((item) => item.id === action.id);
				if (index !== -1) next.nodes[index] = reverse ? { ...action.from } : { ...action.to };
			} else if (action.type === "add-node") {
				if (reverse) next.nodes = next.nodes.filter((node) => node.id !== action.node.id);
				else next.nodes.push({ ...action.node });
			} else if (action.type === "delete-nodes") {
				const ids = new Set(action.nodes.map(({ item }) => item.id));
				const edgeIds = new Set(action.edges.map(({ item }) => item.id));
				if (reverse) {
					next.nodes = restoreAt(next.nodes, action.nodes);
					next.edges = restoreAt(next.edges, action.edges);
				} else {
					next.nodes = next.nodes.filter((node) => !ids.has(node.id));
					next.edges = next.edges.filter((edge) => !edgeIds.has(edge.id));
				}
			} else if (action.type === "add-edge") {
				if (reverse) next.edges = next.edges.filter((edge) => edge.id !== action.edge.id);
				else next.edges.push({ ...action.edge });
			} else if (action.type === "delete-edge") {
				if (reverse) next.edges = restoreAt(next.edges, [action.edge]);
				else next.edges = next.edges.filter((edge) => edge.id !== action.edge.item.id);
			}
			return next;
		},
		[],
	);

	const undo = useCallback(() => {
		const action = history.at(-1);
		if (!action) return;
		setCanvas((current) => applyAction(current, action, true));
		setHistory((current) => current.slice(0, -1));
		setFuture((current) => [...current, action]);
		if (CONTENT_ACTIONS[action.type]) setContentVersion((version) => version + 1);
	}, [applyAction, history]);

	const redo = useCallback(() => {
		const action = future.at(-1);
		if (!action) return;
		setCanvas((current) => applyAction(current, action));
		setFuture((current) => current.slice(0, -1));
		setHistory((current) => [...current, action]);
		if (CONTENT_ACTIONS[action.type]) setContentVersion((version) => version + 1);
	}, [applyAction, future]);

	const fitToView = useCallback(() => {
		const nodes = canvasRef.current.nodes;
		if (nodes.length === 0) return;
		const bounds = nodes.reduce(
			(result, node) => ({
				minX: Math.min(result.minX, node.x),
				minY: Math.min(result.minY, node.y),
				maxX: Math.max(result.maxX, node.x + node.width),
				maxY: Math.max(result.maxY, node.y + node.height),
			}),
			{ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
		);
		const rect = containerRef.current?.getBoundingClientRect();
		// No measurable box means the canvas is not laid out (unmounted, `display:
		// none`, or no layout engine). Fitting to a guessed 800x500 there would
		// place the viewport in coordinates the user never sees.
		const width = rect?.width ?? 0;
		const height = rect?.height ?? 0;
		if (width <= 0 || height <= 0) return;
		const zoom = Math.max(
			MIN_ZOOM,
			Math.min(
				1.5,
				Math.min(
					(width - 80) / Math.max(1, bounds.maxX - bounds.minX),
					(height - 80) / Math.max(1, bounds.maxY - bounds.minY),
				),
			),
		);
		setViewport({
			x: width / 2 - (bounds.minX + (bounds.maxX - bounds.minX) / 2) * zoom,
			y: height / 2 - (bounds.minY + (bounds.maxY - bounds.minY) / 2) * zoom,
			zoom,
		});
	}, [containerRef, setViewport]);

	useEffect(() => {
		// A restored viewport is the reader's own placement; re-fitting it would
		// undo the very thing that was remembered.
		if (!needsInitialFit.current) return;
		let frame = 0;
		const timer = setTimeout(() => {
			frame = requestAnimationFrame(() => fitToView());
		}, 100);
		return () => {
			clearTimeout(timer);
			cancelAnimationFrame(frame);
		};
	}, [fitToView]);

	// A collapsed id outlives its group only until the next canvas change. Left in
	// place it would still be collapsed by the time the toolbar's next group takes
	// the freed id, and that new group would hide its members on sight.
	useEffect(() => {
		setCollapsedGroupIds((current) =>
			current.some((id) => !nodeMap.has(id)) ? current.filter((id) => nodeMap.has(id)) : current,
		);
	}, [nodeMap]);

	// Diagrams and math are drawn into the cards' HTML after it mounts. The scan
	// is keyed on what cards render — content edits and collapsing (which mounts
	// hidden cards) — so a drag never re-parses a diagram.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-scan keyed on rendered content
	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		renderMermaidBlocks(root);
		void renderCanvasMath(root);
	}, [contentVersion, collapsedGroupIds]);

	// Two canvases — or a canvas and a markdown page's diagrams — share one theme
	// observer; releasing only this canvas' claim keeps the others alive.
	useEffect(() => {
		retainMermaid();
		return () => disposeMermaid();
	}, []);

	// Move focus into the dialog on open so its own keys work without a pointer,
	// and hand focus back to the toggle on close.
	useEffect(() => {
		if (!showHelp) return;
		helpCloseRef.current?.focus();
		return () => helpButtonRef.current?.focus();
	}, [showHelp]);

	/** Node selection and edge selection are exclusive: picking one clears the other. */
	const selectNode = useCallback((nodeId: string, extend: boolean) => {
		setSelectedEdgeId(null);
		setSelectedNodeIds((current) => {
			if (extend)
				return current.includes(nodeId)
					? current.filter((id) => id !== nodeId)
					: [...current, nodeId];
			return current.length === 1 && current[0] === nodeId ? current : [nodeId];
		});
	}, []);

	// One stable callback for every edge, so `CanvasEdge`'s memo holds.
	const selectEdge = useCallback((edgeId: string) => {
		setSelectedNodeIds([]);
		setSelectedEdgeId(edgeId);
	}, []);

	const clearSelection = useCallback(() => {
		setSelectedNodeIds([]);
		setSelectedEdgeId(null);
	}, []);

	// Collapsing is a view toggle: it never touches `canvas`, so export and the
	// undo history stay exactly as the source had them. A member hidden by the
	// collapse must also leave the selection, or Delete would remove cards the
	// user can no longer see.
	const toggleGroupCollapse = useCallback((groupId: string) => {
		setCollapsedGroupIds((current) => {
			if (current.includes(groupId)) return current.filter((id) => id !== groupId);
			const hidden = new Set(groupMembersRef.current.get(groupId) ?? []);
			setSelectedNodeIds((selected) => selected.filter((id) => !hidden.has(id)));
			return [...current, groupId];
		});
	}, []);

	const connectEdge = useCallback(
		(fromId: string, toId: string) => {
			const current = canvasRef.current;
			const from = current.nodes.find((node) => node.id === fromId);
			const to = current.nodes.find((node) => node.id === toId);
			if (!from || !to || fromId === toId) return;
			const edge = createEdge(current.edges, from, to);
			commit({ type: "add-edge", edge }, { ...current, edges: [...current.edges, edge] });
		},
		[commit],
	);

	const commitEdit = useCallback(() => {
		const editing = editingRef.current;
		if (!editing) return;
		editingRef.current = null;
		setEditingNodeId(null);
		const current = canvasRef.current;
		const node = current.nodes.find((item) => item.id === editing.id);
		// Opening the editor and leaving without a change is not an edit: it
		// must not clear the redo stack or mark the board unsaved.
		if (node?.type !== "text" || node.text === editing.draft) return;
		const updated: CanvasNode = { ...node, text: editing.draft };
		commit(
			{ type: "update", id: node.id, from: node, to: updated },
			{ ...current, nodes: current.nodes.map((item) => (item.id === node.id ? updated : item)) },
		);
	}, [commit]);

	const startEditing = useCallback(
		(nodeId: string) => {
			if (!editable) return;
			const node = canvasRef.current.nodes.find((item) => item.id === nodeId);
			if (node?.type !== "text") return;
			setEditingNodeId(node.id);
			setDraftText(node.text);
		},
		[editable],
	);

	const handleNodePointerDown = useCallback(
		(node: CanvasNode, event: PointerEvent<HTMLDivElement>) => {
			// A connect gesture armed from the toolbar: this press picks the target.
			const source = edgeSourceRef.current;
			if (editable && source && event.button === 0) {
				event.stopPropagation();
				if (source !== node.id) connectEdge(source, node.id);
				setEdgeSourceId(null);
				return;
			}
			// The middle button and Space+drag pan from anywhere, and the read-only
			// viewer pans from any card: the press is left to reach the viewport.
			if (!editable || event.button !== 0 || isSpaceHeld()) return;
			event.stopPropagation();
			// Selection happens here, once: the click that follows a press must not
			// select again, or a Shift-click would extend and then reset.
			selectNode(node.id, event.shiftKey);
			const members = node.type === "group" ? (groupMembersRef.current.get(node.id) ?? []) : [];
			const nodes = canvasRef.current.nodes;
			const dragged = [node.id, ...members]
				.map((id) => nodes.find((item) => item.id === id))
				.filter((item): item is CanvasNode => item !== undefined);
			dragRef.current = {
				id: node.id,
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
		[connectEdge, editable, isSpaceHeld, selectNode],
	);

	const handleResizePointerDown = useCallback(
		(node: CanvasNode, event: PointerEvent<HTMLButtonElement>) => {
			event.stopPropagation();
			event.currentTarget.setPointerCapture?.(event.pointerId);
			resizeRef.current = {
				id: node.id,
				startX: event.clientX,
				startY: event.clientY,
				originX: node.width,
				originY: node.height,
			};
		},
		[],
	);

	const finishNodeDrag = useCallback(() => {
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
	}, [commit]);

	const updateDraggedNode = useCallback((event: PointerEvent) => {
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
		setCanvas((current) => {
			if (resize) {
				const index = current.nodes.findIndex((item) => item.id === resize.id);
				const node = current.nodes[index];
				if (!node) return current;
				const width = Math.max(
					80,
					Math.round(resize.originX + (event.clientX - resize.startX) / zoom),
				);
				const height = Math.max(
					60,
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
			// Sub-pixel movement rounds to the same box: returning the same state
			// object lets React skip the re-render entirely.
			if (moved.length === 0) return current;
			// Only the dragged nodes are new objects; every other node, the edges
			// and the asset/note/link maps keep their identity, so only the moving
			// cards and the edges touching them re-render.
			const nodes = current.nodes.slice();
			for (const change of moved) nodes[change.index] = change.node;
			return { ...current, nodes };
		});
	}, []);

	/** World coordinates of the visible centre, where Obsidian drops a new card. */
	const viewCenter = useCallback(
		(width: number, height: number) => {
			const rect = containerRef.current?.getBoundingClientRect();
			const { x, y, zoom } = viewportRef.current;
			const screenX = (rect?.width ?? 0) / 2;
			const screenY = (rect?.height ?? 0) / 2;
			return { x: (screenX - x) / zoom - width / 2, y: (screenY - y) / zoom - height / 2 };
		},
		[containerRef],
	);

	const createCard = useCallback(
		(factory: (nodes: CanvasNode[], x: number, y: number) => CanvasNode) => {
			const current = canvasRef.current;
			const probe = factory(current.nodes, 0, 0);
			const at = viewCenter(probe.width, probe.height);
			const node = factory(current.nodes, at.x, at.y);
			commit({ type: "add-node", node }, { ...current, nodes: [...current.nodes, node] });
			setSelectedEdgeId(null);
			setSelectedNodeIds([node.id]);
			return node;
		},
		[commit, viewCenter],
	);

	const createTextCard = useCallback(() => {
		const node = createCard(createTextNode);
		if (node.type === "text") {
			setEditingNodeId(node.id);
			setDraftText(node.text);
		}
	}, [createCard]);
	const createFileCard = useCallback(() => createCard(createFileNode), [createCard]);
	const createLinkCard = useCallback(() => createCard(createLinkNode), [createCard]);
	const createGroupCard = useCallback(() => createCard(createGroupNode), [createCard]);

	const deleteSelectedEdge = useCallback(() => {
		if (!selectedEdgeId) return;
		const current = canvasRef.current;
		const index = current.edges.findIndex((item) => item.id === selectedEdgeId);
		const edge = current.edges[index];
		if (!edge) return;
		commit(
			{ type: "delete-edge", edge: { item: edge, index } },
			{ ...current, edges: current.edges.filter((item) => item.id !== edge.id) },
		);
		setSelectedEdgeId(null);
		containerRef.current?.focus();
	}, [commit, containerRef, selectedEdgeId]);

	const deleteSelected = useCallback(() => {
		const current = canvasRef.current;
		const ids = new Set(selectedNodeIds);
		const nodes = current.nodes
			.map((item, index) => ({ item, index }))
			.filter(({ item }) => ids.has(item.id));
		if (nodes.length === 0) return;
		const edges = current.edges
			.map((item, index) => ({ item, index }))
			.filter(({ item }) => ids.has(item.fromNode) || ids.has(item.toNode));
		commit(
			{ type: "delete-nodes", nodes, edges },
			{
				...current,
				nodes: current.nodes.filter((node) => !ids.has(node.id)),
				edges: current.edges.filter((edge) => !ids.has(edge.fromNode) && !ids.has(edge.toNode)),
			},
		);
		setSelectedNodeIds([]);
		// The focused card is gone; keep the keyboard on the board.
		containerRef.current?.focus();
	}, [commit, containerRef, selectedNodeIds]);

	const nudgeSelected = useCallback(
		(dx: number, dy: number) => {
			const current = canvasRef.current;
			const ids = new Set(selectedNodeIds);
			const moves: NodeMove[] = current.nodes
				.filter((node) => ids.has(node.id))
				.map((node) => ({
					id: node.id,
					from: { x: node.x, y: node.y },
					to: { x: node.x + dx, y: node.y + dy },
				}));
			if (moves.length === 0) return;
			const action: EditorAction = { type: "move", moves };
			commit(action, applyAction(current, action));
		},
		[applyAction, commit, selectedNodeIds],
	);

	const exportCanvas = useCallback(() => {
		const blob = new Blob([serializeCanvas(canvasRef.current)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = exportFileName(boardId, editorTitle);
		anchor.click();
		URL.revokeObjectURL(url);
	}, [boardId, editorTitle]);

	const handleKeyDown = useCallback(
		(event: KeyboardEvent) => {
			// Escape is the one key that must work while editing: it commits the
			// draft and leaves the editor (the textarea unmounting fires no blur in
			// every browser, so the commit cannot be left to onBlur).
			if (event.key === "Escape") {
				const editing = editingRef.current;
				commitEdit();
				clearSelection();
				setEdgeSourceId(null);
				setShowHelp(false);
				if (editing) {
					containerRef.current
						?.querySelector<HTMLElement>(`[data-node-id="${CSS.escape(editing.id)}"]`)
						?.focus();
				}
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
					event.shiftKey ? redo() : undo();
					return;
				}
				if (key === "y") {
					event.preventDefault();
					redo();
					return;
				}
				if (key === "s") {
					event.preventDefault();
					exportCanvas();
					return;
				}
			}
			// Every other binding is a bare key: Ctrl/⌘+F is the browser's find, and
			// Ctrl+0 its zoom reset, and both must reach the browser untouched.
			if (modifier || event.altKey) return;
			if (editable && (event.key === "Delete" || event.key === "Backspace")) {
				event.preventDefault();
				if (selectedEdgeId) deleteSelectedEdge();
				else deleteSelected();
				return;
			}
			if (editable && event.key === "Enter" && selectedNodeIds.length === 1) {
				const [id] = selectedNodeIds;
				if (id) {
					event.preventDefault();
					startEditing(id);
				}
				return;
			}
			const arrows: Record<string, [number, number]> = {
				ArrowLeft: [-1, 0],
				ArrowRight: [1, 0],
				ArrowUp: [0, -1],
				ArrowDown: [0, 1],
			};
			const arrow = arrows[event.key];
			if (arrow) {
				event.preventDefault();
				// In the editor the arrows move the selection; otherwise they pan.
				if (editable && selectedNodeIds.length > 0) {
					const step = event.shiftKey ? NUDGE_STEP * 5 : NUDGE_STEP;
					nudgeSelected(arrow[0] * step, arrow[1] * step);
				} else {
					const step = event.shiftKey ? KEY_STEP * 4 : KEY_STEP;
					panBy(-arrow[0] * step, -arrow[1] * step);
				}
				return;
			}
			if (event.key === "+" || event.key === "=") zoomIn();
			else if (event.key === "-") zoomOut();
			else if (event.key === "0") resetZoom();
			else if (key === "f") fitToView();
		},
		[
			clearSelection,
			commitEdit,
			containerRef,
			deleteSelected,
			deleteSelectedEdge,
			editable,
			exportCanvas,
			fitToView,
			nudgeSelected,
			panBy,
			redo,
			resetZoom,
			selectedEdgeId,
			selectedNodeIds,
			startEditing,
			undo,
			zoomIn,
			zoomOut,
		],
	);

	const visibleNodes = useMemo(
		() =>
			hiddenNodeIds.size === 0
				? canvas.nodes
				: canvas.nodes.filter((node) => !hiddenNodeIds.has(node.id)),
		[canvas.nodes, hiddenNodeIds],
	);

	return (
		<div ref={rootRef} className={`canvas-container ${editable ? "canvas-editor" : ""}`}>
			{editable && (
				<div className="canvas-editor-banner" role="status">
					<strong>{editorTitle}</strong>
					<span>{history.length ? "Unsaved changes" : "Read-only source until exported"}</span>
				</div>
			)}
			{editable && edgeSourceId && (
				<div className="canvas-editor-banner" role="status">
					<strong>Connect edge</strong>
					<span>Click a target node to connect, or press Escape to cancel.</span>
				</div>
			)}
			<div
				ref={setContainerRef}
				className="canvas-viewport"
				role="application"
				aria-roledescription="canvas"
				aria-label={editable ? "Editable canvas" : "Interactive canvas with nodes and connections"}
				// Focusable so the board's own keys (arrows, f/0/+/-, Delete) reach it
				// without a card having to hold focus first.
				tabIndex={0}
				onPointerDown={handlePointerDown}
				onPointerMove={(event) => {
					if (!handlePointerMove(event)) updateDraggedNode(event);
				}}
				onPointerUp={(event) => {
					handlePointerUp(event);
					finishNodeDrag();
				}}
				// A touch takeover, a native drag or an OS-level interruption ends the
				// gesture with pointercancel and no pointerup. Without these the pan
				// stayed active and `dragRef`/`resizeRef` stayed armed: the card kept
				// following the cursor and the move never reached the undo history.
				onPointerCancel={(event) => {
					handlePointerUp(event);
					finishNodeDrag();
				}}
				onLostPointerCapture={(event) => {
					handlePointerUp(event);
					finishNodeDrag();
				}}
				onClick={(event) => {
					if (event.target === event.currentTarget) clearSelection();
				}}
				onDoubleClick={(event) => {
					if (event.target === event.currentTarget) fitToView();
				}}
				onKeyDown={handleKeyDown}
			>
				<div className="canvas-world" style={{ transform }}>
					{showGrid && <div className="canvas-background" aria-hidden="true" />}
					<svg
						className="canvas-edges"
						xmlns="http://www.w3.org/2000/svg"
						style={{ zIndex: edgeLayer }}
						// Editable edges are real buttons: hiding them would leave focusable
						// controls inside an aria-hidden subtree (an axe violation).
						aria-hidden={editable ? undefined : true}
					>
						<title>Canvas edges</title>
						<defs>
							{visibleEdges.map((edge) => {
								const color = edgeColor(edge.color);
								const ids = markerIds(instanceId, edge.id);
								return (
									<g key={edge.id}>
										<marker
											id={ids.end}
											markerWidth="10"
											markerHeight="7"
											refX="9"
											refY="3.5"
											orient="auto"
											markerUnits="userSpaceOnUse"
										>
											<polygon points="0 0, 10 3.5, 0 7" fill={color} />
										</marker>
										<marker
											id={ids.start}
											markerWidth="10"
											markerHeight="7"
											refX="1"
											refY="3.5"
											orient="auto"
											markerUnits="userSpaceOnUse"
										>
											<polygon points="10 0, 0 3.5, 10 7" fill={color} />
										</marker>
									</g>
								);
							})}
						</defs>
						{visibleEdges.map((edge) => {
							const fromNode = nodeMap.get(edge.fromNode);
							const toNode = nodeMap.get(edge.toNode);
							if (!fromNode || !toNode) return null;
							return (
								<CanvasEdge
									key={edge.id}
									edge={edge}
									fromNode={fromNode}
									toNode={toNode}
									markerPrefix={instanceId}
									isHighlighted={connectedEdgeIds.has(edge.id)}
									isSelected={selectedEdgeId === edge.id}
									onSelect={editable ? selectEdge : undefined}
								/>
							);
						})}
					</svg>
					{visibleNodes.map((node) => {
						const isSelected = selectedNodeIds.includes(node.id);
						const isHovered = node.id === hoveredNodeId;
						const raised = node.type !== "group" && (isSelected || isHovered);
						return (
							<NodeFrame
								key={node.id}
								node={node}
								zIndex={(zIndexById.get(node.id) ?? 0) + (raised ? topLayer : 0)}
								isSelected={isSelected}
								isHovered={isHovered}
								editable={editable}
								isEditing={editable && editingNodeId === node.id}
								draftText={editable && editingNodeId === node.id ? draftText : undefined}
								memberCount={node.type === "group" ? (groupMembers.get(node.id)?.length ?? 0) : 0}
								isCollapsed={collapsedGroupIds.includes(node.id)}
								assets={canvas.assets}
								notes={canvas.notes}
								links={canvas.links}
								idPrefix={instanceId}
								fileRoutePrefix={fileRoutePrefix}
								linkPreview={linkPreview}
								iframeSandbox={iframeSandbox}
								onPointerDown={handleNodePointerDown}
								onResizePointerDown={handleResizePointerDown}
								onSelect={selectNode}
								onEdit={startEditing}
								onHover={setHoveredNodeId}
								onToggleCollapse={toggleGroupCollapse}
								onDraftChange={setDraftText}
								onCommitEdit={commitEdit}
							/>
						);
					})}
				</div>
			</div>
			<div className="canvas-toolbar" role="toolbar" aria-label="Canvas controls">
				{editable && (
					<>
						<button
							type="button"
							className="canvas-toolbar-btn"
							onClick={createTextCard}
							aria-label="Add text card"
							title="Add text card"
						>
							＋
						</button>
						<button
							type="button"
							className="canvas-toolbar-btn"
							onClick={createFileCard}
							aria-label="Add file card"
							title="Add file card"
						>
							🗎
						</button>
						<button
							type="button"
							className="canvas-toolbar-btn"
							onClick={createLinkCard}
							aria-label="Add link card"
							title="Add link card"
						>
							🔗
						</button>
						<button
							type="button"
							className="canvas-toolbar-btn"
							onClick={createGroupCard}
							aria-label="Add group"
							title="Add group"
						>
							▭
						</button>
						<button
							type="button"
							className="canvas-toolbar-btn"
							onClick={() => {
								const [sourceId] = selectedNodeIds;
								if (!sourceId) return;
								setEdgeSourceId(sourceId);
							}}
							disabled={!selectedNodeIds.length}
							aria-label="Connect edge from selected node"
							title="Connect edge (click source, then target node)"
						>
							⇄
						</button>
						<button
							type="button"
							className="canvas-toolbar-btn"
							onClick={deleteSelectedEdge}
							disabled={!selectedEdgeId}
							aria-label="Delete selected edge"
							title="Delete selected edge"
						>
							⌫
						</button>
						<button
							type="button"
							className="canvas-toolbar-btn"
							onClick={deleteSelected}
							disabled={!selectedNodeIds.length}
							aria-label="Delete selected"
							title="Delete selected"
						>
							⌫
						</button>
						<button
							type="button"
							className="canvas-toolbar-btn"
							onClick={undo}
							disabled={!history.length}
							aria-label="Undo"
							title="Undo"
						>
							↶
						</button>
						<button
							type="button"
							className="canvas-toolbar-btn"
							onClick={redo}
							disabled={!future.length}
							aria-label="Redo"
							title="Redo"
						>
							↷
						</button>
						<button
							type="button"
							className="canvas-toolbar-btn"
							onClick={exportCanvas}
							aria-label="Export canvas"
							title="Export canvas"
						>
							⇩
						</button>
					</>
				)}
				<button
					type="button"
					className="canvas-toolbar-btn"
					onClick={() => setShowGrid((value) => !value)}
					aria-label="Toggle Grid Dots"
					aria-pressed={showGrid}
				>
					⚙
				</button>
				<button type="button" className="canvas-toolbar-btn" onClick={zoomIn} aria-label="Zoom in">
					＋
				</button>
				<button
					type="button"
					className="canvas-toolbar-btn"
					onClick={resetZoom}
					aria-label="Reset zoom (1:1)"
				>
					◎
				</button>
				<button
					type="button"
					className="canvas-toolbar-btn"
					onClick={fitToView}
					aria-label="Fit to View"
				>
					⛶
				</button>
				<button
					type="button"
					className="canvas-toolbar-btn"
					onClick={zoomOut}
					aria-label="Zoom out"
				>
					−
				</button>
				<button
					type="button"
					className="canvas-toolbar-btn"
					ref={helpButtonRef}
					onClick={() => setShowHelp((value) => !value)}
					aria-label="Help"
					aria-expanded={showHelp}
					aria-haspopup="dialog"
				>
					?
				</button>
			</div>
			{showHelp && (
				<div
					className="canvas-help-modal"
					role="dialog"
					aria-modal="true"
					aria-labelledby={helpTitleId}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.stopPropagation();
							setShowHelp(false);
							return;
						}
						// The dialog holds a single focusable control; Tab keeps focus on
						// it rather than walking back out into the toolbar behind it.
						if (event.key === "Tab") {
							event.preventDefault();
							helpCloseRef.current?.focus();
						}
					}}
				>
					<div className="canvas-help-header">
						<h3 id={helpTitleId}>Canvas Controls</h3>
						<button
							type="button"
							ref={helpCloseRef}
							className="canvas-help-close"
							aria-label="Close help"
							onClick={() => setShowHelp(false)}
						>
							×
						</button>
					</div>
					<p>
						{editable
							? "Drag cards to move them; drag the background, middle-drag or Space+drag to pan. Double-click (or Enter) edits a text card; Escape finishes. Shift-click adds to the selection. Arrow keys move the selection. Select a card, then ⇄ and a second card to connect them. Delete removes the selection. Ctrl/⌘+Z undoes, Ctrl/⌘+S exports."
							: "Drag anywhere to pan, or use the arrow keys. Scroll or pinch to zoom (Ctrl/⌘+scroll inside a page). Press F or double-click the background to fit the board; 0 resets to 1:1."}
					</p>
				</div>
			)}
		</div>
	);
}

interface NodeFrameProps {
	node: CanvasNode;
	zIndex: number;
	isSelected: boolean;
	isHovered: boolean;
	editable: boolean;
	isEditing: boolean;
	draftText?: string;
	memberCount: number;
	isCollapsed: boolean;
	assets?: Record<string, string>;
	notes?: Record<string, string>;
	links?: CanvasData["links"];
	idPrefix: string;
	fileRoutePrefix?: string;
	linkPreview?: boolean;
	iframeSandbox?: string;
	onPointerDown: (node: CanvasNode, event: PointerEvent<HTMLDivElement>) => void;
	onResizePointerDown: (node: CanvasNode, event: PointerEvent<HTMLButtonElement>) => void;
	onSelect: (nodeId: string, extend: boolean) => void;
	onEdit: (nodeId: string) => void;
	onHover: (nodeId: string | null) => void;
	onToggleCollapse: (groupId: string) => void;
	onDraftChange: (text: string) => void;
	onCommitEdit: () => void;
}

/**
 * The positioned, focusable frame around one card: it owns selection, drag,
 * resize, collapse and inline editing. Memoised with stable callbacks, so a
 * drag re-renders only the cards that move.
 */
const NodeFrame = memo(function NodeFrame({
	node,
	zIndex,
	isSelected,
	isHovered,
	editable,
	isEditing,
	draftText,
	memberCount,
	isCollapsed,
	assets,
	notes,
	links,
	idPrefix,
	fileRoutePrefix,
	linkPreview,
	iframeSandbox,
	onPointerDown,
	onResizePointerDown,
	onSelect,
	onEdit,
	onHover,
	onToggleCollapse,
	onDraftChange,
	onCommitEdit,
}: NodeFrameProps) {
	const label = cardLabel(node);
	return (
		<div
			className={`canvas-node-frame canvas-node-frame-${node.type}${isSelected ? " is-selected" : ""}`}
			data-node-id={node.id}
			role="group"
			aria-roledescription={node.type === "group" ? "group" : "card"}
			aria-label={editable && isSelected ? `${label} (selected)` : label}
			tabIndex={0}
			onPointerDown={(event) => onPointerDown(node, event)}
			onPointerEnter={() => onHover(node.id)}
			onPointerLeave={() => onHover(null)}
			onClick={(event) => {
				// The editor selects on pointerdown (it has to, to drag); the viewer
				// selects here. A pan that starts on a card captures the pointer, so
				// its click lands on the viewport, not here. A click on a link,
				// control or embedded frame inside the card belongs to that element.
				if (editable) return;
				const interactive =
					event.target instanceof Element ? event.target.closest(INTERACTIVE_CONTENT) : null;
				if (interactive && event.currentTarget.contains(interactive)) return;
				onSelect(node.id, event.shiftKey);
			}}
			onFocus={(event) => {
				if (event.target === event.currentTarget) onHover(node.id);
			}}
			onBlur={(event) => {
				if (event.target === event.currentTarget) onHover(null);
			}}
			onKeyDown={(event) => {
				if (event.target !== event.currentTarget) return;
				if (editable && event.key === "Enter" && node.type === "text") {
					event.preventDefault();
					event.stopPropagation();
					onSelect(node.id, false);
					onEdit(node.id);
					return;
				}
				if (event.key === " " || event.key === "Enter") {
					event.preventDefault();
					onSelect(node.id, event.shiftKey);
				}
			}}
			onDoubleClick={() => {
				if (editable && node.type === "text") onEdit(node.id);
			}}
			style={{
				position: "absolute",
				left: node.x,
				top: node.y,
				width: node.width,
				height: node.height,
				zIndex,
			}}
		>
			<CanvasNodeComponent
				node={node}
				assets={assets}
				notes={notes}
				links={links}
				idPrefix={idPrefix}
				isHovered={isHovered}
				isSelected={isSelected}
				fileRoutePrefix={fileRoutePrefix}
				linkPreview={linkPreview}
				iframeSandbox={iframeSandbox}
			/>
			{editable && isSelected && (
				<button
					type="button"
					className="canvas-resize-handle"
					aria-label={`Resize ${label}`}
					onPointerDown={(event) => onResizePointerDown(node, event)}
				/>
			)}
			{node.type === "group" && memberCount > 0 && (
				// A group with nothing inside has nothing to hide, so it gets no
				// control.
				<button
					type="button"
					className="canvas-group-collapse"
					aria-label={`${isCollapsed ? "Expand" : "Collapse"} group ${node.label || node.id}`}
					aria-expanded={!isCollapsed}
					title={isCollapsed ? "Expand group" : "Collapse group"}
					onPointerDown={(event) => event.stopPropagation()}
					onClick={(event) => {
						event.stopPropagation();
						onToggleCollapse(node.id);
					}}
				>
					{isCollapsed ? "▸" : "▾"}
				</button>
			)}
			{isEditing && node.type === "text" && (
				<textarea
					// biome-ignore lint/a11y/noAutofocus: focus is required for immediate text-card editing
					autoFocus
					className="canvas-editor-textarea"
					aria-label={`Edit ${label}`}
					value={draftText ?? ""}
					// Text selection with the mouse is the textarea's own gesture; it
					// must not start a card drag.
					onPointerDown={(event) => event.stopPropagation()}
					onChange={(event) => onDraftChange(event.target.value)}
					onBlur={onCommitEdit}
				/>
			)}
		</div>
	);
});
