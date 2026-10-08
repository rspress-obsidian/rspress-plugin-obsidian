/**
 * The remark pass: Obsidian semantics for one compiled page.
 *
 * Syntax is recognised by the tokenizer (`syntax.ts`, registered by the
 * attacher below), so this module works on typed nodes — `wikiLink`,
 * `highlight`, `math`/`inlineMath`, `footnoteReference` — and never re-reads
 * syntax out of text. {@link transformContent} is the documented stage order;
 * a transcluded note and a callout title run the same stages, so a construct
 * renders the same wherever it is written.
 */
import fs from "node:fs";
import type { Element, Root as HastRoot } from "hast";
import type { Code, Html, Image, Link, PhrasingContent, Root } from "mdast";
import rehypeStringify from "rehype-stringify";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import type { Parent } from "unist";
import { visit } from "unist-util-visit";
import type { VFile } from "vfile";
import { mathEngineStylesheet, prepareMathEngine } from "../math.js";
import { MERMAID_BLOCK_CLASS, MERMAID_SECURITY_ATTRIBUTE } from "../mermaid/classes.js";
import { getContentLineFlags } from "../shared/content-flags.js";
import { escapeHtmlAttribute, escapeHtmlText } from "../shared/escape.js";
import { parseFrontmatter, stripFrontmatter } from "../shared/frontmatter.js";
import { extensionOf } from "../shared/media-exts.js";
import { extractBlockSection } from "../shared/transclusion.js";
import { getCachedBacklinksIndex, renderBacklinksHtml } from "./backlinks.js";
import { processCallouts, restoreHijackedCallouts } from "./callouts.js";
import { blankCommentRanges, findCommentRanges, stripComments } from "./comments.js";
import { getCachedContentIndex } from "./content-index.js";
import { processFootnotes } from "./footnotes.js";
import { type PageHeading, scanPageHeadings } from "./heading-text.js";
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
} from "./inline-passes.js";
import {
	imageImports,
	type MediaContext,
	processMarkdownImages,
	renderMediaEmbed,
	withSiteBase,
} from "./media.js";
import { getMentions } from "./mentions.js";
import { disabledFenceMessage, enabledPluginFeatures } from "./obsidian-plugins/index.js";
import type { ObsidianPluginFeature, PluginRenderContext } from "./obsidian-plugins/types.js";
import { parseWikiLink } from "./parse-wikilink.js";
import { processDailyNoteNodes, processDataviewNodes } from "./remark-dataview.js";
import {
	createTextNode,
	failPendingDiagnostics,
	isFatalVFileMessage,
	reportPluginDiagnostic,
	SKIP_PARENT_TYPES,
} from "./remark-diagnostics.js";
import { resolveHeadingSlug, resolveWikiLink } from "./resolve-wikilink.js";
import {
	parseObsidianMarkdown,
	plainText,
	registerObsidianSyntax,
	type WikiLinkNode,
} from "./syntax.js";
import type {
	ContentIndex,
	ContentPage,
	NormalizedPluginOptions,
	ParsedWikiLink,
	RemarkPluginFactory,
	RemarkWikiLinkPluginOptions,
	ResolvedWikiLink,
	WikiLinkCandidate,
} from "./types.js";
import { isPathInsideRoot, normalizeFsPath, wikiLinkDisplayText } from "./utils.js";

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

/**
 * Rspress's record of the page being compiled (`processor.data().pageMeta`).
 * Its `title` is what the browser title reads, and a non-empty one stops
 * Rspress drawing a fallback `# title` heading. Rspress fills it from the
 * source's first `# heading` before this pass runs, so a heading a feature
 * renders, or a template fills in, is invisible to it unless set here.
 */
interface RspressPageMeta {
	title: string;
	frontmatter?: { title?: unknown };
}

function isRspressPageMeta(value: unknown): value is RspressPageMeta {
	return (
		typeof value === "object" &&
		value !== null &&
		"title" in value &&
		typeof value.title === "string"
	);
}

/** Everything a stage needs about the document being rendered. */
interface RenderContext {
	file: VFile;
	options: NormalizedPluginOptions;
	/** The markdown the tree was parsed from (positions index into it). */
	source: string;
	/** `source` with `%%comments%%` blanked — same length, same offsets. */
	cleanSource: string;
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
	/** Page mode inside Rspress: the page's title record. */
	pageMeta?: RspressPageMeta;
}

function resolveOptionsOf(options: NormalizedPluginOptions) {
	return {
		enableFuzzyMatching: options.enableFuzzyMatching,
		enableCaseInsensitiveLookup: options.enableCaseInsensitiveLookup,
	};
}

function mediaContextOf(ctx: RenderContext): MediaContext {
	return {
		docsRoot: ctx.docsRoot,
		currentFilePath: ctx.currentFilePath,
		index: ctx.index,
		enableCaseInsensitiveLookup: ctx.options.enableCaseInsensitiveLookup,
		siteBase: ctx.siteBase,
	};
}

function blankComments(source: string): string {
	return source.includes("%%") ? blankCommentRanges(source, findCommentRanges(source)) : source;
}

/** The visited-stack key of an embed: the page plus the section it names. */
function embedKey(absolutePath: string, parsed?: ParsedWikiLink): string {
	const subpath = parsed?.subpath;
	return `${absolutePath}#${subpath ? `${subpath.kind}:${subpath.value.toLowerCase()}` : ""}`;
}

/**
 * Turn ` ```mermaid ` fences into client-rendered placeholders.
 *
 * Mermaid needs a DOM, so the diagram is drawn by the client renderer
 * (`src/mermaid/blocks.ts`) that the markdown plugin registers as a global UI
 * component — the same placeholder contract the canvas feature uses.
 */
function processMermaidNodes(tree: Root, options: NormalizedPluginOptions): void {
	visit(tree, "code", (node) => {
		if (node.lang?.toLowerCase() !== "mermaid") return;
		// The source lands in an attribute as well as in the text, so quotes must
		// be escaped too — otherwise a diagram containing `"` breaks out of
		// `data-code` and can inject attributes.
		const htmlNode = node as unknown as Html;
		htmlNode.type = "html";
		htmlNode.value = `<pre class="${MERMAID_BLOCK_CLASS}" ${MERMAID_SECURITY_ATTRIBUTE}="${options.mermaidSecurityLevel}" data-code="${escapeHtmlAttribute(node.value)}">${escapeHtmlText(node.value)}</pre>\n`;
	});
}

/**
 * Render fenced blocks that belong to a reproduced Obsidian plugin (```tasks,
 * ```base, …) through that feature, and report the ones whose feature is off:
 * those stay code blocks (the config hook gives Shiki a plain-text fallback for
 * their unknown languages), but a reader would otherwise assume the raw query
 * syntax they see ran. `mermaid` has its own pass, and a fence in any other
 * language is the author's own code.
 */
async function processPluginFences(tree: Root, ctx: RenderContext): Promise<void> {
	const { file, options } = ctx;
	const work: { node: Code; feature: ObsidianPluginFeature }[] = [];
	visit(tree, "code", (node) => {
		const language = node.lang?.toLowerCase();
		if (!language) return;
		const feature = ctx.features.find((candidate) => candidate.fences?.includes(language));
		if (feature?.renderFence) {
			work.push({ node, feature });
			return;
		}
		const message = disabledFenceMessage(language, options);
		if (!message) return;
		reportPluginDiagnostic(
			file,
			"unsupported-block",
			`[!${language}] ${message}`,
			options.onUnsupportedBlock === "error" ? "fail" : "warn",
		);
	});
	for (const { node, feature } of work) {
		const replacement = await feature.renderFence?.(node, pluginContext(feature, ctx));
		if (!replacement) continue;
		visit(tree, "code", (candidate, index, parent) => {
			if (candidate !== node || !parent || typeof index !== "number") return;
			parent.children.splice(index, 1, ...(replacement as typeof parent.children));
			return index + replacement.length;
		});
	}
}

/**
 * What a feature sees of the document being rendered. Rendering helpers run
 * the same stages as the page, so markdown a feature renders (a card, a task,
 * a cell) resolves links and renders tags exactly like note text.
 */
function pluginContext(feature: ObsidianPluginFeature, ctx: RenderContext): PluginRenderContext {
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
				options: resolveOptionsOf(ctx.options),
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

/** `ctx` re-pointed at another note: its index, its root, its file. */
async function contextForPage(page: ContentPage, ctx: RenderContext): Promise<RenderContext> {
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

/**
 * Render block markdown a feature produced (a Kanban card, a Tasks result, a
 * base cell) as part of `page`, through every stage. Ids are namespaced per
 * block so two rendered blocks never clash with each other or the page.
 */
async function renderBlockHtml(
	markdown: string,
	page: ContentPage,
	ctx: RenderContext,
): Promise<string> {
	const target = await contextForPage(page, ctx);
	const tree = parseObsidianMarkdown(markdown, { enableMath: ctx.options.enableMath });
	ctx.embedCounter.value += 1;
	await transformContent(tree, {
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
function generatedPageFor(
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
			// ambiguous links) must propagate so the build actually fails.
			if (isFatalVFileMessage(error)) throw error;
			reportPluginDiagnostic(
				file,
				"",
				`Unexpected error processing ${file.path ?? "unknown file"}: ${error instanceof Error ? error.message : String(error)}`,
			);
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
		options,
	}: RemarkWikiLinkPluginOptions,
	pageMeta: RspressPageMeta | undefined,
): Promise<void> {
	const currentFilePath = getCurrentFilePath(file);
	const docsRoot = getDocsRoot(currentFilePath);
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
		pageMeta,
	});
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
async function transformContent(tree: Root, ctx: RenderContext): Promise<void> {
	const { file, options, currentPage, index } = ctx;
	const decoratePage = ctx.mode === "page" && ctx.indexed;

	// A note a plugin owns whole (a Kanban board, an Excalidraw drawing) is
	// replaced first; every later stage then treats the replacement like any
	// other content.
	if (ctx.wholeNote && ctx.mode !== "fragment") {
		for (const feature of ctx.features) {
			const replacement = await feature.renderNote?.(tree, pluginContext(feature, ctx));
			if (!replacement) continue;
			tree.children = replacement;
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
		// broken is reported through the build rather than silently falling back.
		await prepareMathEngine(options.mathEngine);
		formulas = processMath(tree, options.mathEngine);
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
		applyPageTitle(tree, ctx);
		if (decoratePage && options.enableBacklinks) {
			const refs = (await getCachedBacklinksIndex(index)).get(currentPage.routePath) ?? [];
			const mentions = options.enableUnlinkedMentions
				? (getMentions(index).get(currentPage.routePath) ?? [])
				: [];
			const html = renderBacklinksHtml(refs, mentions);
			if (html) tree.children.push({ type: "html", value: html });
		}
		if (decoratePage && currentPage.cssclasses.length > 0) {
			const classes = currentPage.cssclasses.map(escapeHtmlAttribute).join(" ");
			tree.children.unshift({ type: "html", value: `<div class="${classes}">` });
			tree.children.push({ type: "html", value: "</div>" });
		}
		// MathJax styles each glyph through a generated stylesheet; a page whose
		// formulas all sit in embeds needs it as much as one with its own.
		if (options.enableMath && options.mathEngine === "mathjax") {
			let embedsMath = false;
			visit(tree, "html", (node) => {
				if (node.value.includes("<mjx-")) embedsMath = true;
			});
			const stylesheet = formulas > 0 || embedsMath ? mathEngineStylesheet("mathjax") : "";
			if (stylesheet)
				tree.children.unshift({ type: "html", value: `<style>${stylesheet}</style>\n` });
		}
	}

	// Last, and at every depth: values rebuilt from source slices during the pass
	// are CRLF on a Windows-authored vault.
	normalizeLineEndingsInTree(tree);
}

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

function treeToHtml(tree: Root, headingAnchors: boolean): string {
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
async function renderInlineHtml(markdown: string, ctx: RenderContext): Promise<string> {
	const tree = parseObsidianMarkdown(markdown, { enableMath: ctx.options.enableMath });
	visit(tree, "html", (_node, index, parent) => {
		if (!parent || typeof index !== "number") return;
		parent.children.splice(index, 1);
		return index;
	});
	await transformContent(tree, {
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

function reportDiagnostic(
	file: VFile,
	raw: string,
	message: string,
	status: "broken-page" | "broken-anchor" | "ambiguous-page",
	options: NormalizedPluginOptions,
): void {
	const failing =
		status === "ambiguous-page"
			? options.onAmbiguousLink === "error"
			: options.onBrokenLink === "error";
	reportPluginDiagnostic(file, status, `${raw} — ${message}`, failing ? "defer" : "warn");
}

function createLinkNode(url: string, label: string, title?: string): Link {
	return { type: "link", url, ...(title ? { title } : {}), children: [createTextNode(label)] };
}

function createEmbedNode(url: string, label: string): Html {
	return {
		type: "html",
		value: `<a class="obsidian-embed" data-obsidian-embed="true" href="${escapeHtmlAttribute(url)}">${escapeHtmlText(label)}</a>`,
	};
}

/**
 * Render a wikilink that could not be resolved the way Obsidian shows one: the
 * display text stays readable but marked as unresolved, with the original
 * syntax and the diagnostic available as attributes.
 */
function createUnresolvedNode(parsed: ParsedWikiLink, reason: string): Html {
	return {
		type: "html",
		value:
			`<span class="obsidian-unresolved" title="${escapeHtmlAttribute(reason)}"` +
			` data-wikilink="${escapeHtmlAttribute(parsed.raw)}">${escapeHtmlText(wikiLinkDisplayText(parsed))}</span>`,
	};
}

/**
 * `<WikiPicker>` for a vault search that matched more than one target.
 *
 * The candidates are resolved while compiling and written into the attribute as
 * JSON, so the component needs no runtime data module. `base` lets it build
 * real hrefs for the site's base while navigating client-side by route.
 */
function createWikiPickerNode(
	parsed: ParsedWikiLink,
	candidates: WikiLinkCandidate[],
	siteBase: string,
): PhrasingContent {
	const attributes: { type: "mdxJsxAttribute"; name: string; value: string }[] = [
		{ type: "mdxJsxAttribute", name: "candidates", value: JSON.stringify(candidates) },
	];
	const query = parsed.subpath?.value.trim();
	if (query) attributes.push({ type: "mdxJsxAttribute", name: "query", value: query });
	if (parsed.alias?.trim()) {
		attributes.push({ type: "mdxJsxAttribute", name: "alias", value: parsed.alias.trim() });
	}
	if (siteBase !== "/") attributes.push({ type: "mdxJsxAttribute", name: "base", value: siteBase });
	return {
		type: "mdxJsxTextElement",
		name: "WikiPicker",
		attributes,
		children: [],
	} as unknown as PhrasingContent;
}

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
		options: resolveOptionsOf(ctx.options),
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
			options: resolveOptionsOf(options),
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
		options: resolveOptionsOf(options),
	});
	if (resolved.status !== "ok" || !resolved.targetPage) return undefined;
	if (resolved.ambiguity) {
		reportDiagnostic(ctx.file, parsed.raw, resolved.ambiguity, "ambiguous-page", options);
	}
	return renderPageEmbed(parsed, resolved, ctx);
}

/** Replace every `wikiLink` node with what it renders as. */
async function processWikiLinks(tree: Root, ctx: RenderContext): Promise<void> {
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
async function renderPageEmbed(
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
			await transformContent(tree, {
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

function isExternalUrl(url: string): boolean {
	return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//");
}

/**
 * Split a markdown link destination into its decoded path and anchor.
 *
 * Returns `undefined` for anything this plugin does not own: external URLs,
 * pure `#anchors`, and destinations that are not `.md`/`.mdx` files (those
 * belong to Rspress's own link handling). Percent-encoded destinations are
 * decoded before the file-extension test.
 */
function parseMarkdownDestination(url: string): { pathPart: string; anchor?: string } | undefined {
	if (!url || isExternalUrl(url) || url.startsWith("#")) return undefined;
	let decoded = url;
	try {
		decoded = decodeURIComponent(url);
	} catch {
		// keep the raw form when the destination is not valid percent-encoding
	}
	const hashIndex = decoded.indexOf("#");
	const pathPart = (hashIndex >= 0 ? decoded.slice(0, hashIndex) : decoded).trim();
	if (!/\.(md|mdx)$/i.test(pathPart)) return undefined;
	return { pathPart, anchor: hashIndex >= 0 ? decoded.slice(hashIndex + 1).trim() : undefined };
}

/**
 * Whether a link destination is one this plugin resolves itself — the
 * predicate the Rspress config hook uses to exempt exactly those destinations
 * from Rspress's dead-link gate.
 */
export function isPluginOwnedMarkdownDestination(url: string): boolean {
	return parseMarkdownDestination(url) !== undefined;
}

/** A {@link ParsedWikiLink} for a `.md`/`.mdx` markdown destination. */
function parseMarkdownLinkUrl(
	url: string,
	raw: string,
	isEmbed: boolean,
): ParsedWikiLink | undefined {
	const destination = parseMarkdownDestination(url);
	if (!destination) return undefined;
	const { pathPart, anchor } = destination;
	return {
		raw,
		target: pathPart.replace(/\.(md|mdx)$/i, ""),
		isEmbed,
		subpath: anchor
			? anchor.startsWith("^")
				? { kind: "block", value: anchor.slice(1).trim() }
				: { kind: "heading", value: anchor }
			: undefined,
		isCurrentPageReference: false,
	};
}

/**
 * An `obsidian://` destination, parsed into the note it names — or the reason
 * it cannot be served.
 *
 * Only the `open` action addresses a note. `search`, `new` and
 * `hook-get-address` cannot be served by a static site, so they — like a URI
 * that cannot be parsed or names no note — come back as an `unsupported`
 * reason. The `vault` parameter is ignored: one root publishes one vault.
 */
function parseObsidianUriTarget(
	url: string,
	raw: string,
): { parsed: ParsedWikiLink } | { unsupported: string } | undefined {
	if (!url.toLowerCase().startsWith("obsidian://")) return undefined;
	let uri: URL;
	try {
		uri = new URL(url);
	} catch {
		return { unsupported: "the URI cannot be parsed; the link is left as written." };
	}
	const action = uri.hostname.toLowerCase();
	if (action !== "open") {
		return {
			unsupported: action
				? `the "obsidian://${action}" action cannot be served by a published site; the link is left as written.`
				: "the URI names no action; the link is left as written.",
		};
	}
	// `file` is the current parameter and `path` the legacy one. A heading
	// arrives percent-encoded inside the value (`file=Note%23Heading`) or as the
	// URI's own fragment (`file=Note#Heading`).
	let target = uri.searchParams.get("file") ?? uri.searchParams.get("path") ?? "";
	let subpathValue = uri.searchParams.get("subpath") ?? "";
	const hashIndex = target.indexOf("#");
	if (hashIndex >= 0) {
		subpathValue = target.slice(hashIndex + 1);
		target = target.slice(0, hashIndex);
	}
	if (!subpathValue && uri.hash.length > 1) {
		const fragment = uri.hash.slice(1);
		try {
			subpathValue = decodeURIComponent(fragment);
		} catch {
			subpathValue = fragment;
		}
	}
	target = target.replace(/\.(md|mdx)$/i, "").trim();
	subpathValue = subpathValue.replace(/^#/, "").trim();
	if (!target) return { unsupported: "the URI does not name a note; the link is left as written." };
	return {
		parsed: {
			raw,
			target,
			isEmbed: false,
			subpath: subpathValue
				? subpathValue.startsWith("^")
					? { kind: "block", value: subpathValue.slice(1).trim() }
					: { kind: "heading", value: subpathValue }
				: undefined,
			isCurrentPageReference: false,
		},
	};
}

/**
 * Rewrite standard markdown links whose destination is a vault page —
 * `[label](Page.md)`, `[label](Page.md#Heading)`, `obsidian://open?…` and
 * reference definitions — to the resolved route, with the wikilink resolution
 * ladder. Unresolvable destinations are reported through `onBrokenLink`: this
 * plugin owns that diagnostic for `.md` links because it exempts them from
 * Rspress's dead-link gate.
 */
function processMarkdownLinks(tree: Root, ctx: RenderContext): void {
	const rewrite = (node: { url: string }, raw: string, unresolvedMessage: string): void => {
		const obsidianUri = parseObsidianUriTarget(node.url, raw);
		if (obsidianUri && "unsupported" in obsidianUri) {
			// Its scheme looks external, so an unresolvable one is a dead link
			// nothing else reports.
			reportDiagnostic(ctx.file, raw, obsidianUri.unsupported, "broken-page", ctx.options);
			return;
		}
		const parsed = obsidianUri?.parsed ?? parseMarkdownLinkUrl(node.url, raw, false);
		if (!parsed) return;
		const resolved = resolveWikiLink(parsed, {
			currentPage: ctx.currentPage,
			index: ctx.index,
			options: resolveOptionsOf(ctx.options),
		});
		if (resolved.status === "ok") {
			if (resolved.ambiguity) {
				reportDiagnostic(ctx.file, raw, resolved.ambiguity, "ambiguous-page", ctx.options);
			}
			if (resolved.href) node.url = resolved.href;
			return;
		}
		reportDiagnostic(
			ctx.file,
			raw,
			resolved.message ?? unresolvedMessage,
			resolved.status,
			ctx.options,
		);
	};

	visit(tree, "link", (node: Link) => {
		rewrite(node, `[…](${node.url})`, "Unable to resolve markdown link.");
	});
	// Reference definitions carry the destination for every `[label][ref]`.
	visit(tree, "definition", (node) => {
		rewrite(
			node,
			`[${node.identifier}]: ${node.url}`,
			"Unable to resolve markdown reference definition.",
		);
	});
}

/**
 * Markdown embeds of vault pages — `![alt](note.md)` — which Obsidian
 * transcludes like `![[note]]`. Under Rspress the image has already become an
 * `<img>` bound to an import of the note; that import is dropped here.
 */
async function processMarkdownEmbeds(tree: Root, ctx: RenderContext): Promise<void> {
	interface EmbedWork {
		node: unknown;
		parent: Parent & { children: unknown[] };
		url: string;
		alt: string;
		dropImport?: unknown;
	}
	const work: EmbedWork[] = [];
	const imports = imageImports(tree);

	visit(tree, (node, _index, parent) => {
		if (!parent) return;
		const container = parent as Parent & { children: unknown[] };
		if (node.type === "image") {
			const image = node as Image;
			if (/\.(md|mdx)([#?]|$)/i.test(image.url)) {
				work.push({ node, parent: container, url: image.url, alt: image.alt ?? "" });
			}
			return;
		}
		if (node.type !== "mdxJsxFlowElement" && node.type !== "mdxJsxTextElement") return;
		const element = node as unknown as {
			name: string | null;
			attributes: { type: string; name?: string; value?: unknown }[];
		};
		if (element.name !== "img") return;
		const src = element.attributes.find((attribute) => attribute.name === "src")?.value as
			| { value?: unknown }
			| undefined;
		const bound = typeof src?.value === "string" ? imports.get(src.value) : undefined;
		if (!bound || !/\.(md|mdx)([#?]|$)/i.test(bound.url)) return;
		const alt = element.attributes.find((attribute) => attribute.name === "alt")?.value;
		work.push({
			node,
			parent: container,
			url: bound.url,
			alt: typeof alt === "string" ? alt : "",
			dropImport: bound.node,
		});
	});

	for (const { node, parent, url, alt, dropImport } of work) {
		const raw = `![${alt}](${url})`;
		const parsed = parseMarkdownLinkUrl(url, raw, true);
		if (!parsed) continue;
		const resolved = resolveWikiLink(parsed, {
			currentPage: ctx.currentPage,
			index: ctx.index,
			options: resolveOptionsOf(ctx.options),
		});
		if (resolved.status !== "ok" || !resolved.targetPage) {
			if (resolved.status !== "ok") {
				reportDiagnostic(
					ctx.file,
					raw,
					resolved.message ?? "Unable to resolve markdown embed.",
					resolved.status,
					ctx.options,
				);
			}
			continue;
		}
		if (resolved.ambiguity) {
			reportDiagnostic(ctx.file, raw, resolved.ambiguity, "ambiguous-page", ctx.options);
		}
		const replacement = ctx.options.enableTransclusion
			? await renderPageEmbed(parsed, resolved, ctx)
			: createEmbedNode(
					resolved.href ?? resolved.targetPage.routePath,
					alt || (resolved.label ?? resolved.targetPage.baseName),
				);
		const position = parent.children.indexOf(node);
		if (position >= 0) parent.children.splice(position, 1, replacement);
		if (dropImport) tree.children = tree.children.filter((child) => child !== dropImport);
	}
}
