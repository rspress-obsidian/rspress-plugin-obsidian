/**
 * Build-time side of the optional `maplibre-gl` peer dependency.
 *
 * A map view reaches MapLibre through `import("maplibre-gl")` in
 * `../runtime/maps.ts`; the site's bundler resolves that specifier while it
 * builds, so a missing package would be a "Module not found" build failure,
 * not a runtime one. When the package is absent the plugin aliases it to an
 * empty module: the site builds, and each map view keeps its table, with an
 * install hint.
 */
import { createRequire } from "node:module";
import path from "node:path";
import type { RspressPlugin } from "@rspress/core";
import { moduleDir } from "../../../../runtime-paths.js";

type BuilderConfig = NonNullable<RspressPlugin["builderConfig"]>;

/** Shown on a map view, and reported, when the site is built without the map library. */
export const MAP_INSTALL_HINT =
	"Interactive map views need the optional peer dependency `maplibre-gl`: install it next to rspress-plugin-obsidian (`npm install maplibre-gl`) and rebuild the site.";

/** The stylesheet the map component imports. */
const MAP_LIBRARY_STYLESHEET = "maplibre-gl/dist/maplibre-gl.css";
/** MapLibre 6's worker, a module of its own; MapLibre 5 inlines its worker in its main bundle. */
const MAP_LIBRARY_WORKER = "maplibre-gl/dist/maplibre-gl-worker.mjs";

function resolvesFrom(fromDir: string, specifier: string): boolean {
	try {
		createRequire(path.join(fromDir, "noop.js")).resolve(specifier);
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether `maplibre-gl` resolves from `fromDir`. The default is this package's
 * own directory, where the bundler starts resolving the specifiers the shipped
 * map component imports, so the answer matches what the build will do.
 *
 * It resolves the stylesheet the component imports, not the package's main
 * entry: MapLibre 6 exports that entry under the `import` condition only, so
 * `require.resolve("maplibre-gl")` fails though the bundler finds it, while
 * `dist/*` resolves under any condition, in 5 (no `exports`) and 6 alike.
 */
export function isMapLibraryInstalled(fromDir: string = moduleDir): boolean {
	return resolvesFrom(fromDir, MAP_LIBRARY_STYLESHEET);
}

/**
 * Whether the `maplibre-gl` resolved from `fromDir` runs its worker from a
 * module file of its own (MapLibre 6), which the site's bundler has to emit and
 * the map component has to point MapLibre at.
 */
export function hasMapLibraryWorkerModule(fromDir: string = moduleDir): boolean {
	return resolvesFrom(fromDir, MAP_LIBRARY_WORKER);
}

/**
 * Whether this build draws interactive maps; resolved on first use, so the
 * bundler config and every map view share one answer. Indirected through
 * `mapLibrary` so a test can reproduce a site built without the peer, which is
 * installed in this repository.
 */
export const mapLibrary: { installed?: boolean } = {};

/** {@link mapLibrary}, resolved the first time it is asked for. */
export function mapLibraryInstalled(): boolean {
	if (mapLibrary.installed === undefined) mapLibrary.installed = isMapLibraryInstalled();
	return mapLibrary.installed;
}

/**
 * Rsbuild config for the map component. Without `maplibre-gl`: an alias that
 * turns its import into an empty module, so the site still builds and each map
 * view keeps its table. With it: a split chunk for MapLibre's stylesheet, which
 * the component imports lazily. Rspress's own `styles` group (priority 99)
 * pulls every stylesheet, lazy ones included, into the global CSS file, which
 * put MapLibre's ~70 kB of rules in front of every page's first paint; this
 * group outranks it, so the rules ship as an async stylesheet the browser
 * fetches, and applies, before the map chunk runs.
 *
 * Either way it defines `__RSPRESS_OBSIDIAN_MAPLIBRE_WORKER__`, which tells the
 * component whether to have the bundler emit MapLibre 6's worker module: a
 * build-time constant, so the branch referring to that file is dropped, never
 * resolved, when MapLibre 5 (or no MapLibre) is installed.
 */
export function mapLibraryBuilderConfig(): BuilderConfig {
	const installed = mapLibraryInstalled();
	const define = {
		__RSPRESS_OBSIDIAN_MAPLIBRE_WORKER__: JSON.stringify(installed && hasMapLibraryWorkerModule()),
	};
	if (!installed) {
		return { resolve: { alias: { "maplibre-gl": false } }, source: { define } };
	}
	return {
		source: { define },
		splitChunks: {
			cacheGroups: {
				"obsidian-maplibre-css": {
					test: /[\\/]maplibre-gl[\\/]dist[\\/]maplibre-gl\.css$/,
					name: "maplibre-gl",
					chunks: "async",
					priority: 100,
					enforce: true,
				},
			},
		},
	};
}
