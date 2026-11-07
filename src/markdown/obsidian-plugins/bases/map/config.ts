/**
 * What a map view's settings and the site's options say about the map itself:
 * its background, its zoom levels, its centre and its marker colours, read the
 * way Obsidian's Maps plugin reads them. A map's rows, markers and table are
 * the base's; this file is only the map's own configuration.
 */
import { readObsidianPluginSettings } from "../../settings.js";
import { layoutSettings, type SettingsOf, type ViewConfig } from "../config.js";
import { compileExpression, type EvalEnv, evaluate, RowScope } from "../evaluate.js";
import type { BasesOptions } from "../options.js";
import {
	DEFAULT_MAP_TILES,
	DEFAULT_MAP_TILES_DARK,
	type MapViewConfig,
} from "../runtime/map-markup.js";
import { ErrorValue } from "../values.js";

/** `"lat, lng"` or `[lat, lng]`, as the Maps plugin reads a coordinates property. */
export function coordinatesOf(value: unknown): [number, number] | undefined {
	const parts =
		typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : undefined;
	if (parts?.length !== 2) return undefined;
	const [lat, lng] = parts.map((part) =>
		typeof part === "string"
			? Number(part.trim() || Number.NaN)
			: typeof part === "number"
				? part
				: Number.NaN,
	);
	if (lat === undefined || lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) {
		return undefined;
	}
	return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lat, lng] : undefined;
}

/** A CSS colour as the Maps plugin takes one: hex, a name, a colour function or a custom property. */
const CSS_COLOR =
	/^(?:#[\da-f]{3,8}|[a-z]+|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([\w\s.,%/+-]*\)|var\(--[\w-]+\))$/i;

/** Whether a marker colour is one a browser will paint the pin with. */
export function isMarkerColor(value: string): boolean {
	return CSS_COLOR.test(value);
}

const OSM_ATTRIBUTION = "© [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors";

/** A `mapTiles` setting (one URL or a list) as the URLs a browser may fetch. */
function tileUrls(value: unknown): string[] {
	return (Array.isArray(value) ? value : [value])
		.filter((url): url is string => typeof url === "string")
		.map((url) => url.trim())
		.filter((url) => /^(?:https?:)?\/\//i.test(url) || url.startsWith("/"));
}

interface MapBackground {
	tiles: string[];
	tilesDark: string[];
	/** Inline markdown. */
	attribution?: string;
}

/**
 * A view's background, as the Maps plugin picks it: the view's own
 * `mapTiles`, else the site's `bases.mapTiles`, else the plugin's first
 * configured background, else OpenFreeMap. Dark mode falls back to light.
 */
export function mapBackground(
	view: ViewConfig,
	options: BasesOptions,
	vaultRoot: string | undefined,
): MapBackground {
	const tileSets =
		options.readVaultSettings === false
			? undefined
			: readObsidianPluginSettings(vaultRoot, "maps")?.tileSets;
	const vaultSet: unknown = Array.isArray(tileSets) ? tileSets[0] : undefined;
	const vault =
		vaultSet && typeof vaultSet === "object"
			? {
					tiles: tileUrls("lightTiles" in vaultSet ? vaultSet.lightTiles : undefined),
					tilesDark: tileUrls("darkTiles" in vaultSet ? vaultSet.darkTiles : undefined),
				}
			: undefined;
	const settings = layoutSettings<"map">(view);
	const candidates: Array<MapBackground | undefined> = [
		{ tiles: tileUrls(settings.mapTiles), tilesDark: tileUrls(settings.mapTilesDark) },
		{
			tiles: tileUrls(options.mapTiles?.tiles),
			tilesDark: tileUrls(options.mapTiles?.tilesDark),
			attribution: options.mapTiles?.attribution,
		},
		vault,
	];
	const background = candidates.find((candidate) => candidate && candidate.tiles.length > 0) ?? {
		tiles: [DEFAULT_MAP_TILES],
		tilesDark: [DEFAULT_MAP_TILES_DARK],
	};
	const tilesDark = background.tilesDark.length > 0 ? background.tilesDark : background.tiles;
	const osm = [...background.tiles, ...tilesDark].some((url) =>
		/\btile\.openstreetmap\.org\//i.test(url),
	);
	return {
		tiles: background.tiles,
		tilesDark,
		attribution: background.attribution ?? (osm ? OSM_ATTRIBUTION : undefined),
	};
}

/** A numeric view setting, clamped as the Maps plugin clamps it; `fallback` when unset. */
export function zoomSetting(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(max, Math.max(min, value))
		: fallback;
}

/**
 * `center`: a formula (`[48.85, 2.29]`, `this.coordinates`) evaluated with
 * `this`, else the older `"lat, lng"` text; `null` centres on the markers.
 */
export function mapCenter(value: unknown, env: EvalEnv): [number, number] | null {
	if (Array.isArray(value)) return coordinatesOf(value) ?? null;
	if (typeof value !== "string" || value.trim() === "") return null;
	const expression = compileExpression(value);
	const evaluated =
		expression instanceof ErrorValue
			? undefined
			: coordinatesOf(evaluate(expression, env, new RowScope(env.thisFile)));
	return evaluated ?? coordinatesOf(value) ?? null;
}

/** The zoom levels a view configures: `minZoom`, `maxZoom`, and the view's own `defaultZoom`. */
export function zoomLevels(
	settings: SettingsOf<"map">,
): Pick<MapViewConfig, "minZoom" | "maxZoom" | "zoom"> {
	const minZoom = zoomSetting(settings.minZoom, 0, 0, 24);
	const maxZoom = zoomSetting(settings.maxZoom, 18, 0, 24);
	return {
		minZoom,
		maxZoom,
		zoom:
			typeof settings.defaultZoom === "number"
				? zoomSetting(settings.defaultZoom, 0, minZoom, maxZoom)
				: null,
	};
}
