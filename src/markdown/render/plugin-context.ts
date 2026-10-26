/** What a reproduced Obsidian plugin sees of the document being rendered. */
import type { ObsidianPluginFeature, PluginRenderContext } from "../obsidian-plugins/types.js";
import { reportPluginDiagnostic } from "../remark-diagnostics.js";
import { resolveWikiLink } from "../resolve-wikilink.js";
import { contextForPage, type RenderContext } from "./context.js";
import { renderBlockHtml, renderInlineHtml } from "./html.js";

/**
 * What a feature sees of the document being rendered. Rendering helpers run
 * the same stages as the page, so markdown a feature renders (a card, a task,
 * a cell) resolves links and renders tags exactly like note text.
 */
export function pluginContext(
	feature: ObsidianPluginFeature,
	ctx: RenderContext,
): PluginRenderContext {
	return {
		file: ctx.file,
		options: ctx.options,
		currentPage: ctx.currentPage,
		index: ctx.index,
		docsRoot: ctx.docsRoot,
		siteBase: ctx.siteBase,
		mode: ctx.mode === "page" ? "page" : "embed",
		wholeNote: ctx.wholeNote,
		source: ctx.cleanSource,
		idPrefix: ctx.idPrefix,
		renderInline: async (markdown, page) =>
			renderInlineHtml(markdown, page ? await contextForPage(page, ctx) : ctx),
		renderBlock: async (markdown, page) => renderBlockHtml(markdown, page ?? ctx.currentPage, ctx),
		resolve: async (parsed, page) => {
			const from = page ? await contextForPage(page, ctx) : ctx;
			return resolveWikiLink(parsed, {
				currentPage: from.currentPage,
				index: from.index,
				options: ctx.resolveOptions,
			});
		},
		indexFor: async (absolutePath) =>
			ctx.getContentIndex ? ctx.getContentIndex(absolutePath) : ctx.index,
		publishedIndexes: async () =>
			ctx.getPublishedIndexes ? ctx.getPublishedIndexes() : [ctx.index],
		report: (message, mode) =>
			reportPluginDiagnostic(
				ctx.file,
				feature.id,
				message,
				(mode ?? (ctx.options.onPluginError === "error" ? "fail" : "warn")) === "fail"
					? "defer"
					: "warn",
			),
	};
}
