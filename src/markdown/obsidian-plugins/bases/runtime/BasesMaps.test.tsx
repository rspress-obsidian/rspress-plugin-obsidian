/**
 * The map views' client: the component that finds them and the renderer that
 * draws them, over markup shaped like the server's (see `map-markup.ts`).
 * MapLibre needs WebGL, which happy-dom has none of, so a stand-in library
 * records what the renderer asks of it; the boundary under test is that
 * request — position, zoom, background, markers and their links, popups —
 * and the page around it.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import BasesMaps from "./BasesMaps";
import {
	MAP_CANVAS_CLASS,
	MAP_CONFIG_ATTRIBUTE,
	MAP_INTERACTIVE_CLASS,
	MAP_VIEW_CLASS,
	type MapViewConfig,
} from "./map-markup";
import {
	disposeBasesMaps,
	type MapLibrary,
	mapLibraryFromModule,
	mapStyle,
	renderBasesMaps,
	setMapLibraryLoader,
} from "./maps";

interface FakeOptions {
	container: HTMLElement;
	style: unknown;
	center: unknown;
	zoom: number;
	minZoom: number;
	maxZoom: number;
	bounds?: FakeBounds;
	fitBoundsOptions?: unknown;
	attributionControl?: unknown;
	cooperativeGestures?: boolean;
}

class FakeBounds {
	readonly points: [number, number][] = [];
	extend(point: [number, number]): this {
		this.points.push(point);
		return this;
	}
	getCenter(): [number, number] {
		const sum = this.points.reduce(([lng, lat], [x, y]) => [lng + x, lat + y], [0, 0]);
		return [sum[0] / this.points.length, sum[1] / this.points.length];
	}
}

class FakeMap {
	static instances: FakeMap[] = [];
	style: unknown;
	center: unknown;
	controls: unknown[] = [];
	removed = false;
	constructor(readonly options: FakeOptions) {
		this.style = options.style;
		this.center = options.center;
		FakeMap.instances.push(this);
	}
	setStyle(style: unknown): void {
		this.style = style;
	}
	setCenter(center: unknown): void {
		this.center = center;
	}
	addControl(control: unknown): void {
		this.controls.push(control);
	}
	remove(): void {
		this.removed = true;
	}
}

class FakeMarker {
	static instances: FakeMarker[] = [];
	readonly element: HTMLElement;
	lngLat: unknown;
	constructor(options: { element: HTMLElement }) {
		this.element = options.element;
		FakeMarker.instances.push(this);
	}
	setLngLat(lngLat: unknown): this {
		this.lngLat = lngLat;
		return this;
	}
	addTo(map: FakeMap): this {
		map.options.container.append(this.element);
		return this;
	}
}

class FakePopup {
	static instances: FakePopup[] = [];
	readonly element = document.createElement("div");
	readonly handlers: Record<string, () => void> = {};
	content: HTMLElement | undefined;
	lngLat: unknown;
	isOpen = false;
	constructor(readonly options: unknown) {
		FakePopup.instances.push(this);
	}
	on(event: string, handler: () => void): this {
		this.handlers[event] = handler;
		return this;
	}
	setLngLat(lngLat: unknown): this {
		this.lngLat = lngLat;
		return this;
	}
	setDOMContent(content: HTMLElement): this {
		this.content = content;
		return this;
	}
	addTo(): this {
		if (!this.isOpen) {
			this.isOpen = true;
			this.handlers.open?.();
		}
		return this;
	}
	remove(): this {
		this.isOpen = false;
		return this;
	}
	getElement(): HTMLElement {
		return this.element;
	}
}

class FakeNavigationControl {
	constructor(readonly options: unknown) {}
}

const fakeLibrary = {
	Map: FakeMap,
	Marker: FakeMarker,
	Popup: FakePopup,
	LngLatBounds: FakeBounds,
	NavigationControl: FakeNavigationControl,
};

/** Resize observations, delivered by hand: a hidden view tab has no width until shown. */
const observed = new Set<Element>();
let deliver: ((width: number) => void) | undefined;
class FakeResizeObserver {
	constructor(callback: (entries: { target: Element; contentRect: { width: number } }[]) => void) {
		deliver = (width) =>
			callback([...observed].map((target) => ({ target, contentRect: { width } })));
	}
	observe(target: Element): void {
		observed.add(target);
		const width = target.getAttribute("data-test-width") === "0" ? 0 : 640;
		queueMicrotask(() => deliver?.(width));
	}
	unobserve(target: Element): void {
		observed.delete(target);
	}
}

const CONFIG: MapViewConfig = {
	center: null,
	zoom: null,
	minZoom: 0,
	maxZoom: 18,
	height: 400,
	tiles: ["https://tiles.example/bright"],
	tilesDark: ["https://tiles.example/dark"],
	attribution: "",
	base: "/",
	popupSkip: ["coordinates", "file.name"],
};

const TABLE = `<div class="bases-map-fallback"><table class="bases-table"><thead class="bases-thead"><tr class="bases-tr"><th class="bases-th" data-property="file.name">file name</th><th class="bases-th" data-property="country">country</th><th class="bases-th" data-property="coordinates">Location</th></tr></thead><tbody class="bases-tbody">
<tr class="bases-tr" data-map-lat="48.85" data-map-lng="2.29" data-map-title="Paris" data-map-route="/Places/Paris"><td class="bases-td" data-property="file.name"><a href="/Places/Paris">Paris</a></td><td class="bases-td" data-property="country"><em>France</em></td><td class="bases-td" data-property="coordinates"><span class="bases-map-pin" style="--bases-map-marker-color: red"><svg class="lucide-landmark"></svg></span>48.85, 2.29</td></tr>
<tr class="bases-tr" data-map-lat="41.9" data-map-lng="12.5" data-map-title="Rome"><td class="bases-td" data-property="file.name">Rome</td><td class="bases-td" data-property="country"></td><td class="bases-td" data-property="coordinates">41.9, 12.5</td></tr>
<tr class="bases-tr" data-map-lat="north" data-map-lng="0" data-map-title="Nowhere"><td class="bases-td" data-property="file.name">Nowhere</td></tr>
</tbody></table></div>`;

function addMapView(config: Partial<MapViewConfig> = {}, attributes: Record<string, string> = {}) {
	const view = document.createElement("div");
	view.className = MAP_VIEW_CLASS;
	view.setAttribute(MAP_CONFIG_ATTRIBUTE, JSON.stringify({ ...CONFIG, ...config }));
	for (const [name, value] of Object.entries(attributes)) view.setAttribute(name, value);
	view.innerHTML = TABLE;
	document.body.append(view);
	return view;
}

async function flush(): Promise<void> {
	for (let round = 0; round < 4; round += 1) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
}

const navigate = mock((_route: string) => {});
const realResizeObserver = globalThis.ResizeObserver;

beforeEach(() => {
	FakeMap.instances = [];
	FakeMarker.instances = [];
	FakePopup.instances = [];
	navigate.mockClear();
	observed.clear();
	globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
	setMapLibraryLoader(async () => fakeLibrary);
});

afterEach(() => {
	cleanup();
	disposeBasesMaps(true);
	document.body.innerHTML = "";
	document.documentElement.classList.remove("dark");
	globalThis.ResizeObserver = realResizeObserver;
	setMapLibraryLoader(null);
});

describe("mapStyle", () => {
	test("one URL without tile placeholders is a style URL, as the Maps plugin reads it", () => {
		expect(mapStyle(["https://tiles.openfreemap.org/styles/bright"])).toBe(
			"https://tiles.openfreemap.org/styles/bright",
		);
	});

	test("tile templates, or several URLs, are raster layers in order", () => {
		expect(mapStyle(["https://a.example/{z}/{x}/{y}.png", "https://b.example/style"])).toEqual({
			version: 8,
			sources: {
				"tiles-0": { type: "raster", tiles: ["https://a.example/{z}/{x}/{y}.png"], tileSize: 256 },
				"tiles-1": { type: "raster", tiles: ["https://b.example/style"], tileSize: 256 },
			},
			layers: [
				{ id: "tiles-0", type: "raster", source: "tiles-0" },
				{ id: "tiles-1", type: "raster", source: "tiles-1" },
			],
		});
	});
});

describe("mapLibraryFromModule", () => {
	test("finds MapLibre as the namespace or as its default export, and nothing in an empty module", () => {
		expect(mapLibraryFromModule(fakeLibrary)).toBe(fakeLibrary as unknown as MapLibrary);
		expect(mapLibraryFromModule({ default: fakeLibrary })).toBe(
			fakeLibrary as unknown as MapLibrary,
		);
		// What a site built without the peer gets: the alias's empty module.
		expect(mapLibraryFromModule({})).toBeNull();
		expect(mapLibraryFromModule({ default: {} })).toBeNull();
		expect(mapLibraryFromModule(undefined)).toBeNull();
	});
});

describe("renderBasesMaps", () => {
	test("draws the view's map over its markers, fitting them when no zoom is set", async () => {
		const view = addMapView();
		await renderBasesMaps(document.body, navigate);
		await flush();

		expect(FakeMap.instances).toHaveLength(1);
		const map = FakeMap.instances[0];
		const canvas = view.firstElementChild;
		expect(canvas?.className).toBe(MAP_CANVAS_CLASS);
		expect((canvas as HTMLElement).style.height).toBe("400px");
		expect(map?.options).toMatchObject({
			container: canvas,
			style: "https://tiles.example/bright",
			minZoom: 0,
			maxZoom: 18,
			cooperativeGestures: true,
			fitBoundsOptions: { padding: { top: 48, right: 48, bottom: 72, left: 48 } },
		});
		expect(map?.options.bounds?.points).toEqual([
			[2.29, 48.85],
			[12.5, 41.9],
		]);
		// No credit of the view's own: MapLibre's control shows the style's.
		expect(map?.options.attributionControl).toBeUndefined();
		expect(map?.controls).toHaveLength(1);
		// The table hides behind the map, but stays in the page.
		expect(view.classList.contains(MAP_INTERACTIVE_CLASS)).toBe(true);
		expect(view.querySelector("table")).not.toBeNull();
	});

	test("markers link to their notes with the site base, wearing the row's pin", async () => {
		addMapView({ base: "/site/" });
		await renderBasesMaps(document.body, navigate);
		await flush();

		const [paris, rome] = FakeMarker.instances;
		expect(FakeMarker.instances).toHaveLength(2);
		expect(paris?.lngLat).toEqual([2.29, 48.85]);
		expect(paris?.element.getAttribute("href")).toBe("/site/Places/Paris");
		expect(paris?.element.getAttribute("aria-label")).toBe("Paris");
		const pin = paris?.element.querySelector(".bases-map-pin");
		expect(pin?.getAttribute("style")).toContain("--bases-map-marker-color: red");
		expect(pin?.querySelector("svg.lucide-landmark")).not.toBeNull();
		// A file without a page has no link, but stays reachable by keyboard for its popup.
		expect(rome?.element.hasAttribute("href")).toBe(false);
		expect(rome?.element.tabIndex).toBe(0);
		expect(rome?.element.querySelector(".bases-map-pin")).not.toBeNull();

		// A plain click goes through the router; a modified one is the browser's.
		const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
		paris?.element.dispatchEvent(click);
		expect(click.defaultPrevented).toBe(true);
		expect(navigate).toHaveBeenCalledWith("/Places/Paris");
		const newTab = new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true });
		paris?.element.dispatchEvent(newTab);
		expect(newTab.defaultPrevented).toBe(false);
		rome?.element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(navigate).toHaveBeenCalledTimes(1);
	});

	test("a marker's popup shows the note's title as a link, then its other filled cells", async () => {
		addMapView({ base: "/site/" });
		await renderBasesMaps(document.body, navigate);
		await flush();
		const [paris, rome] = FakeMarker.instances;
		const popup = FakePopup.instances[0];

		paris?.element.dispatchEvent(new MouseEvent("mouseenter"));
		expect(popup?.isOpen).toBe(true);
		expect(popup?.lngLat).toEqual([2.29, 48.85]);
		const title = popup?.content?.querySelector<HTMLAnchorElement>(".bases-map-popup-title");
		expect(title?.textContent).toBe("Paris");
		expect(title?.getAttribute("href")).toBe("/site/Places/Paris");
		const labels = [
			...(popup?.content?.querySelectorAll(".bases-map-popup-property-label") ?? []),
		].map((label) => label.textContent);
		// The name is the title and the location is the marker: only the country is listed.
		expect(labels).toEqual(["country"]);
		expect(popup?.content?.querySelector(".bases-map-popup-property-value em")?.textContent).toBe(
			"France",
		);
		title?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(navigate).toHaveBeenCalledWith("/Places/Paris");

		// Leaving the marker closes the popup after a moment, unless the pointer reaches it.
		paris?.element.dispatchEvent(new MouseEvent("mouseleave"));
		popup?.element.dispatchEvent(new MouseEvent("mouseenter"));
		await Bun.sleep(200);
		expect(popup?.isOpen).toBe(true);
		popup?.element.dispatchEvent(new MouseEvent("mouseleave"));
		await Bun.sleep(200);
		expect(popup?.isOpen).toBe(false);

		// Keyboard focus opens it too; Rome has no page, no filled cell to list.
		rome?.element.dispatchEvent(new FocusEvent("focus"));
		expect(popup?.content?.querySelector(".bases-map-popup-title")?.tagName).toBe("DIV");
		expect(popup?.content?.querySelector(".bases-map-popup-properties")).toBeNull();
		rome?.element.dispatchEvent(new FocusEvent("blur"));
		await Bun.sleep(200);
		expect(popup?.isOpen).toBe(false);
	});

	test("a set center and zoom place the map; a credit of the view's own is shown", async () => {
		const view = addMapView({
			center: [10, 20],
			zoom: 6,
			height: null,
			attribution: '© <a href="https://example.com">Example</a>',
		});
		await renderBasesMaps(document.body, navigate);
		await flush();

		const map = FakeMap.instances[0];
		expect(map?.options).toMatchObject({ center: [20, 10], zoom: 6 });
		expect(map?.options.bounds).toBeUndefined();
		expect(map?.options.attributionControl).toEqual({
			customAttribution: '© <a href="https://example.com">Example</a>',
		});
		// The base's own page sizes the map from the stylesheet.
		expect((view.firstElementChild as HTMLElement).style.height).toBe("");
	});

	test("a set center with no zoom fits the markers, then moves to the center", async () => {
		addMapView({ center: [1, 2] });
		await renderBasesMaps(document.body, navigate);
		await flush();
		expect(FakeMap.instances[0]?.options.bounds).toBeDefined();
		expect(FakeMap.instances[0]?.center).toEqual([2, 1]);
	});

	test("a view with no located row opens on the default place and zoom", async () => {
		const view = addMapView();
		for (const row of view.querySelectorAll("tbody tr")) row.remove();
		await renderBasesMaps(document.body, navigate);
		await flush();
		expect(FakeMap.instances[0]?.options).toMatchObject({ center: [0, 0], zoom: 4 });
		expect(FakeMap.instances[0]?.options.bounds).toBeUndefined();
	});

	test("the background follows the site's dark mode", async () => {
		document.documentElement.classList.add("dark");
		addMapView();
		addMapView({
			tiles: ["https://same.example/style"],
			tilesDark: ["https://same.example/style"],
		});
		await renderBasesMaps(document.body, navigate);
		await flush();
		const [themed, same] = FakeMap.instances;
		expect(themed?.style).toBe("https://tiles.example/dark");

		document.documentElement.classList.remove("dark");
		await flush();
		expect(themed?.style).toBe("https://tiles.example/bright");
		expect(same?.style).toBe("https://same.example/style");
		document.documentElement.classList.add("dark");
		await flush();
		expect(themed?.style).toBe("https://tiles.example/dark");
	});

	test("idempotent: a view already drawn is left alone", async () => {
		addMapView();
		await renderBasesMaps(document.body, navigate);
		await flush();
		await renderBasesMaps(document.body, navigate);
		await flush();
		expect(FakeMap.instances).toHaveLength(1);
		expect(document.querySelectorAll(`.${MAP_CANVAS_CLASS}`)).toHaveLength(1);
	});

	test("a view in a hidden tab is drawn once it is shown", async () => {
		addMapView({}, { "data-test-width": "0" });
		await renderBasesMaps(document.body, navigate);
		await flush();
		expect(FakeMap.instances).toHaveLength(0);
		deliver?.(640);
		expect(FakeMap.instances).toHaveLength(1);
	});

	test("a view that leaves the page releases its map", async () => {
		const view = addMapView();
		const hidden = addMapView({}, { "data-test-width": "0" });
		await renderBasesMaps(document.body, navigate);
		await flush();
		view.remove();
		hidden.remove();
		disposeBasesMaps();
		expect(FakeMap.instances[0]?.removed).toBe(true);
		expect(observed.size).toBe(0);
	});

	test("a view whose settings are not JSON keeps its table", async () => {
		const view = addMapView();
		view.setAttribute(MAP_CONFIG_ATTRIBUTE, "{broken");
		await renderBasesMaps(document.body, navigate);
		await flush();
		expect(FakeMap.instances).toHaveLength(0);
		expect(view.classList.contains(MAP_INTERACTIVE_CLASS)).toBe(false);
	});

	test("without ResizeObserver the map is drawn at once", async () => {
		globalThis.ResizeObserver = undefined as unknown as typeof ResizeObserver;
		addMapView();
		await renderBasesMaps(document.body, navigate);
		expect(FakeMap.instances).toHaveLength(1);
	});

	test("no peer: nothing happens, the table stays", async () => {
		const loader = mock(async () => ({}));
		setMapLibraryLoader(loader);
		const view = addMapView();
		const before = view.innerHTML;
		await renderBasesMaps(document.body, navigate);
		await flush();
		expect(loader).toHaveBeenCalledTimes(1);
		expect(FakeMap.instances).toHaveLength(0);
		expect(view.innerHTML).toBe(before);
		expect(view.classList.contains(MAP_INTERACTIVE_CLASS)).toBe(false);
		// The answer is kept: the next scan does not import again.
		await renderBasesMaps(document.body, navigate);
		expect(loader).toHaveBeenCalledTimes(1);
	});

	test("a library chunk that failed to load leaves the table, and the next scan retries", async () => {
		const warn = mock(() => {});
		const realWarn = console.warn;
		console.warn = warn;
		try {
			let attempts = 0;
			setMapLibraryLoader(async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("ChunkLoadError");
				return fakeLibrary;
			});
			addMapView();
			await renderBasesMaps(document.body, navigate);
			expect(FakeMap.instances).toHaveLength(0);
			expect(warn).toHaveBeenCalledTimes(1);
			await renderBasesMaps(document.body, navigate);
			await flush();
			expect(FakeMap.instances).toHaveLength(1);
		} finally {
			console.warn = realWarn;
		}
	});

	test("a page without map views loads nothing", async () => {
		const loader = mock(async () => fakeLibrary);
		setMapLibraryLoader(loader);
		await renderBasesMaps(document.body, navigate);
		expect(loader).not.toHaveBeenCalled();
	});
});

describe("BasesMaps", () => {
	// The scan is throttled through `requestAnimationFrame`; run frames by hand.
	const frames: Array<() => void> = [];
	const realRequestFrame = globalThis.requestAnimationFrame;
	const realCancelFrame = globalThis.cancelAnimationFrame;

	beforeEach(() => {
		frames.length = 0;
		globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
			frames.push(() => callback(0));
			return frames.length;
		}) as typeof requestAnimationFrame;
		globalThis.cancelAnimationFrame = ((id: number) => {
			frames[id - 1] = () => {};
		}) as typeof cancelAnimationFrame;
	});

	afterEach(() => {
		globalThis.requestAnimationFrame = realRequestFrame;
		globalThis.cancelAnimationFrame = realCancelFrame;
	});

	async function settle(): Promise<void> {
		for (let round = 0; round < 4; round += 1) {
			await flush();
			for (const run of frames.splice(0)) run();
		}
	}

	test("draws the map views already in the server-rendered page, and renders nothing itself", async () => {
		addMapView();
		const { container } = render(<BasesMaps />);
		await settle();
		expect(container.firstChild).toBeNull();
		expect(FakeMap.instances).toHaveLength(1);
	});

	test("loads nothing on a page without a map view", async () => {
		const loader = mock(async () => fakeLibrary);
		setMapLibraryLoader(loader);
		render(<BasesMaps />);
		await settle();
		expect(loader).not.toHaveBeenCalled();
	});

	test("picks up a view committed later, and releases the map of one that left", async () => {
		render(<BasesMaps />);
		await settle();
		const view = addMapView();
		await settle();
		expect(FakeMap.instances).toHaveLength(1);

		// The next route has no map: the old one is released.
		view.remove();
		await settle();
		expect(FakeMap.instances[0]?.removed).toBe(true);
	});

	test("unmounting releases every map", async () => {
		addMapView();
		const { unmount } = render(<BasesMaps />);
		await settle();
		unmount();
		expect(FakeMap.instances[0]?.removed).toBe(true);
	});
});
