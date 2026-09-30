import type { GraphData, GraphLink, GraphNode } from "../types.js";
import { matchesGraphQuery, parseGraphQuery } from "./graph-query.js";

export interface ForceGraphNode extends GraphNode {
	isCurrent: boolean;
	/** Tag routes this node links to — what `tag:` queries match against. */
	tags?: string[];
}

export interface ForceGraphLink {
	source: string;
	target: string;
}

export interface GraphIndex {
	nodeById: Map<string, GraphNode>;
	adjacentIdsByNode: Map<string, Set<string>>;
	linksByNode: Map<string, GraphLink[]>;
}

/**
 * Which nodes the panel shows. Every field is optional; omitted fields fall
 * back to the Obsidian local-graph defaults (depth 1, everything visible, no
 * search), which is exactly the pre-filters behaviour.
 */
export interface GraphViewFilters {
	/** Search-box contents, parsed with `parseGraphQuery`. @default "" */
	query?: string;
	/** Hops from the current page. 1 = current page plus its neighbors.
	 * Clamped to 1–5. @default 1 */
	depth?: number;
	/** Show `/tags/…` pages as nodes. @default true */
	showTags?: boolean;
	/** Keep visible nodes that link to nothing else in the view.
	 * @default true */
	showOrphans?: boolean;
	/**
	 * Which part of the vault the panel draws: `"local"` walks `depth` hops from
	 * the current page (Obsidian's local graph), `"global"` shows every published
	 * page with the current one highlighted (the global graph). @default "local"
	 */
	scope?: GraphScope;
}

/** `"local"` is the neighborhood of the current page, `"global"` the whole vault. */
export type GraphScope = "local" | "global";

export interface DerivedGraphViewData {
	nodes: ForceGraphNode[];
	links: ForceGraphLink[];
	isLargeGraph: boolean;
	/** True when the view has no links to draw (isolated or fully filtered page) */
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
 * Render ceiling for the global scope.
 *
 * The whole vault is what the reader asked for, so the cap only exists to keep
 * d3-force usable on a very large site; the panel reports how many nodes it left
 * out rather than silently drawing a subset.
 */
export const MAX_GLOBAL_NODES = 1000;

export const DEFAULT_GRAPH_FILTERS = Object.freeze({
	query: "",
	depth: 1,
	showTags: true,
	showOrphans: true,
	scope: "local" as GraphScope,
});

const TAG_ROUTE_PREFIX = "/tags/";

/** Normalize a browser pathname (which may carry a `.html` suffix and trailing slashes) to a graph node id. */
export function normalizeClientRoutePath(pathname: string): string {
	const withoutHtml = pathname.replace(/\.html$/, "");
	const trimmed = withoutHtml.replace(/\/+$/, "");
	const withoutIndex = trimmed.replace(/\/index$/, "");
	return withoutIndex || "/";
}

export function createGraphIndex(graphData: GraphData): GraphIndex {
	const nodeById = new Map<string, GraphNode>();
	const adjacentIdsByNode = new Map<string, Set<string>>();
	const linksByNode = new Map<string, GraphLink[]>();

	for (const node of graphData.nodes) {
		nodeById.set(node.id, node);
	}

	for (const link of graphData.links) {
		ensureNeighborSet(adjacentIdsByNode, link.source).add(link.target);
		ensureNeighborSet(adjacentIdsByNode, link.target).add(link.source);
		ensureLinkBucket(linksByNode, link.source).push(link);

		if (link.target !== link.source) {
			ensureLinkBucket(linksByNode, link.target).push(link);
		}
	}

	return {
		nodeById,
		adjacentIdsByNode,
		linksByNode,
	};
}

export function deriveGraphViewData(
	graphIndex: GraphIndex,
	currentRoutePath: string,
	filters?: GraphViewFilters,
): DerivedGraphViewData {
	const currentNode = graphIndex.nodeById.get(currentRoutePath);

	if (!currentNode) {
		return {
			nodes: [],
			links: [],
			isLargeGraph: false,
			isEmpty: true,
			neighborCount: 0,
			neighborTotal: 0,
			truncatedCount: 0,
		};
	}

	const { query, depth, showTags, showOrphans, scope } = normalizeFilters(filters);
	const searchQuery = parseGraphQuery(query);

	// The node set (the neighborhood within `depth` hops, or the whole vault in
	// the global scope), then the visibility toggles, then the search query, then
	// the render cap. Every filter runs before the cap so hidden or unmatched
	// nodes cannot consume the budget of nodes the reader actually asked for.
	// `depth` is the local scope's neighborhood size (depth 1 = the current page
	// plus its direct neighbors — graph-view's original behaviour).
	const reached =
		scope === "global"
			? new Set(graphIndex.nodeById.keys())
			: collectWithinDepth(graphIndex, currentRoutePath, depth);
	reached.delete(currentRoutePath);

	let candidates = Array.from(reached).filter((nodeId) => {
		const node = graphIndex.nodeById.get(nodeId);
		if (!node) return false;
		return showTags || !node.routePath.startsWith(TAG_ROUTE_PREFIX);
	});
	const neighborTotal = candidates.length;

	if (!searchQuery.isEmpty) {
		candidates = candidates.filter((nodeId) => {
			const node = graphIndex.nodeById.get(nodeId);
			if (!node) return false;
			// The stored `GraphNode` carries no tag metadata, so `tag:` queries
			// read the node's outgoing tag edges the way the final view does.
			const queryable = {
				label: node.label,
				routePath: node.routePath,
				tags: collectTagTargets(graphIndex, nodeId),
			};
			return matchesGraphQuery(queryable, searchQuery);
		});
	}

	let keptNeighborIds = candidates;
	const cap = scope === "global" ? MAX_GLOBAL_NODES : MAX_NEIGHBORS;
	let truncatedCount = 0;
	if (candidates.length > cap) {
		// Degree descending, then id ascending, so the kept set never depends on input order.
		candidates = [...candidates].sort((a, b) => {
			const degreeA = graphIndex.adjacentIdsByNode.get(a)?.size ?? 0;
			const degreeB = graphIndex.adjacentIdsByNode.get(b)?.size ?? 0;
			return degreeB - degreeA || (a < b ? -1 : 1);
		});
		keptNeighborIds = candidates.slice(0, cap);
		truncatedCount = candidates.length - cap;
	}

	const visibleIds = new Set<string>([currentRoutePath, ...keptNeighborIds]);

	// Every link with both ends visible, deduplicated and ordered current
	// first: at depth 1 that is the current page's links (plus any link
	// between two of its neighbors, which Obsidian draws too), and deeper
	// views get the full induced subgraph.
	const links: ForceGraphLink[] = [];
	const seenLinks = new Set<string>();
	for (const nodeId of visibleIds) {
		for (const link of graphIndex.linksByNode.get(nodeId) ?? []) {
			if (!visibleIds.has(link.source) || !visibleIds.has(link.target)) continue;
			const key =
				link.source < link.target
					? `${link.source}→${link.target}`
					: `${link.target}→${link.source}`;
			if (seenLinks.has(key)) continue;
			seenLinks.add(key);
			links.push({ source: link.source, target: link.target });
		}
	}

	if (!showOrphans) {
		const degree = new Map<string, number>();
		for (const link of links) {
			degree.set(link.source, (degree.get(link.source) ?? 0) + 1);
			degree.set(link.target, (degree.get(link.target) ?? 0) + 1);
		}
		for (const nodeId of Array.from(visibleIds)) {
			if (nodeId !== currentRoutePath && !degree.get(nodeId)) visibleIds.delete(nodeId);
		}
		// Orphans had no links by definition, so the link set is unchanged.
	}

	const nodes: ForceGraphNode[] = [];
	for (const nodeId of visibleIds) {
		const node = graphIndex.nodeById.get(nodeId);
		if (!node) continue;
		nodes.push({
			...node,
			isCurrent: node.id === currentRoutePath,
			tags: collectTagTargets(graphIndex, nodeId),
		});
	}

	const neighborCount = Math.max(0, visibleIds.size - 1);
	const isEmpty = links.length === 0;
	const nodeCount = nodes.length;
	const linkCount = links.length;
	return {
		nodes,
		links,
		isLargeGraph:
			!isEmpty &&
			(nodeCount > LARGE_GRAPH_NODE_THRESHOLD || linkCount > LARGE_GRAPH_LINK_THRESHOLD),
		isEmpty,
		neighborCount,
		neighborTotal,
		truncatedCount,
	};
}

function normalizeFilters(filters?: GraphViewFilters): {
	query: string;
	depth: number;
	showTags: boolean;
	showOrphans: boolean;
	scope: GraphScope;
} {
	const depth = Math.min(
		MAX_DEPTH,
		Math.max(1, Math.round(filters?.depth ?? DEFAULT_GRAPH_FILTERS.depth)),
	);
	return {
		query: filters?.query ?? DEFAULT_GRAPH_FILTERS.query,
		depth,
		showTags: filters?.showTags ?? DEFAULT_GRAPH_FILTERS.showTags,
		showOrphans: filters?.showOrphans ?? DEFAULT_GRAPH_FILTERS.showOrphans,
		scope: filters?.scope === "global" ? "global" : "local",
	};
}

/** BFS from the current node, returning every id reached within `depth` hops (current included). */
function collectWithinDepth(
	graphIndex: GraphIndex,
	currentRoutePath: string,
	depth: number,
): Set<string> {
	const reached = new Set<string>([currentRoutePath]);
	let frontier = [currentRoutePath];
	for (let hop = 0; hop < depth && frontier.length > 0; hop += 1) {
		const next: string[] = [];
		for (const nodeId of frontier) {
			for (const neighbor of graphIndex.adjacentIdsByNode.get(nodeId) ?? []) {
				if (reached.has(neighbor)) continue;
				if (!graphIndex.nodeById.has(neighbor)) continue;
				reached.add(neighbor);
				next.push(neighbor);
			}
		}
		frontier = next;
	}
	return reached;
}

/** The `/tags/…` routes this node links to — the page's own tags. */
function collectTagTargets(graphIndex: GraphIndex, nodeId: string): string[] {
	const targets: string[] = [];
	for (const link of graphIndex.linksByNode.get(nodeId) ?? []) {
		if (link.source === nodeId && link.target.startsWith(TAG_ROUTE_PREFIX)) {
			targets.push(link.target);
		}
	}
	return targets;
}

function ensureNeighborSet(
	adjacentIdsByNode: GraphIndex["adjacentIdsByNode"],
	nodeId: string,
): Set<string> {
	const existing = adjacentIdsByNode.get(nodeId);
	if (existing) {
		return existing;
	}

	const neighborSet = new Set<string>();
	adjacentIdsByNode.set(nodeId, neighborSet);
	return neighborSet;
}

function ensureLinkBucket(linksByNode: GraphIndex["linksByNode"], nodeId: string): GraphLink[] {
	const existing = linksByNode.get(nodeId);
	if (existing) {
		return existing;
	}

	const linkBucket: GraphLink[] = [];
	linksByNode.set(nodeId, linkBucket);
	return linkBucket;
}
