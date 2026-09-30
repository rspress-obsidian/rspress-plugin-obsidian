// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { DARK_COLORS, LIGHT_COLORS } from "../palette/colors";

const { mock } = require("bun:test");

// `virtual-graph-data` is a build-time module; provide a stable fixture.
const mockGraphData = {
	nodes: [
		{ id: "/", label: "Home", routePath: "/" },
		{ id: "/guide", label: "Guide", routePath: "/guide" },
		{ id: "/api", label: "API", routePath: "/api" },
	],
	links: [
		{ source: "/", target: "/guide" },
		{ source: "/guide", target: "/api" },
	],
};

mock.module("virtual-graph-data", () => ({ graphData: mockGraphData, default: mockGraphData }));
mock.module("@rspress/core/runtime", () => ({
	useLocation: () => ({ pathname: "/guide", search: "", hash: "", state: null, key: "" }),
	useNavigate: () => () => {},
}));
// `react-force-graph-2d` renders to a canvas, so it has no DOM of its own and
// the palette it is handed would otherwise be invisible to a test. Echo it back
// as an attribute so the resolved theme can be read from the DOM.
mock.module("react-force-graph-2d", () => ({
	default: ({ nodeColor }: { nodeColor?: (node: { isCurrent?: boolean }) => string }) => (
		<div data-testid="force-graph" data-node-color={nodeColor?.({}) ?? ""} />
	),
}));

// Re-import the component under test AFTER mocks are registered.
const { default: GraphSidebar } = await import("../GraphSidebar");

describe("GraphSidebar theme", () => {
	afterEach(() => {
		cleanup();
		document.documentElement.classList.remove("dark");
	});

	test("paints the graph with the document theme and repaints when it changes", async () => {
		document.documentElement.classList.add("dark");
		const { findByTestId } = render(<GraphSidebar />);

		// The graph chunk is imported in an effect, so the graph only mounts after
		// mount-time theme resolution — this asserts that half of the contract,
		// which the first-paint test cannot see.
		const graph = await findByTestId("force-graph");
		expect(graph.getAttribute("data-node-color")).toBe(DARK_COLORS.node);

		// The MutationObserver has to repaint an already-mounted graph.
		await act(async () => {
			document.documentElement.classList.remove("dark");
		});
		expect(graph.getAttribute("data-node-color")).toBe(LIGHT_COLORS.node);
	});
});
