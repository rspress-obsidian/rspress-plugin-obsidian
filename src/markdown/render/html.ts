/**
 * Nested documents rendered to an HTML string through every stage: a callout
 * title, a block a feature produced, and the serialisation an embed uses.
 */
import type { Element, Root as HastRoot } from "hast";
import type { Root } from "mdast";
import rehypeStringify from "rehype-stringify";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { parseObsidianMarkdown } from "../syntax.js";
import type { ContentPage } from "../types.js";
import { visit } from "../visit.js";
import { blankComments, contextForPage, type RenderContext } from "./context.js";

/** Add the `#` link Rspress gives every heading, to the headings of an embed. */
function rehypeHeadingAnchors() {
	return (tree: HastRoot): void => {
		visit(tree, "element", (node: Element) => {
			if (!/^h[1-6]$/.test(node.tagName)) return;
			const id = node.properties?.id;
			if (typeof id !== "string" || !id) return;
			node.children.unshift({
				type: "element",
				tagName: "a",
				properties: { className: ["rp-header-anchor"], ariaHidden: "true", href: `#${id}` },
				children: [{ type: "text", value: "#" }],
			});
		});
	};
}

export function treeToHtml(tree: Root, headingAnchors: boolean): string {
	const processor = unified()
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(headingAnchors ? rehypeHeadingAnchors : () => undefined)
		.use(rehypeStringify, { allowDangerousHtml: true });
	return processor.stringify(processor.runSync(tree) as HastRoot);
}

/**
 * Render one line of inline markdown — a callout title — to HTML, through the
 * same stages as the page. Raw HTML the author wrote in the title is dropped,
 * as it always has been: a title is a heading, not a place for markup.
 */
export async function renderInlineHtml(markdown: string, ctx: RenderContext): Promise<string> {
	const tree = parseObsidianMarkdown(markdown, { enableMath: ctx.options.enableMath });
	visit(tree, "html", (_node, index, parent) => {
		if (!parent || typeof index !== "number") return;
		parent.children.splice(index, 1);
		return index;
	});
	await ctx.transform(tree, {
		...ctx,
		source: markdown,
		cleanSource: blankComments(markdown),
		mode: "fragment",
		wholeNote: false,
	});
	return treeToHtml(tree, false)
		.trim()
		.replace(/^<p>/, "")
		.replace(/<\/p>$/, "")
		.trim();
}

/**
 * Render block markdown a feature produced (a Kanban card, a Tasks result, a
 * base cell) as part of `page`, through every stage. Ids are namespaced per
 * block so two rendered blocks never clash with each other or the page.
 */
export async function renderBlockHtml(
	markdown: string,
	page: ContentPage,
	ctx: RenderContext,
): Promise<string> {
	const target = await contextForPage(page, ctx);
	const tree = parseObsidianMarkdown(markdown, { enableMath: ctx.options.enableMath });
	ctx.embedCounter.value += 1;
	await ctx.transform(tree, {
		...target,
		source: markdown,
		cleanSource: blankComments(markdown),
		mode: "embed",
		wholeNote: false,
		depth: ctx.depth + 1,
		idPrefix: `${ctx.idPrefix}block-${ctx.embedCounter.value}-`,
		headingIds: undefined,
		embedCounter: { value: 0 },
	});
	return treeToHtml(tree, false);
}
