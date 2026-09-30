// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";

const { mock } = require("bun:test");

// `virtual-graph-data` is a build-time module; provide a stable fixture.
const mockGraphData = {
	nodes: [
		{ id: "/", label: "Home", routePath: "/" },
		{ id: "/guide", label: "Guide", routePath: "/guide" },
	],
	links: [{ source: "/", target: "/guide" }],
};

mock.module("virtual-graph-data", () => ({ graphData: mockGraphData, default: mockGraphData }));

const navigateSpy = mock((_routePath: string) => {});
mock.module("@rspress/core/runtime", () => ({
	useLocation: () => ({ pathname: "/guide", search: "", hash: "", state: null, key: "" }),
	useNavigate: () => navigateSpy,
}));

// Capture the props GraphView hands the force graph so a node click and a node
// hover can be driven the way the real canvas would.
let capturedGraphProps: Record<string, unknown> | null = null;
mock.module("react-force-graph-2d", () => ({
	default: (props: Record<string, unknown>) => {
		capturedGraphProps = props;
		return null;
	},
}));

// Re-import the component under test AFTER mocks are registered.
const { default: GraphSidebar } = await import("./GraphSidebar");

async function settle(): Promise<void> {
	// GraphView loads the force graph through a dynamic import, so its state
	// update lands a turn after mount; two rounds keep it inside `act`.
	for (let round = 0; round < 2; round += 1) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await act(async () => {
			await promise;
		});
	}
}

/** The header control; its `aria-expanded` is the sidebar's open state. */
function toggle(container: HTMLElement): HTMLButtonElement {
	const button = container.querySelector("button[aria-expanded]");
	if (!button) throw new Error("sidebar toggle missing");
	return button as HTMLButtonElement;
}

/** The handler GraphView wired to the force graph, or a loud failure. */
function graphHandler(name: string): (node: unknown) => void {
	const handler = capturedGraphProps?.[name];
	if (typeof handler !== "function") throw new Error(`GraphView never wired ${name}`);
	return handler as (node: unknown) => void;
}

afterEach(() => {
	cleanup();
	navigateSpy.mockClear();
	capturedGraphProps = null;
});

describe("GraphSidebar", () => {
	test("server-renders the graph region without touching the browser", () => {
		// Rspress renders the theme slot on the server, so nothing may read
		// `window` during render — the measurement runs in an effect.
		const html = renderToString(<GraphSidebar />);

		expect(html).toContain("Graph View");
		expect(html).toContain("Zoom in");
	});

	test("toggles the graph region from the header control", async () => {
		const { container } = render(<GraphSidebar />);
		await settle();
		const control = toggle(container);

		expect(control.textContent).toContain("Graph View");
		expect(control.getAttribute("aria-expanded")).toBe("true");

		fireEvent.click(control);
		expect(control.getAttribute("aria-expanded")).toBe("false");

		fireEvent.click(control);
		expect(control.getAttribute("aria-expanded")).toBe("true");

		// The resize listener re-measures; it must not throw when detached.
		fireEvent(window, new Event("resize"));
		expect(control.getAttribute("aria-expanded")).toBe("true");
	});

	test("navigates to the route of a clicked node", async () => {
		render(<GraphSidebar />);
		await settle();

		act(() => graphHandler("onNodeClick")({ routePath: "/guide" }));

		expect(navigateSpy).toHaveBeenCalledWith("/guide");
	});

	test("shows the hovered node's label in the sidebar tooltip", async () => {
		const { container } = render(<GraphSidebar />);
		await settle();

		act(() => graphHandler("onNodeHover")({ id: "/guide", label: "Guide", x: 1, y: 2 }));

		expect(container.textContent).toContain("Guide");
	});

	test("exposes the zoom controls and drives the graph view through them", async () => {
		const { container } = render(<GraphSidebar />);
		await settle();

		for (const label of ["Zoom in", "Zoom out", "Fit to view", "Reset zoom"]) {
			const button = container.querySelector(`button[aria-label='${label}']`);
			expect(button).not.toBeNull();
			fireEvent.click(button as HTMLButtonElement);
		}

		// The controls act on the graph, never on the router.
		expect(navigateSpy).not.toHaveBeenCalled();
	});
});
