import type { GraphData, GraphLink, GraphNode, GraphNodeKind } from "../types.js";
import { type GraphQuery, matchesGraphQuery, parseGraphQuery } from "./graph-query.js";

export interface ForceGraphNode extends GraphNode {
	isCurrent: boolean;
	/** Tag names (lowercased, no `#`) this node links to — what `tag:` queries match. */
	tags: string[];
	/** Links touching this node in the whole graph; drives the node size. */
	degree: number;
}

export interface ForceGraphLink {
	source: string;
	target: string;
}

export interface GraphIndex {
	nodeById: Map<string, GraphNode>;
	/** Targets each node links to. */
	outgoingByNode: Map<string, Set<string>>;
	/** Sources linking to each node. */
	incomingByNode: Map<string, Set<string>>;
	linksByNode: Map<string, GraphLink[]>;
	tagsByNode: Map<string, string[]>;
}

/** `"local"` is the neighborhood of the current page, `"global"` the whole site. */
export type GraphScope = "local" | "global";

/**
 * Which nodes the panel shows — Obsidian's Filters section plus the local
 * graph's depth and link-direction toggles. Every field is optional; omitted
 * fields take Obsidian's defaults.
 */
export interface GraphViewFilters {
	/** Search-box contents, parsed with `parseGraphQuery`. @default "" */
	query?: string;
	/** Hops from the current page in the local scope. Clamped to 1–5. @default 1 */
	depth?: number;
	/** Show tag nodes. @default true */
	showTags?: boolean;
	/** Show attachment nodes (images, PDFs, …). @default false */
	showAttachments?: boolean;
	/** Hide links to notes that do not exist. Off draws them as unresolved nodes. @default true */
	existingOnly?: boolean;
	/** Keep nodes that link to nothing else in the view. @default true */
	showOrphans?: boolean;
	/** @default "local" */
	scope?: GraphScope;
	/** Local graph: follow links into the current page. @default true */
	incoming?: boolean;
	/** Local graph: follow links out of the current page. @default true */
	outgoing?: boolean;
	/** Local graph: draw links between neighbors, not only along the walk. @default true */
	neighborLinks?: boolean;
}

export interface DerivedGraphViewData {
	nodes: ForceGraphNode[];
	links: ForceGraphLink[];
	isLargeGraph: boolean;
	/** True when there is no node to draw. */
	isEmpty: boolean;
	/** Neighbors actually rendered, excluding the current page. */
	neighborCount: number;
	/** Neighbors within the depth and toggles, before the render cap. */
	neighborTotal: number;
	/** Nodes the render cap left out, so the panel can say so. */
	truncatedCount: number;
}

export const LARGE_GRAPH_NODE_THRESHOLD = 80;
export const LARGE_GRAPH_LINK_THRESHOLD = 160;

/**
 * Hard ceiling on rendered neighbors. A hub/MOC page can link thousands of
 * pages; handing that whole neighborhood to d3-force freezes the panel.
 * Neighbors past the cap are ranked out by degree (then id) so the choice is
 * deterministic.
 */
export const MAX_NEIGHBORS = 250;

/** Highest value the depth control accepts — matching the transclusion cap. */
export const MAX_DEPTH = 5;

/**
 * Render ceiling for the global scope. The cap only keeps d3-force usable on a
 * very large site; the panel reports how many nodes it left out.
 */
export const MAX_GLOBAL_NODES = 1000;

export const DEFAULT_GRAPH_FILTERS = Object.freeze({
	query: "",
	depth: 1,
	showTags: true,
	showAttachments: false,
	existingOnly: true,
	showOrphans: true,
	scope: "local" as GraphScope,
	incoming: true,
	outgoing: true,
	neighborLinks: true,
});

/**
 * A browser pathname (or link href path) as a graph node id: the router hands
 * over the percent-encoded path, node ids are Rspress's decoded routes, and a
 * `.html` suffix, `/index` and trailing slashes are dropped. A malformed escape
 * keeps the raw path.
 */
export function normalizeClientRoutePath(pathname: string): string {
	let decoded = pathname;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		// `%E0%A4%A` and friends: match what was typed.
	}
	const withoutHtml = decoded.normalize("NFC").replace(/\.html$/, "");
	const trimmed = withoutHtml.replace(/\/+$/, "");
	const withoutIndex = trimmed.replace(/\/index$/, "");
	return withoutIndex || "/";
}

/** The tag a tag node stands for, as `tag:` queries compare it: lowercased, no `#`. */
function tagNameOf(node: GraphNode): string {
	return node.label.replace(/^#/, "").normalize("NFC").toLowerCase();
}

export function createGraphIndex(graphData: GraphData): GraphIndex {
	const nodeById = new Map<string, GraphNode>();
	const outgoingByNode = new Map<string, Set<string>>();
	const incomingByNode = new Map<string, Set<string>>();
	const linksByNode = new Map<string, GraphLink[]>();
	const tagsByNode = new Map<string, string[]>();

	for (const node of graphData.nodes) nodeById.set(node.id, node);

	for (const link of graphData.links) {
		bucket(outgoingByNode, link.source, () => new Set<string>()).add(link.target);
		bucket(incomingByNode, link.target, () => new Set<string>()).add(link.source);
		bucket(linksByNode, link.source, () => []).push(link);
		if (link.target !== link.source) bucket(linksByNode, link.target, () => []).push(link);
		const target = nodeById.get(link.target);
		if (target?.kind === "tag") bucket(tagsByNode, link.source, () => []).push(tagNameOf(target));
	}
	for (const node of graphData.nodes) {
		if (node.kind === "tag") bucket(tagsByNode, node.id, () => []).push(tagNameOf(node));
	}

	return { nodeById, outgoingByNode, incomingByNode, linksByNode, tagsByNode };
}

/** Whether filters hide this kind of node outright, before any walk or search. */
function isKindVisible(kind: GraphNodeKind, filters: Required<GraphViewFilters>): boolean {
	switch (kind) {
		case "tag":
			return filters.showTags;
		case "attachment":
			return filters.showAttachments;
		case "unresolved":
			return !filters.existingOnly;
		case "page":
			return true;
	}
}

export function deriveGraphViewData(
	graphIndex: GraphIndex,
	currentRoutePath: string,
	filters?: GraphViewFilters,
	/** Note text by node id, once the search data has loaded. */
	searchText?: ReadonlyMap<string, string>,
): DerivedGraphViewData {
	const settings = normalizeFilters(filters);
	const currentNode = graphIndex.nodeById.get(currentRoutePath);
	const empty: DerivedGraphViewData = {
		nodes: [],
		links: [],
		isLargeGraph: false,
		isEmpty: true,
		neighborCount: 0,
		neighborTotal: 0,
		truncatedCount: 0,
	};
	// The global graph needs no current page (a 404, a page outside the graph);
	// the local graph is the current page's neighborhood, so without one it is empty.
	if (!currentNode && settings.scope === "local") return empty;

	const searchQuery = parseGraphQuery(settings.query);
	const kindVisible = (nodeId: string) => {
		const node = graphIndex.nodeById.get(nodeId);
		return node !== undefined && isKindVisible(node.kind, settings);
	};

	// Node set (the walk within `depth` hops, or every node), then the search,
	// then the render cap — every filter runs before the cap so hidden or
	// unmatched nodes cannot consume the budget. Kind filters apply during the
	// walk too: a hidden tag does not connect two notes that share it.
	const hops =
		settings.scope === "global"
			? undefined
			: collectWithinDepth(graphIndex, currentRoutePath, settings, kindVisible);
	let candidates = hops
		? [...hops.keys()].filter((nodeId) => nodeId !== currentRoutePath)
		: [...graphIndex.nodeById.keys()].filter(
				(nodeId) => nodeId !== currentRoutePath && kindVisible(nodeId),
			);
	const neighborTotal = candidates.length;

	if (!searchQuery.isEmpty) {
		candidates = candidates.filter((nodeId) =>
			matches(graphIndex, nodeId, searchQuery, searchText),
		);
	}

	let keptNeighborIds = candidates;
	const cap = settings.scope === "global" ? MAX_GLOBAL_NODES : MAX_NEIGHBORS;
	let truncatedCount = 0;
	if (candidates.length > cap) {
		const degreeOf = (nodeId: string) => graphIndex.linksByNode.get(nodeId)?.length ?? 0;
		// Degree descending, then id ascending, so the kept set never depends on input order.
		keptNeighborIds = [...candidates]
			.sort((a, b) => degreeOf(b) - degreeOf(a) || (a < b ? -1 : 1))
			.slice(0, cap);
		truncatedCount = candidates.length - cap;
	}

	const visibleIds = new Set<string>(keptNeighborIds);
	if (currentNode) visibleIds.add(currentRoutePath);

	const links: ForceGraphLink[] = [];
	const seenLinks = new Set<string>();
	for (const nodeId of visibleIds) {
		for (const link of graphIndex.linksByNode.get(nodeId) ?? []) {
			if (!visibleIds.has(link.source) || !visibleIds.has(link.target)) continue;
			if (hops && !keepLocalLink(link, currentRoutePath, hops, settings)) continue;
			const key = `${link.source}\u0000${link.target}`;
			if (seenLinks.has(key)) continue;
			seenLinks.add(key);
			links.push({ source: link.source, target: link.target });
		}
	}

	if (!settings.showOrphans) {
		const linked = new Set<string>();
		for (const link of links) {
			linked.add(link.source);
			linked.add(link.target);
		}
		for (const nodeId of [...visibleIds]) {
			if (nodeId !== currentRoutePath && !linked.has(nodeId)) visibleIds.delete(nodeId);
		}
	}

	const nodes: ForceGraphNode[] = [];
	for (const nodeId of visibleIds) {
		const node = graphIndex.nodeById.get(nodeId);
		if (!node) continue;
		nodes.push({
			...node,
			isCurrent: node.id === currentRoutePath,
			tags: graphIndex.tagsByNode.get(nodeId) ?? [],
			degree: graphIndex.linksByNode.get(nodeId)?.length ?? 0,
		});
	}

	return {
		nodes,
		links,
		isLargeGraph:
			nodes.length > LARGE_GRAPH_NODE_THRESHOLD || links.length > LARGE_GRAPH_LINK_THRESHOLD,
		isEmpty: nodes.length === 0,
		neighborCount: currentNode ? Math.max(0, visibleIds.size - 1) : visibleIds.size,
		neighborTotal,
		truncatedCount,
	};
}

function matches(
	graphIndex: GraphIndex,
	nodeId: string,
	query: GraphQuery,
	searchText?: ReadonlyMap<string, string>,
): boolean {
	const node = graphIndex.nodeById.get(nodeId);
	if (!node) return false;
	return matchesGraphQuery(
		{ ...node, tags: graphIndex.tagsByNode.get(nodeId) ?? [] },
		query,
		searchText?.get(nodeId),
	);
}

/**
 * Local-graph link rules: a link touching the current page must run in an
 * enabled direction, and with "Neighbor links" off only links that step one
 * hop further from the current page are drawn.
 */
function keepLocalLink(
	link: GraphLink,
	currentRoutePath: string,
	hops: Map<string, number>,
	settings: Required<GraphViewFilters>,
): boolean {
	if (link.source === currentRoutePath && !settings.outgoing) return false;
	if (link.target === currentRoutePath && !settings.incoming) return false;
	if (settings.neighborLinks) return true;
	const sourceHop = hops.get(link.source) ?? 0;
	const targetHop = hops.get(link.target) ?? 0;
	return Math.abs(sourceHop - targetHop) === 1;
}

export function normalizeFilters(filters?: GraphViewFilters): Required<GraphViewFilters> {
	const pick = <K extends keyof GraphViewFilters>(key: K): Required<GraphViewFilters>[K] =>
		(filters?.[key] ?? DEFAULT_GRAPH_FILTERS[key]) as Required<GraphViewFilters>[K];
	return {
		query: pick("query"),
		depth: Math.min(MAX_DEPTH, Math.max(1, Math.round(pick("depth")))),
		showTags: pick("showTags"),
		showAttachments: pick("showAttachments"),
		existingOnly: pick("existingOnly"),
		showOrphans: pick("showOrphans"),
		scope: filters?.scope === "global" ? "global" : "local",
		incoming: pick("incoming"),
		outgoing: pick("outgoing"),
		neighborLinks: pick("neighborLinks"),
	};
}

/**
 * Breadth-first walk from the current node, returning every visible node
 * reached within `depth` hops with its hop count (current included at 0). The
 * first hop follows only the enabled directions; later hops follow every link,
 * as Obsidian's local graph does.
 */
function collectWithinDepth(
	graphIndex: GraphIndex,
	currentRoutePath: string,
	settings: Required<GraphViewFilters>,
	kindVisible: (nodeId: string) => boolean,
): Map<string, number> {
	const hops = new Map<string, number>([[currentRoutePath, 0]]);
	let frontier = [currentRoutePath];
	for (let hop = 1; hop <= settings.depth && frontier.length > 0; hop += 1) {
		const next: string[] = [];
		for (const nodeId of frontier) {
			const fromCurrent = nodeId === currentRoutePath;
			const neighbors = [
				...(!fromCurrent || settings.outgoing ? (graphIndex.outgoingByNode.get(nodeId) ?? []) : []),
				...(!fromCurrent || settings.incoming ? (graphIndex.incomingByNode.get(nodeId) ?? []) : []),
			];
			for (const neighbor of neighbors) {
				if (hops.has(neighbor) || !kindVisible(neighbor)) continue;
				hops.set(neighbor, hop);
				next.push(neighbor);
			}
		}
		frontier = next;
	}
	return hops;
}

function bucket<K, V>(map: Map<K, V>, key: K, create: () => V): V {
	const existing = map.get(key);
	if (existing !== undefined) return existing;
	const created = create();
	map.set(key, created);
	return created;
}
