// happy-dom must be registered BEFORE any testing-library import binds to globals
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (!globalThis.document) GlobalRegistrator.register();

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { MERMAID_BLOCK_CLASS } from "../../mermaid/classes";

// The graph runtime reads the path from the document; this test renders a
// panel anchored on /guide.
history.replaceState({}, "", "/guide");

const { mock } = require("bun:test");

// The renderer — and mermaid under it — is a browser-only dependency with its
// own suite (`src/mermaid/blocks.test.ts`). The boundary under test here is the
// component's own decision: whether to load the renderer at all, and which root
// it is pointed at. Mocking that module keeps this file off mermaid entirely.
const renderMermaidBlocks = mock((_root: HTMLElement) => {});
mock.module("../../mermaid/blocks", () => ({
	renderMermaidBlocks,
	disposeMermaid: () => {},
	retainMermaid: () => {},
}));

// Re-import the component under test AFTER mocks are registered.
const { default: MermaidBlocks } = await import("./MermaidBlocks");

// The scan is throttled through `requestAnimationFrame`; run the frames by hand
// so the test needs no timer and stays deterministic.
const frames: Array<() => void> = [];
let frameId = 0;
const realRequestFrame = globalThis.requestAnimationFrame;
const realCancelFrame = globalThis.cancelAnimationFrame;

beforeEach(() => {
	frames.length = 0;
	frameId = 0;
	renderMermaidBlocks.mockClear();
	globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
		frames.push(() => callback(0));
		frameId += 1;
		return frameId;
	}) as typeof requestAnimationFrame;
	globalThis.cancelAnimationFrame = ((id: number) => {
		frames[id - 1] = () => {};
	}) as typeof cancelAnimationFrame;
});

afterEach(() => {
	cleanup();
	document.body.innerHTML = "";
});

afterAll(() => {
	globalThis.requestAnimationFrame = realRequestFrame;
	globalThis.cancelAnimationFrame = realCancelFrame;
});

function addPlaceholder(): void {
	const block = document.createElement("pre");
	block.className = MERMAID_BLOCK_CLASS;
	block.setAttribute("data-code", "flowchart TD\n  A --> B");
	document.body.appendChild(block);
}

/**
 * Run every queued frame and let the awaited dynamic import land. `scan` is
 * fire-and-forget, so a mutation only becomes visible after both: the observer
 * queues a frame, the frame starts the import, the import resolves later.
 */
async function settle(): Promise<void> {
	for (let round = 0; round < 4; round += 1) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
		for (const run of frames.splice(0)) run();
	}
}

describe("MermaidBlocks", () => {
	test("loads nothing when the page carries no diagram", async () => {
		const { container } = render(<MermaidBlocks />);

		await settle();

		expect(container.firstChild).toBeNull();
		expect(renderMermaidBlocks).not.toHaveBeenCalled();
	});

	test("draws the placeholders already in the server-rendered page", async () => {
		addPlaceholder();

		render(<MermaidBlocks />);
		await settle();

		expect(renderMermaidBlocks).toHaveBeenCalledTimes(1);
		expect(renderMermaidBlocks.mock.calls[0]?.[0]).toBe(document.body);
	});

	test("picks up a placeholder committed after the first scan", async () => {
		render(<MermaidBlocks />);
		await settle();
		expect(renderMermaidBlocks).not.toHaveBeenCalled();

		// A slow route chunk can commit its diagram well after the first frame.
		addPlaceholder();
		await settle();

		expect(renderMermaidBlocks).toHaveBeenCalledTimes(1);
	});

	test("re-scans when the route changes", async () => {
		addPlaceholder();

		const view = render(<MermaidBlocks />);
		await settle();
		expect(renderMermaidBlocks).toHaveBeenCalledTimes(1);

		// The component reads the document's path, so the test moves the document.
		history.replaceState({}, "", "/guide/advanced");
		window.dispatchEvent(new PopStateEvent("popstate"));
		view.rerender(<MermaidBlocks />);
		await settle();

		expect(renderMermaidBlocks).toHaveBeenCalledTimes(2);
	});

	test("stops scanning once the page unmounts it", async () => {
		const view = render(<MermaidBlocks />);
		await settle();

		view.unmount();
		addPlaceholder();
		await settle();

		expect(renderMermaidBlocks).not.toHaveBeenCalled();
	});
});
