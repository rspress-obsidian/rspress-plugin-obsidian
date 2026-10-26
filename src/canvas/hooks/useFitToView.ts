import type { RefObject } from "react";
import { useCallback, useEffect } from "react";
import type { CanvasData, CanvasNode } from "../types.js";
import { MIN_ZOOM, type Viewport } from "./usePanZoom.js";

/** The zoom a fit never exceeds, so a tiny board is not blown up past legibility. */
export const MAX_FIT_ZOOM = 1.5;
/** Screen pixels left around the board's bounding box on each axis (half per side). */
const FIT_MARGIN = 80;

/**
 * The viewport that centres every node in a `width`×`height` screen box, or
 * `null` when there is nothing to fit or no box to fit it in.
 */
export function fitViewport(nodes: CanvasNode[], width: number, height: number): Viewport | null {
	if (nodes.length === 0 || width <= 0 || height <= 0) return null;
	const bounds = nodes.reduce(
		(result, node) => ({
			minX: Math.min(result.minX, node.x),
			minY: Math.min(result.minY, node.y),
			maxX: Math.max(result.maxX, node.x + node.width),
			maxY: Math.max(result.maxY, node.y + node.height),
		}),
		{ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
	);
	const zoom = Math.max(
		MIN_ZOOM,
		Math.min(
			MAX_FIT_ZOOM,
			Math.min(
				(width - FIT_MARGIN) / Math.max(1, bounds.maxX - bounds.minX),
				(height - FIT_MARGIN) / Math.max(1, bounds.maxY - bounds.minY),
			),
		),
	);
	return {
		x: width / 2 - (bounds.minX + (bounds.maxX - bounds.minX) / 2) * zoom,
		y: height / 2 - (bounds.minY + (bounds.maxY - bounds.minY) / 2) * zoom,
		zoom,
	};
}

export interface FitToViewOptions {
	/** The latest board, whose nodes are fitted. */
	canvasRef: RefObject<CanvasData>;
	/** The viewport element whose box the board is fitted into. */
	containerRef: RefObject<HTMLElement | null>;
	setViewport: (viewport: Viewport) => void;
	/**
	 * Read once after mount: true fits the board shortly after it lays out. A
	 * restored viewport is the reader's own placement and must not be re-fitted.
	 */
	fitOnMountRef: RefObject<boolean>;
}

/** Fit the whole board into view, on demand and once after mount when asked to. */
export function useFitToView({
	canvasRef,
	containerRef,
	setViewport,
	fitOnMountRef,
}: FitToViewOptions): () => void {
	const fitToView = useCallback(() => {
		const rect = containerRef.current?.getBoundingClientRect();
		// No measurable box means the canvas is not laid out (unmounted, `display:
		// none`, or no layout engine). Fitting to a guessed 800x500 there would
		// place the viewport in coordinates the user never sees.
		const next = fitViewport(canvasRef.current.nodes, rect?.width ?? 0, rect?.height ?? 0);
		if (next) setViewport(next);
	}, [canvasRef, containerRef, setViewport]);

	useEffect(() => {
		if (!fitOnMountRef.current) return;
		let frame = 0;
		const timer = setTimeout(() => {
			frame = requestAnimationFrame(() => fitToView());
		}, 100);
		return () => {
			clearTimeout(timer);
			cancelAnimationFrame(frame);
		};
	}, [fitOnMountRef, fitToView]);

	return fitToView;
}
