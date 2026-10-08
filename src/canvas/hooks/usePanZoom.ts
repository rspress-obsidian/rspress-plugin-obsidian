import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface Viewport {
	x: number;
	y: number;
	zoom: number;
}

interface Point {
	x: number;
	y: number;
}

/**
 * Zoom limits. The floor is low enough to fit a board several screens wide
 * into a phone-sized viewport; 0.1 left boards wider than ~5,000px unfittable.
 */
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 5;

// `useLayoutEffect` warns during server rendering; the server has no stored
// viewport to adopt anyway.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** `localStorage` key prefix for a canvas viewport, one per board. */
export const VIEWPORT_KEY_PREFIX = "rspress-canvas-viewport:";

/**
 * Screen pixels a press must travel before it becomes a pan and claims pointer
 * capture. Capturing on pointerdown would retarget the compatibility click to
 * the viewport, so every link inside a card would stop navigating.
 */
export const PAN_CAPTURE_THRESHOLD = 3;

/** Elements that own their own drag gesture; a press on them never pans. */
const OWN_GESTURE_SELECTOR =
	"input, textarea, select, video, audio, [contenteditable=''], [contenteditable='true']";

function clampZoom(zoom: number): number {
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

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
		if (!(zoom >= MIN_ZOOM && zoom <= MAX_ZOOM)) return undefined;
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
 * The storage key for one board. The board is identified by the source the
 * viewer loaded (its vault path), not by the page it sits on: two boards
 * embedded in one note must not share a viewport, and the same board keeps its
 * place wherever it is shown — the way Obsidian keeps a canvas viewport per
 * file in its workspace rather than in the board.
 */
export function viewportStorageKey(boardId: string): string {
	return `${VIEWPORT_KEY_PREFIX}${boardId}`;
}

/**
 * Zoom `viewport` by `factor` keeping the world point under `anchor` (in
 * viewport-local screen pixels) where it is.
 */
export function zoomAround(viewport: Viewport, factor: number, anchor: Point): Viewport {
	const zoom = clampZoom(viewport.zoom * factor);
	const scale = zoom / viewport.zoom;
	return {
		x: anchor.x - scale * (anchor.x - viewport.x),
		y: anchor.y - scale * (anchor.y - viewport.y),
		zoom,
	};
}

/**
 * The viewport for a two-finger gesture: the zoom follows the change in finger
 * distance, and the world point that sat under the starting midpoint follows
 * the current midpoint, so the board stays pinned under both fingers. Points
 * are viewport-local screen pixels.
 */
export function pinchViewport(
	start: Viewport,
	startPoints: readonly [Point, Point],
	points: readonly [Point, Point],
): Viewport {
	const startDistance = Math.hypot(
		startPoints[1].x - startPoints[0].x,
		startPoints[1].y - startPoints[0].y,
	);
	const distance = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
	const zoom = clampZoom(start.zoom * (startDistance > 0 ? distance / startDistance : 1));
	const startMid = {
		x: (startPoints[0].x + startPoints[1].x) / 2,
		y: (startPoints[0].y + startPoints[1].y) / 2,
	};
	const mid = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
	const world = { x: (startMid.x - start.x) / start.zoom, y: (startMid.y - start.y) / start.zoom };
	return { x: mid.x - world.x * zoom, y: mid.y - world.y * zoom, zoom };
}

/** Wheel deltas in pixels, whatever unit the device reported them in. */
function wheelPixels(event: WheelEvent): Point {
	const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? window.innerHeight || 800 : 1;
	return { x: event.deltaX * unit, y: event.deltaY * unit };
}

/**
 * The zoom factor for one wheel event: multiplicative and proportional to the
 * delta, so a notch is the same relative step at any zoom and a trackpad pinch
 * (dozens of small `ctrlKey` events) glides instead of jumping the whole range.
 */
export function wheelZoomFactor(deltaY: number, pinch: boolean): number {
	return Math.exp(-deltaY * (pinch ? 0.01 : 0.002));
}

export interface PanZoomOptions {
	/** Full `localStorage` key (see {@link viewportStorageKey}); no persistence without one. */
	storageKey?: string;
	/**
	 * Called once per key after mount, with whether a stored viewport was
	 * adopted, so the caller can skip its first fit.
	 */
	onRestore?: (restored: boolean) => void;
	/**
	 * Whether a bare wheel zooms. A full-page board wants it; a board embedded
	 * in a long note must let the page scroll, and zooms only with Ctrl/⌘ (or a
	 * trackpad pinch) or once the reader has focused it.
	 * @default true
	 */
	wheelZoom?: boolean;
}

interface PanState {
	pointerId: number;
	last: Point;
	origin: Point;
	captured: boolean;
}

interface PinchState {
	start: Viewport;
	startPoints: [Point, Point];
	ids: [number, number];
}

/**
 * Pan and zoom for a canvas: mouse, pen and touch (one finger pans, two pinch),
 * wheel and trackpad, Space+drag, and the remembered viewport.
 *
 * A press pans unless something inside the viewport claimed it first by
 * stopping propagation (an editor card drag, a resize handle, the collapse
 * toggle) or it lands on an element with its own drag gesture (form fields,
 * media controls).
 */
export function usePanZoom(options: PanZoomOptions = {}) {
	const { storageKey, onRestore, wheelZoom = true } = options;
	// Always the default on the first render, on the server and the client
	// alike: the stored viewport is adopted after hydration, so the markup the
	// server rendered and the client's first render agree.
	const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 });
	const viewportRef = useRef(viewport);
	viewportRef.current = viewport;
	const restoredKeyRef = useRef<string | null | undefined>(null);
	const containerRef = useRef<HTMLElement | null>(null);
	const pointers = useRef(new Map<number, Point>());
	const pan = useRef<PanState | null>(null);
	const pinch = useRef<PinchState | null>(null);
	const isSpacePressed = useRef(false);
	const isPointerOver = useRef(false);
	const wheelZoomRef = useRef(wheelZoom);
	wheelZoomRef.current = wheelZoom;
	const onRestoreRef = useRef(onRestore);
	onRestoreRef.current = onRestore;

	const localPoint = useCallback((clientX: number, clientY: number): Point => {
		const rect = containerRef.current?.getBoundingClientRect();
		return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
	}, []);

	const centerPoint = useCallback((): Point => {
		const rect = containerRef.current?.getBoundingClientRect();
		return { x: (rect?.width ?? 0) / 2, y: (rect?.height ?? 0) / 2 };
	}, []);

	// Native wheel handler: React's synthetic wheel listener is passive, and a
	// passive listener cannot stop the page from scrolling.
	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;

		const onWheel = (e: WheelEvent) => {
			const pinchGesture = e.ctrlKey || e.metaKey;
			const focused = el.contains(document.activeElement);
			if (!wheelZoomRef.current && !pinchGesture && !focused) return;
			const delta = wheelPixels(e);
			// A scrollable card body scrolls on its own axis before the board zooms.
			let target = e.target as HTMLElement | null;
			while (!pinchGesture && target && target !== el) {
				const style = getComputedStyle(target);
				const scrollsY =
					(style.overflowY === "auto" || style.overflowY === "scroll") &&
					target.scrollHeight > target.clientHeight;
				const scrollsX =
					(style.overflowX === "auto" || style.overflowX === "scroll") &&
					target.scrollWidth > target.clientWidth;
				if ((scrollsY && delta.y !== 0) || (scrollsX && delta.x !== 0)) return;
				target = target.parentElement;
			}

			e.preventDefault();
			// Horizontal travel pans: a sideways trackpad swipe or Shift+wheel must
			// not read as "zoom in" just because `deltaY` is zero.
			if (!pinchGesture && Math.abs(delta.x) > Math.abs(delta.y)) {
				setViewport((prev) => ({ ...prev, x: prev.x - delta.x }));
				return;
			}
			if (delta.y === 0) return;
			const rect = el.getBoundingClientRect();
			const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
			const factor = wheelZoomFactor(delta.y, pinchGesture);
			setViewport((prev) => zoomAround(prev, factor, anchor));
		};

		const onEnter = () => {
			isPointerOver.current = true;
		};
		const onLeave = () => {
			isPointerOver.current = false;
		};

		el.addEventListener("wheel", onWheel, { passive: false });
		el.addEventListener("pointerenter", onEnter);
		el.addEventListener("pointerleave", onLeave);
		return () => {
			el.removeEventListener("wheel", onWheel);
			el.removeEventListener("pointerenter", onEnter);
			el.removeEventListener("pointerleave", onLeave);
		};
	}, []);

	// Space+drag pans, but only for the board the reader is on: the key is
	// claimed while the pointer is over this viewport or focus is inside it, so
	// Space keeps scrolling the page everywhere else.
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.code !== "Space") return;
			const el = containerRef.current;
			if (!el) return;
			const target = e.target as HTMLElement | null;
			const typing =
				target?.isContentEditable ||
				(target?.tagName && /^(?:input|textarea|select|button)$/i.test(target.tagName));
			if (typing) return;
			const focusedInside = target !== null && el.contains(target);
			if (!isPointerOver.current && !focusedInside) return;
			isSpacePressed.current = true;
			e.preventDefault();
		};

		const handleKeyUp = (e: KeyboardEvent) => {
			if (e.code !== "Space") return;
			isSpacePressed.current = false;
		};

		window.addEventListener("keydown", handleKeyDown);
		window.addEventListener("keyup", handleKeyUp);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			window.removeEventListener("keyup", handleKeyUp);
		};
	}, []);

	const setContainerRef = useCallback((node: HTMLElement | null) => {
		containerRef.current = node;
	}, []);

	const startPinch = useCallback(() => {
		const entries = [...pointers.current.entries()].slice(0, 2);
		const [first, second] = entries;
		if (!first || !second) return;
		pan.current = null;
		pinch.current = {
			start: viewportRef.current,
			startPoints: [first[1], second[1]],
			ids: [first[0], second[0]],
		};
	}, []);

	const handlePointerDown = useCallback(
		(e: ReactPointerEvent) => {
			const target = e.target as Element | null;
			const ownGesture =
				typeof target?.closest === "function" && target.closest(OWN_GESTURE_SELECTOR) !== null;
			if (e.pointerType === "touch") {
				pointers.current.set(e.pointerId, localPoint(e.clientX, e.clientY));
				if (pointers.current.size >= 2) {
					// The second finger turns the gesture into a pinch; claim both now so
					// the browser cannot steal them for its own zoom.
					(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
					startPinch();
					return;
				}
			}
			if (ownGesture && e.button !== 1) return;
			if (e.button !== 0 && e.button !== 1) return;
			// Middle-button presses would otherwise start the browser's autoscroll.
			if (e.button === 1) e.preventDefault();
			pan.current = {
				pointerId: e.pointerId,
				last: { x: e.clientX, y: e.clientY },
				origin: { x: e.clientX, y: e.clientY },
				captured: false,
			};
		},
		[localPoint, startPinch],
	);

	/** Returns whether the move was consumed by a pan or pinch. */
	const handlePointerMove = useCallback(
		(e: ReactPointerEvent): boolean => {
			if (pointers.current.has(e.pointerId)) {
				pointers.current.set(e.pointerId, localPoint(e.clientX, e.clientY));
			}
			const activePinch = pinch.current;
			if (activePinch) {
				const a = pointers.current.get(activePinch.ids[0]);
				const b = pointers.current.get(activePinch.ids[1]);
				if (a && b) setViewport(pinchViewport(activePinch.start, activePinch.startPoints, [a, b]));
				return true;
			}
			const active = pan.current;
			if (!active || active.pointerId !== e.pointerId) return false;
			if (!active.captured) {
				const travelled = Math.max(
					Math.abs(e.clientX - active.origin.x),
					Math.abs(e.clientY - active.origin.y),
				);
				if (travelled < PAN_CAPTURE_THRESHOLD) return false;
				active.captured = true;
				(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
			}
			const dx = e.clientX - active.last.x;
			const dy = e.clientY - active.last.y;
			active.last = { x: e.clientX, y: e.clientY };
			setViewport((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
			return true;
		},
		[localPoint],
	);

	const handlePointerUp = useCallback((e?: ReactPointerEvent) => {
		if (!e) {
			pointers.current.clear();
			pan.current = null;
			pinch.current = null;
			return;
		}
		pointers.current.delete(e.pointerId);
		if (pinch.current?.ids.includes(e.pointerId)) {
			pinch.current = null;
			// The finger still down carries on as a one-finger pan.
			const [remaining] = [...pointers.current.entries()];
			if (remaining) {
				const rect = containerRef.current?.getBoundingClientRect();
				const client = {
					x: remaining[1].x + (rect?.left ?? 0),
					y: remaining[1].y + (rect?.top ?? 0),
				};
				pan.current = { pointerId: remaining[0], last: client, origin: client, captured: true };
			}
			return;
		}
		if (pan.current?.pointerId === e.pointerId) pan.current = null;
	}, []);

	/** Whether a pan or pinch is under way (past the capture threshold). */
	const isGesturing = useCallback(
		() => pinch.current !== null || pan.current?.captured === true,
		[],
	);
	const isSpaceHeld = useCallback(() => isSpacePressed.current, []);

	// Adopt the stored viewport once per key, after hydration and before paint.
	useIsomorphicLayoutEffect(() => {
		if (restoredKeyRef.current === storageKey) return;
		restoredKeyRef.current = storageKey;
		const stored = readStoredViewport(storageKey);
		if (stored) setViewport(stored);
		onRestoreRef.current?.(stored !== undefined);
	}, [storageKey]);

	useEffect(() => {
		if (restoredKeyRef.current !== storageKey) return;
		writeStoredViewport(storageKey, viewport);
	}, [viewport, storageKey]);

	const zoomBy = useCallback(
		(factor: number, anchor?: Point) => {
			const point = anchor ?? centerPoint();
			setViewport((prev) => zoomAround(prev, factor, point));
		},
		[centerPoint],
	);
	const zoomIn = useCallback(() => zoomBy(1.2), [zoomBy]);
	const zoomOut = useCallback(() => zoomBy(1 / 1.2), [zoomBy]);
	// 1:1 around the centre of the view, so the reader stays where they were.
	const resetZoom = useCallback(() => {
		const point = centerPoint();
		setViewport((prev) => zoomAround(prev, 1 / prev.zoom, point));
	}, [centerPoint]);
	const panBy = useCallback((dx: number, dy: number) => {
		setViewport((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
	}, []);

	const transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`;

	return {
		viewport,
		setViewport,
		transform,
		containerRef,
		setContainerRef,
		handlePointerDown,
		handlePointerMove,
		handlePointerUp,
		isGesturing,
		isSpaceHeld,
		zoomBy,
		zoomIn,
		zoomOut,
		resetZoom,
		panBy,
	};
}
