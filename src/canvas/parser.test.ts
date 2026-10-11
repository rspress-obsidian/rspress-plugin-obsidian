import { expect, test } from "bun:test";
import fc from "fast-check";
import { CanvasParseError, parseCanvas, serializeCanvas } from "./parser";
import type { CanvasEdgeData, CanvasNode } from "./types";

const validCanvas = JSON.stringify({
	nodes: [
		{
			id: "n1",
			type: "text",
			x: 0,
			y: 0,
			width: 100,
			height: 100,
			text: "hello",
		},
	],
	edges: [],
});

test("parses valid canvas with empty edges", () => {
	const data = parseCanvas(validCanvas);
	expect(data.nodes).toHaveLength(1);
	expect(data.edges).toHaveLength(0);
	expect(data.nodes[0]?.id).toBe("n1");
});

test("parses canvas with missing nodes/edges arrays", () => {
	const data = parseCanvas("{}");
	expect(data.nodes).toHaveLength(0);
	expect(data.edges).toHaveLength(0);
});

test("parses all four node types", () => {
	const json = JSON.stringify({
		nodes: [
			{
				id: "t1",
				type: "text",
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				text: "hello",
			},
			{
				id: "f1",
				type: "file",
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				file: "Note.md",
				subpath: "#heading",
			},
			{
				id: "l1",
				type: "link",
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				url: "https://example.com",
			},
			{
				id: "g1",
				type: "group",
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				label: "Group",
				background: "bg.png",
				backgroundStyle: "cover",
			},
		],
		edges: [],
	});
	const data = parseCanvas(json);
	expect(data.nodes).toHaveLength(4);
	expect(data.nodes[0]?.type).toBe("text");
	expect(data.nodes[1]?.type).toBe("file");
	expect(data.nodes[2]?.type).toBe("link");
	expect(data.nodes[3]?.type).toBe("group");

	const textNode = data.nodes[0] as CanvasNode;
	if (textNode.type === "text") expect(textNode.text).toBe("hello");

	const fileNode = data.nodes[1] as CanvasNode;
	if (fileNode.type === "file") {
		expect(fileNode.file).toBe("Note.md");
		expect(fileNode.subpath).toBe("#heading");
	}

	const linkNode = data.nodes[2] as CanvasNode;
	if (linkNode.type === "link") expect(linkNode.url).toBe("https://example.com");

	const groupNode = data.nodes[3] as CanvasNode;
	if (groupNode.type === "group") {
		expect(groupNode.label).toBe("Group");
		expect(groupNode.background).toBe("bg.png");
		expect(groupNode.backgroundStyle).toBe("cover");
	}
});

test("parses optional fields correctly", () => {
	const json = JSON.stringify({
		nodes: [
			{
				id: "n1",
				type: "text",
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				text: "hi",
				color: "4",
			},
		],
		edges: [
			{
				id: "e1",
				fromNode: "n1",
				toNode: "n1",
				fromSide: "right",
				toSide: "left",
				fromEnd: "arrow",
				toEnd: "none",
				color: "#ff0000",
				label: "test",
			},
		],
	});
	const data = parseCanvas(json);
	expect(data.nodes[0]?.color).toBe("4");
	const edge = data.edges[0] as CanvasEdgeData;
	expect(edge.fromSide).toBe("right");
	expect(edge.toSide).toBe("left");
	expect(edge.fromEnd).toBe("arrow");
	expect(edge.toEnd).toBe("none");
	expect(edge.color).toBe("#ff0000");
	expect(edge.label).toBe("test");
});

test("edge defaults: missing fromSide/toSide/fromEnd/toEnd are undefined", () => {
	const json = JSON.stringify({
		nodes: [
			{
				id: "n1",
				type: "text",
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				text: "hi",
			},
		],
		edges: [{ id: "e1", fromNode: "n1", toNode: "n1" }],
	});
	const data = parseCanvas(json);
	const edge = data.edges[0] as CanvasEdgeData;
	expect(edge.fromSide).toBeUndefined();
	expect(edge.toSide).toBeUndefined();
	expect(edge.fromEnd).toBeUndefined();
	expect(edge.toEnd).toBeUndefined();
});

// A structurally broken document is still a hard error: there is nothing to
// render, so a partial board would be worse than a clear failure.
test("throws on invalid JSON", () => {
	expect(() => parseCanvas("not json")).toThrow(CanvasParseError);
});

test("throws on non-object JSON", () => {
	expect(() => parseCanvas(JSON.stringify("string"))).toThrow(CanvasParseError);
	expect(() => parseCanvas("[]")).toThrow(CanvasParseError);
	expect(() => parseCanvas("42")).toThrow(CanvasParseError);
	expect(() => parseCanvas("null")).toThrow(CanvasParseError);
});

test("throws when nodes is not an array", () => {
	const json = JSON.stringify({ nodes: "bad" });
	expect(() => parseCanvas(json)).toThrow(/nodes must be an array/);
});

test("throws when edges is not an array", () => {
	const json = JSON.stringify({ edges: "bad" });
	expect(() => parseCanvas(json)).toThrow(/edges must be an array/);
});

test("skips invalid node type", () => {
	const json = JSON.stringify({
		nodes: [{ id: "n1", type: "unknown", x: 0, y: 0, width: 100, height: 100 }],
		edges: [],
	});
	expect(firstProblem(json)).toMatch(/Invalid node type/);
});

test("skips missing required node fields", () => {
	const json = JSON.stringify({
		nodes: [{ id: "n1", type: "text", x: 0, y: 0 }],
		edges: [],
	});
	expect(parseCanvas(json).problems?.join("\n")).toMatch(/width|width must be/);
});

test("skips missing text for text node", () => {
	const json = JSON.stringify({
		nodes: [{ id: "n1", type: "text", x: 0, y: 0, width: 100, height: 100 }],
		edges: [],
	});
	expect(firstProblem(json)).toMatch(/node\.text/);
});

test("skips missing file for file node", () => {
	const json = JSON.stringify({
		nodes: [{ id: "n1", type: "file", x: 0, y: 0, width: 100, height: 100 }],
		edges: [],
	});
	expect(firstProblem(json)).toMatch(/node\.file/);
});

test("skips missing url for link node", () => {
	const json = JSON.stringify({
		nodes: [{ id: "n1", type: "link", x: 0, y: 0, width: 100, height: 100 }],
		edges: [],
	});
	expect(firstProblem(json)).toMatch(/node\.url/);
});

test("skips invalid fromSide", () => {
	const json = JSON.stringify({
		nodes: [
			{
				id: "n1",
				type: "text",
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				text: "hi",
			},
		],
		edges: [{ id: "e1", fromNode: "n1", toNode: "n1", fromSide: "center" }],
	});
	expect(firstProblem(json)).toMatch(/Invalid fromSide/);
});

test("skips invalid toSide", () => {
	const json = JSON.stringify({
		nodes: [
			{
				id: "n1",
				type: "text",
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				text: "hi",
			},
		],
		edges: [{ id: "e1", fromNode: "n1", toNode: "n1", toSide: "middle" }],
	});
	expect(firstProblem(json)).toMatch(/Invalid toSide/);
});

test("skips invalid fromEnd", () => {
	const json = JSON.stringify({
		nodes: [
			{
				id: "n1",
				type: "text",
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				text: "hi",
			},
		],
		edges: [{ id: "e1", fromNode: "n1", toNode: "n1", fromEnd: "circle" }],
	});
	expect(firstProblem(json)).toMatch(/Invalid fromEnd/);
});

test("skips invalid toEnd", () => {
	const json = JSON.stringify({
		nodes: [
			{
				id: "n1",
				type: "text",
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				text: "hi",
			},
		],
		edges: [{ id: "e1", fromNode: "n1", toNode: "n1", toEnd: "diamond" }],
	});
	expect(firstProblem(json)).toMatch(/Invalid toEnd/);
});

test("skips when edge references nonexistent node", () => {
	const json = JSON.stringify({
		nodes: [
			{
				id: "n1",
				type: "text",
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				text: "hi",
			},
		],
		edges: [{ id: "e1", fromNode: "n1", toNode: "ghost" }],
	});
	expect(firstProblem(json)).toMatch(/Skipped edge "e1": endpoint is not a rendered node$/);
});

test("skips when edge references nonexistent fromNode", () => {
	const json = JSON.stringify({
		nodes: [
			{
				id: "n1",
				type: "text",
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				text: "hi",
			},
		],
		edges: [{ id: "e1", fromNode: "ghost", toNode: "n1" }],
	});
	expect(firstProblem(json)).toMatch(/Skipped edge "e1": endpoint is not a rendered node$/);
});

test("skips a node whose geometry is not finite", () => {
	const json = JSON.stringify({
		nodes: [
			{
				id: "n1",
				type: "text",
				x: NaN,
				y: 0,
				width: 100,
				height: 100,
				text: "hi",
			},
		],
		edges: [],
	});
	expect(firstProblem(json)).toMatch(/node\.x.*finite number/);
});

test("accepts hex, preset and rgb colours", () => {
	const json = JSON.stringify({
		nodes: [
			{
				id: "n1",
				type: "text",
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				text: "a",
				color: "#ff0000",
			},
			{
				id: "n2",
				type: "text",
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				text: "b",
				color: "3",
			},
			{
				id: "n3",
				type: "text",
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				text: "c",
				color: "rgb(255,0,0)",
			},
		],
		edges: [],
	});
	const data = parseCanvas(json);
	expect(data.nodes[0]?.color).toBe("#ff0000");
	expect(data.nodes[1]?.color).toBe("3");
	expect(data.nodes[2]?.color).toBe("rgb(255,0,0)");
});

test("treats subpath as optional on file nodes", () => {
	const json = JSON.stringify({
		nodes: [
			{
				id: "n1",
				type: "file",
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				file: "Note.md",
			},
		],
		edges: [],
	});
	const data = parseCanvas(json);
	const node = data.nodes[0] as CanvasNode;
	if (node.type === "file") expect(node.subpath).toBeUndefined();
});

test("treats label and background as optional on group nodes", () => {
	const json = JSON.stringify({
		nodes: [{ id: "n1", type: "group", x: 0, y: 0, width: 100, height: 100 }],
		edges: [],
	});
	const data = parseCanvas(json);
	const node = data.nodes[0] as CanvasNode;
	if (node.type === "group") {
		expect(node.label).toBeUndefined();
		expect(node.background).toBeUndefined();
	}
});

test("drops publisher-only fields from a source board", () => {
	// Fields earlier versions wrote into published boards (and editor exports),
	// and the current build-time ones: a source file must not be able to steer
	// what the published page loads.
	const json = JSON.stringify({
		nodes: [
			{
				id: "n1",
				type: "file",
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				file: "Welcome.md",
				fileContent: "Hello world content",
				imageUrl: "data:image/png;base64,123",
				isImage: true,
				resolvedFile: { kind: "image", key: "evil.png" },
			},
		],
		edges: [],
		assets: { "evil.png": "https://evil.example/x.png" },
		notes: { "a.md": "x" },
		links: { "": {} },
	});
	const data = parseCanvas(json);
	expect(Object.keys(data.nodes[0] ?? {}).sort()).toEqual(
		["file", "height", "id", "type", "width", "x", "y"].sort(),
	);
	expect(data.assets).toBeUndefined();
	expect(data.notes).toBeUndefined();
	expect(data.links).toBeUndefined();
});

test("keeps unknown node, edge and document fields for a lossless round trip", () => {
	const source = {
		metadata: { version: "1.0" },
		nodes: [
			{
				id: "a",
				type: "text",
				x: 0,
				y: 0,
				width: 10,
				height: 10,
				text: "A",
				styleAttributes: { shape: "pill" },
				extra: 1,
			},
			{ id: "b", type: "text", x: 20, y: 0, width: 10, height: 10, text: "B" },
		],
		edges: [{ id: "e", fromNode: "a", toNode: "b", styleAttributes: { path: "dotted" } }],
	};
	const data = parseCanvas(JSON.stringify(source));
	expect(JSON.parse(serializeCanvas(data))).toEqual(source);
});

test("reads the build-time fields of a published board when asked to", () => {
	const json = JSON.stringify({
		nodes: [
			{
				id: "n1",
				type: "file",
				x: 0,
				y: 0,
				width: 1,
				height: 1,
				file: "pic.png",
				resolvedFile: { kind: "image", key: "pic.png" },
			},
			{ id: "g", type: "group", x: 0, y: 0, width: 1, height: 1, resolvedBackground: "bg.png" },
		],
		assets: { "pic.png": "/vault/pic.png" },
		notes: { "a.md": "hello" },
		links: { "": { Loose: { href: "/vault/loose", label: "Loose" } } },
	});
	const data = parseCanvas(json, { enriched: true });
	expect(data.nodes[0]).toMatchObject({ resolvedFile: { kind: "image", key: "pic.png" } });
	expect(data.nodes[1]).toMatchObject({ resolvedBackground: "bg.png" });
	expect(data.assets).toEqual({ "pic.png": "/vault/pic.png" });
	expect(data.notes).toEqual({ "a.md": "hello" });
	expect(data.links?.[""]?.Loose).toEqual({ href: "/vault/loose", label: "Loose" });
	// An unknown kind is a malformed node, reported and skipped.
	const bad = parseCanvas(
		JSON.stringify({
			nodes: [
				{
					id: "x",
					type: "file",
					x: 0,
					y: 0,
					width: 1,
					height: 1,
					file: "a",
					resolvedFile: { kind: "zip" },
				},
			],
		}),
		{ enriched: true },
	);
	expect(bad.problems?.[0]).toMatch(/Invalid node\.resolvedFile\.kind: zip/);
});

test("export strips every build-time field and map", () => {
	const published = parseCanvas(
		JSON.stringify({
			nodes: [
				{
					id: "n1",
					type: "file",
					x: 0,
					y: 0,
					width: 1,
					height: 1,
					file: "pic.png",
					resolvedFile: { kind: "image", key: "pic.png" },
				},
			],
			edges: [],
			assets: { "pic.png": "/vault/pic.png" },
			notes: { "a.md": "hello" },
		}),
		{ enriched: true },
	);
	const exported = JSON.parse(serializeCanvas(published));
	expect(exported).toEqual({
		nodes: [{ id: "n1", type: "file", x: 0, y: 0, width: 1, height: 1, file: "pic.png" }],
		edges: [],
	});
	// Re-importing the export is the source board again.
	expect(serializeCanvas(parseCanvas(serializeCanvas(published)))).toBe(serializeCanvas(published));
});

test("parses real Demo.canvas file", async () => {
	const content = await Bun.file("Obsidian Vault/Demo.canvas").text();
	const data = parseCanvas(content);

	// The point is that the board shipped in this repository is valid, not that
	// it holds a particular number of cards — the demo grows, and pinning its
	// shape here would fail on a demo edit rather than on a real defect.
	expect(data.problems).toEqual([]);
	expect(data.edges.length).toBeGreaterThan(0);
	const types = new Set(data.nodes.map((n) => n.type));
	for (const type of ["text", "file", "link", "group"]) {
		expect(types.has(type as (typeof data.nodes)[number]["type"])).toBe(true);
	}
});
test("accepts fractional geometry", () => {
	const canvas = {
		nodes: [
			{
				id: "n1",
				type: "text",
				x: 0.5,
				y: -10.25,
				width: 100,
				height: 100,
				text: "text",
			},
		],
		edges: [],
	};
	const data = parseCanvas(JSON.stringify(canvas));
	expect(data.nodes[0]?.x).toBe(0.5);
	expect(data.nodes[0]?.y).toBe(-10.25);
});

test("skips non-finite geometry", () => {
	for (const value of [Infinity, -Infinity, NaN]) {
		const board = {
			nodes: [{ id: "n1", type: "text", x: value, y: 0, width: 100, height: 100, text: "text" }],
			edges: [],
		};
		expect(firstProblem(JSON.stringify(board))).toMatch(/node\.x.*finite number/);
	}
});

test("keeps the first of a duplicated id and reports the rest", () => {
	// A copy-pasted card must not make the node it duplicates unaddressable, and
	// it must not cost the board the node that was already there.
	const duplicateNodes = {
		nodes: [
			{ id: "n1", type: "text", x: 0, y: 0, width: 100, height: 100, text: "a" },
			{ id: "n1", type: "text", x: 100, y: 0, width: 100, height: 100, text: "b" },
		],
		edges: [],
	};
	const nodes = parseCanvas(JSON.stringify(duplicateNodes));
	expect(nodes.nodes).toHaveLength(1);
	expect(nodes.problems?.[0]).toMatch(/Skipped duplicate node id: "n1"$/);

	const duplicateEdges = {
		nodes: [
			{ id: "n1", type: "text", x: 0, y: 0, width: 100, height: 100, text: "a" },
			{ id: "n2", type: "text", x: 100, y: 0, width: 100, height: 100, text: "b" },
		],
		edges: [
			{ id: "e1", fromNode: "n1", toNode: "n2" },
			{ id: "e1", fromNode: "n2", toNode: "n1" },
		],
	};
	const edges = parseCanvas(JSON.stringify(duplicateEdges));
	expect(edges.edges).toHaveLength(1);
	expect(edges.problems?.[0]).toMatch(/Skipped duplicate edge id: "e1"$/);
});

function textNode(overrides: Record<string, unknown> = {}) {
	return { id: "n1", type: "text", x: 0, y: 0, width: 100, height: 100, text: "hi", ...overrides };
}

function canvas(overrides: Record<string, unknown>) {
	return JSON.stringify({ nodes: [textNode()], edges: [], ...overrides });
}
/**
 * The reason the parser recorded for the item it dropped.
 *
 * A malformed node or edge is skipped and reported rather than thrown, so every
 * per-item assertion goes through here. A document-level failure — unparseable
 * JSON, `nodes` not an array, a malformed asset map — still throws, and those
 * tests assert `toThrow` instead.
 */
function firstProblem(json: string): string {
	return parseCanvas(json).problems?.[0] ?? "";
}

test("throws on a document-level failure but only reports an item-level one", () => {
	// Unparseable JSON leaves nothing to render, so it is still a hard error.
	expect(() => parseCanvas("{oops")).toThrow(CanvasParseError);
	expect(() => parseCanvas("{oops")).toThrow(/^Canvas parse error: Invalid JSON: /);

	// A malformed node is dropped and reported, and the reason names the node so
	// a broken file can be fixed rather than silently losing a card.
	const semantic = parseCanvas(canvas({ nodes: [textNode({ type: "blob" })] }));
	expect(semantic.nodes).toHaveLength(0);
	expect(semantic.problems?.[0]).toMatch(/^Skipped node 0 "n1"/);
	expect(semantic.problems?.[0]).toMatch(/Invalid node type: blob$/);
});

test("names the missing field when a required node field has the wrong type", () => {
	expect(firstProblem(canvas({ nodes: [textNode({ id: 7 })] }))).toMatch(
		/Expected node\.id to be a string, got number$/,
	);
	expect(firstProblem(canvas({ nodes: [textNode({ type: null })] }))).toMatch(
		/Expected node\.type to be a string, got object$/,
	);
	expect(firstProblem(canvas({ nodes: [textNode({ width: "100" })] }))).toMatch(
		/Expected node\.width to be a finite number, got string$/,
	);
});

test("skips nodes that are not objects", () => {
	for (const node of [42, "n1", null, true]) {
		expect(firstProblem(JSON.stringify({ nodes: [node] }))).toMatch(/Node must be an object$/);
	}
});

test("skips a non-string optional node field", () => {
	expect(firstProblem(canvas({ nodes: [textNode({ color: 3 })] }))).toMatch(
		/Expected node\.color to be a string, got number$/,
	);
	expect(
		firstProblem(
			canvas({
				nodes: [
					{ id: "f1", type: "file", x: 0, y: 0, width: 1, height: 1, file: "a.md", subpath: 9 },
				],
			}),
		),
	).toMatch(/Expected node\.subpath to be a string, got number$/);
});

test("skips an unknown group backgroundStyle", () => {
	const group = {
		id: "g1",
		type: "group",
		x: 0,
		y: 0,
		width: 1,
		height: 1,
		backgroundStyle: "diagonal",
	};
	expect(firstProblem(JSON.stringify({ nodes: [group] }))).toMatch(
		/Invalid backgroundStyle: diagonal$/,
	);
});

test("skips edges that are not objects or are missing their identity fields", () => {
	for (const edge of [42, null]) {
		expect(firstProblem(JSON.stringify({ nodes: [], edges: [edge] }))).toMatch(
			/Edge must be an object$/,
		);
	}
	expect(firstProblem(canvas({ edges: [{}] }))).toMatch(
		/Expected edge\.id to be a string, got undefined$/,
	);
	expect(firstProblem(canvas({ edges: [{ id: "e1" }] }))).toMatch(
		/Expected edge\.fromNode to be a string, got undefined$/,
	);
	expect(firstProblem(canvas({ edges: [{ id: "e1", fromNode: "n1" }] }))).toMatch(
		/Expected edge\.toNode to be a string, got undefined$/,
	);
});

test("skips a non-string optional edge field", () => {
	expect(
		firstProblem(canvas({ edges: [{ id: "e1", fromNode: "n1", toNode: "n1", color: 5 }] })),
	).toMatch(/Expected edge\.color to be a string, got number$/);
});

test("carries the offending ids so a broken file can be fixed", () => {
	expect(
		firstProblem(JSON.stringify({ nodes: [textNode({ id: "dup" }), textNode({ id: "dup" })] })),
	).toMatch(/Skipped duplicate node id: "dup"$/);

	expect(
		firstProblem(
			JSON.stringify({
				nodes: [textNode({ id: "a" }), textNode({ id: "b" })],
				edges: [
					{ id: "e9", fromNode: "a", toNode: "b" },
					{ id: "e9", fromNode: "b", toNode: "a" },
				],
			}),
		),
	).toMatch(/Skipped duplicate edge id: "e9"$/);

	// A dangling edge is dropped with the edge named, so a broken file can be
	// fixed: it is the endpoint that is missing, not the edge.
	expect(firstProblem(canvas({ edges: [{ id: "e1", fromNode: "ghost", toNode: "n1" }] }))).toMatch(
		/Skipped edge "e1": endpoint is not a rendered node$/,
	);

	expect(firstProblem(canvas({ edges: [{ id: "e1", fromNode: "n1", toNode: "ghost" }] }))).toMatch(
		/Skipped edge "e1": endpoint is not a rendered node$/,
	);
});

test("parses asset and note maps of a published board", () => {
	const data = parseCanvas(
		canvas({ assets: { "img.png": "https://cdn/img.png" }, notes: { "a.md": "hello" } }),
		{ enriched: true },
	);
	expect(data.assets).toEqual({ "img.png": "https://cdn/img.png" });
	expect(data.notes).toEqual({ "a.md": "hello" });
});

test("leaves asset and note maps undefined when the file omits them", () => {
	const data = parseCanvas(canvas({}), { enriched: true });
	expect(data.assets).toBeUndefined();
	expect(data.notes).toBeUndefined();
});

// The asset and note maps are document-level, not per-item, so a wrong map is
// still a hard error — there is no partial reading of it worth rendering.
test("rejects malformed asset and note maps", () => {
	const enriched = { enriched: true };
	for (const assets of ["", 3, null, []]) {
		expect(() => parseCanvas(canvas({ assets }), enriched)).toThrow(/assets must be an object/);
	}
	for (const notes of ["", 3, null, []]) {
		expect(() => parseCanvas(canvas({ notes }), enriched)).toThrow(/notes must be an object/);
	}
	expect(() => parseCanvas(canvas({ assets: { "img.png": 5 } }), enriched)).toThrow(
		/Expected assets\.img\.png to be a string, got number/,
	);
	expect(() => parseCanvas(canvas({ notes: { "a.md": 5 } }), enriched)).toThrow(
		/Expected notes\.a\.md to be a string, got number/,
	);
});

test("property: any JSON input either parses or throws CanvasParseError", () => {
	// The build treats a malformed board as a logged, non-fatal error while
	// the raw board stays published — that promise holds only if nothing else
	// (TypeError, SyntaxError, RangeError) can escape the parser.
	fc.assert(
		fc.property(fc.json(), (json) => {
			try {
				const parsed = parseCanvas(json);
				return Array.isArray(parsed.nodes) && Array.isArray(parsed.edges);
			} catch (error) {
				return error instanceof CanvasParseError;
			}
		}),
	);
});
