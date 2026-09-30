import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { VIEWPORT_KEY_PREFIX } from "../hooks/usePanZoom";
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
 * an unmeasured viewport alone (see the dedicated test), so the tests that assert
 * fitting have to give the viewport a box first.
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
			{ id: "b", type: "link", x: 300, y: 0, width: 200, height: 100, url: "https://b.example" },
		],
		edges: [],
	};
}

function linkedNodes(): CanvasData {
	return {
		...twoNodes(),
		edges: [{ id: "e1", fromNode: "a", toNode: "b" }],
	};
}

function pick<T extends Element>(container: HTMLElement, selector: string): T {
	const element = container.querySelector(selector);
	if (!element) throw new Error(`no element matched ${selector}`);
	return element as unknown as T;
}

describe("CanvasRenderer toolbar", () => {
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

		expect(pick<HTMLElement>(container, ".canvas-world").style.transform).toBe(
			"translate(0px, 0px) scale(1)",
		);

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Zoom in"]'));
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Zoom in"]'));
		expect(pick<HTMLElement>(container, ".canvas-world").style.transform).toBe(
			"translate(0px, 0px) scale(1.2)",
		);

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Zoom out"]'));
		expect(pick<HTMLElement>(container, ".canvas-world").style.transform).toBe(
			"translate(0px, 0px) scale(1.1)",
		);

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Reset zoom (1:1)"]'));
		expect(pick<HTMLElement>(container, ".canvas-world").style.transform).toBe(
			"translate(0px, 0px) scale(1)",
		);
	});

	test("fit to view frames the node bounds in the measured viewport", () => {
		stubViewportRect(800, 500);
		const { container } = render(<CanvasRenderer data={oneNode()} />);

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Fit to View"]'));

		expect(pick<HTMLElement>(container, ".canvas-world").style.transform).toBe(
			"translate(250px, 175px) scale(1.5)",
		);
	});

	test("reopens a board at the viewport the reader left it at", async () => {
		stubViewportRect(800, 500);
		const first = render(<CanvasRenderer data={oneNode()} />);
		// Let the first visit's own fit land before moving the viewport.
		await delay(150);
		fireEvent.click(pick<HTMLButtonElement>(first.container, '[aria-label="Zoom in"]'));
		fireEvent.click(pick<HTMLButtonElement>(first.container, '[aria-label="Zoom in"]'));
		const moved = pick<HTMLElement>(first.container, ".canvas-world").style.transform;
		expect(moved).toContain("scale(1.7)");
		await delay(150);
		cleanup();

		// The second visit must not re-fit over the remembered position.
		const second = render(<CanvasRenderer data={oneNode()} />);
		await delay(150);
		expect(pick<HTMLElement>(second.container, ".canvas-world").style.transform).toBe(moved);
	});

	test("a first visit still fits the board to the viewport", async () => {
		stubViewportRect(800, 500);
		const { container } = render(<CanvasRenderer data={oneNode()} />);
		await delay(150);

		expect(pick<HTMLElement>(container, ".canvas-world").style.transform).toBe(
			"translate(250px, 175px) scale(1.5)",
		);
	});

	test("ignores a stored viewport that is not a usable triple", () => {
		localStorage.setItem(`${VIEWPORT_KEY_PREFIX}${window.location.pathname}`, '{"x":"left"}');
		stubViewportRect(800, 500);
		const { container } = render(<CanvasRenderer data={oneNode()} />);

		expect(pick<HTMLElement>(container, ".canvas-world").style.transform).toBe(
			"translate(0px, 0px) scale(1)",
		);
	});

	test("does not fit to a guessed box when the viewport has no measurable size", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} />);

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Fit to View"]'));

		expect(pick<HTMLElement>(container, ".canvas-world").style.transform).toBe(
			"translate(0px, 0px) scale(1)",
		);
	});

	test("fit to view leaves an empty canvas alone", () => {
		const { container } = render(<CanvasRenderer data={{ nodes: [], edges: [] }} />);

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Fit to View"]'));

		expect(pick<HTMLElement>(container, ".canvas-world").style.transform).toBe(
			"translate(0px, 0px) scale(1)",
		);
	});

	test("zooms with the mouse wheel over the viewport", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} />);
		const viewport = pick<HTMLElement>(container, ".canvas-viewport");

		fireEvent.wheel(viewport, { deltaY: -100 });

		expect(pick<HTMLElement>(container, ".canvas-world").style.transform).toContain("scale(1.1)");
	});

	test("pans the world when dragging the background", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} />);
		const viewport = pick<HTMLElement>(container, ".canvas-viewport");

		fireEvent.pointerDown(viewport, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
		fireEvent.pointerMove(viewport, { clientX: 130, clientY: 120, pointerId: 1 });
		fireEvent.pointerUp(viewport, { pointerId: 1 });

		expect(pick<HTMLElement>(container, ".canvas-world").style.transform).toBe(
			"translate(30px, 20px) scale(1)",
		);
	});

	test("a pointercancel ends the pan instead of leaving it armed", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} />);
		const viewport = pick<HTMLElement>(container, ".canvas-viewport");

		fireEvent.pointerDown(viewport, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
		fireEvent.pointerMove(viewport, { clientX: 130, clientY: 120, pointerId: 1 });
		fireEvent.pointerCancel(viewport, { pointerId: 1 });
		fireEvent.pointerMove(viewport, { clientX: 400, clientY: 400, pointerId: 1 });

		expect(pick<HTMLElement>(container, ".canvas-world").style.transform).toBe(
			"translate(30px, 20px) scale(1)",
		);
	});

	test("every toolbar button carries the shared button class", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		const toolbar = pick<HTMLElement>(container, ".canvas-toolbar");

		const unclassed = Array.from(toolbar.querySelectorAll("button")).filter(
			(button) => !button.classList.contains("canvas-toolbar-btn"),
		);

		expect(unclassed.map((button) => button.getAttribute("aria-label"))).toEqual([]);
	});

	test("opens and closes the help modal", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} />);

		expect(container.querySelector(".canvas-help-modal")).toBeNull();

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Help"]'));
		const modal = pick<HTMLElement>(container, ".canvas-help-modal");
		expect(modal.textContent).toContain("Canvas Controls");
		expect(modal.textContent).toContain("Drag to pan. Scroll to zoom.");

		fireEvent.click(pick<HTMLButtonElement>(modal, "button"));
		expect(container.querySelector(".canvas-help-modal")).toBeNull();
	});

	test("exposes the help modal as a labelled dialog and closes it with Escape", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} />);
		const toggle = pick<HTMLButtonElement>(container, '[aria-label="Help"]');
		expect(toggle.getAttribute("aria-expanded")).toBe("false");

		fireEvent.click(toggle);

		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		const modal = pick<HTMLElement>(container, ".canvas-help-modal");
		expect(modal.getAttribute("role")).toBe("dialog");
		expect(modal.getAttribute("aria-modal")).toBe("true");
		const titleId = modal.getAttribute("aria-labelledby");
		expect(pick<HTMLElement>(container, `[id="${titleId}"]`).textContent).toBe("Canvas Controls");

		// The × glyph carries no name of its own, and the dialog moves focus onto it.
		const close = pick<HTMLButtonElement>(modal, 'button[aria-label="Close help"]');
		expect(document.activeElement).toBe(close);

		fireEvent.keyDown(modal, { key: "Escape" });

		expect(container.querySelector(".canvas-help-modal")).toBeNull();
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
	});

	test("keeps the viewport itself focusable so its shortcuts need no focused child", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} />);

		expect(pick<HTMLElement>(container, ".canvas-viewport").getAttribute("tabindex")).toBe("0");
	});
});

describe("CanvasRenderer read-only mode", () => {
	test("exposes an interactive canvas with no editor controls", () => {
		const { container } = render(<CanvasRenderer data={twoNodes()} />);

		const viewport = pick<HTMLElement>(container, ".canvas-viewport");
		expect(viewport.getAttribute("role")).toBe("application");
		expect(viewport.getAttribute("aria-label")).toBe(
			"Interactive canvas with nodes and connections",
		);
		expect(container.querySelector(".canvas-editor")).toBeNull();
		expect(container.querySelector('[aria-label="Add text card"]')).toBeNull();
		expect(container.querySelector('[aria-label="Delete selected"]')).toBeNull();
		expect(container.querySelector('[aria-label="Export canvas"]')).toBeNull();
	});

	test("ignores the Delete key", () => {
		const { container } = render(<CanvasRenderer data={twoNodes()} />);
		const viewport = pick<HTMLElement>(container, ".canvas-viewport");

		fireEvent.keyDown(viewport, { key: "Delete" });

		expect(container.querySelectorAll(".canvas-editor-node-wrapper")).toHaveLength(2);
	});

	test("renders edges as non-interactive graphics", () => {
		const { container } = render(<CanvasRenderer data={linkedNodes()} />);

		const edge = pick<Element>(container, "g.canvas-edge");
		expect(edge.getAttribute("role")).toBeNull();
		expect(pick<Element>(container, "path[marker-end]").getAttribute("marker-end")).toBe(
			"url(#arrowhead-e1)",
		);
	});
});

describe("CanvasRenderer editor banner and card creation", () => {
	test("titles the banner and reports unsaved changes after an edit", () => {
		const { container } = render(
			<CanvasRenderer data={oneNode()} editable editorTitle="My Canvas" />,
		);

		const banner = pick<HTMLElement>(container, ".canvas-editor-banner");
		expect(banner.textContent).toBe("My CanvasRead-only source until exported");

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Add text card"]'));

		expect(pick<HTMLElement>(container, ".canvas-editor-banner").textContent).toBe(
			"My CanvasUnsaved changes",
		);
	});

	test("adds a text card and opens its inline editor", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Add text card"]'));

		expect(container.querySelectorAll(".canvas-editor-node-wrapper")).toHaveLength(2);
		const textarea = pick<HTMLTextAreaElement>(container, "textarea.canvas-editor-textarea");
		expect(textarea.value).toBe("New card");
		expect(pick<HTMLButtonElement>(container, '[aria-label="Delete selected"]').disabled).toBe(
			false,
		);
	});

	test("adds file, link and group cards", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Add file card"]'));
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Add link card"]'));
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Add group"]'));

		expect(container.querySelectorAll(".canvas-node-file")).toHaveLength(1);
		expect(container.querySelectorAll(".canvas-node-link")).toHaveLength(1);
		expect(container.querySelectorAll(".canvas-node-group")).toHaveLength(1);
	});
});

describe("CanvasRenderer text editing", () => {
	test("commits the edited text on blur and can undo it", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		const wrapper = pick<HTMLElement>(container, ".canvas-editor-node-wrapper");

		fireEvent.doubleClick(wrapper);
		const textarea = pick<HTMLTextAreaElement>(container, "textarea.canvas-editor-textarea");
		expect(textarea.value).toBe("Alpha");

		fireEvent.change(textarea, { target: { value: "Edited text" } });
		expect(textarea.value).toBe("Edited text");

		fireEvent.focusOut(textarea);

		expect(container.querySelector("textarea.canvas-editor-textarea")).toBeNull();
		expect(pick<HTMLElement>(container, ".canvas-markdown").textContent?.trim()).toBe(
			"Edited text",
		);

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Undo"]'));
		expect(pick<HTMLElement>(container, ".canvas-markdown").textContent?.trim()).toBe("Alpha");

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Redo"]'));
		expect(pick<HTMLElement>(container, ".canvas-markdown").textContent?.trim()).toBe(
			"Edited text",
		);
	});
});

describe("CanvasRenderer selection, drag and delete", () => {
	test("drag moves the node and records an undoable move", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		const viewport = pick<HTMLElement>(container, ".canvas-viewport");
		const wrapper = pick<HTMLElement>(container, ".canvas-editor-node-wrapper");

		fireEvent.pointerDown(pick<HTMLElement>(container, ".canvas-node"), {
			button: 0,
			clientX: 10,
			clientY: 10,
			pointerId: 1,
		});
		expect(pick<HTMLElement>(container, ".canvas-node").className).toContain(
			"canvas-node-selected",
		);

		fireEvent.pointerMove(viewport, { clientX: 70, clientY: 40, pointerId: 1 });
		expect(wrapper.style.left).toBe("60px");
		expect(wrapper.style.top).toBe("30px");

		fireEvent.pointerUp(viewport, { pointerId: 1 });
		expect(pick<HTMLButtonElement>(container, '[aria-label="Undo"]').disabled).toBe(false);

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Undo"]'));
		expect(pick<HTMLElement>(container, ".canvas-editor-node-wrapper").style.left).toBe("0px");
	});

	test("the resize handle resizes the selected node", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		const viewport = pick<HTMLElement>(container, ".canvas-viewport");
		const wrapper = pick<HTMLElement>(container, ".canvas-editor-node-wrapper");

		fireEvent.click(pick<HTMLElement>(container, ".canvas-node"));
		fireEvent.pointerDown(pick<HTMLButtonElement>(container, '[aria-label="Resize a"]'), {
			button: 0,
			clientX: 200,
			clientY: 100,
			pointerId: 1,
		});
		fireEvent.pointerMove(viewport, { clientX: 260, clientY: 150, pointerId: 1 });
		fireEvent.pointerUp(viewport, { pointerId: 1 });

		expect(wrapper.style.width).toBe("260px");
		expect(wrapper.style.height).toBe("150px");
		expect(pick<HTMLButtonElement>(container, '[aria-label="Undo"]').disabled).toBe(false);

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Undo"]'));
		expect(pick<HTMLElement>(container, ".canvas-editor-node-wrapper").style.width).toBe("200px");

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Redo"]'));
		expect(pick<HTMLElement>(container, ".canvas-editor-node-wrapper").style.width).toBe("260px");
	});

	test("deletes the selected node and its edges, then restores both on undo", () => {
		const { container } = render(<CanvasRenderer data={linkedNodes()} editable />);

		expect(container.querySelectorAll("g.canvas-edge")).toHaveLength(1);

		fireEvent.click(pick<HTMLElement>(container, '[aria-label="Link: https://b.example"]'));
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Delete selected"]'));

		expect(container.querySelector('[aria-label="Link: https://b.example"]')).toBeNull();
		expect(container.querySelectorAll("g.canvas-edge")).toHaveLength(0);
		expect(pick<HTMLButtonElement>(container, '[aria-label="Delete selected"]').disabled).toBe(
			true,
		);

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Undo"]'));
		expect(container.querySelectorAll("g.canvas-edge")).toHaveLength(1);
		expect(container.querySelector('[aria-label="Link: https://b.example"]')).toBeTruthy();

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Redo"]'));
		expect(container.querySelectorAll("g.canvas-edge")).toHaveLength(0);
		expect(container.querySelector('[aria-label="Link: https://b.example"]')).toBeNull();
	});

	test("Delete and Backspace remove the selection in editor mode", () => {
		const { container } = render(<CanvasRenderer data={linkedNodes()} editable />);
		const viewport = pick<HTMLElement>(container, ".canvas-viewport");

		fireEvent.click(pick<HTMLElement>(container, '[aria-label="Text node"]'));
		fireEvent.keyDown(viewport, { key: "Delete" });
		expect(container.querySelector('[aria-label="Text node"]')).toBeNull();
		expect(container.querySelectorAll("g.canvas-edge")).toHaveLength(0);

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Undo"]'));
		expect(container.querySelector('[aria-label="Text node"]')).toBeTruthy();

		fireEvent.click(pick<Element>(container, "g.canvas-edge"));
		fireEvent.keyDown(viewport, { key: "Backspace" });
		expect(container.querySelectorAll("g.canvas-edge")).toHaveLength(0);
		expect(container.querySelector('[aria-label="Text node"]')).toBeTruthy();
	});

	test("shift-click extends the selection and Escape clears it", () => {
		const { container } = render(<CanvasRenderer data={twoNodes()} editable />);
		const viewport = pick<HTMLElement>(container, ".canvas-viewport");

		fireEvent.click(pick<HTMLElement>(container, '[aria-label="Text node"]'));
		fireEvent.pointerDown(pick<HTMLElement>(container, '[aria-label="Link: https://b.example"]'), {
			button: 0,
			shiftKey: true,
			pointerId: 1,
		});

		expect(container.querySelectorAll(".canvas-node-selected")).toHaveLength(2);

		fireEvent.keyDown(viewport, { key: "Escape" });
		expect(container.querySelectorAll(".canvas-node-selected")).toHaveLength(0);
	});

	test("clicking the background clears the selection and double-click fits the view", () => {
		stubViewportRect(800, 500);
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		const viewport = pick<HTMLElement>(container, ".canvas-viewport");

		fireEvent.click(pick<HTMLElement>(container, ".canvas-node"));
		expect(container.querySelectorAll(".canvas-node-selected")).toHaveLength(1);

		fireEvent.click(viewport);
		expect(container.querySelectorAll(".canvas-node-selected")).toHaveLength(0);

		fireEvent.doubleClick(viewport);
		expect(pick<HTMLElement>(container, ".canvas-world").style.transform).toBe(
			"translate(250px, 175px) scale(1.5)",
		);
	});

	test("keystrokes inside the card editor do not delete or move the canvas", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		const transform = () => pick<HTMLElement>(container, ".canvas-world").style.transform;

		fireEvent.doubleClick(pick<HTMLElement>(container, ".canvas-node"));
		const textarea = pick<HTMLTextAreaElement>(container, ".canvas-editor-textarea");
		fireEvent.change(textarea, { target: { value: "Alpha!" } });

		for (const key of ["Backspace", "Delete", "f", "0", "+"]) {
			fireEvent.keyDown(textarea, { key });
		}

		expect(container.querySelector('[aria-label="Text node"]')).toBeTruthy();
		expect(pick<HTMLTextAreaElement>(container, ".canvas-editor-textarea").value).toBe("Alpha!");
		expect(transform()).toBe("translate(0px, 0px) scale(1)");
	});

	test("Ctrl+Z inside the card editor does not undo a canvas action", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Add text card"]'));
		expect(container.querySelectorAll(".canvas-editor-node-wrapper")).toHaveLength(2);

		const textarea = pick<HTMLTextAreaElement>(container, ".canvas-editor-textarea");
		fireEvent.change(textarea, { target: { value: "draft" } });
		fireEvent.keyDown(textarea, { key: "z", ctrlKey: true });

		expect(container.querySelectorAll(".canvas-editor-node-wrapper")).toHaveLength(2);
		expect(pick<HTMLTextAreaElement>(container, ".canvas-editor-textarea").value).toBe("draft");
	});

	test("claims the pointer only once a press becomes a drag, so clicks reach card links", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		const viewport = pick<HTMLElement>(container, ".canvas-viewport");
		const wrapper = pick<HTMLElement>(container, ".canvas-editor-node-wrapper");

		// A press that never moves is a click: capturing here would retarget the
		// click to this wrapper and no link inside the card would ever fire.
		fireEvent.pointerDown(wrapper, { button: 0, clientX: 0, clientY: 0, pointerId: 4 });
		expect(wrapper.hasPointerCapture(4)).toBe(false);
		fireEvent.pointerUp(wrapper, { pointerId: 4 });
		expect(pick<HTMLButtonElement>(container, '[aria-label="Undo"]').disabled).toBe(true);

		// Past the threshold it is a drag, and the capture keeps the release.
		fireEvent.pointerDown(wrapper, { button: 0, clientX: 0, clientY: 0, pointerId: 5 });
		fireEvent.pointerMove(viewport, { clientX: 40, clientY: 20, pointerId: 5 });
		expect(wrapper.hasPointerCapture(5)).toBe(true);

		fireEvent.pointerUp(wrapper, { pointerId: 5 });

		// The move reached the history: undo restores the original position.
		expect(pick<HTMLButtonElement>(container, '[aria-label="Undo"]').disabled).toBe(false);
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Undo"]'));
		expect(pick<HTMLElement>(container, ".canvas-editor-node-wrapper").style.left).toBe("0px");
	});

	test("does not claim the pointer at all when the canvas is read-only", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} />);
		const viewport = pick<HTMLElement>(container, ".canvas-viewport");
		const wrapper = pick<HTMLElement>(container, ".canvas-editor-node-wrapper");

		fireEvent.pointerDown(wrapper, { button: 0, clientX: 0, clientY: 0, pointerId: 8 });
		fireEvent.pointerMove(viewport, { clientX: 90, clientY: 60, pointerId: 8 });

		// Nothing is dragged without `editable`, so nothing may capture either:
		// links inside a card are the primary navigation in the default mode.
		expect(wrapper.hasPointerCapture(8)).toBe(false);
		expect(wrapper.style.left).toBe("0px");
	});

	test("a pointercancel disarms the drag and records the move exactly once", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		const viewport = pick<HTMLElement>(container, ".canvas-viewport");
		const wrapper = pick<HTMLElement>(container, ".canvas-editor-node-wrapper");

		fireEvent.pointerDown(wrapper, { button: 0, clientX: 0, clientY: 0, pointerId: 9 });
		fireEvent.pointerMove(viewport, { clientX: 40, clientY: 20, pointerId: 9 });
		expect(wrapper.style.left).toBe("40px");

		// A touch takeover or OS interruption ends the gesture with pointercancel and
		// no pointerup: the card must not keep following the cursor afterwards.
		fireEvent.pointerCancel(wrapper, { pointerId: 9 });
		fireEvent.pointerMove(viewport, { clientX: 400, clientY: 300, pointerId: 9 });
		expect(wrapper.style.left).toBe("40px");

		// The cancel already committed the move; the late pointerup must not push a
		// second history entry.
		fireEvent.pointerUp(wrapper, { pointerId: 9 });
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Undo"]'));
		expect(pick<HTMLElement>(container, ".canvas-editor-node-wrapper").style.left).toBe("0px");
		expect(pick<HTMLButtonElement>(container, '[aria-label="Undo"]').disabled).toBe(true);
	});

	test("a drag that rounds to the same coordinates records no history", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		const viewport = pick<HTMLElement>(container, ".canvas-viewport");
		const wrapper = pick<HTMLElement>(container, ".canvas-editor-node-wrapper");

		fireEvent.pointerDown(wrapper, { button: 0, clientX: 10, clientY: 10, pointerId: 3 });
		fireEvent.pointerMove(viewport, { clientX: 10.4, clientY: 10.4, pointerId: 3 });
		fireEvent.pointerUp(wrapper, { pointerId: 3 });

		expect(wrapper.style.left).toBe("0px");
		expect(pick<HTMLButtonElement>(container, '[aria-label="Undo"]').disabled).toBe(true);
	});

	test("fits once on mount and leaves the viewport alone after a drag", async () => {
		stubViewportRect(800, 500);
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		const viewport = pick<HTMLElement>(container, ".canvas-viewport");
		const wrapper = pick<HTMLElement>(container, ".canvas-editor-node-wrapper");
		const transform = () => pick<HTMLElement>(container, ".canvas-world").style.transform;
		const settled = () => delay(250);

		await settled();
		const fitted = transform();
		expect(fitted).toBe("translate(250px, 175px) scale(1.5)");

		fireEvent.pointerDown(wrapper, { button: 0, clientX: 0, clientY: 0, pointerId: 6 });
		fireEvent.pointerMove(viewport, { clientX: 40, clientY: 20, pointerId: 6 });
		fireEvent.pointerUp(wrapper, { pointerId: 6 });

		// A refit after the move would re-centre the canvas and discard the
		// user's pan/zoom; the fitted transform must survive the commit.
		await settled();
		expect(transform()).toBe(fitted);
	});

	test("cancels the queued mount-fit frame when the canvas unmounts first", async () => {
		const originalRequest = globalThis.requestAnimationFrame;
		const originalCancel = globalThis.cancelAnimationFrame;
		let queuedFrame = 0;
		let cancelled = 0;
		// A frame that never runs stands in for one queued while the canvas is being
		// torn down: it must be cancelled, not left to run against an unmounted tree.
		globalThis.requestAnimationFrame = (() => {
			queuedFrame = 7;
			return 7;
		}) as typeof requestAnimationFrame;
		globalThis.cancelAnimationFrame = ((handle: number) => {
			if (handle === queuedFrame) cancelled += 1;
		}) as typeof cancelAnimationFrame;

		try {
			const { unmount } = render(<CanvasRenderer data={oneNode()} editable />);
			// The mount fit is deferred by a real 100ms timer, so this one wait is
			// the behaviour under test rather than a stand-in for a signal.
			await delay(150);
			expect(queuedFrame).toBe(7);
			expect(cancelled).toBe(0);

			unmount();

			expect(cancelled).toBe(1);
		} finally {
			globalThis.requestAnimationFrame = originalRequest;
			globalThis.cancelAnimationFrame = originalCancel;
		}
	});
});

describe("CanvasRenderer undo and redo", () => {
	test("undo and redo step through the node set", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);

		expect(pick<HTMLButtonElement>(container, '[aria-label="Undo"]').disabled).toBe(true);
		expect(pick<HTMLButtonElement>(container, '[aria-label="Redo"]').disabled).toBe(true);

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Add text card"]'));
		expect(container.querySelectorAll(".canvas-editor-node-wrapper")).toHaveLength(2);

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Undo"]'));
		expect(container.querySelectorAll(".canvas-editor-node-wrapper")).toHaveLength(1);
		expect(pick<HTMLButtonElement>(container, '[aria-label="Undo"]').disabled).toBe(true);
		expect(pick<HTMLButtonElement>(container, '[aria-label="Redo"]').disabled).toBe(false);

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Redo"]'));
		expect(container.querySelectorAll(".canvas-editor-node-wrapper")).toHaveLength(2);
		expect(pick<HTMLButtonElement>(container, '[aria-label="Redo"]').disabled).toBe(true);
	});

	test("Ctrl+Z undoes, Ctrl+Shift+Z and Ctrl+Y redo", () => {
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		const viewport = pick<HTMLElement>(container, ".canvas-viewport");

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Add text card"]'));

		fireEvent.keyDown(viewport, { key: "z", ctrlKey: true });
		expect(container.querySelectorAll(".canvas-editor-node-wrapper")).toHaveLength(1);

		fireEvent.keyDown(viewport, { key: "z", ctrlKey: true, shiftKey: true });
		expect(container.querySelectorAll(".canvas-editor-node-wrapper")).toHaveLength(2);

		fireEvent.keyDown(viewport, { key: "z", ctrlKey: true });
		fireEvent.keyDown(viewport, { key: "y", ctrlKey: true });
		expect(container.querySelectorAll(".canvas-editor-node-wrapper")).toHaveLength(2);
	});

	test("keyboard shortcuts drive the zoom", () => {
		stubViewportRect(800, 500);
		const { container } = render(<CanvasRenderer data={oneNode()} editable />);
		const viewport = pick<HTMLElement>(container, ".canvas-viewport");

		fireEvent.keyDown(viewport, { key: "+" });
		expect(pick<HTMLElement>(container, ".canvas-world").style.transform).toContain("scale(1.1)");

		fireEvent.keyDown(viewport, { key: "-" });
		expect(pick<HTMLElement>(container, ".canvas-world").style.transform).toContain("scale(1)");

		fireEvent.keyDown(viewport, { key: "+" });
		fireEvent.keyDown(viewport, { key: "0" });
		expect(pick<HTMLElement>(container, ".canvas-world").style.transform).toContain("scale(1)");

		fireEvent.keyDown(viewport, { key: "f" });
		expect(pick<HTMLElement>(container, ".canvas-world").style.transform).toBe(
			"translate(250px, 175px) scale(1.5)",
		);
	});
});

describe("CanvasRenderer edges", () => {
	test("connects a node to a target and undoes the new edge", () => {
		const { container } = render(<CanvasRenderer data={twoNodes()} editable />);

		fireEvent.click(pick<HTMLElement>(container, '[aria-label="Text node"]'));
		fireEvent.click(
			pick<HTMLButtonElement>(container, '[aria-label="Connect edge from selected node"]'),
		);
		expect(container.textContent).toContain("Click a target node to connect");

		fireEvent.click(pick<HTMLElement>(container, '[aria-label="Link: https://b.example"]'));

		expect(container.querySelectorAll(".canvas-edges path[marker-end]")).toHaveLength(1);
		expect(container.textContent).not.toContain("Click a target node to connect");

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Undo"]'));
		expect(container.querySelectorAll(".canvas-edges path[marker-end]")).toHaveLength(0);
	});

	test("selects an edge and deletes it", () => {
		const { container } = render(<CanvasRenderer data={linkedNodes()} editable />);

		const edge = pick<Element>(container, "g.canvas-edge");
		expect(pick<Element>(container, ".canvas-edges path").getAttribute("stroke-width")).toBe("2");
		expect(pick<HTMLButtonElement>(container, '[aria-label="Delete selected edge"]').disabled).toBe(
			true,
		);

		fireEvent.click(edge);

		expect(pick<Element>(container, ".canvas-edges path").getAttribute("stroke-width")).toBe("4");
		expect(pick<HTMLButtonElement>(container, '[aria-label="Delete selected edge"]').disabled).toBe(
			false,
		);

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Delete selected edge"]'));
		expect(container.querySelectorAll(".canvas-edges path[marker-end]")).toHaveLength(0);

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Undo"]'));
		expect(container.querySelectorAll(".canvas-edges path[marker-end]")).toHaveLength(1);

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Redo"]'));
		expect(container.querySelectorAll(".canvas-edges path[marker-end]")).toHaveLength(0);
	});

	test("highlights edges connected to the hovered node", () => {
		const { container } = render(<CanvasRenderer data={linkedNodes()} />);

		expect(container.querySelector("g.canvas-edge")).toBeTruthy();

		fireEvent.mouseEnter(pick<HTMLElement>(container, '[aria-label="Text node"]'));

		expect(container.querySelector("g.canvas-edge-highlighted")).toBeTruthy();
	});
});

describe("CanvasRenderer export", () => {
	test("downloads the edited canvas as JSON", async () => {
		const blobs: Blob[] = [];
		const downloads: string[] = [];
		const originalCreateObjectURL = URL.createObjectURL;
		const originalRevokeObjectURL = URL.revokeObjectURL;
		const originalClick = HTMLAnchorElement.prototype.click;
		URL.createObjectURL = (blob: Blob) => {
			blobs.push(blob);
			return "blob:canvas";
		};
		URL.revokeObjectURL = () => {};
		HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
			downloads.push(this.download);
		};

		try {
			const data: CanvasData = {
				...linkedNodes(),
				assets: { "pic.png": "/pic.png" },
				notes: { "note.md": "body" },
			};
			const { container } = render(<CanvasRenderer data={data} editable editorTitle="My Canvas" />);

			fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Add text card"]'));
			fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Export canvas"]'));

			expect(downloads).toEqual(["my-canvas.canvas"]);
			expect(blobs).toHaveLength(1);

			const [blob] = blobs;
			if (!blob) throw new Error("export produced no blob");
			const exported = JSON.parse(await blob.text());
			expect(exported.nodes.map((node: { id: string }) => node.id)).toEqual(["a", "b", "node-3"]);
			expect(exported.edges.map((edge: { id: string }) => edge.id)).toEqual(["e1"]);
			expect(exported.assets).toEqual({ "pic.png": "/pic.png" });
			expect(exported.notes).toEqual({ "note.md": "body" });
		} finally {
			URL.createObjectURL = originalCreateObjectURL;
			URL.revokeObjectURL = originalRevokeObjectURL;
			HTMLAnchorElement.prototype.click = originalClick;
		}
	});

	test("Ctrl+S exports the canvas", () => {
		const downloads: string[] = [];
		const originalCreateObjectURL = URL.createObjectURL;
		const originalClick = HTMLAnchorElement.prototype.click;
		URL.createObjectURL = () => "blob:canvas";
		HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
			downloads.push(this.download);
		};

		try {
			const { container } = render(
				<CanvasRenderer data={oneNode()} editable editorTitle="My Canvas" />,
			);
			fireEvent.keyDown(pick<HTMLElement>(container, ".canvas-viewport"), {
				key: "s",
				ctrlKey: true,
			});

			expect(downloads).toEqual(["my-canvas.canvas"]);
		} finally {
			URL.createObjectURL = originalCreateObjectURL;
			HTMLAnchorElement.prototype.click = originalClick;
		}
	});
});

/**
 * The group is deliberately listed *last*: a `.canvas` file may order nodes
 * however Obsidian wrote them, and the toolbar appends new groups at the end.
 */
function groupedCanvas(): CanvasData {
	return {
		nodes: [
			{ id: "a", type: "text", x: 40, y: 40, width: 200, height: 100, text: "Alpha" },
			{ id: "b", type: "link", x: 300, y: 40, width: 200, height: 100, url: "https://b.example" },
			{ id: "g", type: "group", x: 0, y: 0, width: 600, height: 300, label: "Group" },
		],
		edges: [{ id: "e1", fromNode: "a", toNode: "b" }],
	};
}

describe("CanvasRenderer groups", () => {
	/** Wrappers in DOM order, paired with the card each one holds. */
	function wrapperHolding(container: HTMLElement, selector: string): HTMLElement {
		const wrappers = Array.from(
			container.querySelectorAll<HTMLElement>(".canvas-editor-node-wrapper"),
		);
		const wrapper = wrappers.find((element) => element.querySelector(selector));
		if (!wrapper) throw new Error(`no wrapper holds ${selector}`);
		return wrapper;
	}

	test("paints a group behind the cards it holds, even when the file lists it last", () => {
		const { container } = render(<CanvasRenderer data={groupedCanvas()} />);
		const zIndexOf = (selector: string) => Number(wrapperHolding(container, selector).style.zIndex);

		expect(zIndexOf(".canvas-node-group")).toBeLessThan(zIndexOf(".canvas-node-text"));
		expect(zIndexOf(".canvas-node-group")).toBeLessThan(zIndexOf(".canvas-node-link"));
	});

	test("a card inside a group is still selectable", () => {
		const { container } = render(<CanvasRenderer data={groupedCanvas()} editable />);

		fireEvent.click(pick<HTMLElement>(container, '[aria-label="Text node"]'));

		expect(pick<HTMLElement>(container, ".canvas-node-text").className).toContain(
			"canvas-node-selected",
		);
		// The click landed on the card, not the group behind it.
		expect(container.querySelectorAll(".canvas-node-selected")).toHaveLength(1);
	});

	test("dragging a group moves the members it holds by the same delta, as one undo step", () => {
		const { container } = render(<CanvasRenderer data={groupedCanvas()} editable />);
		const viewport = pick<HTMLElement>(container, ".canvas-viewport");
		const left = (selector: string) => wrapperHolding(container, selector).style.left;

		fireEvent.pointerDown(pick<HTMLElement>(container, ".canvas-node-group"), {
			button: 0,
			clientX: 10,
			clientY: 10,
			pointerId: 1,
		});
		fireEvent.pointerMove(viewport, { clientX: 60, clientY: 40, pointerId: 1 });
		fireEvent.pointerUp(viewport, { pointerId: 1 });

		expect(left(".canvas-node-group")).toBe("50px");
		expect(left(".canvas-node-text")).toBe("90px");
		expect(left(".canvas-node-link")).toBe("350px");

		// One history entry for the whole gesture: the first undo restores every
		// node it moved and spends the history.
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Undo"]'));
		expect(left(".canvas-node-group")).toBe("0px");
		expect(left(".canvas-node-text")).toBe("40px");
		expect(left(".canvas-node-link")).toBe("300px");
		expect(pick<HTMLButtonElement>(container, '[aria-label="Undo"]').disabled).toBe(true);

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Redo"]'));
		expect(left(".canvas-node-group")).toBe("50px");
		expect(left(".canvas-node-text")).toBe("90px");
	});

	test("a card dragged out of its group stops moving with it, and one dragged in joins", () => {
		const { container } = render(<CanvasRenderer data={groupedCanvas()} editable />);
		const viewport = pick<HTMLElement>(container, ".canvas-viewport");
		const left = (selector: string) => wrapperHolding(container, selector).style.left;

		// "a" leaves the group's box (0..600) for 740.
		fireEvent.pointerDown(pick<HTMLElement>(container, '[aria-label="Text node"]'), {
			button: 0,
			clientX: 0,
			clientY: 0,
			pointerId: 1,
		});
		fireEvent.pointerMove(viewport, { clientX: 700, clientY: 0, pointerId: 1 });
		fireEvent.pointerUp(viewport, { pointerId: 1 });
		expect(left(".canvas-node-text")).toBe("740px");

		// Membership is geometric, so the next group drag leaves it behind while
		// the card still inside travels with the group.
		fireEvent.pointerDown(pick<HTMLElement>(container, ".canvas-node-group"), {
			button: 0,
			clientX: 0,
			clientY: 0,
			pointerId: 2,
		});
		fireEvent.pointerMove(viewport, { clientX: 100, clientY: 0, pointerId: 2 });
		fireEvent.pointerUp(viewport, { pointerId: 2 });

		expect(left(".canvas-node-group")).toBe("100px");
		expect(left(".canvas-node-text")).toBe("740px");
		expect(left(".canvas-node-link")).toBe("400px");

		// Dragging "a" back inside re-parents it on the next render.
		fireEvent.pointerDown(pick<HTMLElement>(container, '[aria-label="Text node"]'), {
			button: 0,
			clientX: 0,
			clientY: 0,
			pointerId: 3,
		});
		fireEvent.pointerMove(viewport, { clientX: -500, clientY: 0, pointerId: 3 });
		fireEvent.pointerUp(viewport, { pointerId: 3 });
		expect(left(".canvas-node-text")).toBe("240px");

		fireEvent.pointerDown(pick<HTMLElement>(container, ".canvas-node-group"), {
			button: 0,
			clientX: 0,
			clientY: 0,
			pointerId: 4,
		});
		fireEvent.pointerMove(viewport, { clientX: 50, clientY: 0, pointerId: 4 });
		fireEvent.pointerUp(viewport, { pointerId: 4 });

		expect(left(".canvas-node-group")).toBe("150px");
		expect(left(".canvas-node-text")).toBe("290px");
	});

	test("collapsing a group hides its members and the edges wholly inside it", () => {
		const { container } = render(<CanvasRenderer data={groupedCanvas()} editable />);

		expect(container.querySelectorAll(".canvas-editor-node-wrapper")).toHaveLength(3);
		expect(container.querySelectorAll("g.canvas-edge")).toHaveLength(1);

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Collapse group Group"]'));

		expect(container.querySelector(".canvas-node-text")).toBeNull();
		expect(container.querySelector(".canvas-node-link")).toBeNull();
		expect(container.querySelectorAll(".canvas-editor-node-wrapper")).toHaveLength(1);
		// Both endpoints are hidden, so the edge goes with them.
		expect(container.querySelectorAll("g.canvas-edge")).toHaveLength(0);
		// The group stays put and its control now reads the other way.
		expect(container.querySelector(".canvas-node-group")).toBeTruthy();
		expect(pick<HTMLButtonElement>(container, '[aria-label="Expand group Group"]')).toBeTruthy();

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Expand group Group"]'));

		expect(container.querySelectorAll(".canvas-editor-node-wrapper")).toHaveLength(3);
		expect(container.querySelectorAll("g.canvas-edge")).toHaveLength(1);
		// Collapse is view state: it never entered the undo history.
		expect(pick<HTMLButtonElement>(container, '[aria-label="Undo"]').disabled).toBe(true);
	});

	test("keeps an edge whose other endpoint is still visible", () => {
		const data: CanvasData = {
			nodes: [
				{ id: "a", type: "text", x: 40, y: 40, width: 200, height: 100, text: "Alpha" },
				{ id: "b", type: "link", x: 800, y: 40, width: 200, height: 100, url: "https://b.example" },
				{ id: "g", type: "group", x: 0, y: 0, width: 600, height: 300, label: "Group" },
			],
			edges: [{ id: "e1", fromNode: "a", toNode: "b" }],
		};
		const { container } = render(<CanvasRenderer data={data} />);

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Collapse group Group"]'));

		expect(container.querySelector(".canvas-node-text")).toBeNull();
		expect(container.querySelectorAll("g.canvas-edge")).toHaveLength(1);
	});

	test("gives a group with no members no collapse control", () => {
		const data: CanvasData = {
			nodes: [
				{ id: "a", type: "text", x: 700, y: 700, width: 200, height: 100, text: "Alpha" },
				{ id: "g", type: "group", x: 0, y: 0, width: 600, height: 300, label: "Empty" },
			],
			edges: [],
		};
		const { container } = render(<CanvasRenderer data={data} />);

		expect(container.querySelector(".canvas-node-group")).toBeTruthy();
		expect(container.querySelector(".canvas-group-collapse")).toBeNull();
	});

	test("a group added after its predecessor was deleted does not inherit the collapse", () => {
		const data = groupedCanvas();
		// The id the toolbar's next group takes once this one is gone.
		data.nodes = data.nodes.map((node) => (node.id === "g" ? { ...node, id: "node-3" } : node));
		const { container } = render(<CanvasRenderer data={data} editable />);

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Collapse group Group"]'));
		fireEvent.click(pick<HTMLElement>(container, ".canvas-node-group"));
		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Delete selected"]'));
		expect(container.querySelector(".canvas-node-group")).toBeNull();

		fireEvent.click(pick<HTMLButtonElement>(container, '[aria-label="Add group"]'));

		// The new group is created at the origin, so card "a" is already inside it
		// and visible — the recycled id brought no collapse state with it.
		expect(pick<HTMLElement>(container, '[aria-label="Text node"]')).toBeTruthy();
		expect(pick<HTMLButtonElement>(container, '[aria-label="Collapse group Group"]')).toBeTruthy();
	});
});
