// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { afterEach, describe, expect, spyOn, test, vi } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { graphDataModule, graphNode } from "./graph-fixture";

// The graph runtime reads the path from the document; this test renders a
// panel anchored on /guide.
history.replaceState({}, "", "/guide");

const { mock } = require("bun:test");

mock.module("virtual-graph-data", () =>
	graphDataModule(
		[graphNode("/", "Home"), graphNode("/guide", "Guide")],
		[{ source: "/", target: "/guide" }],
	),
);

// Capture the props the plugin passes to react-force-graph-2d so we can
// assert the pointer-area painter is wired and paints the node radius.
let capturedProps: Record<string, unknown> | null = null;

mock.module("react-force-graph-2d", () => ({
	default: (props: Record<string, unknown>) => {
		capturedProps = props;
		return null;
	},
}));

const { default: GraphView } = await import("../GraphView");

describe("GraphView nodePointerAreaPaint", () => {
	afterEach(() => {
		cleanup();
		capturedProps = null;
	});

	test("registers a pointer-area painter matching the visible node radius", async () => {
		// Render GraphView; the lazy `import("react-force-graph-2d")` resolves to
		// the mock, so await the microtask before asserting captured props.
		render(<GraphView width={400} height={300} />);

		await act(async () => {
			await Promise.resolve();
		});

		expect(capturedProps).not.toBeNull();

		// The pointer-area painter is required: without it the default hit radius
		// (`sqrt(nodeVal) * nodeRelSize` at `nodeRelSize={1}`) collapses to ~1px,
		// making hover/click nearly impossible at typical zoom levels.
		expect(typeof capturedProps?.nodePointerAreaPaint).toBe("function");

		// Verify the painter fills a circle of the same radius as the rendered
		// node — the observable hit-testing contract.
		const painter = capturedProps?.nodePointerAreaPaint as (
			node: { x?: number; y?: number; degree: number },
			paintColor: string,
			ctx: CanvasRenderingContext2D,
			globalScale: number,
		) => void;
		expect(painter).toBeTypeOf("function");

		let lastArc: { x: number; y: number; radius: number } = { x: 0, y: 0, radius: 0 };
		let lastFillStyle: unknown = null;

		const ctx = new Proxy(
			{},
			{
				get: (_, prop) => {
					if (prop === "arc") {
						return (x: number, y: number, radius: number) => {
							lastArc = { x, y, radius };
						};
					}
					if (prop === "beginPath" || prop === "fill") {
						return () => {};
					}
					return undefined;
				},
				set: (_, prop, value) => {
					if (prop === "fillStyle") {
						lastFillStyle = value;
					}
					return true;
				},
			},
		) as CanvasRenderingContext2D;

		painter({ x: 12, y: 34, degree: 0 }, "#ff00ff", ctx, 1);

		// An unlinked node's dot has radius 5 in a normal-sized graph.
		expect(lastArc.x).toBe(12);
		expect(lastArc.y).toBe(34);
		expect(lastArc.radius).toBe(5);
		expect(lastFillStyle).toBe("#ff00ff");
	});

	test("paints every link's hit area from the first link's call, and nothing from the others", async () => {
		render(<GraphView width={400} height={300} />);
		await act(async () => {
			await Promise.resolve();
		});
		const painter = capturedProps?.linkPointerAreaPaint as (
			link: object,
			paintColor: string,
			ctx: CanvasRenderingContext2D,
			globalScale: number,
		) => void;
		const graphData = capturedProps?.graphData as { links: object[] } | undefined;
		const firstLink = graphData?.links[0];
		if (!firstLink) throw new Error("GraphView handed the force graph no links");

		// A context that accepts any call and counts them; the painter's cache
		// canvas gets one too (happy-dom has no 2D canvas).
		const calls: string[] = [];
		const recordingContext = (canvas: object) =>
			new Proxy({} as Record<string | symbol, unknown>, {
				get: (_, prop) => {
					if (prop === "canvas") return canvas;
					if (prop === "getTransform") return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
					return (..._args: unknown[]) => {
						calls.push(String(prop));
					};
				},
				set: () => true,
			}) as unknown as CanvasRenderingContext2D;
		const cacheCanvas = { width: 0, height: 0, getContext: () => recordingContext(cacheCanvas) };
		const createElement = document.createElement.bind(document);
		const spy = spyOn(document, "createElement").mockImplementation(((tag: string) =>
			tag === "canvas"
				? (cacheCanvas as unknown as HTMLCanvasElement)
				: createElement(tag)) as typeof document.createElement);
		try {
			const shadow = recordingContext({ width: 400, height: 300 });
			painter({}, "#000002", shadow, 1);
			expect(calls).toEqual([]);

			// The first repaint paints in place; once the view has held still
			// through an idle period, repaints copy the cached layer.
			vi.useFakeTimers();
			try {
				painter(firstLink, "#000001", shadow, 1);
				vi.advanceTimersByTime(1000);
				painter(firstLink, "#000001", shadow, 1);
			} finally {
				vi.useRealTimers();
			}
			expect(calls.filter((name) => name === "drawImage")).toHaveLength(1);
		} finally {
			spy.mockRestore();
		}
	});
});
