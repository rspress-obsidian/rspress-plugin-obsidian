import { memo, useEffect, useId, useRef } from "react";

export interface CanvasToolbarProps {
	editable: boolean;
	canUndo: boolean;
	canRedo: boolean;
	hasNodeSelection: boolean;
	hasEdgeSelection: boolean;
	showGrid: boolean;
	/** Whether the help dialog is open; it is rendered beside the toolbar. */
	showHelp: boolean;
	onAddText: () => void;
	onAddFile: () => void;
	onAddLink: () => void;
	onAddGroup: () => void;
	/** Arm the connect gesture from the selected card. */
	onConnect: () => void;
	onDeleteEdge: () => void;
	onDeleteSelected: () => void;
	onUndo: () => void;
	onRedo: () => void;
	onExport: () => void;
	onToggleGrid: () => void;
	onZoomIn: () => void;
	onResetZoom: () => void;
	onFitToView: () => void;
	onZoomOut: () => void;
	onToggleHelp: () => void;
	onCloseHelp: () => void;
}

/**
 * The board's control bar — editing tools when editable, view tools always —
 * and its help dialog. Memoised: the renderer re-renders on every pan and zoom
 * frame, which changes none of these props.
 */
export const CanvasToolbar = memo(function CanvasToolbar({
	editable,
	canUndo,
	canRedo,
	hasNodeSelection,
	hasEdgeSelection,
	showGrid,
	showHelp,
	onAddText,
	onAddFile,
	onAddLink,
	onAddGroup,
	onConnect,
	onDeleteEdge,
	onDeleteSelected,
	onUndo,
	onRedo,
	onExport,
	onToggleGrid,
	onZoomIn,
	onResetZoom,
	onFitToView,
	onZoomOut,
	onToggleHelp,
	onCloseHelp,
}: CanvasToolbarProps) {
	const helpButtonRef = useRef<HTMLButtonElement>(null);
	const helpCloseRef = useRef<HTMLButtonElement>(null);
	const helpTitleId = useId();

	// Move focus into the dialog on open so its own keys work without a pointer,
	// and hand focus back to the toggle on close.
	useEffect(() => {
		if (!showHelp) return;
		helpCloseRef.current?.focus();
		return () => helpButtonRef.current?.focus();
	}, [showHelp]);

	return (
		<>
			<div className="canvas-toolbar" role="toolbar" aria-label="Canvas controls">
				{editable && (
					<>
						<button
							type="button"
							className="canvas-toolbar-btn"
							onClick={onAddText}
							aria-label="Add text card"
							title="Add text card"
						>
							＋
						</button>
						<button
							type="button"
							className="canvas-toolbar-btn"
							onClick={onAddFile}
							aria-label="Add file card"
							title="Add file card"
						>
							🗎
						</button>
						<button
							type="button"
							className="canvas-toolbar-btn"
							onClick={onAddLink}
							aria-label="Add link card"
							title="Add link card"
						>
							🔗
						</button>
						<button
							type="button"
							className="canvas-toolbar-btn"
							onClick={onAddGroup}
							aria-label="Add group"
							title="Add group"
						>
							▭
						</button>
						<button
							type="button"
							className="canvas-toolbar-btn"
							onClick={onConnect}
							disabled={!hasNodeSelection}
							aria-label="Connect edge from selected node"
							title="Connect edge (click source, then target node)"
						>
							⇄
						</button>
						<button
							type="button"
							className="canvas-toolbar-btn"
							onClick={onDeleteEdge}
							disabled={!hasEdgeSelection}
							aria-label="Delete selected edge"
							title="Delete selected edge"
						>
							⌫
						</button>
						<button
							type="button"
							className="canvas-toolbar-btn"
							onClick={onDeleteSelected}
							disabled={!hasNodeSelection}
							aria-label="Delete selected"
							title="Delete selected"
						>
							⌫
						</button>
						<button
							type="button"
							className="canvas-toolbar-btn"
							onClick={onUndo}
							disabled={!canUndo}
							aria-label="Undo"
							title="Undo"
						>
							↶
						</button>
						<button
							type="button"
							className="canvas-toolbar-btn"
							onClick={onRedo}
							disabled={!canRedo}
							aria-label="Redo"
							title="Redo"
						>
							↷
						</button>
						<button
							type="button"
							className="canvas-toolbar-btn"
							onClick={onExport}
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
					onClick={onToggleGrid}
					aria-label="Toggle Grid Dots"
					aria-pressed={showGrid}
				>
					⚙
				</button>
				<button
					type="button"
					className="canvas-toolbar-btn"
					onClick={onZoomIn}
					aria-label="Zoom in"
				>
					＋
				</button>
				<button
					type="button"
					className="canvas-toolbar-btn"
					onClick={onResetZoom}
					aria-label="Reset zoom (1:1)"
				>
					◎
				</button>
				<button
					type="button"
					className="canvas-toolbar-btn"
					onClick={onFitToView}
					aria-label="Fit to View"
				>
					⛶
				</button>
				<button
					type="button"
					className="canvas-toolbar-btn"
					onClick={onZoomOut}
					aria-label="Zoom out"
				>
					−
				</button>
				<button
					type="button"
					className="canvas-toolbar-btn"
					ref={helpButtonRef}
					onClick={onToggleHelp}
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
							onCloseHelp();
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
							onClick={onCloseHelp}
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
		</>
	);
});
