import { expect, mock, spyOn, test } from "bun:test";
import * as katexMath from "../../math-katex.js";
import { renderMarkdown } from "./markdown";
import { renderCanvasMath } from "./math-render";

// KaTeX runs with `throwOnError: false`, so no real formula makes it return
// null; one sentinel TeX string stands in for an engine failure, and every
// other formula goes to the real engine.
const { renderKatexHtml } = { ...katexMath };
const FAILING_TEX = "\\canvasTestEngineFailure";
mock.module("../../math-katex.js", () => ({
	...katexMath,
	renderKatexHtml: (tex: string, displayMode: boolean) =>
		tex === FAILING_TEX ? null : renderKatexHtml(tex, displayMode),
}));

function card(markdown: string): HTMLElement {
	const root = document.createElement("div");
	root.innerHTML = renderMarkdown(markdown);
	return root;
}

test("typesets inline and display placeholders with KaTeX", async () => {
	const root = card("energy $E = mc^2$ here\n\n$$\n\\frac{a}{b}\n$$");
	await renderCanvasMath(root);

	const inline = root.querySelector("span.canvas-math");
	expect(inline?.querySelector(".katex")).not.toBeNull();
	expect(inline?.querySelector(".katex-display")).toBeNull();
	expect(inline?.hasAttribute("data-rendered")).toBe(true);

	const display = root.querySelector("div.canvas-math-display");
	expect(display?.querySelector(".katex-display")).not.toBeNull();
	expect(display?.hasAttribute("data-rendered")).toBe(true);
});

test("marks a formula the engine cannot render and keeps its TeX", async () => {
	const root = card(`a $${FAILING_TEX}$ b`);
	await renderCanvasMath(root);

	const element = root.querySelector(".canvas-math");
	expect(element?.classList.contains("canvas-math-error")).toBe(true);
	expect(element?.textContent).toBe(FAILING_TEX);
	expect(element?.hasAttribute("data-rendered")).toBe(true);
});

test("renders each placeholder once", async () => {
	const root = card("$x$");
	await renderCanvasMath(root);
	const element = root.querySelector(".canvas-math");
	const first = element?.innerHTML;
	element?.setAttribute("data-tex", "y");
	await renderCanvasMath(root);
	expect(element?.innerHTML).toBe(first);
});

test("leaves a root without math untouched", async () => {
	const root = card("No **math** here, just $5 and `$x$`.");
	const before = root.innerHTML;
	await renderCanvasMath(root);
	expect(root.innerHTML).toBe(before);
});

test("inside a site build, formulas go in once KaTeX's stylesheet applies", async () => {
	// The canvas plugin defines these through `source.define`.
	const globals = globalThis as Record<string, unknown>;
	globals.__RSPRESS_OBSIDIAN_KATEX_STYLESHEET__ = "obsidian-katex/9.9.9/katex.min.css";
	globals.__RSPRESS_OBSIDIAN_CANVAS_BASE__ = "/docs/";
	// happy-dom would fetch (and fail) a stylesheet put in the document.
	const appended: HTMLLinkElement[] = [];
	const append = spyOn(document.head, "append").mockImplementation((...nodes) => {
		for (const node of nodes) if (node instanceof HTMLLinkElement) appended.push(node);
	});
	try {
		const root = card("energy $E = mc^2$ here");
		const typeset = renderCanvasMath(root);
		// One turn of the event loop: the KaTeX chunk has resolved by then, so
		// only the stylesheet can be holding the formula back.
		const { promise: turn, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await turn;
		expect(appended.map((link) => link.getAttribute("href"))).toEqual([
			"/docs/obsidian-katex/9.9.9/katex.min.css",
		]);
		expect(root.querySelector(".canvas-math[data-rendered]")).toBeNull();

		appended[0]?.dispatchEvent(new Event("load"));
		await typeset;
		expect(root.querySelector(".canvas-math[data-rendered] .katex")).not.toBeNull();
	} finally {
		append.mockRestore();
		delete globals.__RSPRESS_OBSIDIAN_KATEX_STYLESHEET__;
		delete globals.__RSPRESS_OBSIDIAN_CANVAS_BASE__;
	}
});
