/**
 * Render-cost and lifecycle contract of the renderer. Both heavy modules it calls —
 * markdown parsing and mermaid injection — are replaced with counting wrappers so a
 * test can assert *how often* the renderer does that work; the markdown wrapper still
 * delegates to the real implementation. It lives in its own file because
 * `mock.module` applies for the whole run: the other component tests keep exercising
 * the real modules unwrapped.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { CanvasData, CanvasFileData } from "../types";
import type { MarkdownOptions } from "../utils/markdown";

const parsed: string[] = [];
// The dynamic imports below are load-order requirements, not runtime selection:
// `mock.module` only affects imports that happen after it registers, so the module
// under test cannot be imported statically. The module's own values are snapshotted
// before the replacement — reading them lazily through the namespace would read the
// replacement and recurse.
const markdown = { ...(await import("../utils/markdown")) };
mock.module("../utils/markdown", () => ({
	...markdown,
	renderMarkdown: (source: string, options?: MarkdownOptions) => {
		parsed.push(source);
		return markdown.renderMarkdown(source, options);
	},
}));

const mermaid = { scans: 0, retained: 0, released: 0 };
mock.module("../../mermaid/blocks", () => ({
	renderMermaidBlocks: () => {
		mermaid.scans += 1;
		return 0;
	},
	retainMermaid: () => {
		mermaid.retained += 1;
	},
	disposeMermaid: () => {
		mermaid.released += 1;
	},
}));

const { CanvasRenderer } = await import("./CanvasRenderer");
const { CanvasNodeComponent } = await import("./CanvasNode");

afterEach(() => {
	cleanup();
	parsed.length = 0;
	mermaid.scans = 0;
	mermaid.retained = 0;
	mermaid.released = 0;
});

function board(): CanvasData {
	return {
		nodes: [
			{ id: "a", type: "text", x: 0, y: 0, width: 200, height: 100, text: "Alpha" },
			{
				id: "b",
				type: "file",
				x: 300,
				y: 0,
				width: 200,
				height: 100,
				file: "Note.md",
				fileContent: "# Beta",
			},
		],
		edges: [],
		assets: { "note.md": "/note.md" },
		notes: { "note.md": "body" },
	};
}

function pick<T extends Element>(container: HTMLElement, selector: string): T {
	const element = container.querySelector(selector);
	if (!element) throw new Error(`no element matched ${selector}`);
	return element as unknown as T;
}

test("a drag re-parses no card's markdown", () => {
	const { container } = render(<CanvasRenderer data={board()} editable />);
	expect(parsed).toEqual(["Alpha", "# Beta"]);

	const viewport = pick<HTMLElement>(container, ".canvas-viewport");
	const wrapper = pick<HTMLElement>(container, ".canvas-editor-node-wrapper");

	fireEvent.pointerDown(wrapper, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
	fireEvent.pointerMove(viewport, { clientX: 60, clientY: 40, pointerId: 1 });
	fireEvent.pointerMove(viewport, { clientX: 120, clientY: 90, pointerId: 1 });
	expect(wrapper.style.left).toBe("120px");

	// The dragged card moved and the other one was untouched. Neither re-parsed:
	// a drag patches a single node object and leaves assets/notes/edges alone.
	expect(parsed).toEqual(["Alpha", "# Beta"]);
});

test("reuses a file card's markdown while its node, assets and notes are unchanged", () => {
	const assets = { "note.md": "/note.md" };
	const notes = { "note.md": "body" };
	const node: CanvasFileData = {
		id: "f",
		type: "file",
		x: 0,
		y: 0,
		width: 200,
		height: 100,
		file: "Note.md",
		fileContent: "# Hello",
	};

	const { rerender } = render(<CanvasNodeComponent node={node} assets={assets} notes={notes} />);
	expect(parsed).toEqual(["# Hello"]);

	// A fresh node object with the same content, as a drag or a selection commit
	// produces: the memo, not just the props comparison, has to hold.
	rerender(<CanvasNodeComponent node={{ ...node }} assets={assets} notes={notes} />);
	expect(parsed).toEqual(["# Hello"]);
});

test("scans for mermaid diagrams on mount and when a card's markdown changes", () => {
	const { container } = render(<CanvasRenderer data={board()} editable />);
	expect(mermaid.scans).toBe(1);

	const viewport = pick<HTMLElement>(container, ".canvas-viewport");
	const wrapper = pick<HTMLElement>(container, ".canvas-editor-node-wrapper");
	fireEvent.pointerDown(wrapper, { button: 0, clientX: 0, clientY: 0, pointerId: 2 });
	fireEvent.pointerMove(viewport, { clientX: 60, clientY: 40, pointerId: 2 });
	fireEvent.pointerUp(wrapper, { pointerId: 2 });
	fireEvent.mouseEnter(pick<HTMLElement>(container, '[aria-label="Text node"]'));

	// Coordinates and highlight state do not change any rendered markdown, so the
	// diagrams already in the DOM are left alone.
	expect(mermaid.scans).toBe(1);

	fireEvent.doubleClick(wrapper);
	const textarea = pick<HTMLTextAreaElement>(container, ".canvas-editor-textarea");
	fireEvent.change(textarea, { target: { value: "Edited text" } });
	fireEvent.focusOut(textarea);

	// The edit rewrote that card's HTML, so the diagrams have to be re-injected.
	expect(mermaid.scans).toBe(2);
});

test("claims the shared mermaid observer on mount and releases it on unmount", () => {
	const { unmount } = render(<CanvasRenderer data={board()} />);
	expect(mermaid).toMatchObject({ retained: 1, released: 0 });

	unmount();

	expect(mermaid).toMatchObject({ retained: 1, released: 1 });
});
