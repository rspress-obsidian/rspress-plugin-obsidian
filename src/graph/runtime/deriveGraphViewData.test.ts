import { describe, expect, test } from "bun:test";
import type { GraphData, GraphNode, GraphNodeKind } from "../types";
import {
	createGraphIndex,
	type DerivedGraphViewData,
	deriveGraphViewData,
	LARGE_GRAPH_NODE_THRESHOLD,
	MAX_DEPTH,
	MAX_GLOBAL_NODES,
	MAX_NEIGHBORS,
	normalizeClientRoutePath,
} from "./deriveGraphViewData";

function node(id: string, label = id, kind: GraphNodeKind = "page"): GraphNode {
	return {
		id,
		label,
		kind,
		navigable: kind !== "unresolved",
		path: kind === "page" ? `${id.slice(1) || "index"}.md` : "",
		ctime: 0,
	};
}

const idsOf = (derived: DerivedGraphViewData) => derived.nodes.map((entry) => entry.id).sort();
const linksOf = (derived: DerivedGraphViewData) =>
	derived.links.map(({ source, target }) => `${source}→${target}`).sort();

describe("deriveGraphViewData", () => {
	test("returns the current node's neighborhood", () => {
		const graphIndex = createGraphIndex({
			nodes: [node("/", "Home"), node("/guide", "Guide"), node("/api", "API")],
			links: [
				{ source: "/", target: "/guide" },
				{ source: "/guide", target: "/api" },
			],
		});

		const derived = deriveGraphViewData(graphIndex, "/guide");

		expect(idsOf(derived)).toEqual(["/", "/api", "/guide"]);
		expect(linksOf(derived)).toEqual(["/guide→/api", "/→/guide"]);
		expect(derived.isEmpty).toBe(false);
		expect(derived.nodes.find((entry) => entry.id === "/guide")?.isCurrent).toBe(true);
		expect(derived.neighborCount).toBe(2);
		expect(derived.neighborTotal).toBe(2);
	});

	test("a page outside the graph has no local graph but still sees the global one", () => {
		const graphIndex = createGraphIndex({
			nodes: [node("/"), node("/guide")],
			links: [{ source: "/", target: "/guide" }],
		});

		expect(deriveGraphViewData(graphIndex, "/missing").isEmpty).toBe(true);
		const global = deriveGraphViewData(graphIndex, "/missing", { scope: "global" });
		expect(idsOf(global)).toEqual(["/", "/guide"]);
		expect(global.nodes.some((entry) => entry.isCurrent)).toBe(false);
	});

	test("an orphan current page shows itself, as Obsidian's local graph does", () => {
		const graphIndex = createGraphIndex({ nodes: [node("/lonely"), node("/other")], links: [] });

		const derived = deriveGraphViewData(graphIndex, "/lonely");

		expect(derived.isEmpty).toBe(false);
		expect(idsOf(derived)).toEqual(["/lonely"]);
	});

	test("caps a hub's neighborhood at its highest-degree neighbors", () => {
		const neighborCount = MAX_NEIGHBORS + 3;
		const neighbors = Array.from({ length: neighborCount }, (_, index) =>
			node(`/n-${String(index).padStart(4, "0")}`),
		);
		// The last three neighbors fan out further, so they outrank the
		// single-link neighbors and must survive the cap.
		const boostedIds = neighbors.slice(-3).map((entry) => entry.id);
		const boostLinks = boostedIds.flatMap((id, index) =>
			Array.from({ length: index + 1 }, (_, k) => ({ source: id, target: `${id}-boost-${k}` })),
		);
		const graphData: GraphData = {
			nodes: [node("/hub"), ...neighbors, ...boostLinks.map(({ target }) => node(target))],
			links: [...neighbors.map((entry) => ({ source: "/hub", target: entry.id })), ...boostLinks],
		};

		const derived = deriveGraphViewData(createGraphIndex(graphData), "/hub");

		expect(derived.nodes).toHaveLength(MAX_NEIGHBORS + 1);
		const expectedIds = new Set([
			...boostedIds,
			...neighbors.slice(0, MAX_NEIGHBORS - boostedIds.length).map((entry) => entry.id),
		]);
		const nodeIds = new Set(derived.nodes.map((entry) => entry.id));
		for (const id of expectedIds) expect(nodeIds.has(id)).toBe(true);
		expect(derived.neighborCount).toBe(MAX_NEIGHBORS);
		expect(derived.neighborTotal).toBe(neighborCount);
		expect(derived.links).toHaveLength(MAX_NEIGHBORS);

		// Selection depends on degree and id only, not on graph input order.
		const reversed = deriveGraphViewData(
			createGraphIndex({
				nodes: [...graphData.nodes].reverse(),
				links: [...graphData.links].reverse(),
			}),
			"/hub",
		);
		expect(idsOf(reversed)).toEqual(idsOf(derived));
	});

	test("search runs before the render cap, so a match past the cap still shows", () => {
		const neighbors = Array.from({ length: MAX_NEIGHBORS + 3 }, (_, index) =>
			node(`/n-${String(index).padStart(4, "0")}`, `Neighbor ${index}`),
		);
		const graphIndex = createGraphIndex({
			nodes: [node("/hub", "Hub"), ...neighbors],
			links: neighbors.map((entry) => ({ source: "/hub", target: entry.id })),
		});

		const derived = deriveGraphViewData(graphIndex, "/hub", { query: "n-0252" });

		expect(idsOf(derived)).toEqual(["/hub", "/n-0252"]);
		expect(derived.neighborTotal).toBe(MAX_NEIGHBORS + 3);
	});

	test("marks a dense local neighborhood as large, not a dense whole graph", () => {
		const neighbors = Array.from({ length: LARGE_GRAPH_NODE_THRESHOLD + 1 }, (_, index) =>
			node(`/node-${index}`),
		);
		const graphIndex = createGraphIndex({
			nodes: [node("/hub"), ...neighbors],
			links: neighbors.map((entry) => ({ source: "/hub", target: entry.id })),
		});

		expect(deriveGraphViewData(graphIndex, "/hub").isLargeGraph).toBe(true);
		expect(deriveGraphViewData(graphIndex, "/node-0").isLargeGraph).toBe(false);
	});

	test("nodes carry their link count, which sizes them", () => {
		const graphIndex = createGraphIndex({
			nodes: [node("/a"), node("/b"), node("/c")],
			links: [
				{ source: "/a", target: "/b" },
				{ source: "/c", target: "/a" },
			],
		});
		const derived = deriveGraphViewData(graphIndex, "/a");
		expect(derived.nodes.find((entry) => entry.id === "/a")?.degree).toBe(2);
		expect(derived.nodes.find((entry) => entry.id === "/b")?.degree).toBe(1);
	});
});

describe("deriveGraphViewData filters", () => {
	// /guide links an ordinary page, its tag, an image and a missing note; the
	// tag connects to /plan, which links on to /deep.
	function fixtureGraph(): GraphData {
		return {
			nodes: [
				node("/guide", "Guide"),
				node("/api", "API"),
				node("/tags/project", "#Project", "tag"),
				node("/plan", "Plan"),
				node("/deep", "Deep"),
				node("/media/pic.png", "pic.png", "attachment"),
				node("?draft", "Draft", "unresolved"),
			],
			links: [
				{ source: "/guide", target: "/api" },
				{ source: "/guide", target: "/tags/project" },
				{ source: "/plan", target: "/tags/project" },
				{ source: "/plan", target: "/deep" },
				{ source: "/guide", target: "/media/pic.png" },
				{ source: "/guide", target: "?draft" },
			],
		};
	}

	test("Obsidian's defaults: tags shown, attachments and unresolved links hidden", () => {
		const derived = deriveGraphViewData(createGraphIndex(fixtureGraph()), "/guide");
		expect(idsOf(derived)).toEqual(["/api", "/guide", "/tags/project"]);
	});

	test("Attachments and Existing-files-only toggles reveal those nodes", () => {
		const graphIndex = createGraphIndex(fixtureGraph());
		const derived = deriveGraphViewData(graphIndex, "/guide", {
			showAttachments: true,
			existingOnly: false,
		});
		expect(idsOf(derived)).toEqual(["/api", "/guide", "/media/pic.png", "/tags/project", "?draft"]);
	});

	test("depth walks further than the default neighborhood", () => {
		const graphIndex = createGraphIndex(fixtureGraph());
		expect(idsOf(deriveGraphViewData(graphIndex, "/guide", { depth: 2 }))).toEqual([
			"/api",
			"/guide",
			"/plan",
			"/tags/project",
		]);
		expect(idsOf(deriveGraphViewData(graphIndex, "/guide", { depth: 3 }))).toContain("/deep");
	});

	test("depth is clamped to 1..MAX_DEPTH", () => {
		const graphIndex = createGraphIndex(fixtureGraph());
		expect(idsOf(deriveGraphViewData(graphIndex, "/guide", { depth: 0 }))).toEqual(
			idsOf(deriveGraphViewData(graphIndex, "/guide")),
		);
		expect(idsOf(deriveGraphViewData(graphIndex, "/guide", { depth: 999 }))).toEqual(
			idsOf(deriveGraphViewData(graphIndex, "/guide", { depth: MAX_DEPTH })),
		);
	});

	test("hidden tags do not connect the notes that share them", () => {
		const graphIndex = createGraphIndex(fixtureGraph());
		const derived = deriveGraphViewData(graphIndex, "/guide", { showTags: false, depth: 3 });
		expect(idsOf(derived)).toEqual(["/api", "/guide"]);
		expect(linksOf(derived)).toEqual(["/guide→/api"]);
	});

	test("incoming and outgoing toggles choose which links leave the current page", () => {
		const graphIndex = createGraphIndex({
			nodes: [node("/me"), node("/cites-me"), node("/i-cite")],
			links: [
				{ source: "/cites-me", target: "/me" },
				{ source: "/me", target: "/i-cite" },
			],
		});
		expect(idsOf(deriveGraphViewData(graphIndex, "/me", { incoming: false }))).toEqual([
			"/i-cite",
			"/me",
		]);
		expect(idsOf(deriveGraphViewData(graphIndex, "/me", { outgoing: false }))).toEqual([
			"/cites-me",
			"/me",
		]);
	});

	test("Neighbor links off drops links between pages at the same distance", () => {
		const graphIndex = createGraphIndex({
			nodes: [node("/me"), node("/a"), node("/b")],
			links: [
				{ source: "/me", target: "/a" },
				{ source: "/me", target: "/b" },
				{ source: "/a", target: "/b" },
			],
		});
		expect(linksOf(deriveGraphViewData(graphIndex, "/me"))).toContain("/a→/b");
		expect(linksOf(deriveGraphViewData(graphIndex, "/me", { neighborLinks: false }))).toEqual([
			"/me→/a",
			"/me→/b",
		]);
	});

	test("nodes carry their tag names so tag: queries can match them", () => {
		const derived = deriveGraphViewData(createGraphIndex(fixtureGraph()), "/guide", { depth: 2 });
		expect(derived.nodes.find((entry) => entry.id === "/plan")?.tags).toEqual(["project"]);
		expect(derived.nodes.find((entry) => entry.id === "/api")?.tags).toEqual([]);
	});

	test("search keeps the current page plus matching nodes", () => {
		const graphIndex = createGraphIndex(fixtureGraph());

		const matched = deriveGraphViewData(graphIndex, "/guide", { query: "api" });
		expect(idsOf(matched)).toEqual(["/api", "/guide"]);

		const nothing = deriveGraphViewData(graphIndex, "/guide", { query: "no-such-node" });
		expect(idsOf(nothing)).toEqual(["/guide"]);
	});

	test("tag: queries match tag nodes and the pages carrying the tag", () => {
		const graphIndex = createGraphIndex(fixtureGraph());
		const derived = deriveGraphViewData(graphIndex, "/guide", { depth: 2, query: "tag:project" });
		expect(idsOf(derived)).toEqual(["/guide", "/plan", "/tags/project"]);
	});

	test("content: queries match note text once it has loaded", () => {
		const graphIndex = createGraphIndex(fixtureGraph());
		const text = new Map([["/api", "Endpoints and rate limits"]]);
		expect(
			idsOf(deriveGraphViewData(graphIndex, "/guide", { query: "content:rate" }, text)),
		).toEqual(["/api", "/guide"]);
	});

	test("showOrphans false drops nodes stranded by the search", () => {
		const derived = deriveGraphViewData(createGraphIndex(fixtureGraph()), "/guide", {
			depth: 2,
			query: "plan",
			showOrphans: false,
		});
		expect(idsOf(derived)).toEqual(["/guide"]);
	});
});

describe("deriveGraphViewData global scope", () => {
	/** A chain of `count` pages, each linked to the next, plus an isolated one. */
	function chain(count: number): GraphData {
		const nodes = [node("/", "Home")];
		const links: GraphData["links"] = [];
		for (let index = 1; index <= count; index += 1) {
			nodes.push(node(`/p${index}`, `Page ${index}`));
			links.push({ source: index === 1 ? "/" : `/p${index - 1}`, target: `/p${index}` });
		}
		nodes.push(node("/island", "Island"));
		return { nodes, links };
	}

	test("the global scope shows pages far beyond the local depth", () => {
		const graphIndex = createGraphIndex(chain(6));
		expect(idsOf(deriveGraphViewData(graphIndex, "/", { depth: 1 }))).toEqual(["/", "/p1"]);
		const global = deriveGraphViewData(graphIndex, "/", { scope: "global" });
		expect(idsOf(global)).toHaveLength(8);
		expect(global.nodes.find((entry) => entry.id === "/")?.isCurrent).toBe(true);
	});

	test("the global scope keeps the toggles and the query", () => {
		const graphIndex = createGraphIndex(chain(4));
		expect(
			idsOf(deriveGraphViewData(graphIndex, "/", { scope: "global", showOrphans: false })),
		).not.toContain("/island");
		expect(
			idsOf(deriveGraphViewData(graphIndex, "/", { scope: "global", query: "Page 3" })),
		).toEqual(["/", "/p3"]);
	});

	test("the global scope caps drawn nodes and reports the rest", () => {
		const derived = deriveGraphViewData(createGraphIndex(chain(MAX_GLOBAL_NODES + 5)), "/", {
			scope: "global",
		});
		expect(derived.nodes).toHaveLength(MAX_GLOBAL_NODES + 1);
		expect(derived.truncatedCount).toBe(6);
	});
});

describe("normalizeClientRoutePath", () => {
	test("strips .html, trailing slashes and /index", () => {
		expect(normalizeClientRoutePath("/guide/configuration.html")).toBe("/guide/configuration");
		expect(normalizeClientRoutePath("/guide//")).toBe("/guide");
		expect(normalizeClientRoutePath("/guide/index.html")).toBe("/guide");
		expect(normalizeClientRoutePath("/index.html")).toBe("/");
		expect(normalizeClientRoutePath("/")).toBe("/");
	});

	test("decodes the router's percent-encoded path, so spaces and CJK routes match", () => {
		expect(normalizeClientRoutePath("/My%20Note")).toBe("/My Note");
		expect(
			normalizeClientRoutePath("/%E6%97%A5%E6%9C%AC%E8%AA%9E%E3%83%8E%E3%83%BC%E3%83%88"),
		).toBe("/日本語ノート");
	});

	test("folds decomposed unicode to NFC, the form route ids use", () => {
		expect(normalizeClientRoutePath("/Cafe\u0301")).toBe("/Caf\u00e9");
	});

	test("keeps a malformed escape as written", () => {
		expect(normalizeClientRoutePath("/100%")).toBe("/100%");
	});

	test("an encoded route finds its node in the graph", () => {
		const graphIndex = createGraphIndex({
			nodes: [node("/Deep Note"), node("/日本語ノート")],
			links: [{ source: "/Deep Note", target: "/日本語ノート" }],
		});
		const derived = deriveGraphViewData(graphIndex, normalizeClientRoutePath("/Deep%20Note"));
		expect(idsOf(derived)).toEqual(["/Deep Note", "/日本語ノート"]);
	});
});
