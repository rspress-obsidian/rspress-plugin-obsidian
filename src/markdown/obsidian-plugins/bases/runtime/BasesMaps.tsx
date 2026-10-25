import { useEffect } from "react";
import { useNavigateTo, usePathname } from "../../../../shared/usePathname.js";
import { MAP_CONFIG_ATTRIBUTE, MAP_VIEW_CLASS } from "./map-markup.js";
// Type-only: erased from the bundle, so the renderer stays out of the entry chunk.
import type * as MapsModule from "./maps.js";

const VIEW_SELECTOR = `.${MAP_VIEW_CLASS}[${MAP_CONFIG_ATTRIBUTE}]`;

/**
 * The renderer, imported on the first page that has a map view. This component
 * is mounted on every page, so a static import would ship the renderer in the
 * entry chunk every reader downloads. Kept once loaded, so releasing maps on
 * unmount stays synchronous.
 */
let maps: typeof MapsModule | null = null;
let loading: Promise<void> | null = null;

/**
 * Draws every Bases map view on the page as an interactive map.
 *
 * The views are server-rendered tables, so the first scan usually finds them
 * already in the DOM; the mutation observer stays connected because Rspress
 * renders each route inside `Suspense` and a slow route chunk can commit after
 * the first frame. An idle scan costs one `querySelector`, throttled to a
 * frame. The renderer and MapLibre are loaded only when a page has a map view.
 *
 * Registered by the Bases feature through `globalUIComponents`. Renders
 * nothing itself.
 */
export default function BasesMaps() {
	const pathname = usePathname();
	const navigateTo = useNavigateTo();

	// `pathname` is the route-change trigger, not an input to the scan.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-run per route
	useEffect(() => {
		let frame = 0;
		let active = true;

		const scan = () => {
			frame = 0;
			// A view that left the page releases its map even when no other is left.
			if (!document.querySelector(VIEW_SELECTOR)) {
				maps?.disposeBasesMaps();
				return;
			}
			if (maps) {
				void maps.renderBasesMaps(document.body, navigateTo);
				return;
			}
			loading ??= import("./maps.js").then(
				(module) => {
					maps = module;
				},
				(error: unknown) => {
					// A chunk that failed to download: forget it so a later scan retries; the tables stay.
					loading = null;
					console.warn("[rspress-plugin-obsidian] the map renderer failed to load:", error);
				},
			);
			void loading.then(() => {
				if (active && maps) schedule();
			});
		};
		const schedule = () => {
			if (frame) return;
			frame = requestAnimationFrame(scan);
		};

		schedule();
		const observer = new MutationObserver(schedule);
		observer.observe(document.body, { childList: true, subtree: true });

		return () => {
			active = false;
			observer.disconnect();
			if (frame) cancelAnimationFrame(frame);
		};
	}, [pathname, navigateTo]);

	useEffect(() => () => maps?.disposeBasesMaps(true), []);

	return null;
}
