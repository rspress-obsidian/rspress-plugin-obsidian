import type { GraphData, GraphNode, GraphNodeKind, GraphPayload } from "./types.js";

/**
 * The wire alphabet: one character per (kind, navigability) pair, decoded by
 * reading this table. Some kinds only ever occur one way — a page always
 * navigates, an unresolved link never does — so their single letter carries
 * that meaning instead of a second letter that would never be written.
 */
const NODE_CODES: Record<string, { readonly kind: GraphNodeKind; readonly navigable: boolean }> = {
	p: { kind: "page", navigable: true },
	T: { kind: "tag", navigable: false },
	t: { kind: "tag", navigable: true },
	a: { kind: "attachment", navigable: true },
	u: { kind: "unresolved", navigable: false },
};

/** The letter each `(kind, navigable)` pair is written as, for {@link encodeGraphPayload}. */
const CODE_BY_MEANING = new Map<string, string>(
	Object.entries(NODE_CODES).map(([code, { kind, navigable }]) => [`${kind}:${navigable}`, code]),
);

/**
 * The wire code for one node's pair.
 *
 * Every pair the graph builder emits is in `NODE_CODES`, so a missing one is a
 * builder bug; throwing here names the pair instead of writing a letter that
 * decodes as some other kind.
 */
function wireCode(node: GraphNode): string {
	const code = CODE_BY_MEANING.get(`${node.kind}:${node.navigable}`);
	if (code === undefined) {
		throw new Error(`graph payload has no wire code for ${node.kind}:${node.navigable}`);
	}
	return code;
}

export function encodeGraphPayload(graph: GraphData, base: string): GraphPayload {
	const indexById = new Map<string, number>();
	const payload: GraphPayload = {
		base,
		ids: [],
		labels: [],
		kinds: "",
		paths: [],
		ctimes: [],
		links: [],
	};
	let kinds = "";
	graph.nodes.forEach((node, index) => {
		indexById.set(node.id, index);
		payload.ids.push(node.id);
		payload.labels.push(node.label);
		kinds += wireCode(node);
		payload.paths.push(node.path);
		payload.ctimes.push(Math.round(node.ctime));
	});
	payload.kinds = kinds;
	for (const link of graph.links) {
		const source = indexById.get(link.source);
		const target = indexById.get(link.target);
		if (source === undefined || target === undefined) continue;
		payload.links.push(source, target);
	}
	return payload;
}

/** Module source for `virtual-graph-data`. `JSON.parse` of a string literal parses faster than an object literal. */
export function graphPayloadModuleSource(payload: GraphPayload): string {
	return `export const graphPayload = JSON.parse(${JSON.stringify(JSON.stringify(payload))});\nexport default graphPayload;\n`;
}

export function decodeGraphPayload(payload: GraphPayload): GraphData {
	const nodes: GraphNode[] = payload.ids.map((id, index) => {
		// `kinds` can be shorter than `ids` in a payload an older bundle wrote; a
		// node with no code decodes as a navigable page.
		const code = NODE_CODES[payload.kinds[index] ?? ""];
		return {
			id,
			label: payload.labels[index] ?? id,
			kind: code?.kind ?? "page",
			navigable: code?.navigable ?? true,
			path: payload.paths[index] ?? "",
			ctime: payload.ctimes[index] ?? 0,
		};
	});
	const links: GraphData["links"] = [];
	for (let index = 0; index + 1 < payload.links.length; index += 2) {
		const source = nodes[payload.links[index] ?? -1];
		const target = nodes[payload.links[index + 1] ?? -1];
		if (source && target) links.push({ source: source.id, target: target.id });
	}
	return { nodes, links };
}
