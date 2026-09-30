// The graph plugin factory is what `rspress.config.ts` hands Rspress, so these
// tests drive the two hooks Rspress calls and assert what they publish: the
// `virtual-graph-data` module (and, with hover previews on, the page-content
// module) for routes built from a real temp docs root, plus the disk cache a
// rebuild is meant to lean on.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RouteMeta, RspressPlugin } from "@rspress/core";
import { graphview } from "./index";

interface GraphNode {
	id: string;
	label: string;
	routePath: string;
}

interface GraphLink {
	source: string;
	target: string;
}

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface DocsFixture {
	root: string;
	cacheDir: string;
	routes: RouteMeta[];
}

/** A two-page docs root whose home page links to the guide, so the edge is real. */
async function createDocsFixture(): Promise<DocsFixture> {
	const root = await mkdtemp(path.join(tmpdir(), "graph-plugin-"));
	tempDirs.push(root);
	const cacheDir = path.join(root, "graph-cache");
	await mkdir(path.join(root, "guide"), { recursive: true });
	await writeFile(path.join(root, "index.md"), "# Home\n\nRead [Guide](./guide/index.md).\n");
	await writeFile(path.join(root, "guide", "index.md"), "# Guide\n");

	const routeTable: Array<[routePath: string, relativePath: string]> = [
		["/", "index.md"],
		["/guide", "guide/index.md"],
	];

	return {
		root,
		cacheDir,
		routes: routeTable.map(([routePath, relativePath]) => ({
			routePath,
			pureRoutePath: routePath,
			absolutePath: path.join(root, relativePath),
			relativePath,
			pageName: relativePath.replace(/\/index\.md$/, "").replace(/\.md$/, "") || "index",
			lang: "",
			version: "",
		})),
	};
}

/** Drive the plugin the way Rspress does: routes first, then the module map. */
async function buildModules(
	plugin: RspressPlugin,
	fixture: DocsFixture,
): Promise<Record<string, string>> {
	plugin.routeGenerated?.(fixture.routes, false);
	const modules = await plugin.addRuntimeModules?.({ root: fixture.root }, false);
	if (!modules) throw new Error("addRuntimeModules published nothing");
	return modules;
}

/** The graph data the module source hands the client. */
function graphDataFrom(source: string): { nodes: GraphNode[]; links: GraphLink[] } {
	const match = source.match(/^export const graphData = (.*); export default graphData;$/s);
	if (!match) throw new Error(`unexpected module source: ${source}`);
	return JSON.parse(match[1] ?? "");
}

/**
 * The hook fires the cache write without awaiting it, so yield to the event loop
 * until the file is there *and complete* rather than guessing a delay —
 * `writeFile` creates the file before filling it, so a bare `stat` can observe
 * an empty file and the subsequent parse fails with an unexpected EOF.
 */
async function waitForCacheFile(cacheDir: string): Promise<void> {
	const cacheFile = path.join(cacheDir, "cache.json");
	for (let attempt = 0; attempt < 500; attempt += 1) {
		try {
			JSON.parse(await readFile(cacheFile, "utf8"));
			return;
		} catch {
			const { promise, resolve } = Promise.withResolvers<void>();
			setImmediate(resolve);
			await promise;
		}
	}
	throw new Error("the graph plugin never wrote its disk cache");
}

describe("graphview", () => {
	test("publishes a node per route and an edge per resolved link", async () => {
		const fixture = await createDocsFixture();

		const modules = await buildModules(graphview({ cacheDir: fixture.cacheDir }), fixture);

		const graphData = graphDataFrom(modules["virtual-graph-data"] ?? "");
		expect(graphData.nodes).toEqual([
			{ id: "/", label: "Home", routePath: "/" },
			{ id: "/guide", label: "Guide", routePath: "/guide" },
		]);
		expect(graphData.links).toEqual([{ source: "/", target: "/guide" }]);
	});

	test("adds the hover-preview module only when hover previews are enabled", async () => {
		const fixture = await createDocsFixture();

		const plain = await buildModules(graphview({ cacheDir: fixture.cacheDir }), fixture);
		expect(plain["virtual-page-content-data"]).toBeUndefined();

		const withPreviews = await buildModules(
			graphview({ cacheDir: fixture.cacheDir, enableHoverPreviews: true }),
			fixture,
		);
		const previewSource = withPreviews["virtual-page-content-data"];
		expect(previewSource).toContain("export const pageContentData =");
		expect(previewSource).toContain('"routePath":"/guide"');
		expect(previewSource).toContain('"title":"Guide"');
	});

	test("hands colour groups to the lazy panel as a runtime prop", () => {
		const groups = [{ query: "path:api", color: "#ff0000" }];
		const plugin = graphview({ groups });

		const panelEntry = plugin.globalUIComponents?.find((entry) =>
			String(entry[0]).includes("LazyGraphPanel"),
		);
		expect(panelEntry?.[1]).toMatchObject({ groups });
	});

	test("reuses the parsed documents on a second build instead of reading them again", async () => {
		const fixture = await createDocsFixture();
		const infoSpy = spyOn(console, "info").mockImplementation(() => {});

		const plugin = graphview({ cacheDir: fixture.cacheDir, profileBuild: true });
		let logs: string[] = [];
		try {
			await buildModules(plugin, fixture);
			await buildModules(plugin, fixture);
		} finally {
			// Read the calls before restoring: `mockRestore` clears them.
			logs = infoSpy.mock.calls.map((call) => String(call[0]));
			infoSpy.mockRestore();
		}

		expect(logs[0]).toContain("cacheMisses=2");
		expect(logs[0]).toContain("reusedModule=false");
		// Second build: both documents came back from the cache, and the module
		// source was reused rather than rebuilt.
		expect(logs[1]).toContain("cacheHits=2");
		expect(logs[1]).toContain("reusedModule=true");
	});

	test("writes the cache file a later build reads back", async () => {
		const fixture = await createDocsFixture();

		await buildModules(graphview({ cacheDir: fixture.cacheDir }), fixture);
		await waitForCacheFile(fixture.cacheDir);

		const persisted = JSON.parse(
			await readFile(path.join(fixture.cacheDir, "cache.json"), "utf8"),
		) as { documents: Record<string, { inferredTitle?: string; rawLinks: string[] }> };
		expect(Object.keys(persisted.documents).sort()).toEqual([
			path.join(fixture.root, "guide", "index.md"),
			path.join(fixture.root, "index.md"),
		]);
		expect(persisted.documents[path.join(fixture.root, "index.md")]?.rawLinks).toEqual([
			"./guide/index.md",
		]);
	});

	test("a fresh instance with an explicit cacheDir reads the file a previous one wrote", async () => {
		const fixture = await createDocsFixture();
		const infoSpy = spyOn(console, "info").mockImplementation(() => {});
		let profiled: string | undefined;
		try {
			await buildModules(graphview({ cacheDir: fixture.cacheDir }), fixture);
			await waitForCacheFile(fixture.cacheDir);

			// Brand-new instance: its in-memory cache starts empty, so every hit
			// in this build has to come from the file on disk. Before the fix an
			// explicit `cacheDir` skipped the load entirely and this build
			// re-parsed both documents.
			await buildModules(graphview({ cacheDir: fixture.cacheDir, profileBuild: true }), fixture);
			profiled = infoSpy.mock.calls
				.map((call) => String(call[0]))
				.find((line) => line.includes("graph build"));
		} finally {
			infoSpy.mockRestore();
		}

		expect(profiled).toContain("cacheHits=2");
		expect(profiled).toContain("cacheMisses=0");
	});
});
