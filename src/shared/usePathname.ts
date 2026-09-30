import { useEffect, useState } from "react";

/**
 * The current path, without asking the host router for it.
 *
 * Four components imported `useLocation` and `useNavigate` from
 * `@rspress/core/runtime`. That entry exports only `isDataUrl`, `isExternalUrl`,
 * `matchNavbar`, `matchSidebar` and `normalizeHref` at Rspress 2.0.21 — neither
 * hook exists. A bundler follows the re-export chain and tolerates the missing
 * names, so the built site worked; Bun's ESM validator does not, and the unit
 * suite failed to load on macOS with `SyntaxError: Export named 'useNavigate'
 * not found`. The tests passed only because each one stubbed the module with
 * those two symbols in it, which is also why nothing caught the invalid import.
 *
 * On a published site a route change is a document load, so the path only has to
 * be right when a component mounts and navigation is the browser's own job.
 */
export function usePathname(): string {
	const [pathname, setPathname] = useState(() =>
		typeof window === "undefined" ? "" : window.location.pathname,
	);

	useEffect(() => {
		const sync = () => setPathname(window.location.pathname);
		sync();
		window.addEventListener("popstate", sync);
		return () => window.removeEventListener("popstate", sync);
	}, []);

	return pathname;
}

/**
 * The navigation seam. Indirected because a published site's
 * `window.location` cannot be spied on under happy-dom, and the panel's click
 * handling is worth asserting — so a test replaces this one property rather
 * than mocking the whole module.
 */
export const navigation = {
	assign(href: string): void {
		if (typeof window !== "undefined") window.location.assign(href);
	},
};

/** Navigate to a site route — a full document load, which is what it is. */
export function navigate(href: string): void {
	navigation.assign(href);
}
