import { describe, expect, test } from "bun:test";
import { decodeGraphPayload, encodeGraphPayload, graphPayloadModuleSource } from "./graph-payload";
import type { GraphData } from "./types";

const graph: GraphData = {
	nodes: [
		{ id: "/", label: "Home", kind: "page", navigable: true, path: "index.md", ctime: 10 },
		{ id: "/tags/x", label: "#x", kind: "tag", navigable: false, path: "", ctime: 10 },
		{ id: "/tags/y", label: "#y", kind: "tag", navigable: true, path: "", ctime: 0 },
		{ id: "/a.png", label: "a.png", kind: "attachment", navigable: true, path: "a.png", ctime: 0 },
		{ id: "?ghost", label: "Ghost", kind: "unresolved", navigable: false, path: "Ghost", ctime: 0 },
	],
	links: [
		{ source: "/", target: "/tags/x" },
		{ source: "/", target: "?ghost" },
	],
};

describe("graph payload", () => {
	test("round-trips every node kind and link", () => {
		expect(decodeGraphPayload(encodeGraphPayload(graph, "/docs/"))).toEqual(graph);
	});

	test("links ship as index pairs and route strings appear once", () => {
		const payload = encodeGraphPayload(graph, "/");
		expect(payload.links).toEqual([0, 1, 0, 4]);
		expect(payload.kinds).toBe("pTtau");
		expect(JSON.stringify(payload).match(/"\/tags\/x"/g)).toHaveLength(1);
	});

	test("the module parses the payload from a JSON string literal", () => {
		const source = graphPayloadModuleSource(encodeGraphPayload(graph, "/"));
		expect(source).toStartWith("export const graphPayload = JSON.parse(");
		const literal = source.match(/JSON\.parse\((".*")\)/s)?.[1] ?? "";
		expect(decodeGraphPayload(JSON.parse(JSON.parse(literal)))).toEqual(graph);
	});
});
