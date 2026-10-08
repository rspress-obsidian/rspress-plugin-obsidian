import { describe, expect, test } from "bun:test";
import { mathEngineStylesheet, prepareMathEngine, renderMathHtml } from "./math.ts";

describe("renderMathHtml", () => {
	test("renders inline and display math to KaTeX markup", () => {
		expect(renderMathHtml("x^2", false)).toContain("katex");
		expect(renderMathHtml("x^2", true)).toContain("katex-display");
	});

	test("renders invalid TeX as KaTeX's error markup instead of throwing", () => {
		// `throwOnError: false` makes KaTeX return a red error span, which is what
		// keeps one broken formula from failing the whole page.
		const html = renderMathHtml("\\notacommand{", false);
		expect(html).toContain("katex-error");
	});

	test("renders mhchem `\\ce` chemistry through the contrib extension", () => {
		// Obsidian renders math with MathJax + mhchem, so `\ce{}` must work here
		// too. Without `katex/contrib/mhchem` KaTeX treats `\ce` as an undefined
		// macro and echoes it as red error text, so assert the real chemistry
		// layout (H with a subscripted 2) and the absence of that echo.
		const html = renderMathHtml("\\ce{H2O}", false);
		expect(html).toContain("<msub>");
		expect(html).not.toContain("<mtext>\\ce</mtext>");
	});

	test("renders mhchem `\\pu` physical units", () => {
		const html = renderMathHtml("\\pu{123 kJ//mol}", false);
		expect(html).toContain("<mfrac>"); // kJ over mol
		expect(html).not.toContain("<mtext>\\pu</mtext>");
	});

	test("returns null when KaTeX cannot render at all", () => {
		// The documented failure contract: callers branch on null to show their own
		// state, so anything KaTeX throws on must come back as null.
		expect(renderMathHtml(undefined as unknown as string, false)).toBeNull();
	});
});

describe("MathJax engine", () => {
	test("neutralises javascript: links and unsafe styles, as KaTeX's trust: false does", async () => {
		await prepareMathEngine("mathjax");
		const link = renderMathHtml("\\href{javascript:alert(1)}{x}", false, "mathjax") ?? "";
		const style =
			renderMathHtml("\\style{background:url(javascript:alert(1))}{z}", false, "mathjax") ?? "";
		expect(link).not.toContain("javascript:");
		expect(style).not.toContain("javascript:");
		expect(renderMathHtml("\\href{https://ok.dev}{x}", false, "mathjax")).toContain(
			"https://ok.dev",
		);
	});

	test("the stylesheet covers glyphs first used after an earlier page read it", async () => {
		await prepareMathEngine("mathjax");
		renderMathHtml("a", false, "mathjax");
		const before = mathEngineStylesheet("mathjax");
		renderMathHtml("\\beta", false, "mathjax");
		const after = mathEngineStylesheet("mathjax");
		// U+1D6FD is MathJax's italic beta.
		expect(before).not.toContain("mjx-c1D6FD");
		expect(after).toContain("mjx-c1D6FD");
	});
});
