import * as path from "node:path";
import { moduleDir, resolveRuntimeFile } from "../runtime-paths.js";

// Runtime components and styles live in `dist/graph/runtime/` when published
// and `src/graph/runtime/` when running from source.
const runtimeDir = path.join(moduleDir, "graph", "runtime");

function findRuntimeFile(name: string): string {
	return resolveRuntimeFile(
		path.join(runtimeDir, `${name}.js`),
		path.join(runtimeDir, `${name}.tsx`),
	);
}

import type { RouteMeta, RspressPlugin, UserConfig } from "@rspress/core";
import {
	buildGraphModule,
	type CollectedRoute,
	createGraphBuildCache,
	loadDiskCache,
	saveDiskCache,
} from "./build/index.js";
import { buildPageContentModule } from "./build/page-content.js";
import type { GraphViewColors } from "./runtime/GraphView.js";
import type { GraphViewGroup } from "./types.js";
import { normalizeRoutePath } from "./utils.js";

export interface RspressPluginGraphViewOptions {
	/** Panel starts expanded on first paint.
	 * @default false */
	defaultOpen?: boolean;
	/** Log graph build timings. Defaults to the `RSPRESS_GRAPH_VIEW_PROFILE=1`
	 * environment variable when unset.
	 * @default false */
	profileBuild?: boolean;
	/** Node, link and accent colours for the panel; the built-in palette is
	 * used for whatever is omitted. */
	colors?: GraphViewColors;
	/** Directory holding the on-disk graph cache between builds. Defaults to
	 * `<project>/node_modules/.cache/rspress-graph-view`. */
	cacheDir?: string;
	/** Ship per-page content and register the hover-preview component, so
	 * hovering a node previews the page it names.
	 * @default false */
	enableHoverPreviews?: boolean;
	/** Inject the bundled panel stylesheet as a global style. Off by default —
	 * importing `rspress-plugin-obsidian/styles.css` (which already includes
	 * it) is the intended way to style the panel.
	 * @default false */
	enableDefaultStyles?: boolean;
	/**
	 * What to do about an authored link that resolves to no route: `"warn"`
	 * (the default) reports it without failing the build, `"error"` fails the
	 * build, `"ignore"` stays quiet.
	 *
	 * A site that documents unresolved links on purpose, or that has already set
	 * the markdown plugin's `onBrokenLink` to say what it wants to hear about,
	 * can set `"ignore"` here — the graph would otherwise report the same link a
	 * second time.
	 * @default "warn"
	 */
	onUnresolvedLink?: "error" | "warn" | "ignore";
	/** Colour groups for the panel: a node matching a group's query paints in
	 * its colour, first match wins. The query language is the search box's
	 * own (`path:`, `file:`, `tag:`, plain text, `-` negation), so a group
	 * can be prototyped by typing it into the panel first. */
	groups?: readonly GraphViewGroup[];
}

/**
 * Graph view feature: builds the wikilink graph over every generated route and
 * serves it as a lazy-mounted panel (plus optional node hover previews).
 *
 * @param options - Panel defaults, build diagnostics and the graph cache; all
 *   fields optional. See {@link RspressPluginGraphViewOptions} for details.
 * @returns An {@link RspressPlugin} ready to append to `plugins:`.
 */
export function graphview(options: RspressPluginGraphViewOptions = {}): RspressPlugin {
	let collectedRoutes: CollectedRoute[] = [];
	const graphBuildCache = createGraphBuildCache();
	// Resolved on the first `addRuntimeModules`, never seeded from
	// `options.cacheDir`: an already-set value must not skip the load below,
	// or an explicit `cacheDir` would become write-only (every build re-parses
	// the whole vault while still burning a cache write).
	let resolvedCacheDir: string | undefined;
	const shouldProfileBuild = options.profileBuild ?? process.env.RSPRESS_GRAPH_VIEW_PROFILE === "1";

	function ensureDiskCache(config: UserConfig): void {
		if (resolvedCacheDir) {
			return;
		}
		const docsRoot = path.resolve(config.root ?? "docs");
		const projectRoot = path.resolve(docsRoot, "..");
		resolvedCacheDir =
			options.cacheDir ?? path.join(projectRoot, "node_modules", ".cache", "rspress-graph-view");
		loadDiskCache(graphBuildCache, resolvedCacheDir);
	}

	return {
		name: "rspress-plugin-obsidian:graph",

		...(options.enableDefaultStyles && {
			globalStyles: path.join(runtimeDir, "graph-panels.css"),
		}),

		routeGenerated(routes: RouteMeta[]) {
			collectedRoutes = routes.map((route) => ({
				routePath: normalizeRoutePath(route.routePath),
				absolutePath: route.absolutePath,
				relativePath: route.relativePath,
				pageName: route.pageName,
			}));
		},

		async addRuntimeModules(config: UserConfig) {
			ensureDiskCache(config);

			const { moduleSource } = await buildGraphModule(collectedRoutes, graphBuildCache, {
				profile: shouldProfileBuild,
				onUnresolvedLink: options.onUnresolvedLink,
			});

			if (resolvedCacheDir) {
				void saveDiskCache(graphBuildCache, resolvedCacheDir);
			}

			const modules: Record<string, string> = {
				"virtual-graph-data": moduleSource,
			};

			if (options.enableHoverPreviews) {
				const { moduleSource: pageContentModule } = await buildPageContentModule(
					collectedRoutes,
					graphBuildCache,
				);
				modules["virtual-page-content-data"] = pageContentModule;
			}

			return modules;
		},
		globalUIComponents: [
			[
				findRuntimeFile("LazyGraphPanel"),
				{
					defaultOpen: options.defaultOpen ?? false,
					colors: options.colors,
					groups: options.groups,
				},
			],
			...(options.enableHoverPreviews
				? [[findRuntimeFile("HoverPreview"), {}] as [string, object]]
				: []),
		],
	};
}

export default graphview;
