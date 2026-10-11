/**
 * KaTeX rendering, on its own so browser bundles (canvas cards) can typeset
 * math without pulling in the MathJax half of `math.ts`, whose optional-peer
 * imports a bundler would try — and fail — to resolve.
 */
import katex from "katex";
// Side-effect import: Obsidian renders math with MathJax, which ships the mhchem
// extension, so `\ce{H2O}` works in notes. KaTeX's equivalent is a contrib
// module that monkey-patches the shared katex instance via `__defineMacro`; the
// package's export map exposes it as `katex/contrib/mhchem`. Importing it here
// (the single entry point for every KaTeX call) keeps the rest of the package
// unaware of it.
import "katex/contrib/mhchem";

/**
 * Render one formula with KaTeX, or `null` when KaTeX rejects it outright.
 * `throwOnError: false` makes an ordinary TeX error render as KaTeX's own
 * inline error, so a broken formula shows its source rather than crashing.
 */
export function renderKatexHtml(tex: string, displayMode: boolean): string | null {
	try {
		return katex.renderToString(tex, { displayMode, throwOnError: false });
	} catch {
		return null;
	}
}
