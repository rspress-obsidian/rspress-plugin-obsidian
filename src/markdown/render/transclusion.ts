/**
 * Note transclusion: a resolved page embed rendered inline through every
 * stage, with cycle and depth protection and a per-build render memo.
 */
import fs from "node:fs";
import type { PhrasingContent } from "mdast";
import { getContentLineFlags } from "../../shared/content-flags.js";
import { escapeHtmlAttribute } from "../../shared/escape.js";
import { stripFrontmatter } from "../../shared/frontmatter.js";
import { extractBlockSection } from "../../shared/transclusion.js";
import { type PageHeading, scanPageHeadings } from "../heading-text.js";
import { withSiteBase } from "../media.js";
import {
	createTextNode,
	isFatalVFileMessage,
	reportPluginDiagnostic,
} from "../remark-diagnostics.js";
import { resolveHeadingSlug } from "../resolve-wikilink.js";
import { parseObsidianMarkdown } from "../syntax.js";
import type { NormalizedPluginOptions, ParsedWikiLink, ResolvedWikiLink } from "../types.js";
import { blankComments, embedKey, type RenderContext } from "./context.js";
import { treeToHtml } from "./html.js";
import { createEmbedNode } from "./link-nodes.js";

const MAX_TRANSCLUSION_DEPTH = 5;

/**
 * Stands in for an embed's id prefix while its HTML is rendered and memoised.
 * The same render can be inserted into several pages (and several times into
 * one), so the concrete prefix — unique per insertion — is substituted when the
 * HTML is placed. A nested embed's prefix starts with the token, so it is
 * namespaced under its host's prefix once that is substituted in turn.
 */
const EMBED_ID_TOKEN = "\uE000embed\uE001";

/**
 * Rendered transclusion HTML, per plugin options object and build generation.
 *
 * The key is the options object itself (one per `markdown()` call), so two
 * processors in the same process never share renders; the generation counter
 * drops stale renders when a dev recompile re-indexes. Within a generation the
 * memo is keyed by target page, section, depth and visited chain — everything
 * the render depends on — so a page embedded twice in one file is read and
 * parsed once instead of once per embed.
 */
const transclusionRenders = new WeakMap<
	NormalizedPluginOptions,
	{ generation: number; renders: Map<string, string> }
>();
let transclusionGeneration = 0;

/** Drop memoized transclusion renders. Called wherever the index memo is dropped. */
export function clearTransclusionCache(): void {
	transclusionGeneration += 1;
}

function transclusionCacheFor(options: NormalizedPluginOptions): Map<string, string> {
	const cached = transclusionRenders.get(options);
	if (cached && cached.generation === transclusionGeneration) return cached.renders;
	const renders = new Map<string, string>();
	transclusionRenders.set(options, { generation: transclusionGeneration, renders });
	return renders;
}

/** A note's headings with their ids, found the way the content index finds them. */
function pageHeadings(content: string): PageHeading[] {
	const lines = content.split(/\r?\n/);
	return scanPageHeadings(blankComments(content).split(/\r?\n/), getContentLineFlags(lines));
}

/**
 * The section of a note a heading id names — from the heading to the next
 * top-level heading of the same or a higher level — and the ids of the
 * headings in it. `id` came from the index, which found headings the same way,
 * so it always names the same heading.
 */
function extractHeadingSectionById(
	content: string,
	id: string,
): { section: string; ids: string[] } | undefined {
	const lines = content.split(/\r?\n/);
	const headings = pageHeadings(content);
	const position = headings.findIndex((heading) => heading.id === id);
	const heading = headings[position];
	if (!heading) return undefined;
	const endIndex = headings.findIndex(
		(next, index) => index > position && next.topLevel && next.depth <= heading.depth,
	);
	const end = headings[endIndex];
	return {
		section: lines
			.slice(heading.line, end ? end.line : lines.length)
			.join("\n")
			.trim(),
		ids: headings.slice(position, endIndex === -1 ? undefined : endIndex).map((entry) => entry.id),
	};
}

/**
 * Render a resolved page embed — `![[Page]]`, `![[Page#Section]]`,
 * `![[#Section]]` on the same note, or the markdown form `![alt](Page.md)`.
 *
 * Cycle protection is keyed on page *and* section: a note may embed one of its
 * own sections, and only an embed already on the stack is refused. A missing
 * section renders as an embed link to the page, as Obsidian shows an unresolved
 * embed.
 */
export async function renderPageEmbed(
	parsedEmbed: ParsedWikiLink,
	resolved: ResolvedWikiLink,
	ctx: RenderContext,
): Promise<PhrasingContent> {
	const { targetPage } = resolved;
	if (!targetPage) return createTextNode(parsedEmbed.raw);
	// An embed that cannot be inlined still points at its page, as Obsidian
	// shows an unresolvable embed.
	const linkInstead = createEmbedNode(
		resolved.href ?? targetPage.routePath,
		resolved.label ?? targetPage.baseName,
	);

	const key = embedKey(targetPage.absolutePath, parsedEmbed);
	if (ctx.visited.has(key)) {
		reportPluginDiagnostic(
			ctx.file,
			"transclusion",
			`Circular transclusion detected: ${parsedEmbed.raw} in "${ctx.currentPage.relativePath}".`,
		);
		return linkInstead;
	}
	if (ctx.depth >= MAX_TRANSCLUSION_DEPTH) {
		reportPluginDiagnostic(
			ctx.file,
			"transclusion",
			`Max transclusion depth (${MAX_TRANSCLUSION_DEPTH}) reached for ${parsedEmbed.raw} in "${ctx.currentPage.relativePath}".`,
		);
		return linkInstead;
	}

	try {
		const content = await fs.promises.readFile(targetPage.absolutePath, "utf-8");
		let section: string | undefined;
		// The ids the target page gives the embedded headings, so a heading keeps
		// the id the index (and `[[Page#Heading]]`) knows, behind the prefix.
		let headingIds: readonly string[] | undefined;
		const subpath = parsedEmbed.subpath;
		if (subpath?.kind === "heading") {
			const id = resolveHeadingSlug(targetPage, subpath.value);
			const found = id === undefined ? undefined : extractHeadingSectionById(content, id);
			section = found?.section;
			headingIds = found?.ids;
		} else if (subpath?.kind === "block") {
			section = extractBlockSection(content, subpath.value);
		} else {
			section = stripFrontmatter(content);
			headingIds = pageHeadings(content).map((heading) => heading.id);
		}
		if (section === undefined) {
			const available =
				subpath?.kind === "heading"
					? targetPage.headings.map((heading) => heading.rawText)
					: targetPage.blocks.map((block) => `^${block.id}`);
			reportPluginDiagnostic(
				ctx.file,
				"transclusion",
				`${subpath?.kind === "heading" ? "Heading" : "Block"} "${subpath?.value}" not found in "${targetPage.relativePath}" for ${parsedEmbed.raw};${
					available.length > 0 ? ` available: ${available.join(", ")};` : ""
				} rendering as a link to the page.`,
			);
			return createEmbedNode(targetPage.routePath, resolved.label ?? targetPage.baseName);
		}

		const renders = transclusionCacheFor(ctx.options);
		const renderKey = [key, String(ctx.depth), [...ctx.visited].sort().join("|")].join("\u0000");
		let html = renders.get(renderKey);
		if (html === undefined) {
			const tree = parseObsidianMarkdown(section, { enableMath: ctx.options.enableMath });
			const index = ctx.getContentIndex
				? await ctx.getContentIndex(targetPage.absolutePath)
				: ctx.index;
			await ctx.transform(tree, {
				...ctx,
				source: section,
				cleanSource: blankComments(section),
				currentPage: targetPage,
				indexed: true,
				index,
				docsRoot: ctx.getDocsRoot(targetPage.absolutePath),
				currentFilePath: targetPage.absolutePath,
				mode: "embed",
				wholeNote: !subpath,
				depth: ctx.depth + 1,
				visited: new Set([...ctx.visited, key]),
				idPrefix: EMBED_ID_TOKEN,
				headingIds,
				embedCounter: { value: 0 },
			});
			html = treeToHtml(tree, true);
			renders.set(renderKey, html);
		}
		ctx.embedCounter.value += 1;
		const prefix = `${ctx.idPrefix}embed-${ctx.embedCounter.value}-`;
		// Raw HTML: Rspress rewrites no attribute here, so the route takes the
		// site base itself, like every other URL this pass emits as HTML.
		const src = withSiteBase(resolved.href ?? "", ctx.siteBase);
		return {
			type: "html",
			value: `<div class="obsidian-transclusion" data-src="${escapeHtmlAttribute(src)}">\n${html.replaceAll(EMBED_ID_TOKEN, prefix)}\n</div>`,
		};
	} catch (error) {
		// `file.fail` inside the transcluded document — a Dataview query that
		// cannot evaluate, a broken or ambiguous link — throws rather than warns,
		// so the same document fails whether it is compiled or embedded.
		if (isFatalVFileMessage(error)) throw error;
		reportPluginDiagnostic(
			ctx.file,
			"transclusion",
			`Failed to read "${targetPage.relativePath}" for ${parsedEmbed.raw}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return linkInstead;
	}
}
