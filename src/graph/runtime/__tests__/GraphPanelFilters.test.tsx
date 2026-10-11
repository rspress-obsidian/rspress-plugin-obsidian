// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { graphDataModule, graphNode } from "./graph-fixture";

// The graph runtime reads the path from the document; this test renders a
// panel anchored on /guide.
history.replaceState({}, "", "/guide");

const { mock } = require("bun:test");

// /guide (the current route) reaches /leaf only at depth 2 via /api, and
// /leaf's only neighbor is /api — filtering /api away strands it, which is
// exactly what the orphan toggle decides about.
// /guide also links an image and a note that does not exist yet, which
// Obsidian's defaults (Attachments off, Existing files only on) hide.
mock.module("virtual-graph-data", () =>
	graphDataModule(
		[
			// Creation times drive the timelapse, which reveals notes oldest first.
			{ ...graphNode("/guide", "Guide"), ctime: 1000 },
			{ ...graphNode("/api", "API"), ctime: 2000 },
			{ ...graphNode("/leaf", "Leaf"), ctime: 3000 },
			graphNode("/tags/project", "#project", "tag"),
			graphNode("/media/pic.png", "pic.png", "attachment"),
			graphNode("?draft", "Draft", "unresolved"),
		],
		[
			{ source: "/guide", target: "/api" },
			{ source: "/guide", target: "/tags/project" },
			{ source: "/api", target: "/leaf" },
			// Two neighbors of /guide linking each other: a "neighbor link".
			{ source: "/api", target: "/tags/project" },
			{ source: "/guide", target: "/media/pic.png" },
			{ source: "/guide", target: "?draft" },
		],
	),
);

// Note text for `content:` searches, loaded only once a query needs it.
mock.module("virtual-graph-search-data", () => {
	const searchEntries = [{ id: "/api", text: "Endpoints and rate limits" }];
	return { searchEntries, default: searchEntries };
});

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
const { LOCAL_STORAGE_KEY_DISPLAY, LOCAL_STORAGE_KEY_FILTERS, LOCAL_STORAGE_KEY_FORCES } =
	await import("../graph-panel-storage");

/** The settings checkbox labelled `label`. */
function toggle(root: ParentNode, label: string): HTMLInputElement {
	const owner = [...root.querySelectorAll("label")].find(
		(element) => element.textContent === label,
	);
	const input = owner?.querySelector("input");
	if (!input) throw new Error(`no "${label}" toggle`);
	return input;
}

/** The settings slider labelled `label`. */
function slider(root: ParentNode, label: string): HTMLInputElement {
	const owner = [...root.querySelectorAll("label")].find(
		(element) => element.querySelector("span")?.textContent === label,
	);
	const input = owner?.querySelector("input[type='range']");
	if (!input) throw new Error(`no "${label}" slider`);
	return input as HTMLInputElement;
}

function visibleNodeIds(): string[] {
	const data = capturedGraphProps?.graphData as { nodes: Array<{ id: string }> } | undefined;
	if (!data) throw new Error("GraphView never handed props to the force graph");
	return data.nodes.map((node) => node.id).sort();
}

/** The graph region's accessible summary, which reports the derived counts. */
function statsLabel(container: HTMLElement): string {
	return container.querySelector("#rspress-graph-view-region")?.getAttribute("aria-label") ?? "";
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
		fireEvent.click(toggle(container, "Tags"));
		expect(visibleNodeIds()).toEqual(["/api", "/guide"]);
	});

	test("Attachments and Existing files only reveal attachment and unresolved nodes", async () => {
		const { container } = await openPanelWithFilters();
		fireEvent.click(toggle(container, "Attachments"));
		expect(visibleNodeIds()).toEqual(["/api", "/guide", "/media/pic.png", "/tags/project"]);
		fireEvent.click(toggle(container, "Existing files only"));
		expect(visibleNodeIds()).toEqual([
			"/api",
			"/guide",
			"/media/pic.png",
			"/tags/project",
			"?draft",
		]);
	});

	test("Outgoing links off leaves nothing linked from the current page", async () => {
		const { container } = await openPanelWithFilters();
		fireEvent.click(toggle(container, "Outgoing links"));
		expect(statsLabel(container)).toContain("Graph view showing 1 node and 0 links");
	});

	test("content: searches note text, loaded on demand", async () => {
		const { input } = await openPanelWithFilters();
		fireEvent.change(input, { target: { value: "content:rate" } });
		await act(async () => {
			await import("virtual-graph-search-data");
			await Promise.resolve();
		});
		expect(visibleNodeIds()).toEqual(["/api", "/guide"]);
	});

	test("display and force settings reach the renderer and persist", async () => {
		const { container } = await openPanelWithFilters();
		fireEvent.click(toggle(container, "Arrows"));
		fireEvent.change(slider(container, "Link distance"), { target: { value: "120" } });
		expect(capturedGraphProps?.linkDirectionalArrowLength).toBeGreaterThan(0);
		expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY_DISPLAY) ?? "{}").arrows).toBe(true);
		expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY_FORCES) ?? "{}").linkDistance).toBe(
			120,
		);

		fireEvent.click(
			[...container.querySelectorAll("button")].find(
				(b) => b.textContent === "Restore defaults",
			) as HTMLElement,
		);
		expect(capturedGraphProps?.linkDirectionalArrowLength).toBe(0);
	});

	test("hiding orphans drops nodes the search stranded", async () => {
		const { container, input } = await openPanelWithFilters();
		fireEvent.click(container.querySelector("button[aria-label='Increase depth']") as HTMLElement);
		fireEvent.change(input, { target: { value: "leaf" } });

		// /leaf matches but its only link went with the filtered-out /api, so
		// the stranded node shows by default and disappears when orphans hide.
		expect(statsLabel(container)).toContain("Graph view showing 2 nodes and 0 links");

		fireEvent.click(toggle(container, "Orphans"));
		expect(statsLabel(container)).toContain("Graph view showing 1 node and 0 links");
	});

	test("Escape clears a non-empty search before closing the panel", async () => {
		const { container, input } = await openPanelWithFilters();
		fireEvent.change(input, { target: { value: "api" } });
		input.focus();

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
		fireEvent.click(toggle(container, "Tags"));
		expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY_FILTERS) ?? "{}")).toEqual({
			scope: "local",
			depth: 2,
			incoming: true,
			outgoing: true,
			neighborLinks: true,
			showTags: false,
			showAttachments: false,
			existingOnly: true,
			showOrphans: true,
		});

		cleanup();
		render(<GraphPanel defaultOpen />);
		fireEvent.click(
			document.querySelector("button[aria-label='Show graph filters']") as HTMLElement,
		);
		await act(async () => {
			await Promise.resolve();
		});
		const depthLabel = document.querySelector("[aria-label='Neighborhood depth'] [aria-live]");
		expect(depthLabel?.textContent).toBe("2");
		expect(toggle(document, "Tags").checked).toBe(false);
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

	test("Decrease depth steps back to the direct neighborhood and stops at one", async () => {
		const { container } = await openPanelWithFilters();
		const decrease = container.querySelector(
			"button[aria-label='Decrease depth']",
		) as HTMLButtonElement;
		expect(decrease.disabled).toBe(true);
		fireEvent.click(container.querySelector("button[aria-label='Increase depth']") as HTMLElement);
		expect(visibleNodeIds()).toContain("/leaf");
		fireEvent.click(decrease);
		expect(visibleNodeIds()).toEqual(["/api", "/guide", "/tags/project"]);
		expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY_FILTERS) ?? "{}").depth).toBe(1);
	});

	test("Neighbor links off drops links between the current page's neighbors", async () => {
		const { container } = await openPanelWithFilters();
		const linkCount = () =>
			(capturedGraphProps?.graphData as { links: unknown[] } | undefined)?.links.length;
		expect(linkCount()).toBe(3);
		fireEvent.click(toggle(container, "Neighbor links"));
		// /api -> /tags/project joins two neighbors of /guide, not a hop of the walk.
		expect(linkCount()).toBe(2);
		expect(visibleNodeIds()).toEqual(["/api", "/guide", "/tags/project"]);
		expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY_FILTERS) ?? "{}").neighborLinks).toBe(
			false,
		);
	});

	test("Incoming links off keeps a page that only links out, and persists", async () => {
		const { container } = await openPanelWithFilters();
		fireEvent.click(toggle(container, "Incoming links"));
		// /guide has no backlinks, so its outgoing neighborhood is untouched.
		expect(visibleNodeIds()).toEqual(["/api", "/guide", "/tags/project"]);
		expect(toggle(container, "Incoming links").checked).toBe(false);
		expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY_FILTERS) ?? "{}").incoming).toBe(
			false,
		);
	});

	test("display sliders reach the painters and persist", async () => {
		const { container } = await openPanelWithFilters();
		const node = { degree: 0 };
		const nodeValue = (): number => {
			const nodeVal = capturedGraphProps?.nodeVal;
			if (typeof nodeVal !== "function") throw new Error("force graph got no nodeVal");
			return nodeVal(node);
		};
		const before = nodeValue();
		fireEvent.change(slider(container, "Node size"), { target: { value: "2" } });
		expect(nodeValue()).toBeGreaterThan(before);

		fireEvent.click(toggle(container, "Arrows"));
		const arrowAt1 = capturedGraphProps?.linkDirectionalArrowLength as number;
		fireEvent.change(slider(container, "Link thickness"), { target: { value: "3" } });
		// Arrow heads scale with the link width.
		expect(capturedGraphProps?.linkDirectionalArrowLength).toBeGreaterThan(arrowAt1);

		fireEvent.change(slider(container, "Text fade threshold"), { target: { value: "2" } });
		expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY_DISPLAY) ?? "{}")).toMatchObject({
			nodeSize: 2,
			linkThickness: 3,
			textFadeThreshold: 2,
		});
		expect(
			slider(container, "Node size").closest("label")?.querySelector("output")?.textContent,
		).toBe("2");
	});

	test("force sliders persist each force", async () => {
		const { container } = await openPanelWithFilters();
		fireEvent.change(slider(container, "Center force"), { target: { value: "0.8" } });
		fireEvent.change(slider(container, "Repel force"), { target: { value: "15" } });
		fireEvent.change(slider(container, "Link force"), { target: { value: "0.5" } });
		expect(JSON.parse(localStorage.getItem(LOCAL_STORAGE_KEY_FORCES) ?? "{}")).toMatchObject({
			centerStrength: 0.8,
			repelStrength: 15,
			linkStrength: 0.5,
		});
	});

	test("Animate reveals notes in creation order, then restores the full graph", async () => {
		vi.useFakeTimers();
		try {
			const { container } = await openPanelWithFilters();
			const animate = () =>
				[...container.querySelectorAll("button")].find((b) =>
					b.textContent?.startsWith("Anim"),
				) as HTMLButtonElement;
			fireEvent.click(animate());
			expect(animate().textContent).toBe("Animating…");
			expect(animate().disabled).toBe(true);
			// Only notes with no recorded creation time exist at the start.
			expect(visibleNodeIds()).toEqual(["/tags/project"]);

			act(() => {
				vi.advanceTimersByTime(80);
			});
			expect(visibleNodeIds()).toEqual(["/guide", "/tags/project"]);
			act(() => {
				vi.advanceTimersByTime(80);
			});
			expect(visibleNodeIds()).toEqual(["/api", "/guide", "/tags/project"]);
			act(() => {
				vi.advanceTimersByTime(160);
			});
			expect(visibleNodeIds()).toEqual(["/api", "/guide", "/tags/project"]);
			expect(animate().textContent).toBe("Animate");
		} finally {
			vi.useRealTimers();
		}
	});
});
