// The graph and canvas features read what the site's markdown plugin publishes.
// These drive the plugins' hooks the way Rspress does — every `config` hook in
// list order, then `addPages` for all of them at once, then the route hooks and
// `addRuntimeModules` — with a config whose `plugins` lists them, and assert
// that each site sees its own markdown plugin, whatever the order.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RouteMeta, RspressPlugin, UserConfig } from "@rspress/core";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { canvas } from "../canvas/index.js";
import { parseCanvas } from "../canvas/parser.js";
import { decodeGraphPayload } from "../graph/graph-payload.js";
import { graphview } from "../graph/index.js";
import type { GraphData, GraphPayload } from "../graph/types.js";
import { getCachedContentIndex } from "../markdown/content-index.js";
import { markdown } from "../markdown/index.js";
import { findPublishedContent } from "./published-content.js";

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Site {
	docs: string;
	vault: string;
	out: string;
	routes: RouteMeta[];
}

/** A docs root and a vault, with the routes Rspress gives their pages. */
async function createSite(
	docsFiles: Record<string, string>,
	vaultFiles: Record<string, string>,
	vaultRoutePrefix: string,
): Promise<Site> {
	const root = await mkdtemp(path.join(tmpdir(), "published-content-"));
	tempDirs.push(root);
	const site: Site = {
		docs: path.join(root, "docs"),
		vault: path.join(root, "vault"),
		out: path.join(root, "out"),
		routes: [],
	};
	for (const [dir, files, prefix] of [
		[site.docs, docsFiles, ""],
		[site.vault, vaultFiles, vaultRoutePrefix],
	] as const) {
		await mkdir(dir, { recursive: true });
		for (const [relativePath, content] of Object.entries(files)) {
			const absolutePath = path.join(dir, relativePath);
			await mkdir(path.dirname(absolutePath), { recursive: true });
			await writeFile(absolutePath, content);
			if (!/\.mdx?$/.test(relativePath)) continue;
			const page = relativePath.replace(/\.mdx?$/, "").replace(/(^|\/)index$/, "");
			const routePath = `${prefix}/${page}`.replace(/(.)\/$/, "$1");
			site.routes.push({
				routePath,
				pureRoutePath: routePath,
				absolutePath,
				relativePath,
				pageName: page || "index",
				lang: "",
				version: "",
			});
		}
	}
	return site;
}

/**
 * Rspress's `config` hooks, run in list order over a config listing the
 * plugins. `utils.addPlugin` registers a plugin as Rspress does: appended to
 * `plugins` (the driver's list, so its hooks run too) but not to the config's.
 */
async function configure(plugins: RspressPlugin[], config: UserConfig): Promise<UserConfig> {
	let current: UserConfig = { ...config, plugins: [...plugins] };
	const utils = { addPlugin: (plugin: RspressPlugin) => plugins.push(plugin), removePlugin() {} };
	for (let index = 0; index < plugins.length; index += 1) {
		current = (await plugins[index]?.config?.(current, utils, true)) ?? current;
	}
	return current;
}

/** Every plugin's `addPages`, run at once as Rspress does. */
async function addPages(plugins: RspressPlugin[], config: UserConfig): Promise<void> {
	await Promise.all(plugins.map((plugin) => plugin.addPages?.(config, true)));
}

/** The hooks after `config`, as Rspress runs them; returns the graph published. */
async function build(plugins: RspressPlugin[], config: UserConfig, site: Site): Promise<GraphData> {
	await addPages(plugins, config);
	return publishGraph(plugins, config, site);
}

/** The hooks after `addPages`; returns the graph published. */
async function publishGraph(
	plugins: RspressPlugin[],
	config: UserConfig,
	site: Site,
): Promise<GraphData> {
	const routeService = {
		routeData: new Map(site.routes.map((routeMeta) => [routeMeta.routePath, { routeMeta }])),
		getRoutes: () => site.routes,
	};
	await Promise.all(plugins.map((plugin) => plugin.routeServiceGenerated?.(routeService, true)));
	const modules: Record<string, string> = {};
	for (const plugin of plugins) {
		Object.assign(modules, await plugin.addRuntimeModules?.(config, true));
	}
	const json = modules["virtual-graph-data"]?.match(/JSON\.parse\((".*")\)/s)?.[1];
	if (!json) throw new Error("no graph module published");
	return decodeGraphPayload(JSON.parse(JSON.parse(json)) as GraphPayload);
}

function edgesFrom(graph: GraphData, source: string): string[] {
	return graph.links
		.filter((link) => link.source === source)
		.map((link) => link.target)
		.sort();
}

describe("published content", () => {
	test("two sites built in one process each read their own markdown plugin", async () => {
		const first = await createSite(
			{ "index.md": "# Home\n\n[[Plan]]\n" },
			{ "Plan.md": "x\n" },
			"/vault",
		);
		const second = await createSite(
			{ "index.md": "# Home\n\n[[Plan]]\n" },
			{ "Plan.md": "y\n" },
			"/notes",
		);
		const firstPlugins = [
			markdown({ vaultRoot: first.vault, vaultRoutePrefix: "/vault" }),
			graphview({ onUnresolvedLink: "ignore" }),
		];
		const secondPlugins = [
			markdown({ vaultRoot: second.vault, vaultRoutePrefix: "/notes" }),
			graphview({ onUnresolvedLink: "ignore" }),
		];

		// Both sites are configured before either builds: the second markdown
		// plugin's `config` hook runs after the first's.
		const firstConfig = await configure(firstPlugins, { root: first.docs });
		const secondConfig = await configure(secondPlugins, { root: second.docs });

		expect(findPublishedContent(firstConfig)).toMatchObject({
			docsRoot: first.docs,
			vaultRoot: first.vault,
			vaultRoutePrefix: "/vault",
		});
		expect(findPublishedContent(secondConfig)).toMatchObject({
			docsRoot: second.docs,
			vaultRoot: second.vault,
			vaultRoutePrefix: "/notes",
		});
		expect(edgesFrom(await build(firstPlugins, firstConfig, first), "/")).toEqual(["/vault/Plan"]);
		expect(edgesFrom(await build(secondPlugins, secondConfig, second), "/")).toEqual([
			"/notes/Plan",
		]);
	});

	test("a site without a markdown plugin has nothing published", () => {
		expect(findPublishedContent({ plugins: [graphview(), canvas()] })).toBeUndefined();
		expect(findPublishedContent({})).toBeUndefined();
	});

	test("finds a markdown plugin another plugin adds from its config hook", async () => {
		const site = await createSite(
			{ "index.md": "# Home\n\n[[Plan]]\n" },
			{ "Plan.md": "x\n" },
			"/kb",
		);
		const markdownPlugin = markdown({ vaultRoot: site.vault, vaultRoutePrefix: "/kb" });
		const preset: RspressPlugin = {
			name: "preset",
			config(config, utils) {
				utils.addPlugin(markdownPlugin);
				return config;
			},
		};
		const plugins = [preset, graphview({ onUnresolvedLink: "ignore" })];
		const config = await configure(plugins, { root: site.docs });

		expect(findPublishedContent(config)).toMatchObject({ vaultRoutePrefix: "/kb" });
		expect(edgesFrom(await build(plugins, config, site), "/")).toEqual(["/kb/Plan"]);
	});

	test("canvas and the graph read the markdown plugin wherever it is listed", async () => {
		const board = JSON.stringify({
			nodes: [
				{ id: "t", type: "text", x: 0, y: 0, width: 10, height: 10, text: "[[Plan]] [[guide]]" },
			],
			edges: [],
		});
		const results: Array<{ graph: GraphData; links: unknown }> = [];
		for (const markdownFirst of [true, false]) {
			const site = await createSite(
				{ "index.md": "# Home\n\n[[Plan]]\n", "guide.md": "# Guide\n" },
				{ "Plan.md": "[[guide]]\n", "Board.canvas": board },
				"/vault",
			);
			const markdownPlugin = markdown({ vaultRoot: site.vault });
			// No `fileRoutePrefix`: the routes come from the markdown plugin's index.
			const features = [
				canvas({ vaultRoot: site.vault, outDir: site.out }),
				graphview({ onUnresolvedLink: "ignore" }),
			];
			const plugins = markdownFirst ? [markdownPlugin, ...features] : [...features, markdownPlugin];
			const config = await configure(plugins, { root: site.docs });
			const graph = await build(plugins, config, site);
			const published = parseCanvas(
				await readFile(path.join(site.out, "__canvases__", "Board.json"), "utf-8"),
				{ enriched: true },
			);
			results.push({ graph, links: published.links?.[""] });
		}

		const [markdownFirst, markdownLast] = results;
		// A docs page reaches the vault note, and the vault note the docs page.
		expect(edgesFrom(markdownFirst?.graph ?? { nodes: [], links: [] }, "/")).toEqual([
			"/vault/Plan",
		]);
		expect(edgesFrom(markdownFirst?.graph ?? { nodes: [], links: [] }, "/vault/Plan")).toEqual([
			"/guide",
		]);
		// A card links the vault note at its published route, and a docs page
		// through the site's other tree.
		expect(markdownFirst?.links).toMatchObject({
			Plan: { href: "/vault/Plan" },
			guide: { href: "/guide" },
		});
		expect(markdownLast?.graph.links).toEqual(markdownFirst?.graph.links ?? []);
		expect(markdownLast?.links).toEqual(markdownFirst?.links);
	});

	test("the content indexes other readers share are not linked to the site's other tree", async () => {
		const site = await createSite({ "index.md": "[[Plan]]\n" }, { "Plan.md": "x\n" }, "/vault");
		const plugin = markdown({ vaultRoot: site.vault });
		const config = await configure([plugin], { root: site.docs });
		await plugin.addPages?.(config, true);

		const published = findPublishedContent(config);
		if (!published?.vaultRoot || !published.vaultIndexOptions)
			throw new Error("no vault published");
		const docs = await getCachedContentIndex(published.docsRoot, published.docsIndexOptions);
		const vault = await getCachedContentIndex(published.vaultRoot, published.vaultIndexOptions);
		expect(docs.linkedIndexes).toBeUndefined();
		expect(vault.linkedIndexes).toBeUndefined();
	});
});

/** A docs page run through the markdown plugin's remark pass, as Rspress compiles it. */
async function renderPage(markdownPlugin: RspressPlugin, file: string): Promise<string> {
	const processor = unified()
		.use(remarkParse)
		.use(markdownPlugin.markdown?.remarkPlugins ?? [])
		.use(remarkStringify);
	return String(await processor.process({ value: await readFile(file, "utf-8"), path: file }));
}

describe("canvas boards", () => {
	test("two sites built in one process each resolve their own boards, whatever the plugin order", async () => {
		const sites = [];
		for (const [own, markdownFirst] of [
			["A", true],
			["B", false],
		] as const) {
			const site = await createSite(
				{ "index.md": `# Home\n\n[[${own}.canvas]]\n` },
				{ [`${own}.canvas`]: JSON.stringify({ nodes: [], edges: [] }) },
				"/vault",
			);
			const boardRoute = `/canvas/${own.toLowerCase()}`;
			// The page Rspress generates for the board from the canvas feature's `addPages`.
			site.routes.push({
				routePath: boardRoute,
				pureRoutePath: boardRoute,
				absolutePath: path.join(site.docs, "node_modules", "temp-board.mdx"),
				relativePath: `canvas/${own.toLowerCase()}.mdx`,
				pageName: own.toLowerCase(),
				lang: "",
				version: "",
			});
			const markdownPlugin = markdown({ vaultRoot: site.vault });
			const features = [
				canvas({ vaultRoot: site.vault, outDir: site.out }),
				graphview({ onUnresolvedLink: "ignore" }),
			];
			const plugins = markdownFirst ? [markdownPlugin, ...features] : [...features, markdownPlugin];
			const config = await configure(plugins, { root: site.docs });
			sites.push({ site, own, markdownPlugin, plugins, config });
		}

		// Both sites are configured and scanned before either compiles a page or
		// publishes its graph, as when one process builds them side by side.
		await Promise.all(sites.map(({ plugins, config }) => addPages(plugins, config)));

		for (const { site, own, markdownPlugin, plugins, config } of sites) {
			const boardRoute = `/canvas/${own.toLowerCase()}`;
			const graph = await publishGraph(plugins, config, site);
			expect(edgesFrom(graph, "/")).toEqual([boardRoute]);
			// The board's route is graphed as the board, not as the generated page.
			expect(graph.nodes.find((node) => node.id === boardRoute)?.label).toBe(`${own}.canvas`);

			const page = await renderPage(markdownPlugin, path.join(site.docs, "index.md"));
			expect(page).toContain(`[${own}.canvas](${boardRoute})`);
		}
	});

	test("finds a canvas plugin another plugin adds from its config hook", async () => {
		const site = await createSite(
			{ "index.md": "# Home\n\n[[Board.canvas]]\n" },
			{ "Board.canvas": JSON.stringify({ nodes: [], edges: [] }) },
			"/vault",
		);
		site.routes.push({
			routePath: "/canvas/board",
			pureRoutePath: "/canvas/board",
			absolutePath: path.join(site.docs, "node_modules", "temp-board.mdx"),
			relativePath: "canvas/board.mdx",
			pageName: "board",
			lang: "",
			version: "",
		});
		const canvasPlugin = canvas({ vaultRoot: site.vault, outDir: site.out });
		const preset: RspressPlugin = {
			name: "preset",
			config(config, utils) {
				utils.addPlugin(canvasPlugin);
				return config;
			},
		};
		const markdownPlugin = markdown({ vaultRoot: site.vault });
		const plugins = [markdownPlugin, preset, graphview({ onUnresolvedLink: "ignore" })];
		const config = await configure(plugins, { root: site.docs });

		expect(edgesFrom(await build(plugins, config, site), "/")).toEqual(["/canvas/board"]);
		expect(await renderPage(markdownPlugin, path.join(site.docs, "index.md"))).toContain(
			"[Board.canvas](/canvas/board)",
		);
	});
});
