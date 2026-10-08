/**
 * Turns each server-rendered map view (see `map-markup.ts`) into an
 * interactive MapLibre map, the library of Obsidian's Maps plugin.
 *
 * The view's table stays in the page: it is the no-JavaScript fallback, what
 * the search index reads, and where each marker comes from. A located row
 * carries the marker's position, title and route; its location cell holds the
 * pin (colour and icon) the marker clones; its other cells fill the popup.
 *
 * MapLibre is an optional peer. A site built without it aliases the import to
 * an empty module, so the library resolves to `null` here and every table is
 * left as it is.
 */
import type * as MapLibre from "maplibre-gl";
import {
	DEFAULT_MAP_ZOOM,
	MAP_CANVAS_CLASS,
	MAP_CONFIG_ATTRIBUTE,
	MAP_INTERACTIVE_CLASS,
	MAP_PIN_CLASS,
	MAP_ROW_ATTRIBUTES,
	MAP_VIEW_CLASS,
	type MapViewConfig,
} from "./map-markup.js";

export type MapLibrary = typeof MapLibre;

/** How long a popup stays after the pointer leaves its marker, so it can be reached. */
const POPUP_HIDE_DELAY_MS = 150;

const VIEW_SELECTOR = `.${MAP_VIEW_CLASS}[${MAP_CONFIG_ATTRIBUTE}]`;

interface MountedMap {
	map: MapLibre.Map;
	config: MapViewConfig;
	dark: boolean;
}

interface MapMarker {
	lat: number;
	lng: number;
	title: string;
	/** The note's route without the site base, and its href with it. */
	route?: string;
	href?: string;
	row: HTMLTableRowElement;
}

function defaultImport(): Promise<unknown> {
	// Optional peer, loaded only when a map view is on the page: a static
	// import would put MapLibre (~800 kB) in the chunk every page loads.
	return Promise.all([
		import("maplibre-gl"),
		// @ts-expect-error -- a stylesheet: the site's bundler injects it; it has no module type.
		import("maplibre-gl/dist/maplibre-gl.css"),
	]).then(([library]) => library);
}

let importLibrary: () => Promise<unknown> = defaultImport;
let libraryPromise: Promise<MapLibrary | null> | null = null;
let library: MapLibrary | null = null;
let navigateTo: (route: string) => void = () => {};

const mounted = new Map<HTMLElement, MountedMap>();
/** Views waiting for a size: a map drawn in a hidden view tab would fit its markers into nothing. */
const waiting = new Set<HTMLElement>();
let resizeObserver: ResizeObserver | null = null;
let themeObserver: MutationObserver | null = null;

/**
 * Replace how the MapLibre module namespace is obtained; `null` restores the
 * real import. Internal: tests use it to stand in for the library and for a
 * site built without it.
 */
export function setMapLibraryLoader(loader: (() => Promise<unknown>) | null): void {
	importLibrary = loader ?? defaultImport;
	libraryPromise = null;
	library = null;
}

/**
 * The MapLibre API in a module namespace (bundlers expose the UMD build as the
 * namespace or as its `default`), or `null` for the empty module a site built
 * without the peer gets.
 */
export function mapLibraryFromModule(module: unknown): MapLibrary | null {
	const candidates = [
		module,
		typeof module === "object" && module !== null && "default" in module
			? module.default
			: undefined,
	];
	for (const candidate of candidates) {
		if (
			typeof candidate === "object" &&
			candidate !== null &&
			"Map" in candidate &&
			typeof candidate.Map === "function" &&
			"Marker" in candidate &&
			"Popup" in candidate &&
			"LngLatBounds" in candidate &&
			"NavigationControl" in candidate
		) {
			// Shape checked above; the namespace's full type is MapLibre's own.
			const api = candidate as MapLibrary;
			return api;
		}
	}
	return null;
}

function loadLibrary(): Promise<MapLibrary | null> {
	libraryPromise ??= importLibrary().then(mapLibraryFromModule, (error: unknown) => {
		// A chunk that failed to download is not a missing package: forget the
		// attempt, so the next scan retries; the tables stay meanwhile.
		libraryPromise = null;
		console.warn("[rspress-plugin-obsidian] the map library failed to load:", error);
		return null;
	});
	return libraryPromise;
}

/**
 * The MapLibre style for a background: one URL without `{z}`/`{x}`/`{y}` is a
 * style URL (OpenFreeMap's, a TileJSON), anything else raster tile templates,
 * as the Maps plugin reads its `mapTiles` setting.
 */
export function mapStyle(tiles: string[]): string | MapLibre.StyleSpecification {
	const [first] = tiles;
	if (tiles.length === 1 && first && !/\{[zxy]\}/.test(first)) return first;
	const sources: MapLibre.StyleSpecification["sources"] = {};
	const layers: MapLibre.StyleSpecification["layers"] = [];
	for (const [index, url] of tiles.entries()) {
		sources[`tiles-${index}`] = { type: "raster", tiles: [url], tileSize: 256 };
		layers.push({ id: `tiles-${index}`, type: "raster", source: `tiles-${index}` });
	}
	return { version: 8, sources, layers };
}

function isDark(): boolean {
	return document.documentElement.classList.contains("dark");
}

function readConfig(view: HTMLElement): MapViewConfig | undefined {
	try {
		const config: MapViewConfig = JSON.parse(view.getAttribute(MAP_CONFIG_ATTRIBUTE) ?? "");
		return config;
	} catch {
		return undefined;
	}
}

function markersOf(view: HTMLElement, config: MapViewConfig): MapMarker[] {
	const markers: MapMarker[] = [];
	for (const row of view.querySelectorAll<HTMLTableRowElement>(`tr[${MAP_ROW_ATTRIBUTES.lat}]`)) {
		const lat = Number(row.getAttribute(MAP_ROW_ATTRIBUTES.lat));
		const lng = Number(row.getAttribute(MAP_ROW_ATTRIBUTES.lng));
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
		const route = row.getAttribute(MAP_ROW_ATTRIBUTES.route) ?? undefined;
		markers.push({
			lat,
			lng,
			title: row.getAttribute(MAP_ROW_ATTRIBUTES.title) ?? "",
			route,
			href: route && config.base !== "/" ? `${config.base}${route.replace(/^\//, "")}` : route,
			row,
		});
	}
	return markers;
}

/** A plain primary click on a note link goes through the router; anything else is the browser's. */
function followLink(event: MouseEvent, route: string | undefined): void {
	if (
		!route ||
		event.button !== 0 ||
		event.metaKey ||
		event.ctrlKey ||
		event.shiftKey ||
		event.altKey
	) {
		return;
	}
	event.preventDefault();
	navigateTo(route);
}

/** The popup: the note's title, linking to it, then the row's other non-empty cells, labelled. */
function popupContent(marker: MapMarker, view: HTMLElement, config: MapViewConfig): HTMLElement {
	const box = document.createElement("div");
	box.className = "bases-map-popup";
	const title = document.createElement(marker.href ? "a" : "div");
	title.className = "bases-map-popup-title";
	title.textContent = marker.title;
	if (title instanceof HTMLAnchorElement && marker.href) {
		title.href = marker.href;
		title.addEventListener("click", (event) => followLink(event, marker.route));
	}
	box.append(title);
	const headers = view.querySelector("thead tr")?.children;
	const properties = document.createElement("div");
	properties.className = "bases-map-popup-properties";
	for (const [index, cell] of [...marker.row.cells].entries()) {
		const property = cell.getAttribute("data-property") ?? "";
		if (config.popupSkip.includes(property)) continue;
		if (cell.textContent?.trim() === "" && !cell.querySelector("img, svg, input")) continue;
		const item = document.createElement("div");
		item.className = "bases-map-popup-property";
		const label = document.createElement("div");
		label.className = "bases-map-popup-property-label";
		label.textContent = headers?.[index]?.textContent ?? property;
		const value = document.createElement("div");
		value.className = "bases-map-popup-property-value";
		for (const child of cell.childNodes) value.append(child.cloneNode(true));
		item.append(label, value);
		properties.append(item);
	}
	if (properties.childElementCount > 0) box.append(properties);
	return box;
}

function mount(view: HTMLElement, maplibre: MapLibrary): void {
	const config = readConfig(view);
	if (!config || mounted.has(view)) return;
	const markers = markersOf(view, config);
	const canvas = document.createElement("div");
	canvas.className = MAP_CANVAS_CLASS;
	if (config.height !== null) canvas.style.height = `${config.height}px`;
	view.insertBefore(canvas, view.firstChild);

	const dark = isDark();
	const bounds = new maplibre.LngLatBounds();
	for (const marker of markers) bounds.extend([marker.lng, marker.lat]);
	// The Maps plugin centres on `center`, else the markers, and zooms to
	// `defaultZoom`, else to fit the markers.
	const fit = config.zoom === null && markers.length > 0;
	const center: MapLibre.LngLatLike | undefined = config.center
		? [config.center[1], config.center[0]]
		: markers.length > 0
			? bounds.getCenter()
			: undefined;
	const options: MapLibre.MapOptions = {
		container: canvas,
		style: mapStyle(dark ? config.tilesDark : config.tiles),
		center: center ?? [0, 0],
		zoom: config.zoom ?? DEFAULT_MAP_ZOOM,
		minZoom: config.minZoom,
		maxZoom: config.maxZoom,
		// A map in a scrolling page zooms on Ctrl/⌘ + wheel, so the page still scrolls.
		cooperativeGestures: true,
	};
	if (fit) {
		options.bounds = bounds;
		// Room around the outer markers, and below them for the attribution bar.
		options.fitBoundsOptions = { padding: { top: 48, right: 48, bottom: 72, left: 48 } };
	}
	if (config.attribution) options.attributionControl = { customAttribution: config.attribution };
	const map = new maplibre.Map(options);
	if (fit && config.center) map.setCenter(center ?? [0, 0]);
	map.addControl(new maplibre.NavigationControl({ showCompass: false }), "top-right");

	const popup = new maplibre.Popup({
		closeButton: false,
		closeOnClick: false,
		offset: 16,
		maxWidth: "280px",
		// Opened on hover: moving focus into it would scroll the page and blur the marker.
		focusAfterOpen: false,
	});
	let hideTimer: number | undefined;
	const keepPopup = () => window.clearTimeout(hideTimer);
	const hidePopup = () => {
		keepPopup();
		hideTimer = window.setTimeout(() => popup.remove(), POPUP_HIDE_DELAY_MS);
	};
	popup.on("open", () => {
		const element = popup.getElement();
		element.addEventListener("mouseenter", keepPopup);
		element.addEventListener("mouseleave", hidePopup);
	});

	for (const marker of markers) {
		const element = document.createElement("a");
		element.className = "bases-map-marker";
		element.setAttribute("aria-label", marker.title);
		if (marker.href) element.href = marker.href;
		else element.tabIndex = 0;
		const pin = marker.row.querySelector(`.${MAP_PIN_CLASS}`)?.cloneNode(true);
		if (pin) {
			element.append(pin);
		} else {
			const dot = document.createElement("span");
			dot.className = MAP_PIN_CLASS;
			element.append(dot);
		}
		const showPopup = () => {
			keepPopup();
			popup
				.setLngLat([marker.lng, marker.lat])
				.setDOMContent(popupContent(marker, view, config))
				.addTo(map);
		};
		element.addEventListener("mouseenter", showPopup);
		element.addEventListener("focus", showPopup);
		element.addEventListener("mouseleave", hidePopup);
		element.addEventListener("blur", hidePopup);
		element.addEventListener("click", (event) => followLink(event, marker.route));
		new maplibre.Marker({ element }).setLngLat([marker.lng, marker.lat]).addTo(map);
	}

	view.classList.add(MAP_INTERACTIVE_CLASS);
	mounted.set(view, { map, config, dark });
	watchTheme();
}

/** Redraws each map's background when the site's `.dark` class flips. */
function watchTheme(): void {
	if (themeObserver) return;
	themeObserver = new MutationObserver(() => {
		const dark = isDark();
		for (const entry of mounted.values()) {
			if (entry.dark === dark) continue;
			entry.dark = dark;
			// Markers are DOM elements, so a style change leaves them in place.
			if (entry.config.tilesDark.join("\n") !== entry.config.tiles.join("\n")) {
				entry.map.setStyle(mapStyle(dark ? entry.config.tilesDark : entry.config.tiles));
			}
		}
	});
	themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
}

/** Mount `view` once it has a width: now, or when its view tab is first shown. */
function mountWhenSized(view: HTMLElement, maplibre: MapLibrary): void {
	if (typeof ResizeObserver === "undefined") {
		mount(view, maplibre);
		return;
	}
	waiting.add(view);
	resizeObserver ??= new ResizeObserver((entries) => {
		for (const entry of entries) {
			if (entry.contentRect.width <= 0 || !(entry.target instanceof HTMLElement)) continue;
			resizeObserver?.unobserve(entry.target);
			waiting.delete(entry.target);
			if (library) mount(entry.target, library);
		}
	});
	resizeObserver.observe(view);
}

/** Release the maps (and waits) of views no longer in the document; `all` releases every one. */
export function disposeBasesMaps(all = false): void {
	for (const [view, entry] of mounted) {
		if (!all && view.isConnected) continue;
		entry.map.remove();
		mounted.delete(view);
	}
	for (const view of waiting) {
		if (!all && view.isConnected) continue;
		resizeObserver?.unobserve(view);
		waiting.delete(view);
	}
	if (mounted.size === 0) {
		themeObserver?.disconnect();
		themeObserver = null;
	}
}

/**
 * Draw every map view under `root` that is not drawn yet. Idempotent: safe to
 * call after every DOM change. `navigate` follows a marker to its note
 * through the site's router.
 */
export async function renderBasesMaps(
	root: ParentNode,
	navigate: (route: string) => void,
): Promise<void> {
	navigateTo = navigate;
	disposeBasesMaps();
	const views = [...root.querySelectorAll<HTMLElement>(VIEW_SELECTOR)].filter(
		(view) => !mounted.has(view) && !waiting.has(view),
	);
	if (views.length === 0) return;
	library = await loadLibrary();
	if (!library) return;
	for (const view of views) {
		if (view.isConnected && !mounted.has(view) && !waiting.has(view)) {
			mountWhenSized(view, library);
		}
	}
}
