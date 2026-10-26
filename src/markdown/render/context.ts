/**
 * The document being rendered, as every stage of the remark pass sees it, and
 * the small helpers that derive from it.
 */
import type { Root } from "mdast";
import type { VFile } from "vfile";
import { blankCommentRanges, findCommentRanges } from "../comments.js";
import type { MediaContext } from "../media.js";
import type { ObsidianPluginFeature } from "../obsidian-plugins/types.js";
import type {
	ContentIndex,
	ContentPage,
	NormalizedPluginOptions,
	ParsedWikiLink,
	ResolveContext,
} from "../types.js";

/**
 * Rspress's record of the page being compiled (`processor.data().pageMeta`).
 * Its `title` is what the browser title reads, and a non-empty one stops
 * Rspress drawing a fallback `# title` heading. Rspress fills it from the
 * source's first `# heading` before this pass runs, so a heading a feature
 * renders, or a template fills in, is invisible to it unless set here.
 */
export interface RspressPageMeta {
	title: string;
	frontmatter?: { title?: unknown };
}

/** Everything a stage needs about the document being rendered. */
export interface RenderContext {
	file: VFile;
	options: NormalizedPluginOptions;
	/** The markdown the tree was parsed from (positions index into it). */
	source: string;
	/** `source` with `%%comments%%` blanked — same length, same offsets. */
	cleanSource: string;
	/** Resolver options, built once per compiled file and shared by every nested document. */
	resolveOptions: NonNullable<ResolveContext["options"]>;
	currentPage: ContentPage;
	/** Whether `currentPage` is an indexed page (not a generated one). */
	indexed: boolean;
	index: ContentIndex;
	docsRoot: string;
	currentFilePath: string;
	getDocsRoot: (filePath?: string) => string;
	getContentIndex?: (filePath: string) => Promise<ContentIndex>;
	getPublishedIndexes?: () => Promise<readonly ContentIndex[]>;
	siteBase: string;
	/** `page` is the compiled file, `embed` a transcluded note, `fragment` a callout title. */
	mode: "page" | "embed" | "fragment";
	/** The tree is a whole note: the compiled page, or an embed with no `#subpath`. */
	wholeNote: boolean;
	/** The reproduced Obsidian plugins this site enabled. */
	features: readonly ObsidianPluginFeature[];
	depth: number;
	/** `path#subpath` of every embed on the stack, the page itself included. */
	visited: ReadonlySet<string>;
	/** Prefix for every id the document emits. */
	idPrefix: string;
	/** For an embed: the ids its source page gives its headings, in order. */
	headingIds?: readonly string[];
	embedCounter: { value: number };
	/** Disk answers for the compiled page, shared by its nested documents (see `MediaContext`). */
	fileChecks: Map<string, boolean>;
	/** Page mode inside Rspress: the page's title record. */
	pageMeta?: RspressPageMeta;
	/** Page mode inside the `markdown()` plugin: where KaTeX's stylesheet is served. */
	katexStylesheetHref?: string;
	/**
	 * Runs every stage over a tree (`transformContent` in `transform.ts`).
	 * Carried here so the stages that render a nested document — an embed, a
	 * callout title, a block a feature produced — run the same stages without
	 * importing the module that imports them.
	 */
	transform: (tree: Root, ctx: RenderContext) => Promise<void>;
}

export function mediaContextOf(ctx: RenderContext): MediaContext {
	return {
		docsRoot: ctx.docsRoot,
		currentFilePath: ctx.currentFilePath,
		index: ctx.index,
		enableCaseInsensitiveLookup: ctx.options.enableCaseInsensitiveLookup,
		siteBase: ctx.siteBase,
		embedMedia: ctx.options.enableMediaEmbeds,
		fileChecks: ctx.fileChecks,
	};
}

export function blankComments(source: string): string {
	return source.includes("%%") ? blankCommentRanges(source, findCommentRanges(source)) : source;
}

/** The visited-stack key of an embed: the page plus the section it names. */
export function embedKey(absolutePath: string, parsed?: ParsedWikiLink): string {
	const subpath = parsed?.subpath;
	return `${absolutePath}#${subpath ? `${subpath.kind}:${subpath.value.toLowerCase()}` : ""}`;
}

/** `ctx` re-pointed at another note: its index, its root, its file. */
export async function contextForPage(
	page: ContentPage,
	ctx: RenderContext,
): Promise<RenderContext> {
	if (page === ctx.currentPage) return ctx;
	const index = ctx.getContentIndex ? await ctx.getContentIndex(page.absolutePath) : ctx.index;
	return {
		...ctx,
		currentPage: page,
		indexed: index.byAbsolutePath.get(page.absolutePath) === page,
		index,
		docsRoot: ctx.getDocsRoot(page.absolutePath),
		currentFilePath: page.absolutePath,
	};
}
