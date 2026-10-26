/**
 * The stage order of the remark pass, shared by the compiled page, a
 * transcluded note, a callout title and a block a feature rendered, so a
 * construct renders the same wherever it is written.
 */
import type { Root } from "mdast";
import { prepareMathEngine } from "../../math.js";
import { processCallouts, restoreHijackedCallouts } from "../callouts.js";
import { stripComments } from "../comments.js";
import { processFootnotes } from "../footnotes.js";
import {
	applySoftLineBreaks,
	assignHeadingIds,
	cleanupParagraphs,
	emitBlockAnchors,
	liftTextWikilinks,
	normalizeLineEndingsInTree,
	processCommentValues,
	processMath,
	processTagLinks,
	processTaskStatuses,
} from "../inline-passes.js";
import { processMarkdownImages } from "../media.js";
import { processDailyNoteNodes, processDataviewNodes } from "../remark-dataview.js";
import { failPendingDiagnostics, reportPluginDiagnostic } from "../remark-diagnostics.js";
import { isPathInsideRoot } from "../utils.js";
import { mediaContextOf, type RenderContext } from "./context.js";
import { processMermaidNodes, processPluginFences } from "./fences.js";
import { renderInlineHtml } from "./html.js";
import { reportDiagnostic } from "./link-nodes.js";
import { processMarkdownEmbeds, processMarkdownLinks } from "./markdown-links.js";
import { decorateCompiledPage } from "./page.js";
import { pluginContext } from "./plugin-context.js";
import { processWikiLinks } from "./wikilinks.js";

/** Whether single newlines render as `<br>` on this page (`strictLineBreaks`). */
function usesSoftLineBreaks(ctx: RenderContext): boolean {
	const setting = ctx.options.strictLineBreaks;
	if (setting !== undefined) return !setting;
	return Boolean(
		ctx.options.vaultRoot && isPathInsideRoot(ctx.currentPage.absolutePath, ctx.options.vaultRoot),
	);
}

/**
 * The stages, in order. Order matters only where a stage creates nodes a later
 * one must treat specially:
 *
 * - callouts first: their content is rebuilt from source, and every later
 *   stage then treats it like the rest of the document;
 * - comments before anything reads text, so a commented construct never runs;
 * - heading ids before inline rendering, from the heading's source;
 * - footnotes before links and math, because the footnote list is made of the
 *   definitions' own nodes and must be rendered by those stages too;
 * - links, embeds and math after tags, so a label or a formula is never read
 *   as a tag (the link text sits inside a `link`, which tag linking skips).
 */
export async function transformContent(tree: Root, ctx: RenderContext): Promise<void> {
	const { file, options, currentPage, index } = ctx;
	const decoratePage = ctx.mode === "page" && ctx.indexed;

	// A note a plugin owns whole (a Kanban board, an Excalidraw drawing) is
	// replaced first; every later stage then treats the replacement like any
	// other content.
	if (ctx.wholeNote && ctx.mode !== "fragment") {
		for (const feature of ctx.features) {
			const replacement = await feature.renderNote?.(tree, pluginContext(feature, ctx));
			if (!replacement) continue;
			// The MDX imports stay whatever the plugin returns: Rspress adds one per
			// global component, and the pass may emit those components on any page
			// (the KaTeX stylesheet link on a board whose cards show math).
			const imports = tree.children.filter(
				(node) => (node.type as string) === "mdxjsEsm" && !replacement.includes(node),
			);
			tree.children = [...imports, ...replacement];
			break;
		}
	}

	if (options.enableDailyNotes && ctx.mode !== "fragment") {
		const templater = ctx.features.find((feature) => feature.expandTemplate);
		await processDailyNoteNodes(
			tree,
			currentPage,
			index,
			options,
			decoratePage,
			ctx.docsRoot,
			ctx.source,
			{
				expandTemplate: templater
					? (template) =>
							templater.expandTemplate?.(template, pluginContext(templater, ctx)) ??
							Promise.resolve(template)
					: undefined,
			},
		);
	}
	liftTextWikilinks(tree);

	if (options.enableCallouts && ctx.mode !== "fragment") {
		restoreHijackedCallouts(tree, ctx.cleanSource, options.enableMath);
		await processCallouts(tree, ctx.cleanSource, options.enableMath, (title) =>
			renderInlineHtml(title, ctx),
		);
	}

	stripComments(tree, ctx.source);
	processCommentValues(tree);

	if (ctx.mode !== "fragment") {
		// Once comments are gone, so a commented-out command never runs.
		for (const feature of ctx.features) {
			await feature.transformTree?.(tree, pluginContext(feature, ctx));
		}
		// After callouts, whose bodies are rebuilt from source, and after
		// comments, so a commented-out query is neither run nor reported.
		if (options.enableDataview) processDataviewNodes(tree, currentPage, index, file, options);
		// After the Dataview pass, so a rendered `dataview` fence is no longer a
		// code node and only fences this plugin truly cannot run are reported.
		await processPluginFences(tree, ctx);
		if (options.enableMermaid) processMermaidNodes(tree, options);
	}

	if (ctx.mode !== "fragment") {
		assignHeadingIds(tree, ctx.cleanSource, ctx.idPrefix, ctx.headingIds);
		processFootnotes(tree, { file, idPrefix: ctx.idPrefix, enableMath: options.enableMath });
	}
	if (options.enableTagLinking) processTagLinks(tree);

	await processWikiLinks(tree, ctx);
	if (options.enableMarkdownLinks) await processMarkdownEmbeds(tree, ctx);
	processMarkdownImages(tree, mediaContextOf(ctx), (raw, message) =>
		reportDiagnostic(file, raw, message, "broken-page", options),
	);
	if (options.enableMarkdownLinks) processMarkdownLinks(tree, ctx);

	let formulas = 0;
	if (options.enableMath) {
		// The engine has to be loaded before the first formula is rendered, and
		// rendering itself is synchronous. A MathJax install that is missing or
		// broken fails the build rather than shipping the page without math.
		try {
			await prepareMathEngine(options.mathEngine);
		} catch (error) {
			reportPluginDiagnostic(
				file,
				"math",
				error instanceof Error ? error.message : String(error),
				"fail",
				error,
			);
		}
		// Only the page's own tree reaches the MDX compiler as a tree; an embed
		// or fragment is serialized to an HTML string first, which has no
		// representation for a JSX element.
		formulas = processMath(tree, options.mathEngine, { jsx: ctx.mode === "page" });
	}

	if (ctx.mode !== "fragment") {
		emitBlockAnchors(
			tree,
			currentPage.blocks.map((block) => block.id),
			ctx.idPrefix,
		);
	}
	processTaskStatuses(tree);
	if (usesSoftLineBreaks(ctx)) applySoftLineBreaks(tree);
	cleanupParagraphs(tree);

	if (ctx.mode === "page") {
		// Only the top-level pass may fail the file: a broken link must not abort
		// resolution of the remaining wikilinks, so failure is raised once.
		failPendingDiagnostics(file);
		await decorateCompiledPage(tree, ctx, formulas);
	}

	// Last, and at every depth: values rebuilt from source slices during the pass
	// are CRLF on a Windows-authored vault.
	normalizeLineEndingsInTree(tree);
}
