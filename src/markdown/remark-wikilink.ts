/**
 * The remark pass: Obsidian semantics for one compiled page.
 *
 * Syntax is recognised by the tokenizer (`syntax.ts`, registered by the
 * attacher below), so the stages work on typed nodes — `wikiLink`,
 * `highlight`, `math`/`inlineMath`, `footnoteReference` — and never re-read
 * syntax out of text. `transformContent` (`render/transform.ts`) is the
 * documented stage order; a transcluded note and a callout title run the same
 * stages, so a construct renders the same wherever it is written.
 */
import type { Root } from "mdast";
import type { VFile } from "vfile";
import { getCachedContentIndex } from "./content-index.js";
import { enabledPluginFeatures } from "./obsidian-plugins/index.js";
import {
	failPendingDiagnostics,
	hasPendingDiagnostics,
	isFatalVFileMessage,
	reportPluginDiagnostic,
} from "./remark-diagnostics.js";
import { blankComments, embedKey, type RspressPageMeta } from "./render/context.js";
import { generatedPageFor } from "./render/page.js";
import { transformContent } from "./render/transform.js";
import { registerObsidianSyntax } from "./syntax.js";
import type { RemarkPluginFactory, RemarkWikiLinkPluginOptions } from "./types.js";
import { normalizeFsPath, pathUnderRoot } from "./utils.js";

function isRspressPageMeta(value: unknown): value is RspressPageMeta {
	return (
		typeof value === "object" &&
		value !== null &&
		"title" in value &&
		typeof value.title === "string"
	);
}

function getCurrentFilePath(file: VFile): string | undefined {
	const pathFromFile = typeof file.path === "string" ? file.path : file.history.at(-1);
	return pathFromFile ? normalizeFsPath(pathFromFile) : undefined;
}

/**
 * The remark plugin. A function attacher: it registers the Obsidian syntax
 * extensions on the processor (`this`) the way `remark-gfm` does, then returns
 * the transformer.
 */
export const remarkWikilink: RemarkPluginFactory<RemarkWikiLinkPluginOptions> = function (
	pluginOptions,
) {
	// `this` is absent only when the attacher is called by hand rather than
	// through `.use()`; such a caller parses the tree itself.
	if (this) registerObsidianSyntax(this, { enableMath: pluginOptions.options.enableMath });
	return async (tree: Root, file: VFile): Promise<void> => {
		try {
			const meta: unknown = this ? Reflect.get(this.data(), "pageMeta") : undefined;
			await renderPage(tree, file, pluginOptions, isRspressPageMeta(meta) ? meta : undefined);
		} catch (error) {
			// A fatal VFileMessage (raised by file.fail for error-mode broken or
			// ambiguous links, or a math engine that cannot load) must propagate
			// so the build actually fails.
			if (isFatalVFileMessage(error)) throw error;
			// Anything else is a fault this plugin did not anticipate. It is a
			// warning with the error attached (stack included) — unless the page
			// already collected error-mode diagnostics before it, which must still
			// fail the build; the failure then lists the unexpected error too.
			reportPluginDiagnostic(
				file,
				"",
				`Unexpected error processing ${file.path ?? "unknown file"}: ${error instanceof Error ? error.message : String(error)}`,
				hasPendingDiagnostics(file) ? "defer" : "warn",
				error,
			);
			failPendingDiagnostics(file);
		}
	};
};

async function renderPage(
	tree: Root,
	file: VFile,
	{
		getDocsRoot,
		getContentIndex,
		getPublishedIndexes,
		getSiteBase,
		getKatexStylesheetHref,
		getCanvasBoards,
		options,
	}: RemarkWikiLinkPluginOptions,
	pageMeta: RspressPageMeta | undefined,
): Promise<void> {
	const compiledPath = getCurrentFilePath(file);
	const docsRoot = getDocsRoot(compiledPath);
	// The index spells paths under the root as configured; Rspress hands over
	// the real path, which differs when the root runs through a symlink.
	const currentFilePath = compiledPath && (pathUnderRoot(compiledPath, docsRoot) ?? compiledPath);
	const index =
		getContentIndex && currentFilePath
			? await getContentIndex(currentFilePath)
			: await getCachedContentIndex(docsRoot);
	if (!currentFilePath) return;

	const source = String(file);
	const indexedPage = index.byAbsolutePath.get(currentFilePath);
	// A page this plugin generated is absent from the index by design (see
	// `generatedPageFor`); a file *inside* a content root that the index does
	// not know is a real problem and keeps its warning.
	const currentPage = indexedPage ?? generatedPageFor(currentFilePath, docsRoot, source);
	if (!currentPage) {
		reportPluginDiagnostic(
			file,
			"",
			`File "${currentFilePath}" not found in content index — wikilink processing skipped.`,
		);
		return;
	}

	await transformContent(tree, {
		file,
		options,
		source,
		cleanSource: blankComments(source),
		resolveOptions: {
			enableFuzzyMatching: options.enableFuzzyMatching,
			enableCaseInsensitiveLookup: options.enableCaseInsensitiveLookup,
			canvasBoards: await getCanvasBoards?.(),
		},
		currentPage,
		indexed: indexedPage !== undefined,
		index,
		docsRoot,
		currentFilePath,
		getDocsRoot,
		getContentIndex,
		getPublishedIndexes,
		siteBase: getSiteBase?.() ?? "/",
		mode: "page",
		wholeNote: true,
		features: enabledPluginFeatures(options),
		depth: 0,
		visited: new Set([embedKey(currentPage.absolutePath)]),
		idPrefix: "",
		embedCounter: { value: 0 },
		fileChecks: new Map(),
		pageMeta,
		katexStylesheetHref: getKatexStylesheetHref?.(),
		transform: transformContent,
	});
}
