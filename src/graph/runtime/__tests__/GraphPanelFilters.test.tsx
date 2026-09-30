// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";

// The graph runtime reads the path from the document; this test renders a
// panel anchored on /guide.
history.replaceState({}, "", "/guide");

const { mock } = require("bun:test");

// /guide (the current route) reaches /leaf only at depth 2 via /api, and
// /leaf's only neighbor is /api — filtering /api away strands it, which is
// exactly what the orphan toggle decides about.
const mockGraphData = {
	nodes: [
		{ id: "/guide", label: "Guide", routePath: "/guide" },
		{ id: "/api", label: "API", routePath: "/api" },
		{ id: "/leaf", label: "Leaf", routePath: "/leaf" },
		{ id: "/tags/project", label: "project", routePath: "/tags/project" },
	],
	links: [
		{ source: "/guide", target: "/api" },
		{ source: "/guide", target: "/tags/project" },
		{ source: "/api", target: "/leaf" },
	],
};

mock.module("virtual-graph-data", () => ({ graphData: mockGraphData, default: mockGraphData }));

// Capture the props GraphView hands the force graph so the visible node set
// can be asserted per filter change.
let capturedGraphProps: Record<string, unknown> | null = null;

mock.module("react-force-graph-2d", () => ({
	default: (props: Record<string, unknown>) => {
		capturedGraphProps = props;
		return null;
	},
}));

const { default: GraphPanel } = await import("../GraphPanel");
const { LOCAL_STORAGE_KEY_FILTERS } = await import("../graph-panel-storage");

function visibleNodeIds(): string[] {
	const data = capturedGraphProps?.graphData as { nodes: Array<{ id: string }> } | undefined;
	if (!data) throw new Error("GraphView never handed props to the force graph");
	return data.nodes.map((node) => node.id).sort();
}

/**
 * A filter set with no visible links swaps GraphView to its "No pages to
 * show" state, where the force graph (and its captured props) never mounts —
 * the panel's live stats region still reports the derived counts, so that is
 * the observable for search-and-orphan combinations.
 */
function statsLabel(container: HTMLElement): string {
	return container.querySelector("[role='img']")?.getAttribute("aria-label") ?? "";
}

async function openPanelWithFilters() {
	const { container } = render(<GraphPanel />);
	fireEvent.keyDown(window, { key: "g" });
	fireEvent.click(
		container.querySelector("button[aria-label='Show graph filters']") as HTMLElement,
	);
	const input = container.querySelector(
		"input[aria-label='Filter graph nodes']",
	) as HTMLInputElement;
	if (!input) throw new Error("filter bar did not open");
	// GraphView imports react-force-graph-2d lazily; let that settle so the
	// mocked renderer has received its props.
	await act(async () => {
		await Promise.resolve();
	});
	return { container, input };
}

describe("GraphPanel filters", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	afterEach(() => {
		cleanup();
		capturedGraphProps = null;
	});

	test("the funnel button discloses the filter bar", () => {
		const { container } = render(<GraphPanel />);
		fireEvent.keyDown(window, { key: "g" });

		const toggle = container.querySelector("button[aria-label='Show graph filters']");
		expect(toggle).not.toBeNull();
		expect(toggle?.getAttribute("aria-expanded")).toBe("false");
		expect(container.querySelector("input[aria-label='Filter graph nodes']")).toBeNull();

		fireEvent.click(toggle as HTMLElement);
		expect(
			container
				.querySelector("button[aria-label='Hide graph filters']")
				?.getAttribute("aria-expanded"),
		).toBe("true");
		expect(container.querySelector("input[aria-label='Filter graph nodes']")).not.toBeNull();
	});

	test("search narrows the visible nodes to matches plus the current page", async () => {
		const { input } = await openPanelWithFilters();
		expect(visibleNodeIds()).toEqual(["/api", "/guide", "/tags/project"]);

		fireEvent.change(input, { target: { value: "API" } });
		expect(visibleNodeIds()).toEqual(["/api", "/guide"]);
	});

	test("the global scope shows the whole vault, the local scope its neighborhood", async () => {
		const { container } = await openPanelWithFilters();
		// Local, depth 1: only /guide's own neighbors.
		expect(visibleNodeIds()).toEqual(["/api", "/guide", "/tags/project"]);

		fireEvent.click(container.querySelector("button[aria-label='Global graph']") as HTMLElement);
		// /leaf is two hops away and unreachable at depth 1, so seeing it proves
		// the scope switch reached the derivation, not just the button state.
		expect(visibleNodeIds()).toEqual(["/api", "/guide", "/leaf", "/tags/project"]);

		fireEvent.click(container.querySelector("button[aria-label='Local graph']") as HTMLElement);
		expect(visibleNodeIds()).toEqual(["/api", "/guide", "/tags/project"]);
	});

	test("the scope control persists and the depth stepper hides in the global scope", async () => {
		const { container } = await openPanelWithFilters();
		const depthGroup = container.querySelector("[aria-label='Neighborhood depth']");
		expect(depthGroup?.hasAttribute("hidden")).toBe(false);

		fireEvent.click(container.querySelector("button[aria-label='Global graph']") as HTMLElement);
		expect(
			container.querySelector("[aria-label='Neighborhood depth']")?.hasAttribute("hidden"),
		).toBe(true);
		expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY_FILTERS) ?? "{}").scope).toBe(
			"global",
		);

		cleanup();
		render(<GraphPanel defaultOpen />);
		fireEvent.click(
			document.querySelector("button[aria-label='Show graph filters']") as HTMLElement,
		);
		await act(async () => {
			await Promise.resolve();
		});
		expect(
			document.querySelector("button[aria-label='Global graph']")?.getAttribute("aria-pressed"),
		).toBe("true");
	});

	test("depth 2 reaches the second hop while the default stays at one", async () => {
		const { container } = await openPanelWithFilters();
		expect(visibleNodeIds()).toEqual(["/api", "/guide", "/tags/project"]);

		fireEvent.click(container.querySelector("button[aria-label='Increase depth']") as HTMLElement);
		expect(visibleNodeIds()).toEqual(["/api", "/guide", "/leaf", "/tags/project"]);
	});

	test("hiding tags drops tag pages from the view", async () => {
		const { container } = await openPanelWithFilters();
		const tagsToggle = Array.from(container.querySelectorAll("input[type='checkbox']"))[0];
		fireEvent.click(tagsToggle as HTMLElement);
		expect(visibleNodeIds()).toEqual(["/api", "/guide"]);
	});

	test("hiding orphans drops nodes the search stranded", async () => {
		const { container, input } = await openPanelWithFilters();
		fireEvent.click(container.querySelector("button[aria-label='Increase depth']") as HTMLElement);
		fireEvent.change(input, { target: { value: "leaf" } });

		// /leaf matches but its only link went with the filtered-out /api, so
		// the stranded node shows by default and disappears when orphans hide.
		expect(statsLabel(container)).toContain("Graph view showing 2 nodes and 0 links");
		expect(container.textContent).toContain("No pages to show");

		const orphansToggle = Array.from(container.querySelectorAll("input[type='checkbox']"))[1];
		fireEvent.click(orphansToggle as HTMLElement);
		expect(statsLabel(container)).toContain("Graph view showing 1 node and 0 links");
	});

	test("Escape clears a non-empty search before closing the panel", async () => {
		const { container, input } = await openPanelWithFilters();
		fireEvent.change(input, { target: { value: "api" } });

		fireEvent.keyDown(window, { key: "Escape" });
		expect(container.querySelector("#rspress-graph-view-panel")).not.toBeNull();
		expect(
			(container.querySelector("input[aria-label='Filter graph nodes']") as HTMLInputElement).value,
		).toBe("");

		fireEvent.keyDown(window, { key: "Escape" });
		expect(container.querySelector("#rspress-graph-view-panel")).toBeNull();
	});

	test("depth and toggles persist across remounts; the query does not", async () => {
		const { container } = await openPanelWithFilters();
		fireEvent.click(container.querySelector("button[aria-label='Increase depth']") as HTMLElement);
		const tagsToggle = Array.from(container.querySelectorAll("input[type='checkbox']"))[0];
		fireEvent.click(tagsToggle as HTMLElement);
		expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY_FILTERS) ?? "{}")).toEqual({
			depth: 2,
			showTags: false,
			showOrphans: true,
			scope: "local",
		});

		cleanup();
		render(<GraphPanel defaultOpen />);
		fireEvent.click(
			document.querySelector("button[aria-label='Show graph filters']") as HTMLElement,
		);
		await act(async () => {
			await Promise.resolve();
		});
		const depthLabel = document.querySelector("[aria-label='Neighborhood depth'] span");
		expect(depthLabel?.textContent).toBe("2");
		const checkboxes = document.querySelectorAll("input[type='checkbox']");
		expect((checkboxes[0] as HTMLInputElement).checked).toBe(false);
		expect(
			(document.querySelector("input[aria-label='Filter graph nodes']") as HTMLInputElement).value,
		).toBe("");
	});

	test("colour groups from plugin options reach the force graph", async () => {
		const groups = [{ query: "path:api", color: "#ff0000" }];
		render(<GraphPanel defaultOpen groups={groups} />);
		await act(async () => {
			await Promise.resolve();
		});
		const nodeColor = capturedGraphProps?.nodeColor as (node: { id: string }) => string;
		expect(typeof nodeColor).toBe("function");
		expect(nodeColor({ id: "/api" })).toBe("#ff0000");
		expect(nodeColor({ id: "/tags/project" })).not.toBe("#ff0000");
	});
});
