/** The `wikiLink` stage: every `[[link]]` and `![[embed]]` replaced by what it renders as. */
import type { PhrasingContent, Root } from "mdast";
import type { Parent } from "unist";
import { extensionOf } from "../../shared/media-exts.js";
import { renderMediaEmbed } from "../media.js";
import { parseWikiLink } from "../parse-wikilink.js";
import {
	createTextNode,
	reportPluginDiagnostic,
	SKIP_PARENT_TYPES,
} from "../remark-diagnostics.js";
import { resolveWikiLink } from "../resolve-wikilink.js";
import type { WikiLinkNode } from "../syntax.js";
import type { ParsedWikiLink } from "../types.js";
import { visit } from "../visit.js";
import { mediaContextOf, type RenderContext } from "./context.js";
import {
	createEmbedNode,
	createLinkNode,
	createUnresolvedNode,
	createWikiPickerNode,
	reportDiagnostic,
} from "./link-nodes.js";
import { pluginContext } from "./plugin-context.js";
import { renderPageEmbed } from "./transclusion.js";

/** Parse a `wikiLink` node's raw source. */
function parseWikiLinkNode(node: WikiLinkNode): ParsedWikiLink {
	const embed = node.value.startsWith("!");
	let inner = node.value.slice(embed ? 3 : 2, -2);
	// Inside a table Obsidian writes the alias pipe escaped (`[[Page\|Alias]]`),
	// and the cell it renders sees a plain `|` — so a link with no other pipe
	// takes the escaped one as its alias separator, as `page-links.ts` does.
	if (!/(?:^|[^\\])\|/.test(inner) && inner.includes("\\|")) inner = inner.replace("\\|", "|");
	return parseWikiLink(inner, node.value);
}

/** Resolve a `[[link]]` (or an embed that is not inlined) to its node. */
function renderLink(parsed: ParsedWikiLink, ctx: RenderContext): PhrasingContent {
	const resolved = resolveWikiLink(parsed, {
		currentPage: ctx.currentPage,
		index: ctx.index,
		options: ctx.resolveOptions,
	});
	if (resolved.status === "ok") {
		if (resolved.ambiguity) {
			reportDiagnostic(ctx.file, parsed.raw, resolved.ambiguity, "ambiguous-page", ctx.options);
		}
		if (!resolved.href || !resolved.label) {
			return createUnresolvedNode(parsed, "Link target has no published route.");
		}
		return parsed.isEmbed
			? createEmbedNode(resolved.href, resolved.label)
			: createLinkNode(resolved.href, resolved.label, resolved.description);
	}
	if (ctx.mode === "page" && parsed.search && resolved.candidates?.length) {
		// Obsidian opens a picker of matches for an ambiguous vault search.
		return createWikiPickerNode(parsed, resolved.candidates, ctx.siteBase);
	}
	const reason = resolved.message ?? "Unable to resolve wikilink.";
	reportDiagnostic(ctx.file, parsed.raw, reason, resolved.status, ctx.options);
	return createUnresolvedNode(parsed, reason);
}

/**
 * Render an embed that is not a plain link — media, a published canvas, or a
 * transcluded note — or `undefined` to fall back to the link form.
 */
async function renderEmbed(
	parsed: ParsedWikiLink,
	ctx: RenderContext,
): Promise<PhrasingContent | undefined> {
	const { options } = ctx;
	// A reproduced plugin's own embeds first: `![[Drawing.excalidraw]]` is a
	// picture and `![[Projects.base]]` a view, whatever the media settings.
	for (const feature of ctx.features) {
		const rendered = await feature.renderEmbed?.(parsed, pluginContext(feature, ctx));
		if (rendered) return rendered;
	}
	if (options.enableMediaEmbeds) {
		const media = renderMediaEmbed(parsed, mediaContextOf(ctx), (message) =>
			reportPluginDiagnostic(ctx.file, "media", message),
		);
		if (media) return media;
	}

	const ext = extensionOf(parsed.target);
	if (ext === "canvas") {
		const resolved = resolveWikiLink(parsed, {
			currentPage: ctx.currentPage,
			index: ctx.index,
			options: ctx.resolveOptions,
		});
		// No canvas route: the board is not published (canvas feature off, or
		// excluded from its scan); an attachment is never inlined.
		if (resolved.status !== "ok" || resolved.canvasSrc === undefined) return undefined;
		if (!options.enableMediaEmbeds || ctx.mode !== "page") {
			// Media embeds are off, or this board sits inside an embed or a title,
			// which are stringified to HTML where a JSX node would vanish.
			return createEmbedNode(resolved.href ?? "", resolved.label ?? parsed.target);
		}
		// `fileRoutePrefix` points the board's file cards at the vault pages this
		// same plugin publishes.
		const attributes = [{ type: "mdxJsxAttribute", name: "src", value: resolved.canvasSrc }];
		if (options.vaultRoutePrefix) {
			attributes.push({
				type: "mdxJsxAttribute",
				name: "fileRoutePrefix",
				value: options.vaultRoutePrefix,
			});
		}
		return {
			type: "mdxJsxFlowElement",
			name: "CanvasEmbed",
			attributes,
			children: [],
		} as unknown as PhrasingContent;
	}

	if (!options.enableTransclusion) return undefined;
	const resolved = resolveWikiLink(parsed, {
		currentPage: ctx.currentPage,
		index: ctx.index,
		options: ctx.resolveOptions,
	});
	if (resolved.status !== "ok" || !resolved.targetPage) return undefined;
	if (resolved.ambiguity) {
		reportDiagnostic(ctx.file, parsed.raw, resolved.ambiguity, "ambiguous-page", options);
	}
	return renderPageEmbed(parsed, resolved, ctx);
}

/** Replace every `wikiLink` node with what it renders as. */
export async function processWikiLinks(tree: Root, ctx: RenderContext): Promise<void> {
	const work: { node: WikiLinkNode; parent: Parent & { children: PhrasingContent[] } }[] = [];
	visit(tree, "wikiLink", (node, index, parent) => {
		if (!parent || typeof index !== "number") return;
		if (SKIP_PARENT_TYPES[parent.type]) {
			// Inside a markdown link's text the brackets are the author's words.
			(parent as Parent & { children: PhrasingContent[] }).children.splice(
				index,
				1,
				createTextNode(node.value),
			);
			return;
		}
		work.push({ node, parent: parent as Parent & { children: PhrasingContent[] } });
	});

	for (const { node, parent } of work) {
		const parsed = parseWikiLinkNode(node);
		const replacement =
			(parsed.isEmbed ? await renderEmbed(parsed, ctx) : undefined) ?? renderLink(parsed, ctx);
		const position = parent.children.indexOf(node);
		if (position >= 0) parent.children.splice(position, 1, replacement);
	}
}
