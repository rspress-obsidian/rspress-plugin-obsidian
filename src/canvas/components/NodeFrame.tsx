import type { PointerEvent } from "react";
import { memo } from "react";
import type { CanvasData, CanvasNode } from "../types.js";
import { CanvasNodeComponent, cardLabel } from "./CanvasNode.js";

/** Content inside a card that handles its own click (and so does not select the card). */
const INTERACTIVE_CONTENT =
	"a[href], button, input, textarea, select, summary, label, iframe, video, audio, [contenteditable]";

export interface NodeFrameProps {
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
export const NodeFrame = memo(function NodeFrame({
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
