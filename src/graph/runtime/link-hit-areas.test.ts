import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { afterEach, beforeEach, expect, spyOn, test, vi } from "bun:test";
import { createLinkHitAreaPainter, type HitAreaLink } from "./link-hit-areas";

type Matrix = { a: number; b: number; c: number; d: number; e: number; f: number };

interface Stroke {
	from: [number, number];
	to: [number, number];
	color: unknown;
	width: unknown;
}

interface Recorder {
	strokes: Stroke[];
	blits: number;
	clips: number;
	transform: Matrix;
}

/**
 * A 2D context that records the calls the painter makes. The offscreen layers
 * and the shadow canvas each get one. Numeric `setTransform` calls (the
 * identity, for pixel-space copies) are not tracked.
 */
function fakeContext(canvas: { width: number; height: number }, record: Recorder) {
	let path: { from: [number, number]; to: [number, number] } | null = null;
	const ctx = {
		canvas,
		strokeStyle: "",
		lineWidth: 1,
		save() {},
		restore() {},
		clearRect() {},
		clip() {
			record.clips += 1;
		},
		beginPath() {
			path = null;
		},
		moveTo(x: number, y: number) {
			path = { from: [x, y], to: [x, y] };
		},
		lineTo(x: number, y: number) {
			if (path) path.to = [x, y];
		},
		stroke() {
			if (path) record.strokes.push({ ...path, color: ctx.strokeStyle, width: ctx.lineWidth });
		},
		setTransform(matrix: Matrix | number) {
			if (typeof matrix === "object") record.transform = matrix;
		},
		getTransform: () => record.transform,
		getImageData() {},
		drawImage() {
			record.blits += 1;
		},
	};
	return ctx as unknown as CanvasRenderingContext2D;
}

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

let createElementSpy: { mockRestore(): void } | null = null;

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	createElementSpy?.mockRestore();
	createElementSpy = null;
});

/**
 * Let the view hold still long enough for the painter's settle checks to run
 * (happy-dom has no `requestIdleCallback`, so they ride on timers).
 */
function idle() {
	vi.advanceTimersByTime(1000);
}

function setup() {
	// Every layer canvas records into one recorder.
	const layer: Recorder = { strokes: [], blits: 0, clips: 0, transform: IDENTITY };
	const shadow: Recorder = {
		strokes: [],
		blits: 0,
		clips: 0,
		transform: { ...IDENTITY, a: 2, d: 2 },
	};
	const createElement = document.createElement.bind(document);
	createElementSpy = spyOn(document, "createElement").mockImplementation(((tag: string) => {
		if (tag !== "canvas") return createElement(tag);
		const canvas = { width: 300, height: 150, getContext: () => ctx };
		const ctx = fakeContext(canvas, layer);
		return canvas as unknown as HTMLCanvasElement;
	}) as typeof document.createElement);
	const shadowCanvas = { width: 3000, height: 3000 };
	return { layer, shadow, shadowCanvas, shadowCtx: fakeContext(shadowCanvas, shadow) };
}

const b = { x: 10, y: 0 };

/**
 * Two links sharing `b`, one far from both, and one the simulation has not
 * resolved yet (force-graph skips it too).
 */
function links(): HitAreaLink[] {
	b.x = 10;
	const a = { x: 0, y: 0 };
	const c = { x: 10, y: 10 };
	return [
		{ source: a, target: b, __indexColor: "#000001" },
		{ source: b, target: c, __indexColor: "#000002" },
		{ source: { x: 1000, y: 1000 }, target: { x: 1010, y: 1000 }, __indexColor: "#000003" },
		{ source: "/x", target: c, __indexColor: "#000004" },
	];
}

const resting = () => 0.6;

/** force-graph's stroke for each positioned link at `width` px, at zoom 2. */
function shadowStrokes(width: number): Stroke[] {
	return [
		{ from: [0, 0], to: [10, 0], color: "#000001", width },
		{ from: [10, 0], to: [10, 10], color: "#000002", width },
		{ from: [1000, 1000], to: [1010, 1000], color: "#000003", width },
	];
}

test("paints straight onto the shadow canvas until a layer is ready, as force-graph would", () => {
	const { layer, shadow, shadowCtx } = setup();
	const paint = createLinkHitAreaPainter();

	paint(shadowCtx, links(), 2, resting);

	// Hover precision 4 on top of the drawn width, over the zoom, plus a
	// 2-unit pad: (0.6 + 4) / 2 + 2.
	expect(shadow.strokes).toEqual(shadowStrokes(4.3));
	expect(shadow.blits).toBe(0);
	expect(layer.strokes).toEqual([]);
});

test("strokes the layer while idle, then copies it on every repaint", () => {
	const { layer, shadow, shadowCtx } = setup();
	const paint = createLinkHitAreaPainter();
	const view = links();
	paint(shadowCtx, view, 2, resting);
	shadow.strokes.length = 0;

	idle();
	expect(layer.strokes).toEqual(shadowStrokes(4.3));
	// Drawn under the shadow canvas' own transform.
	expect(layer.transform).toEqual(shadow.transform);

	layer.strokes.length = 0;
	paint(shadowCtx, view, 2, resting);
	paint(shadowCtx, view, 2, resting);
	expect(layer.strokes).toEqual([]);
	expect(shadow.strokes).toEqual([]);
	expect(shadow.blits).toBe(2);
});

test("a node moving, a pan or zoom, or a resize drops the layer until the view holds still", () => {
	const { layer, shadow, shadowCanvas, shadowCtx } = setup();
	const paint = createLinkHitAreaPainter();
	const view = links();
	paint(shadowCtx, view, 2, resting);
	idle();

	const changes: Array<() => void> = [
		() => {
			b.x = 11;
		},
		() => {
			shadow.transform = { ...shadow.transform, e: 5 };
		},
		() => {
			shadowCanvas.width = 900;
		},
	];
	for (const change of changes) {
		change();
		shadow.strokes.length = 0;
		paint(shadowCtx, view, 2, resting);
		expect(shadow.strokes.length).toBe(3);

		layer.strokes.length = 0;
		idle();
		expect(layer.strokes.length).toBe(3);
	}
});

test("builds nothing while the view keeps moving, and builds once it holds still", () => {
	const { layer, shadowCtx } = setup();
	const paint = createLinkHitAreaPainter();
	paint(shadowCtx, links(), 2, resting);
	// A simulation or a pan moving the view between every settle check.
	for (let step = 0; step < 6; step += 1) {
		b.x += 1;
		vi.advanceTimersByTime(310);
	}
	expect(layer.strokes).toEqual([]);

	idle();
	expect(layer.strokes.length).toBe(3);
});

test("a disposed painter builds nothing", () => {
	const { layer, shadowCtx } = setup();
	const paint = createLinkHitAreaPainter();
	paint(shadowCtx, links(), 2, resting);
	paint.dispose();
	idle();
	expect(layer.strokes).toEqual([]);
});

test("repaints an emphasised link, and the links its stroke touches, at their own widths", () => {
	const { layer, shadow, shadowCtx } = setup();
	const paint = createLinkHitAreaPainter();
	const view = links();
	// A hovered node: its link emphasised, every other link dimmed.
	const hovered = (link: HitAreaLink) => (link === view[0] ? 1.3 : 0.4);
	paint(shadowCtx, view, 2, hovered);
	idle();
	// The dimmed layer holds every link at the shared width.
	expect(layer.strokes).toEqual(shadowStrokes(4.2));
	shadow.strokes.length = 0;

	paint(shadowCtx, view, 2, hovered);

	// The emphasised link and the one crossing its cells repaint, in link
	// order; the far link keeps the layer's pixels. No clip: Chrome
	// anti-aliases a clipped stroke differently from a full repaint.
	expect(shadow.clips).toBe(0);
	expect(shadow.strokes).toEqual([
		{ from: [0, 0], to: [10, 0], color: "#000001", width: 4.65 },
		{ from: [10, 0], to: [10, 10], color: "#000002", width: 4.2 },
	]);
});

test("keeps a layer for both the resting and the dimmed width", () => {
	const { layer, shadow, shadowCtx } = setup();
	const paint = createLinkHitAreaPainter();
	const view = links();
	const hovered = (link: HitAreaLink) => (link === view[0] ? 1.3 : 0.4);
	paint(shadowCtx, view, 2, resting);
	paint(shadowCtx, view, 2, hovered);
	idle();
	layer.strokes.length = 0;
	shadow.blits = 0;

	paint(shadowCtx, view, 2, resting);
	paint(shadowCtx, view, 2, hovered);
	paint(shadowCtx, view, 2, resting);

	expect(layer.strokes).toEqual([]);
	expect(shadow.blits).toBeGreaterThanOrEqual(3);
});
