// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { navigation } from "../../../shared/usePathname.js";

if (!globalThis.document) GlobalRegistrator.register();

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { MAX_NEIGHBORS } from "../deriveGraphViewData";
import { graphDataModule, graphNode } from "./graph-fixture";

// The graph runtime reads the path from the document; this test renders a
// panel anchored on /guide.
history.replaceState({}, "", "/guide");

const { mock } = require("bun:test");

// "/guide" is a hub: more neighbors than the render cap, so the view truncates.
const hubNeighbors = Array.from({ length: MAX_NEIGHBORS + 2 }, (_, index) =>
	graphNode(`/note-${index}`, `Note ${index}`),
);

mock.module("virtual-graph-data", () =>
	graphDataModule(
		[graphNode("/guide", "Guide"), ...hubNeighbors],
		hubNeighbors.map((node) => ({ source: "/guide", target: node.id })),
	),
);

// The panel navigates through the shared seam rather than `window.location`
// directly, which is what makes it observable here.
const navigateSpy = mock(() => {});
navigation.assign = navigateSpy;

// Capture the props GraphView hands the force graph so node clicks can be driven.
let capturedGraphProps: Record<string, unknown> | null = null;

mock.module("react-force-graph-2d", () => ({
	default: (props: Record<string, unknown>) => {
		capturedGraphProps = props;
		return null;
	},
}));

const { default: GraphPanel } = await import("../GraphPanel");

function openPanel() {
	const { container } = render(<GraphPanel />);
	return container;
}

describe("GraphPanel accessibility", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	afterEach(() => {
		cleanup();
		navigateSpy.mockClear();
		capturedGraphProps = null;
	});

	test("opens on G key and closes on Escape with focus returning to the FAB", () => {
		const container = openPanel();
		const fab = container.querySelector(
			"button[aria-label='Open graph view']",
		) as HTMLButtonElement;

		// Initially closed: FAB present, no panel
		expect(container.querySelector("#rspress-graph-view-panel")).toBeNull();

		// Press G → opens
		fireEvent.keyDown(window, { key: "g" });
		expect(container.querySelector("#rspress-graph-view-panel")).toBeTruthy();

		// Escape inside the panel → closes, focus returns to FAB
		(
			container.querySelector(
				"#rspress-graph-view-panel button[aria-label='Close graph view']",
			) as HTMLButtonElement
		).focus();
		fireEvent.keyDown(window, { key: "Escape" });
		expect(container.querySelector("#rspress-graph-view-panel")).toBeFalsy();
		expect(document.activeElement).toBe(fab);
	});

	test("toggles open/closed via the FAB button", () => {
		const container = openPanel();
		const fab = container.querySelector(
			"button[aria-label='Open graph view']",
		) as HTMLButtonElement;

		fireEvent.click(fab);
		expect(container.querySelector("#rspress-graph-view-panel")).toBeTruthy();
		expect(fab.getAttribute("aria-expanded")).toBe("true");

		fireEvent.click(fab);
		expect(container.querySelector("#rspress-graph-view-panel")).toBeFalsy();
		expect(fab.getAttribute("aria-expanded")).toBe("false");
	});

	test("ignores G key when typing in an input", () => {
		const container = openPanel();
		const input = document.createElement("input");
		document.body.appendChild(input);
		input.focus();

		fireEvent.keyDown(input, { key: "g" });
		expect(container.querySelector("#rspress-graph-view-panel")).toBeNull();

		input.remove();
	});

	test("reports the truncated neighborhood in the stats line", async () => {
		const container = openPanel();
		fireEvent.click(
			container.querySelector("button[aria-label='Open graph view']") as HTMLButtonElement,
		);

		// Stats land on a 150ms timer after the panel opens.
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 200);
		await act(async () => {
			await promise;
		});

		const statsLine = container.querySelector("[aria-live='polite']");
		expect(statsLine?.textContent).toBe(
			`${MAX_NEIGHBORS + 1} nodes · ${MAX_NEIGHBORS} links · ${MAX_NEIGHBORS} of ${MAX_NEIGHBORS + 2} neighbors · 2 more not drawn`,
		);
	});
	test("leaves Escape alone when focus is outside the panel", () => {
		// Escape meant for another widget (the search modal, say) must not close
		// the graph or be swallowed by it.
		const container = openPanel();
		fireEvent.keyDown(window, { key: "g" });
		const elsewhere = document.createElement("input");
		document.body.appendChild(elsewhere);
		elsewhere.focus();
		try {
			const event = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
			window.dispatchEvent(event);
			expect(event.defaultPrevented).toBe(false);
			expect(container.querySelector("#rspress-graph-view-panel")).toBeTruthy();
		} finally {
			elsewhere.remove();
		}
	});

	test("the floating panel is non-modal: Tab moves on past its last control", () => {
		const container = openPanel();
		fireEvent.keyDown(window, { key: "g" });

		const panel = container.querySelector("#rspress-graph-view-panel") as HTMLElement;
		expect(panel.getAttribute("aria-modal")).toBe("false");
		const focusable = panel.querySelectorAll<HTMLElement>("button:not([disabled])");
		const last = focusable[focusable.length - 1];
		last?.focus();
		const event = new KeyboardEvent("keydown", { key: "Tab", cancelable: true });
		window.dispatchEvent(event);
		expect(event.defaultPrevented).toBe(false);
	});

	test("fullscreen is modal and keeps Tab inside", () => {
		const container = openPanel();
		fireEvent.keyDown(window, { key: "g" });
		fireEvent.click(container.querySelector("button[aria-label='Maximize']") as HTMLButtonElement);

		const panel = container.querySelector("#rspress-graph-view-panel") as HTMLElement;
		expect(panel.getAttribute("aria-modal")).toBe("true");
		const focusable = panel.querySelectorAll<HTMLElement>(
			"button:not([disabled]), [href], input:not([disabled])",
		);
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (!first || !last) throw new Error("panel has no focusable controls");

		first.focus();
		fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
		expect(document.activeElement).toBe(last);

		last.focus();
		fireEvent.keyDown(window, { key: "Tab" });
		expect(document.activeElement).toBe(first);
	});

	test("maximizes and restores the panel", () => {
		const container = openPanel();
		fireEvent.keyDown(window, { key: "g" });

		const maximize = container.querySelector("button[aria-label='Maximize']") as HTMLButtonElement;
		expect(maximize).toBeTruthy();

		fireEvent.click(maximize);

		// The control flips to "Restore" once the panel is fullscreen.
		const restore = container.querySelector("button[aria-label='Restore']");
		expect(restore).toBeTruthy();
		expect(container.querySelector("button[aria-label='Maximize']")).toBeNull();
	});

	test("takes the faded-out FAB out of the tab order in fullscreen", async () => {
		const container = openPanel();
		// Settle the lazy force-graph import inside act so it does not update later.
		await act(async () => {
			await Promise.resolve();
		});
		fireEvent.keyDown(window, { key: "g" });

		const fab = container.querySelector(
			"button[aria-label='Close graph view']",
		) as HTMLButtonElement;
		expect(fab.getAttribute("aria-hidden")).toBe("false");
		expect(fab.getAttribute("tabindex")).toBe("0");

		fireEvent.click(container.querySelector("button[aria-label='Maximize']") as HTMLButtonElement);

		// Fullscreen only fades the FAB out; it must also leave the tab order and
		// the accessibility tree, otherwise it stays focusable and announced.
		const hiddenFab = container.querySelector(
			"button[aria-label='Close graph view']",
		) as HTMLButtonElement;
		expect(hiddenFab.getAttribute("aria-hidden")).toBe("true");
		expect(hiddenFab.getAttribute("tabindex")).toBe("-1");

		// Close so the 150ms stats timer does not fire after the test.
		fireEvent.keyDown(window, { key: "g" });
	});

	test("reopening with the keyboard after fullscreen opens a windowed panel", async () => {
		const container = openPanel();
		await act(async () => {
			await Promise.resolve();
		});
		fireEvent.keyDown(window, { key: "g" });
		fireEvent.click(container.querySelector("button[aria-label='Maximize']") as HTMLButtonElement);
		expect(container.querySelector("button[aria-label='Restore']")).toBeTruthy();

		// 'g' closes the panel and must also drop fullscreen, so the next open is
		// windowed rather than instantly re-maximized.
		fireEvent.keyDown(window, { key: "g" });
		expect(container.querySelector("#rspress-graph-view-panel")).toBeNull();

		fireEvent.keyDown(window, { key: "g" });
		expect(container.querySelector("#rspress-graph-view-panel")).toBeTruthy();
		expect(container.querySelector("button[aria-label='Restore']")).toBeNull();
		expect(container.querySelector("button[aria-label='Maximize']")).toBeTruthy();

		// Close so the 150ms stats timer does not fire after the test.
		fireEvent.keyDown(window, { key: "g" });
	});

	test("drags the panel by its header and remembers the position", () => {
		const container = openPanel();
		fireEvent.keyDown(window, { key: "g" });

		// The drag handle is the header row, not the panel root.
		const header = container.querySelector("#rspress-graph-view-title")?.parentElement;
		if (!header) throw new Error("panel header not found");
		const handle = header as HTMLElement & {
			setPointerCapture: () => void;
			releasePointerCapture: () => void;
		};
		// happy-dom has no pointer capture; the handler only needs it to exist.
		handle.setPointerCapture = () => {};
		handle.releasePointerCapture = () => {};

		fireEvent.pointerDown(handle, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
		fireEvent.pointerMove(handle, { clientX: 160, clientY: 130, pointerId: 1 });
		fireEvent.pointerUp(handle, { clientX: 160, clientY: 130, pointerId: 1 });

		// The drag offset is persisted, which is the observable effect of a drag.
		expect(JSON.parse(localStorage.getItem("rspress-graph-view-pos") ?? "null")).toEqual({
			x: 60,
			y: 30,
		});
	});

	test("does not start a drag from a control in the header", () => {
		const container = openPanel();
		fireEvent.keyDown(window, { key: "g" });

		const close = container.querySelector(
			"button[aria-label='Close graph view']",
		) as HTMLButtonElement;
		const header = container.querySelector("#rspress-graph-view-title")?.parentElement;
		if (!header) throw new Error("panel header not found");
		const handle = header as HTMLElement & { setPointerCapture: () => void };
		handle.setPointerCapture = () => {
			throw new Error("a drag must not start on a control");
		};

		fireEvent.pointerDown(close, { button: 0, clientX: 10, clientY: 10, pointerId: 2 });
		fireEvent.pointerMove(handle, { clientX: 90, clientY: 90, pointerId: 2 });
		fireEvent.pointerUp(handle, { clientX: 90, clientY: 90, pointerId: 2 });

		// The panel keeps its position: the control click was not a drag.
		expect(JSON.parse(localStorage.getItem("rspress-graph-view-pos") ?? "null")).toEqual({
			x: 0,
			y: 0,
		});
	});
	test("does not toggle on a modifier combination", () => {
		const container = openPanel();

		for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
			fireEvent.keyDown(window, { key: "g", ...modifier });
			expect(container.querySelector("#rspress-graph-view-panel")).toBeNull();
		}
	});

	test("highlights the close control on hover", () => {
		const container = openPanel();
		fireEvent.keyDown(window, { key: "g" });

		// Two controls carry this label (the FAB and the panel's own close button);
		// the hover styling belongs to the one inside the panel.
		const close = container.querySelector(
			"#rspress-graph-view-panel button[aria-label='Close graph view']",
		) as HTMLButtonElement;
		const restingColor = close.style.color;

		fireEvent.mouseEnter(close);

		// The control turns a danger red dark enough for 4.5:1 on a light panel.
		expect(close.style.color).not.toBe(restingColor);
		expect(close.style.color.toLowerCase()).toMatch(/b91c1c|185,\s*28,\s*28/);
	});

	test("closes from the panel's own close button and returns focus to the FAB", async () => {
		const container = openPanel();
		await act(async () => {
			await Promise.resolve();
		});
		fireEvent.keyDown(window, { key: "g" });

		const close = container.querySelector(
			"#rspress-graph-view-panel button[aria-label='Close graph view']",
		) as HTMLButtonElement;
		fireEvent.click(close);

		expect(container.querySelector("#rspress-graph-view-panel")).toBeNull();
		expect(document.activeElement).toBe(
			container.querySelector("button[aria-label='Open graph view']"),
		);
	});

	test("scales the FAB on hover and restores it on leave", async () => {
		const container = openPanel();
		const fab = container.querySelector(
			"button[aria-label='Open graph view']",
		) as HTMLButtonElement;

		fireEvent.mouseEnter(fab);
		expect(fab.style.transform).toBe("scale(1.12)");
		expect(fab.style.animationPlayState).toBe("paused");

		fireEvent.mouseLeave(fab);
		expect(fab.style.transform).toBe("scale(1)");
		expect(fab.style.animationPlayState).toBe("running");
	});

	test("clears the close control's hover highlight on leave", async () => {
		const container = openPanel();
		fireEvent.keyDown(window, { key: "g" });

		const close = container.querySelector(
			"#rspress-graph-view-panel button[aria-label='Close graph view']",
		) as HTMLButtonElement;
		fireEvent.mouseEnter(close);
		fireEvent.mouseLeave(close);

		expect(close.style.background).toBe("transparent");

		// Close so the 150ms stats timer does not fire after the test.
		fireEvent.keyDown(window, { key: "g" });
	});

	test("does not take focus when it mounts already open", async () => {
		// The docs site opens the panel with `defaultOpen`. Moving focus into it on a
		// timer pulled focus out of whatever the reader had focused in the meantime —
		// the canvas help dialog, for one — after which Escape went to the panel
		// instead of the dialog.
		const elsewhere = document.createElement("button");
		elsewhere.setAttribute("aria-label", "somewhere else");
		document.body.appendChild(elsewhere);
		elsewhere.focus();

		try {
			const { container } = render(<GraphPanel defaultOpen />);
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 200);
			await act(async () => {
				await promise;
			});

			expect(container.querySelector("#rspress-graph-view-panel")).toBeTruthy();
			expect(document.activeElement).toBe(elsewhere);
		} finally {
			elsewhere.remove();
		}
	});

	test("stays closed on a phone despite defaultOpen, until the reader opens it", async () => {
		const narrow = vi
			.spyOn(window, "matchMedia")
			.mockImplementation(
				(query: string) =>
					({ matches: query === "(max-width: 639px)", media: query }) as MediaQueryList,
			);
		try {
			const { container } = render(<GraphPanel defaultOpen />);
			await act(async () => {});
			expect(container.querySelector("#rspress-graph-view-panel")).toBeNull();

			fireEvent.keyDown(window, { key: "g" });
			expect(container.querySelector("#rspress-graph-view-panel")).toBeTruthy();
			// Close so the 150ms stats timer does not fire after the test.
			fireEvent.keyDown(window, { key: "g" });
		} finally {
			narrow.mockRestore();
		}
	});

	test("keeps a phone reader's own choice to open the panel", async () => {
		localStorage.setItem("rspress-graph-view-open", "true");
		const narrow = vi
			.spyOn(window, "matchMedia")
			.mockImplementation((query: string) => ({ matches: true, media: query }) as MediaQueryList);
		try {
			const { container } = render(<GraphPanel />);
			await act(async () => {});
			expect(container.querySelector("#rspress-graph-view-panel")).toBeTruthy();
			fireEvent.keyDown(window, { key: "g" });
		} finally {
			narrow.mockRestore();
		}
	});

	test("takes focus when the reader opens it", async () => {
		const container = openPanel();
		fireEvent.keyDown(window, { key: "g" });

		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 200);
		await act(async () => {
			await promise;
		});

		expect(document.activeElement).toBe(
			container.querySelector("#rspress-graph-view-panel button[aria-label='Close graph view']"),
		);

		// Close so the 150ms stats timer does not fire after the test.
		fireEvent.keyDown(window, { key: "g" });
	});

	test("navigates to the route of a clicked graph node", async () => {
		openPanel();
		await act(async () => {
			await Promise.resolve();
		});
		fireEvent.keyDown(window, { key: "g" });
		// GraphView only mounts its force graph once the lazy import resolves.
		await act(async () => {
			await Promise.resolve();
		});

		const onNodeClick = capturedGraphProps?.onNodeClick as
			| ((node: ReturnType<typeof graphNode>) => void)
			| undefined;
		if (!onNodeClick) throw new Error("GraphView never wired onNodeClick");

		onNodeClick(graphNode("/guide/api"));

		expect(navigateSpy).toHaveBeenCalledWith("/guide/api");

		// Close so the 150ms stats timer does not fire after the test.
		fireEvent.keyDown(window, { key: "g" });
	});

	test("a panel the reader requested before its chunk loaded takes focus on mount", () => {
		// The FAB the reader activated belongs to the lazy wrapper and unmounts as
		// the chunk loads; without this, focus fell to <body>.
		vi.useFakeTimers();
		try {
			const { container } = render(<GraphPanel defaultOpen readerRequested />);
			act(() => {
				vi.advanceTimersByTime(200);
			});
			expect(document.activeElement).toBe(
				container.querySelector("#rspress-graph-view-panel button[aria-label='Close graph view']"),
			);
		} finally {
			vi.useRealTimers();
		}
	});

	test("secondary text uses the theme's full-strength secondary colour", () => {
		const container = openPanel();
		fireEvent.keyDown(window, { key: "g" });
		const hint = [...container.querySelectorAll("#rspress-graph-view-panel span")].find((span) =>
			span.textContent?.includes("to close"),
		) as HTMLElement | undefined;
		const footer = hint?.parentElement as HTMLElement;
		// The old `color-mix(… 40%, transparent)` measured about 1.7:1.
		expect(footer.style.color).not.toContain("color-mix");
		expect(footer.style.color).toContain("--rp-c-text-2");
	});
});
