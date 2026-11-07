/**
 * How drawn graph parts look: node size, label fade, and colours validated for
 * the canvas. Kept out of `GraphView.tsx` because they are plain functions of
 * their arguments — the component passes in the payload and the settings.
 */
import type { ForceGraphNode } from "./deriveGraphViewData.js";
import { labelZoomFor } from "./graph-settings.js";
import type { CanvasColors } from "./palette/colors.js";

/** Radius of a node with no links, in graph units, before the size setting. */
const BASE_RADIUS = 5;
const LARGE_GRAPH_BASE_RADIUS = 4;

/**
 * Visual node radius. Nodes grow with their link count, as in Obsidian; the
 * pointer-area painter and the arrow placement use the same value so the hit
 * region and arrowheads line up with the drawn dot.
 */
export function nodeRadius(degree: number, isLargeGraph: boolean, nodeSize: number): number {
	const base = isLargeGraph ? LARGE_GRAPH_BASE_RADIUS : BASE_RADIUS;
	return base * nodeSize * (1 + 0.25 * Math.log2(1 + degree));
}

/** Label opacity at a zoom level: fades in over the 30% of zoom below the threshold. */
export function labelOpacity(globalScale: number, textFadeThreshold: number): number {
	const fullAt = labelZoomFor(textFadeThreshold);
	const startAt = fullAt * 0.7;
	return Math.min(1, Math.max(0, (globalScale - startAt) / (fullAt - startAt)));
}

/**
 * Accept a group colour only if the runtime can actually paint it: an
 * invalid `fillStyle` is silently ignored by canvas, which would bleed the
 * previous node's colour into this one.
 */
export function safeColor(value: string): string | undefined {
	if (typeof value !== "string" || value.trim() === "") return undefined;
	if (typeof CSS !== "undefined" && typeof CSS.supports === "function") {
		return CSS.supports("color", value) ? value : undefined;
	}
	return value;
}

export function kindColor(node: Pick<ForceGraphNode, "kind">, colors: CanvasColors): string {
	if (node.kind === "tag") return colors.tagNode;
	if (node.kind === "attachment") return colors.attachmentNode;
	if (node.kind === "unresolved") return colors.unresolvedNode;
	return colors.node;
}
