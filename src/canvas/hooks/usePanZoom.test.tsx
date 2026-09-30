// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useCallback } from "react";
import { usePanZoom } from "./usePanZoom";

// The hook remembers its viewport per board, so each test starts from a browser
// with no memory of the previous one's pans and zooms.
beforeEach(() => {
	localStorage.clear();
});

function Harness({ onRef }: { onRef?: (el: HTMLElement) => void }) {
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
	} = usePanZoom();

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
		>
			<div data-testid="content" />
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

// happy-dom's WheelEvent drops clientX/clientY from the init dict, so set them
// explicitly and dispatch inside act() to flush the resulting state update.
function wheelOn(target: Element, init: { deltaY: number; clientX: number; clientY: number }) {
	const event = new WheelEvent("wheel", {
		deltaY: init.deltaY,
		bubbles: true,
		cancelable: true,
	});
	Object.defineProperty(event, "clientX", { value: init.clientX });
	Object.defineProperty(event, "clientY", { value: init.clientY });
	act(() => {
		target.dispatchEvent(event);
	});
	return event;
}

function setup(onRef?: (el: HTMLElement) => void) {
	const utils = render(<Harness onRef={onRef} />);
	const viewport = utils.getByTestId("viewport");
	return { ...utils, viewport, content: utils.getByTestId("content") };
}

test("wheel up zooms in and keeps the world point under the cursor anchored", () => {
	const { viewport } = setup();
	const before = viewportState(viewport);
	expect(before).toMatchObject({ x: 0, y: 0, zoom: 1 });

	wheelOn(viewport, { deltaY: -100, clientX: 100, clientY: 50 });

	const after = viewportState(viewport);
	expect(after.zoom).toBeCloseTo(1.1, 6);
	expectCursorAnchored(before, after, 100, 50);
	// translate compensates the scale for a cursor that is not at the origin
	expect(after.x).toBeCloseTo(-10, 6);
	expect(after.y).toBeCloseTo(-5, 6);
});

test("wheel down zooms out around the cursor and reports the shifted transform", () => {
	const { viewport } = setup();
	const before = viewportState(viewport);

	wheelOn(viewport, { deltaY: 100, clientX: 100, clientY: 50 });

	const after = viewportState(viewport);
	expect(after.zoom).toBeCloseTo(0.9, 6);
	expectCursorAnchored(before, after, 100, 50);
	expect(after.transform).toBe(`translate(${after.x}px, ${after.y}px) scale(0.9)`);
});

test("anchors the zoom point when the viewport is already panned", () => {
	const { viewport } = setup();
	fireEvent.pointerDown(viewport, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
	fireEvent.pointerMove(viewport, { clientX: 60, clientY: 40 });
	fireEvent.pointerUp(viewport);
	const before = viewportState(viewport);
	expect(before).toMatchObject({ x: 60, y: 40, zoom: 1 });

	wheelOn(viewport, { deltaY: -100, clientX: 300, clientY: 200 });

	const after = viewportState(viewport);
	expect(after.zoom).toBeCloseTo(1.1, 6);
	expectCursorAnchored(before, after, 300, 200);
});

test("clamps wheel zoom to the 0.1 and 5 limits", () => {
	const { viewport } = setup();

	for (let i = 0; i < 100; i += 1) wheelOn(viewport, { deltaY: -100, clientX: 0, clientY: 0 });
	expect(viewportState(viewport).zoom).toBe(5);

	for (let i = 0; i < 100; i += 1) wheelOn(viewport, { deltaY: 100, clientX: 0, clientY: 0 });
	expect(viewportState(viewport).zoom).toBe(0.1);
});

test("toolbar zoom buttons step by 0.1 and clamp at both ends", () => {
	const { viewport, getByTestId } = setup();
	const zoomInButton = getByTestId("zoom-in");
	const zoomOutButton = getByTestId("zoom-out");

	fireEvent.click(zoomOutButton);
	expect(viewportState(viewport).zoom).toBe(0.9);

	fireEvent.click(zoomInButton);
	fireEvent.click(zoomInButton);
	expect(viewportState(viewport).zoom).toBe(1.1);

	for (let i = 0; i < 60; i += 1) fireEvent.click(zoomInButton);
	expect(viewportState(viewport).zoom).toBe(5);

	for (let i = 0; i < 100; i += 1) fireEvent.click(zoomOutButton);
	expect(viewportState(viewport).zoom).toBe(0.1);
});

test("reset returns the viewport to the origin at 1x", () => {
	const { viewport, getByTestId } = setup();
	fireEvent.pointerDown(viewport, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
	fireEvent.pointerMove(viewport, { clientX: 50, clientY: 20 });
	fireEvent.pointerUp(viewport);
	wheelOn(viewport, { deltaY: -100, clientX: 0, clientY: 0 });
	// zooming anchors the cursor at the origin, so the pan scales with it
	const zoomed = viewportState(viewport);
	expect(zoomed.zoom).toBe(1.1);
	expect(zoomed.x).toBeCloseTo(55, 6);
	expect(zoomed.y).toBeCloseTo(22, 6);

	fireEvent.click(getByTestId("reset"));
	expect(viewportState(viewport)).toMatchObject({
		x: 0,
		y: 0,
		zoom: 1,
		transform: "translate(0px, 0px) scale(1)",
	});
});

test("left-button drag on the empty canvas pans by the pointer delta", () => {
	const { viewport, content } = setup();

	fireEvent.pointerDown(viewport, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
	expect(viewportState(viewport).transform).toBe("translate(0px, 0px) scale(1)");

	fireEvent.pointerMove(viewport, { clientX: 150, clientY: 120 });
	expect(viewportState(viewport)).toMatchObject({ x: 50, y: 20 });
	expect(viewportState(viewport).transform).toBe("translate(50px, 20px) scale(1)");

	// deltas are incremental, not measured from the original grab point
	fireEvent.pointerMove(viewport, { clientX: 160, clientY: 130 });
	expect(viewportState(viewport)).toMatchObject({ x: 60, y: 30 });

	// a press that started on a node must not pan
	fireEvent.pointerUp(viewport);
	fireEvent.pointerDown(content, { button: 0, clientX: 200, clientY: 200, pointerId: 2 });
	fireEvent.pointerMove(viewport, { clientX: 260, clientY: 240 });
	expect(viewportState(viewport)).toMatchObject({ x: 60, y: 30 });
});

test("middle-button drag pans even when the press starts on a node", () => {
	const { viewport, content } = setup();

	fireEvent.pointerDown(content, { button: 1, clientX: 100, clientY: 100, pointerId: 1 });
	fireEvent.pointerMove(viewport, { clientX: 130, clientY: 80 });
	expect(viewportState(viewport)).toMatchObject({ x: 30, y: -20 });
});

test("pointer move without a supporting press never moves the viewport", () => {
	const { viewport } = setup();

	fireEvent.pointerMove(viewport, { clientX: 200, clientY: 200 });
	expect(viewportState(viewport)).toMatchObject({ x: 0, y: 0 });

	// right button is not a pan gesture
	fireEvent.pointerDown(viewport, { button: 2, clientX: 100, clientY: 100, pointerId: 1 });
	fireEvent.pointerMove(viewport, { clientX: 200, clientY: 200 });
	expect(viewportState(viewport)).toMatchObject({ x: 0, y: 0 });
});

test("pointer up ends the drag", () => {
	const { viewport } = setup();

	fireEvent.pointerDown(viewport, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
	fireEvent.pointerMove(viewport, { clientX: 40, clientY: 40 });
	fireEvent.pointerUp(viewport);
	fireEvent.pointerMove(viewport, { clientX: 90, clientY: 90 });

	expect(viewportState(viewport)).toMatchObject({ x: 40, y: 40 });
});

test("holding space pans from a press that starts on a node, and releasing it stops the drag", () => {
	const { viewport, content } = setup();

	fireEvent.keyDown(window, { code: "Space" });
	fireEvent.pointerDown(content, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
	fireEvent.pointerMove(viewport, { clientX: 60, clientY: 30 });
	expect(viewportState(viewport)).toMatchObject({ x: 50, y: 20 });

	fireEvent.keyUp(window, { code: "Space" });
	fireEvent.pointerMove(viewport, { clientX: 100, clientY: 100 });
	expect(viewportState(viewport)).toMatchObject({ x: 50, y: 20 });

	// without space held, a press on a node no longer pans
	fireEvent.pointerDown(content, { button: 0, clientX: 100, clientY: 100, pointerId: 2 });
	fireEvent.pointerMove(viewport, { clientX: 200, clientY: 200 });
	expect(viewportState(viewport)).toMatchObject({ x: 50, y: 20 });
});

test("space keydown swallows page scrolling only when the page body has focus", () => {
	setup();
	const onBody = new KeyboardEvent("keydown", { code: "Space", cancelable: true, bubbles: true });
	document.body.dispatchEvent(onBody);
	expect(onBody.defaultPrevented).toBe(true);

	const onWindow = new KeyboardEvent("keydown", { code: "Space", cancelable: true });
	window.dispatchEvent(onWindow);
	expect(onWindow.defaultPrevented).toBe(false);

	const otherKey = new KeyboardEvent("keydown", { code: "KeyA", cancelable: true, bubbles: true });
	document.body.dispatchEvent(otherKey);
	expect(otherKey.defaultPrevented).toBe(false);
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
	expect(viewportState(viewport).zoom).toBeCloseTo(1.1, 6);
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
			["keydown", "keyup", "wheel"].includes(entry.type),
		);
		expect(panZoomListeners.map((entry) => entry.type).sort()).toEqual([
			"keydown",
			"keyup",
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
		const { viewport } = usePanZoom(storageKey);
		return <div data-testid={id}>{`${viewport.x}|${viewport.y}|${viewport.zoom}`}</div>;
	}

	test("starts from the stored viewport for a key", () => {
		localStorage.setItem("board-a", JSON.stringify({ x: 10, y: 20, zoom: 2 }));
		const { getByTestId } = render(<Stored storageKey="board-a" id="a" />);

		expect(getByTestId("a").textContent).toBe("10|20|2");
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
