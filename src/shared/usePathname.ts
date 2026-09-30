import { useInRouterContext, useLocation, useNavigate } from "@rspress/core/runtime";
import { useCallback, useEffect, useState } from "react";

/**
 * The current route path, normalized to what the router calls it.
 *
 * Rspress mounts the whole app inside a react-router `BrowserRouter`
 * (`@rspress/core/runtime`, which re-exports the hooks used here), so the
 * router — not the document — is the source of truth. A client-side navigation
 * rewrites history and fires no `popstate`, so reading `window.location` on
 * its own left every graph frozen on the route it first mounted at: clicking a
 * sidebar link moved the page and the current node, the neighbourhood scope
 * and the hover preview all stayed behind. The router also strips the site
 * base from the path, which the raw pathname carried and no node id has.
 *
 * `window` is still the fallback, because the runtime components are exported
 * for custom themes: rendered outside a router (or on the server) there is
 * nothing to subscribe to.
 */
export function usePathname(): string {
	const inRouter = useInRouterContext();
	// biome-ignore lint/correctness/useHookAtTopLevel: `inRouter` is fixed for the life of the instance
	const location = inRouter ? useLocation() : null;
	const [documentPath, setDocumentPath] = useState(() =>
		typeof window === "undefined" ? "" : window.location.pathname,
	);

	useEffect(() => {
		if (inRouter) return;
		const sync = () =>
			setDocumentPath(typeof window === "undefined" ? "" : window.location.pathname);
		window.addEventListener("popstate", sync);
		return () => window.removeEventListener("popstate", sync);
	}, [inRouter]);

	return location?.pathname ?? documentPath;
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

/**
 * Navigate to a site route: a client-side transition inside the router (which
 * also resolves the site base), a document load outside one.
 */
export function useNavigateTo(): (href: string) => void {
	const inRouter = useInRouterContext();
	// biome-ignore lint/correctness/useHookAtTopLevel: `inRouter` is fixed for the life of the instance
	const navigate = inRouter ? useNavigate() : null;

	return useCallback(
		(href: string) => {
			if (navigate) {
				navigate(href);
			} else {
				navigation.assign(href);
			}
		},
		[navigate],
	);
}
