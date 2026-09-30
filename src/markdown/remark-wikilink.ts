import fs from "node:fs";
import path from "node:path";
import { rehypeHeaderAnchor } from "@rspress/core/dist/node/mdx/rehypePlugins/headerAnchor.js";
import type { Blockquote, HTML, Image, Link, PhrasingContent, Root, Text } from "mdast";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import type { Parent } from "unist";
import { visit } from "unist-util-visit";
import type { VFile } from "vfile";
import {
	type MathEngine,
	mathEngineStylesheet,
	prepareMathEngine,
	renderMathHtml,
} from "../math.js";
import { MERMAID_BLOCK_CLASS, MERMAID_SECURITY_ATTRIBUTE } from "../mermaid/classes.js";
import { escapeHtmlAttribute, escapeHtmlText } from "../shared/escape.js";
import { parseFrontmatter, stripFrontmatter } from "../shared/frontmatter.js";
import { AUDIO_EXTS, extensionOf, IMAGE_EXTS, PDF_EXT, VIDEO_EXTS } from "../shared/media-exts.js";
import { pdfEmbedHtml } from "../shared/media-html.js";
import { humanizeBaseName } from "../shared/slug.js";
import { extractBlockSection, extractHeadingSection } from "../shared/transclusion.js";
import { getCachedBacklinksIndex, renderBacklinksHtml } from "./backlinks.js";
import { stripComments } from "./comments.js";
import { getCachedContentIndex } from "./content-index.js";
import {
	expandDailyTemplateTokens,
	isEmptyDailyNoteBody,
	parseDailyNoteDate,
	renderDailyNavigation,
} from "./daily-notes.js";
import { renderDataviewInline, renderDataviewQuery } from "./dataview.js";
import { renderDataviewJs } from "./dataview-js.js";
import { extractInlineFootnotes } from "./inline-footnotes.js";
import { getMentions } from "./mentions.js";
import { findWikilinkMatches, parseWikiLink } from "./parse-wikilink.js";
import { resolveHeadingSlug, resolveWikiLink } from "./resolve-wikilink.js";
import { encodeTagPathSegment } from "./tag-pages.js";
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
import {
	formatAvailableBlocks,
	formatAvailableHeadings,
	isPathInsideRoot,
	normalizeFilePathKey,
	normalizeFsPath,
} from "./utils.js";

// Obsidian tags accept letters, numbers, symbols, emojis, hyphens, and
// nested-slash segments, but must contain at least one non-numeric character.
const TAG_PATTERN = /(?<![/\p{L}\p{N}_-])#([\p{L}\p{M}\p{N}\p{Extended_Pictographic}_/-]+)/gu;
// Capture optional fold operator: '+' = expanded, '-' = collapsed, absent = static
const CALLOUT_HEADER_PATTERN = /^\[!(\w+)\]([-+])?\s*(.*)$/;
// Obsidian inline and block comments: %% ... %%
const COMMENT_PATTERN = /%%[\s\S]*?%%/g;
// Obsidian text highlighting: ==text==. A single `=` may appear inside
// (`==a=b==`); `====` never matches empty content.
const HIGHLIGHT_PATTERN = /==([^=]+(?:=[^=]+)*)==/g;
// Obsidian footnotes: [^1] reference, [^1]: definition, and ^[inline text]
const FOOTNOTE_REF_PATTERN = /(?<!\[)\[\^([^\]]+)\](?!:)/g;
const FOOTNOTE_DEF_PATTERN = /^\[\^([^\]]+)\]:[ \t]*(.*(?:\n[ \t]{2,}.*)*)$/gm;

// Obsidian math. Display (`$$…$$`) is matched first so its delimiters are not
// read as two inline spans. Inline (`$…$`) follows Obsidian's rule: no space
// directly inside the delimiters, no newline — so prose such as `$5 and $10`
// stays prose.
const MATH_PATTERN = /\$\$([\s\S]+?)\$\$|\$(?!\s)([^$\n]+?)(?<!\s)\$/g;

const MAX_TRANSCLUSION_DEPTH = 5;

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
	if (cached && cached.generation === transclusionGeneration) {
		return cached.renders;
	}
	const renders = new Map<string, string>();
	transclusionRenders.set(options, { generation: transclusionGeneration, renders });
	return renders;
}

// Files that produced an "error"-mode diagnostic (broken/ambiguous link).
// Failure is deferred to the end of the top-level pass so one bad link does
// not abort resolution of the remaining wikilinks in the document.
const pendingFailures = new WeakSet<VFile>();

/**
 * Record one plugin diagnostic.
 *
 * Rspress never reads `file.messages`, so a warn-level diagnostic recorded
 * only there is invisible; print it to the console as well. Failing
 * diagnostics keep the vfile message that becomes the build failure and are
 * not printed — the build error already carries them.
 *
 * `mode` picks where failure lands: `"fail"` throws immediately (the
 * option-driven error modes), `"defer"` marks the file so the top-level pass
 * can fail it once every link has been resolved.
 */
/**
 * A fatal `VFileMessage`, which is what `file.fail` throws in `"fail"` mode.
 *
 * The top-level pass must rethrow one so the build actually fails. So must
 * every catch that runs while rendering a transcluded document: swallowing it
 * turns `onDataviewError: "error"` (and the broken/ambiguous link modes) into a
 * warning the moment the offending note happens to be embedded, so the same
 * document fails one build and passes the next.
 */
function isFatalVFileMessage(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"fatal" in error &&
		(error as { fatal?: unknown }).fatal === true
	);
}

function reportPluginDiagnostic(
	file: VFile,
	scope: string,
	message: string,
	mode: "warn" | "defer" | "fail" = "warn",
): void {
	const text = `[rspress-plugin-obsidian:markdown${scope ? `:${scope}` : ""}] ${message}`;
	if (mode === "fail") {
		file.fail(text);
		return;
	}
	file.message(text);
	if (mode === "defer") {
		pendingFailures.add(file);
		return;
	}
	console.warn(text);
}

// Maps Obsidian callout type aliases to their canonical CSS class.
const CALLOUT_TYPE_ALIASES: Record<string, string> = {
	abstract: "abstract",
	summary: "abstract",
	tldr: "abstract",
	check: "success",
	done: "success",
	help: "question",
	faq: "question",
	hint: "tip",
	important: "tip",
	caution: "caution",
	attention: "caution",
	failure: "failure",
	fail: "failure",
	missing: "failure",
	error: "danger",
	cite: "quote",
};

/** Node types whose children are phrasing content, where an inline footnote can sit. */
const PHRASING_CONTAINER_TYPES = new Set([
	"paragraph",
	"heading",
	"tableCell",
	"emphasis",
	"strong",
	"delete",
	"link",
]);

const SKIP_PARENT_TYPES = new Set([
	"link",
	"linkReference",
	"definition",
	"inlineCode",
	"code",
	"html",
	"mdxJsxTextElement",
	"mdxJsxFlowElement",
	"mdxFlowExpression",
	"mdxTextExpression",
]);

/**
 * Run `transform` over every container whose children are phrasing content.
 *
 * An inline footnote is a phrasing construct, so it can appear in a paragraph,
 * a heading, a table cell or a blockquote paragraph. `transform` returns the
 * replacement children, or nothing to leave the container alone.
 */
function visitPhrasingContainers(
	tree: Root,
	transform: (children: PhrasingContent[]) => PhrasingContent[] | undefined,
): void {
	visit(tree, (node) => {
		if (PHRASING_CONTAINER_TYPES.has(node.type)) {
			const children = (node as Parent & { children: PhrasingContent[] }).children;
			if (!Array.isArray(children)) return;
			const replaced = transform(children);
			if (replaced) (node as Parent & { children: PhrasingContent[] }).children = replaced;
		}
		// Descend regardless: a link or emphasis can itself hold one.
	});
}

/**
 * Resolve all wikilink tokens in `tree` by replacing them with `link` or
 * `html` AST nodes. Operates synchronously so it can be reused inside
 * transclusion handling.
 *
 * When `file` is provided, broken/ambiguous links are reported through the
 * VFile diagnostic API. When omitted (e.g. for transcluded sub-documents),
 * unresolved links are silently left as raw text.
 */
function resolveWikilinksInAst(
	tree: Root,
	currentPage: ContentPage,
	index: ContentIndex,
	options: NormalizedPluginOptions,
	file?: VFile,
	// Only the tree MDX itself compiles can carry a component; a transcluded note
	// is stringified to HTML, where a JSX node would vanish.
	depth = 0,
): void {
	const resolveOptions = {
		enableFuzzyMatching: options.enableFuzzyMatching,
		enableCaseInsensitiveLookup: options.enableCaseInsensitiveLookup,
	};

	visit(tree, "text", (node, position, parent) => {
		if (!parent || typeof position !== "number") {
			return;
		}

		if (SKIP_PARENT_TYPES.has(parent.type)) {
			return;
		}

		const matches = findWikilinkMatches(node.value);
		if (matches.length === 0) {
			return;
		}

		const replacementNodes: PhrasingContent[] = [];
		let cursor = 0;

		for (const match of matches) {
			if (match.start > cursor) {
				replacementNodes.push(createTextNode(node.value.slice(cursor, match.start)));
			}

			const parsed = parseWikiLink(match.inner, match.fullMatch);
			const resolved = resolveWikiLink(parsed, {
				currentPage,
				index,
				options: resolveOptions,
			});

			if (resolved.status === "ok") {
				const href = resolved.href;
				const label = resolved.label;

				if (href && label) {
					replacementNodes.push(
						parsed.isEmbed
							? createEmbedNode(href, label)
							: createLinkNode(href, label, resolved.description),
					);
				} else {
					replacementNodes.push(
						createUnresolvedNode(parsed, "Link target has no published route."),
					);
				}
			} else if (depth === 0 && parsed.search && resolved.candidates?.length) {
				// Obsidian opens a picker of matches for an ambiguous vault search.
				replacementNodes.push(createWikiPickerNode(parsed, resolved.candidates));
			} else {
				const reason = resolved.message ?? "Unable to resolve wikilink.";
				if (file) {
					reportDiagnostic(file, parsed.raw, reason, resolved.status, options);
				}
				replacementNodes.push(createUnresolvedNode(parsed, reason));
			}

			cursor = match.end;
		}

		if (cursor < node.value.length) {
			replacementNodes.push(createTextNode(node.value.slice(cursor)));
		}

		const parentWithChildren = parent as Parent & {
			children: PhrasingContent[];
		};
		parentWithChildren.children.splice(position, 1, ...replacementNodes);
	});
}

function processDataviewNodes(
	tree: Root,
	currentPage: ContentPage,
	index: ContentIndex,
	file: VFile,
	options: NormalizedPluginOptions,
): void {
	visit(tree, "code", (node) => {
		const language = node.lang?.toLowerCase();
		if (language === "dataviewjs") {
			const result = renderDataviewJs(node.value, currentPage, index, options.dailyNotes);
			if (result.error) {
				reportDataviewDiagnostic(file, options, result.error);
				return;
			}
			if (!result.html) return;
			const htmlNode = node as unknown as HTML;
			htmlNode.type = "html";
			htmlNode.value = result.html;
			return;
		}
		if (language !== "dataview") return;

		const result = renderDataviewQuery(node.value, currentPage, index, options.dailyNotes);
		if (result.error) {
			reportDataviewDiagnostic(file, options, result.error);
			return;
		}
		if (!result.html) return;
		const htmlNode = node as unknown as HTML;
		htmlNode.type = "html";
		htmlNode.value = result.html;
	});

	visit(tree, "text", (node, position, parent) => {
		if (!parent || typeof position !== "number") return;
		if (SKIP_PARENT_TYPES.has(parent.type)) return;
		const visibleFields = node.value.replace(
			/(?:\(|\[)([^()[\]:]+?)::\s*([^\])\n]*?)(?:\)|\])/g,
			(fullMatch, _key: string, value: string, offset: number) =>
				isInsideWikilink(node.value, offset) ? fullMatch : value,
		);
		if (visibleFields !== node.value) node.value = visibleFields;
		if (!node.value.includes("=")) return;
		const matches = [
			// A dot only continues the identifier when a name follows it, so a
			// sentence-final `.` is not swallowed: `its folder is = file.folder.`
			// resolved the field `file.folder.` and matched nothing.
			...node.value.matchAll(
				/(^|[\s(])=\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*(?:\([^()\n]*\))?)/g,
			),
		].filter((match) => !isInsideWikilink(node.value, match.index ?? 0));
		if (matches.length === 0) return;

		const replacementNodes: PhrasingContent[] = [];
		let cursor = 0;
		let substituted = false;
		for (const match of matches) {
			// Group 1 is the delimiter before the `=` (whitespace or `(`), so the
			// `=` sits one past it and the expression past that. Deriving both
			// ends from `match[0]` rather than from the expression length is what
			// keeps the source intact: the old offsets pointed at the `=` and
			// under-advanced the cursor, re-emitting the tail of the expression
			// as literal text.
			const matchStart = match.index ?? 0;
			const matchEnd = matchStart + match[0].length;
			const equalsAt = matchStart + (match[1]?.length ?? 0);
			if (equalsAt > cursor) {
				replacementNodes.push(createTextNode(node.value.slice(cursor, equalsAt)));
			}
			const result = renderDataviewInline(match[2] ?? "", currentPage, index, options.dailyNotes);
			if (result.html) {
				substituted = true;
				replacementNodes.push({ type: "html", value: result.html });
			} else {
				// No value to show: leave the `= expr` exactly as written.
				replacementNodes.push(createTextNode(node.value.slice(equalsAt, matchEnd)));
			}
			if (result.error) {
				reportDataviewDiagnostic(file, options, result.error);
			}
			cursor = matchEnd;
		}
		if (cursor < node.value.length) {
			replacementNodes.push(createTextNode(node.value.slice(cursor)));
		}

		// Nothing resolved, so nothing changed: leave the node whole. Splitting it
		// anyway broke every later inline pass that needs its neighbours — `$E =
		// mc^2$` lost its math because the run was cut in two around the `=`.
		if (!substituted) return;

		(parent as Parent & { children: unknown[] }).children.splice(position, 1, ...replacementNodes);
	});
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
		const attributeValue = escapeHtmlAttribute(node.value);
		const htmlNode = node as unknown as HTML;
		htmlNode.type = "html";
		// The configured security level travels with the placeholder: mermaid's
		// configuration is global, so the client applies the stamped level once
		// for every diagram it renders.
		htmlNode.value = `<pre class="${MERMAID_BLOCK_CLASS}" ${MERMAID_SECURITY_ATTRIBUTE}="${options.mermaidSecurityLevel}" data-code="${attributeValue}">${escapeHtmlText(node.value)}</pre>\n`;
	});
}

// Fenced blocks written by an Obsidian plugin runtime this plugin cannot
// execute or render. Publishing such a fence as a code block with no signal
// shows the reader raw query syntax that they will assume ran.
const UNSUPPORTED_PLUGIN_FENCES: Record<string, string> = {
	tasks: "Tasks query blocks are not executed by this plugin; the block is rendered as code.",
	excalidraw: "Excalidraw drawings are not rendered by this plugin; the block is rendered as code.",
	base: "Bases views are not executed by this plugin; the block is rendered as code.",
	kanban: "Kanban boards are not rendered by this plugin; the block is rendered as code.",
	dataview: "Dataview query blocks are not executed by this plugin; the block is rendered as code.",
	dataviewjs: "DataviewJS blocks are never executed by this plugin; the block is rendered as code.",
};

/**
 * Report fences that belong to an Obsidian plugin runtime this plugin cannot
 * execute. `mermaid` is rendered by its own pass, ordinary language fences
 * (`js`, `bash`, …) are the author's own code and stay silent, and `dataview`
 * / `dataviewjs` are only unknown while Dataview is disabled.
 */
function processUnsupportedBlockNodes(
	tree: Root,
	file: VFile,
	options: NormalizedPluginOptions,
): void {
	visit(tree, "code", (node) => {
		const language = node.lang?.toLowerCase();
		if (!language) return;
		const message = UNSUPPORTED_PLUGIN_FENCES[language];
		if (!message) return;
		if (options.enableDataview && (language === "dataview" || language === "dataviewjs")) {
			return;
		}
		reportPluginDiagnostic(
			file,
			"unsupported-block",
			`[!${language}] ${message}`,
			options.onUnsupportedBlock === "error" ? "fail" : "warn",
		);
	});
}

/**
 * Render `$inline$` and `$$display$$` math with KaTeX.
 *
 * Only `text` nodes are visited, so code fences, inline code and raw HTML are
 * untouched. KaTeX is called with `throwOnError: false`, so malformed input
 * renders as KaTeX's own inline error rather than breaking the build; the
 * `null` branch is a safety net for inputs KaTeX rejects outright, which stay
 * as written.
 */
function processMathNodes(tree: Root, engine: MathEngine): void {
	visit(tree, "text", (node, position, parent) => {
		if (!parent || typeof position !== "number") return;
		if (SKIP_PARENT_TYPES.has(parent.type)) return;
		const text = node.value;
		if (!text.includes("$")) return;

		const replacementNodes: PhrasingContent[] = [];
		let cursor = 0;

		for (const match of text.matchAll(MATH_PATTERN)) {
			const displayMode = match[1] !== undefined;
			const tex = (match[1] ?? match[2] ?? "").trim();
			const html = tex ? renderMathHtml(tex, displayMode, engine) : null;
			// Unrenderable math stays literal text, so `cursor` must not advance.
			if (!html) continue;

			const start = match.index ?? 0;
			if (start > cursor) {
				replacementNodes.push(createTextNode(text.slice(cursor, start)));
			}
			// KaTeX emits inline-level markup; the wrapper stays inline so a
			// display block can live inside the paragraph it was written in.
			replacementNodes.push({
				type: "html",
				value: `<span class="${displayMode ? "obsidian-math-display" : "obsidian-math"}">${html}</span>`,
			});
			cursor = start + match[0].length;
		}

		if (replacementNodes.length === 0) return;
		if (cursor < text.length) {
			replacementNodes.push(createTextNode(text.slice(cursor)));
		}
		(parent as Parent & { children: PhrasingContent[] }).children.splice(
			position,
			1,
			...replacementNodes,
		);
	});
}

/** Parse a Markdown fragment into the block nodes the rest of the pass expects. */
function parseMarkdownNodes(markdown: string): Root["children"] {
	const processor = unified().use(remarkParse);
	return (processor.parse(markdown) as Root).children;
}

/**
 * Read the configured daily-note template, if it exists.
 *
 * The path is relative to the root the page came from, so a vault template works
 * for vault pages and a docs template for docs pages. A missing file is not an
 * error: the option is a convenience, and a template that has not been written
 * yet should not fail the build.
 */
function readDailyNoteTemplate(template: string, docsRoot: string): string | undefined {
	const relative =
		template.endsWith(".md") || template.endsWith(".mdx") ? template : `${template}.md`;
	const absolute = path.join(docsRoot, relative);
	try {
		if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return undefined;
		return stripFrontmatter(fs.readFileSync(absolute, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * A stand-in page for a file the plugin generated, or `undefined` when the file
 * is a real one that the content index should have had.
 *
 * Rspress compiles a generated page from a temp file outside every content root
 * (`node_modules/.rspress/runtime/temp-NN.mdx`), so there is no indexed page to
 * look up. The pass still needs *a* page to work from: the fields a generated
 * page legitimately has — its frontmatter title, its own path — are filled in,
 * and the rest are empty, because a generated page has no headings, tags, blocks
 * or backlinks of its own.
 *
 * The route is the temp path rather than the published one, because the remark
 * pass is only told the file it is compiling. That is enough here: a generated
 * page resolves *other* pages against the real index, and has no headings for a
 * `[[#self-reference]]` to resolve against.
 */
function generatedPageFor(
	absolutePath: string,
	docsRoot: string,
	source: string,
): ContentPage | undefined {
	if (isPathInsideRoot(absolutePath, docsRoot)) return undefined;

	const withoutExtension = absolutePath.replace(/\.(md|mdx)$/i, "");
	const relativePath = normalizeFsPath(withoutExtension);
	const baseName = relativePath.split("/").pop() ?? relativePath;
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
		baseName,
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

function processDailyNoteNodes(
	tree: Root,
	currentPage: ContentPage,
	index: ContentIndex,
	options: NormalizedPluginOptions,
	includePageDecorations: boolean,
	docsRoot: string,
	source: string,
): void {
	const date = parseDailyNoteDate(currentPage.relativePath, options.dailyNotes);
	if (!date) return;

	// Obsidian's daily-notes core fills a new note from a template. A static
	// build has no cursor to insert at, so the rule is the useful one instead:
	// only a note whose body is still empty takes the template's content.
	if (options.dailyNotes.template && isEmptyDailyNoteBody(stripFrontmatter(source))) {
		const template = readDailyNoteTemplate(options.dailyNotes.template, docsRoot);
		if (template) {
			tree.children = parseMarkdownNodes(template);
		}
	}

	const title = currentPage.title ?? currentPage.baseName;
	visit(tree, "text", (node, position, parent) => {
		if (!parent || typeof position !== "number") return;
		if (SKIP_PARENT_TYPES.has(parent.type)) return;
		node.value = expandDailyTemplateTokens(node.value, date, title);
	});

	if (includePageDecorations && options.dailyNotes.navigation) {
		const navigation = renderDailyNavigation(currentPage, index.pages, options.dailyNotes);
		if (navigation) {
			tree.children.unshift({ type: "html", value: navigation });
		}
	}
}

function reportDataviewDiagnostic(
	file: VFile,
	options: NormalizedPluginOptions,
	message: string,
): void {
	reportPluginDiagnostic(
		file,
		"dataview",
		message,
		options.onDataviewError === "error" ? "fail" : "warn",
	);
}
export const remarkWikilink: RemarkPluginFactory<RemarkWikiLinkPluginOptions> =
	({ getDocsRoot, getContentIndex, options }) =>
	async (tree: Root, file: VFile): Promise<void> => {
		try {
			await remarkWikilinkInner(
				tree,
				file,
				getDocsRoot,
				options,
				undefined,
				true,
				undefined,
				0,
				undefined,
				getContentIndex,
			);
		} catch (error) {
			// A fatal VFileMessage (raised by file.fail for error-mode broken or
			// ambiguous links) must propagate so the build actually fails.
			if (isFatalVFileMessage(error)) {
				throw error;
			}

			reportPluginDiagnostic(
				file,
				"",
				`Unexpected error processing ${file.path ?? "unknown file"}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	};

/**
 * Fold CRLF (and lone CR) out of every value that reaches the output.
 *
 * micromark parses the source without rewriting it, so a document edited on
 * Windows keeps `\r\n` inside text, code and raw-HTML node values. Browsers
 * normalise those away, but they make the emitted HTML byte-different from the
 * same vault on Linux — and byte-identical output is what lets a Windows CI leg
 * compare artifacts instead of merely smoke-testing them. Only `value` changes:
 * `position` still indexes the raw CRLF source, so the source-slice passes
 * (comment ranges, callout restoration) keep matching.
 */
function normalizeLineEndingsInTree(tree: Root): void {
	visit(tree, (node) => {
		switch (node.type) {
			case "text":
			case "code":
			case "inlineCode":
			case "html": {
				if (node.value.includes("\r")) {
					node.value = node.value.replace(/\r\n?/g, "\n");
				}
				return;
			}
			default:
				return;
		}
	});
}

/** What a raw-source scan of `[^id]: …` lines finds, for the footnote stages. */
interface FootnoteSourceMetadata {
	definitions: Map<string, string>;
	continuationLineNumbers: Set<number>;
}

// --- pipeline stages -------------------------------------------------------
// Extracted verbatim, in pipeline order, and named so the orchestrator reads as
// the ordered list it is. Some pairs are order-dependent — a stage that runs
// after a source-rebuilding one sees different nodes, because rebuilding
// produces nodes with no source positions, and the comment-value pass below
// exists only to catch callout content for that reason. Others are not
// observable from the outside; do not assume every neighbour is coupled.
// `pipeline ordering` in remark-wikilink.test.ts holds the composed behaviour.

/**
 * Strip `%%` comments from node *values*.
 *
 * `stripComments` above works from source ranges and so cannot see nodes this
 * plugin rebuilt from source (callout content), which carry no positions.
 */
function processCommentValues(tree: Root): void {
	visit(tree, "text", (node, position, parent) => {
		if (!node.value.includes("%%")) return;
		const stripped = node.value.replace(COMMENT_PATTERN, "");
		if (stripped === node.value) return;

		if (stripped.trim().length === 0 && parent && typeof position === "number") {
			// Remove the now-empty text node from its parent
			(parent as Parent & { children: unknown[] }).children.splice(position, 1);
			return;
		}

		node.value = stripped;
	});
}

/**
 * Turn Obsidian `==highlights==` into `<mark>` nodes.
 */
function processHighlights(tree: Root): void {
	visit(tree, "text", (node, position, parent) => {
		if (!parent || typeof position !== "number") {
			return;
		}

		if (SKIP_PARENT_TYPES.has(parent.type)) {
			return;
		}

		const text = node.value;
		if (!text.includes("==")) {
			return;
		}

		const matches = [...text.matchAll(HIGHLIGHT_PATTERN)].filter(
			(match) => !isInsideWikilink(text, match.index ?? 0),
		);
		if (matches.length === 0) {
			return;
		}

		const replacementNodes: PhrasingContent[] = [];
		let cursor = 0;

		for (const match of matches) {
			const start = match.index ?? 0;
			const fullMatch = match[0];
			const inner = match[1] ?? "";

			if (start > cursor) {
				replacementNodes.push(createTextNode(text.slice(cursor, start)));
			}

			replacementNodes.push(createHighlightNode(inner));
			cursor = start + fullMatch.length;
		}

		if (cursor < text.length) {
			replacementNodes.push(createTextNode(text.slice(cursor)));
		}

		const parentWithChildren = parent as Parent & {
			children: PhrasingContent[];
		};
		parentWithChildren.children.splice(position, 1, ...replacementNodes);
	});
}

/**
 * Render Obsidian footnotes — `[^id]`, `[^id]: …`, and inline `^[…]`.
 *
 * Six stages over one shared tree, kept together on purpose: they thread the
 * same collected state (`footnoteDefs`, `inlineFnDefs`) through each other, and
 * a stage that runs after a source-rebuilding one sees different nodes than it
 * would otherwise. That ordering is load-bearing, and the stage comments below
 * say which pairs depend on it.
 */
function processFootnotes(
	tree: Root,
	currentPage: ContentPage,
	index: ContentIndex,
	options: NormalizedPluginOptions,
	file: VFile,
	footnoteSourceMetadata: FootnoteSourceMetadata,
): void {
	// Pass 1 (read-only): collect all label-based definitions across the whole tree
	// so that title attributes are correct even when defs appear after their refs.
	const footnoteDefs = new Map<string, string>();
	const footnoteDupeLabels = new Set<string>();
	visit(tree, "text", (node) => {
		if (!node.value.includes("[^")) return;
		for (const m of node.value.matchAll(FOOTNOTE_DEF_PATTERN)) {
			const label = m[1] ?? "";
			const content = normalizeFootnoteContent(m[2] ?? "");
			if (label && content) {
				if (footnoteDefs.has(label)) {
					footnoteDupeLabels.add(label);
				}
				footnoteDefs.set(label, content);
			}
		}
	});
	for (const [label, content] of footnoteSourceMetadata.definitions) {
		const existing = footnoteDefs.get(label);
		if (!existing || content.length > existing.length) {
			footnoteDefs.set(label, content);
		}
	}

	// Strip whole definition paragraphs. Inline markdown inside a definition
	// (`[^1]: see **note**`) splits the paragraph into several nodes, so
	// removing only the matched marker text would leak the rest of the
	// definition into the body; the collected content (favouring the raw
	// source above) is what the footnotes block renders.
	visit(tree, "paragraph", (node, position, parent) => {
		if (!parent || typeof position !== "number") return;
		const first = node.children[0];
		if (first?.type !== "text" || !/^\[\^[^\]]+\]:/.test(first.value)) return;
		// Unindented lines after the marker are lazy continuations, not part of
		// the definition — leave paragraphs that still carry such content.
		const rest = node.children
			.map((child) => (child.type === "text" ? child.value : ""))
			.join("")
			.replace(/^\[\^[^\]]+\]:[ \t]*/, "");
		const lines = rest.split("\n");
		if (lines.slice(1).some((line) => line !== "" && !/^[ \t]{2,}/.test(line))) return;
		(parent as Parent & { children: unknown[] }).children.splice(position, 1);
	});

	if (footnoteSourceMetadata.continuationLineNumbers.size > 0) {
		visit(tree, "text", (node, position, parent) => {
			if (!parent || typeof position !== "number") return;
			if (parent.type !== "paragraph") return;
			const lineNumber = node.position?.start.line;
			if (
				typeof lineNumber === "number" &&
				footnoteSourceMetadata.continuationLineNumbers.has(lineNumber)
			) {
				(parent as Parent & { children: unknown[] }).children.splice(position, 1);
			}
		});
	}

	if (footnoteDupeLabels.size > 0) {
		reportPluginDiagnostic(
			file,
			"footnote",
			`Duplicate footnote label${footnoteDupeLabels.size > 1 ? "s" : ""}: ${[...footnoteDupeLabels].join(", ")}. Later definitions overwrite earlier ones.`,
		);
	}

	// Inline `^[…]` footnotes are found at the phrasing level, before the pass
	// below: remark splits their content at every markdown construct inside it,
	// so `^[with **bold** here]` never presents the closing bracket in the same
	// text node as the opener. The definitions land in the shared counter and
	// list the footnotes block renders.
	let inlineFnCounter = 0;
	const inlineFnDefs: Array<{ id: string; content: string }> = [];
	visitPhrasingContainers(tree, (children) => {
		const extracted = extractInlineFootnotes(children, inlineFnCounter);
		if (extracted.defs.length === 0) return;
		inlineFnCounter += extracted.defs.length;
		inlineFnDefs.push(...extracted.defs);
		return extracted.children;
	});

	// Pass 2: strip definition lines, transform label refs.

	visit(tree, "text", (node, position, parent) => {
		if (!parent || typeof position !== "number") return;
		if (SKIP_PARENT_TYPES.has(parent.type)) return;

		const text = node.value;
		// Inline `^[…]` footnotes are handled by the phrasing-level pass above;
		// only label refs and defs remain here.
		if (!text.includes("[^")) return;

		interface FnMatch {
			kind: "ref" | "def";
			start: number;
			end: number;
			label: string;
			content: string;
		}

		const allMatches: FnMatch[] = [];
		for (const m of text.matchAll(FOOTNOTE_DEF_PATTERN)) {
			allMatches.push({
				kind: "def",
				start: m.index ?? 0,
				end: (m.index ?? 0) + m[0].length,
				label: m[1] ?? "",
				content: normalizeFootnoteContent(m[2] ?? ""),
			});
		}
		for (const m of text.matchAll(FOOTNOTE_REF_PATTERN)) {
			allMatches.push({
				kind: "ref",
				start: m.index ?? 0,
				end: (m.index ?? 0) + m[0].length,
				label: m[1] ?? "",
				content: "",
			});
		}

		if (allMatches.length === 0) return;

		allMatches.sort((a, b) => a.start - b.start);

		const replacementNodes: PhrasingContent[] = [];
		let cursor = 0;

		for (const match of allMatches) {
			if (match.start > cursor) {
				replacementNodes.push(createTextNode(text.slice(cursor, match.start)));
			}

			if (match.kind === "def") {
				// Definition lines are stripped — not included in output.
			} else if (match.kind === "ref") {
				const def = footnoteDefs.get(match.label);
				const title = def ? ` title="${escapeHtmlAttribute(def)}"` : "";
				replacementNodes.push({
					type: "html",
					value: `<sup class="footnote-ref" id="fnref-${escapeHtmlAttribute(match.label)}"><a href="#fn-${escapeHtmlAttribute(match.label)}"${title}>${escapeHtmlText(match.label)}</a></sup>`,
				});
			}

			cursor = match.end;
		}

		if (cursor < text.length) {
			replacementNodes.push(createTextNode(text.slice(cursor)));
		}

		const parentWithChildren = parent as Parent & {
			children: PhrasingContent[];
		};

		// If the node was only definition text it's now empty — remove it.
		const nonEmpty = replacementNodes.filter(
			(n): n is PhrasingContent => n.type !== "text" || (n as Text).value.trim().length > 0,
		);
		if (nonEmpty.length === 0) {
			(parent as Parent & { children: unknown[] }).children.splice(position, 1);
			return;
		}

		parentWithChildren.children.splice(position, 1, ...replacementNodes);
	});

	// Rspress registers `remark-gfm` before this plugin, so micromark has
	// already turned `[^1]` into a `footnoteReference` node and `[^1]:` into a
	// `footnoteDefinition` — the text patterns above never see them. Left alone
	// that produced a second, gfm-rendered footnotes section *and* left the
	// back-links above pointing at ids nothing ever emitted. Claim both node
	// types instead: harvest the definitions (the raw-source scan above is
	// still the richer source, so this only fills gaps), drop them so gfm has
	// nothing left to render, and emit the `<sup>` the back-links target.
	visit(tree, "footnoteDefinition", (node, position, parent) => {
		if (!parent || typeof position !== "number") return;
		const label = String(node.identifier ?? "").trim();
		const content = normalizeFootnoteContent(flattenMdastText(node.children));
		if (label && content && !footnoteDefs.has(label)) {
			footnoteDefs.set(label, content);
		}
		(parent as Parent & { children: unknown[] }).children.splice(position, 1);
	});
	visit(tree, "footnoteReference", (node, position, parent) => {
		if (!parent || typeof position !== "number") return;
		if (SKIP_PARENT_TYPES.has(parent.type)) return;
		const label = String(node.identifier ?? "").trim();
		if (!label) return;
		const def = footnoteDefs.get(label);
		const title = def ? ` title="${escapeHtmlAttribute(def)}"` : "";
		(parent as Parent & { children: unknown[] }).children.splice(position, 1, {
			type: "html",
			value: `<sup class="footnote-ref" id="fnref-${escapeHtmlAttribute(label)}"><a href="#fn-${escapeHtmlAttribute(label)}"${title}>${escapeHtmlText(label)}</a></sup>`,
		});
	});

	// Render all footnotes (label-based + inline) at the end of the document.
	// Definitions render like callout titles: inline Markdown plus resolved
	// wikilinks, so `**bold**` and `[[page]]` inside a footnote are real markup.
	if (footnoteDefs.size > 0 || inlineFnDefs.length > 0) {
		const footnotesHtml = renderAllFootnotesHtml(footnoteDefs, inlineFnDefs, (content) =>
			renderCalloutTitleHtml(content, currentPage, index, options),
		);
		if (footnotesHtml) {
			tree.children.push({ type: "html", value: footnotesHtml });
		}
	}
}

/**
 * Rewrite inline `#tag` into a link to its generated tag page.
 */
function processTagLinks(tree: Root): void {
	visit(tree, "text", (node, position, parent) => {
		if (!parent || typeof position !== "number") {
			return;
		}

		if (SKIP_PARENT_TYPES.has(parent.type)) {
			return;
		}

		const text = node.value;
		if (!text.includes("#")) {
			return;
		}

		const tags = [...text.matchAll(TAG_PATTERN)].filter(
			(match) => !isInsideWikilink(text, match.index ?? 0),
		);
		if (tags.length === 0) {
			return;
		}

		const replacementNodes: PhrasingContent[] = [];
		let cursor = 0;

		for (const tag of tags) {
			const start = tag.index ?? 0;
			const fullMatch = tag[0] ?? "";
			// Trim any trailing slashes that may appear on malformed nested tags.
			const tagName = (tag[1] ?? "").replace(/\/+$/, "");

			if (start > cursor) {
				replacementNodes.push(createTextNode(text.slice(cursor, start)));
			}

			if (tagName && !/^[\p{N}/-]+$/u.test(tagName)) {
				replacementNodes.push(
					createLinkNode(`/tags/${encodeTagPathSegment(tagName)}`, `#${tagName}`),
				);
			} else {
				replacementNodes.push(createTextNode(fullMatch));
			}
			cursor = start + fullMatch.length;
		}

		if (cursor < text.length) {
			replacementNodes.push(createTextNode(text.slice(cursor)));
		}

		const parentWithChildren = parent as Parent & {
			children: PhrasingContent[];
		};
		parentWithChildren.children.splice(position, 1, ...replacementNodes);
	});
}

/**
 * Drop paragraphs emptied by earlier transforms, and unwrap paragraphs left
 * holding only block-level HTML or a JSX embed.
 */
function cleanupParagraphs(tree: Root): void {
	visit(tree, "paragraph", (node, position, parent) => {
		if (!parent || typeof position !== "number") return;
		if (
			node.children.length === 0 ||
			node.children.every((child) => {
				// `mdxJsxFlowElement` is not part of the phrasing union (a flow
				// element cannot appear inside a paragraph as far as mdast is
				// concerned), but this pass creates exactly that combination when
				// it splices an embed into a paragraph — hence the widened read.
				const type = (child as { type: string }).type;
				return type === "html" || type === "mdxJsxFlowElement";
			})
		) {
			(parent as Parent & { children: unknown[] }).children.splice(position, 1, ...node.children);
		}
	});
}

async function remarkWikilinkInner(
	tree: Root,
	file: VFile,
	getDocsRoot: (filePath?: string) => string,
	options: NormalizedPluginOptions,
	currentFilePathOverride?: string,
	includePageDecorations = true,
	visitedOverride?: Set<string>,
	depth = 0,
	sourceContent?: string,
	getContentIndex?: (filePath: string) => Promise<ContentIndex>,
): Promise<void> {
	const currentFilePath = currentFilePathOverride ?? getCurrentFilePath(file);
	const docsRoot = getDocsRoot(currentFilePath);
	const index =
		getContentIndex && currentFilePath
			? await getContentIndex(currentFilePath)
			: await getCachedContentIndex(docsRoot);

	if (!currentFilePath) {
		return;
	}

	const indexedPage = index.byAbsolutePath.get(currentFilePath);
	// A page this plugin generated is absent from the index by design: Rspress
	// writes `addPages` content to `node_modules/.rspress/runtime/temp-NN.mdx`,
	// outside every content root, and compiles that. A stand-in page lets the
	// pass run on it, so a generator that emits a wikilink, a formula or a callout
	// gets the same treatment as a note — and there is nothing for the reader to
	// fix, so no diagnostic. A file *inside* a content root that the index does not
	// know is a real problem and keeps its warning.
	const currentPage = indexedPage ?? generatedPageFor(currentFilePath, docsRoot, String(file));
	if (!currentPage) {
		reportPluginDiagnostic(
			file,
			"",
			`File "${currentFilePath}" not found in content index — wikilink processing skipped.`,
		);
		return;
	}
	// Page decorations (daily-note navigation, the backlinks panel, `cssclasses`)
	// describe a page the reader can navigate to. They are already no-ops for an
	// unindexed page, but stating it keeps a generated page from ever growing one.
	const decoratePage = includePageDecorations && indexedPage !== undefined;
	if (options.enableDailyNotes) {
		processDailyNoteNodes(
			tree,
			currentPage,
			index,
			options,
			decoratePage,
			docsRoot,
			sourceContent ?? String(file),
		);
	}

	if (options.enableDataview) {
		processDataviewNodes(tree, currentPage, index, file, options);
	}
	// After the Dataview pass, so a rendered `dataview` fence is no longer a
	// code node and only fences this plugin truly cannot run are reported.
	processUnsupportedBlockNodes(tree, file, options);
	if (options.enableMermaid) {
		processMermaidNodes(tree, options);
	}
	const footnoteSourceMetadata = extractFootnoteSourceMetadata(sourceContent ?? String(file));
	const source = sourceContent ?? String(file);

	// Callouts run before every text-level transform: their content paragraphs
	// are rebuilt from raw source (so markdown titles split the AST without
	// truncating it), and the passes below then apply to the rebuilt nodes
	// exactly as they do to the rest of the document. First, any callouts
	// already claimed by Rspress's built-in alert transform are restored from
	// source so they get full Obsidian semantics here too.
	if (options.enableCallouts) {
		restoreHijackedCallouts(tree, source);
		processCallouts(tree, currentPage, index, options, source);
	}

	// Strip Obsidian comments (%% ... %%) before all other transforms. The
	// source-range pass handles comments that span paragraphs and headings; the
	// value pass below still catches nodes this plugin rebuilt from source
	// (callouts), which carry no source positions.
	stripComments(tree, source);
	processCommentValues(tree);

	// Transform Obsidian text highlighting ==text== to <mark> tags
	processHighlights(tree);

	// Transform Obsidian footnotes — two-pass approach.
	processFootnotes(tree, currentPage, index, options, file, footnoteSourceMetadata);

	if (options.enableTagLinking) {
		processTagLinks(tree);
	}

	if (options.enableMediaEmbeds || options.enableTransclusion) {
		await processEmbedsInTree(
			tree,
			currentPage,
			index,
			options,
			file,
			docsRoot,
			currentFilePath,
			visitedOverride ?? new Set([currentPage.absolutePath]),
			depth,
			getContentIndex,
		);
	}

	// Sized markdown images are media, not note transclusion, so they are
	// gathered here for their own sake: behind `enableMarkdownLinks` they were
	// off unless markdown-link support happened to be on too, which has nothing
	// to do with `enableMediaEmbeds`.
	if (options.enableMarkdownLinks || options.enableMediaEmbeds) {
		await processMarkdownEmbeds(
			tree,
			currentPage,
			index,
			options,
			file,
			docsRoot,
			visitedOverride ?? new Set([currentPage.absolutePath]),
			depth,
			getContentIndex,
		);
	}

	resolveWikilinksInAst(tree, currentPage, index, options, file, depth);
	if (options.enableMarkdownLinks) {
		processMarkdownLinks(tree, currentPage, index, options, file);
	}
	// Math runs last among the text transforms: wikilinks, highlights and tags
	// have already claimed their syntax, so `$` is the only thing left to read.
	if (options.enableMath) {
		// The engine has to be loaded before the first formula is rendered, and
		// rendering itself is synchronous, so the async half runs first. A
		// MathJax install that is missing or broken is reported through the
		// build rather than silently falling back to KaTeX.
		await prepareMathEngine(options.mathEngine);
		processMathNodes(tree, options.mathEngine);
		const stylesheet = mathEngineStylesheet(options.mathEngine);
		if (stylesheet) {
			tree.children.unshift({ type: "html", value: `<style>${stylesheet}</style>\n` });
		}
	}
	emitBlockAnchors(tree, currentPage);

	// Final cleanup: drop paragraphs emptied by earlier transforms (comments,
	// footnote definitions) and unwrap paragraphs that now contain only raw
	// block-level HTML nodes (embeds, block anchors) or a JSX embed
	// (`CanvasEmbed`, a flow element in MDX). All would otherwise serialize
	// with stray empty <p> wrappers around block-level content.
	cleanupParagraphs(tree);

	// Only the top-level pass (depth 0) may fail the file: a broken link must
	// not abort resolution of the remaining wikilinks, so failure is raised
	// once the whole document has been processed.
	if (depth === 0 && pendingFailures.has(file)) {
		file.fail(
			`[rspress-plugin-obsidian:markdown] One or more wikilinks failed to resolve (see messages above).`,
		);
	}
	if (decoratePage && options.enableBacklinks) {
		const backlinksMap = await getCachedBacklinksIndex(index);
		const refs = backlinksMap.get(currentPage.routePath) ?? [];
		const mentions = options.enableUnlinkedMentions
			? (getMentions(index).get(currentPage.routePath) ?? [])
			: [];
		const html = renderBacklinksHtml(refs, mentions);
		if (html) {
			tree.children.push({ type: "html", value: html });
		}
	}

	if (decoratePage && currentPage.cssclasses.length > 0) {
		const classes = currentPage.cssclasses.map(escapeHtmlAttribute).join(" ");
		tree.children.unshift({
			type: "html",
			value: `<div class="${classes}">`,
		});
		tree.children.push({ type: "html", value: "</div>" });
	}

	// Last, and at every depth: values rebuilt from source slices during the pass
	// (callout content, transcluded subtrees) are CRLF on a Windows-authored
	// vault, so folding here is what catches everything that reaches the output.
	normalizeLineEndingsInTree(tree);
}

async function renderTranscludedHtml(
	content: string,
	options: NormalizedPluginOptions,
	file: VFile,
	docsRoot: string,
	currentFilePath: string,
	visited: Set<string>,
	depth: number,
	getContentIndex?: (filePath: string) => Promise<ContentIndex>,
): Promise<string> {
	const transcludedAst = unified().use(remarkParse).use(remarkGfm).parse(content) as Root;
	await remarkWikilinkInner(
		transcludedAst,
		file,
		() => docsRoot,
		options,
		currentFilePath,
		false,
		visited,
		depth,
		content,
		getContentIndex,
	);
	const htmlProcessor = unified()
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(rehypeHeaderAnchor)
		.use(rehypeStringify, { allowDangerousHtml: true });
	const hastTree = htmlProcessor.runSync(transcludedAst);
	return htmlProcessor.stringify(hastTree);
}
interface PageEmbedContext {
	options: NormalizedPluginOptions;
	file: VFile;
	docsRoot: string;
	currentPage: ContentPage;
	visited: Set<string>;
	depth: number;
	getContentIndex?: (filePath: string) => Promise<ContentIndex>;
}

/**
 * Render a resolved page embed — `![[Page]]`, `![[Page#Section]]`, or the
 * markdown form `![alt](Page.md)` — as a transclusion node shared by both
 * embed syntaxes.
 *
 * A missing heading or block section renders as an embed link to the page,
 * matching Obsidian, which shows unresolved embeds as links rather than
 * inlining the entire page.
 */
async function renderPageEmbed(
	parsedEmbed: ParsedWikiLink,
	resolved: ResolvedWikiLink,
	ctx: PageEmbedContext,
): Promise<PhrasingContent> {
	const { targetPage } = resolved;
	if (!targetPage) {
		return createTextNode(parsedEmbed.raw);
	}

	if (ctx.visited.has(targetPage.absolutePath)) {
		reportPluginDiagnostic(
			ctx.file,
			"transclusion",
			`Circular transclusion detected: ${parsedEmbed.raw} in "${ctx.currentPage.relativePath}".`,
		);
		return createTextNode(parsedEmbed.raw);
	}
	if (ctx.depth >= MAX_TRANSCLUSION_DEPTH) {
		reportPluginDiagnostic(
			ctx.file,
			"transclusion",
			`Max transclusion depth (${MAX_TRANSCLUSION_DEPTH}) reached for ${parsedEmbed.raw} in "${ctx.currentPage.relativePath}".`,
		);
		return createTextNode(parsedEmbed.raw);
	}

	try {
		const content = await fs.promises.readFile(targetPage.absolutePath, "utf-8");
		let transcludedContent: string | undefined;

		if (parsedEmbed.subpath) {
			if (parsedEmbed.subpath.kind === "heading") {
				const headingSlug = resolveHeadingSlug(targetPage, parsedEmbed.subpath.value);
				if (headingSlug !== undefined) {
					transcludedContent = extractHeadingSection(content, headingSlug);
				}
			} else if (parsedEmbed.subpath.kind === "block") {
				transcludedContent = extractBlockSection(content, parsedEmbed.subpath.value);
			}

			if (transcludedContent === undefined) {
				const suffix =
					parsedEmbed.subpath.kind === "heading"
						? formatAvailableHeadings(targetPage)
						: formatAvailableBlocks(targetPage);
				reportPluginDiagnostic(
					ctx.file,
					"transclusion",
					`${parsedEmbed.subpath.kind === "heading" ? "Heading" : "Block"} "${parsedEmbed.subpath.value}" not found in "${targetPage.relativePath}" for ${parsedEmbed.raw};${suffix} rendering as a link to the page.`,
				);
				return createEmbedNode(
					targetPage.routePath,
					parsedEmbed.alias ?? humanizeBaseName(targetPage.baseName),
				);
			}
		}

		if (transcludedContent === undefined) {
			transcludedContent = stripFrontmatter(content);
		}

		const renders = transclusionCacheFor(ctx.options);
		const renderKey = [
			targetPage.absolutePath,
			parsedEmbed.subpath ? `${parsedEmbed.subpath.kind}:${parsedEmbed.subpath.value}` : "",
			String(ctx.depth),
			[...ctx.visited].sort().join("|"),
		].join("\u0000");
		let transcludedHtml = renders.get(renderKey);
		if (transcludedHtml === undefined) {
			transcludedHtml = await renderTranscludedHtml(
				transcludedContent,
				ctx.options,
				ctx.file,
				ctx.docsRoot,
				targetPage.absolutePath,
				new Set([...ctx.visited, targetPage.absolutePath]),
				ctx.depth + 1,
				ctx.getContentIndex,
			);
			renders.set(renderKey, transcludedHtml);
		}
		return {
			type: "html",
			value: `<div class="obsidian-transclusion" data-src="${escapeHtmlAttribute(resolved.href ?? "")}">\n${transcludedHtml}\n</div>`,
		};
	} catch (error) {
		// `file.fail` inside the transcluded document — a Dataview query that
		// cannot evaluate, a broken or ambiguous link — throws rather than warns.
		// Swallowing it here reported the failure and let the build pass, so the
		// same document failed on its own and succeeded once embedded.
		if (isFatalVFileMessage(error)) {
			throw error;
		}
		reportPluginDiagnostic(
			ctx.file,
			"transclusion",
			`Failed to read "${targetPage.relativePath}" for ${parsedEmbed.raw}: ${error instanceof Error ? error.message : String(error)}`,
		);
		return createTextNode(parsedEmbed.raw);
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
	if (!url || isExternalUrl(url) || url.startsWith("#")) {
		return undefined;
	}

	let decoded = url;
	try {
		decoded = decodeURIComponent(url);
	} catch {
		// keep the raw form when the destination is not valid percent-encoding
	}

	const hashIndex = decoded.indexOf("#");
	const pathPart = (hashIndex >= 0 ? decoded.slice(0, hashIndex) : decoded).trim();
	if (!/\.(md|mdx)$/i.test(pathPart)) {
		return undefined;
	}

	return {
		pathPart,
		anchor: hashIndex >= 0 ? decoded.slice(hashIndex + 1).trim() : undefined,
	};
}

/**
 * An `obsidian://` destination, parsed into the note it names — or the reason
 * it cannot be served.
 */
type ObsidianUriTarget = { parsed: ParsedWikiLink } | { unsupported: string };

/**
 * Parse an `obsidian://` link into the vault note it names, so the link pass
 * can resolve it like any other link instead of shipping an `obsidian://` href
 * that is dead on the web (the scheme looks external, so nothing else reports
 * it either).
 *
 * Only the `open` action addresses a note. `search`, `new`, and
 * `hook-get-address` cannot be served by a static site, so they — like a URI
 * that cannot be parsed or names no note — come back as an `unsupported`
 * reason for the caller to report.
 *
 * The `vault` parameter is ignored: one docs root publishes one vault, so the
 * file resolves against the index this pass already holds.
 */
function parseObsidianUriTarget(url: string, raw: string): ObsidianUriTarget | undefined {
	if (!url.toLowerCase().startsWith("obsidian://")) {
		return undefined;
	}

	let uri: URL;
	try {
		uri = new URL(url);
	} catch {
		return { unsupported: "the URI cannot be parsed; the link is left as written." };
	}

	// The action is the URI's host: `obsidian://open?…`.
	const action = uri.hostname.toLowerCase();
	if (action !== "open") {
		return {
			unsupported: action
				? `the "obsidian://${action}" action cannot be served by a published site; the link is left as written.`
				: "the URI names no action; the link is left as written.",
		};
	}

	// `file` is the current parameter and `path` the legacy one; `URLSearchParams`
	// decodes both. A heading arrives percent-encoded inside the value
	// (`file=Note%23Heading`) or as the URI's own fragment (`file=Note#Heading`).
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
			// keep the raw form when the fragment is not valid percent-encoding
			subpathValue = fragment;
		}
	}

	target = target.replace(/\.(md|mdx)$/i, "").trim();
	subpathValue = subpathValue.replace(/^#/, "").trim();
	if (!target) {
		return { unsupported: "the URI does not name a note; the link is left as written." };
	}

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
 * Whether a link destination is one this plugin resolves itself.
 *
 * The same predicate `parseMarkdownLinkUrl` uses, exported so the Rspress
 * config hook can exempt exactly those destinations from Rspress's dead-link
 * gate and leave every other link checked.
 */
export function isPluginOwnedMarkdownDestination(url: string): boolean {
	return parseMarkdownDestination(url) !== undefined;
}

/**
 * Build a {@link ParsedWikiLink} from a standard markdown link destination.
 *
 * Only `.md` / `.mdx` file references are considered — Obsidian's
 * autocomplete emits that form, and anything else (external URLs, pure
 * `#anchors`, extensionless routes) belongs to Rspress's own link handling.
 */
function parseMarkdownLinkUrl(
	url: string,
	raw: string,
	isEmbed: boolean,
): ParsedWikiLink | undefined {
	const destination = parseMarkdownDestination(url);
	if (!destination) {
		return undefined;
	}
	const { pathPart, anchor } = destination;

	const subpath = anchor
		? anchor.startsWith("^")
			? { kind: "block" as const, value: anchor.slice(1).trim() }
			: { kind: "heading" as const, value: anchor }
		: undefined;

	return {
		raw,
		target: pathPart.replace(/\.(md|mdx)$/i, ""),
		isEmbed,
		subpath,
		isCurrentPageReference: false,
	};
}

/**
 * Rewrite standard markdown links whose destination is a vault page —
 * `[label](Page.md)`, `[label](./relative.md)`, `[label](Page.md#Heading)` —
 * to the resolved route, using the same resolution ladder as wikilinks
 * (path, basename, title/alias, case-insensitive, fuzzy). Unresolvable
 * destinations are reported through `onBrokenLink` — this plugin owns that
 * diagnostic for `.md` links because it disables Rspress's dead-link gate
 * when markdown-link resolution is enabled.
 */
function processMarkdownLinks(
	tree: Root,
	currentPage: ContentPage,
	index: ContentIndex,
	options: NormalizedPluginOptions,
	file: VFile,
): void {
	const resolveOptions = {
		enableFuzzyMatching: options.enableFuzzyMatching,
		enableCaseInsensitiveLookup: options.enableCaseInsensitiveLookup,
	};

	/**
	 * Resolve one destination in place. `.md` destinations and `obsidian://`
	 * URIs both go through the wikilink ladder; anything else (external URLs,
	 * pure anchors, extensionless routes) belongs to Rspress's own handling.
	 */
	const rewriteDestination = (
		node: { url: string },
		raw: string,
		unresolvedMessage: string,
	): void => {
		const obsidianUri = parseObsidianUriTarget(node.url, raw);
		if (obsidianUri && "unsupported" in obsidianUri) {
			// An `obsidian://` link cannot be left to Rspress: its scheme looks
			// external, so an unresolvable one is a dead link nobody reports.
			reportDiagnostic(file, raw, obsidianUri.unsupported, "broken-page", options);
			return;
		}

		const parsed = obsidianUri?.parsed ?? parseMarkdownLinkUrl(node.url, raw, false);
		if (!parsed) {
			return;
		}

		const resolved = resolveWikiLink(parsed, {
			currentPage,
			index,
			options: resolveOptions,
		});
		if (resolved.status === "ok") {
			if (resolved.href) {
				node.url = resolved.href;
			}
			return;
		}
		reportDiagnostic(file, raw, resolved.message ?? unresolvedMessage, resolved.status, options);
	};

	visit(tree, "link", (node: Link) => {
		rewriteDestination(node, `[…](${node.url})`, "Unable to resolve markdown link.");
	});

	// Reference definitions (`[ref]: Page.md`) carry the destination for every
	// `[label][ref]` in the document, so resolving the definition fixes all of them
	// at once — and a broken one is reported instead of rendering a dead `.md`
	// href that Rspress's dead-link gate has been told to leave alone.
	visit(tree, "definition", (node) => {
		rewriteDestination(
			node,
			`[${node.identifier}]: ${node.url}`,
			"Unable to resolve markdown reference definition.",
		);
	});
}

/**
 * Resolve markdown embeds of vault pages — `![alt](note.md)` — the form
 * Obsidian transcludes identically to `![[note]]`. With transclusion
 * enabled the page is inlined; otherwise the embed becomes a styled link.
 */
async function processMarkdownEmbeds(
	tree: Root,
	currentPage: ContentPage,
	index: ContentIndex,
	options: NormalizedPluginOptions,
	file: VFile,
	docsRoot: string,
	visited: Set<string>,
	depth: number,
	getContentIndex?: (filePath: string) => Promise<ContentIndex>,
): Promise<void> {
	const resolveOptions = {
		enableFuzzyMatching: options.enableFuzzyMatching,
		enableCaseInsensitiveLookup: options.enableCaseInsensitiveLookup,
	};

	interface EmbedWork {
		node: Image;
		parent: Parent;
		/** Set when the node is a sized media image rather than a page embed. */
		media?: { alt: string; sizeAttr: string };
	}
	const work: EmbedWork[] = [];

	visit(tree, "image", (node, _position, parent) => {
		if (!parent) return;
		const image = node as Image;
		if (/\.(md|mdx)([#?]|$)/i.test(image.url)) {
			// `![alt](Note.md)` is markdown-link transclusion, which stays behind
			// its own flag; this pass now also runs for media alone.
			if (!options.enableMarkdownLinks) return;
			work.push({ node: image, parent });
			return;
		}
		// Obsidian lets a markdown image carry the same size a wikilink embed
		// does — "the same syntax as a wikilink" — either as the alt on its own
		// (`![250](url)`, `![250x145](url)`) or after a caption
		// (`![A caption|250](url)`). An alt that is not a bare dimension is
		// caption text, and the node is left to the ordinary image renderer,
		// byte for byte.
		if (!options.enableMediaEmbeds) return;
		const sized = splitImageSize(image.alt ?? "");
		if (!sized) return;
		work.push({ node: image, parent, media: sized });
	});

	for (const { node, parent, media } of work) {
		if (media) {
			// The `src` remark resolved is kept as-is: it is already correct for
			// the page it was written on, and resolving it again here would
			// re-encode a URL that is about to be emitted.
			const replacement: PhrasingContent = {
				type: "html",
				value: `<img src="${escapeHtmlAttribute(node.url)}" alt="${escapeHtmlAttribute(media.alt || altFromImageUrl(node.url))}"${media.sizeAttr} loading="lazy" />`,
			};
			const parentWithChildren = parent as Parent & { children: PhrasingContent[] };
			const position = parentWithChildren.children.indexOf(node);
			if (position < 0) continue;
			parentWithChildren.children.splice(position, 1, replacement);
			continue;
		}
		const raw = `![${node.alt ?? ""}](${node.url})`;
		const parsed = parseMarkdownLinkUrl(node.url, raw, true);
		if (!parsed) continue;

		const resolved = resolveWikiLink(parsed, {
			currentPage,
			index,
			options: resolveOptions,
		});
		if (resolved.status !== "ok" || !resolved.targetPage) {
			if (resolved.status !== "ok") {
				reportDiagnostic(
					file,
					raw,
					resolved.message ?? "Unable to resolve markdown embed.",
					resolved.status,
					options,
				);
			}
			continue;
		}
		const replacement: PhrasingContent = options.enableTransclusion
			? await renderPageEmbed(parsed, resolved, {
					options,
					file,
					docsRoot,
					currentPage,
					visited,
					depth,
					getContentIndex,
				})
			: createEmbedNode(
					resolved.href ?? resolved.targetPage.routePath,
					node.alt ?? humanizeBaseName(resolved.targetPage.baseName),
				);

		const parentWithChildren = parent as Parent & {
			children: PhrasingContent[];
		};
		const currentPosition = parentWithChildren.children.indexOf(node);
		if (currentPosition < 0) continue;
		parentWithChildren.children.splice(currentPosition, 1, replacement);
	}
}

async function processEmbedsInTree(
	tree: Root,
	currentPage: ContentPage,
	index: ContentIndex,
	options: NormalizedPluginOptions,
	file: VFile,
	docsRoot: string,
	currentFilePath: string,
	visited: Set<string>,
	depth: number,
	getContentIndex?: (filePath: string) => Promise<ContentIndex>,
): Promise<void> {
	const resolveOptions = {
		enableFuzzyMatching: options.enableFuzzyMatching,
		enableCaseInsensitiveLookup: options.enableCaseInsensitiveLookup,
	};

	// Two-pass approach: collect nodes, then resolve async
	interface EmbedWork {
		node: Text;
		parent: Parent;
	}
	const embedNodes: EmbedWork[] = [];

	visit(tree, "text", (node, _position, parent) => {
		if (!parent) return;
		if (SKIP_PARENT_TYPES.has(parent.type)) return;
		if (!node.value.includes("![")) return;
		const embedMatches = findWikilinkMatches(node.value).filter((match) =>
			match.fullMatch.startsWith("!["),
		);
		if (embedMatches.length > 0) {
			embedNodes.push({ node, parent });
		}
	});

	// Process all embed nodes with proper async file reads,
	// building AST nodes (text + html) instead of a raw HTML string.
	for (const { node, parent } of embedNodes) {
		const text = node.value;
		const embedMatches = findWikilinkMatches(text).filter((match) =>
			match.fullMatch.startsWith("!["),
		);
		if (embedMatches.length === 0) continue;

		const replacementNodes: PhrasingContent[] = [];
		let lastEnd = 0;

		for (const match of embedMatches) {
			const start = match.start;
			const fullMatch = match.fullMatch;
			const inner = match.inner;

			if (start > lastEnd) {
				replacementNodes.push(createTextNode(text.slice(lastEnd, start)));
			}

			const parsedEmbed = parseWikiLink(inner, fullMatch);
			const sizeParam = parsedEmbed.alias ?? "";
			const target = parsedEmbed.target;
			const fragment = parsedEmbed.subpath ? `#${parsedEmbed.subpath.value}` : "";
			const ext = extensionOf(target);
			if (options.enableMediaEmbeds && IMAGE_EXTS.has(ext)) {
				const sizeAttr = parseSizeAttr(sizeParam);
				// Obsidian treats a numeric pipe as a size; any other pipe text
				// is alt/caption text for the image.
				const altText = sizeAttr ? target : sizeParam.trim() || target;
				const resolved = resolveMediaSrc(
					target,
					docsRoot,
					currentFilePath,
					index,
					options.enableCaseInsensitiveLookup,
				);
				if (!resolved.found) {
					reportPluginDiagnostic(
						file,
						"media",
						`Image "${target}" not found on disk for ${fullMatch}.`,
					);
				}
				const src = escapeHtmlAttribute(`${resolved.url}${fragment}`);
				replacementNodes.push({
					type: "html",
					value: `<img src="${src}" alt="${escapeHtmlAttribute(altText)}"${sizeAttr} loading="lazy" />`,
				});
			} else if (options.enableMediaEmbeds && AUDIO_EXTS.has(ext)) {
				const resolved = resolveMediaSrc(
					target,
					docsRoot,
					currentFilePath,
					index,
					options.enableCaseInsensitiveLookup,
				);
				if (!resolved.found) {
					reportPluginDiagnostic(
						file,
						"media",
						`Audio "${target}" not found on disk for ${fullMatch}.`,
					);
				}
				const src = escapeHtmlAttribute(`${resolved.url}${fragment}`);
				replacementNodes.push({
					type: "html",
					value: `<audio controls src="${src}"></audio>`,
				});
			} else if (options.enableMediaEmbeds && VIDEO_EXTS.has(ext)) {
				const sizeAttr = parseSizeAttr(sizeParam);
				const resolved = resolveMediaSrc(
					target,
					docsRoot,
					currentFilePath,
					index,
					options.enableCaseInsensitiveLookup,
				);
				if (!resolved.found) {
					reportPluginDiagnostic(
						file,
						"media",
						`Video "${target}" not found on disk for ${fullMatch}.`,
					);
				}
				const src = escapeHtmlAttribute(`${resolved.url}${fragment}`);
				replacementNodes.push({
					type: "html",
					value: `<video controls src="${src}"${sizeAttr}></video>`,
				});
			} else if (options.enableMediaEmbeds && ext === PDF_EXT) {
				const resolved = resolveMediaSrc(
					target,
					docsRoot,
					currentFilePath,
					index,
					options.enableCaseInsensitiveLookup,
				);
				if (!resolved.found) {
					reportPluginDiagnostic(
						file,
						"media",
						`PDF "${target}" not found on disk for ${fullMatch}.`,
					);
				}
				// Obsidian puts the two PDF knobs in the subpath: `#page=3` opens the
				// viewer at a page, `#height=400` sizes the frame. Only the page
				// belongs in the URL — the height is a property of this embed, so
				// it is an attribute and never travels to the file.
				const subpathValue = parsedEmbed.subpath?.value ?? "";
				const pdfPage = subpathValue.match(/^page=(\d+)$/i)?.[1];
				const pdfHeight = subpathValue.match(/^height=(\d+)$/i)?.[1] ?? "600";
				const src = `${resolved.url}${pdfPage ? `#page=${pdfPage}` : ""}`;
				// The frame is a figure with a caption bar naming the file and a
				// link out to it, built in one place because the canvas renderer
				// embeds the same document. Publishers who do not want inline PDFs
				// at all should leave `enableMediaEmbeds` off, which links to the
				// file instead of embedding it.
				replacementNodes.push({
					type: "html",
					value: pdfEmbedHtml({ src, target, page: pdfPage, height: Number(pdfHeight) }),
				});
			} else if (ext === "canvas") {
				const resolved = resolveWikiLink(parsedEmbed, {
					currentPage,
					index,
					options: resolveOptions,
				});
				if (resolved.status === "ok" && resolved.canvasSrc !== undefined) {
					if (options.enableMediaEmbeds && depth === 0) {
						// A board the canvas feature published: render it through the
						// same `<CanvasEmbed>` component the docs link to. Only the
						// top-level tree is compiled by MDX — a transclusion is
						// stringified as plain HTML, where a JSX node degrades to an
						// empty <div> — so deeper embeds take the link form below.
						// `fileRoutePrefix` points the board's file cards at the vault
						// pages this same plugin publishes.
						const attributes: {
							type: "mdxJsxAttribute";
							name: string;
							value: string;
						}[] = [{ type: "mdxJsxAttribute", name: "src", value: resolved.canvasSrc }];
						if (options.vaultRoutePrefix) {
							attributes.push({
								type: "mdxJsxAttribute",
								name: "fileRoutePrefix",
								value: options.vaultRoutePrefix,
							});
						}
						replacementNodes.push({
							type: "mdxJsxFlowElement",
							name: "CanvasEmbed",
							attributes,
							children: [],
						} as unknown as PhrasingContent);
					} else {
						// Media embeds are off, or this board sits inside a transcluded
						// note: link to the board. The link form is plain HTML, so it
						// survives both the HTML stringifier and a pipeline with the
						// embed toggle off.
						replacementNodes.push(createEmbedNode(resolved.href ?? "", resolved.label ?? target));
					}
				} else {
					// No canvas route: the board is not published (canvas feature off,
					// or excluded from its scan). Previous behaviour applies — an
					// attachment is never inlined by transclusion either.
					replacementNodes.push(createTextNode(fullMatch));
				}
			} else if (options.enableTransclusion) {
				const resolved = resolveWikiLink(parsedEmbed, {
					currentPage,
					index,
					options: resolveOptions,
				});

				if (resolved.status === "ok" && resolved.targetPage) {
					replacementNodes.push(
						await renderPageEmbed(parsedEmbed, resolved, {
							options,
							file,
							docsRoot,
							currentPage,
							visited,
							depth,
							getContentIndex,
						}),
					);
				} else {
					replacementNodes.push(createTextNode(fullMatch));
				}
			} else {
				replacementNodes.push(createTextNode(fullMatch));
			}

			lastEnd = start + fullMatch.length;
		}

		if (lastEnd < text.length) {
			replacementNodes.push(createTextNode(text.slice(lastEnd)));
		}

		const parentWithChildren = parent as Parent & {
			children: PhrasingContent[];
		};
		const currentPosition = parentWithChildren.children.indexOf(node);
		if (currentPosition < 0) continue;
		parentWithChildren.children.splice(currentPosition, 1, ...replacementNodes);
	}
}

function getCurrentFilePath(file: VFile): string | undefined {
	const pathFromFile = typeof file.path === "string" ? file.path : file.history.at(-1);
	return pathFromFile ? normalizeFsPath(pathFromFile) : undefined;
}

/**
 * True when `index` falls inside a `[[...]]` / `![[...]]` span of `text`.
 * Keeps text-level transforms (tags, highlights) from firing inside wikilink
 * targets and aliases, where `#anchor` and `==text==` belong to the link, not
 * the surrounding prose.
 */
function isInsideWikilink(text: string, index: number): boolean {
	for (const match of findWikilinkMatches(text)) {
		if (index >= match.start && index < match.end) {
			return true;
		}
	}
	return false;
}

/**
 * Remove `position` from a node and its descendants.
 *
 * Nodes parsed from a source *fragment* carry offsets relative to that fragment;
 * any pass that maps offsets back into the document (comment stripping) would
 * slice the wrong characters. Dropping the positions makes those passes skip the
 * node instead of corrupting it.
 */
function dropPositions(node: unknown): void {
	if (typeof node !== "object" || node === null) return;
	const record = node as { position?: unknown; children?: unknown[] };
	delete record.position;
	if (Array.isArray(record.children)) {
		for (const child of record.children) dropPositions(child);
	}
}

function createTextNode(value: string): Text {
	return {
		type: "text",
		value,
	};
}

function createLinkNode(url: string, label: string, title?: string): Link {
	return {
		type: "link",
		url,
		...(title ? { title } : {}),
		children: [
			{
				type: "text",
				value: label,
			},
		],
	};
}

function createEmbedNode(url: string, label: string): HTML {
	return {
		type: "html",
		value: `<a class="obsidian-embed" data-obsidian-embed="true" href="${escapeHtmlAttribute(url)}">${escapeHtmlText(label)}</a>`,
	};
}

function createHighlightNode(text: string): HTML {
	return {
		type: "html",
		value: `<mark>${escapeHtmlText(text)}</mark>`,
	};
}

/**
 * Render a wikilink that could not be resolved the way Obsidian shows one:
 * the label stays readable but marked as unresolved, with the original syntax
 * and the diagnostic available as attributes. Rendering the raw `[[…]]` text
 * instead would hide the label a reader expects to see.
 */
/**
 * `<WikiPicker>` for a vault search that matched more than one target.
 *
 * The candidates are resolved while compiling and written into the attribute as
 * JSON, so the component needs no runtime data module and the list keeps working
 * on a statically exported site.
 */
function createWikiPickerNode(
	parsed: ParsedWikiLink,
	candidates: WikiLinkCandidate[],
): PhrasingContent {
	const attributes: { type: "mdxJsxAttribute"; name: string; value: string }[] = [
		{ type: "mdxJsxAttribute", name: "candidates", value: JSON.stringify(candidates) },
	];
	const query = parsed.subpath?.value.trim();
	if (query) attributes.push({ type: "mdxJsxAttribute", name: "query", value: query });
	if (parsed.alias?.trim()) {
		attributes.push({ type: "mdxJsxAttribute", name: "alias", value: parsed.alias.trim() });
	}
	return {
		type: "mdxJsxTextElement",
		name: "WikiPicker",
		attributes,
		children: [],
	} as unknown as PhrasingContent;
}

function createUnresolvedNode(parsed: ParsedWikiLink, reason: string): HTML {
	const label = parsed.alias?.trim() || parsed.target;
	return {
		type: "html",
		value:
			`<span class="obsidian-unresolved" title="${escapeHtmlAttribute(reason)}"` +
			` data-wikilink="${escapeHtmlAttribute(parsed.raw)}">${escapeHtmlText(label)}</span>`,
	};
}

/**
 * Emit HTML anchors for every block ID indexed on the current page, so that
 * `[[Page#^block-id]]` links actually resolve in the browser.
 *
 * The resolver produces `#^block-id` fragments; this function is the
 * counterpart that materializes an `id="^block-id"` target in the output.
 * Standalone `^id` markers are replaced entirely; inline `… ^id` markers are
 * stripped from the paragraph and replaced with an empty anchor at their
 * position. Both match the exact patterns used by `extractBlocks()` in
 * `content-index.ts`.
 */
function emitBlockAnchors(tree: Root, currentPage: ContentPage): void {
	const ids = new Set(currentPage.blocks.map((block) => block.id));
	if (ids.size === 0) return;

	visit(tree, "text", (node, position, parent) => {
		if (!parent || typeof position !== "number") return;
		if (SKIP_PARENT_TYPES.has(parent.type)) return;

		const value = node.value;
		if (!value.includes("^")) return;

		const standalone = /^\s*\^([A-Za-z0-9_-]+)\s*$/.exec(value);
		if (standalone) {
			const id = standalone[1];
			if (id && ids.has(id)) {
				(parent as Parent & { children: unknown[] }).children.splice(
					position,
					1,
					createBlockAnchor(id),
				);
			}
			return;
		}

		const inline = /\s\^([A-Za-z0-9_-]+)\s*$/.exec(value);
		if (inline) {
			const id = inline[1];
			if (id && ids.has(id)) {
				const leading = value.slice(0, value.length - inline[0].length);
				const replacement: PhrasingContent[] = [];
				if (leading.length > 0) {
					replacement.push(createTextNode(leading));
				}
				replacement.push(createBlockAnchor(id));
				const children = (parent as Parent & { children: PhrasingContent[] }).children;
				children.splice(position, 1, ...replacement);
			}
		}
	});
}

function createBlockAnchor(id: string): HTML {
	return {
		type: "html",
		value: `<a id="^${escapeHtmlAttribute(id)}"></a>`,
	};
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

/**
 * Split a markdown image's alt text into alt text and a size.
 *
 * Obsidian documents two forms for a markdown image: the size alone in the alt
 * (`![250](url)`, `![250x145](url)`) and a caption followed by a size pipe
 * (`![A picture|80](url)`), the latter matching the wikilink embed's `|80`. A
 * caption that is not a bare dimension — `![A picture|wide](url)` — is left
 * alone, so no size is ever claimed from prose.
 */
function splitImageSize(alt: string): { alt: string; sizeAttr: string } | undefined {
	const separator = alt.lastIndexOf("|");
	if (separator !== -1) {
		const sizeAttr = parseSizeAttr(alt.slice(separator + 1).trim());
		if (sizeAttr) return { alt: alt.slice(0, separator).trim(), sizeAttr };
	}
	const sizeAttr = parseSizeAttr(alt.trim());
	if (sizeAttr) return { alt: "", sizeAttr };
	return undefined;
}

/** Alt text for a sized image that carried none: the file's own name. */
function altFromImageUrl(url: string): string {
	const name =
		url
			.split("/")
			.pop()
			?.split(/[?#]/)[0]
			?.replace(/\.[^.]+$/, "") ?? "";
	return humanizeBaseName(name);
}

function parseSizeAttr(sizeParam: string): string {
	if (!sizeParam) return "";
	const match = sizeParam.match(/^(\d+)(?:x(\d+))?$/);
	if (!match) return "";
	const width = match[1];
	const height = match[2];
	return height ? ` width="${width}" height="${height}"` : ` width="${width}"`;
}
interface MediaResolveResult {
	url: string;
	found: boolean;
}

/**
 * Resolve a media embed target to a root-relative URL.
 * Tries the file relative to the current markdown file, then relative to
 * docsRoot. Falls back to a root-relative path if neither is found on disk.
 * Each path segment is percent-encoded so spaces and special characters
 * produce valid `src`/`href` URLs.
 */
function resolveMediaSrc(
	target: string,
	docsRoot: string,
	currentFilePath: string,
	index: ContentIndex,
	enableCaseInsensitiveLookup: boolean,
): MediaResolveResult {
	// Percent-encode every segment, dropping `..`/`.` so a wikilink target
	// cannot escape the docs root through the emitted URL.
	const encodePath = (segments: string[]): string =>
		`/${segments
			.filter((segment) => segment !== "" && segment !== "." && segment !== "..")
			.map((segment) => encodeURIComponent(segment))
			.join("/")}`;

	const relativeAsset = (absolutePath: string): MediaResolveResult | undefined => {
		const relativePath = path.relative(docsRoot, absolutePath);
		if (
			relativePath.startsWith("..") ||
			path.isAbsolute(relativePath) ||
			relativePath.length === 0
		) {
			return undefined;
		}
		const pathKey = normalizeFilePathKey(normalizeFsPath(relativePath));
		const exact = index.byAssetPath.get(pathKey);
		if (exact) {
			return { url: exact.urlPath, found: true };
		}
		if (!enableCaseInsensitiveLookup) {
			return undefined;
		}
		const candidates = index.byAssetPathCI.get(pathKey.toLowerCase()) ?? [];
		return candidates.length === 1 && candidates[0]
			? { url: candidates[0].urlPath, found: true }
			: undefined;
	};

	// A disk check is not authoritative about spelling: on a case-insensitive
	// filesystem (macOS, Windows) `existsSync("document.pdf")` is true for a file
	// actually named `Document.pdf`, and returning the name as typed emits a URL
	// the site never publishes. The index recorded the real casing, so ask it
	// first and fall back to the request only when it has no entry.
	const canonicalOrTyped = (absolutePath: string): string | undefined => {
		const rel = path.relative(docsRoot, absolutePath).replace(/\\/g, "/");
		if (rel.startsWith("..") || path.isAbsolute(rel) || rel.length === 0) return undefined;
		return relativeAsset(absolutePath)?.url ?? encodePath(rel.split("/"));
	};

	const tryRelToFile = path.resolve(path.dirname(currentFilePath), target);
	if (fs.existsSync(tryRelToFile)) {
		const url = canonicalOrTyped(tryRelToFile);
		if (url) return { url, found: true };
	}
	const indexedRelative = relativeAsset(tryRelToFile);
	if (indexedRelative) {
		return indexedRelative;
	}

	const tryRelToRoot = path.resolve(docsRoot, target);
	if (fs.existsSync(tryRelToRoot)) {
		const url = canonicalOrTyped(tryRelToRoot);
		if (url) return { url, found: true };
	}
	const indexedRoot = relativeAsset(tryRelToRoot);
	if (indexedRoot) {
		return indexedRoot;
	}

	// When no path-qualified asset matched, mirror page wikilinks by accepting
	// a unique basename, including nested and case-insensitive attachments.
	const basename = path.basename(normalizeFilePathKey(target));
	const exactBasename = index.byAssetBaseName.get(basename) ?? [];
	if (exactBasename.length === 1 && exactBasename[0]) {
		return { url: exactBasename[0].urlPath, found: true };
	}
	if (enableCaseInsensitiveLookup) {
		const caseInsensitiveBasename = index.byAssetBaseNameCI.get(basename.toLowerCase()) ?? [];
		if (caseInsensitiveBasename.length === 1 && caseInsensitiveBasename[0]) {
			return { url: caseInsensitiveBasename[0].urlPath, found: true };
		}
	}

	const fallback = target.startsWith("/") ? target.slice(1) : target;
	return {
		url: encodePath(fallback.split("/")),
		found: false,
	};
}

// The marker Rspress's built-in GitHub-style alert transform (its internal
// remarkContainerSyntax plugin) uses for the containerDirective nodes it
// creates, and the callout types it claims.
const RSPRESS_CALLOUT_COMPONENT = "$$$callout$$$";
const RSPRESS_CALLOUT_TYPES = new Set([
	"tip",
	"note",
	"warning",
	"caution",
	"danger",
	"info",
	"details",
]);

interface RspressCalloutContainer {
	type: "containerDirective";
	name?: string;
	attributes?: { type?: string; title?: string };
	children: Root["children"];
	position?: { start?: { line?: number }; end?: { line?: number } };
}

interface NodeWithLine {
	position?: { start?: { line?: number }; end?: { line?: number } };
	children?: NodeWithLine[];
}

/**
 * Restore blockquote callouts that Rspress's built-in GitHub-style alert
 * transform has already claimed.
 *
 * Rspress registers remarkContainerSyntax before plugin remark plugins, so
 * `> [!note]` blockquotes for note/tip/warning/caution/danger/info/details
 * arrive here already converted to `$$$callout$$$` containerDirective nodes —
 * with the fold suffix leaked into the content and the first paragraph of
 * multi-paragraph alerts dropped entirely.
 *
 * The converted nodes keep their original source positions, so each one can
 * be verified against the raw source: walk up from its first positioned
 * child through the contiguous `>`-prefixed lines and check that the range
 * starts with a `[!type]` header matching the container's type. That
 * distinguishes GitHub-alert origin from `:::type` containers (whose source
 * lines are not `>`-prefixed), which keep Rspress's native rendering.
 * Verified nodes are replaced with the blockquote re-parsed from the
 * original source — recovering the header, fold state, and any dropped
 * content — and are then transformed by {@link processCallouts} like any
 * other callout.
 */
function restoreHijackedCallouts(tree: Root, source: string): void {
	const sourceLines = source.split(/\r?\n/);

	interface Candidate {
		node: RspressCalloutContainer;
		parent: Parent & { children: Root["children"] };
		startLine: number;
		endLine: number;
	}
	const candidates: Candidate[] = [];
	const parents = new WeakMap<object, Parent>();

	// Collect hijacked containers with the source line range they cover.
	// Only the topmost ones are restored: replacing an outer container
	// re-parses its nested callouts from source too.
	visit(tree, "containerDirective", (rawNode, _position, parent) => {
		const node = rawNode as RspressCalloutContainer;
		if (parent) {
			parents.set(node, parent);
		}
		if (
			!parent ||
			node.name !== RSPRESS_CALLOUT_COMPONENT ||
			!node.attributes?.type ||
			!RSPRESS_CALLOUT_TYPES.has(node.attributes.type)
		) {
			return;
		}

		let startLine = Number.POSITIVE_INFINITY;
		let endLine = 0;
		const scan = (current: NodeWithLine): void => {
			const line = current.position?.start?.line;
			const end = current.position?.end?.line;
			if (typeof line === "number" && line < startLine) {
				startLine = line;
			}
			if (typeof end === "number" && end > endLine) {
				endLine = end;
			}
			for (const child of current.children ?? []) {
				scan(child);
			}
		};
		scan(node);
		if (
			!Number.isFinite(startLine) ||
			endLine <= 0 ||
			startLine > sourceLines.length ||
			endLine > sourceLines.length
		) {
			return;
		}

		// Walk up through the contiguous blockquote lines covering the first
		// positioned child.
		let headerIndex = startLine - 1;
		while (headerIndex > 0 && (sourceLines[headerIndex - 1] ?? "").trimStart().startsWith(">")) {
			headerIndex -= 1;
		}

		const headerLine = (sourceLines[headerIndex] ?? "").replace(/^(?:\s*>+)+\s*/, "");
		const headerMatch = /^\[!(\w+)\]/.exec(headerLine);
		if (!headerMatch || headerMatch[1]?.toLowerCase() !== node.attributes.type) {
			return;
		}

		candidates.push({
			node,
			parent: parent as Parent & { children: Root["children"] },
			startLine: headerIndex + 1,
			endLine,
		});
	});

	for (const candidate of candidates) {
		// Skip candidates nested inside another restored container.
		let ancestor = parents.get(candidate.node);
		let nested = false;
		while (ancestor) {
			if (candidates.some((c) => c.node === ancestor)) {
				nested = true;
				break;
			}
			ancestor = parents.get(ancestor);
		}
		if (nested) {
			continue;
		}

		const blockquoteSource = sourceLines
			.slice(candidate.startLine - 1, candidate.endLine)
			.join("\n");
		// Leading blank lines keep the re-parsed positions aligned with the
		// original source lines.
		const fragment = `${"\n".repeat(candidate.startLine - 1)}${blockquoteSource}`;
		const parsed = unified().use(remarkParse).use(remarkGfm).parse(fragment) as Root;
		if (parsed.children.length === 0) {
			continue;
		}

		const index = candidate.parent.children.indexOf(
			candidate.node as unknown as Root["children"][number],
		);
		if (index < 0) {
			continue;
		}
		candidate.parent.children.splice(index, 1, ...parsed.children);
	}
}

/**
 * Find and process all callout blockquotes in the tree, processing
 * innermost callouts first so that nested callouts are fully resolved
 * before their parent is transformed.
 *
 * Standard unist-util-visit is pre-order (parents before children), which
 * breaks nesting because replacing the outer blockquote removes the inner
 * one from the traversal. This two-phase approach (collect first, then
 * process in reverse) ensures correct nesting order.
 *
 * Header lines are recovered from `source` via node positions rather than
 * from the first text node: inline markdown in a title splits the paragraph
 * into multiple inline nodes, so the text node alone would truncate the
 * title and lose continuation lines.
 */
function processCallouts(
	tree: Root,
	currentPage: ContentPage,
	index: ContentIndex,
	options: NormalizedPluginOptions,
	source: string,
): void {
	interface CalloutEntry {
		bq: Blockquote;
		position: number;
		parent: Parent & { children: Root["children"] };
	}

	const stack: CalloutEntry[] = [];
	const sourceLines = source.split(/\r?\n/);

	// Strip leading blockquote markers (one or more levels) from a source line.
	const stripQuoteMarker = (line: string): string => line.replace(/^(?:\s*>+)+\s*/, "");

	const headerLineOf = (bq: Blockquote): string | undefined => {
		const firstPara = bq.children[0];
		const line = firstPara?.position?.start.line;
		if (typeof line === "number" && line >= 1 && line <= sourceLines.length) {
			return stripQuoteMarker(sourceLines[line - 1] ?? "");
		}

		// Position fallback for synthesized ASTs: use the first text node.
		if (firstPara?.type !== "paragraph") {
			return undefined;
		}
		const firstText = firstPara.children.find((c): c is Text => c.type === "text");
		return firstText?.value.split("\n")[0];
	};

	visit(tree, "blockquote", (node, position, parent) => {
		if (!parent || typeof position !== "number") return;

		const bq = node as Blockquote;
		if (bq.children[0]?.type !== "paragraph") return;

		const headerLine = headerLineOf(bq);
		if (!headerLine || !CALLOUT_HEADER_PATTERN.exec(headerLine)) return;

		stack.push({
			bq,
			position,
			parent: parent as Parent & { children: Root["children"] },
		});
	});

	// Process innermost callouts first so nested ones are resolved before
	// their parent is transformed. post-order ensures child blockquotes are
	// still present in the parent's children when we process the parent.
	for (const { bq, position, parent: parentNode } of stack.reverse()) {
		const firstPara = bq.children[0];
		if (firstPara?.type !== "paragraph") continue;

		const headerLine = headerLineOf(bq);
		const calloutMatch = headerLine ? CALLOUT_HEADER_PATTERN.exec(headerLine) : null;
		if (!calloutMatch) continue;

		const rawType = calloutMatch[1]?.toLowerCase() ?? "note";
		const calloutType = CALLOUT_TYPE_ALIASES[rawType] ?? rawType;
		const foldState = calloutMatch[2];
		const calloutTitle = calloutMatch[3]?.trim() || rawType;

		// Strip the header line from the opening paragraph, keeping any
		// continuation lines as the callout's first content block. The
		// paragraph is rebuilt from source so markdown in the title does not
		// leak into the content (and vice versa).
		const startLine = firstPara.position?.start.line;
		const endLine = firstPara.position?.end.line;
		if (
			typeof startLine === "number" &&
			typeof endLine === "number" &&
			startLine >= 1 &&
			endLine <= sourceLines.length
		) {
			const contentLines = sourceLines.slice(startLine, endLine).map(stripQuoteMarker);
			const reParsed = unified().use(remarkParse).parse(contentLines.join("\n"))
				.children as typeof bq.children;
			// These nodes were parsed from a *fragment*, so their positions are
			// relative to it, not to the document. Handing those offsets to the
			// source-range consumers (comment stripping) would cut the wrong
			// characters, so drop them: the passes that follow either work on node
			// values or rebuild their own positions.
			for (const node of reParsed) {
				dropPositions(node);
			}
			if (reParsed.length === 0) {
				bq.children.shift();
			} else {
				bq.children.splice(0, 1, ...reParsed);
			}
		} else {
			// Fallback for positionless ASTs: operate on the first text node.
			const firstText = firstPara.children.find((c): c is Text => c.type === "text");
			if (!firstText) continue;
			const remainingLines = firstText.value.split("\n").slice(1);
			if (remainingLines.length === 0) {
				bq.children.shift();
			} else {
				firstText.value = remainingLines.join("\n");
			}
		}

		// Obsidian renders callout titles as inline markdown (and resolves
		// wikilinks in them), so render before escaping into the title element.
		const titleHtml = renderCalloutTitleHtml(calloutTitle, currentPage, index, options);

		const replacements: Root["children"] = buildCalloutNodes(
			calloutType,
			titleHtml,
			foldState,
			bq.children as Root["children"],
		);
		parentNode.children.splice(position, 1, ...replacements);
	}
}

/**
 * Build the replacement AST nodes for an Obsidian callout.
 * Foldable callouts (+ expanded, - collapsed) use <details>/<summary>.
 * Static callouts use <div> elements. `titleHtml` must already be
 * renderer-produced HTML (see {@link renderCalloutTitleHtml}), never raw
 * user text.
 */
function buildCalloutNodes(
	calloutType: string,
	titleHtml: string,
	foldState: string | undefined,
	contentChildren: Root["children"],
): Root["children"] {
	const escapedType = escapeHtmlAttribute(calloutType);

	if (foldState) {
		const openAttr = foldState === "+" ? " open" : "";
		const openTag: HTML = {
			type: "html",
			value: `<details class="callout callout-${escapedType}" data-callout="${escapedType}"${openAttr}>`,
		};
		const summaryTag: HTML = {
			type: "html",
			value: `<summary class="callout-title">${titleHtml}</summary>`,
		};
		if (contentChildren.length > 0) {
			return [
				openTag,
				summaryTag,
				{ type: "html", value: '<div class="callout-content">' },
				...contentChildren,
				{ type: "html", value: "</div></details>" },
			];
		}

		return [
			openTag,
			summaryTag,
			{ type: "html", value: '<div class="callout-content"></div></details>' },
		];
	}

	const openDiv: HTML = {
		type: "html",
		value: `<div class="callout callout-${escapedType}" data-callout="${escapedType}">`,
	};
	const titleDiv: HTML = {
		type: "html",
		value: `<div class="callout-title">${titleHtml}</div>`,
	};
	if (contentChildren.length > 0) {
		return [
			openDiv,
			titleDiv,
			{ type: "html", value: '<div class="callout-content">' },
			...contentChildren,
			{ type: "html", value: "</div></div>" },
		];
	}

	return [openDiv, titleDiv, { type: "html", value: '<div class="callout-content"></div></div>' }];
}

/**
 * Render a callout title — a single line of inline markdown — to HTML.
 *
 * Wikilinks inside the title are resolved first so `[[Page|Alias]]` titles
 * link the way they do in Obsidian. remark-rehype runs without
 * `allowDangerousHtml`, so any raw HTML in the title is dropped and text is
 * entity-escaped by rehype-stringify: the returned markup is safe to embed
 * in the title element.
 */
function renderCalloutTitleHtml(
	title: string,
	currentPage: ContentPage,
	index: ContentIndex,
	options: NormalizedPluginOptions,
): string {
	const withLinks = resolveTitleWikilinks(title, currentPage, index, options);

	// ==highlights== are Obsidian syntax, not markdown, so each highlighted
	// span is rendered separately and wrapped in <mark>. Edge whitespace is
	// re-attached around the rendered cores because inline markdown parsing
	// trims it. Skipped when the title contains a code span, where `==` may
	// be literal text.
	if (withLinks.includes("==") && !withLinks.includes("`")) {
		const parts = withLinks.split(/(==[^=]+(?:=[^=]+)*==)/).filter(Boolean);
		const highlighted = parts
			.map((part) => {
				const leading = /^[ \t]+/.exec(part)?.[0] ?? "";
				const trailing = /[ \t]+$/.exec(part)?.[0] ?? "";
				const match = /^==([^=]+(?:=[^=]+)*)==$/.exec(part);
				const core = match?.[1]
					? `<mark>${renderInlineMarkdownHtml(match[1])}</mark>`
					: renderInlineMarkdownHtml(part);
				return `${leading}${core}${trailing}`;
			})
			.join("");
		if (highlighted) {
			return highlighted;
		}
	}

	return renderInlineMarkdownHtml(withLinks) || escapeHtmlText(title);
}

/**
 * Render a single line of inline markdown to HTML. remark-rehype runs
 * without `allowDangerousHtml`, so raw HTML is dropped and text is
 * entity-escaped by rehype-stringify: the result is safe to embed inline.
 */
function renderInlineMarkdownHtml(text: string): string {
	const tree = unified().use(remarkParse).use(remarkGfm).parse(text);
	const processor = unified().use(remarkRehype).use(rehypeStringify);
	const html = processor.stringify(processor.runSync(tree)).trim();

	// A single-line input yields exactly one paragraph; unwrap it so the
	// markup is valid inline content.
	return html
		.replace(/^<p>/, "")
		.replace(/<\/p>\n?$/, "")
		.trim();
}

/**
 * Rewrite every wikilink in a callout title into markdown link syntax so the
 * inline markdown renderer produces a real anchor. Unresolvable wikilinks are
 * left verbatim, matching body-text behaviour.
 */
function resolveTitleWikilinks(
	title: string,
	currentPage: ContentPage,
	index: ContentIndex,
	options: NormalizedPluginOptions,
): string {
	const matches = findWikilinkMatches(title);
	if (matches.length === 0) {
		return title;
	}

	let result = "";
	let cursor = 0;
	for (const match of matches) {
		if (match.start > cursor) {
			result += title.slice(cursor, match.start);
		}

		const parsed = parseWikiLink(match.inner, match.fullMatch);
		const resolved = resolveWikiLink(parsed, {
			currentPage,
			index,
			options: {
				enableFuzzyMatching: options.enableFuzzyMatching,
				enableCaseInsensitiveLookup: options.enableCaseInsensitiveLookup,
			},
		});

		if (resolved.status === "ok" && resolved.href && resolved.label) {
			// Escape bracket characters in the label and markdown-significant
			// characters in the destination so both survive the inline parser.
			const safeLabel = resolved.label.replace(/([[\\]])/g, "\\$1");
			const safeHref = encodeMarkdownDestination(resolved.href);
			result += `[${safeLabel}](${safeHref})`;
		} else {
			result += match.fullMatch;
		}

		cursor = match.end;
	}
	if (cursor < title.length) {
		result += title.slice(cursor);
	}

	return result;
}

/**
 * Percent-encode characters that would terminate a markdown `( destination )`
 * construct, so page routes containing them still parse as one destination.
 */
function encodeMarkdownDestination(href: string): string {
	return href.replace(/[ ()<>\\"[\]]/g, (char) => encodeURIComponent(char));
}
function extractFootnoteSourceMetadata(source: string): FootnoteSourceMetadata {
	const definitions = new Map<string, string>();
	const continuationLineNumbers = new Set<number>();

	for (const match of source.matchAll(FOOTNOTE_DEF_PATTERN)) {
		const label = match[1] ?? "";
		const content = normalizeFootnoteContent(match[2] ?? "");
		if (!label || !content) continue;

		definitions.set(label, content);
		const startLine = source.slice(0, match.index ?? 0).split(/\r?\n/).length;
		const lines = (match[0] ?? "").split(/\r?\n/);
		for (let offset = 1; offset < lines.length; offset += 1) {
			continuationLineNumbers.add(startLine + offset);
		}
	}

	return { definitions, continuationLineNumbers };
}

function normalizeFootnoteContent(content: string): string {
	return content.replace(/\n[ \t]+/g, " ").trim();
}

/** Plain text of a node subtree — the fallback source for a definition the raw
 *  source scan did not catch (an indented or otherwise unusual form). */
function flattenMdastText(nodes: unknown): string {
	if (!Array.isArray(nodes)) return "";
	let out = "";
	for (const node of nodes as { type?: string; value?: string; children?: unknown }[]) {
		if (typeof node?.value === "string" && (node.type === "text" || node.type === "inlineCode")) {
			out += node.value;
		} else if (node?.children) {
			out += flattenMdastText(node.children);
		}
	}
	return out;
}

function renderAllFootnotesHtml(
	defs: Map<string, string>,
	inlineDefs: Array<{ id: string; content: string }>,
	renderContent: (content: string) => string,
): string {
	const items: string[] = [];

	defs.forEach((content, label) => {
		items.push(
			`<li id="fn-${escapeHtmlAttribute(label)}">${renderContent(content)} <a href="#fnref-${escapeHtmlAttribute(label)}">↩</a></li>`,
		);
	});

	for (const { id, content } of inlineDefs) {
		items.push(
			`<li id="fn-${escapeHtmlAttribute(id)}">${renderContent(content)} <a href="#fnref-${escapeHtmlAttribute(id)}">↩</a></li>`,
		);
	}

	if (items.length === 0) return "";

	return `<hr />
<ol class="footnotes">
${items.join("\n")}
</ol>`;
}
