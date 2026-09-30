import { useCallback, useEffect, useRef, useState } from "react";

export interface Viewport {
	x: number;
	y: number;
	zoom: number;
}

/** `localStorage` key prefix for a canvas viewport, one per board route. */
export const VIEWPORT_KEY_PREFIX = "rspress-canvas-viewport:";

/** Read a stored viewport, ignoring anything that is not a usable triple. */
export function readStoredViewport(key: string | undefined): Viewport | undefined {
	if (!key) return undefined;
	try {
		const raw = localStorage.getItem(key);
		if (!raw) return undefined;
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const { x, y, zoom } = parsed as Partial<Viewport>;
		if (typeof x !== "number" || typeof y !== "number" || typeof zoom !== "number") {
			return undefined;
		}
		// A stored zoom outside the hook's own range would restore a viewport the
		// user cannot pan or zoom back out of.
		if (!(zoom >= 0.1 && zoom <= 5)) return undefined;
		if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
		return { x, y, zoom };
	} catch {
		// Storage disabled, or a value another version wrote.
		return undefined;
	}
}

function writeStoredViewport(key: string | undefined, viewport: Viewport): void {
	if (!key) return;
	try {
		localStorage.setItem(key, JSON.stringify(viewport));
	} catch {
		// Private mode or a full quota: the canvas still works, it just re-fits.
	}
}

/**
 * The storage key for the board on the current route.
 *
 * The board is identified by the route it is published at: the `.canvas` format
 * carries no view state, and Obsidian keeps the viewport in its own workspace
 * file rather than in the board. Returns `undefined` where there is no document
 * (SSR), so nothing is read or written there.
 */
export function viewportStorageKey(): string | undefined {
	if (typeof window === "undefined") return undefined;
	return `${VIEWPORT_KEY_PREFIX}${window.location.pathname}`;
}

/**
 * Pan and zoom for a canvas, remembering the last position.
 *
 * The last viewport is stored per board, so a reopened canvas appears where the
 * reader left it — the way Obsidian restores a canvas viewport. `onRestore`
 * reports whether a stored viewport was adopted, so the caller can skip its
 * one-off fit.
 */
export function usePanZoom(storageKey?: string, onRestore?: (restored: boolean) => void) {
	const key = storageKey ?? viewportStorageKey();
	const [viewport, setViewport] = useState<Viewport>(
		() =>
			readStoredViewport(key) ?? {
				x: 0,
				y: 0,
				zoom: 1,
			},
	);
	const restoredRef = useRef(false);
	const isPanning = useRef(false);
	const isSpacePressed = useRef(false);
	const lastPointer = useRef({ x: 0, y: 0 });
	const containerRef = useRef<HTMLElement | null>(null);

	// Native wheel handler — bypasses React's passive listener default
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;

		const onWheel = (e: WheelEvent) => {
			// Check if wheel target is inside a scrollable element
			let target = e.target as HTMLElement | null;
			while (target && target !== el) {
				const style = getComputedStyle(target);
				const overflowY = style.overflowY;
				// Only the vertical axis is consulted: this handler zooms on deltaY, so
				// a wide code block that scrolls horizontally must not swallow zoom.
				const isScrollable =
					(overflowY === "auto" || overflowY === "scroll") &&
					target.scrollHeight > target.clientHeight;
				if (isScrollable) {
					// Let the scrollable element handle the wheel event
					return;
				}
				target = target.parentElement;
			}

			e.preventDefault();
			const rect = el.getBoundingClientRect();
			const zoomFactor = e.deltaY > 0 ? -0.1 : 0.1;
			const mouseX = e.clientX - rect.left;
			const mouseY = e.clientY - rect.top;
			setViewport((prev) => {
				const newZoom = Math.max(0.1, Math.min(5, prev.zoom + zoomFactor));
				const scale = newZoom / prev.zoom;
				return {
					x: mouseX - scale * (mouseX - prev.x),
					y: mouseY - scale * (mouseY - prev.y),
					zoom: newZoom,
				};
			});
		};

		el.addEventListener("wheel", onWheel, { passive: false });
		return () => el.removeEventListener("wheel", onWheel);
	}, []);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.code === "Space") {
				isSpacePressed.current = true;
				// Prevent default spacebar scrolling
				if (e.target === document.body) {
					e.preventDefault();
				}
			}
		};

		const handleKeyUp = (e: KeyboardEvent) => {
			if (e.code === "Space") {
				isSpacePressed.current = false;
				isPanning.current = false; // Stop panning if space is released
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		window.addEventListener("keyup", handleKeyUp);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			window.removeEventListener("keyup", handleKeyUp);
		};
	}, []);

	// Ref callback for the viewport element
	const setContainerRef = useCallback((node: HTMLElement | null) => {
		containerRef.current = node;
	}, []);

	const handlePointerDown = useCallback((e: React.PointerEvent) => {
		if (
			e.button === 1 ||
			(e.button === 0 && e.target === e.currentTarget) ||
			(e.button === 0 && isSpacePressed.current)
		) {
			isPanning.current = true;
			lastPointer.current = { x: e.clientX, y: e.clientY };
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		}
	}, []);

	const handlePointerMove = useCallback((e: React.PointerEvent) => {
		if (!isPanning.current) return;
		const dx = e.clientX - lastPointer.current.x;
		const dy = e.clientY - lastPointer.current.y;
		lastPointer.current = { x: e.clientX, y: e.clientY };
		setViewport((prev) => ({
			...prev,
			x: prev.x + dx,
			y: prev.y + dy,
		}));
	}, []);

	const handlePointerUp = useCallback(() => {
		isPanning.current = false;
	}, []);

	// Report the stored viewport exactly once, before the caller's fit effect
	// runs, so a reopened board is not immediately re-fitted.
	// `onRestore` is a notification, not an input: re-running on identity changes
	// would re-report, so only the storage key is a dependency.
	// biome-ignore lint/correctness/useExhaustiveDependencies: notify once per key
	useEffect(() => {
		if (restoredRef.current) return;
		restoredRef.current = true;
		onRestore?.(readStoredViewport(key) !== undefined);
	}, [key]);

	const transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;

	const zoomIn = useCallback(
		() => setViewport((p) => ({ ...p, zoom: Math.min(5, +(p.zoom + 0.1).toFixed(1)) })),
		[],
	);
	const zoomOut = useCallback(
		() => setViewport((p) => ({ ...p, zoom: Math.max(0.1, +(p.zoom - 0.1).toFixed(1)) })),
		[],
	);
	const resetZoom = useCallback(() => setViewport((p) => ({ ...p, zoom: 1, x: 0, y: 0 })), []);

	useEffect(() => {
		if (!restoredRef.current) return;
		writeStoredViewport(key, viewport);
	}, [viewport, key]);

	return {
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
	};
}
