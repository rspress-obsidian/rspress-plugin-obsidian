/**
 * Rendered diagrams are injected with `innerHTML`, so mermaid's own sanitization is
 * the only thing between a hostile note/canvas text node and the document. These tests
 * drive the real code path (`renderMermaidBlocks`) and assert the exact string handed
 * to that injection sink carries nothing executable.
 *
 * The sink is captured with a property spy because happy-dom's parser drops the
 * children of `<svg>` once a `<style>` child appears, which hides a leak from any
 * check that reads the element back. Environment note: under happy-dom mermaid's
 * strict DOMPurify pass returns an empty string where a browser returns the sanitized
 * SVG; with the previous `securityLevel: "loose"` the raw `<a href="javascript:...">`
 * anchor is injected instead and the assertions below fail.
 */

import { afterEach, expect, test } from "bun:test";
import {
	disposeMermaid,
	renderMermaidBlocks,
	retainMermaid,
	setMermaidSecurityLevel,
} from "./blocks";
import {
	MERMAID_BLOCK_CLASS,
	MERMAID_ERROR_CLASS,
	MERMAID_RENDERED_CLASS,
	MERMAID_SECURITY_ATTRIBUTE,
} from "./classes";

const HOSTILE_DIAGRAM = [
	"flowchart TD",
	"  A[Start] --> B[End]",
	'  click A "javascript:alert(1)"',
].join("\n");

// happy-dom implements no SVG layout, and mermaid measures label boxes while it lays
// a diagram out. Stub the measurement APIs so the render reaches serialization;
// nothing else in the suite reads them.
function stubSvgMeasurement(): void {
	const prototype = SVGElement.prototype as unknown as Record<string, unknown>;
	if (typeof prototype.getBBox !== "function") {
		prototype.getBBox = () => ({ x: 0, y: 0, width: 100, height: 20 });
	}
	if (typeof prototype.getComputedTextLength !== "function") {
		prototype.getComputedTextLength = () => 60;
	}
}

stubSvgMeasurement();

interface RenderedBlock {
	root: HTMLElement;
	block: HTMLElement;
	/** The exact string assigned to `block.innerHTML`. */
	injected: () => string;
}

function createBlock(code: string, spyOnSink = true, securityLevel?: string): RenderedBlock {
	const root = document.createElement("div");
	const block = document.createElement("pre");
	block.className = MERMAID_BLOCK_CLASS;
	block.setAttribute("data-code", code);
	if (securityLevel) block.setAttribute(MERMAID_SECURITY_ATTRIBUTE, securityLevel);
	root.appendChild(block);
	document.body.appendChild(root);

	let html = "";
	if (spyOnSink) {
		Object.defineProperty(block, "innerHTML", {
			configurable: true,
			get: () => html,
			set: (value: string) => {
				html = value;
			},
		});
	}

	return { root, block, injected: () => html };
}

/**
 * Yield exactly one microtask turn. happy-dom queues a MutationObserver callback
 * with `queueMicrotask` at the moment of the mutation, so a turn queued after the
 * mutation runs *behind* the callback but ahead of any render it kicks off —
 * enough to see whether the observer fired, without waiting on a timer.
 */
function nextMicrotask(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	queueMicrotask(resolve);
	return promise;
}

function isSettled(block: HTMLElement): boolean {
	return (
		block.classList.contains(MERMAID_RENDERED_CLASS) ||
		block.classList.contains(MERMAID_ERROR_CLASS)
	);
}

/** Resolve once the fire-and-forget render marks the block as rendered or errored. */
function waitForSettled(block: HTMLElement): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (isSettled(block)) {
		resolve();
		return promise;
	}
	const observer = new MutationObserver(() => {
		if (!isSettled(block)) return;
		observer.disconnect();
		resolve();
	});
	observer.observe(block, { attributes: true, attributeFilter: ["class"] });
	return promise;
}

async function render(code: string, securityLevel?: string): Promise<RenderedBlock> {
	const rendered = createBlock(code, true, securityLevel);
	const settled = waitForSettled(rendered.block);
	renderMermaidBlocks(rendered.root);
	await settled;
	return rendered;
}

afterEach(() => {
	// Detach the diagrams first, then release: the last release drops the tracked
	// set, and a block that is already gone cannot keep the observer connected.
	document.documentElement.classList.remove("dark");
	document.body.innerHTML = "";
	disposeMermaid();
	// Mermaid's configuration is global, so a level applied by one test has to be
	// dropped or the strict assertions in the others stop meaning anything.
	setMermaidSecurityLevel("strict");
});

test("injects no javascript: URL for a hostile click directive", async () => {
	const { block, injected } = await render(HOSTILE_DIAGRAM);

	expect(block.classList.contains(MERMAID_ERROR_CLASS)).toBe(false);
	expect(injected()).not.toContain("javascript:");
	expect(injected().toLowerCase()).not.toContain("<script");
	// The sanitized SVG, or nothing when the environment drops `<style>`-in-`<svg>`.
	expect(injected() === "" || injected().includes("<svg")).toBe(true);
});

test("applies a security level stamped on the placeholder", async () => {
	// The loose level hands rendering to the diagram source, so the raw anchor
	// survives — the exact behaviour the strict default exists to prevent. It is
	// only reachable from plugin configuration, never from note content.
	const { block, injected } = await render(HOSTILE_DIAGRAM, "loose");

	expect(block.classList.contains(MERMAID_ERROR_CLASS)).toBe(false);
	expect(injected()).toContain("javascript:");
});

test("re-configures the shared instance when a placeholder stamps another level", async () => {
	// Mermaid's config is global, so the second render has to re-initialize it:
	// without that, the strict stamp would render under the previous level.
	await render(HOSTILE_DIAGRAM, "loose");
	const { block, injected } = await render(HOSTILE_DIAGRAM, "strict");

	expect(block.classList.contains(MERMAID_RENDERED_CLASS)).toBe(true);
	expect(injected()).not.toContain("javascript:");
});

test("ignores an unknown stamped level", async () => {
	// An attribute that is not one of mermaid's own levels must not disable
	// sanitization: an unrecognized stamp falls back to the strict default.
	const { injected } = await render(HOSTILE_DIAGRAM, "off");

	expect(injected()).not.toContain("javascript:");
});

test("does not let a loose stamp leak into the next route's unstamped blocks", async () => {
	// Mermaid's config is global and the level outlives the page that set it. A
	// canvas board emits no stamp at all, so after a page configured `loose` the
	// next route would otherwise render its diagrams unsanitized.
	await render(HOSTILE_DIAGRAM, "loose");
	const { block, injected } = await render(HOSTILE_DIAGRAM);

	expect(block.classList.contains(MERMAID_ERROR_CLASS)).toBe(false);
	expect(injected()).not.toContain("javascript:");
});

test("does not re-render a block that already holds a diagram", () => {
	const { root, block } = createBlock(HOSTILE_DIAGRAM, false);
	const marker = '<svg class="existing"></svg>';
	block.innerHTML = marker;

	renderMermaidBlocks(root);

	expect(block.innerHTML).toBe(marker);
	expect(block.classList.contains(MERMAID_RENDERED_CLASS)).toBe(false);
});

test("keeps the theme observer alive for another consumer's diagram after a release", async () => {
	// A canvas unmounting calls `disposeMermaid`; a markdown page's diagram is still
	// in the document and must keep re-rendering on a theme change.
	const page = await render(HOSTILE_DIAGRAM);
	expect(page.block.classList.contains(MERMAID_RENDERED_CLASS)).toBe(true);

	disposeMermaid();

	document.documentElement.classList.add("dark");
	await nextMicrotask();

	// The observer resets every tracked block it still owns, dropping the rendered
	// class before the re-render completes.
	expect(page.block.classList.contains(MERMAID_RENDERED_CLASS)).toBe(false);
});

test("keeps the observer while a second holder still claims it", async () => {
	const first = await render(HOSTILE_DIAGRAM);
	const second = await render(HOSTILE_DIAGRAM);
	retainMermaid();
	retainMermaid();

	disposeMermaid();
	first.block.remove();

	document.documentElement.classList.add("dark");
	await nextMicrotask();

	expect(second.block.classList.contains(MERMAID_RENDERED_CLASS)).toBe(false);
	// The detached diagram is dropped from tracking rather than re-rendered.
	expect(first.block.classList.contains(MERMAID_RENDERED_CLASS)).toBe(true);

	disposeMermaid();
});
