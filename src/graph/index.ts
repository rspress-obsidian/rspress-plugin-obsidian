import * as path from "node:path";
import type { RouteMeta, RspressPlugin, UserConfig } from "@rspress/core";
import { deferInvalidationPlugin } from "../dev-invalidation.js";
import { moduleDir, resolveRuntimeFile } from "../runtime-paths.js";
import { getPublishedContent } from "../shared/published-content.js";
import { buildGraphModules, type CollectedRoute, type GraphBuildState } from "./build/index.js";
import { createGraphDevRefresher } from "./dev-refresh.js";
import type { GraphViewColors } from "./runtime/GraphView.js";
import type { GraphViewGroup } from "./types.js";
import { normalizeRoutePath } from "./utils.js";

// Runtime components and styles live in `dist/graph/runtime/` when published
// and `src/graph/runtime/` when running from source.
const runtimeDir = path.join(moduleDir, "graph", "runtime");

function findRuntimeFile(name: string): string {
	return resolveRuntimeFile(
		path.join(runtimeDir, `${name}.js`),
		path.join(runtimeDir, `${name}.tsx`),
	);
}

export interface RspressPluginGraphViewOptions {
	/** Panel starts expanded on first paint — except on screens narrower than
	 * 640px, where it would cover the article. A visitor's own toggle wins.
	 * @default false */
	defaultOpen?: boolean;
	/** Log graph build counts and timings. Defaults to the
	 * `RSPRESS_GRAPH_VIEW_PROFILE=1` environment variable when unset.
	 * @default false */
	profileBuild?: boolean;
	/** Node, link and accent colours for the panel; the built-in palette is
	 * used for whatever is omitted. */
	colors?: GraphViewColors;
	/** Register the Page preview: hovering a link in the article with a mouse
	 * shows the linked note rendered in a scrollable popover, sliced to the
	 * section or block a `#heading` or `#^block` link names. The popover renders
	 * the target route's own page module, which Rspress already fetches on
	 * hover, so nothing extra is built or shipped.
	 * @default false */
	enableHoverPreviews?: boolean;
	/** Inject the bundled panel stylesheet as a global style. Off by default —
	 * importing `rspress-plugin-obsidian/styles.css` (which already includes
	 * it) is the intended way to style the panel.
	 * @default false */
	enableDefaultStyles?: boolean;
	/**
	 * What to do about an authored link that resolves to nothing: `"warn"`
	 * (the default) reports it without failing the build, `"error"` fails the
	 * build, `"ignore"` stays quiet. The link still appears in the graph as an
	 * unresolved node when "Existing files only" is off.
	 *
	 * The markdown plugin reports the same links through its `onBrokenLink`, so
	 * a site that already hears about them there can set `"ignore"` here.
	 * @default "warn"
	 */
	onUnresolvedLink?: "error" | "warn" | "ignore";
	/** Colour groups for the panel: a node matching a group's query paints in
	 * its colour, first match wins. The query language is the search box's
	 * own, so a group can be prototyped by typing it into the panel first. */
	groups?: readonly GraphViewGroup[];
}

interface RouteSource {
	getRoutes(): RouteMeta[];
}

/**
 * Graph view feature: builds the link graph over every published route and
 * serves it as a lazy-mounted panel (plus optional link hover previews).
 *
 * Links resolve through the markdown plugin's content index and resolver, so
 * the graph's edges are the page's own links and its Backlinks pane's sources.
 *
 * @param options - Panel defaults, build diagnostics and hover previews; all
 *   fields optional. See {@link RspressPluginGraphViewOptions} for details.
 * @returns An {@link RspressPlugin} ready to append to `plugins:`.
 */
export function graphview(options: RspressPluginGraphViewOptions = {}): RspressPlugin {
	const state: GraphBuildState = {};
	const shouldProfileBuild = options.profileBuild ?? process.env.RSPRESS_GRAPH_VIEW_PROFILE === "1";
	let routeSource: RouteSource | undefined;
	// Rspress asks for runtime modules once per dev-server start; the refresher
	// keeps them current while notes are edited.
	const devRefresher = createGraphDevRefresher({
		moduleDir: path.join(process.cwd(), "node_modules", ".rspress-graph-view"),
		rebuild: async () => (await build(lastConfig)).modules,
	});
	let lastConfig: UserConfig = {};

	// Routes are read when the modules are built, not in `routeGenerated`:
	// Rspress fires that hook before `routeServiceGenerated`, where the markdown
	// plugin removes `publish: false` pages, so a snapshot taken there would put
	// unpublished pages (titles, links and text) into the graph.
	const collectRoutes = (): CollectedRoute[] =>
		(routeSource?.getRoutes() ?? []).map((route) => ({
			routePath: normalizeRoutePath(route.routePath),
			absolutePath: route.absolutePath,
			relativePath: route.relativePath,
			pageName: route.pageName,
		}));

	const build = (config: UserConfig) =>
		buildGraphModules(collectRoutes(), state, {
			docsRoot: path.resolve(config.root ?? "docs"),
			base: config.base ?? "/",
			profile: shouldProfileBuild,
			onUnresolvedLink: options.onUnresolvedLink,
		});

	return {
		name: "rspress-plugin-obsidian:graph",

		...(options.enableDefaultStyles && {
			globalStyles: path.join(runtimeDir, "graph-panels.css"),
		}),

		config(config, _utils, isProd) {
			if (isProd) return config;
			return {
				...config,
				builderConfig: {
					...config.builderConfig,
					plugins: [
						...(config.builderConfig?.plugins ?? []),
						deferInvalidationPlugin,
						devRefresher.rsbuildPlugin,
					],
				},
			};
		},

		routeServiceGenerated(routeService: RouteSource) {
			routeSource = routeService;
		},

		async addRuntimeModules(config: UserConfig, isProd: boolean) {
			lastConfig = config;
			const { modules } = await build(config);
			if (isProd) return modules;

			const published = getPublishedContent();
			devRefresher.watch(
				[path.resolve(config.root ?? "docs"), published?.vaultRoot].filter((root): root is string =>
					Boolean(root),
				),
			);
			return devRefresher.publish(modules);
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
