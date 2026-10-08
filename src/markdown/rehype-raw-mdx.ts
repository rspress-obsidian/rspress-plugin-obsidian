import type { Element, Root } from "hast";
import rehypeRaw from "rehype-raw";
import { EXIT, visit } from "unist-util-visit";
import type { VFile } from "vfile";
import { withSiteBase } from "./media.js";

// The MDX node types `hast-util-raw` must pass through untouched — the list
// `@mdx-js/mdx` exports as `nodeTypes`, which Rspress hands to its own
// `rehype-raw` for `.md` pages.
const MDX_NODE_TYPES = [
	"mdxFlowExpression",
	"mdxJsxFlowElement",
	"mdxJsxTextElement",
	"mdxTextExpression",
	"mdxjsEsm",
];

/** Elements whose `src` Rspress never rewrites for the site `base`. */
const MEDIA_ELEMENTS: Record<string, true> = {
	audio: true,
	video: true,
	source: true,
	track: true,
	iframe: true,
	embed: true,
};

export interface RehypeRawForMdxOptions {
	/** The site `base`, `/…/`. */
	getSiteBase?: () => string;
}

/**
 * Parse the raw HTML the remark pass emits, on pages Rspress compiles as MDX,
 * and give raw media elements the site `base`.
 *
 * Obsidian constructs (footnotes, callouts, unresolved links, embeds) leave the
 * remark pass as `html` nodes. Rspress adds `rehype-raw` only for `.md` files,
 * so on an `.mdx` page — and on every `addPages` page, which Rspress compiles as
 * `temp-NN.mdx` — they reach the MDX compiler as hast `raw` nodes and the build
 * fails with "Cannot handle unknown node `raw`". A page with no `raw` node is
 * left exactly as Rspress produced it.
 *
 * Rspress prefixes the base on the links and images it renders, but a raw
 * `<audio>`, `<video>`, `<source>` or `<iframe>` — written in a note or emitted
 * for an embed — keeps a root-relative `src` that 404s under a `base`. This
 * runs after Rspress's own `rehype-raw` on `.md` pages, so both kinds of page
 * are covered.
 */
export function rehypeRawForMdx(options: RehypeRawForMdxOptions = {}) {
	const parseRaw = rehypeRaw({ passThrough: MDX_NODE_TYPES });
	return (tree: Root, file: VFile): Root => {
		let hasRaw = false;
		visit(tree, "raw", () => {
			hasRaw = true;
			return EXIT;
		});
		const parsed = hasRaw ? (parseRaw(tree, file) as Root) : tree;
		const base = options.getSiteBase?.() ?? "/";
		if (base !== "/") {
			visit(parsed, "element", (node: Element) => {
				if (!MEDIA_ELEMENTS[node.tagName]) return;
				const src = node.properties?.src;
				if (typeof src === "string") node.properties.src = withSiteBase(src, base);
				const poster = node.properties?.poster;
				if (typeof poster === "string") node.properties.poster = withSiteBase(poster, base);
			});
		}
		return parsed;
	};
}
