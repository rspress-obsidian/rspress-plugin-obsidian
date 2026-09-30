/**
 * Math rendering shared by the markdown feature (`$inline$`, `$$display$$` in
 * notes) and the canvas feature (math inside canvas text nodes).
 *
 * Two engines are available. KaTeX is the default: it is fast, small and
 * synchronous. MathJax — the engine Obsidian itself uses — is opt-in through
 * `mathEngine`, for the TeX that KaTeX does not implement.
 *
 * MathJax is loaded lazily and only when selected: it is a large package, and a
 * site that never asks for it should not pay for it. Loading happens once per
 * build, before the first formula is rendered, because the remark pass renders
 * synchronously; `prepareMathEngine` is the async half of that contract.
 *
 * Returns `null` when the engine cannot render the input, so each caller can
 * decide how to show the failure without leaking a half-built element.
 */
import katex from "katex";
// Side-effect import: Obsidian renders math with MathJax, which ships the mhchem
// extension, so `\ce{H2O}` works in notes. KaTeX's equivalent is a contrib
// module that monkey-patches the shared katex instance via `__defineMacro`; the
// package's export map exposes it as `katex/contrib/mhchem`. Importing it here
// (the single entry point for every math call site) keeps the rest of the
// package unaware of it.
import "katex/contrib/mhchem";

/** Which engine renders `$…$` and `$$…$$`. */
export type MathEngine = "katex" | "mathjax";

/** Minimal shape of the MathJax pieces this module uses. */
interface MathJaxRuntime {
	document: {
		convert: (tex: string, options: { display: boolean }) => unknown;
	};
	adaptor: { innerHTML: (node: unknown) => string; textContent: (node: unknown) => string };
	output: { styleSheet: (document: unknown) => unknown };
}

let mathJaxRuntime: MathJaxRuntime | null = null;
let mathJaxStylesheet: string | null = null;

/**
 * Load the selected engine before any formula is rendered.
 *
 * Idempotent, so the remark pass can call it on every file. Selecting MathJax
 * without the optional `mathjax-full` package installed throws with the install
 * command, rather than failing later with a module-resolution error the reader
 * cannot act on.
 */
export async function prepareMathEngine(engine: MathEngine = "katex"): Promise<void> {
	if (engine !== "mathjax" || mathJaxRuntime) return;
	try {
		// Dynamic by design: a static import would pull the whole engine into every
		// build that loads this module, including the ones using KaTeX.
		const [mathjaxModule, texModule, adaptorModule, handlerModule, chtmlModule, packagesModule] =
			await Promise.all([
				import("mathjax-full/js/mathjax.js"),
				import("mathjax-full/js/input/tex.js"),
				import("mathjax-full/js/adaptors/liteAdaptor.js"),
				import("mathjax-full/js/handlers/html.js"),
				import("mathjax-full/js/output/chtml.js"),
				import("mathjax-full/js/input/tex/AllPackages.js"),
			]);
		const { mathjax } = mathjaxModule as { mathjax: unknown };
		const { TeX } = texModule as { TeX: new (options: unknown) => unknown };
		const { liteAdaptor } = adaptorModule as {
			liteAdaptor: () => MathJaxRuntime["adaptor"] &
				Parameters<typeof handlerModule.RegisterHTMLHandler>[0];
		};
		const { RegisterHTMLHandler } = handlerModule as {
			RegisterHTMLHandler: (adaptor: unknown) => void;
		};
		const { CHTML } = chtmlModule as { CHTML: new (options?: unknown) => MathJaxRuntime["output"] };
		const { AllPackages } = packagesModule as { AllPackages: unknown[] };

		const adaptor = liteAdaptor();
		RegisterHTMLHandler(adaptor);
		const input = new TeX({ packages: AllPackages });
		const output = new CHTML();
		const document = (
			mathjax as { document: (document: string, options: unknown) => MathJaxRuntime["document"] }
		).document("", { InputJax: input, OutputJax: output });
		mathJaxRuntime = { document, adaptor, output };
		mathJaxStylesheet = null;
	} catch (error) {
		throw new Error(
			`mathEngine: "mathjax" needs the optional "mathjax-full" package. Install it with \`bun add mathjax-full\` (or your package manager's equivalent) and keep mathEngine set. Original error: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

/**
 * The CSS the selected engine needs in the page.
 *
 * KaTeX ships its stylesheet, which the plugin loads as a file. MathJax's
 * CommonHTML output is styled by a stylesheet it generates at runtime, so the
 * build emits it inline instead. Empty until {@link prepareMathEngine} has run.
 */
export function mathEngineStylesheet(engine: MathEngine = "katex"): string {
	if (engine !== "mathjax" || !mathJaxRuntime) return "";
	if (mathJaxStylesheet !== null) return mathJaxStylesheet;
	try {
		mathJaxStylesheet = mathJaxRuntime.adaptor.textContent(
			mathJaxRuntime.output.styleSheet(mathJaxRuntime.document),
		);
	} catch {
		// A stylesheet we cannot generate is not a reason to fail the build; the
		// diagrams still render, just unstyled.
		mathJaxStylesheet = "";
	}
	return mathJaxStylesheet;
}

function renderWithMathJax(tex: string, displayMode: boolean): string | null {
	if (!mathJaxRuntime) return null;
	try {
		return mathJaxRuntime.adaptor.innerHTML(
			mathJaxRuntime.document.convert(tex, { display: displayMode }),
		);
	} catch {
		return null;
	}
}

/**
 * Render one formula, or `null` when the engine cannot handle it.
 *
 * MathJax reports a broken formula inside its output (as MathJax does in a
 * browser) rather than throwing, so its result is returned as-is; KaTeX's
 * `throwOnError: false` gives the same "show the TeX, not a crash" behaviour.
 */
export function renderMathHtml(
	tex: string,
	displayMode: boolean,
	engine: MathEngine = "katex",
): string | null {
	if (engine === "mathjax") return renderWithMathJax(tex, displayMode);
	try {
		return katex.renderToString(tex, { displayMode, throwOnError: false });
	} catch {
		return null;
	}
}
