export interface GraphNode {
	id: string;
	label: string;
	routePath: string;
}

export interface GraphLink {
	source: string;
	target: string;
}

export interface GraphData {
	nodes: GraphNode[];
	links: GraphLink[];
}

/**
 * A colour group for the graph panel: nodes whose content matches `query`
 * render in `color`. The query uses the same language as the panel's search
 * box (see `src/graph/runtime/graph-query.ts`), and the first matching group
 * wins.
 */
export interface GraphViewGroup {
	query: string;
	color: string;
}
