/**
 * What a graph node stands for, mirroring the node kinds Obsidian's graph
 * draws: a published note, a tag, an attachment a note links to, and an
 * unresolved link target (a "ghost" node, shown when "Existing files only" is
 * off).
 */
export type GraphNodeKind = "page" | "tag" | "attachment" | "unresolved";

export interface GraphNode {
	/**
	 * Unique id. Pages and tags use their route path, attachments their
	 * site-relative URL path, and unresolved targets a `?`-prefixed key that can
	 * never collide with a route.
	 */
	id: string;
	label: string;
	kind: GraphNodeKind;
	/**
	 * Whether clicking the node can open something: every page and attachment, a
	 * tag only when the markdown plugin generated its tag page.
	 */
	navigable: boolean;
	/** Vault- or docs-relative file path (`path:`/`file:` queries match it); empty when none. */
	path: string;
	/** File creation time in ms since the epoch, for the timelapse; 0 when unknown. */
	ctime: number;
}

/** A directed link: `source` links to `target`. */
export interface GraphLink {
	source: string;
	target: string;
}

export interface GraphData {
	nodes: GraphNode[];
	links: GraphLink[];
}

/**
 * The wire format of `virtual-graph-data`: column arrays and index-pair links,
 * so a 5,000-note vault does not repeat every route string three times. Built by
 * `encodeGraphPayload` and read back by `decodeGraphPayload`.
 */
export interface GraphPayload {
	/** Site `base` (always `/…/`), for links Rspress's router does not prefix. */
	base: string;
	ids: string[];
	labels: string[];
	/** One character per node: `p` page, `t` tag with a page, `T` tag without, `a` attachment, `u` unresolved. */
	kinds: string;
	paths: string[];
	ctimes: number[];
	/** Flat `[source, target, source, target, …]` node indexes. */
	links: number[];
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

/** One page's text for `content:`/`line:`/`section:` graph searches. */
export interface GraphSearchEntry {
	id: string;
	/** Markdown source with frontmatter and comments removed. */
	text: string;
}
