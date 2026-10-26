/**
 * What only the compiled page gets: a stand-in page for a generated file, and
 * the decorations around its body — title, backlinks, `cssclasses`, math styles.
 */
import type { Root, RootContent } from "mdast";
import { mathEngineStylesheet } from "../../math.js";
import { escapeHtmlAttribute } from "../../shared/escape.js";
import { parseFrontmatter } from "../../shared/frontmatter.js";
import { getCachedBacklinksIndex, renderBacklinksHtml } from "../backlinks.js";
import { getMentions } from "../mentions.js";
import { plainText } from "../syntax.js";
import type { ContentPage } from "../types.js";
import { isPathInsideRoot, normalizeFsPath } from "../utils.js";
import { visit } from "../visit.js";
import type { RenderContext } from "./context.js";

/**
 * A stand-in page for a file the plugin generated, or `undefined` when the file
 * is a real one that the content index should have had.
 *
 * Rspress compiles a generated page from a temp file outside every content root
 * (`node_modules/.rspress/runtime/temp-NN.mdx`), so there is no indexed page to
 * look up. The fields a generated page legitimately has — its frontmatter title,
 * its own path — are filled in, and the rest are empty, because a generated page
 * has no headings, tags, blocks or backlinks of its own.
 */
export function generatedPageFor(
	absolutePath: string,
	docsRoot: string,
	source: string,
): ContentPage | undefined {
	if (isPathInsideRoot(absolutePath, docsRoot)) return undefined;

	const relativePath = normalizeFsPath(absolutePath.replace(/\.(md|mdx)$/i, ""));
	let title: string | undefined;
	try {
		const { data } = parseFrontmatter(source);
		if (typeof data.title === "string" && data.title.trim() !== "") title = data.title;
	} catch {
		// Malformed frontmatter on a generated page: the title is a nicety here,
		// and the frontmatter pass reports the problem where it always has.
	}

	return {
		absolutePath,
		relativePath,
		routePath: `/${relativePath}`,
		pathKey: relativePath,
		filePathKey: relativePath,
		baseName: relativePath.split("/").pop() ?? relativePath,
		title,
		aliases: [],
		tags: [],
		cssclasses: [],
		publish: true,
		fileCtimeMs: 0,
		fileMtimeMs: 0,
		fileSizeBytes: 0,
		headings: [],
		wikilinkTargets: [],
		headingBySlug: new Map(),
		headingByText: new Map(),
		blocks: [],
		dataviewFields: {},
		dataviewTasks: [],
		dataviewLists: [],
	};
}

/** Text of the page's own first `# heading` as rendered, if it has one. */
function renderedPageHeading(tree: Root): string | undefined {
	for (const node of tree.children) {
		if (node.type === "heading" && node.depth === 1) return plainText(node.children).trim();
		const html = node.type === "html" ? /^\s*<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(node.value) : null;
		if (html) return (html[1] ?? "").replace(/<[^>]*>/g, "").trim();
	}
	return undefined;
}

/**
 * Give the compiled page the title Obsidian shows for the note.
 *
 * Rspress titles a page by its source's first `# heading`, and draws a
 * frontmatter `title` as the heading when the source has none. Both miss what
 * a feature or template renders: a board or drawing whose source heading is
 * plugin data, an empty daily note filled from a template, a generated page
 * that draws its own heading. On a vault note the rendered first heading is
 * the title, and a note that renders none gets its file name as its heading,
 * as Obsidian's inline title shows it. Docs-root pages keep Rspress's own
 * convention.
 */
function applyPageTitle(tree: Root, ctx: RenderContext): void {
	const meta = ctx.pageMeta;
	if (!meta) return;
	const rendered = renderedPageHeading(tree);
	const frontmatterTitle = meta.frontmatter?.title;
	if (typeof frontmatterTitle === "string" && frontmatterTitle.trim() !== "") {
		// The title is the frontmatter's; only stop Rspress drawing it a second
		// time above a heading the page already renders.
		if (rendered !== undefined) meta.title = rendered;
		return;
	}
	if (
		!ctx.indexed ||
		!ctx.options.vaultRoot ||
		!isPathInsideRoot(ctx.currentPage.absolutePath, ctx.options.vaultRoot)
	) {
		return;
	}
	meta.title = rendered ?? ctx.currentPage.baseName;
	if (rendered === undefined) {
		tree.children.unshift({
			type: "heading",
			depth: 1,
			children: [{ type: "text", value: meta.title }],
		});
	}
}

/**
 * Decorate the compiled page once its body is rendered: its title, the
 * backlinks panel and `cssclasses` wrapper of an indexed note, and the math
 * styles of a page that shows math (`formulas` is how many the page's own tree
 * rendered).
 */
export async function decorateCompiledPage(
	tree: Root,
	ctx: RenderContext,
	formulas: number,
): Promise<void> {
	const { options, currentPage, index } = ctx;
	applyPageTitle(tree, ctx);
	if (ctx.indexed && options.enableBacklinks) {
		const refs = (await getCachedBacklinksIndex(index)).get(currentPage.routePath) ?? [];
		const mentions = options.enableUnlinkedMentions
			? (getMentions(index).get(currentPage.routePath) ?? [])
			: [];
		const html = renderBacklinksHtml(refs, mentions);
		if (html) tree.children.push({ type: "html", value: html });
	}
	if (ctx.indexed && currentPage.cssclasses.length > 0) {
		const classes = currentPage.cssclasses.map(escapeHtmlAttribute).join(" ");
		tree.children.unshift({ type: "html", value: `<div class="${classes}">` });
		tree.children.push({ type: "html", value: "</div>" });
	}
	// Both engines need styles on exactly the pages that show math, the
	// page's own or an embed's: MathJax a stylesheet it generates per glyph,
	// emitted inline; KaTeX its static stylesheet, linked from the head.
	if (options.enableMath) {
		const marker = options.mathEngine === "mathjax" ? "<mjx-" : 'class="katex';
		let embedsMath = false;
		visit(tree, "html", (node) => {
			if (node.value.includes(marker)) embedsMath = true;
		});
		if (formulas > 0 || embedsMath) {
			if (options.mathEngine === "mathjax") {
				const stylesheet = mathEngineStylesheet("mathjax");
				if (stylesheet)
					tree.children.unshift({ type: "html", value: `<style>${stylesheet}</style>\n` });
			} else if (ctx.katexStylesheetHref) {
				tree.children.unshift({
					type: "mdxJsxFlowElement",
					name: "KatexStylesheet",
					attributes: [{ type: "mdxJsxAttribute", name: "href", value: ctx.katexStylesheetHref }],
					children: [],
				} as unknown as RootContent);
			}
		}
	}
}
