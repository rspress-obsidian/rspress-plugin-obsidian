import type { RefObject } from "react";
import { useCallback } from "react";
import { serializeCanvas } from "../parser.js";
import type { CanvasData, CanvasNode } from "../types.js";
import {
	createEdge,
	createFileNode,
	createGroupNode,
	createLinkNode,
	createTextNode,
} from "../utils/editor.js";
import {
	applyEditorAction,
	type CanvasEditor,
	type EditorAction,
	type NodeMove,
} from "./useCanvasEditor.js";
import type { CanvasSelection } from "./useCanvasSelection.js";
import type { Viewport } from "./usePanZoom.js";

/** The file name an export downloads as: the board's own name. */
export function exportFileName(boardId: string | undefined, editorTitle: string): string {
	const name = boardId
		?.split("/")
		.pop()
		?.replace(/\.canvas$/i, "");
	return `${name || editorTitle.toLowerCase().replace(/\s+/g, "-") || "canvas"}.canvas`;
}

export interface BoardCommandsOptions
	extends Pick<CanvasEditor, "commit">,
		Pick<
			CanvasSelection,
			"selectedNodeIds" | "selectedEdgeId" | "setSelectedNodeIds" | "setSelectedEdgeId"
		> {
	/** The latest board; every command reads and replaces it. */
	canvasRef: RefObject<CanvasData>;
	/** The latest viewport, whose centre a new card drops at. */
	viewportRef: RefObject<Viewport>;
	/** The viewport element: its box locates the centre, and it takes focus after a delete. */
	containerRef: RefObject<HTMLElement | null>;
	/** Open the inline editor on a newly created text card. */
	editNode: (node: CanvasNode) => void;
	boardId?: string;
	editorTitle: string;
}

export interface BoardCommands {
	connectEdge: (fromId: string, toId: string) => void;
	createTextCard: () => void;
	createFileCard: () => void;
	createLinkCard: () => void;
	createGroupCard: () => void;
	deleteSelectedEdge: () => void;
	deleteSelected: () => void;
	nudgeSelected: (dx: number, dy: number) => void;
	exportCanvas: () => void;
}

/** The editor's board edits, each committed to the undo history as one action. */
export function useBoardCommands({
	canvasRef,
	viewportRef,
	containerRef,
	commit,
	selectedNodeIds,
	selectedEdgeId,
	setSelectedNodeIds,
	setSelectedEdgeId,
	editNode,
	boardId,
	editorTitle,
}: BoardCommandsOptions): BoardCommands {
	const connectEdge = useCallback(
		(fromId: string, toId: string) => {
			const current = canvasRef.current;
			const from = current.nodes.find((node) => node.id === fromId);
			const to = current.nodes.find((node) => node.id === toId);
			if (!from || !to || fromId === toId) return;
			const edge = createEdge(current.edges, from, to);
			commit({ type: "add-edge", edge }, { ...current, edges: [...current.edges, edge] });
		},
		[canvasRef, commit],
	);

	const createCard = useCallback(
		(factory: (nodes: CanvasNode[], x: number, y: number) => CanvasNode) => {
			const current = canvasRef.current;
			const probe = factory(current.nodes, 0, 0);
			// World coordinates of the visible centre, where Obsidian drops a new card.
			const rect = containerRef.current?.getBoundingClientRect();
			const { x, y, zoom } = viewportRef.current;
			const centerX = ((rect?.width ?? 0) / 2 - x) / zoom;
			const centerY = ((rect?.height ?? 0) / 2 - y) / zoom;
			const node = factory(current.nodes, centerX - probe.width / 2, centerY - probe.height / 2);
			commit({ type: "add-node", node }, { ...current, nodes: [...current.nodes, node] });
			setSelectedEdgeId(null);
			setSelectedNodeIds([node.id]);
			return node;
		},
		[canvasRef, commit, containerRef, setSelectedEdgeId, setSelectedNodeIds, viewportRef],
	);

	const createTextCard = useCallback(
		() => editNode(createCard(createTextNode)),
		[createCard, editNode],
	);
	const createFileCard = useCallback(() => void createCard(createFileNode), [createCard]);
	const createLinkCard = useCallback(() => void createCard(createLinkNode), [createCard]);
	const createGroupCard = useCallback(() => void createCard(createGroupNode), [createCard]);

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
	}, [canvasRef, commit, containerRef, selectedEdgeId, setSelectedEdgeId]);

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
	}, [canvasRef, commit, containerRef, selectedNodeIds, setSelectedNodeIds]);

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
			commit(action, applyEditorAction(current, action));
		},
		[canvasRef, commit, selectedNodeIds],
	);

	const exportCanvas = useCallback(() => {
		const blob = new Blob([serializeCanvas(canvasRef.current)], { type: "application/json" });
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = exportFileName(boardId, editorTitle);
		anchor.click();
		URL.revokeObjectURL(url);
	}, [boardId, canvasRef, editorTitle]);

	return {
		connectEdge,
		createTextCard,
		createFileCard,
		createLinkCard,
		createGroupCard,
		deleteSelectedEdge,
		deleteSelected,
		nudgeSelected,
		exportCanvas,
	};
}
