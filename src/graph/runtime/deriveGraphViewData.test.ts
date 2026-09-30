import { describe, expect, test } from "bun:test";
import type { GraphData } from "../types";
import {
	createGraphIndex,
	deriveGraphViewData,
	LARGE_GRAPH_NODE_THRESHOLD,
	MAX_DEPTH,
	MAX_GLOBAL_NODES,
	MAX_NEIGHBORS,
	normalizeClientRoutePath,
} from "./deriveGraphViewData";

describe("deriveGraphViewData", () => {
	test("returns the current node neighborhood without re-scanning the entire graph", () => {
		const graphData: GraphData = {
			nodes: [
				{ id: "/", label: "Home", routePath: "/" },
				{ id: "/guide", label: "Guide", routePath: "/guide" },
				{ id: "/api", label: "API", routePath: "/api" },
			],
			links: [
				{ source: "/", target: "/guide" },
				{ source: "/guide", target: "/api" },
			],
		};

		const graphIndex = createGraphIndex(graphData);
		const derived = deriveGraphViewData(graphIndex, "/guide");

		expect(derived.nodes.map((node) => node.id).sort()).toEqual(["/", "/api", "/guide"]);
		expect(derived.links.map(({ source, target }) => ({ source, target }))).toEqual([
			{ source: "/", target: "/guide" },
			{ source: "/guide", target: "/api" },
		]);
		expect(derived.isEmpty).toBe(false);
		expect(derived.nodes.find((node) => node.id === "/guide")?.isCurrent).toBe(true);
		expect(derived.neighborCount).toBe(2);
		expect(derived.neighborTotal).toBe(2);
	});

	test("returns an empty view when the current route is not present", () => {
		const graphData: GraphData = {
			nodes: [
				{ id: "/", label: "Home", routePath: "/" },
				{ id: "/guide", label: "Guide", routePath: "/guide" },
			],
			links: [{ source: "/", target: "/guide" }],
		};

		const graphIndex = createGraphIndex(graphData);
		const derived = deriveGraphViewData(graphIndex, "/missing");

		expect(derived.nodes).toEqual([]);
		expect(derived.links).toEqual([]);
		expect(derived.isEmpty).toBe(true);
	});

	test("caps a hub's neighborhood at its highest-degree neighbors", () => {
		const neighborCount = MAX_NEIGHBORS + 3;
		const neighbors = Array.from({ length: neighborCount }, (_, index) => ({
			id: `/n-${String(index).padStart(4, "0")}`,
			label: `Neighbor ${index}`,
			routePath: `/n-${String(index).padStart(4, "0")}`,
		}));
		// The last three neighbors fan out further, so they outrank the
		// single-link neighbors and must survive the cap.
		const boostedIds = neighbors.slice(-3).map((node) => node.id);
		const boostLinks = boostedIds.flatMap((id, index) =>
			Array.from({ length: index + 1 }, (_, k) => ({ source: id, target: `${id}-boost-${k}` })),
		);
		const graphData: GraphData = {
			nodes: [
				{ id: "/hub", label: "Hub", routePath: "/hub" },
				...neighbors,
				...boostLinks.map(({ target }) => ({ id: target, label: target, routePath: target })),
			],
			links: [...neighbors.map((node) => ({ source: "/hub", target: node.id })), ...boostLinks],
		};

		const derived = deriveGraphViewData(createGraphIndex(graphData), "/hub");

		// Current page plus at most MAX_NEIGHBORS neighbors.
		expect(derived.nodes).toHaveLength(MAX_NEIGHBORS + 1);
		expect(derived.nodes.find((node) => node.id === "/hub")?.isCurrent).toBe(true);

		// Degree descending, then id ascending: the boosted neighbors win, and
		// the remaining slots go to the lowest-id single-link neighbors.
		const expectedIds = new Set([
			...boostedIds,
			...neighbors.slice(0, MAX_NEIGHBORS - boostedIds.length).map((node) => node.id),
		]);
		const nodeIds = new Set(derived.nodes.map((node) => node.id));
		for (const id of expectedIds) {
			expect(nodeIds.has(id)).toBe(true);
		}
		const droppedIds = neighbors.filter((node) => !expectedIds.has(node.id)).map((node) => node.id);
		expect(droppedIds).toHaveLength(neighborCount - MAX_NEIGHBORS);
		for (const id of droppedIds) {
			expect(nodeIds.has(id)).toBe(false);
		}

		expect(derived.neighborCount).toBe(MAX_NEIGHBORS);
		expect(derived.neighborTotal).toBe(neighborCount);

		// Links to dropped neighbors are dropped too, and no link dangles.
		expect(derived.links).toHaveLength(MAX_NEIGHBORS);
		for (const { source, target } of derived.links) {
			expect(source).toBe("/hub");
			expect(nodeIds.has(source)).toBe(true);
			expect(nodeIds.has(target)).toBe(true);
		}

		// Selection depends on degree and id only, not on graph input order.
		const reversed = deriveGraphViewData(
			createGraphIndex({
				nodes: [...graphData.nodes].reverse(),
				links: [...graphData.links].reverse(),
			}),
			"/hub",
		);
		expect(reversed.nodes.map((node) => node.id)).toEqual(derived.nodes.map((node) => node.id));
	});

	test("search runs before the render cap, so a match past the cap still shows", () => {
		const neighbors = Array.from({ length: MAX_NEIGHBORS + 3 }, (_, index) => ({
			id: `/n-${String(index).padStart(4, "0")}`,
			label: `Neighbor ${index}`,
			routePath: `/n-${String(index).padStart(4, "0")}`,
		}));
		const graphData: GraphData = {
			nodes: [{ id: "/hub", label: "Hub", routePath: "/hub" }, ...neighbors],
			links: neighbors.map((node) => ({ source: "/hub", target: node.id })),
		};

		// All neighbors tie on degree, so the cap alone keeps the lowest ids
		// and drops the last three — including this match.
		const derived = deriveGraphViewData(createGraphIndex(graphData), "/hub", {
			query: "n-0252",
		});

		expect(derived.nodes.map((node) => node.id).sort()).toEqual(["/hub", "/n-0252"]);
		expect(derived.neighborCount).toBe(1);
		expect(derived.neighborTotal).toBe(MAX_NEIGHBORS + 3);
	});

	test("marks a dense local neighborhood as large, not a dense whole graph", () => {
		const neighborCount = LARGE_GRAPH_NODE_THRESHOLD + 1;
		const neighbors = Array.from({ length: neighborCount }, (_, index) => ({
			id: `/node-${index}`,
			label: `Node ${index}`,
			routePath: `/node-${index}`,
		}));
		const graphData: GraphData = {
			nodes: [{ id: "/hub", label: "Hub", routePath: "/hub" }, ...neighbors],
			links: neighbors.map((node) => ({ source: "/hub", target: node.id })),
		};

		const graphIndex = createGraphIndex(graphData);
		const hub = deriveGraphViewData(graphIndex, "/hub");
		const leaf = deriveGraphViewData(graphIndex, "/node-0");

		expect(hub.isLargeGraph).toBe(true);
		expect(hub.nodes).toHaveLength(neighborCount + 1);
		expect(leaf.isLargeGraph).toBe(false);
		expect(leaf.nodes).toHaveLength(2);
	});

	test("keeps only links incident to the current page", () => {
		const graphData: GraphData = {
			nodes: [
				{ id: "/a", label: "A", routePath: "/a" },
				{ id: "/b", label: "B", routePath: "/b" },
				{ id: "/c", label: "C", routePath: "/c" },
				{ id: "/x", label: "X", routePath: "/x" },
				{ id: "/y", label: "Y", routePath: "/y" },
			],
			links: [
				{ source: "/a", target: "/b" },
				{ source: "/b", target: "/c" },
				{ source: "/x", target: "/y" },
			],
		};

		const derived = deriveGraphViewData(createGraphIndex(graphData), "/b");

		expect(derived.links.map(({ source, target }) => ({ source, target }))).toEqual([
			{ source: "/a", target: "/b" },
			{ source: "/b", target: "/c" },
		]);
		expect(derived.nodes.map((node) => node.id).sort()).toEqual(["/a", "/b", "/c"]);
		expect(derived.isLargeGraph).toBe(false);
	});

	test("flags an isolated current page as empty", () => {
		const graphData: GraphData = {
			nodes: [
				{ id: "/lonely", label: "Lonely", routePath: "/lonely" },
				{ id: "/other", label: "Other", routePath: "/other" },
			],
			links: [],
		};

		const graphIndex = createGraphIndex(graphData);
		const derived = deriveGraphViewData(graphIndex, "/lonely");

		expect(derived.isEmpty).toBe(true);
		expect(derived.nodes.map((node) => node.id)).toEqual(["/lonely"]);
	});
});

describe("deriveGraphViewData filters", () => {
	// /guide's neighborhood: an ordinary neighbor, a tag page, a page carrying
	// that tag (two hops via the tag page) and a third-hop page behind it.
	// `/tags/project` links to `/plan` the way a generated tag index does, and
	// `/plan` links to its own tag as every tagged page does.
	function fixtureGraph(): GraphData {
		return {
			nodes: [
				{ id: "/guide", label: "Guide", routePath: "/guide" },
				{ id: "/api", label: "API", routePath: "/api" },
				{ id: "/tags/project", label: "project", routePath: "/tags/project" },
				{ id: "/plan", label: "Plan", routePath: "/plan" },
				{ id: "/deep", label: "Deep", routePath: "/deep" },
			],
			links: [
				{ source: "/guide", target: "/api" },
				{ source: "/guide", target: "/tags/project" },
				{ source: "/tags/project", target: "/plan" },
				{ source: "/plan", target: "/deep" },
				{ source: "/plan", target: "/tags/project" },
			],
		};
	}

	const idsOf = (derived: ReturnType<typeof deriveGraphViewData>) =>
		derived.nodes.map((node) => node.id).sort();

	test("depth walks further than the default neighborhood", () => {
		const graphIndex = createGraphIndex(fixtureGraph());

		expect(idsOf(deriveGraphViewData(graphIndex, "/guide"))).toEqual([
			"/api",
			"/guide",
			"/tags/project",
		]);
		expect(idsOf(deriveGraphViewData(graphIndex, "/guide", { depth: 2 }))).toEqual([
			"/api",
			"/guide",
			"/plan",
			"/tags/project",
		]);
		expect(idsOf(deriveGraphViewData(graphIndex, "/guide", { depth: 3 }))).toEqual([
			"/api",
			"/deep",
			"/guide",
			"/plan",
			"/tags/project",
		]);
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

	test("showTags false removes tag pages and their links", () => {
		const graphIndex = createGraphIndex(fixtureGraph());
		const derived = deriveGraphViewData(graphIndex, "/guide", { showTags: false });

		expect(idsOf(derived)).toEqual(["/api", "/guide"]);
		expect(derived.links).toEqual([{ source: "/guide", target: "/api" }]);
		expect(derived.neighborTotal).toBe(1);
	});

	test("nodes carry their own tag routes so tag: queries can match them", () => {
		const graphIndex = createGraphIndex(fixtureGraph());
		const derived = deriveGraphViewData(graphIndex, "/guide", { depth: 2 });

		expect(derived.nodes.find((node) => node.id === "/plan")?.tags).toEqual(["/tags/project"]);
		expect(derived.nodes.find((node) => node.id === "/api")?.tags).toEqual([]);
	});

	test("search keeps the current page plus matching nodes", () => {
		const graphIndex = createGraphIndex(fixtureGraph());

		const matched = deriveGraphViewData(graphIndex, "/guide", { query: "api" });
		expect(idsOf(matched)).toEqual(["/api", "/guide"]);
		expect(matched.links).toEqual([{ source: "/guide", target: "/api" }]);
		expect(matched.isEmpty).toBe(false);

		// A match with no surviving neighbor renders but has no links — the
		// default keeps it (orphans on), the empty state still shows.
		const stranded = deriveGraphViewData(graphIndex, "/guide", { depth: 2, query: "plan" });
		expect(idsOf(stranded)).toEqual(["/guide", "/plan"]);
		expect(stranded.isEmpty).toBe(true);

		// The current page never filters itself out, even with no match.
		const nothing = deriveGraphViewData(graphIndex, "/guide", { query: "no-such-node" });
		expect(idsOf(nothing)).toEqual(["/guide"]);
	});

	test("tag: queries match tag pages and the pages carrying the tag", () => {
		const graphIndex = createGraphIndex(fixtureGraph());
		const derived = deriveGraphViewData(graphIndex, "/guide", { depth: 2, query: "tag:project" });

		expect(idsOf(derived)).toEqual(["/guide", "/plan", "/tags/project"]);
		expect(derived.isEmpty).toBe(false);
	});

	test("showOrphans false drops nodes stranded by the search", () => {
		const graphIndex = createGraphIndex(fixtureGraph());
		const derived = deriveGraphViewData(graphIndex, "/guide", {
			depth: 2,
			query: "plan",
			showOrphans: false,
		});

		expect(idsOf(derived)).toEqual(["/guide"]);
		expect(derived.isEmpty).toBe(true);
	});
});

describe("normalizeClientRoutePath", () => {
	test("strips .html suffix", () => {
		expect(normalizeClientRoutePath("/guide/configuration.html")).toBe("/guide/configuration");
	});

	test("strips trailing slashes", () => {
		expect(normalizeClientRoutePath("/guide/")).toBe("/guide");
		expect(normalizeClientRoutePath("/guide//")).toBe("/guide");
	});

	test("handles root", () => {
		expect(normalizeClientRoutePath("/")).toBe("/");
		expect(normalizeClientRoutePath("/index.html")).toBe("/");
	});

	test("maps nested index.html to its directory", () => {
		expect(normalizeClientRoutePath("/guide/index.html")).toBe("/guide");
		expect(normalizeClientRoutePath("/guide/")).toBe("/guide");
	});

	test("leaves clean paths unchanged", () => {
		expect(normalizeClientRoutePath("/guide/getting-started")).toBe("/guide/getting-started");
	});

	describe("deriveGraphViewData global scope", () => {
		/** A chain of `count` pages, each linked to the next, plus an isolated one. */
		function chain(count: number): GraphData {
			const nodes = [{ id: "/", label: "Home", routePath: "/" }];
			const links: GraphData["links"] = [];
			for (let index = 1; index <= count; index += 1) {
				nodes.push({ id: `/p${index}`, label: `Page ${index}`, routePath: `/p${index}` });
				links.push({ source: `/${index === 1 ? "" : `p${index - 1}`}`, target: `/p${index}` });
			}
			nodes.push({ id: "/island", label: "Island", routePath: "/island" });
			return { nodes, links };
		}

		test("the global scope shows pages far beyond the local depth", () => {
			const graphIndex = createGraphIndex(chain(6));

			const local = deriveGraphViewData(graphIndex, "/", { depth: 1 });
			const global = deriveGraphViewData(graphIndex, "/", { scope: "global" });

			expect(local.nodes.map((node) => node.id).sort()).toEqual(["/", "/p1"]);
			expect(global.nodes.map((node) => node.id).sort()).toEqual([
				"/",
				"/island",
				"/p1",
				"/p2",
				"/p3",
				"/p4",
				"/p5",
				"/p6",
			]);
			// The current page is still the one flagged, so "you are here" survives.
			expect(global.nodes.find((node) => node.id === "/")?.isCurrent).toBe(true);
			expect(global.truncatedCount).toBe(0);
		});

		test("the global scope keeps the toggles and the query", () => {
			const graphIndex = createGraphIndex(chain(4));

			const noIslands = deriveGraphViewData(graphIndex, "/", {
				scope: "global",
				showOrphans: false,
			});
			// `/island` links to nothing, so the orphan toggle removes it.
			expect(noIslands.nodes.map((node) => node.id)).not.toContain("/island");

			const searched = deriveGraphViewData(graphIndex, "/", {
				scope: "global",
				query: "Page 3",
			});
			expect(searched.nodes.map((node) => node.id).sort()).toEqual(["/", "/p3"]);
		});

		test("the global scope caps drawn nodes and reports the rest", () => {
			const graphIndex = createGraphIndex(chain(MAX_GLOBAL_NODES + 5));

			const derived = deriveGraphViewData(graphIndex, "/", { scope: "global" });

			// The current page plus the cap; the surplus (the five chain pages and the
			// island) is reported, not hidden.
			expect(derived.nodes).toHaveLength(MAX_GLOBAL_NODES + 1);
			expect(derived.truncatedCount).toBe(6);
		});
	});
});
