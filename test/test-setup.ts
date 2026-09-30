import { mock } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();

/**
 * Stub `@rspress/core/runtime` here, in the preload, rather than in each test.
 *
 * The graph runtime imports `useLocation` and `useNavigate` from it, and Bun
 * validates a static named import against the real module the first time the
 * importing file is linked. When a test file registered the stub itself, that
 * registration raced the import — fine on Linux, and `SyntaxError: Export named
 * 'useNavigate' not found` on a macOS runner whose file order differed.
 *
 * The preload runs before every test file is linked, so the stub is always in
 * place first. Tests that need to observe navigation call `mock.module`
 * themselves afterwards to swap in their own spy, which still wins.
 */
let navigateSpy = mock(() => {});

mock.module("@rspress/core/runtime", () => ({
	useLocation: () => ({ pathname: "/", search: "", hash: "", state: null, key: "" }),
	useNavigate: () => navigateSpy,
}));

/** Replace the shared `useNavigate` implementation, e.g. with a spy. */
export function setNavigate(fn: () => void): void {
	navigateSpy = mock(fn);
}
