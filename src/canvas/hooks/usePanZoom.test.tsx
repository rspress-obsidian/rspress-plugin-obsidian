// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useCallback } from "react";
import { renderToString } from "react-dom/server";
import {
	MAX_ZOOM,
	MIN_ZOOM,
	type PanZoomOptions,
	pinchViewport,
	usePanZoom,
	viewportStorageKey,
	wheelZoomFactor,
	zoomAround,
} from "./usePanZoom";

// The hook remembers its viewport per board, so each test starts from a browser
// with no memory of the previous one's pans and zooms.
beforeEach(() => {
	localStorage.clear();
});

function Harness({
	onRef,
	options,
}: {
	onRef?: (el: HTMLElement) => void;
	options?: PanZoomOptions;
}) {
	const {
		viewport,
		transform,
		setContainerRef,
		handlePointerDown,
		handlePointerMove,
		handlePointerUp,
		zoomIn,
		zoomOut,
		resetZoom,
	} = usePanZoom(options);

	// Ref runs before the hook's effects, so the callback can inspect the
	// element that the wheel listener is about to be attached to.
	const attachContainer = useCallback(
		(el: HTMLElement | null) => {
			setContainerRef(el);
			if (el) onRef?.(el);
		},
		[setContainerRef, onRef],
	);

	return (
		<div
			ref={attachContainer}
			data-testid="viewport"
			data-x={viewport.x}
			data-y={viewport.y}
			data-zoom={viewport.zoom}
			data-transform={transform}
			onPointerDown={handlePointerDown}
			onPointerMove={handlePointerMove}
			onPointerUp={handlePointerUp}
			onPointerCancel={handlePointerUp}
		>
			<div data-testid="content" />
			{/* A child that claims its own presses, as an editor card does. */}
			<div data-testid="claimed" onPointerDown={(event) => event.stopPropagation()} />
			<textarea data-testid="field" />
			<button type="button" data-testid="zoom-in" onClick={zoomIn} />
			<button type="button" data-testid="zoom-out" onClick={zoomOut} />
			<button type="button" data-testid="reset" onClick={resetZoom} />
		</div>
	);
}

interface ViewportState {
	x: number;
	y: number;
	zoom: number;
	transform: string;
}

function viewportState(el: HTMLElement): ViewportState {
	return {
		x: Number(el.dataset.x),
		y: Number(el.dataset.y),
		zoom: Number(el.dataset.zoom),
		transform: el.dataset.transform ?? "",
	};
}

// World coordinate that sits under a given screen coordinate for the canvas'
// `translate(x, y) scale(zoom)` transform (transform-origin: 0 0).
function worldUnder(state: ViewportState, screenX: number, screenY: number) {
	return { x: (screenX - state.x) / state.zoom, y: (screenY - state.y) / state.zoom };
}

// The observable contract of cursor-anchored zoom: the same world point stays
// under the same screen point.
function expectCursorAnchored(
	before: ViewportState,
	after: ViewportState,
	screenX: number,
	screenY: number,
) {
	const worldBefore = worldUnder(before, screenX, screenY);
	const worldAfter = worldUnder(after, screenX, screenY);
	expect(worldAfter.x).toBeCloseTo(worldBefore.x, 6);
	expect(worldAfter.y).toBeCloseTo(worldBefore.y, 6);
}

const originalGetComputedStyle = globalThis.getComputedStyle;

afterEach(() => {
	cleanup();
	globalThis.getComputedStyle = originalGetComputedStyle;
});

// happy-dom's WheelEvent drops clientX/clientY and the modifier keys from the
// init dict, so set them explicitly and dispatch inside act() to flush the
// resulting state update.
function wheelOn(
	target: Element,
	init: { deltaY: number; deltaX?: number; clientX: number; clientY: number; ctrlKey?: boolean },
) {
	const event = new WheelEvent("wheel", {
		deltaY: init.deltaY,
		deltaX: init.deltaX ?? 0,
		bubbles: true,
		cancelable: true,
	});
	Object.defineProperty(event, "clientX", { value: init.clientX });
	Object.defineProperty(event, "clientY", { value: init.clientY });
	Object.defineProperty(event, "ctrlKey", { value: init.ctrlKey ?? false });
	act(() => {
		target.dispatchEvent(event);
	});
	return event;
}

function setup(onRef?: (el: HTMLElement) => void, options?: PanZoomOptions) {
	const utils = render(<Harness onRef={onRef} options={options} />);
	const viewport = utils.getByTestId("viewport");
	return { ...utils, viewport, content: utils.getByTestId("content") };
}

function drag(
	viewport: HTMLElement,
	from: Element,
	points: [number, number][],
	init: { button?: number; pointerId?: number; pointerType?: string } = {},
) {
	const pointerId = init.pointerId ?? 1;
	const [first, ...rest] = points;
	if (!first) return;
	fireEvent.pointerDown(from, {
		button: init.button ?? 0,
		clientX: first[0],
		clientY: first[1],
		pointerId,
		pointerType: init.pointerType ?? "mouse",
	});
	for (const [x, y] of rest) fireEvent.pointerMove(viewport, { clientX: x, clientY: y, pointerId });
}

test("wheel zoom is multiplicative and keeps the world point under the cursor", () => {
	const { viewport } = setup();
	const before = viewportState(viewport);
	expect(before).toMatchObject({ x: 0, y: 0, zoom: 1 });

	wheelOn(viewport, { deltaY: -100, clientX: 100, clientY: 50 });
	const after = viewportState(viewport);
	expect(after.zoom).toBeCloseTo(wheelZoomFactor(-100, false), 6);
	expectCursorAnchored(before, after, 100, 50);

	// The same notch is the same relative step at any zoom: zooming out from
	// 0.2 must not halve the scale the way a fixed 0.1 step did.
	const small = zoomAround({ x: 0, y: 0, zoom: 0.2 }, wheelZoomFactor(100, false), { x: 0, y: 0 });
	expect(small.zoom / 0.2).toBeCloseTo(wheelZoomFactor(100, false), 6);
});

test("a larger wheel delta zooms further, and a trackpad pinch is finer per event", () => {
	expect(wheelZoomFactor(-200, false)).toBeGreaterThan(wheelZoomFactor(-100, false));
	// A pinch sends many tiny ctrlKey events; each must be a small step.
	expect(wheelZoomFactor(-2, true)).toBeLessThan(1.05);
	expect(wheelZoomFactor(100, false)).toBeLessThan(1);
});

test("a horizontal scroll pans instead of zooming in", () => {
	const { viewport } = setup();
	wheelOn(viewport, { deltaY: 0, deltaX: 40, clientX: 0, clientY: 0 });
	expect(viewportState(viewport)).toMatchObject({ x: -40, y: 0, zoom: 1 });
});

test("anchors the zoom point when the viewport is already panned", () => {
	const { viewport } = setup();
	drag(viewport, viewport, [
		[0, 0],
		[60, 40],
	]);
	fireEvent.pointerUp(viewport, { pointerId: 1 });
	const before = viewportState(viewport);
	expect(before).toMatchObject({ x: 60, y: 40, zoom: 1 });

	wheelOn(viewport, { deltaY: -100, clientX: 300, clientY: 200 });
	expectCursorAnchored(before, viewportState(viewport), 300, 200);
});

test("clamps wheel zoom to the hook's limits", () => {
	const { viewport } = setup();
	for (let i = 0; i < 100; i += 1) wheelOn(viewport, { deltaY: -500, clientX: 0, clientY: 0 });
	expect(viewportState(viewport).zoom).toBe(MAX_ZOOM);
	for (let i = 0; i < 100; i += 1) wheelOn(viewport, { deltaY: 500, clientX: 0, clientY: 0 });
	expect(viewportState(viewport).zoom).toBe(MIN_ZOOM);
});

test("an embedded board lets a bare wheel scroll the page", () => {
	const { viewport } = setup(undefined, { wheelZoom: false });
	const bare = wheelOn(viewport, { deltaY: -100, clientX: 0, clientY: 0 });
	expect(bare.defaultPrevented).toBe(false);
	expect(viewportState(viewport).zoom).toBe(1);

	const pinch = wheelOn(viewport, { deltaY: -100, clientX: 0, clientY: 0, ctrlKey: true });
	expect(pinch.defaultPrevented).toBe(true);
	expect(viewportState(viewport).zoom).toBeGreaterThan(1);

	// Once the reader has clicked into the board, a bare wheel zooms it.
	act(() => viewport.focus());
	wheelOn(viewport, { deltaY: -100, clientX: 0, clientY: 0 });
	expect(viewportState(viewport).zoom).toBeGreaterThan(wheelZoomFactor(-100, true));
});

test("toolbar zoom buttons step multiplicatively and clamp at both ends", () => {
	const { viewport, getByTestId } = setup();
	fireEvent.click(getByTestId("zoom-out"));
	expect(viewportState(viewport).zoom).toBeCloseTo(1 / 1.2, 6);
	fireEvent.click(getByTestId("zoom-in"));
	fireEvent.click(getByTestId("zoom-in"));
	expect(viewportState(viewport).zoom).toBeCloseTo(1.2, 6);
	for (let i = 0; i < 60; i += 1) fireEvent.click(getByTestId("zoom-in"));
	expect(viewportState(viewport).zoom).toBe(MAX_ZOOM);
	for (let i = 0; i < 100; i += 1) fireEvent.click(getByTestId("zoom-out"));
	expect(viewportState(viewport).zoom).toBe(MIN_ZOOM);
});

test("reset returns to 1:1 around the view centre, keeping the reader's place", () => {
	const { viewport, getByTestId } = setup();
	drag(viewport, viewport, [
		[0, 0],
		[50, 20],
	]);
	fireEvent.pointerUp(viewport, { pointerId: 1 });
	wheelOn(viewport, { deltaY: -100, clientX: 0, clientY: 0 });
	expect(viewportState(viewport).zoom).not.toBe(1);

	// happy-dom lays nothing out, so the view centre is (0, 0).
	fireEvent.click(getByTestId("reset"));
	const reset = viewportState(viewport);
	expect(reset.zoom).toBe(1);
	expect(reset.x).toBeCloseTo(50, 6);
	expect(reset.y).toBeCloseTo(20, 6);
});

test("a drag pans from the background and from any card that does not claim the press", () => {
	const { viewport, content } = setup();
	drag(viewport, viewport, [
		[100, 100],
		[150, 120],
		[160, 130],
	]);
	// deltas are incremental, not measured from the original grab point
	expect(viewportState(viewport)).toMatchObject({ x: 60, y: 30 });
	fireEvent.pointerUp(viewport, { pointerId: 1 });

	// A read-only card passes its press on, so the board pans from it too.
	drag(viewport, content, [
		[200, 200],
		[260, 240],
	]);
	expect(viewportState(viewport)).toMatchObject({ x: 120, y: 70 });
});

test("a press a child claims, or one inside a text field, never pans", () => {
	const { viewport, getByTestId } = setup();
	drag(viewport, getByTestId("claimed"), [
		[0, 0],
		[50, 50],
	]);
	fireEvent.pointerUp(viewport, { pointerId: 1 });
	drag(viewport, getByTestId("field"), [
		[0, 0],
		[50, 50],
	]);
	expect(viewportState(viewport)).toMatchObject({ x: 0, y: 0 });
});

test("a press shorter than the capture threshold is a click, not a pan", () => {
	const { viewport, content } = setup();
	drag(viewport, content, [
		[10, 10],
		[11, 12],
	]);
	expect(viewportState(viewport)).toMatchObject({ x: 0, y: 0 });
});

test("middle-button drag pans even from a text field", () => {
	const { viewport, getByTestId } = setup();
	drag(
		viewport,
		getByTestId("field"),
		[
			[100, 100],
			[130, 80],
		],
		{ button: 1 },
	);
	expect(viewportState(viewport)).toMatchObject({ x: 30, y: -20 });
});

test("pointer move without a supporting press never moves the viewport", () => {
	const { viewport } = setup();
	fireEvent.pointerMove(viewport, { clientX: 200, clientY: 200, pointerId: 1 });
	expect(viewportState(viewport)).toMatchObject({ x: 0, y: 0 });
	// right button is not a pan gesture
	drag(
		viewport,
		viewport,
		[
			[100, 100],
			[200, 200],
		],
		{ button: 2 },
	);
	expect(viewportState(viewport)).toMatchObject({ x: 0, y: 0 });
});

test("pointer up and pointer cancel end the drag", () => {
	const { viewport } = setup();
	drag(viewport, viewport, [
		[0, 0],
		[40, 40],
	]);
	fireEvent.pointerUp(viewport, { pointerId: 1 });
	fireEvent.pointerMove(viewport, { clientX: 90, clientY: 90, pointerId: 1 });
	expect(viewportState(viewport)).toMatchObject({ x: 40, y: 40 });

	drag(viewport, viewport, [
		[0, 0],
		[10, 0],
	]);
	fireEvent.pointerCancel(viewport, { pointerId: 1 });
	fireEvent.pointerMove(viewport, { clientX: 90, clientY: 90, pointerId: 1 });
	expect(viewportState(viewport)).toMatchObject({ x: 50, y: 40 });
});

test("one finger pans and two fingers pinch-zoom around their midpoint", () => {
	const { viewport } = setup();
	const touch = { pointerType: "touch" };
	fireEvent.pointerDown(viewport, {
		...touch,
		pointerId: 1,
		button: 0,
		clientX: 100,
		clientY: 100,
	});
	fireEvent.pointerMove(viewport, { ...touch, pointerId: 1, clientX: 120, clientY: 100 });
	expect(viewportState(viewport)).toMatchObject({ x: 20, y: 0, zoom: 1 });

	// The second finger turns the gesture into a pinch.
	fireEvent.pointerDown(viewport, {
		...touch,
		pointerId: 2,
		button: 0,
		clientX: 220,
		clientY: 100,
	});
	fireEvent.pointerMove(viewport, { ...touch, pointerId: 2, clientX: 320, clientY: 100 });
	const pinched = viewportState(viewport);
	// Fingers 100px apart, now 200px: twice the zoom.
	expect(pinched.zoom).toBeCloseTo(2, 6);
	// The world point under the starting midpoint (170, 100) follows the new
	// midpoint (220, 100).
	const world = { x: (170 - 20) / 1, y: (100 - 0) / 1 };
	expect(pinched.x + world.x * pinched.zoom).toBeCloseTo(220, 6);
	expect(pinched.y + world.y * pinched.zoom).toBeCloseTo(100, 6);
});

test("pinch maths keeps both fingers on the same world points", () => {
	const start = { x: 10, y: -20, zoom: 0.5 };
	const startPoints = [
		{ x: 100, y: 100 },
		{ x: 200, y: 200 },
	] as const;
	const points = [
		{ x: 50, y: 50 },
		{ x: 350, y: 350 },
	] as const;
	const next = pinchViewport(start, startPoints, points);
	expect(next.zoom).toBeCloseTo(1.5, 6);
	const worldOf = (v: typeof start, p: { x: number; y: number }) => ({
		x: (p.x - v.x) / v.zoom,
		y: (p.y - v.y) / v.zoom,
	});
	for (const index of [0, 1] as const) {
		const before = worldOf(start, startPoints[index]);
		const after = worldOf(next, points[index]);
		expect(after.x).toBeCloseTo(before.x, 6);
		expect(after.y).toBeCloseTo(before.y, 6);
	}
});

test("Space pans only for the board under the pointer or holding focus", () => {
	const { viewport, content } = setup();
	const elsewhere = new KeyboardEvent("keydown", {
		code: "Space",
		cancelable: true,
		bubbles: true,
	});
	document.body.dispatchEvent(elsewhere);
	// The page keeps its Space-to-scroll.
	expect(elsewhere.defaultPrevented).toBe(false);

	fireEvent.pointerEnter(viewport);
	const over = new KeyboardEvent("keydown", { code: "Space", cancelable: true, bubbles: true });
	document.body.dispatchEvent(over);
	expect(over.defaultPrevented).toBe(true);
	fireEvent.keyUp(window, { code: "Space" });
	fireEvent.pointerLeave(viewport);

	const otherKey = new KeyboardEvent("keydown", { code: "KeyA", cancelable: true, bubbles: true });
	document.body.dispatchEvent(otherKey);
	expect(otherKey.defaultPrevented).toBe(false);

	act(() => viewport.focus());
	const focused = new KeyboardEvent("keydown", { code: "Space", cancelable: true, bubbles: true });
	viewport.dispatchEvent(focused);
	expect(focused.defaultPrevented).toBe(true);
	expect(content).toBeTruthy();
});

test("wheel over a scrollable child scrolls it instead of zooming the canvas", () => {
	const { viewport, content } = setup();
	content.style.overflowY = "auto";
	Object.defineProperty(content, "scrollHeight", { value: 400, configurable: true });
	Object.defineProperty(content, "clientHeight", { value: 100, configurable: true });
	globalThis.getComputedStyle = ((el: Element) => ({
		overflowY: (el as HTMLElement).style.overflowY,
		overflowX: (el as HTMLElement).style.overflowX,
	})) as unknown as typeof getComputedStyle;

	const overOverflowingChild = wheelOn(content, { deltaY: -100, clientX: 10, clientY: 10 });
	expect(viewportState(viewport)).toMatchObject({ zoom: 1 });
	expect(overOverflowingChild.defaultPrevented).toBe(false);

	// content that cannot scroll falls through to the canvas zoom
	content.style.overflowY = "hidden";
	const overClippedChild = wheelOn(content, { deltaY: -100, clientX: 10, clientY: 10 });
	expect(viewportState(viewport).zoom).toBeCloseTo(wheelZoomFactor(-100, false), 6);
	expect(overClippedChild.defaultPrevented).toBe(true);
});

test("removes every window and container listener when it unmounts", () => {
	interface Registration {
		target: EventTarget;
		type: string;
		listener: unknown;
	}
	const added: Registration[] = [];
	const removed: Registration[] = [];
	const windowAddDescriptor = Object.getOwnPropertyDescriptor(window, "addEventListener");
	const windowRemoveDescriptor = Object.getOwnPropertyDescriptor(window, "removeEventListener");

	const record =
		(
			records: Registration[],
			target: EventTarget,
			forward: (type: string, listener: unknown, options: unknown) => void,
		) =>
		(type: string, listener: unknown, options: unknown) => {
			records.push({ target, type, listener });
			forward(type, listener, options);
		};

	// happy-dom gives window and each element their own listener methods, so the
	// spies have to sit on the instances the hook actually registers against.
	const originalWindowAdd = window.addEventListener.bind(window);
	const originalWindowRemove = window.removeEventListener.bind(window);
	Object.defineProperty(window, "addEventListener", {
		configurable: true,
		writable: true,
		value: record(added, window, originalWindowAdd as (t: string, l: unknown, o: unknown) => void),
	});
	Object.defineProperty(window, "removeEventListener", {
		configurable: true,
		writable: true,
		value: record(
			removed,
			window,
			originalWindowRemove as (t: string, l: unknown, o: unknown) => void,
		),
	});

	const instrumentElement = (el: HTMLElement) => {
		const originalAdd = el.addEventListener.bind(el);
		const originalRemove = el.removeEventListener.bind(el);
		Object.defineProperty(el, "addEventListener", {
			configurable: true,
			writable: true,
			value: record(added, el, originalAdd as (t: string, l: unknown, o: unknown) => void),
		});
		Object.defineProperty(el, "removeEventListener", {
			configurable: true,
			writable: true,
			value: record(removed, el, originalRemove as (t: string, l: unknown, o: unknown) => void),
		});
	};

	try {
		const { viewport, unmount } = setup(instrumentElement);
		const panZoomListeners = added.filter((entry) =>
			["keydown", "keyup", "wheel", "pointerenter", "pointerleave"].includes(entry.type),
		);
		expect(panZoomListeners.map((entry) => entry.type).sort()).toEqual([
			"keydown",
			"keyup",
			"pointerenter",
			"pointerleave",
			"wheel",
		]);
		expect(panZoomListeners.find((entry) => entry.type === "wheel")?.target).toBe(viewport);
		expect(panZoomListeners.find((entry) => entry.type === "keydown")?.target).toBe(window);

		unmount();

		const stillAttached = added.filter(
			(entry) =>
				!removed.some(
					(gone) =>
						gone.target === entry.target &&
						gone.type === entry.type &&
						gone.listener === entry.listener,
				),
		);
		expect(stillAttached).toEqual([]);
	} finally {
		if (windowAddDescriptor) Object.defineProperty(window, "addEventListener", windowAddDescriptor);
		if (windowRemoveDescriptor)
			Object.defineProperty(window, "removeEventListener", windowRemoveDescriptor);
	}
});

describe("usePanZoom storage", () => {
	function Stored({ storageKey, id }: { storageKey?: string; id: string }) {
		const { viewport, transform } = usePanZoom({ storageKey });
		return (
			<div
				data-testid={id}
				style={{ transform }}
			>{`${viewport.x}|${viewport.y}|${viewport.zoom}`}</div>
		);
	}

	test("restores the stored viewport for a key once mounted", () => {
		localStorage.setItem("board-a", JSON.stringify({ x: 10, y: 20, zoom: 2 }));
		const { getByTestId } = render(<Stored storageKey="board-a" id="a" />);
		expect(getByTestId("a").textContent).toBe("10|20|2");
	});

	test("renders the default viewport on the server, so hydration matches", () => {
		localStorage.setItem("board-ssr", JSON.stringify({ x: 10, y: 20, zoom: 2 }));
		const html = renderToString(<Stored storageKey="board-ssr" id="ssr" />);
		expect(html).toContain("0|0|1");
		expect(html).toContain("translate(0px, 0px) scale(1)");
	});

	test("keys the viewport by board, so two boards on one page keep their own", () => {
		expect(viewportStorageKey("A.canvas")).not.toBe(viewportStorageKey("B.canvas"));
		localStorage.setItem(viewportStorageKey("A.canvas"), JSON.stringify({ x: 1, y: 1, zoom: 1 }));
		localStorage.setItem(viewportStorageKey("B.canvas"), JSON.stringify({ x: 2, y: 2, zoom: 2 }));
		const { getByTestId } = render(
			<>
				<Stored storageKey={viewportStorageKey("A.canvas")} id="A" />
				<Stored storageKey={viewportStorageKey("B.canvas")} id="B" />
			</>,
		);
		expect(getByTestId("A").textContent).toBe("1|1|1");
		expect(getByTestId("B").textContent).toBe("2|2|2");
	});

	test("ignores a stored zoom outside the hook's own range", () => {
		// Restoring zoom 50 would leave the reader unable to zoom back out.
		localStorage.setItem("board-b", JSON.stringify({ x: 10, y: 20, zoom: 50 }));
		const { getByTestId } = render(<Stored storageKey="board-b" id="b" />);
		expect(getByTestId("b").textContent).toBe("0|0|1");
	});

	test("ignores a stored value that is not a triple", () => {
		localStorage.setItem("board-c", "{oops");
		localStorage.setItem("board-d", '{"x":1,"y":2}');
		const { getByTestId } = render(
			<>
				<Stored storageKey="board-c" id="c" />
				<Stored storageKey="board-d" id="d" />
			</>,
		);
		expect(getByTestId("c").textContent).toBe("0|0|1");
		expect(getByTestId("d").textContent).toBe("0|0|1");
	});
});
