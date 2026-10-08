import { encodeGraphPayload } from "../../graph-payload";
import type { GraphData, GraphLink, GraphNode, GraphNodeKind, GraphPayload } from "../../types";

/** A graph node with the fields the runtime reads; pages by default. */
export function graphNode(id: string, label = id, kind: GraphNodeKind = "page"): GraphNode {
	return {
		id,
		label,
		kind,
		navigable: kind !== "unresolved",
		path: kind === "page" ? `${id.slice(1) || "index"}.md` : "",
		ctime: 0,
	};
}

/** The module `virtual-graph-data` exports for a graph, as the build emits it. */
export function graphDataModule(nodes: GraphNode[], links: GraphLink[], base = "/") {
	const graph: GraphData = { nodes, links };
	const graphPayload: GraphPayload = encodeGraphPayload(graph, base);
	return { graphPayload, default: graphPayload };
}
