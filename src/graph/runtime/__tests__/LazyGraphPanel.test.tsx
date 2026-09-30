// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

const { mock } = require("bun:test");

// `virtual-graph-data` only exists once a test provides it, and rspress's
// runtime package pulls its own virtual modules — mocking both is enough to
// resolve GraphPanel's import graph so the real module can be captured before
// the stub below replaces it. Test files that render either module re-mock
// them with their own fixtures anyway.
mock.module("virtual-graph-data", () => ({
	graphData: { nodes: [], links: [] },
	default: { nodes: [], links: [] },
}));
mock.module("@rspress/core/runtime", () => ({
	useLocation: () => ({ pathname: "/", search: "", hash: "", state: null, key: "" }),
	useNavigate: () => () => {},
}));
// Snapshot the exports: registering the stub below patches the live namespace
// in place, so the namespace object itself cannot serve as the restore value.
const realGraphPanel = { ...(await import("../GraphPanel")) };

// Stand-in for the heavy panel chunk: mounting it is what must not happen until
// the panel is actually wanted. Bun's mock registry keys modules by resolved
// path and keeps the entry for the rest of the process, so this stub has to be
// handed back the real exports in `afterAll` — otherwise every test file that
// loads after this one would see the stub instead of the real panel.
let mountCount = 0;
let lastDefaultOpen: boolean | undefined;

mock.module("../GraphPanel", () => ({
	default: (props: { defaultOpen?: boolean }) => {
		mountCount += 1;
		lastDefaultOpen = props.defaultOpen;
		return <div data-testid="graph-panel" />;
	},
}));

// Re-import the component under test AFTER mocks are registered.
const { default: LazyGraphPanel } = await import("../LazyGraphPanel");

/** Let the lazy import and React effects settle. */
async function settle(ms = 0): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);

	await act(async () => {
		await promise;
	});
}

function fab(container: HTMLElement): HTMLButtonElement {
	return container.querySelector("button[aria-label='Open graph view']") as HTMLButtonElement;
}

describe("LazyGraphPanel loading", () => {
	afterEach(() => {
		cleanup();
		mountCount = 0;
		lastDefaultOpen = undefined;
	});

	afterAll(() => {
		mock.module("../GraphPanel", () => realGraphPanel);
	});

	test("offers a FAB and loads nothing while the panel is closed", async () => {
		const { container } = render(<LazyGraphPanel />);

		expect(fab(container)).toBeTruthy();

		// The panel used to auto-load 100ms after mount, downloading the whole
		// graph on every page view.
		await settle(200);
		expect(mountCount).toBe(0);
	});

	test("loads the panel, open, when the FAB is clicked", async () => {
		const { container } = render(<LazyGraphPanel />);

		fireEvent.click(fab(container));
		await settle();

		expect(mountCount).toBe(1);
		expect(lastDefaultOpen).toBe(true);
	});

	test("loads the panel immediately when defaultOpen is set", async () => {
		render(<LazyGraphPanel defaultOpen />);

		await settle();

		expect(mountCount).toBe(1);
		expect(lastDefaultOpen).toBe(true);
	});

	test("loads the panel on the g shortcut", async () => {
		render(<LazyGraphPanel />);

		fireEvent.keyDown(window, { key: "g" });
		await settle();

		expect(mountCount).toBe(1);
		expect(lastDefaultOpen).toBe(true);
	});

	test("keeps the g shortcut out of text inputs", async () => {
		render(<LazyGraphPanel />);

		const input = document.createElement("input");
		document.body.appendChild(input);
		input.focus();

		fireEvent.keyDown(input, { key: "g" });
		await settle(200);

		expect(mountCount).toBe(0);
		input.remove();
	});
});
