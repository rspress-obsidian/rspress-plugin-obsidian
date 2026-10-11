import { memo } from "react";
import type { CanvasEdgeData, CanvasNode } from "../types.js";
import { resolveColor } from "../utils/color.js";
import { edgeCurve } from "../utils/geometry.js";

/** The marker ids an edge's arrowheads use, unique per renderer instance. */
export function markerIds(prefix: string, edgeId: string): { end: string; start: string } {
	const safe = edgeId.replace(/[^A-Za-z0-9_-]/g, "_");
	return { end: `${prefix}-arrow-${safe}`, start: `${prefix}-arrow-start-${safe}` };
}

export function edgeColor(color: string | undefined): string {
	return resolveColor(color, "var(--canvas-edge-color)");
}

/** Room the label box gets around the curve midpoint; the text wraps inside it. */
const LABEL_BOX = { width: 240, height: 120 };

interface CanvasEdgeProps {
	edge: CanvasEdgeData;
	/**
	 * Only the two endpoints, not the whole node map: a drag then re-renders the
	 * edges that touch the moving card, and every other edge keeps its memo.
	 */
	fromNode: CanvasNode;
	toNode: CanvasNode;
	markerPrefix: string;
	isHighlighted?: boolean;
	isSelected?: boolean;
	onSelect?: (edgeId: string) => void;
}

export const CanvasEdge = memo(function CanvasEdge({
	edge,
	fromNode,
	toNode,
	markerPrefix,
	isHighlighted,
	isSelected,
	onSelect,
}: CanvasEdgeProps) {
	const { start, end, cp1, cp2, mid } = edgeCurve(fromNode, toNode, edge.fromSide, edge.toSide);
	const color = edgeColor(edge.color);
	const hasArrow = edge.toEnd !== "none";
	const hasStartArrow = edge.fromEnd === "arrow";
	const ids = markerIds(markerPrefix, edge.id);
	const pathD = `M ${start.x} ${start.y} C ${cp1.x} ${cp1.y}, ${cp2.x} ${cp2.y}, ${end.x} ${end.y}`;
	const className = [
		"canvas-edge",
		isHighlighted ? "canvas-edge-highlighted" : "",
		isSelected ? "canvas-edge-selected" : "",
	]
		.filter(Boolean)
		.join(" ");

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: edges are selectable in editor mode; role=button conveys interactivity
		<g
			className={className}
			role={onSelect ? "button" : undefined}
			// SVG elements take no focus by default, so a mouse-free user could not
			// reach an edge to select or delete it.
			tabIndex={onSelect ? 0 : undefined}
			aria-label={onSelect ? (edge.label ?? "Canvas edge") : undefined}
			data-edge-id={edge.id}
			onKeyDown={(event) => {
				if (!onSelect) return;
				if (event.key === "Enter" || event.key === " ") {
					event.preventDefault();
					onSelect(edge.id);
				}
			}}
			onClick={(event) => {
				if (onSelect) {
					event.stopPropagation();
					onSelect(edge.id);
				}
			}}
			style={{ cursor: onSelect ? "pointer" : undefined }}
		>
			{/* A wide invisible stroke so a 2px line is a usable click target. */}
			{onSelect && <path d={pathD} stroke="transparent" strokeWidth={14} fill="none" />}
			<path
				className="canvas-edge-path"
				d={pathD}
				stroke={color}
				strokeWidth={isSelected ? 4 : isHighlighted ? 3 : 2}
				strokeOpacity={isSelected || isHighlighted ? 1 : 0.75}
				fill="none"
				markerEnd={hasArrow ? `url(#${ids.end})` : undefined}
				markerStart={hasStartArrow ? `url(#${ids.start})` : undefined}
			/>
			{edge.label && (
				<foreignObject
					x={mid.x - LABEL_BOX.width / 2}
					y={mid.y - LABEL_BOX.height / 2}
					width={LABEL_BOX.width}
					height={LABEL_BOX.height}
					style={{ pointerEvents: "none", overflow: "visible" }}
				>
					<div className="canvas-edge-label-box">
						<span className="canvas-edge-label">{edge.label}</span>
					</div>
				</foreignObject>
			)}
		</g>
	);
});
