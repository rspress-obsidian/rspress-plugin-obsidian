// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createRef } from "react";
import type { GraphNode } from "../../types";
import type { GraphViewHandle } from "../GraphView";
import { graphDataModule, graphNode } from "./graph-fixture";

// The graph runtime reads the path from the document; this test renders a
// panel anchored on /guide.
history.replaceState({}, "", "/guide");

const { mock } = require("bun:test");

// "/guide" is the current route; its neighbours are "/api" and "/", so all three
// are rendered. Hovering "/api" leaves "/" outside the focused neighbourhood.
mock.module("virtual-graph-data", () =>
	graphDataModule(
		[
			graphNode("/guide", "Guide"),
			graphNode("/api", "API"),
			graphNode("/", "Home"),
			graphNode("/tags/x", "#x", "tag"),
		],
		[
			{ source: "/guide", target: "/api" },
			{ source: "/guide", target: "/" },
		],
	),
);

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

interface Node extends GraphNode {
	isCurrent: boolean;
	degree: number;
	tags: string[];
	x: number;
	y: number;
}

/** A node as force-graph hands it to the painters: derived fields plus a position. */
function painted(id: string, label: string, x: number, y: number, isCurrent = false): Node {
	return { ...graphNode(id, label), isCurrent, degree: 0, tags: [], x, y };
}

const current = painted("/guide", "Guide", 0, 0, true);
const neighbour = painted("/api", "API", 10, 0);
const other = painted("/", "Home", 0, 10);

type Painter = (node: Node, ctx: CanvasRenderingContext2D, globalScale: number) => void;
type HoverHandler = (node: Node | null) => void;
type LinkPainter = (link: object) => string | number;

async function mountGraph(
	props: {
		onNodeClick?: (node: GraphNode) => void;
		filters?: {
			query?: string;
			depth?: number;
			showTags?: boolean;
			showOrphans?: boolean;
		};
		groups?: ReadonlyArray<{ query: string; color: string }>;
		display?: {
			arrows: boolean;
			textFadeThreshold: number;
			nodeSize: number;
			linkThickness: number;
		};
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
		onNodeClick: capturedProps.onNodeClick as (node: GraphNode, event?: MouseEvent) => void,
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

		// Below the fade range a plain node paints its dot and nothing else.
		const zoomedOut = emptyRecord();
		nodeCanvasObject(other, createContext(zoomedOut), 0.9);
		expect(zoomedOut.arcs).toEqual([{ x: 0, y: 10, radius: 5 }]);
		expect(zoomedOut.filledText).toEqual([]);
		expect(zoomedOut.strokedText).toEqual([]);

		// At/above 1.4 the label is stroked (outline) and filled.
		const zoomedIn = emptyRecord();
		nodeCanvasObject(other, createContext(zoomedIn), 1.4);
		expect(zoomedIn.strokedText).toEqual(["Home"]);
		expect(zoomedIn.filledText).toEqual(["Home"]);
	});

	test("the text fade threshold shows labels from further out", async () => {
		const { nodeCanvasObject } = await mountGraph({
			display: { arrows: false, textFadeThreshold: 2, nodeSize: 1, linkThickness: 1 },
		});
		const record = emptyRecord();
		nodeCanvasObject(other, createContext(record), 0.5);
		expect(record.filledText).toEqual(["Home"]);
	});

	test("node size, link thickness and arrows follow the display settings", async () => {
		await mountGraph({
			display: { arrows: true, textFadeThreshold: 0, nodeSize: 2, linkThickness: 2 },
		});
		const props = capturedProps ?? {};
		const record = emptyRecord();
		(props.nodeCanvasObject as Painter)(other, createContext(record), 0.5);
		expect(record.arcs[0]?.radius).toBe(10);
		// A node's arrowheads stop at its edge: force-graph reads the radius from nodeVal.
		expect((props.nodeVal as (node: Node) => number)(other)).toBe(100);
		expect(props.linkDirectionalArrowLength).toBeGreaterThan(0);
		const links = (props.graphData as { links: object[] }).links;
		expect((props.linkWidth as LinkPainter)(links[0] as object)).toBe(1.6);
	});

	test("nodes grow with their link count, and the hit area grows with them", async () => {
		const { nodeCanvasObject } = await mountGraph();
		const hub = { ...other, degree: 7 };
		const record = emptyRecord();
		nodeCanvasObject(hub, createContext(record), 0.5);
		expect(record.arcs[0]?.radius).toBe(5 * (1 + 0.25 * 3));

		const hit = emptyRecord();
		const pointerArea = capturedProps?.nodePointerAreaPaint as
			| ((n: Node, c: string, ctx: CanvasRenderingContext2D) => void)
			| undefined;
		if (!pointerArea) throw new Error("GraphView never wired nodePointerAreaPaint");
		pointerArea(hub, "#000001", createContext(hit));
		expect(hit.arcs[0]?.radius).toBe(record.arcs[0]?.radius);
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

	test("applies the force settings to the renderer, and again when a slider moves", async () => {
		const forces = { centerStrength: 0.3, repelStrength: 10, linkStrength: 1, linkDistance: 45 };
		const { rerender } = render(<GraphView width={400} height={300} forces={forces} />);
		await act(async () => {
			await Promise.resolve();
		});

		const applied: Record<string, unknown> = {};
		let reheats = 0;
		const fake = {
			d3Force: (name: string, force?: unknown) => {
				if (force !== undefined) {
					applied[name] = force;
					return undefined;
				}
				return {
					strength: (value: unknown) => {
						applied[`${name}.strength`] = value;
					},
					distance: (value: unknown) => {
						applied[`${name}.distance`] = value;
					},
				};
			},
			d3ReheatSimulation: () => {
				reheats += 1;
			},
		};
		const forceRef = capturedProps?.ref as { current: unknown } | undefined;
		if (!forceRef) throw new Error("GraphView did not attach a ref to the force graph");
		forceRef.current = fake;

		rerender(
			<GraphView
				width={400}
				height={300}
				forces={{ ...forces, repelStrength: 4, linkDistance: 120, centerStrength: 0 }}
			/>,
		);

		expect(applied["charge.strength"]).toBe(-60);
		expect(applied["link.distance"]).toBe(120);
		// Link force scales d3's default 1 / (smaller endpoint degree).
		const strength = applied["link.strength"] as (link: object) => number;
		const graphData = capturedProps?.graphData as { links: object[] } | undefined;
		const links = graphData?.links ?? [];
		expect(strength(links[0] as object)).toBe(1);
		expect(applied.gravity).toBeNull();
		expect(reheats).toBe(1);
	});

	test("a positive center force pulls every node toward the origin, harder the farther out", async () => {
		const forces = { centerStrength: 0, repelStrength: 10, linkStrength: 1, linkDistance: 45 };
		const { rerender } = render(<GraphView width={400} height={300} forces={forces} />);
		await act(async () => {
			await Promise.resolve();
		});
		let gravity: unknown;
		const forceRef = capturedProps?.ref as { current: unknown } | undefined;
		if (!forceRef) throw new Error("GraphView did not attach a ref to the force graph");
		forceRef.current = {
			d3Force: (name: string, force?: unknown) => {
				if (name === "gravity") gravity = force;
				return undefined;
			},
		};
		rerender(<GraphView width={400} height={300} forces={{ ...forces, centerStrength: 0.5 }} />);

		type Body = { x: number; y: number; vx?: number; vy?: number };
		// The custom force d3 calls with alpha, as GraphView registers it.
		const pull = gravity as ((alpha: number) => void) & { initialize: (nodes: Body[]) => void };
		const near: Body = { x: 10, y: -10 };
		const far: Body = { x: 100, y: 0, vx: 1, vy: 0 };
		pull.initialize([near, far]);
		pull(1);
		expect(near.vx).toBeLessThan(0);
		expect(near.vy).toBeGreaterThan(0);
		expect(1 - (far.vx ?? 0)).toBeGreaterThan(-(near.vx ?? 0));
		pull(0);
		expect(far.vy).toBe(0);
	});

	test("only navigable nodes show the pointer cursor", async () => {
		await mountGraph();
		const showPointerCursor = capturedProps?.showPointerCursor as (node: unknown) => boolean;
		expect(showPointerCursor(neighbour)).toBe(true);
		expect(showPointerCursor(graphNode("?draft", "Draft", "unresolved"))).toBe(false);
		expect(showPointerCursor(null)).toBe(false);
	});

	test("the page list opens a plain click in place and leaves modified clicks to the browser", async () => {
		const clicks: string[] = [];
		await mountGraph({ onNodeClick: (node) => clicks.push(node.id) });
		const link = [...document.querySelectorAll("nav[aria-label='Pages in this graph'] a")].find(
			(a) => a.textContent === "API",
		) as HTMLAnchorElement;
		// Record whether GraphView took the click, then stop happy-dom from
		// following the href so later tests stay anchored on /guide.
		const takenByGraph: boolean[] = [];
		const stopNavigation = (event: Event) => {
			takenByGraph.push(event.defaultPrevented);
			event.preventDefault();
		};
		window.addEventListener("click", stopNavigation);
		try {
			fireEvent.click(link, { metaKey: true });
			fireEvent.click(link, { button: 1 });
			expect(clicks).toEqual([]);
			fireEvent.click(link);
		} finally {
			window.removeEventListener("click", stopNavigation);
		}
		expect(takenByGraph).toEqual([false, false, true]);
		expect(clicks).toEqual(["/api"]);
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

	test("reports a click on a navigable node, and ignores an unresolved one", async () => {
		const clicks: string[] = [];
		const { onNodeClick } = await mountGraph({
			onNodeClick: (node) => clicks.push(node.id),
		});

		onNodeClick(neighbour);
		onNodeClick({ ...graphNode("?draft", "Draft", "unresolved") });

		expect(clicks).toEqual(["/api"]);
	});

	test("Cmd/Ctrl-click opens the node in a new tab", async () => {
		const opened: unknown[][] = [];
		const original = window.open;
		window.open = ((...args: unknown[]) => {
			opened.push(args);
			return null;
		}) as typeof window.open;
		try {
			const { onNodeClick } = await mountGraph({ onNodeClick: () => {} });
			onNodeClick(painted("/My Note", "My Note", 0, 0), { metaKey: true } as MouseEvent);
		} finally {
			window.open = original;
		}
		expect(opened).toEqual([["/My%20Note", "_blank", "noopener"]]);
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
