import type { PointerEvent } from "react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { disposeMermaid, renderMermaidBlocks, retainMermaid } from "../../mermaid/blocks.js";
import { MERMAID_STRICT_SCOPE_ATTRIBUTE } from "../../mermaid/classes.js";
import { DEFAULT_IFRAME_SANDBOX } from "../constants.js";
import { useBoardCommands } from "../hooks/useBoardCommands.js";
import { useCanvasEditor } from "../hooks/useCanvasEditor.js";
import { useCanvasGroups } from "../hooks/useCanvasGroups.js";
import { useCanvasSelection } from "../hooks/useCanvasSelection.js";
import { useCanvasShortcuts } from "../hooks/useCanvasShortcuts.js";
import { useCardEditing } from "../hooks/useCardEditing.js";
import { useFitToView } from "../hooks/useFitToView.js";
import { useNodeGesture } from "../hooks/useNodeGesture.js";
import { usePanZoom, viewportStorageKey } from "../hooks/usePanZoom.js";
import type { CanvasData, CanvasNode } from "../types.js";
import { renderCanvasMath } from "../utils/math-render.js";
import { CanvasEdge } from "./CanvasEdge.js";
import { CanvasToolbar } from "./CanvasToolbar.js";
import { EdgeMarkers } from "./EdgeMarkers.js";
import { NodeFrame } from "./NodeFrame.js";

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

export function CanvasRenderer({
	data,
	boardId,
	fileRoutePrefix,
	linkPreview,
	editable = false,
	editorTitle = "Canvas editor",
	iframeSandbox = DEFAULT_IFRAME_SANDBOX,
	wheelZoom = true,
}: CanvasRendererProps) {
	const { canvas, canUndo, canRedo, contentVersion, commit, undo, redo, preview } =
		useCanvasEditor(data);
	const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
	const [showGrid, setShowGrid] = useState(true);
	const [showHelp, setShowHelp] = useState(false);
	const [edgeSourceId, setEdgeSourceId] = useState<string | null>(null);
	const instanceId = useId().replace(/[^A-Za-z0-9_-]/g, "");
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

	const {
		selectedNodeIds,
		selectedEdgeId,
		setSelectedNodeIds,
		setSelectedEdgeId,
		selectNode,
		selectEdge,
		clearSelection,
	} = useCanvasSelection();
	const { editingNodeId, draftText, setDraftText, editingRef, startEditing, editNode, commitEdit } =
		useCardEditing({ editable, canvasRef, commit });
	const { isDragging, startDrag, startResize, updateGesture, finishGesture } = useNodeGesture({
		canvasRef,
		viewportRef,
		commit,
		preview,
	});
	// A member hidden by a collapse must leave the selection, or Delete would
	// remove cards the user can no longer see.
	const deselect = useCallback(
		(hidden: ReadonlySet<string>) =>
			setSelectedNodeIds((selected) => selected.filter((id) => !hidden.has(id))),
		[setSelectedNodeIds],
	);
	const {
		groupMembers,
		membersOf,
		collapsedGroupIds,
		toggleGroupCollapse,
		visibleNodes,
		visibleEdges,
	} = useCanvasGroups({
		nodes: canvas.nodes,
		edges: canvas.edges,
		isDragging,
		onHide: deselect,
	});
	const fitToView = useFitToView({
		canvasRef,
		containerRef,
		setViewport,
		fitOnMountRef: needsInitialFit,
	});
	const {
		connectEdge,
		createTextCard,
		createFileCard,
		createLinkCard,
		createGroupCard,
		deleteSelectedEdge,
		deleteSelected,
		nudgeSelected,
		exportCanvas,
	} = useBoardCommands({
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
	});

	const nodeMap = useMemo(
		() => new Map(canvas.nodes.map((node) => [node.id, node])),
		[canvas.nodes],
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
			// A group drags the members it holds along with it.
			startDrag(node.type === "group" ? [node.id, ...membersOf(node.id)] : [node.id], event);
		},
		[connectEdge, editable, isSpaceHeld, membersOf, selectNode, startDrag],
	);

	// Escape leaves whatever is in progress: it commits an open draft (and puts
	// focus back on its card), and drops the selection, the connect gesture and help.
	const handleEscape = useCallback(() => {
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
	}, [clearSelection, commitEdit, containerRef, editingRef]);

	const handleKeyDown = useCanvasShortcuts({
		editable,
		selectedNodeIds,
		selectedEdgeId,
		escape: handleEscape,
		undo,
		redo,
		exportCanvas,
		deleteSelectedEdge,
		deleteSelected,
		startEditing,
		nudgeSelected,
		panBy,
		zoomIn,
		zoomOut,
		resetZoom,
		fitToView,
	});

	// The toolbar is memoised; with handlers of one identity it sits out the
	// per-frame re-render a pan or zoom causes.
	const armConnect = useCallback(() => {
		const [sourceId] = selectedNodeIds;
		if (sourceId) setEdgeSourceId(sourceId);
	}, [selectedNodeIds]);
	const toggleGrid = useCallback(() => setShowGrid((value) => !value), []);
	const toggleHelp = useCallback(() => setShowHelp((value) => !value), []);
	const closeHelp = useCallback(() => setShowHelp(false), []);

	// Everything inside the transformed world, which a pan or zoom does not
	// change: returning the same element lets React skip the whole subtree on
	// the per-frame viewport re-render instead of diffing every card and edge.
	const worldContent = useMemo(
		() => (
			<>
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
					<EdgeMarkers edges={visibleEdges} idPrefix={instanceId} />
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
							onResizePointerDown={startResize}
							onSelect={selectNode}
							onEdit={startEditing}
							onHover={setHoveredNodeId}
							onToggleCollapse={toggleGroupCollapse}
							onDraftChange={setDraftText}
							onCommitEdit={commitEdit}
						/>
					);
				})}
			</>
		),
		[
			showGrid,
			edgeLayer,
			editable,
			visibleEdges,
			nodeMap,
			instanceId,
			connectedEdgeIds,
			selectedEdgeId,
			selectEdge,
			visibleNodes,
			selectedNodeIds,
			hoveredNodeId,
			zIndexById,
			topLayer,
			editingNodeId,
			draftText,
			groupMembers,
			collapsedGroupIds,
			canvas.assets,
			canvas.notes,
			canvas.links,
			fileRoutePrefix,
			linkPreview,
			iframeSandbox,
			handleNodePointerDown,
			startResize,
			selectNode,
			startEditing,
			toggleGroupCollapse,
			setDraftText,
			commitEdit,
		],
	);

	return (
		<div
			ref={rootRef}
			className={`canvas-container ${editable ? "canvas-editor" : ""}`}
			// Card diagrams are author content shown to every reader: Mermaid renders
			// them at `strict` whatever the page's own security level is.
			{...{ [MERMAID_STRICT_SCOPE_ATTRIBUTE]: "" }}
		>
			{editable && (
				<div className="canvas-editor-banner" role="status">
					<strong>{editorTitle}</strong>
					<span>{canUndo ? "Unsaved changes" : "Read-only source until exported"}</span>
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
					if (!handlePointerMove(event)) updateGesture(event);
				}}
				onPointerUp={(event) => {
					handlePointerUp(event);
					finishGesture();
				}}
				// A touch takeover, a native drag or an OS-level interruption ends the
				// gesture with pointercancel and no pointerup. Without these the pan
				// stayed active and the card gesture stayed armed: the card kept
				// following the cursor and the move never reached the undo history.
				onPointerCancel={(event) => {
					handlePointerUp(event);
					finishGesture();
				}}
				onLostPointerCapture={(event) => {
					handlePointerUp(event);
					finishGesture();
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
					{worldContent}
				</div>
			</div>
			<CanvasToolbar
				editable={editable}
				canUndo={canUndo}
				canRedo={canRedo}
				hasNodeSelection={selectedNodeIds.length > 0}
				hasEdgeSelection={Boolean(selectedEdgeId)}
				showGrid={showGrid}
				showHelp={showHelp}
				onAddText={createTextCard}
				onAddFile={createFileCard}
				onAddLink={createLinkCard}
				onAddGroup={createGroupCard}
				onConnect={armConnect}
				onDeleteEdge={deleteSelectedEdge}
				onDeleteSelected={deleteSelected}
				onUndo={undo}
				onRedo={redo}
				onExport={exportCanvas}
				onToggleGrid={toggleGrid}
				onZoomIn={zoomIn}
				onResetZoom={resetZoom}
				onFitToView={fitToView}
				onZoomOut={zoomOut}
				onToggleHelp={toggleHelp}
				onCloseHelp={closeHelp}
			/>
		</div>
	);
}
