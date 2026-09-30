import type { KeyboardEvent, MouseEvent, PointerEvent } from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { disposeMermaid, renderMermaidBlocks, retainMermaid } from "../../mermaid/blocks.js";
import { usePanZoom } from "../hooks/usePanZoom.js";
import type { CanvasData, CanvasEdgeData, CanvasNode } from "../types.js";
import { resolveColor } from "../utils/color.js";
import {
	createEdge,
	createFileNode,
	createGroupNode,
	createLinkNode,
	createTextNode,
} from "../utils/editor.js";
import { membersByGroup } from "../utils/group.js";
import { CanvasEdge } from "./CanvasEdge.js";
import { CanvasNodeComponent } from "./CanvasNode.js";

interface CanvasRendererProps {
	data: CanvasData;
	fileRoutePrefix?: string;
	linkPreview?: boolean;
	editable?: boolean;
	editorTitle?: string;
	iframeSandbox?: string;
}
/** One node's travel within a move action. */
interface NodeMove {
	id: string;
	from: { x: number; y: number };
	to: { x: number; y: number };
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
	| { type: "delete-node"; node: CanvasNode; edges: CanvasEdgeData[] }
	| { type: "delete-nodes"; nodes: CanvasNode[]; edges: CanvasEdgeData[] }
	| { type: "delete-edge"; edge: CanvasEdgeData }
	| { type: "add-edge"; edge: CanvasEdgeData };

interface DragState {
	id: string;
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

function edgeColor(color: string | undefined): string {
	return resolveColor(color, "var(--canvas-edge-color)");
}

function cloneData(data: CanvasData): CanvasData {
	return {
		nodes: data.nodes.map((node) => ({ ...node })),
		edges: data.edges.map((edge) => ({ ...edge })),
		assets: data.assets ? { ...data.assets } : undefined,
		notes: data.notes ? { ...data.notes } : undefined,
	};
}

/**
 * Movement, in screen pixels, after which a pointer press on a card becomes a
 * drag and claims pointer capture.
 *
 * Capturing on pointerdown instead would retarget the compatibility click to
 * the wrapper, and the click target is the common ancestor of the retargeted
 * mouseup and the mousedown — so every link inside a card (file-card "open
 * note", link nodes, wikilinks in rendered markdown) would stop navigating.
 * Capture is only needed once the gesture is known to be a drag.
 */
const DRAG_CAPTURE_THRESHOLD = 3;

export function CanvasRenderer({
	data,
	fileRoutePrefix,
	linkPreview,
	editable = false,
	editorTitle = "Canvas editor",
	iframeSandbox = "allow-scripts allow-same-origin allow-popups",
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
	// Collapsed groups are view state, never canvas data: the `.canvas` format has
	// nowhere to record them and export must stay byte-faithful to the source.
	const [collapsedGroupIds, setCollapsedGroupIds] = useState<string[]>([]);
	const helpButtonRef = useRef<HTMLButtonElement>(null);
	const helpCloseRef = useRef<HTMLButtonElement>(null);
	const helpTitleId = useId();
	const dragRef = useRef<DragState | null>(null);
	const resizeRef = useRef<ResizeState | null>(null);
	// A press on a card, held until the pointer moves far enough to be a drag.
	const pendingCaptureRef = useRef<{
		element: Element;
		pointerId: number;
		x: number;
		y: number;
	} | null>(null);
	const mermaidRootRef = useRef<HTMLDivElement>(null);
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
		zoomIn,
		zoomOut,
		resetZoom,
	} = usePanZoom(undefined, (restored) => {
		// A board the reader has already positioned reopens where they left it;
		// only a first visit (or one whose stored viewport was unusable) fits.
		if (!restored) needsInitialFit.current = true;
	});

	const nodeMap = useMemo(
		() => new Map(canvas.nodes.map((node) => [node.id, node])),
		[canvas.nodes],
	);
	// Which nodes each group holds, by containment. Recomputed whenever the node
	// geometry changes, so membership follows a drag out of (or into) a group.
	const groupMembers = useMemo(() => membersByGroup(canvas.nodes), [canvas.nodes]);
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
	// Groups are containers, so they stack beneath everything else whatever order
	// the file lists them in: a group appended by the toolbar would otherwise
	// paint over the cards it was drawn to hold. Rank groups first, then the rest,
	// keeping each band in canvas order.
	const zIndexById = useMemo(() => {
		const ranks = new Map<string, number>();
		let rank = 0;
		for (const node of canvas.nodes) if (node.type === "group") ranks.set(node.id, ++rank);
		for (const node of canvas.nodes) if (node.type !== "group") ranks.set(node.id, ++rank);
		return ranks;
	}, [canvas.nodes]);
	const connectedEdgeIds = useMemo(() => {
		const activeIds = new Set(selectedNodeIds);
		if (hoveredNodeId) activeIds.add(hoveredNodeId);
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
			} else if (action.type === "delete-node") {
				if (reverse) {
					next.nodes.push({ ...action.node });
					next.edges.push(...action.edges.map((edge) => ({ ...edge })));
				} else {
					next.nodes = next.nodes.filter((node) => node.id !== action.node.id);
					next.edges = next.edges.filter(
						(edge) => edge.fromNode !== action.node.id && edge.toNode !== action.node.id,
					);
				}
			} else if (action.type === "delete-nodes") {
				const ids = new Set(action.nodes.map((node) => node.id));
				if (reverse) {
					next.nodes.push(...action.nodes.map((node) => ({ ...node })));
					next.edges.push(...action.edges.map((edge) => ({ ...edge })));
				} else {
					next.nodes = next.nodes.filter((node) => !ids.has(node.id));
					next.edges = next.edges.filter(
						(edge) => !ids.has(edge.fromNode) && !ids.has(edge.toNode),
					);
				}
			} else if (action.type === "add-edge") {
				if (reverse) next.edges = next.edges.filter((edge) => edge.id !== action.edge.id);
				else next.edges.push({ ...action.edge });
			} else if (action.type === "delete-edge") {
				if (reverse) next.edges.push({ ...action.edge });
				else next.edges = next.edges.filter((edge) => edge.id !== action.edge.id);
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
	}, [applyAction, history]);

	const redo = useCallback(() => {
		const action = future.at(-1);
		if (!action) return;
		setCanvas((current) => applyAction(current, action));
		setFuture((current) => current.slice(0, -1));
		setHistory((current) => [...current, action]);
	}, [applyAction, future]);

	const fitToView = useCallback(() => {
		if (canvas.nodes.length === 0) return;
		const bounds = canvas.nodes.reduce(
			(result, node) => ({
				minX: Math.min(result.minX, node.x),
				minY: Math.min(result.minY, node.y),
				maxX: Math.max(result.maxX, node.x + node.width),
				maxY: Math.max(result.maxY, node.y + node.height),
			}),
			{ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
		);
		const viewport = containerRef.current?.getBoundingClientRect();
		// No measurable box means the canvas is not laid out (unmounted, `display:
		// none`, or no layout engine). Fitting to a guessed 800x500 there would
		// place the viewport in coordinates the user never sees.
		const width = viewport?.width ?? 0;
		const height = viewport?.height ?? 0;
		if (width <= 0 || height <= 0) return;
		const zoom = Math.max(
			0.15,
			Math.min(
				1.5,
				Math.min(
					(width - 80) / (bounds.maxX - bounds.minX),
					(height - 80) / (bounds.maxY - bounds.minY),
				),
			),
		);
		setViewport({
			x: width / 2 - (bounds.minX + (bounds.maxX - bounds.minX) / 2) * zoom,
			y: height / 2 - (bounds.minY + (bounds.maxY - bounds.minY) / 2) * zoom,
			zoom,
		});
	}, [canvas.nodes, containerRef, setViewport]);

	// Fit once on mount. `fitToView` changes identity with `canvas.nodes`, so
	// depending on it here re-fitted — and discarded the user's pan/zoom — 100ms
	// after every drag, add, delete and undo. The ref keeps the latest callback
	// reachable without re-running the effect.
	const fitToViewRef = useRef(fitToView);
	useEffect(() => {
		fitToViewRef.current = fitToView;
	});
	useEffect(() => {
		// A restored viewport is the reader's own placement; re-fitting it would
		// undo the very thing that was remembered.
		if (!needsInitialFit.current) return;
		let frame = 0;
		const timer = setTimeout(() => {
			frame = requestAnimationFrame(() => fitToViewRef.current());
		}, 100);
		return () => {
			clearTimeout(timer);
			cancelAnimationFrame(frame);
		};
	}, []);

	// A collapsed id outlives its group only until the next canvas change. Left in
	// place it would still be collapsed by the time the toolbar's next group takes
	// the freed id, and that new group would hide its members on sight.
	useEffect(() => {
		setCollapsedGroupIds((current) =>
			current.some((id) => !nodeMap.has(id)) ? current.filter((id) => nodeMap.has(id)) : current,
		);
	}, [nodeMap]);

	// The markdown each card renders, as one string. Mermaid blocks are injected
	// by renderMermaidBlocks, and the effect below re-scans on exactly this key:
	// a drag or resize changes coordinates only, so it no longer re-parses every
	// diagram per frame, while editing a card still re-renders its diagrams.
	const markdownKey = useMemo(
		() =>
			canvas.nodes
				.map((node) =>
					node.type === "text" ? node.text : node.type === "file" ? (node.fileContent ?? "") : "",
				)
				.filter(Boolean)
				.join("\u0000"),
		[canvas.nodes],
	);
	// The key is the trigger, not an input: the effect re-scans only when the
	// rendered markdown changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-scan keyed on the rendered markdown
	useEffect(() => {
		if (mermaidRootRef.current) renderMermaidBlocks(mermaidRootRef.current);
	}, [markdownKey]);

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

	const selectNode = useCallback((nodeId: string, event?: MouseEvent) => {
		setSelectedNodeIds((current) => {
			if (event?.shiftKey)
				return current.includes(nodeId)
					? current.filter((id) => id !== nodeId)
					: [...current, nodeId];
			return [nodeId];
		});
	}, []);

	// One stable callback for every edge. An inline arrow per edge per render
	// changed the `onSelect` prop on every commit and defeated `CanvasEdge`'s memo.
	const selectEdge = useCallback((edgeId: string) => setSelectedEdgeId(edgeId), []);

	// Collapsing is a view toggle: it never touches `canvas`, so export and the
	// undo history stay exactly as the source had them. A member hidden by the
	// collapse must also leave the selection, or Delete would remove cards the
	// user can no longer see.
	const toggleGroupCollapse = useCallback(
		(groupId: string) => {
			if (!collapsedGroupIds.includes(groupId)) {
				const hidden = new Set(groupMembers.get(groupId) ?? []);
				setSelectedNodeIds((current) => current.filter((id) => !hidden.has(id)));
			}
			setCollapsedGroupIds((current) =>
				current.includes(groupId) ? current.filter((id) => id !== groupId) : [...current, groupId],
			);
		},
		[collapsedGroupIds, groupMembers],
	);

	const startNodeDrag = useCallback(
		(node: CanvasNode, event: PointerEvent) => {
			if (!editable || event.button !== 0) return;
			// A group drags the members it holds by the same delta. Membership is
			// sampled here, at pointerdown, so the set cannot change under the
			// cursor mid-gesture and leave half a group behind.
			const members = node.type === "group" ? (groupMembers.get(node.id) ?? []) : [];
			const dragged = [node, ...members.map((id) => nodeMap.get(id))].filter(
				(item): item is CanvasNode => item !== undefined,
			);
			dragRef.current = {
				id: node.id,
				startX: event.clientX,
				startY: event.clientY,
				origins: dragged.map((item) => ({ id: item.id, x: item.x, y: item.y })),
			};
		},
		[editable, groupMembers, nodeMap],
	);

	const finishNodeDrag = useCallback(() => {
		const drag = dragRef.current;
		const resize = resizeRef.current;
		dragRef.current = null;
		resizeRef.current = null;
		pendingCaptureRef.current = null;
		if (drag) {
			const moves = drag.origins
				.map((origin) => {
					const node = canvas.nodes.find((item) => item.id === origin.id);
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
			if (moves.length) commit({ type: "move", moves }, canvas);
		}
		if (resize) {
			const node = canvas.nodes.find((item) => item.id === resize.id);
			if (node && (node.width !== resize.originX || node.height !== resize.originY)) {
				commit(
					{
						type: "resize",
						id: resize.id,
						from: { width: resize.originX, height: resize.originY },
						to: { width: node.width, height: node.height },
					},
					canvas,
				);
			}
		}
	}, [canvas, commit]);
	const updateDraggedNode = useCallback(
		(event: PointerEvent) => {
			// A press only becomes a drag once it moves: claim the pointer then, so a
			// plain click still reaches the links inside the card.
			const pending = pendingCaptureRef.current;
			if (
				pending &&
				pending.pointerId === event.pointerId &&
				(Math.abs(event.clientX - pending.x) >= DRAG_CAPTURE_THRESHOLD ||
					Math.abs(event.clientY - pending.y) >= DRAG_CAPTURE_THRESHOLD)
			) {
				pendingCaptureRef.current = null;
				pending.element.setPointerCapture(event.pointerId);
			}

			const resize = resizeRef.current;
			// The two gestures are mutually exclusive; a resize wins if both refs are set.
			const drag = resize ? null : dragRef.current;
			if (!resize && !drag) return;
			const zoom = viewport.zoom || 1;
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
				// Only the dragged nodes are new objects, and `edges`/`assets`/`notes`
				// keep their identity: cloning the whole canvas here re-created every
				// card and both lookup tables per frame, which broke
				// `CanvasNodeComponent`'s memo and re-parsed every card's markdown on
				// every pointermove.
				const nodes = current.nodes.slice();
				for (const change of moved) nodes[change.index] = change.node;
				return { ...current, nodes };
			});
		},
		[viewport.zoom],
	);

	const createTextCard = useCallback(() => {
		const node = createTextNode(canvas.nodes, 0, 0);
		if (node.type !== "text") return;
		commit({ type: "add-node", node }, { ...cloneData(canvas), nodes: [...canvas.nodes, node] });
		setSelectedNodeIds([node.id]);
		setEditingNodeId(node.id);
		setDraftText(node.text);
	}, [canvas, commit]);

	const createCard = useCallback(
		(factory: (nodes: CanvasNode[], x: number, y: number) => CanvasNode) => {
			const node = factory(canvas.nodes, 0, 0);
			commit({ type: "add-node", node }, { ...cloneData(canvas), nodes: [...canvas.nodes, node] });
			setSelectedNodeIds([node.id]);
			return node;
		},
		[canvas, commit],
	);

	const createFileCard = useCallback(
		() => createCard((nodes, x, y) => createFileNode(nodes, x, y)),
		[createCard],
	);
	const createLinkCard = useCallback(
		() => createCard((nodes, x, y) => createLinkNode(nodes, x, y)),
		[createCard],
	);
	const createGroupCard = useCallback(
		() => createCard((nodes, x, y) => createGroupNode(nodes, x, y)),
		[createCard],
	);

	const connectEdge = useCallback(
		(fromId: string, toId: string) => {
			if (fromId === toId) return;
			const edge = createEdge(canvas.edges, fromId, toId);
			commit({ type: "add-edge", edge }, { ...cloneData(canvas), edges: [...canvas.edges, edge] });
		},
		[canvas, commit],
	);

	// Stable per-node click handler: connect if an edge source is armed, else select.
	const handleNodeClick = useCallback(
		(nodeId: string) => {
			if (edgeSourceId && edgeSourceId !== nodeId) {
				connectEdge(edgeSourceId, nodeId);
				setEdgeSourceId(null);
			} else {
				selectNode(nodeId);
			}
		},
		[edgeSourceId, connectEdge, selectNode],
	);

	const deleteSelectedEdge = useCallback(() => {
		if (!selectedEdgeId) return;
		const edge = canvas.edges.find((item) => item.id === selectedEdgeId);
		if (!edge) return;
		commit(
			{ type: "delete-edge", edge },
			{ ...cloneData(canvas), edges: canvas.edges.filter((item) => item.id !== edge.id) },
		);
		setSelectedEdgeId(null);
	}, [canvas, commit, selectedEdgeId]);

	const deleteSelected = useCallback(() => {
		const nodes = selectedNodeIds
			.map((id) => canvas.nodes.find((item) => item.id === id))
			.filter((node): node is CanvasNode => node !== undefined);
		if (nodes.length === 0) return;
		const ids = new Set(nodes.map((node) => node.id));
		const edges = canvas.edges.filter((edge) => ids.has(edge.fromNode) || ids.has(edge.toNode));
		commit(
			{ type: "delete-nodes", nodes, edges },
			{
				...cloneData(canvas),
				nodes: canvas.nodes.filter((node) => !ids.has(node.id)),
				edges: canvas.edges.filter((edge) => !ids.has(edge.fromNode) && !ids.has(edge.toNode)),
			},
		);
		setSelectedNodeIds([]);
	}, [canvas, commit, selectedNodeIds]);

	const exportCanvas = useCallback(() => {
		const serialized = {
			...(canvas.assets ? { assets: canvas.assets } : {}),
			...(canvas.notes ? { notes: canvas.notes } : {}),
			nodes: canvas.nodes,
			edges: canvas.edges,
		};
		const blob = new Blob([JSON.stringify(serialized, null, 2)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `${editorTitle.toLowerCase().replace(/\s+/g, "-")}.canvas`;
		anchor.click();
		URL.revokeObjectURL(url);
	}, [canvas, editorTitle]);

	const handleKeyDown = useCallback(
		(event: KeyboardEvent) => {
			// Escape is the one key that must work while editing: it commits the
			// draft and leaves the editor.
			if (event.key === "Escape") {
				setSelectedNodeIds([]);
				setEditingNodeId(null);
				setEdgeSourceId(null);
				setSelectedEdgeId(null);
				setShowHelp(false);
				return;
			}
			// Keys typed into the inline card editor belong to the text field: without
			// this, Backspace/Delete deletes the card being edited, `f`/`0`/`+`/`-`
			// refit or zoom the viewport, and Ctrl+Z undoes a canvas action instead of
			// the text. The guard sits above every other binding for that reason.
			const keyTarget = event.target as HTMLElement | null;
			if (
				keyTarget?.isContentEditable ||
				(keyTarget?.tagName && /^(?:input|textarea|select)$/i.test(keyTarget.tagName))
			) {
				return;
			}
			const modifier = event.ctrlKey || event.metaKey;
			if (modifier && event.key.toLowerCase() === "z") {
				event.preventDefault();
				event.shiftKey ? redo() : undo();
				return;
			}
			if (modifier && event.key.toLowerCase() === "y") {
				event.preventDefault();
				redo();
				return;
			}
			if (modifier && event.key.toLowerCase() === "s") {
				event.preventDefault();
				exportCanvas();
				return;
			}
			if (editable && (event.key === "Delete" || event.key === "Backspace")) {
				event.preventDefault();
				if (selectedEdgeId) deleteSelectedEdge();
				else deleteSelected();
				return;
			}
			if (event.key === "+" || event.key === "=") zoomIn();
			if (event.key === "-") zoomOut();
			if (event.key === "0") resetZoom();
			if (event.key.toLowerCase() === "f") fitToView();
		},
		[
			deleteSelected,
			deleteSelectedEdge,
			editable,
			exportCanvas,
			fitToView,
			redo,
			resetZoom,
			selectedEdgeId,
			undo,
			zoomIn,
			zoomOut,
		],
	);

	return (
		<div ref={mermaidRootRef} className={`canvas-container ${editable ? "canvas-editor" : ""}`}>
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
				aria-label={editable ? "Editable canvas" : "Interactive canvas with nodes and connections"}
				// Focusable so the viewport's own shortcuts (f/0/+/-/Delete) reach it
				// without a child having to hold focus first.
				tabIndex={0}
				onPointerDown={handlePointerDown}
				onPointerMove={(event) => {
					handlePointerMove(event);
					updateDraggedNode(event);
				}}
				onPointerUp={() => {
					handlePointerUp();
					finishNodeDrag();
				}}
				// A touch takeover, a native drag or an OS-level interruption ends the
				// gesture with pointercancel and no pointerup. Without these the pan
				// stayed active and `dragRef`/`resizeRef` stayed armed: the card kept
				// following the cursor and the move never reached the undo history.
				onPointerCancel={() => {
					handlePointerUp();
					finishNodeDrag();
				}}
				onLostPointerCapture={() => {
					handlePointerUp();
					finishNodeDrag();
				}}
				onClick={(event) => {
					if (event.target === event.currentTarget) setSelectedNodeIds([]);
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
						// Editable edges are real buttons: hiding them would leave focusable
						// controls inside an aria-hidden subtree (an axe violation).
						aria-hidden={editable ? undefined : true}
					>
						<title>Canvas edges</title>
						<defs>
							{visibleEdges.map((edge) => {
								const color = edgeColor(edge.color);
								return (
									<g key={edge.id}>
										<marker
											id={`arrowhead-${edge.id}`}
											markerWidth="10"
											markerHeight="7"
											refX="9"
											refY="3.5"
											orient="auto"
										>
											<polygon points="0 0, 10 3.5, 0 7" fill={color} />
										</marker>
										<marker
											id={`arrowhead-start-${edge.id}`}
											markerWidth="10"
											markerHeight="7"
											refX="1"
											refY="3.5"
											orient="auto"
										>
											<polygon points="10 0, 0 3.5, 10 7" fill={color} />
										</marker>
									</g>
								);
							})}
						</defs>
						{visibleEdges.map((edge) => (
							<CanvasEdge
								key={edge.id}
								edge={edge}
								nodeMap={nodeMap}
								isHighlighted={connectedEdgeIds.has(edge.id)}
								isSelected={selectedEdgeId === edge.id}
								onSelect={editable ? selectEdge : undefined}
							/>
						))}
					</svg>
					{canvas.nodes
						.filter((node) => !hiddenNodeIds.has(node.id))
						.map((node) => (
							// biome-ignore lint/a11y/noStaticElementInteractions: editor node wrapper owns drag and resize gestures
							<div
								key={node.id}
								onPointerDown={(event) => {
									event.stopPropagation();
									// The viewport's own capture never runs — the event is stopped
									// above — so the drag claims the pointer here, but only once it
									// moves: capturing now would swallow the click on a link inside
									// this card (see DRAG_CAPTURE_THRESHOLD). Without the claim a
									// release outside the viewport is never delivered, so the drag
									// stays armed and the move never reaches the undo history.
									selectNode(node.id, event);
									startNodeDrag(node, event);
									if (editable && event.button === 0) {
										pendingCaptureRef.current = {
											element: event.currentTarget,
											pointerId: event.pointerId,
											x: event.clientX,
											y: event.clientY,
										};
									}
								}}
								onDoubleClick={() => {
									if (editable && node.type === "text") {
										setEditingNodeId(node.id);
										setDraftText(node.text);
									}
								}}
								className="canvas-editor-node-wrapper"
								style={{
									position: "absolute",
									left: node.x,
									top: node.y,
									width: node.width,
									height: node.height,
									zIndex: zIndexById.get(node.id),
								}}
							>
								<CanvasNodeComponent
									node={node}
									assets={canvas.assets}
									notes={canvas.notes}
									zIndex={zIndexById.get(node.id)}
									isHovered={node.id === hoveredNodeId}
									isSelected={selectedNodeIds.includes(node.id)}
									fileRoutePrefix={fileRoutePrefix}
									linkPreview={linkPreview}
									iframeSandbox={iframeSandbox}
									onHover={setHoveredNodeId}
									onClick={handleNodeClick}
								/>
								{editable && selectedNodeIds.includes(node.id) && (
									<button
										type="button"
										className="canvas-resize-handle"
										aria-label={`Resize ${node.id}`}
										onPointerDown={(event) => {
											event.stopPropagation();
											event.currentTarget.setPointerCapture(event.pointerId);
											resizeRef.current = {
												id: node.id,
												startX: event.clientX,
												startY: event.clientY,
												originX: node.width,
												originY: node.height,
											};
										}}
									/>
								)}
								{node.type === "group" && (groupMembers.get(node.id)?.length ?? 0) > 0 && (
									// A group with nothing inside has nothing to hide, so it gets
									// no control. The toggle is a sibling of the group card, not a
									// child: the card is itself a button and controls may not nest.
									// ponytail: the wrapper's z-index makes it a stacking context, so
									// this control paints in the group's band — a member card sitting
									// over the group's top-right corner covers it. Promote it to a
									// world-level overlay if that ever matters.
									<button
										type="button"
										className="canvas-group-collapse"
										aria-label={`${collapsedGroupIds.includes(node.id) ? "Expand" : "Collapse"} group ${node.label || node.id}`}
										aria-expanded={collapsedGroupIds.includes(node.id)}
										title={collapsedGroupIds.includes(node.id) ? "Expand group" : "Collapse group"}
										onPointerDown={(event) => event.stopPropagation()}
										onClick={(event) => {
											event.stopPropagation();
											toggleGroupCollapse(node.id);
										}}
									>
										{collapsedGroupIds.includes(node.id) ? "▸" : "▾"}
									</button>
								)}
								{editable && editingNodeId === node.id && node.type === "text" && (
									<textarea
										// biome-ignore lint/a11y/noAutofocus: focus is required for immediate text-card editing
										autoFocus
										className="canvas-editor-textarea"
										value={draftText}
										onChange={(event) => setDraftText(event.target.value)}
										onBlur={() => {
											const updated = { ...node, text: draftText } as CanvasNode;
											commit(
												{ type: "update", id: node.id, from: node, to: updated },
												{
													...cloneData(canvas),
													nodes: canvas.nodes.map((item) => (item.id === node.id ? updated : item)),
												},
											);
											setEditingNodeId(null);
										}}
									/>
								)}
							</div>
						))}
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
							? "Double-click text to edit. Drag cards to move. Shift-click for multi-selection. Select a node, then ⇄ to connect an edge to another node. Click an edge to select it. Delete removes selected cards/edges. Ctrl/Cmd+S exports."
							: "Drag to pan. Scroll to zoom. Double-click the background to fit the canvas."}
					</p>
				</div>
			)}
		</div>
	);
}
