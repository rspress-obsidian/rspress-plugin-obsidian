import type { GraphData, GraphNode, GraphNodeKind, GraphPayload } from "./types.js";

const KIND_CODE: Record<GraphNodeKind, readonly [navigable: string, inert: string]> = {
	page: ["p", "p"],
	tag: ["t", "T"],
	attachment: ["a", "a"],
	unresolved: ["u", "u"],
};

const NODE_BY_CODE: Record<string, { kind: GraphNodeKind; navigable: boolean }> = {
	p: { kind: "page", navigable: true },
	t: { kind: "tag", navigable: true },
	T: { kind: "tag", navigable: false },
	a: { kind: "attachment", navigable: true },
	u: { kind: "unresolved", navigable: false },
};

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
		kinds += KIND_CODE[node.kind][node.navigable ? 0 : 1];
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
		const code = NODE_BY_CODE[payload.kinds[index] ?? "p"] ?? NODE_BY_CODE.p;
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
