import { mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { useInRouterContext, useLocation, useNavigate } from "react-router-dom";

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
 */
mock.module("@rspress/core/runtime", () => ({
	useInRouterContext,
	useLocation,
	useNavigate,
}));
