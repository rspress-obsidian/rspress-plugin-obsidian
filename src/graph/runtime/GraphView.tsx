import {
	Component,
	type ElementType,
	forwardRef,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { graphPayload } from "virtual-graph-data";
import { encodeRoutePath } from "../../shared/route-path.js";
import { navigation, useNavigateTo, usePathname } from "../../shared/usePathname.js";
import { decodeGraphPayload } from "../graph-payload.js";
import type { GraphNode, GraphPayload, GraphViewGroup } from "../types.js";
import {
	createGraphIndex,
	deriveGraphViewData,
	type ForceGraphLink,
	type ForceGraphNode,
	type GraphIndex,
	type GraphViewFilters,
	normalizeClientRoutePath,
} from "./deriveGraphViewData.js";
import { matchesGraphQuery, parseGraphQuery } from "./graph-query.js";
import {
	CHARGE_PER_REPEL,
	DEFAULT_DISPLAY_SETTINGS,
	DEFAULT_FORCE_SETTINGS,
	type GraphDisplaySettings,
	type GraphForceSettings,
	labelZoomFor,
	MAX_CENTER_PULL,
} from "./graph-settings.js";
import {
	type CanvasColors,
	DARK_COLORS,
	FONT_STACK,
	type GraphViewColors,
	LIGHT_COLORS,
	mergeColors,
} from "./palette/colors.js";

export type { GraphViewFilters } from "./deriveGraphViewData.js";
export type { GraphViewColors } from "./palette/colors.js";

const indexByPayload = new WeakMap<GraphPayload, GraphIndex>();

/**
 * The payload ships as index pairs; decode and index it once per payload
 * object, shared by every graph on the page (the panel and a sidebar graph).
 */
function graphIndexFor(payload: GraphPayload): GraphIndex {
	let index = indexByPayload.get(payload);
	if (!index) {
		index = createGraphIndex(decodeGraphPayload(payload));
		indexByPayload.set(payload, index);
	}
	return index;
}

interface GraphViewProps {
	width: number;
	height: number;
	/** Replaces the default navigation (router for pages, document load for files). */
	onNodeClick?: (node: GraphNode) => void;
	onNodeHoverChange?: (label: string | null, x: number, y: number) => void;
	colors?: GraphViewColors;
	/** Which nodes to show: search, depth, kind toggles, link directions. */
	filters?: GraphViewFilters;
	/** Colour groups; a node renders in the first group whose query matches. */
	groups?: readonly GraphViewGroup[];
	display?: GraphDisplaySettings;
	forces?: GraphForceSettings;
	/** Note text by node id for `content:`/`line:`/`section:` queries, once loaded. */
	searchText?: ReadonlyMap<string, string>;
	/** Bump to play the timelapse: nodes appear in file-creation order. */
	timelapseRun?: number;
	onTimelapseEnd?: () => void;
}

interface D3Force {
	strength?: (value: number | ((link: unknown) => number)) => unknown;
	distance?: (value: number) => unknown;
}

/** A custom d3 force: called every tick, handed the node array on (re)start. */
interface CustomForce {
	(alpha: number): void;
	initialize: (nodes: Array<{ x?: number; y?: number; vx?: number; vy?: number }>) => void;
}

interface ForceGraphHandleRef {
	d3ReheatSimulation?: () => void;
	d3Force?: (forceName: string, forceFn?: D3Force | CustomForce | null) => D3Force | undefined;
	zoom?: {
		(): number;
		(scale: number, durationMs?: number): void;
	};
	zoomToFit?: (durationMs?: number, padding?: number) => void;
	centerAt?: (x?: number, y?: number, durationMs?: number) => void;
}

function isDarkMode(): boolean {
	if (typeof document === "undefined") return false;
	const html = document.documentElement;
	return (
		html.classList.contains("dark") ||
		html.getAttribute("data-theme") === "dark" ||
		html.closest("[data-theme='dark']") !== null
	);
}

function useTheme(): boolean {
	// Seed `false` so the first client render matches the server output (where
	// `document` does not exist). The effect reads the real theme after mount and
	// the observer keeps it in sync, so hydration never mismatches in dark mode.
	const [dark, setDark] = useState(false);

	useEffect(() => {
		setDark(isDarkMode());
		const observer = new MutationObserver(() => {
			setDark(isDarkMode());
		});
		observer.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class", "data-theme"],
		});
		return () => observer.disconnect();
	}, []);

	return dark;
}

/**
 * The URL a node opens. Pages and tag pages are routes (encoded per segment);
 * attachment ids are already the encoded file URL. Both get the site base,
 * which plain `<a href>`s and document loads need and the router adds itself.
 */
export function nodeHref(
	node: Pick<GraphNode, "id" | "kind">,
	base = graphPayload.base || "/",
): string {
	const path = node.kind === "attachment" ? node.id : encodeRoutePath(node.id);
	return `${base.replace(/\/+$/, "")}${path}`;
}

// ─── Error Boundary ────────────────────────────────────────────────

export class GraphErrorBoundary extends Component<
	{ children: ReactNode; fallback: ReactNode },
	{ hasError: boolean }
> {
	override state = { hasError: false };

	static getDerivedStateFromError(): { hasError: boolean } {
		return { hasError: true };
	}

	override render() {
		if (this.state.hasError) return this.props.fallback;
		return this.props.children;
	}
}

export function GraphFallback({
	width,
	height,
	color,
}: {
	width: number;
	height: number;
	color: string;
}) {
	return (
		<div
			style={{
				width,
				height,
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				flexDirection: "column",
				gap: 8,
				color,
				fontFamily: FONT_STACK,
				fontSize: 13,
			}}
		>
			<svg
				aria-hidden="true"
				width="24"
				height="24"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="1.5"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<circle cx="12" cy="12" r="10" />
				<line x1="12" y1="8" x2="12" y2="12" />
				<line x1="12" y1="16" x2="12.01" y2="16" />
			</svg>
			{/* A missing package fails the site build, not this chunk; what reaches
			    the reader is a renderer that failed to load or crashed. */}
			<span>Graph renderer failed to load</span>
		</div>
	);
}

export interface GraphViewStats {
	nodes: number;
	links: number;
	neighborCount: number;
	neighborTotal: number;
	/** Nodes the render cap left out, so the panel can say the view is partial. */
	truncatedCount: number;
}

export interface GraphViewHandle {
	zoomIn: () => void;
	zoomOut: () => void;
	zoomReset: () => void;
	zoomToFit: () => void;
	centerOnCurrent: () => void;
	getStats: () => GraphViewStats;
}

/** Radius of a node with no links, in graph units, before the size setting. */
const BASE_RADIUS = 5;
const LARGE_GRAPH_BASE_RADIUS = 4;

/**
 * Visual node radius. Nodes grow with their link count, as in Obsidian; the
 * pointer-area painter and the arrow placement use the same value so the hit
 * region and arrowheads line up with the drawn dot.
 */
export function nodeRadius(degree: number, isLargeGraph: boolean, nodeSize: number): number {
	const base = isLargeGraph ? LARGE_GRAPH_BASE_RADIUS : BASE_RADIUS;
	return base * nodeSize * (1 + 0.25 * Math.log2(1 + degree));
}

/** Label opacity at a zoom level: fades in over the 30% of zoom below the threshold. */
export function labelOpacity(globalScale: number, textFadeThreshold: number): number {
	const fullAt = labelZoomFor(textFadeThreshold);
	const startAt = fullAt * 0.7;
	return Math.min(1, Math.max(0, (globalScale - startAt) / (fullAt - startAt)));
}

/**
 * Accept a group colour only if the runtime can actually paint it: an
 * invalid `fillStyle` is silently ignored by canvas, which would bleed the
 * previous node's colour into this one.
 */
function safeColor(value: string): string | undefined {
	if (typeof value !== "string" || value.trim() === "") return undefined;
	if (typeof CSS !== "undefined" && typeof CSS.supports === "function") {
		return CSS.supports("color", value) ? value : undefined;
	}
	return value;
}

function kindColor(node: Pick<ForceGraphNode, "kind">, colors: CanvasColors): string {
	if (node.kind === "tag") return colors.tagNode;
	if (node.kind === "attachment") return colors.attachmentNode;
	if (node.kind === "unresolved") return colors.unresolvedNode;
	return colors.node;
}

/** Pulls every node toward the origin; d3's own `center` force only recentres the mean. */
function createCenterPull(strength: number): CustomForce {
	let nodes: Array<{ x?: number; y?: number; vx?: number; vy?: number }> = [];
	const force = ((alpha: number) => {
		const k = strength * MAX_CENTER_PULL * alpha;
		for (const node of nodes) {
			node.vx = (node.vx ?? 0) - (node.x ?? 0) * k;
			node.vy = (node.vy ?? 0) - (node.y ?? 0) * k;
		}
	}) as CustomForce;
	force.initialize = (next) => {
		nodes = next;
	};
	return force;
}

const VISUALLY_HIDDEN = {
	position: "absolute",
	width: 1,
	height: 1,
	margin: -1,
	padding: 0,
	overflow: "hidden",
	clip: "rect(0 0 0 0)",
	whiteSpace: "nowrap",
	border: 0,
} as const;

export default forwardRef<GraphViewHandle, GraphViewProps>(function GraphView(
	{
		width,
		height,
		onNodeClick,
		onNodeHoverChange,
		colors: customColors,
		filters,
		groups,
		display = DEFAULT_DISPLAY_SETTINGS,
		forces = DEFAULT_FORCE_SETTINGS,
		searchText,
		timelapseRun = 0,
		onTimelapseEnd,
	},
	ref,
) {
	const pathname = usePathname();
	const navigateTo = useNavigateTo();
	const dark = useTheme();
	const baseColors = dark ? DARK_COLORS : LIGHT_COLORS;
	const colors = useMemo(() => mergeColors(baseColors, customColors), [baseColors, customColors]);
	const [ForceGraph, setForceGraph] = useState<ElementType | null>(null);
	const [forceGraphError, setForceGraphError] = useState(false);
	// Hover state lives in refs the painters read; the counter changes the
	// painters' identities so force-graph repaints after the simulation has
	// cooled (it pauses redraws once the engine stops).
	const [hoverVersion, setHoverVersion] = useState(0);
	const [listFocused, setListFocused] = useState(false);
	const [timelapseCutoff, setTimelapseCutoff] = useState<number | null>(null);
	const hoveredNodeRef = useRef<string | null>(null);
	const connectedSetRef = useRef<Set<string>>(new Set());
	const hoveredLinkRef = useRef<ForceGraphLink | null>(null);
	const forceRef = useRef<ForceGraphHandleRef | null>(null);
	const statsRef = useRef<GraphViewStats>({
		nodes: 0,
		links: 0,
		neighborCount: 0,
		neighborTotal: 0,
		truncatedCount: 0,
	});

	const currentRoutePath = useMemo(() => normalizeClientRoutePath(pathname), [pathname]);

	const graphIndex = useMemo(() => graphIndexFor(graphPayload), []);

	const derived = useMemo(() => {
		const result = deriveGraphViewData(graphIndex, currentRoutePath, filters, searchText);
		statsRef.current = {
			nodes: result.nodes.length,
			links: result.links.length,
			neighborCount: result.neighborCount,
			neighborTotal: result.neighborTotal,
			truncatedCount: result.truncatedCount,
		};
		return result;
	}, [graphIndex, currentRoutePath, filters, searchText]);
	const { isLargeGraph, isEmpty } = derived;

	// The ids each link was derived with: d3's link force replaces `source` and
	// `target` with node objects once the simulation starts.
	const linkEndpoints = useMemo(() => {
		const map = new WeakMap<object, [string, string]>();
		for (const link of derived.links) map.set(link, [link.source, link.target]);
		return map;
	}, [derived.links]);

	// One stable object per derived view: force-graph reheats the simulation
	// whenever `graphData` changes identity, so a fresh literal per render made
	// every hover, drag and resize restart the layout.
	const forceGraphData = useMemo(() => {
		if (timelapseCutoff === null) return { nodes: derived.nodes, links: derived.links };
		const nodes = derived.nodes.filter((node) => node.ctime <= timelapseCutoff);
		const shown = new Set(nodes.map((node) => node.id));
		const links = derived.links.filter((link) => {
			const ends = linkEndpoints.get(link);
			return ends !== undefined && shown.has(ends[0]) && shown.has(ends[1]);
		});
		return { nodes, links };
	}, [derived, linkEndpoints, timelapseCutoff]);

	// Link counts within the view, for d3's default link strength
	// (1 / the smaller endpoint degree), which the "Link force" slider scales.
	const visibleDegree = useMemo(() => {
		const degree = new Map<string, number>();
		for (const link of derived.links) {
			degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
			degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
		}
		return degree;
	}, [derived.links]);

	// First matching group wins; the current page keeps its dedicated colour
	// so "you are here" never hides behind a group.
	const groupColorByNode = useMemo(() => {
		const colorByNode = new Map<string, string>();
		if (!groups?.length || derived.nodes.length === 0) return colorByNode;
		const compiled = groups.map((group) => ({
			query: parseGraphQuery(group.query),
			color: safeColor(group.color),
		}));
		for (const node of derived.nodes) {
			if (node.isCurrent) continue;
			for (const group of compiled) {
				if (group.color && matchesGraphQuery(node, group.query, searchText?.get(node.id))) {
					colorByNode.set(node.id, group.color);
					break;
				}
			}
		}
		return colorByNode;
	}, [derived.nodes, groups, searchText]);

	useImperativeHandle(
		ref,
		() => ({
			zoomIn: () => {
				const fg = forceRef.current;
				if (fg?.zoom) fg.zoom(fg.zoom() * 1.3, 300);
			},
			zoomOut: () => {
				const fg = forceRef.current;
				if (fg?.zoom) fg.zoom(fg.zoom() / 1.3, 300);
			},
			zoomReset: () => {
				forceRef.current?.zoom?.(1, 300);
			},
			zoomToFit: () => {
				forceRef.current?.zoomToFit?.(300, 16);
			},
			centerOnCurrent: () => {
				forceRef.current?.centerAt?.(0, 0, 0);
			},
			getStats: () => ({ ...statsRef.current }),
		}),
		[],
	);

	useEffect(() => {
		let active = true;
		import("react-force-graph-2d")
			.then((mod) => {
				if (active) setForceGraph(() => mod.default);
			})
			.catch(() => {
				if (active) setForceGraphError(true);
			});
		return () => {
			active = false;
		};
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: currentRoutePath re-centers on route change
	useEffect(() => {
		const timer = setTimeout(() => {
			const fg = forceRef.current;
			if (fg?.centerAt && !isEmpty) fg.centerAt(0, 0, 300);
		}, 120);
		return () => clearTimeout(timer);
	}, [currentRoutePath, isEmpty]);

	// Forces are configured once the renderer exists — which may be long after
	// the data — and again whenever a slider moves. `ForceGraph` and `isEmpty`
	// are dependencies because either can be what finally mounts the instance.
	useEffect(() => {
		const fg = forceRef.current;
		if (!ForceGraph || isEmpty || !fg?.d3Force) return;
		fg.d3Force("charge")?.strength?.(forces.repelStrength * CHARGE_PER_REPEL);
		const link = fg.d3Force("link");
		link?.distance?.(forces.linkDistance);
		link?.strength?.((value: unknown) => {
			const ends = linkEndpoints.get(value as object);
			const smaller = ends
				? Math.min(visibleDegree.get(ends[0]) ?? 1, visibleDegree.get(ends[1]) ?? 1)
				: 1;
			return forces.linkStrength / Math.max(1, smaller);
		});
		fg.d3Force(
			"gravity",
			forces.centerStrength > 0 ? createCenterPull(forces.centerStrength) : null,
		);
		fg.d3ReheatSimulation?.();
	}, [
		ForceGraph,
		isEmpty,
		forces.centerStrength,
		forces.repelStrength,
		forces.linkStrength,
		forces.linkDistance,
		linkEndpoints,
		visibleDegree,
	]);

	// Timelapse: reveal the view's nodes in file-creation order. Derived nodes
	// (tags, attachments, unresolved links) appear with the first note linking
	// them; nodes without a known time are there from the start.
	const nodesRef = useRef(derived.nodes);
	nodesRef.current = derived.nodes;
	const onTimelapseEndRef = useRef(onTimelapseEnd);
	onTimelapseEndRef.current = onTimelapseEnd;
	useEffect(() => {
		if (timelapseRun === 0) return;
		const times = [
			...new Set(nodesRef.current.map((node) => node.ctime).filter((t) => t > 0)),
		].sort((a, b) => a - b);
		if (times.length === 0) {
			onTimelapseEndRef.current?.();
			return;
		}
		const steps = Math.min(60, times.length);
		let step = 0;
		setTimelapseCutoff(0);
		const timer = setInterval(() => {
			step += 1;
			if (step > steps) {
				clearInterval(timer);
				setTimelapseCutoff(null);
				onTimelapseEndRef.current?.();
				return;
			}
			setTimelapseCutoff(times[Math.ceil((step / steps) * times.length) - 1] ?? Infinity);
		}, 80);
		return () => {
			clearInterval(timer);
			setTimelapseCutoff(null);
		};
	}, [timelapseRun]);

	const radiusOf = useCallback(
		(node: ForceGraphNode) => nodeRadius(node.degree, isLargeGraph, display.nodeSize),
		[isLargeGraph, display.nodeSize],
	);

	const openNode = useCallback(
		(node: GraphNode, newTab = false) => {
			if (!node.navigable) return;
			if (newTab) {
				window.open(nodeHref(node), "_blank", "noopener");
				return;
			}
			if (onNodeClick) onNodeClick(node);
			else if (node.kind === "attachment") navigation.assign(nodeHref(node));
			else navigateTo(node.id);
		},
		[onNodeClick, navigateTo],
	);

	const nodePointerAreaPaint = useCallback(
		(
			node: ForceGraphNode & { x?: number; y?: number },
			paintColor: string,
			ctx: CanvasRenderingContext2D,
		) => {
			// The shadow canvas hit-tests by reading the painted pixel color, so
			// paint the same radius as the visible node. Without this, the default
			// hit radius (`sqrt(nodeVal) * nodeRelSize + pad`) can drift from the dot.
			ctx.beginPath();
			ctx.arc(node.x || 0, node.y || 0, radiusOf(node), 0, Math.PI * 2);
			ctx.fillStyle = paintColor;
			ctx.fill();
		},
		[radiusOf],
	);

	// force-graph places arrowheads at `sqrt(nodeVal) * nodeRelSize`, so the
	// value is the squared radius (with `nodeRelSize` 1).
	const nodeVal = useCallback((node: ForceGraphNode) => radiusOf(node) ** 2, [radiusOf]);

	const handleNodeClick = useCallback(
		(node: GraphNode, event?: MouseEvent) => {
			openNode(node, Boolean(event?.metaKey || event?.ctrlKey));
		},
		[openNode],
	);

	const handleLinkHover = useCallback(
		(link: object | null) => {
			const endpoints = link ? linkEndpoints.get(link) : undefined;
			hoveredLinkRef.current = endpoints ? { source: endpoints[0], target: endpoints[1] } : null;
			setHoverVersion((version) => version + 1);
		},
		[linkEndpoints],
	);

	const handleNodeHover = useCallback(
		(node: (ForceGraphNode & { x?: number; y?: number }) | null) => {
			if (node?.id) {
				hoveredNodeRef.current = node.id;
				const set = new Set<string>([node.id]);
				for (const id of graphIndex.outgoingByNode.get(node.id) ?? []) set.add(id);
				for (const id of graphIndex.incomingByNode.get(node.id) ?? []) set.add(id);
				connectedSetRef.current = set;
				onNodeHoverChange?.(node.label ?? null, node.x ?? 0, node.y ?? 0);
			} else {
				hoveredNodeRef.current = null;
				connectedSetRef.current = new Set();
				onNodeHoverChange?.(null, 0, 0);
			}
			setHoverVersion((version) => version + 1);
		},
		[graphIndex, onNodeHoverChange],
	);

	const nodeColor = useCallback(
		(node: ForceGraphNode) => {
			if (node.isCurrent) return colors.currentNode;
			return groupColorByNode.get(node.id) ?? kindColor(node, colors);
		},
		[colors, groupColorByNode],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: hoverVersion forces a repaint after the engine cools
	const nodeCanvasObject = useCallback(
		(
			node: ForceGraphNode & { x?: number; y?: number },
			ctx: CanvasRenderingContext2D,
			globalScale: number,
		) => {
			const label = node.label || "";
			const fontSize = 12 / globalScale;
			const radius = radiusOf(node);
			const nx = node.x || 0;
			const ny = node.y || 0;

			const isHovered = hoveredNodeRef.current === node.id;
			// With a node hovered, everything outside its neighbourhood fades back
			// so the focused subgraph reads at a glance.
			const isDimmed = hoveredNodeRef.current !== null && !connectedSetRef.current.has(node.id);

			// Hover focus wins over the group colour so the neighbourhood reads
			// while a node is hovered, and dimming wins too.
			ctx.beginPath();
			ctx.arc(nx, ny, radius, 0, Math.PI * 2);
			if (node.isCurrent) ctx.fillStyle = colors.currentNode;
			else if (isHovered) ctx.fillStyle = colors.nodeHover;
			else if (isDimmed) ctx.fillStyle = colors.nodeDimmed;
			else ctx.fillStyle = groupColorByNode.get(node.id) ?? kindColor(node, colors);
			ctx.fill();

			// Labels fade in with zoom (the "Text fade threshold" setting); the
			// current and hovered nodes are always labelled.
			const opacity =
				node.isCurrent || isHovered ? 1 : labelOpacity(globalScale, display.textFadeThreshold);
			if (opacity <= 0 || !label) return;
			const previousAlpha = ctx.globalAlpha;
			ctx.globalAlpha = opacity;
			ctx.font = `${node.isCurrent || isHovered ? 600 : 400} ${fontSize}px ${FONT_STACK}`;
			ctx.textAlign = "center";
			ctx.textBaseline = "middle";
			ctx.lineJoin = "round";
			ctx.lineWidth = 2 / globalScale;
			ctx.strokeStyle = colors.labelShadow;
			const labelY = ny + radius + fontSize + 2 / globalScale;
			ctx.strokeText(label, nx, labelY);
			ctx.fillStyle = node.isCurrent
				? colors.currentLabel
				: isHovered
					? colors.labelHover
					: colors.label;
			ctx.fillText(label, nx, labelY);
			ctx.globalAlpha = previousAlpha;
		},
		[colors, radiusOf, groupColorByNode, display.textFadeThreshold, hoverVersion],
	);

	const isLinkHighlighted = useCallback(
		(link: object): boolean | undefined => {
			const endpoints = linkEndpoints.get(link);
			if (!endpoints) return undefined;
			const [src, tgt] = endpoints;
			const hovered = hoveredLinkRef.current;
			if (hovered) {
				return (
					(src === hovered.source && tgt === hovered.target) ||
					(src === hovered.target && tgt === hovered.source)
				);
			}
			if (hoveredNodeRef.current) {
				return src === hoveredNodeRef.current || tgt === hoveredNodeRef.current;
			}
			return undefined;
		},
		[linkEndpoints],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: hoverVersion forces a repaint after the engine cools
	const linkColor = useCallback(
		(link: object) => {
			const highlighted = isLinkHighlighted(link);
			if (highlighted === undefined) return colors.link;
			return highlighted ? colors.linkHighlight : colors.fallbackLinkDim;
		},
		[colors.link, colors.linkHighlight, colors.fallbackLinkDim, isLinkHighlighted, hoverVersion],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: hoverVersion forces a repaint after the engine cools
	const linkWidth = useCallback(
		(link: object) => {
			const highlighted = isLinkHighlighted(link);
			let width: number;
			if (highlighted === undefined) width = isLargeGraph ? 0.6 : 0.8;
			else if (highlighted) width = hoveredLinkRef.current ? 1.5 : 1.3;
			else width = isLargeGraph ? 0.4 : 0.5;
			return width * display.linkThickness;
		},
		[isLargeGraph, isLinkHighlighted, display.linkThickness, hoverVersion],
	);

	const listedNodes = useMemo(
		() =>
			[...derived.nodes]
				.filter((node) => node.navigable)
				.sort(
					(a, b) => Number(b.isCurrent) - Number(a.isCurrent) || a.label.localeCompare(b.label),
				),
		[derived.nodes],
	);

	const handleListClick = useCallback(
		(event: ReactMouseEvent<HTMLAnchorElement>, node: GraphNode) => {
			// Modified clicks keep the browser's own behaviour (new tab, window).
			if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
				return;
			}
			event.preventDefault();
			openNode(node);
		},
		[openNode],
	);

	// A keyboard and screen-reader alternative to the canvas: every navigable
	// node in the view as a link. Hidden until it holds focus, then shown over
	// the graph so a sighted keyboard user sees where focus is.
	const nodeList =
		listedNodes.length > 0 ? (
			<nav
				aria-label="Pages in this graph"
				onFocus={() => setListFocused(true)}
				onBlur={(event) => {
					if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
						setListFocused(false);
					}
				}}
				style={
					listFocused
						? {
								position: "absolute",
								inset: 0,
								overflow: "auto",
								zIndex: 3,
								padding: 8,
								background: "var(--rp-c-bg, #ffffff)",
								fontFamily: FONT_STACK,
								fontSize: 12,
							}
						: VISUALLY_HIDDEN
				}
			>
				<ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
					{listedNodes.map((node) => (
						<li key={node.id}>
							<a
								href={nodeHref(node)}
								aria-current={node.isCurrent ? "page" : undefined}
								onClick={(event) => handleListClick(event, node)}
								style={{ color: "var(--rp-c-text-1, #1a1a1a)" }}
							>
								{node.label}
							</a>
						</li>
					))}
				</ul>
			</nav>
		) : null;

	if (forceGraphError) {
		return (
			<>
				<GraphFallback width={width} height={height} color={colors.label} />
				{nodeList}
			</>
		);
	}

	if (!ForceGraph) {
		return (
			<div
				style={{
					width,
					height,
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
				}}
			>
				<div
					style={{
						width: 20,
						height: 20,
						borderRadius: "50%",
						border: `2px solid ${colors.loaderBorder}`,
						borderTopColor: colors.loaderTop,
						animation: "gv-spinner 0.8s linear infinite",
					}}
				/>
				{nodeList}
			</div>
		);
	}

	if (isEmpty) {
		return (
			<div
				style={{
					width,
					height,
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					flexDirection: "column",
					gap: 6,
					color: colors.label,
					fontFamily: FONT_STACK,
					fontSize: 13,
				}}
			>
				<svg
					aria-hidden="true"
					width="22"
					height="22"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<circle cx="12" cy="12" r="3" />
					<line x1="12" y1="5" x2="12" y2="9" />
					<line x1="12" y1="15" x2="12" y2="19" />
					<line x1="5" y1="12" x2="9" y2="12" />
					<line x1="15" y1="12" x2="19" y2="12" />
				</svg>
				<span>No pages to show</span>
			</div>
		);
	}

	return (
		<GraphErrorBoundary
			fallback={<GraphFallback width={width} height={height} color={colors.label} />}
		>
			<div aria-hidden="true">
				<ForceGraph
					ref={forceRef}
					graphData={forceGraphData}
					width={width}
					height={height}
					nodeRelSize={1}
					nodeVal={nodeVal as (node: object) => number}
					nodeColor={nodeColor as (node: object) => string}
					nodeCanvasObject={nodeCanvasObject}
					nodeCanvasObjectMode={() => "replace" as const}
					nodePointerAreaPaint={
						nodePointerAreaPaint as (
							node: unknown,
							paintColor: string,
							ctx: CanvasRenderingContext2D,
							globalScale: number,
						) => void
					}
					onNodeHover={handleNodeHover as (node: unknown, prevNode: unknown) => void}
					onLinkHover={handleLinkHover as (link: unknown, prevLink: unknown) => void}
					linkColor={linkColor}
					linkWidth={linkWidth}
					linkDirectionalArrowLength={display.arrows ? 3.5 * display.linkThickness + 1.5 : 0}
					linkDirectionalArrowRelPos={1}
					onNodeClick={handleNodeClick as (node: unknown, event: MouseEvent) => void}
					backgroundColor="transparent"
					showPointerCursor={(node: unknown) =>
						Boolean(node && typeof node === "object" && "navigable" in node && node.navigable)
					}
					d3AlphaDecay={isLargeGraph ? 0.08 : 0.04}
					d3VelocityDecay={isLargeGraph ? 0.6 : 0.4}
					d3AlphaMin={0.002}
				/>
			</div>
			{nodeList}
		</GraphErrorBoundary>
	);
});
