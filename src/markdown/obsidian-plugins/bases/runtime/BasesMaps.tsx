import { useEffect } from "react";
import { useNavigateTo, usePathname } from "../../../../shared/usePathname.js";
import { MAP_CONFIG_ATTRIBUTE, MAP_VIEW_CLASS } from "./map-markup.js";
import { disposeBasesMaps, renderBasesMaps } from "./maps.js";

const VIEW_SELECTOR = `.${MAP_VIEW_CLASS}[${MAP_CONFIG_ATTRIBUTE}]`;

/**
 * Draws every Bases map view on the page as an interactive map.
 *
 * The views are server-rendered tables, so the first scan usually finds them
 * already in the DOM; the mutation observer stays connected because Rspress
 * renders each route inside `Suspense` and a slow route chunk can commit after
 * the first frame. An idle scan costs one `querySelector`, throttled to a
 * frame. MapLibre itself is loaded only when a page has a map view.
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

		const scan = () => {
			frame = 0;
			// A view that left the page releases its map even when no other is left.
			if (!document.querySelector(VIEW_SELECTOR)) {
				disposeBasesMaps();
				return;
			}
			void renderBasesMaps(document.body, navigateTo);
		};
		const schedule = () => {
			if (frame) return;
			frame = requestAnimationFrame(scan);
		};

		schedule();
		const observer = new MutationObserver(schedule);
		observer.observe(document.body, { childList: true, subtree: true });

		return () => {
			observer.disconnect();
			if (frame) cancelAnimationFrame(frame);
		};
	}, [pathname, navigateTo]);

	useEffect(() => () => disposeBasesMaps(true), []);

	return null;
}
