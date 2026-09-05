import type { KeyboardEvent, MouseEvent, PointerEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePanZoom } from '../hooks/usePanZoom';
import type { CanvasData, CanvasEdgeData, CanvasNode } from '../types';
import { resolveColor } from '../utils/color';
import {
  createEdge,
  createFileNode,
  createGroupNode,
  createLinkNode,
  createTextNode,
} from '../utils/editor';
import { disposeMermaid, renderMermaidBlocks } from '../utils/mermaid';
import { CanvasEdge } from './CanvasEdge';
import { CanvasNodeComponent } from './CanvasNode';

interface CanvasRendererProps {
  data: CanvasData;
  fileRoutePrefix?: string;
  linkPreview?: boolean;
  editable?: boolean;
  editorTitle?: string;
  iframeSandbox?: string;
}
type EditorAction =
  | { type: 'move'; id: string; from: { x: number; y: number }; to: { x: number; y: number } }
  | {
      type: 'resize';
      id: string;
      from: { width: number; height: number };
      to: { width: number; height: number };
    }
  | { type: 'update'; id: string; from: CanvasNode; to: CanvasNode }
  | { type: 'add-node'; node: CanvasNode }
  | { type: 'delete-node'; node: CanvasNode; edges: CanvasEdgeData[] }
  | { type: 'delete-nodes'; nodes: CanvasNode[]; edges: CanvasEdgeData[] }
  | { type: 'delete-edge'; edge: CanvasEdgeData }
  | { type: 'add-edge'; edge: CanvasEdgeData };

interface DragState {
  id: string;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

function edgeColor(color: string | undefined): string {
  return resolveColor(color, 'var(--canvas-edge-color)');
}

function cloneData(data: CanvasData): CanvasData {
  return {
    nodes: data.nodes.map((node) => ({ ...node })),
    edges: data.edges.map((edge) => ({ ...edge })),
    assets: data.assets ? { ...data.assets } : undefined,
    notes: data.notes ? { ...data.notes } : undefined,
  };
}

export function CanvasRenderer({
  data,
  fileRoutePrefix,
  linkPreview,
  editable = false,
  editorTitle = 'Canvas editor',
  iframeSandbox = 'allow-scripts allow-same-origin allow-popups',
}: CanvasRendererProps) {
  const [canvas, setCanvas] = useState(() => cloneData(data));
  const [history, setHistory] = useState<EditorAction[]>([]);
  const [future, setFuture] = useState<EditorAction[]>([]);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [showGrid, setShowGrid] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [draftText, setDraftText] = useState('');
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [edgeSourceId, setEdgeSourceId] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<DragState | null>(null);
  const mermaidRootRef = useRef<HTMLDivElement>(null);

  const {
    viewport,
    setViewport,
    transform,
    setContainerRef,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
    zoomIn,
    zoomOut,
    resetZoom,
  } = usePanZoom();

  const nodeMap = useMemo(
    () => new Map(canvas.nodes.map((node) => [node.id, node])),
    [canvas.nodes],
  );
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
      if (action.type === 'move') {
        const node = next.nodes.find((item) => item.id === action.id);
        if (node) Object.assign(node, reverse ? action.from : action.to);
      } else if (action.type === 'resize') {
        const node = next.nodes.find((item) => item.id === action.id);
        if (node) Object.assign(node, reverse ? action.from : action.to);
      } else if (action.type === 'update') {
        const index = next.nodes.findIndex((item) => item.id === action.id);
        if (index !== -1) next.nodes[index] = reverse ? { ...action.from } : { ...action.to };
      } else if (action.type === 'add-node') {
        if (reverse) next.nodes = next.nodes.filter((node) => node.id !== action.node.id);
        else next.nodes.push({ ...action.node });
      } else if (action.type === 'delete-node') {
        if (reverse) {
          next.nodes.push({ ...action.node });
          next.edges.push(...action.edges.map((edge) => ({ ...edge })));
        } else {
          next.nodes = next.nodes.filter((node) => node.id !== action.node.id);
          next.edges = next.edges.filter(
            (edge) => edge.fromNode !== action.node.id && edge.toNode !== action.node.id,
          );
        }
      } else if (action.type === 'delete-nodes') {
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
      } else if (action.type === 'add-edge') {
        if (reverse) next.edges = next.edges.filter((edge) => edge.id !== action.edge.id);
        else next.edges.push({ ...action.edge });
      } else if (action.type === 'delete-edge') {
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
    const viewport = document.querySelector('.canvas-viewport')?.getBoundingClientRect();
    const width = viewport?.width || 800;
    const height = viewport?.height || 500;
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
  }, [canvas.nodes, setViewport]);

  useEffect(() => {
    const timer = setTimeout(() => requestAnimationFrame(fitToView), 100);
    return () => clearTimeout(timer);
  }, [fitToView]);

  // Re-inject mermaid diagrams after every commit — internal re-renders
  // (hover, selection, fit-to-view) re-apply dangerouslySetInnerHTML and wipe
  // injected SVGs. renderMermaidBlocks is idempotent, so this self-heals.
  useEffect(() => {
    if (mermaidRootRef.current) renderMermaidBlocks(mermaidRootRef.current);
  });

  useEffect(() => disposeMermaid, []);

  const selectNode = useCallback((nodeId: string, event?: MouseEvent) => {
    setSelectedNodeIds((current) => {
      if (event?.shiftKey)
        return current.includes(nodeId)
          ? current.filter((id) => id !== nodeId)
          : [...current, nodeId];
      return [nodeId];
    });
  }, []);

  const startNodeDrag = useCallback(
    (node: CanvasNode, event: PointerEvent) => {
      if (!editable || event.button !== 0) return;
      dragRef.current = {
        id: node.id,
        startX: event.clientX,
        startY: event.clientY,
        originX: node.x,
        originY: node.y,
      };
    },
    [editable],
  );

  const finishNodeDrag = useCallback(() => {
    const drag = dragRef.current;
    const resize = resizeRef.current;
    dragRef.current = null;
    resizeRef.current = null;
    if (drag) {
      const node = canvas.nodes.find((item) => item.id === drag.id);
      if (node && (node.x !== drag.originX || node.y !== drag.originY)) {
        commit(
          {
            type: 'move',
            id: drag.id,
            from: { x: drag.originX, y: drag.originY },
            to: { x: node.x, y: node.y },
          },
          canvas,
        );
      }
    }
    if (resize) {
      const node = canvas.nodes.find((item) => item.id === resize.id);
      if (node && (node.width !== resize.originX || node.height !== resize.originY)) {
        commit(
          {
            type: 'resize',
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
      const resize = resizeRef.current;
      const drag = dragRef.current;
      if (!resize && !drag) return;
      const zoom = viewport.zoom || 1;
      setCanvas((current) => {
        const next = cloneData(current);
        const node = next.nodes.find((item) => item.id === (resize || drag)?.id);
        if (!node) return next;
        if (resize) {
          node.width = Math.max(
            80,
            Math.round(resize.originX + (event.clientX - resize.startX) / zoom),
          );
          node.height = Math.max(
            60,
            Math.round(resize.originY + (event.clientY - resize.startY) / zoom),
          );
        } else if (drag) {
          node.x = Math.round(drag.originX + (event.clientX - drag.startX) / zoom);
          node.y = Math.round(drag.originY + (event.clientY - drag.startY) / zoom);
        }
        return next;
      });
    },
    [viewport.zoom],
  );

  const createTextCard = useCallback(() => {
    const node = createTextNode(canvas.nodes, 0, 0);
    if (node.type !== 'text') return;
    commit({ type: 'add-node', node }, { ...cloneData(canvas), nodes: [...canvas.nodes, node] });
    setSelectedNodeIds([node.id]);
    setEditingNodeId(node.id);
    setDraftText(node.text);
  }, [canvas, commit]);

  const createCard = useCallback(
    (factory: (nodes: CanvasNode[], x: number, y: number) => CanvasNode) => {
      const node = factory(canvas.nodes, 0, 0);
      commit({ type: 'add-node', node }, { ...cloneData(canvas), nodes: [...canvas.nodes, node] });
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
      commit({ type: 'add-edge', edge }, { ...cloneData(canvas), edges: [...canvas.edges, edge] });
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
      { type: 'delete-edge', edge },
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
      { type: 'delete-nodes', nodes, edges },
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
    const blob = new Blob([JSON.stringify(serialized, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${editorTitle.toLowerCase().replace(/\s+/g, '-')}.canvas`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [canvas, editorTitle]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if (modifier && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
        return;
      }
      if (modifier && event.key.toLowerCase() === 's') {
        event.preventDefault();
        exportCanvas();
        return;
      }
      if (event.key === 'Escape') {
        setSelectedNodeIds([]);
        setEditingNodeId(null);
        setEdgeSourceId(null);
        setSelectedEdgeId(null);
        return;
      }
      if (editable && (event.key === 'Delete' || event.key === 'Backspace')) {
        event.preventDefault();
        if (selectedEdgeId) deleteSelectedEdge();
        else deleteSelected();
        return;
      }
      if (event.key === '+' || event.key === '=') zoomIn();
      if (event.key === '-') zoomOut();
      if (event.key === '0') resetZoom();
      if (event.key.toLowerCase() === 'f') fitToView();
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
    <div ref={mermaidRootRef} className={`canvas-container ${editable ? 'canvas-editor' : ''}`}>
      {editable && (
        <div className="canvas-editor-banner" role="status">
          <strong>{editorTitle}</strong>
          <span>{history.length ? 'Unsaved changes' : 'Read-only source until exported'}</span>
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
        aria-label={editable ? 'Editable canvas' : 'Interactive canvas with nodes and connections'}
        onPointerDown={handlePointerDown}
        onPointerMove={(event) => {
          handlePointerMove(event);
          updateDraggedNode(event);
        }}
        onPointerUp={() => {
          handlePointerUp();
          finishNodeDrag();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) setSelectedNodeIds([]);
        }}
        onDoubleClick={(event) => {
          if (event.target === event.currentTarget) fitToView();
        }}
        onKeyDown={handleKeyDown}>
        <div className="canvas-world" style={{ transform }}>
          {showGrid && <div className="canvas-background" aria-hidden="true" />}
          <svg className="canvas-edges" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
            <defs>
              {canvas.edges.map((edge) => {
                const color = edgeColor(edge.color);
                return (
                  <g key={edge.id}>
                    <marker
                      id={`arrowhead-${edge.id}`}
                      markerWidth="10"
                      markerHeight="7"
                      refX="9"
                      refY="3.5"
                      orient="auto">
                      <polygon points="0 0, 10 3.5, 0 7" fill={color} />
                    </marker>
                    <marker
                      id={`arrowhead-start-${edge.id}`}
                      markerWidth="10"
                      markerHeight="7"
                      refX="1"
                      refY="3.5"
                      orient="auto">
                      <polygon points="10 0, 0 3.5, 10 7" fill={color} />
                    </marker>
                  </g>
                );
              })}
            </defs>
            {canvas.edges.map((edge) => (
              <CanvasEdge
                key={edge.id}
                edge={edge}
                nodeMap={nodeMap}
                isHighlighted={connectedEdgeIds.has(edge.id)}
                isSelected={selectedEdgeId === edge.id}
                onSelect={editable ? (id) => setSelectedEdgeId(id) : undefined}
              />
            ))}
          </svg>
          {canvas.nodes.map((node, index) => (
            // biome-ignore lint/a11y/noStaticElementInteractions: editor node wrapper owns drag and resize gestures
            <div
              key={node.id}
              onPointerDown={(event) => {
                event.stopPropagation();
                selectNode(node.id, event);
                startNodeDrag(node, event);
              }}
              onDoubleClick={() => {
                if (editable && node.type === 'text') {
                  setEditingNodeId(node.id);
                  setDraftText(node.text);
                }
              }}
              className="canvas-editor-node-wrapper"
              style={{
                position: 'absolute',
                left: node.x,
                top: node.y,
                width: node.width,
                height: node.height,
                zIndex: index + 1,
              }}>
              <CanvasNodeComponent
                node={node}
                assets={canvas.assets}
                notes={canvas.notes}
                zIndex={index + 1}
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
              {editable && editingNodeId === node.id && node.type === 'text' && (
                <textarea
                  // biome-ignore lint/a11y/noAutofocus: focus is required for immediate text-card editing
                  autoFocus
                  className="canvas-editor-textarea"
                  value={draftText}
                  onChange={(event) => setDraftText(event.target.value)}
                  onBlur={() => {
                    const updated = { ...node, text: draftText } as CanvasNode;
                    commit(
                      { type: 'update', id: node.id, from: node, to: updated },
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
              title="Add text card">
              ＋
            </button>
            <button
              type="button"
              className="canvas-toolbar-btn"
              onClick={createFileCard}
              aria-label="Add file card"
              title="Add file card">
              🗎
            </button>
            <button
              type="button"
              className="canvas-toolbar-btn"
              onClick={createLinkCard}
              aria-label="Add link card"
              title="Add link card">
              🔗
            </button>
            <button
              type="button"
              className="canvas-toolbar-btn"
              onClick={createGroupCard}
              aria-label="Add group"
              title="Add group">
              ▭
            </button>
            <button
              type="button"
              onClick={() => {
                const [sourceId] = selectedNodeIds;
                if (!sourceId) return;
                setEdgeSourceId(sourceId);
              }}
              disabled={!selectedNodeIds.length}
              aria-label="Connect edge from selected node"
              title="Connect edge (click source, then target node)">
              ⇄
            </button>
            <button
              type="button"
              className="canvas-toolbar-btn"
              onClick={deleteSelectedEdge}
              disabled={!selectedEdgeId}
              aria-label="Delete selected edge"
              title="Delete selected edge">
              ⌫
            </button>
            <button
              type="button"
              className="canvas-toolbar-btn"
              onClick={deleteSelected}
              disabled={!selectedNodeIds.length}
              aria-label="Delete selected"
              title="Delete selected">
              ⌫
            </button>
            <button
              type="button"
              className="canvas-toolbar-btn"
              onClick={undo}
              disabled={!history.length}
              aria-label="Undo"
              title="Undo">
              ↶
            </button>
            <button
              type="button"
              className="canvas-toolbar-btn"
              onClick={redo}
              disabled={!future.length}
              aria-label="Redo"
              title="Redo">
              ↷
            </button>
            <button
              type="button"
              className="canvas-toolbar-btn"
              onClick={exportCanvas}
              aria-label="Export canvas"
              title="Export canvas">
              ⇩
            </button>
          </>
        )}
        <button
          type="button"
          className="canvas-toolbar-btn"
          onClick={() => setShowGrid((value) => !value)}
          aria-label="Toggle Grid Dots">
          ⚙
        </button>
        <button type="button" className="canvas-toolbar-btn" onClick={zoomIn} aria-label="Zoom in">
          ＋
        </button>
        <button
          type="button"
          className="canvas-toolbar-btn"
          onClick={resetZoom}
          aria-label="Reset zoom (1:1)">
          ◎
        </button>
        <button
          type="button"
          className="canvas-toolbar-btn"
          onClick={fitToView}
          aria-label="Fit to View">
          ⛶
        </button>
        <button
          type="button"
          className="canvas-toolbar-btn"
          onClick={zoomOut}
          aria-label="Zoom out">
          −
        </button>
        <button
          type="button"
          className="canvas-toolbar-btn"
          onClick={() => setShowHelp((value) => !value)}
          aria-label="Help">
          ?
        </button>
      </div>
      {showHelp && (
        <div className="canvas-help-modal">
          <div className="canvas-help-header">
            <h3>Canvas Controls</h3>
            <button type="button" onClick={() => setShowHelp(false)}>
              ×
            </button>
          </div>
          <p>
            {editable
              ? 'Double-click text to edit. Drag cards to move. Shift-click for multi-selection. Select a node, then ⇄ to connect an edge to another node. Click an edge to select it. Delete removes selected cards/edges. Ctrl/Cmd+S exports.'
              : 'Drag to pan. Scroll to zoom. Double-click the background to fit the canvas.'}
          </p>
        </div>
      )}
    </div>
  );
}
