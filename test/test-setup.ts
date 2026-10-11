import { beforeEach, mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ReactNode } from "react";
import { createContext, createElement } from "react";
import { useInRouterContext, useLocation, useNavigate } from "react-router-dom";
import { setCanvasRoutes } from "../src/shared/canvas-routes.js";
import { clearPublishedFileRoutes } from "../src/shared/file-routes.js";
import { setPublishedContent } from "../src/shared/published-content.js";
import { findTestRoute, setTestRoutes } from "./rspress-routes.js";

// A real origin so the no-router `usePathname` fallback has a pathname to
// read. Tests that need a specific route set it with `history.replaceState`
// before rendering.
GlobalRegistrator.register({ url: "http://localhost/" });

/**
 * Stub `@rspress/core/runtime` in the preload, for every test file.
 *
 * The real entry transitively imports Rspress's virtual modules
 * (`virtual-site-data`, `virtual-i18n-text`, `virtual-routes`), which resolve
 * only inside a real Rspress build, so any component reaching that entry cannot
 * be loaded by Bun without this.
 *
 * The router hooks are the genuine article, re-exported by that entry through
 * `export * from "react-router-dom"` — hand-written stand-ins for them would
 * pass tests against a router the host never runs. They are the same hooks
 * `src/shared/usePathname.ts` subscribes to, so a component rendered inside a
 * `MemoryRouter` behaves as it does on a real site.
 *
 * The route API serves the pages a test registers with `setTestRoutes`, for a
 * site whose base is `/`.
 */
mock.module("@rspress/core/runtime", () => ({
	useInRouterContext,
	useLocation,
	useNavigate,
	PageContext: createContext({ data: {} }),
	removeBase: (pathname: string) => pathname,
	pathnameToRouteService: (pathname: string) => {
		const route = findTestRoute(pathname);
		return (
			route && {
				path: route.path,
				filePath: `${route.path}.md`,
				lang: "",
				preload: async () => {
					if (route.chunkFails) throw new Error(`chunk for ${route.path} failed to load`);
					return { default: route.default };
				},
			}
		);
	},
	initPageData: async (routePath: string) => {
		const route = findTestRoute(routePath);
		return {
			routePath,
			title: route?.title ?? "",
			headingTitle: route?.headingTitle,
			frontmatter: {},
			toc: [],
		};
	},
}));

/**
 * The theme entry imports Rspress's virtual modules too; these are the parts
 * the plugin renders with. The headings carry `rp-toc-include`, as the theme's
 * own do.
 */
mock.module("@rspress/core/theme", () => ({
	getCustomMDXComponent: () =>
		Object.fromEntries(
			["h1", "h2", "h3", "h4", "h5", "h6"].map((tag) => [
				tag,
				(props: object) => createElement(tag, { ...props, className: "rp-toc-include" }),
			]),
		),
	Callout: ({ children }: { children?: ReactNode }) =>
		createElement("div", { className: "callout" }, children),
}));

// The plugins hand each other build state through module-level registries
// (what `markdown()` publishes, the boards `canvas()` routes). Every test file
// shares one process, so a test that runs a plugin's hooks would otherwise leak
// that state into whichever file Bun runs next.
beforeEach(() => {
	setPublishedContent(undefined);
	setCanvasRoutes([]);
	clearPublishedFileRoutes();
	setTestRoutes([]);
});
