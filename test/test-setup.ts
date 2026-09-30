import { mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// A real origin so `usePathname` has a pathname to read. Tests that need a
// specific route set it with `history.replaceState` before rendering.
GlobalRegistrator.register({ url: "http://localhost/" });

/**
 * Stub `@rspress/core/runtime` in the preload, for every test file.
 *
 * The real entry transitively imports Rspress's virtual modules
 * (`virtual-site-data`, `virtual-i18n-text`, `virtual-routes`), which resolve
 * only inside a real Rspress build, so any component reaching that entry cannot
 * be loaded by Bun without this.
 *
 * The stub is empty on purpose. It used to supply `useNavigate` and
 * `useLocation`, which the runtime does not export — that fiction is what let an
 * invalid import sit in four components unquestioned. Nothing imports from this
 * entry any more; `src/shared/usePathname.ts` replaced both hooks.
 */
mock.module("@rspress/core/runtime", () => ({}));
