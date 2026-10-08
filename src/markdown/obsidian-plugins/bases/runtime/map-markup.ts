/**
 * The markup contract between a map view's server-rendered table and the
 * client that turns it into an interactive map. A leaf module with no imports:
 * the build-time renderer and the browser component both read it, and neither
 * may drag the other's dependencies in.
 */

/** Wraps a map view's table; carries the view's {@link MapViewConfig} as JSON. */
export const MAP_VIEW_CLASS = "bases-map-view";
export const MAP_CONFIG_ATTRIBUTE = "data-bases-map";
/** Set on a map view once its interactive map is drawn; the table then hides. */
export const MAP_INTERACTIVE_CLASS = "is-interactive";
/** The element MapLibre draws into, inserted before the table. */
export const MAP_CANVAS_CLASS = "bases-map";
/** A marker's colour circle and icon, in the location cell; the marker clones it. */
export const MAP_PIN_CLASS = "bases-map-pin";

/** Attributes of a located row (`<tr>`): where it is and the note it links to. */
export const MAP_ROW_ATTRIBUTES = {
	lat: "data-map-lat",
	lng: "data-map-lng",
	title: "data-map-title",
	/** The note's route, without the site base; absent when the file has no page. */
	route: "data-map-route",
} as const;

/** OpenFreeMap's styles: the Maps plugin's own default background, public and keyless. */
export const DEFAULT_MAP_TILES = "https://tiles.openfreemap.org/styles/bright";
export const DEFAULT_MAP_TILES_DARK = "https://tiles.openfreemap.org/styles/dark";
/** The zoom the Maps plugin opens at when a view sets none and has no marker to fit. */
export const DEFAULT_MAP_ZOOM = 4;

/** A map view's settings, resolved at build time from the view, the site options and the vault. */
export interface MapViewConfig {
	/** `center`, as `[lat, lng]`; `null` centres on the markers. */
	center: [number, number] | null;
	/** `defaultZoom`; `null` fits the markers. */
	zoom: number | null;
	minZoom: number;
	maxZoom: number;
	/** Height in pixels of an embedded map (`mapHeight`); `null` lets the stylesheet size it. */
	height: number | null;
	/** Style URL, or raster tile URL templates (`{z}/{x}/{y}`), in light mode. */
	tiles: string[];
	/** The same in dark mode. */
	tilesDark: string[];
	/** Credit shown on the map, as HTML; `""` leaves only the style's own. */
	attribution: string;
	/** The site base (`/…/`), which marker links carry. */
	base: string;
	/** Columns (`data-property`) a popup leaves out: the title, location and marker settings. */
	popupSkip: string[];
}
