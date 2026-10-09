// The graph plugin factory is what `rspress.config.ts` hands Rspress, so these
// tests drive its hooks in Rspress's own order — `config`, then
// `routeServiceGenerated` for every plugin, then `addRuntimeModules` — and
// assert what it publishes.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RouteMeta, RspressPlugin, UserConfig } from "@rspress/core";
import { markdown } from "../markdown/index.js";
import { setPublishedContent } from "../shared/published-content.js";
import { decodeGraphPayload } from "./graph-payload.js";
import { graphview } from "./index.js";
import type { GraphData, GraphPayload } from "./types.js";

const tempDirs: string[] = [];

afterEach(async () => {
	setPublishedContent(undefined);
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A stand-in for Rspress's RouteService: the route map plugins read and edit. */
function createRouteService(routes: RouteMeta[]) {
	const routeData = new Map(routes.map((routeMeta) => [routeMeta.routePath, { routeMeta }]));
	return {
		routeData,
		getRoutes: () => [...routeData.values()].map((entry) => entry.routeMeta),
	};
}

async function createDocs(
	files: Record<string, string>,
): Promise<{ root: string; routes: RouteMeta[] }> {
	const root = await mkdtemp(path.join(tmpdir(), "graph-plugin-"));
	tempDirs.push(root);
	const routes: RouteMeta[] = [];
	for (const [relativePath, content] of Object.entries(files)) {
		const absolutePath = path.join(root, relativePath);
		await mkdir(path.dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, content);
		const routePath = `/${relativePath.replace(/\.mdx?$/, "").replace(/(^|\/)index$/, "")}`;
		routes.push({
			routePath,
			pureRoutePath: routePath,
			absolutePath,
			relativePath,
			pageName: relativePath.replace(/\.mdx?$/, ""),
			lang: "",
			version: "",
		});
	}
	return { root, routes };
}

/** Run the hooks Rspress runs, in its order, for every plugin given. */
async function runRspress(
	plugins: RspressPlugin[],
	routes: RouteMeta[],
	config: UserConfig,
	isProd = true,
): Promise<{ modules: Record<string, string>; config: UserConfig }> {
	let current = config;
	for (const plugin of plugins) {
		current =
			(await plugin.config?.(current, { addPlugin: () => {}, removePlugin: () => {} }, isProd)) ??
			current;
	}
	const routeService = createRouteService(routes);
	await Promise.all(
		plugins.map((plugin) => plugin.routeGenerated?.(routeService.getRoutes(), isProd)),
	);
	await Promise.all(plugins.map((plugin) => plugin.routeServiceGenerated?.(routeService, isProd)));
	const modules: Record<string, string> = {};
	for (const plugin of plugins)
		Object.assign(modules, await plugin.addRuntimeModules?.(current, isProd));
	return { modules, config: current };
}

function graphFrom(source: string | undefined): GraphData {
	const json = source?.match(/JSON\.parse\((".*")\)/s)?.[1];
	if (!json) throw new Error(`unexpected module source: ${source}`);
	return decodeGraphPayload(JSON.parse(JSON.parse(json)) as GraphPayload);
}

describe("graphview", () => {
	test("publishes a node per route and an edge per resolved link", async () => {
		const { root, routes } = await createDocs({
			"index.md": "# Home\n\nRead [Guide](./guide/index.md).\n",
			"guide/index.md": "# Guide\n",
		});

		const { modules } = await runRspress([graphview()], routes, { root });

		const graph = graphFrom(modules["virtual-graph-data"]);
		expect(graph.nodes.map((node) => [node.id, node.label])).toEqual([
			["/", "Home"],
			["/guide", "Guide"],
		]);
		expect(graph.links).toEqual([{ source: "/", target: "/guide" }]);
	});

	test("a publish: false page never reaches the graph or the search data", async () => {
		const { root, routes } = await createDocs({
			"index.md": "Public page linking [[secret]].\n",
			"secret.md": "---\ntitle: Secret Plans\npublish: false\n---\nThe launch code is 0000.\n",
		});

		// The markdown plugin removes the unpublished route in its own
		// `routeServiceGenerated`, after Rspress fired `routeGenerated` with it.
		const { modules } = await runRspress(
			[graphview({ enableHoverPreviews: true }), markdown()],
			routes,
			{ root },
		);

		const graph = graphFrom(modules["virtual-graph-data"]);
		// The link to it is what the public page itself shows — an unresolved
		// node named by the link text — never the page, its title or its body.
		expect(graph.nodes.filter((node) => node.kind === "page").map((node) => node.id)).toEqual([
			"/",
		]);
		expect(graph.nodes.find((node) => node.id !== "/")).toMatchObject({
			kind: "unresolved",
			label: "secret",
			navigable: false,
		});
		const published = [modules["virtual-graph-data"], modules["virtual-graph-search-data"]].join(
			"\n",
		);
		expect(published).not.toContain("Secret Plans");
		expect(published).not.toContain("launch code");
	});

	test("hover previews publish no data module of their own", async () => {
		const { root, routes } = await createDocs({ "index.md": "x\n", "guide.md": "# Guide\nBody\n" });

		const withPreviews = await runRspress([graphview({ enableHoverPreviews: true })], routes, {
			root,
		});
		expect(Object.keys(withPreviews.modules).sort()).toEqual([
			"virtual-graph-data",
			"virtual-graph-search-data",
		]);
	});

	test("hands colour groups to the lazy panel as a runtime prop", () => {
		const groups = [{ query: "path:api", color: "#ff0000" }];
		const plugin = graphview({ groups });

		const panelEntry = plugin.globalUIComponents?.find((entry) =>
			String(entry[0]).includes("LazyGraphPanel"),
		);
		expect(panelEntry?.[1]).toMatchObject({ groups });
	});

	test("under rspress dev the modules re-export live in-memory files a watcher refreshes", async () => {
		const { root, routes } = await createDocs({ "index.md": "x\n" });
		const plugin = graphview();

		const { modules, config } = await runRspress([plugin], routes, { root }, false);

		expect(modules["virtual-graph-data"]).toContain("export * from");
		const registered = (config.builderConfig?.plugins ?? []).flat();
		expect(
			registered.some((entry) => entry && "name" in entry && entry.name.includes("graph-dev-data")),
		).toBe(true);
	});

	test("a production build publishes the data itself and registers no dev plugin", async () => {
		const { root, routes } = await createDocs({ "index.md": "x\n" });

		const { modules, config } = await runRspress([graphview()], routes, { root }, true);

		expect(modules["virtual-graph-data"]).toContain("export const graphPayload");
		expect(config.builderConfig?.plugins ?? []).toHaveLength(0);
	});
});
