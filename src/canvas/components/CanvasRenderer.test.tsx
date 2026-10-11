import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { viewportStorageKey } from "../hooks/usePanZoom";
import type { CanvasData } from "../types";
import { CanvasRenderer } from "./CanvasRenderer";

afterEach(cleanup);

// A canvas reopens at the viewport it was last left at, so each test starts from
// a browser with no memory of the previous one's pans and zooms.
beforeEach(() => {
	localStorage.clear();
});

const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

afterEach(() => {
	HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
});

/**
 * happy-dom lays nothing out, so every element measures 0x0. Fit-to-view leaves
 * an unmeasured viewport alone, so the tests that assert fitting (or placing a
 * card at the view centre) give the viewport a box first.
 */
function stubViewportRect(width: number, height: number): void {
	HTMLElement.prototype.getBoundingClientRect = (() => ({
		x: 0,
		y: 0,
		top: 0,
		left: 0,
		right: width,
		bottom: height,
		width,
		height,
		toJSON: () => ({}),
	})) as unknown as typeof HTMLElement.prototype.getBoundingClientRect;
}

function oneNode(): CanvasData {
	return {
		nodes: [{ id: "a", type: "text", x: 0, y: 0, width: 200, height: 100, text: "Alpha" }],
		edges: [],
	};
}

function twoNodes(): CanvasData {
	return {
		nodes: [
			{ id: "a", type: "text", x: 0, y: 0, width: 200, height: 100, text: "Alpha" },
			{ id: "b", type: "text", x: 300, y: 0, width: 200, height: 100, text: "Beta" },
		],
		edges: [],
	};
}

function linkedNodes(): CanvasData {
	return { ...twoNodes(), edges: [{ id: "e1", fromNode: "a", toNode: "b" }] };
}

function pick<T extends Element>(container: HTMLElement, selector: string): T {
	const element = container.querySelector(selector);
	if (!element) throw new Error(`no element matched ${selector}`);
	return element as unknown as T;
}

function frame(container: HTMLElement, id: string): HTMLElement {
	return pick<HTMLElement>(container, `[data-node-id="${id}"]`);
}

function frameIds(container: HTMLElement): string[] {
	return [...container.querySelectorAll<HTMLElement>("[data-node-id]")].map(
		(element) => element.dataset.nodeId ?? "",
	);
}

function selectedIds(container: HTMLElement): string[] {
	return [...container.querySelectorAll<HTMLElement>(".canvas-node-frame.is-selected")].map(
		(element) => element.dataset.nodeId ?? "",
	);
}

function worldTransform(container: HTMLElement): string {
	return pick<HTMLElement>(container, ".canvas-world").style.transform;
}

/** A real click: the browser sends pointerdown, pointerup, then click. */
function clickCard(
	container: HTMLElement,
	id: string,
	init: { shiftKey?: boolean; pointerId?: number } = {},
) {
	const target = frame(container, id);
	const pointer = { button: 0, clientX: 5, clientY: 5, pointerId: init.pointerId ?? 1, ...init };
	fireEvent.pointerDown(target, pointer);
	fireEvent.pointerUp(pick<HTMLElement>(container, ".canvas-viewport"), pointer);
	fireEvent.click(target, { shiftKey: init.shiftKey ?? false });
}

function dragCard(container: HTMLElement, id: string, dx: number, dy: number, pointerId = 1) {
	const viewport = pick<HTMLElement>(container, ".canvas-viewport");
	fireEvent.pointerDown(frame(container, id), { button: 0, clientX: 0, clientY: 0, pointerId });
	fireEvent.pointerMove(viewport, { clientX: dx / 2, clientY: dy / 2, pointerId });
	fireEvent.pointerMove(viewport, { clientX: dx, clientY: dy, pointerId });
	fireEvent.pointerUp(viewport, { pointerId });
}

function keyOn(container: HTMLElement, key: string, init: Partial<KeyboardEventInit> = {}) {
	fireEvent.keyDown(pick<HTMLElement>(container, ".canvas-viewport"), { key, ...init });
}

/** Capture what the export button (or Ctrl/⌘+S) downloads. */
function captureDownloads() {
	const blobs: Blob[] = [];
	const names: string[] = [];
	const originalCreate = URL.createObjectURL;
	const originalRevoke = URL.revokeObjectURL;
	const originalClick = HTMLAnchorElement.prototype.click;
	URL.createObjectURL = (blob: Blob) => {
		blobs.push(blob);
		return "blob:canvas";
	};
	URL.revokeObjectURL = () => {};
	HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
		names.push(this.download);
	};
	return {
		blobs,
		names,
		restore() {
			URL.createObjectURL = originalCreate;
			URL.revokeObjectURL = originalRevoke;
			HTMLAnchorElement.prototype.click = originalClick;
		},
	};
}

describe("CanvasRenderer toolbar and viewport", () => {
	test("toggles the grid dots on and off", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} />);
		expect(container.querySelector(".canvas-background")).toBeTruthy();
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Toggle Grid Dots"]'));
		expect(container.querySelector(".canvas-background")).toBeNull();
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Toggle Grid Dots"]'));
		expect(container.querySelector(".canvas-background")).toBeTruthy();
	});

	test("zoom in, zoom out and reset change the rendered world transform", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} />);
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Zoom in"]'));
		expect(worldTransform(container)).toContain("scale(1.2)");
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Zoom out"]'));
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Zoom out"]'));
		expect(worldTransform(container)).toMatch(/scale\(0\.83/);
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Reset zoom (1:1)"]'));
		expect(worldTransform(container)).toContain("scale(1)");
	});

	test("reopens a board at the viewport the reader left it at", async () => {
		stubViewportRect(800, 500);
		const first = render(<CanvasRenderer data={oneNode()} boardId="Board.canvas" />);
		await delay(150);
		fireEvent.click(pick<HTMLButtonElement>(first.container, '[aria-label="Zoom in"]'));
		const moved = worldTransform(first.container);
		cleanup();

		// The second visit must not re-fit over the remembered position.
		const second = render(<CanvasRenderer data={oneNode()} boardId="Board.canvas" />);
		await delay(150);
		expect(worldTransform(second.container)).toBe(moved);
		expect(localStorage.getItem(viewportStorageKey("Board.canvas"))).not.toBeNull();
	});

	test("a first visit fits the board to the viewport", async () => {
		stubViewportRect(800, 500);
		const { container } = render(<CanvasRenderer data={oneNode()} boardId="Fresh.canvas" />);
		await delay(150);
		expect(worldTransform(container)).toBe("translate(250px, 175px) scale(1.5)");
	});

	test("ignores a stored viewport that is not a usable triple", async () => {
		localStorage.setItem(viewportStorageKey("Bad.canvas"), '{"x":"left"}');
		stubViewportRect(800, 500);
		const { container } = render(<CanvasRenderer data={oneNode()} boardId="Bad.canvas" />);
		await delay(150);
		expect(worldTransform(container)).toBe("translate(250px, 175px) scale(1.5)");
	});

	test("opens the help dialog with focus inside and returns focus on close", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} />);
		const help = pick<HTMLButtonElement>(container, '[aria-label="Help"]');
		fireEvent.click(help);
		expect(help.getAttribute("aria-expanded")).toBe("true");
		const close = pick<HTMLButtonElement>(container, '[aria-label="Close help"]');
		expect(document.activeElement).toBe(close);
		fireEvent.keyDown(pick<HTMLElement>(container, '[role="dialog"]'), { key: "Escape" });
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		expect(document.activeElement).toBe(help);
	});

	test("keyboard shortcuts drive the zoom, but leave modifier combos to the browser", () => {
		stubViewportRect(800, 500);
		const { container } = render(<CanvasRenderer data={oneNode()} />);
		keyOn(container, "+");
		expect(worldTransform(container)).toContain("scale(1.2)");
		const zoomed = worldTransform(container);

		// Ctrl/⌘+F is find-in-page and Ctrl+0 the browser's zoom reset.
		keyOn(container, "f", { ctrlKey: true });
		keyOn(container, "0", { metaKey: true });
		keyOn(container, "-", { altKey: true });
		expect(worldTransform(container)).toBe(zoomed);

		keyOn(container, "0");
		expect(worldTransform(container)).toContain("scale(1)");
		keyOn(container, "f");
		expect(worldTransform(container)).toBe("translate(250px, 175px) scale(1.5)");
	});

	test("arrow keys pan the board", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} />);
		keyOn(container, "ArrowRight");
		keyOn(container, "ArrowDown");
		expect(worldTransform(container)).toBe("translate(-40px, -40px) scale(1)");
	});

	test("restores the viewport only after hydration, so the server markup matches", async () => {
		localStorage.setItem(
			viewportStorageKey("Hydrate.canvas"),
			JSON.stringify({ x: 5, y: 6, zoom: 2 }),
		);
		const { renderToString } = await import("react-dom/server");
		const html = renderToString(<CanvasRenderer data={oneNode()} boardId="Hydrate.canvas" />);
		expect(html).toContain("translate(0px, 0px) scale(1)");
		const { container } = render(<CanvasRenderer data={oneNode()} boardId="Hydrate.canvas" />);
		expect(worldTransform(container)).toBe("translate(5px, 6px) scale(2)");
	});
});

describe("CanvasRenderer read-only mode", () => {
	test("pans from any card, and a card never moves", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} />);
		const viewport = pick<HTMLElement>(container, ".canvas-viewport");
		fireEvent.pointerDown(frame(container, "a"), {
			button: 0,
			clientX: 10,
			clientY: 10,
			pointerId: 1,
		});
		fireEvent.pointerMove(viewport, { clientX: 60, clientY: 40, pointerId: 1 });
		expect(worldTransform(container)).toBe("translate(50px, 30px) scale(1)");
		expect(frame(container, "a").style.left).toBe("0px");
	});

	test("ignores Delete, and Ctrl/⌘+S downloads nothing", () => {
		const downloads = captureDownloads();
		try {
			const { container } = render(<CanvasRenderer data={oneNode()} />);
			clickCard(container, "a");
			keyOn(container, "Delete");
			keyOn(container, "s", { metaKey: true });
			keyOn(container, "s", { ctrlKey: true });
			expect(frameIds(container)).toEqual(["a"]);
			expect(downloads.names).toEqual([]);
		} finally {
			downloads.restore();
		}
	});

	test("renders edges as non-interactive graphics", () => {
		const { container } = render(<CanvasRenderer data={linkedNodes()} />);
		expect(pick<SVGElement>(container, "svg.canvas-edges").getAttribute("aria-hidden")).toBe(
			"true",
		);
		expect(container.querySelector('[data-edge-id][role="button"]')).toBeNull();
	});

	test("exposes cards as named groups, not opaque buttons, so their content is readable", () => {
		const { container } = render(
			<CanvasRenderer
				data={{
					nodes: [
						{
							id: "a",
							type: "text",
							x: 0,
							y: 0,
							width: 200,
							height: 100,
							text: "# Plan\n\n- [link](https://e.com)",
						},
					],
					edges: [],
				}}
			/>,
		);
		const card = frame(container, "a");
		expect(card.getAttribute("role")).toBe("group");
		expect(card.getAttribute("aria-roledescription")).toBe("card");
		expect(card.getAttribute("aria-label")).toBe("Plan");
		expect(container.querySelector('[role="button"]')).toBeNull();
		expect(card.querySelector("h1")?.textContent).toBe("Plan");
		expect(card.getAttribute("tabindex")).toBe("0");
	});

	test("a click on a card selects it and highlights its edges", () => {
		const { container } = render(<CanvasRenderer data={linkedNodes()} />);
		clickCard(container, "a");
		expect(selectedIds(container)).toEqual(["a"]);
		expect(container.querySelector('[data-edge-id="e1"]')?.getAttribute("class")).toContain(
			"canvas-edge-highlighted",
		);
	});

	test("a click on the card's content selects it; a click on a link inside does not", () => {
		const data: CanvasData = {
			nodes: [
				{
					id: "a",
					type: "text",
					x: 0,
					y: 0,
					width: 200,
					height: 100,
					text: "Alpha [site](https://example.com)",
				},
			],
			edges: [],
		};
		const { container } = render(<CanvasRenderer data={data} />);
		fireEvent.click(pick<HTMLElement>(frame(container, "a"), "a[href]"));
		expect(selectedIds(container)).toEqual([]);
		fireEvent.click(pick<HTMLElement>(frame(container, "a"), ".canvas-node"));
		expect(selectedIds(container)).toEqual(["a"]);
	});

	test("hovering or selecting a card keeps its rendered content in place", () => {
		// A card's DOM rebuilt on hover restarts its media, drops text selection,
		// and detaches the node a fast click pressed on — so the click never fires.
		const { container } = render(<CanvasRenderer data={linkedNodes()} />);
		const content = pick<HTMLElement>(frame(container, "a"), ".canvas-markdown").firstChild;
		fireEvent.pointerEnter(frame(container, "a"));
		clickCard(container, "a");
		expect(selectedIds(container)).toEqual(["a"]);
		expect(pick<HTMLElement>(frame(container, "a"), ".canvas-markdown").firstChild).toBe(content);
	});
});

describe("CanvasRenderer stacking", () => {
	test("paints groups, then edges, then cards, each band in array order", () => {
		const data: CanvasData = {
			nodes: [
				{ id: "c1", type: "text", x: 10, y: 10, width: 50, height: 50, text: "one" },
				{ id: "g1", type: "group", x: 0, y: 0, width: 500, height: 500 },
				{ id: "c2", type: "text", x: 100, y: 10, width: 50, height: 50, text: "two" },
				{ id: "g2", type: "group", x: 0, y: 0, width: 600, height: 600 },
				{ id: "c3", type: "text", x: 200, y: 10, width: 50, height: 50, text: "three" },
			],
			edges: [{ id: "e", fromNode: "c1", toNode: "c3" }],
		};
		const { container } = render(<CanvasRenderer data={data} />);
		const z = (id: string) => Number(frame(container, id).style.zIndex);
		const edges = Number(pick<SVGElement>(container, "svg.canvas-edges").style.zIndex);
		expect(z("g1")).toBeLessThan(z("g2"));
		expect(z("g2")).toBeLessThan(edges);
		expect(edges).toBeLessThan(z("c1"));
		expect(z("c1")).toBeLessThan(z("c2"));
		expect(z("c2")).toBeLessThan(z("c3"));
	});

	test("lifts a hovered or selected card on its frame, but never a group", () => {
		const data: CanvasData = {
			nodes: [
				{ id: "g", type: "group", x: 0, y: 0, width: 500, height: 500 },
				{ id: "a", type: "text", x: 10, y: 10, width: 50, height: 50, text: "a" },
				{ id: "b", type: "text", x: 100, y: 10, width: 50, height: 50, text: "b" },
			],
			edges: [],
		};
		const { container } = render(<CanvasRenderer data={data} />);
		const before = Number(frame(container, "g").style.zIndex);
		fireEvent.pointerEnter(frame(container, "a"));
		expect(Number(frame(container, "a").style.zIndex)).toBeGreaterThan(
			Number(frame(container, "b").style.zIndex),
		);
		fireEvent.pointerEnter(frame(container, "g"));
		expect(Number(frame(container, "g").style.zIndex)).toBe(before);
	});

	test("gives each renderer its own arrow markers", () => {
		const { container } = render(
			<>
				<CanvasRenderer data={linkedNodes()} />
				<CanvasRenderer data={linkedNodes()} />
			</>,
		);
		const ids = [...container.querySelectorAll("marker")].map((marker) => marker.id);
		expect(ids).toHaveLength(4);
		expect(new Set(ids).size).toBe(4);
		const ends = [...container.querySelectorAll("path.canvas-edge-path")].map((path) =>
			path.getAttribute("marker-end"),
		);
		expect(new Set(ends).size).toBe(2);
	});
});

describe("CanvasRenderer editor: cards and text", () => {
	test("adds a text card at the centre of the view and opens its editor", () => {
		stubViewportRect(800, 500);
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Add text card"]'));
		const card = frame(container, "node-2");
		// The new 280x160 card is centred on the visible middle (400, 250).
		expect(card.style.left).toBe("260px");
		expect(card.style.top).toBe("170px");
		expect(container.querySelector(".canvas-editor-textarea")).toBeTruthy();
	});

	test("commits the edited text on blur and can undo it", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		fireEvent.doubleClick(frame(container, "a"));
		const textarea = pick<HTMLTextAreaElement>(container, ".canvas-editor-textarea");
		fireEvent.change(textarea, { target: { value: "Edited" } });
		fireEvent.blur(textarea);
		expect(frame(container, "a").textContent).toContain("Edited");
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Undo"]'));
		expect(frame(container, "a").textContent).toContain("Alpha");
	});

	test("opening and leaving the editor without a change records nothing", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		fireEvent.doubleClick(frame(container, "a"));
		fireEvent.blur(pick<HTMLTextAreaElement>(container, ".canvas-editor-textarea"));
		expect(pick<HTMLButtonElement>(container, '[aria-label="Undo"]').disabled).toBe(true);
		expect(container.textContent).toContain("Read-only source until exported");
	});

	test("Escape commits the draft instead of discarding it", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		fireEvent.doubleClick(frame(container, "a"));
		const textarea = pick<HTMLTextAreaElement>(container, ".canvas-editor-textarea");
		fireEvent.change(textarea, { target: { value: "Kept" } });
		fireEvent.keyDown(textarea, { key: "Escape" });
		expect(container.querySelector(".canvas-editor-textarea")).toBeNull();
		expect(frame(container, "a").textContent).toContain("Kept");
		expect(document.activeElement).toBe(frame(container, "a"));
	});

	test("Enter on a focused text card opens its editor", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		fireEvent.keyDown(frame(container, "a"), { key: "Enter" });
		expect(container.querySelector(".canvas-editor-textarea")).toBeTruthy();
	});

	test("selecting text in the editor with the mouse does not drag the card", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		fireEvent.doubleClick(frame(container, "a"));
		const textarea = pick<HTMLTextAreaElement>(container, ".canvas-editor-textarea");
		const viewport = pick<HTMLElement>(container, ".canvas-viewport");
		fireEvent.pointerDown(textarea, { button: 0, clientX: 0, clientY: 0, pointerId: 4 });
		fireEvent.pointerMove(viewport, { clientX: 80, clientY: 40, pointerId: 4 });
		fireEvent.pointerUp(viewport, { pointerId: 4 });
		expect(frame(container, "a").style.left).toBe("0px");
		expect(worldTransform(container)).toBe("translate(0px, 0px) scale(1)");
	});

	test("keystrokes inside the card editor neither delete the card nor undo the board", () => {
		const { container } = render(<CanvasRenderer data={twoNodes()} editable />);
		dragCard(container, "b", 40, 0);
		fireEvent.doubleClick(frame(container, "a"));
		const textarea = pick<HTMLTextAreaElement>(container, ".canvas-editor-textarea");
		fireEvent.keyDown(textarea, { key: "Backspace" });
		fireEvent.keyDown(textarea, { key: "z", ctrlKey: true });
		fireEvent.keyDown(textarea, { key: "f" });
		expect(frameIds(container)).toEqual(["a", "b"]);
		expect(frame(container, "b").style.left).toBe("340px");
	});
});

describe("CanvasRenderer editor: selection, drag and delete", () => {
	test("drag moves the node and records an undoable move", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		dragCard(container, "a", 120, 90);
		expect(frame(container, "a").style.left).toBe("120px");
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Undo"]'));
		expect(frame(container, "a").style.left).toBe("0px");
	});

	test("the resize handle resizes the selected node", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		clickCard(container, "a");
		const handle = pick<HTMLButtonElement>(container, ".canvas-resize-handle");
		const viewport = pick<HTMLElement>(container, ".canvas-viewport");
		fireEvent.pointerDown(handle, { button: 0, clientX: 0, clientY: 0, pointerId: 2 });
		fireEvent.pointerMove(viewport, { clientX: 50, clientY: 30, pointerId: 2 });
		fireEvent.pointerUp(viewport, { pointerId: 2 });
		expect(frame(container, "a").style.width).toBe("250px");
		expect(frame(container, "a").style.height).toBe("130px");
	});

	test("Shift-click extends the selection through a real pointer and click sequence", () => {
		const { container } = render(<CanvasRenderer data={twoNodes()} editable />);
		clickCard(container, "a");
		clickCard(container, "b", { shiftKey: true });
		expect(selectedIds(container).sort()).toEqual(["a", "b"]);
		clickCard(container, "a", { shiftKey: true });
		expect(selectedIds(container)).toEqual(["b"]);
		keyOn(container, "Escape");
		expect(selectedIds(container)).toEqual([]);
	});

	test("deleting and undoing puts cards and edges back in their original order", () => {
		const data: CanvasData = {
			nodes: [
				{ id: "a", type: "text", x: 0, y: 0, width: 10, height: 10, text: "a" },
				{ id: "b", type: "text", x: 20, y: 0, width: 10, height: 10, text: "b" },
				{ id: "c", type: "text", x: 40, y: 0, width: 10, height: 10, text: "c" },
			],
			edges: [
				{ id: "ab", fromNode: "a", toNode: "b" },
				{ id: "bc", fromNode: "b", toNode: "c" },
				{ id: "ac", fromNode: "a", toNode: "c" },
			],
		};
		const { container } = render(<CanvasRenderer data={data} editable />);
		const zBefore = Number(frame(container, "a").style.zIndex);
		clickCard(container, "a");
		keyOn(container, "Delete");
		expect(frameIds(container)).toEqual(["b", "c"]);
		expect(container.querySelector('[data-edge-id="ab"]')).toBeNull();
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Undo"]'));
		// Array order is z-order: the restored card goes back under the others.
		expect(frameIds(container)).toEqual(["a", "b", "c"]);
		expect(Number(frame(container, "a").style.zIndex)).toBe(zBefore);
		expect(
			[...container.querySelectorAll<SVGGElement>("[data-edge-id]")].map(
				(edge) => edge.dataset.edgeId,
			),
		).toEqual(["ab", "bc", "ac"]);
	});

	test("Delete and Backspace remove the selection", () => {
		const { container } = render(<CanvasRenderer data={twoNodes()} editable />);
		clickCard(container, "a");
		keyOn(container, "Delete");
		clickCard(container, "b");
		keyOn(container, "Backspace");
		expect(frameIds(container)).toEqual([]);
	});

	test("node and edge selection are exclusive, so Delete removes what was picked last", () => {
		const { container } = render(<CanvasRenderer data={linkedNodes()} editable />);
		fireEvent.click(pick<SVGGElement>(container, '[data-edge-id="e1"]'));
		clickCard(container, "a");
		expect(
			pick<SVGPathElement>(container, '[data-edge-id="e1"] path.canvas-edge-path').getAttribute(
				"stroke-width",
			),
		).not.toBe("4");
		keyOn(container, "Delete");
		expect(frameIds(container)).toEqual(["b"]);

		cleanup();
		const second = render(<CanvasRenderer data={linkedNodes()} editable />);
		clickCard(second.container, "a");
		fireEvent.click(pick<SVGGElement>(second.container, '[data-edge-id="e1"]'));
		expect(selectedIds(second.container)).toEqual([]);
		keyOn(second.container, "Delete");
		expect(frameIds(second.container)).toEqual(["a", "b"]);
		expect(second.container.querySelector('[data-edge-id="e1"]')).toBeNull();
	});

	test("arrow keys move the selection one undoable step at a time", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		clickCard(container, "a");
		keyOn(container, "ArrowRight");
		keyOn(container, "ArrowDown", { shiftKey: true });
		expect(frame(container, "a").style.left).toBe("10px");
		expect(frame(container, "a").style.top).toBe("50px");
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Undo"]'));
		expect(frame(container, "a").style.top).toBe("0px");
	});

	test("clicking the background clears the selection and double-click fits the view", () => {
		stubViewportRect(800, 500);
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		clickCard(container, "a");
		const viewport = pick<HTMLElement>(container, ".canvas-viewport");
		fireEvent.click(viewport);
		expect(selectedIds(container)).toEqual([]);
		fireEvent.doubleClick(viewport);
		expect(worldTransform(container)).toBe("translate(250px, 175px) scale(1.5)");
	});

	test("claims the pointer only once a press becomes a drag, so clicks reach card links", () => {
		const captured: number[] = [];
		const original = HTMLElement.prototype.setPointerCapture;
		HTMLElement.prototype.setPointerCapture = (id: number) => {
			captured.push(id);
		};
		try {
			const { container } = render(<CanvasRenderer data={oneNode()} editable />);
			const viewport = pick<HTMLElement>(container, ".canvas-viewport");
			fireEvent.pointerDown(frame(container, "a"), {
				button: 0,
				clientX: 0,
				clientY: 0,
				pointerId: 9,
			});
			fireEvent.pointerMove(viewport, { clientX: 1, clientY: 1, pointerId: 9 });
			expect(captured).toEqual([]);
			fireEvent.pointerMove(viewport, { clientX: 10, clientY: 0, pointerId: 9 });
			expect(captured).toEqual([9]);
		} finally {
			HTMLElement.prototype.setPointerCapture = original;
		}
	});

	test("the middle button and Space+drag pan from a card in the editor", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		const viewport = pick<HTMLElement>(container, ".canvas-viewport");
		fireEvent.pointerDown(frame(container, "a"), {
			button: 1,
			clientX: 0,
			clientY: 0,
			pointerId: 3,
		});
		fireEvent.pointerMove(viewport, { clientX: 30, clientY: 20, pointerId: 3 });
		fireEvent.pointerUp(viewport, { pointerId: 3 });
		expect(worldTransform(container)).toBe("translate(30px, 20px) scale(1)");
		expect(frame(container, "a").style.left).toBe("0px");

		fireEvent.pointerEnter(viewport);
		fireEvent.keyDown(document.body, { code: "Space", key: " " });
		fireEvent.pointerDown(frame(container, "a"), {
			button: 0,
			clientX: 0,
			clientY: 0,
			pointerId: 4,
		});
		fireEvent.pointerMove(viewport, { clientX: 10, clientY: 0, pointerId: 4 });
		fireEvent.keyUp(window, { code: "Space", key: " " });
		expect(worldTransform(container)).toBe("translate(40px, 20px) scale(1)");
		expect(frame(container, "a").style.left).toBe("0px");
	});

	test("a pointercancel disarms the drag and records the move exactly once", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		const viewport = pick<HTMLElement>(container, ".canvas-viewport");
		fireEvent.pointerDown(frame(container, "a"), {
			button: 0,
			clientX: 0,
			clientY: 0,
			pointerId: 5,
		});
		fireEvent.pointerMove(viewport, { clientX: 40, clientY: 0, pointerId: 5 });
		fireEvent.pointerCancel(viewport, { pointerId: 5 });
		fireEvent.pointerMove(viewport, { clientX: 90, clientY: 0, pointerId: 5 });
		expect(frame(container, "a").style.left).toBe("40px");
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Undo"]'));
		expect(frame(container, "a").style.left).toBe("0px");
		expect(pick<HTMLButtonElement>(container, '[aria-label="Undo"]').disabled).toBe(true);
	});

	test("a press that never travels far enough records no history", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		dragCard(container, "a", 2, 0);
		expect(pick<HTMLButtonElement>(container, '[aria-label="Undo"]').disabled).toBe(true);
	});

	test("fits once on mount and leaves the viewport alone after a drag", async () => {
		stubViewportRect(800, 500);
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		await waitFor(() =>
			expect(worldTransform(container)).toBe("translate(250px, 175px) scale(1.5)"),
		);
		dragCard(container, "a", 40, 20);
		// The mount fit is deferred by a real 100ms timer; a refit after the
		// move would have landed within this wait.
		await delay(250);
		expect(worldTransform(container)).toBe("translate(250px, 175px) scale(1.5)");
	});
});

describe("CanvasRenderer undo and redo", () => {
	test("Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		dragCard(container, "a", 50, 0);
		keyOn(container, "z", { ctrlKey: true });
		expect(frame(container, "a").style.left).toBe("0px");
		keyOn(container, "z", { ctrlKey: true, shiftKey: true });
		expect(frame(container, "a").style.left).toBe("50px");
		keyOn(container, "z", { metaKey: true });
		keyOn(container, "y", { ctrlKey: true });
		expect(frame(container, "a").style.left).toBe("50px");
	});

	test("undo and redo step through added cards", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Add group"]'));
		expect(frameIds(container)).toEqual(["a", "node-2"]);
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Undo"]'));
		expect(frameIds(container)).toEqual(["a"]);
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Redo"]'));
		expect(frameIds(container)).toEqual(["a", "node-2"]);
	});
});

describe("CanvasRenderer edges", () => {
	test("connects a node to a target on the facing sides, and undoes the new edge", () => {
		const { container } = render(<CanvasRenderer data={twoNodes()} editable />);
		clickCard(container, "a");
		fireEvent.click(
			pick<HTMLButtonElement>(container, '[aria-label="Connect edge from selected node"]'),
		);
		clickCard(container, "b");
		const path = pick<SVGPathElement>(container, '[data-edge-id="edge-1"] path.canvas-edge-path');
		// a.right (200, 50) to b.left (300, 50): the arrow lands on b's border.
		expect(path.getAttribute("d")).toMatch(/^M 200 50 .* 300 50$/);
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Undo"]'));
		expect(container.querySelector('[data-edge-id="edge-1"]')).toBeNull();
	});

	test("selects an edge and deletes it, and undo puts it back in place", () => {
		const { container } = render(<CanvasRenderer data={linkedNodes()} editable />);
		fireEvent.click(pick<SVGGElement>(container, '[data-edge-id="e1"]'));
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Delete selected edge"]'));
		expect(container.querySelector('[data-edge-id="e1"]')).toBeNull();
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Undo"]'));
		expect(container.querySelector('[data-edge-id="e1"]')).toBeTruthy();
	});

	test("highlights edges connected to the hovered node", () => {
		const { container } = render(<CanvasRenderer data={linkedNodes()} />);
		const edge = () => container.querySelector('[data-edge-id="e1"]')?.getAttribute("class");
		expect(edge()).toBe("canvas-edge");
		fireEvent.pointerEnter(frame(container, "b"));
		expect(edge()).toContain("canvas-edge-highlighted");
		fireEvent.pointerLeave(frame(container, "b"));
		expect(edge()).toBe("canvas-edge");
	});
});

describe("CanvasRenderer export", () => {
	test("exports the board losslessly: unknown fields kept, build data stripped", async () => {
		const downloads = captureDownloads();
		try {
			const data = {
				nodes: [
					{
						id: "a",
						type: "text",
						x: 0,
						y: 0,
						width: 200,
						height: 100,
						text: "Alpha",
						styleAttributes: { shape: "pill" },
					},
					{
						id: "f",
						type: "file",
						x: 300,
						y: 0,
						width: 200,
						height: 100,
						file: "pic.png",
						resolvedFile: { kind: "image", key: "pic.png" },
					},
				],
				edges: [{ id: "e1", fromNode: "a", toNode: "f", styleAttributes: { path: "dotted" } }],
				assets: { "pic.png": "/vault/pic.png" },
				notes: { "note.md": "body" },
				links: { "": {} },
				metadata: { version: "1" },
			} as unknown as CanvasData;
			const { container } = render(
				<CanvasRenderer data={data} editable boardId="Projects/My Board.canvas" />,
			);
			fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Export canvas"]'));

			expect(downloads.names).toEqual(["My Board.canvas"]);
			const exported = JSON.parse(await (downloads.blobs[0] as Blob).text());
			expect(exported).toEqual({
				metadata: { version: "1" },
				nodes: [
					{
						id: "a",
						type: "text",
						x: 0,
						y: 0,
						width: 200,
						height: 100,
						text: "Alpha",
						styleAttributes: { shape: "pill" },
					},
					{ id: "f", type: "file", x: 300, y: 0, width: 200, height: 100, file: "pic.png" },
				],
				edges: [{ id: "e1", fromNode: "a", toNode: "f", styleAttributes: { path: "dotted" } }],
			});
		} finally {
			downloads.restore();
		}
	});

	test("Ctrl/⌘+S exports in the editor, named after the editor title without a board", () => {
		const downloads = captureDownloads();
		try {
			const { container } = render(
				<CanvasRenderer data={oneNode()} editable editorTitle="My Canvas" />,
			);
			keyOn(container, "s", { metaKey: true });
			expect(downloads.names).toEqual(["my-canvas.canvas"]);
		} finally {
			downloads.restore();
		}
	});
});

describe("CanvasRenderer groups", () => {
	function grouped(): CanvasData {
		return {
			nodes: [
				{ id: "inside", type: "text", x: 20, y: 20, width: 50, height: 50, text: "in" },
				{ id: "outside", type: "text", x: 600, y: 20, width: 50, height: 50, text: "out" },
				{ id: "g", type: "group", x: 0, y: 0, width: 300, height: 300, label: "Box" },
			],
			edges: [
				{ id: "inner", fromNode: "inside", toNode: "inside" },
				{ id: "cross", fromNode: "inside", toNode: "outside" },
			],
		};
	}

	test("a card inside a group is still selectable", () => {
		const { container } = render(<CanvasRenderer data={grouped()} editable />);
		clickCard(container, "inside");
		expect(selectedIds(container)).toEqual(["inside"]);
	});

	test("dragging a group moves the members it holds by the same delta, as one undo step", () => {
		const { container } = render(<CanvasRenderer data={grouped()} editable />);
		dragCard(container, "g", 100, 50);
		expect(frame(container, "g").style.left).toBe("100px");
		expect(frame(container, "inside").style.left).toBe("120px");
		expect(frame(container, "outside").style.left).toBe("600px");
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Undo"]'));
		expect(frame(container, "inside").style.left).toBe("20px");
		expect(frame(container, "g").style.left).toBe("0px");
	});

	test("a card dragged out of its group stops moving with it, and one dragged in joins", () => {
		const { container } = render(<CanvasRenderer data={grouped()} editable />);
		dragCard(container, "inside", 700, 0, 1);
		dragCard(container, "outside", -560, 0, 2);
		dragCard(container, "g", 10, 0, 3);
		expect(frame(container, "inside").style.left).toBe("720px");
		expect(frame(container, "outside").style.left).toBe("50px");
	});

	test("collapsing a group hides its members and the edges wholly inside it", () => {
		const { container } = render(<CanvasRenderer data={grouped()} />);
		const toggle = pick<HTMLButtonElement>(container, ".canvas-group-collapse");
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		expect(toggle.getAttribute("aria-label")).toBe("Collapse group Box");
		fireEvent.click(toggle);
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
		expect(toggle.getAttribute("aria-label")).toBe("Expand group Box");
		expect(frameIds(container)).toEqual(["outside", "g"]);
		expect(container.querySelector('[data-edge-id="inner"]')).toBeNull();
		expect(container.querySelector('[data-edge-id="cross"]')).toBeTruthy();
		fireEvent.click(toggle);
		expect(frameIds(container)).toEqual(["inside", "outside", "g"]);
	});

	test("a group added after its predecessor was deleted does not inherit the collapse", async () => {
		const data: CanvasData = {
			nodes: [
				{ id: "node-1", type: "text", x: 20, y: 20, width: 50, height: 50, text: "in" },
				{ id: "node-2", type: "group", x: 0, y: 0, width: 300, height: 300 },
			],
			edges: [],
		};
		const { container } = render(<CanvasRenderer data={data} editable />);
		fireEvent.click(pick<HTMLButtonElement>(container, ".canvas-group-collapse"));
		clickCard(container, "node-2");
		keyOn(container, "Delete");
		await act(async () => {});
		// The toolbar's next group takes the freed id; it must start expanded.
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Add group"]'));
		expect(frameIds(container)).toContain("node-1");
	});
});
