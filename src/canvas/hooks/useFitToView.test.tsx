// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { afterEach, describe, expect, mock, test, vi } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { CanvasData, CanvasNode } from "../types";
import { fitViewport, MAX_FIT_ZOOM, useFitToView } from "./useFitToView";
import { MIN_ZOOM, type Viewport } from "./usePanZoom";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

function card(x: number, y: number, width: number, height: number): CanvasNode {
	return { id: `${x},${y}`, type: "text", x, y, width, height, text: "" };
}

/** A container element that measures `width`×`height` (happy-dom lays nothing out). */
function container(width: number, height: number): HTMLElement {
	const element = document.createElement("div");
	element.getBoundingClientRect = () => ({ width, height }) as DOMRect;
	return element;
}

describe("fitViewport", () => {
	test("centres the board's bounding box, leaving a margin", () => {
		// 400×200 of content in a 480×280 box: 80 px of margin leaves exactly zoom 1.
		const viewport = fitViewport([card(0, 0, 100, 100), card(300, 100, 100, 100)], 480, 280);
		expect(viewport).toEqual({ x: 40, y: 40, zoom: 1 });
	});

	test("never zooms past the fit cap or below the minimum", () => {
		expect(fitViewport([card(0, 0, 10, 10)], 800, 500)?.zoom).toBe(MAX_FIT_ZOOM);
		expect(fitViewport([card(0, 0, 1e9, 1e9)], 800, 500)?.zoom).toBe(MIN_ZOOM);
	});

	test("has nothing to fit without nodes or without a measurable box", () => {
		expect(fitViewport([], 800, 500)).toBeNull();
		expect(fitViewport([card(0, 0, 10, 10)], 0, 500)).toBeNull();
		expect(fitViewport([card(0, 0, 10, 10)], 800, 0)).toBeNull();
	});
});

describe("useFitToView", () => {
	function setup(options: { element: HTMLElement | null; fitOnMount?: boolean }) {
		const setViewport = mock((_viewport: Viewport) => {});
		const canvas: CanvasData = { nodes: [card(0, 0, 100, 100)], edges: [] };
		const view = renderHook(() =>
			useFitToView({
				canvasRef: { current: canvas },
				containerRef: { current: options.element },
				setViewport,
				fitOnMountRef: { current: options.fitOnMount ?? false },
			}),
		);
		return { ...view, setViewport };
	}

	/** Run the 100 ms mount timer, then the animation frame happy-dom runs on a real `setImmediate`. */
	async function elapse(ms: number): Promise<void> {
		act(() => {
			vi.advanceTimersByTime(ms);
		});
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await act(() => promise);
	}

	test("fits the board into the container on demand", () => {
		const { result, setViewport } = setup({ element: container(880, 480) });
		act(() => result.current());
		expect(setViewport).toHaveBeenCalledWith(fitViewport([card(0, 0, 100, 100)], 880, 480));
	});

	test("leaves an unmeasured or missing container alone", () => {
		const unmeasured = setup({ element: container(0, 0) });
		act(() => unmeasured.result.current());
		expect(unmeasured.setViewport).not.toHaveBeenCalled();

		const missing = setup({ element: null });
		act(() => missing.result.current());
		expect(missing.setViewport).not.toHaveBeenCalled();
	});

	test("fits once after mount only when asked to", async () => {
		vi.useFakeTimers();
		const asked = setup({ element: container(800, 500), fitOnMount: true });
		const unasked = setup({ element: container(800, 500) });
		await elapse(150);
		expect(asked.setViewport).toHaveBeenCalledTimes(1);
		expect(unasked.setViewport).not.toHaveBeenCalled();
	});

	test("an unmount before the mount fit cancels it", async () => {
		vi.useFakeTimers();
		const { unmount, setViewport } = setup({ element: container(800, 500), fitOnMount: true });
		unmount();
		await elapse(150);
		expect(setViewport).not.toHaveBeenCalled();
	});
});
