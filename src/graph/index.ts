import { existsSync } from "node:fs";
import * as path from "node:path";

const pluginDir = import.meta.dirname;
const compiledDir = path.join(pluginDir, "..", "..", "dist", "graph", "runtime");
const sourceDir = path.join(pluginDir, "graph", "runtime");

function findRuntimeFile(name: string): string {
	const jsPath = `${name}.js`;
	const tsxPath = `${name}.tsx`;
	if (existsSync(path.join(compiledDir, jsPath))) return path.join(compiledDir, jsPath);
	if (existsSync(path.join(sourceDir, jsPath))) return path.join(sourceDir, jsPath);
	if (existsSync(path.join(sourceDir, tsxPath))) return path.join(sourceDir, tsxPath);
	return path.join(compiledDir, jsPath);
}

import type { RouteMeta, RspressPlugin, UserConfig } from "@rspress/core";
import {
	buildGraphModule,
	type CollectedRoute,
	createGraphBuildCache,
	loadDiskCache,
	saveDiskCache,
} from "./build";
import { buildPageContentModule } from "./build/page-content.ts";
import type { GraphViewColors } from "./runtime/GraphView";
import { normalizeRoutePath } from "./utils";

export interface RspressPluginGraphViewOptions {
	defaultOpen?: boolean;
	profileBuild?: boolean;
	colors?: GraphViewColors;
	cacheDir?: string;
	enableHoverPreviews?: boolean;
	enableDefaultStyles?: boolean;
}

export function pluginGraphview(options: RspressPluginGraphViewOptions = {}): RspressPlugin {
	let collectedRoutes: CollectedRoute[] = [];
	const graphBuildCache = createGraphBuildCache();
	let cacheDir: string | undefined = options.cacheDir;
	const shouldProfileBuild = options.profileBuild ?? process.env.RSPRESS_GRAPH_VIEW_PROFILE === "1";

	function ensureDiskCache(config: UserConfig): void {
		if (cacheDir) {
			return;
		}
		const docsRoot = path.resolve(config.root ?? "docs");
		const projectRoot = path.resolve(docsRoot, "..");
		cacheDir =
			options.cacheDir ?? path.join(projectRoot, "node_modules", ".cache", "rspress-graph-view");
		loadDiskCache(graphBuildCache, cacheDir);
	}

	return {
		name: "rspress-plugin-graph-view",

		...(options.enableDefaultStyles && {
			globalStyles: path.join(
				pluginDir,
				"..",
				"..",
				"dist",
				"graph",
				"runtime",
				"graph-panels.css",
			),
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
			});

			if (cacheDir) {
				void saveDiskCache(graphBuildCache, cacheDir);
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
				},
			],
			...(options.enableHoverPreviews
				? [[findRuntimeFile("HoverPreview"), {}] as [string, object]]
				: []),
		],
	};
}

export default pluginGraphview;
