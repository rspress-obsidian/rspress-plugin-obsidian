// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import type { GraphViewHandle } from "../GraphView";

// The graph runtime reads the path from the document; this test renders a
// panel anchored on /guide.
history.replaceState({}, "", "/guide");

const { mock } = require("bun:test");

// "/guide" is the current route; its neighbours are "/api" and "/", so all three
// are rendered. Hovering "/api" leaves "/" outside the focused neighbourhood.
const mockGraphData = {
	nodes: [
		{ id: "/guide", label: "Guide", routePath: "/guide" },
		{ id: "/api", label: "API", routePath: "/api" },
		{ id: "/", label: "Home", routePath: "/" },
	],
	links: [
		{ source: "/guide", target: "/api" },
		{ source: "/guide", target: "/" },
	],
};

mock.module("virtual-graph-data", () => ({ graphData: mockGraphData, default: mockGraphData }));

// Capture the props the plugin passes to react-force-graph-2d so we can invoke
// the canvas painters directly — the same technique as
// `GraphViewPointerArea.test.tsx`.
let capturedProps: Record<string, unknown> | null = null;

mock.module("react-force-graph-2d", () => ({
	default: (props: Record<string, unknown>) => {
		capturedProps = props;
		return null;
	},
}));

const { default: GraphView } = await import("../GraphView");

// Light-palette values from `canvas/colors.ts`; the theme observer resolves to
// light in happy-dom (no `dark` class on `<html>`).
const LIGHT = {
	currentNode: "#5b5b5b",
	node: "#9a9a9a",
	nodeHover: "#4f4f4f",
	nodeDimmed: "rgba(154, 154, 154, 0.28)",
	linkHighlight: "rgba(90, 90, 90, 0.85)",
	fallbackLinkDim: "rgba(218, 218, 218, 0.35)",
};

interface PaintRecord {
	arcs: Array<{ x: number; y: number; radius: number }>;
	fillStyles: unknown[];
	strokedText: string[];
	filledText: string[];
}

/** A canvas context stand-in that records only the calls the painters make. */
function createContext(record: PaintRecord): CanvasRenderingContext2D {
	return new Proxy({} as Record<string, unknown>, {
		get: (_, prop) => {
			switch (prop) {
				case "arc":
					return (x: number, y: number, radius: number) => {
						record.arcs.push({ x, y, radius });
					};
				case "strokeText":
					return (text: string) => {
						record.strokedText.push(text);
					};
				case "fillText":
					return (text: string) => {
						record.filledText.push(text);
					};
				case "beginPath":
				case "fill":
				case "closePath":
					return () => {};
				default:
					return undefined;
			}
		},
		set: (_, prop, value) => {
			if (prop === "fillStyle") record.fillStyles.push(value);
			return true;
		},
	}) as unknown as CanvasRenderingContext2D;
}

function emptyRecord(): PaintRecord {
	return { arcs: [], fillStyles: [], strokedText: [], filledText: [] };
}

/** Let queued microtasks and MutationObserver callbacks settle inside `act`. */
function settle(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, 0);
	return promise;
}

interface Node {
	id: string;
	label: string;
	isCurrent: boolean;
	x: number;
	y: number;
}

const current: Node = { id: "/guide", label: "Guide", isCurrent: true, x: 0, y: 0 };
const neighbour: Node = { id: "/api", label: "API", isCurrent: false, x: 10, y: 0 };
const other: Node = { id: "/", label: "Home", isCurrent: false, x: 0, y: 10 };

type Painter = (node: Node, ctx: CanvasRenderingContext2D, globalScale: number) => void;
type HoverHandler = (node: Node | null) => void;
type LinkPainter = (link: object) => string | number;

async function mountGraph(
	props: {
		onNodeClick?: (routePath: string) => void;
		filters?: {
			query?: string;
			depth?: number;
			showTags?: boolean;
			showOrphans?: boolean;
		};
		groups?: ReadonlyArray<{ query: string; color: string }>;
	} = {},
) {
	render(<GraphView width={400} height={300} {...props} />);
	await act(async () => {
		await Promise.resolve();
	});
	if (!capturedProps) throw new Error("react-force-graph-2d never received props");
	return {
		nodeCanvasObject: capturedProps.nodeCanvasObject as Painter,
		nodeColor: capturedProps.nodeColor as (node: { id?: string; isCurrent?: boolean }) => string,
		onNodeHover: capturedProps.onNodeHover as HoverHandler,
		onLinkHover: capturedProps.onLinkHover as HoverHandler,
		onNodeClick: capturedProps.onNodeClick as (node: { routePath?: string }) => void,
		linkColor: capturedProps.linkColor as LinkPainter,
		linkWidth: capturedProps.linkWidth as LinkPainter,
		nodes: (capturedProps.graphData as { nodes: Array<{ id: string }> }).nodes,
		links: (capturedProps.graphData as { links: Array<{ source: string; target: string }> }).links,
	};
}

function linkTo(links: Array<{ source: string; target: string }>, id: string): object {
	const link = links.find((candidate) => candidate.source === id || candidate.target === id);
	if (!link) throw new Error(`no rendered link touches ${id}`);
	return link;
}

describe("GraphView canvas painters", () => {
	afterEach(() => {
		cleanup();
		capturedProps = null;
	});

	test("draws a label only once the graph is zoomed past the threshold", async () => {
		const { nodeCanvasObject } = await mountGraph();

		// Below the threshold a plain node paints its dot and nothing else.
		const zoomedOut = emptyRecord();
		nodeCanvasObject(other, createContext(zoomedOut), 1);
		expect(zoomedOut.arcs).toEqual([{ x: 0, y: 10, radius: 5 }]);
		expect(zoomedOut.filledText).toEqual([]);
		expect(zoomedOut.strokedText).toEqual([]);

		// At/above 1.4 the label is stroked (outline) and filled.
		const zoomedIn = emptyRecord();
		nodeCanvasObject(other, createContext(zoomedIn), 1.4);
		expect(zoomedIn.strokedText).toEqual(["Home"]);
		expect(zoomedIn.filledText).toEqual(["Home"]);
	});

	test("labels the current page even when zoomed out", async () => {
		const { nodeCanvasObject } = await mountGraph();

		const record = emptyRecord();
		nodeCanvasObject(current, createContext(record), 1);

		expect(record.fillStyles[0]).toBe(LIGHT.currentNode);
		expect(record.filledText).toEqual(["Guide"]);
	});

	test("dims nodes outside the hovered node's neighbourhood", async () => {
		const { nodeCanvasObject, onNodeHover } = await mountGraph();

		await act(async () => {
			onNodeHover(neighbour);
		});

		const hovered = emptyRecord();
		nodeCanvasObject(neighbour, createContext(hovered), 1);
		expect(hovered.fillStyles[0]).toBe(LIGHT.nodeHover);

		const dimmed = emptyRecord();
		nodeCanvasObject(other, createContext(dimmed), 1);
		expect(dimmed.fillStyles[0]).toBe(LIGHT.nodeDimmed);

		// The current page keeps its own fill regardless of the hover.
		const active = emptyRecord();
		nodeCanvasObject(current, createContext(active), 1);
		expect(active.fillStyles[0]).toBe(LIGHT.currentNode);

		await act(async () => {
			onNodeHover(null);
		});
		const restored = emptyRecord();
		nodeCanvasObject(other, createContext(restored), 1);
		expect(restored.fillStyles[0]).toBe(LIGHT.node);
	});

	test("highlights links connected to the hovered node and dims the rest", async () => {
		const { onNodeHover, linkColor, linkWidth, links } = await mountGraph();
		const connected = linkTo(links, "/api");
		const disconnected = linkTo(links, "/");

		await act(async () => {
			onNodeHover(neighbour);
		});

		expect(linkColor(connected)).toBe(LIGHT.linkHighlight);
		expect(linkColor(disconnected)).toBe(LIGHT.fallbackLinkDim);
		expect(linkWidth(connected)).toBe(1.3);
		expect(linkWidth(disconnected)).toBe(0.5);
	});

	test("highlights the hovered link itself", async () => {
		const { onLinkHover, linkColor, linkWidth, links } = await mountGraph();
		const hovered = linkTo(links, "/api");
		const rest = linkTo(links, "/");

		await act(async () => {
			onLinkHover(hovered as Node);
		});

		expect(linkColor(hovered)).toBe(LIGHT.linkHighlight);
		expect(linkColor(rest)).toBe(LIGHT.fallbackLinkDim);
		expect(linkWidth(hovered)).toBe(1.5);

		await act(async () => {
			onLinkHover(null);
		});
		expect(linkColor(hovered)).not.toBe(LIGHT.fallbackLinkDim);
	});

	test("drives the force-graph handle from the imperative zoom API", async () => {
		const ref = createRef<GraphViewHandle>();
		render(<GraphView ref={ref} width={400} height={300} />);
		await act(async () => {
			await Promise.resolve();
		});

		const calls: unknown[][] = [];
		const zoom = (...args: unknown[]) => {
			calls.push(args);
			return args.length === 0 ? 1 : undefined;
		};
		const force = {
			zoom,
			zoomToFit: (...args: unknown[]) => calls.push(["zoomToFit", ...args]),
			centerAt: (...args: unknown[]) => calls.push(["centerAt", ...args]),
		};
		// `ref` arrives as a prop on the mocked component (React 19 passes refs to
		// function components), which is how GraphView reaches the force instance.
		const forceRef = capturedProps?.ref as { current: unknown } | undefined;
		if (!forceRef) throw new Error("GraphView did not attach a ref to the force graph");
		forceRef.current = force;

		ref.current?.zoomIn();
		expect(calls.at(-1)).toEqual([1.3, 300]);

		ref.current?.zoomOut();
		expect(calls.at(-1)).toEqual([1 / 1.3, 300]);

		ref.current?.zoomReset();
		expect(calls.at(-1)).toEqual([1, 300]);

		ref.current?.zoomToFit();
		expect(calls.at(-1)).toEqual(["zoomToFit", 300, 16]);

		ref.current?.centerOnCurrent();
		expect(calls.at(-1)).toEqual(["centerAt", 0, 0, 0]);

		expect(ref.current?.getStats()).toMatchObject({ nodes: 3, links: 2 });
	});

	test("reports a node click with the node's route path", async () => {
		const clicks: string[] = [];
		const { onNodeClick } = await mountGraph({
			onNodeClick: (routePath) => clicks.push(routePath),
		});

		onNodeClick({ routePath: "/api" });
		onNodeClick({});

		expect(clicks).toEqual(["/api"]);
	});

	test("repaints with the dark palette when the document theme changes", async () => {
		await mountGraph();

		await act(async () => {
			document.documentElement.classList.add("dark");
			// MutationObserver callbacks are delivered asynchronously.
			await settle();
		});

		// Re-read the prop: the observer re-render hands the force graph a new
		// painter closed over the dark palette.
		const painter = capturedProps?.nodeCanvasObject as Painter;
		const record = emptyRecord();
		painter(other, createContext(record), 1);
		expect(record.fillStyles[0]).toBe("#8a8a8a");

		await act(async () => {
			document.documentElement.classList.remove("dark");
			await settle();
		});
	});

	test("passes the search filter down so only matches render", async () => {
		const { nodes, links } = await mountGraph({ filters: { query: "API" } });

		// The current page always stays; "/" (label "Home") does not match.
		expect(nodes.map((node) => node.id).sort()).toEqual(["/api", "/guide"]);
		expect(links).toHaveLength(1);
	});

	test("paints nodes in the first colour group whose query matches", async () => {
		const { nodeCanvasObject, nodeColor } = await mountGraph({
			groups: [
				{ query: "file:api", color: "#ff0000" },
				{ query: "path:api", color: "#00ff00" },
			],
		});

		const grouped = emptyRecord();
		nodeCanvasObject(neighbour, createContext(grouped), 1);
		expect(grouped.fillStyles[0]).toBe("#ff0000");
		expect(nodeColor(neighbour)).toBe("#ff0000");

		// A node no group claims keeps the palette, and the current page keeps
		// its dedicated colour so "you are here" never hides behind a group.
		const plain = emptyRecord();
		nodeCanvasObject(other, createContext(plain), 1);
		expect(plain.fillStyles[0]).toBe(LIGHT.node);

		const active = emptyRecord();
		nodeCanvasObject(current, createContext(active), 1);
		expect(active.fillStyles[0]).toBe(LIGHT.currentNode);
		expect(nodeColor(current)).toBe(LIGHT.currentNode);
	});
});
