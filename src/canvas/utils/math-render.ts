/**
 * Typeset the math placeholders `renderMarkdown` emits for canvas cards.
 *
 * The card renderer only marks formulas up; KaTeX and its mhchem extension
 * are a large chunk, so they load through a dynamic import, and only on a
 * board that actually holds math.
 */
export async function renderCanvasMath(root: ParentNode): Promise<void> {
	const pending = root.querySelectorAll<HTMLElement>(".canvas-math[data-tex]:not([data-rendered])");
	if (pending.length === 0) return;
	// KaTeX only: the MathJax half of `math.ts` imports an optional peer the
	// browser bundle must never try to resolve.
	const { renderKatexHtml } = await import("../../math-katex.js");
	for (const element of pending) {
		// Another call may have typeset this one while the chunk loaded.
		if (element.hasAttribute("data-rendered")) continue;
		const tex = element.getAttribute("data-tex") ?? "";
		const html = renderKatexHtml(tex, element.getAttribute("data-display") === "true");
		if (html === null) {
			element.classList.add("canvas-math-error");
			element.textContent = tex;
		} else {
			element.innerHTML = html;
		}
		element.setAttribute("data-rendered", "");
	}
}
