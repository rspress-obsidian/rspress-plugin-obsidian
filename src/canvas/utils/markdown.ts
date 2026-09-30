import { slug } from "github-slugger";
import { marked } from "marked";
import { renderMathHtml } from "../../math.js";
import { MERMAID_BLOCK_CLASS } from "../../mermaid/classes.js";
import { escapeHtmlAttribute, escapeHtmlText, sanitizeUrl } from "../../shared/escape.js";
import { NOTE_MARKDOWN_EXTENSIONS } from "../../shared/extensions.js";
import { AUDIO_EXTS, IMAGE_EXTS, PDF_EXT, VIDEO_EXTS } from "../../shared/media-exts.js";
import { pdfEmbedHtml } from "../../shared/media-html.js";
import { extractNoteSection } from "../../shared/transclusion.js";
import { normalizeAssetKey } from "./asset-key.js";
import { resolveFileRoute } from "./resolver.js";

// Re-exported so the canvas entry keeps owning the URL allowlist it is tested
// against; the implementation lives in the shared escaping module because the
// Dataview renderers need the same guarantee.
export { sanitizeUrl };

// A trailing `.something` only counts as a file extension when it is short and
// alphanumeric. Obsidian note titles are ordinary prose, so `[[Chapter 1.
// Introduction]]` must read as a note name and not as a file called
// `Chapter 1` with extension `. introduction` — which silently downgraded the
// embed to a plain link.
const NOTE_FILE_EXTENSION_RE = /\.[a-z0-9]{1,8}$/i;

export interface MarkdownOptions {
	fileRoutePrefix?: string;
	assets?: Record<string, string>;
	notes?: Record<string, string>;
	depth?: number;
}

interface Replacement {
	token: string;
	html: string;
}

interface Footnote {
	id: string;
	content: string;
}

// A fenced code block, with the closing fence matching the opening marker.
const FENCE_RE = /^([ \t]{0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n?[ \t]*\2[ \t]*$/gm;

// Inline math: `$...$` with no adjacent whitespace inside the delimiters.
const INLINE_MATH_RE = /\$(?!\s)([^$\n]+?)(?<!\s)\$/g;
// Display math: `$$...$$`.
const DISPLAY_MATH_RE = /\$\$([\s\S]+?)\$\$/g;

// Obsidian highlight: `==text==`, where a single `=` may appear inside the
// span; a bare run like `====` is left alone. Mirrors `HIGHLIGHT_PATTERN` in
// the Markdown plugin so a card and a note page agree on where a span ends.
const HIGHLIGHT_RE = /==([^=]+(?:=[^=]+)*)==/g;

// Obsidian tags: `#tag` or `#nested/tag`, not preceded by a word char, `[`, or `/`.
const TAG_RE = /(^|[\s([>])(#(?:[A-Za-z0-9_-]+\/?)+)(?![\w/])/g;

// Footnote block definition: `[^id]: content`.
const FOOTNOTE_DEF_RE = /^\[\^([^\]]+)\]:[ \t]*([^\n]+)$/gm;
// Footnote inline reference: `[^id]`.
const FOOTNOTE_REF_RE = /\[\^([^\]]+)\]/g;

function splitTarget(value: string): { file: string; subpath?: string } {
	const hashIndex = value.indexOf("#");
	if (hashIndex === -1) return { file: value.trim() };
	return {
		file: value.slice(0, hashIndex).trim(),
		subpath: value.slice(hashIndex),
	};
}

function resolveWikiLinkTarget(value: string, prefix?: string): string {
	const { file, subpath } = splitTarget(value);
	const filePath = NOTE_FILE_EXTENSION_RE.test(file) ? file : `${file}.md`;
	return anchorHref(resolveFileRoute(filePath, prefix), subpath);
}

/**
 * Append a `#Heading` or `#^block` subpath to a note route.
 *
 * Headings have to be slugified the same way the note page slugifies its own
 * `## Getting Started`, or the fragment matches nothing and the browser lands
 * at the top of the page. Block references keep their `^` and are encoded as-is.
 */
export function anchorHref(route: string, subpath?: string): string {
	if (!subpath) return route;
	const anchor = subpath.slice(1);
	if (anchor.startsWith("^")) return `${route}#${encodeURIComponent(anchor)}`;
	return `${route}#${slug(anchor)}`;
}

function resolveAssetUrl(target: string, options: MarkdownOptions): string {
	const asset = options.assets?.[normalizeAssetKey(target)];
	return asset || resolveFileRoute(splitTarget(target).file, options.fileRoutePrefix);
}

function createReplacement(replacements: Replacement[], html: string): string {
	const token = `OBS_CANVAS_REPLACEMENT_${replacements.length}`;
	replacements.push({ token, html });
	return token;
}

/** `renderMathHtml` returns null when KaTeX cannot render; show the raw TeX instead. */
function renderMath(tex: string, displayMode: boolean): string {
	return (
		renderMathHtml(tex, displayMode) ??
		`<span class="canvas-math-error">${escapeHtmlAttribute(tex)}</span>`
	);
}

/** Split markdown into prose and fenced-code segments; fences stay intact. */
function splitByFences(text: string): Array<{ type: "prose" | "code"; text: string }> {
	const segments: Array<{ type: "prose" | "code"; text: string }> = [];
	let last = 0;
	for (const match of text.matchAll(FENCE_RE)) {
		const index = match.index ?? 0;
		if (index > last) segments.push({ type: "prose", text: text.slice(last, index) });
		segments.push({ type: "code", text: match[0] });
		last = index + match[0].length;
	}
	if (last < text.length) segments.push({ type: "prose", text: text.slice(last) });
	if (segments.length === 0) segments.push({ type: "prose", text });
	return segments;
}

function collectFootnoteDefinitions(text: string, footnotes: Footnote[]): string {
	const knownIds = new Set(footnotes.map((footnote) => footnote.id));
	return text.replace(FOOTNOTE_DEF_RE, (_match, rawId: string, rawContent: string) => {
		const id = rawId.trim();
		if (!knownIds.has(id)) {
			footnotes.push({ id, content: rawContent.trim() });
			knownIds.add(id);
		}
		return "";
	});
}

function resolveFootnoteReferences(
	text: string,
	replacements: Replacement[],
	footnotes: Footnote[],
): string {
	const knownIds = new Set(footnotes.map((footnote) => footnote.id));
	return text.replace(FOOTNOTE_REF_RE, (_match, rawId: string) => {
		const id = rawId.trim();
		if (!knownIds.has(id)) return _match;
		const index = footnotes.findIndex((footnote) => footnote.id === id) + 1;
		return createReplacement(
			replacements,
			`<sup class="canvas-footnote-ref" id="canvas-fnref-${index}"><a href="#canvas-fn-${index}">${index}</a></sup>`,
		);
	});
}

/**
 * Footnote inline form: `^[content]`.
 *
 * The content may hold brackets of its own — a wikilink, a Markdown link label —
 * so the closing bracket is found by depth rather than by the first `]`, and the
 * content is handed to the same renderer the label footnotes use. Runs after the
 * code-span and math replacements, so an opener inside either is already a token.
 */
function processInlineFootnotes(
	text: string,
	replacements: Replacement[],
	footnotes: Footnote[],
): string {
	let result = "";
	let cursor = 0;

	while (cursor < text.length) {
		const start = text.indexOf("^[", cursor);
		if (start === -1) break;
		const end = findClosingBracket(text, start + 1);
		if (end === -1) break;

		const content = text.slice(start + 2, end);
		result += text.slice(cursor, start);
		footnotes.push({ id: `inline-${footnotes.length + 1}`, content });
		const index = footnotes.length;
		result += createReplacement(
			replacements,
			`<sup class="canvas-footnote-ref" id="canvas-fnref-${index}"><a href="#canvas-fn-${index}">${index}</a></sup>`,
		);
		cursor = end + 1;
	}

	return result + text.slice(cursor);
}

/** Index of the `]` closing the `[` at `openIndex`, or -1 when unbalanced. */
function findClosingBracket(text: string, openIndex: number): number {
	let depth = 0;
	for (let index = openIndex; index < text.length; index += 1) {
		if (text[index] === "[") depth += 1;
		else if (text[index] === "]") {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return -1;
}

function processEmbeds(
	text: string,
	replacements: Replacement[],
	options: MarkdownOptions,
): string {
	return text.replace(/!\[\[([^\]]+)\]\]/g, (_match, rawTarget: string) => {
		const parts = rawTarget.split("|");
		const target = parts[0]?.trim() || "";
		// Obsidian size syntax: `![[image.png|300]]` or `![[image.png|300x200]]`.
		// A trailing pipe value that is a bare dimension is a size, not an alias.
		let altText = target;
		let sizeStyle = "";
		if (parts.length > 1) {
			const rest = parts.slice(1).join("|").trim();
			const sizeMatch = rest.match(/^(\d+)(?:x(\d+))?$/i);
			if (sizeMatch) {
				const width = Number(sizeMatch[1]);
				const height = sizeMatch[2] ? Number(sizeMatch[2]) : undefined;
				sizeStyle = height ? `width:${width}px;height:${height}px;` : `width:${width}px;`;
			} else if (rest) {
				altText = rest;
			}
		}

		const cleanAlt = altText;
		const targetInfo = splitTarget(target);
		const targetExtension = targetInfo.file.toLowerCase().match(NOTE_FILE_EXTENSION_RE)?.[0] || "";
		const noteFile = targetExtension ? targetInfo.file : `${targetInfo.file}.md`;
		const note = options.notes?.[normalizeAssetKey(noteFile)];

		if (note && (targetExtension === "" || NOTE_MARKDOWN_EXTENSIONS.has(targetExtension))) {
			if ((options.depth || 0) >= 2) {
				const href = sanitizeUrl(resolveWikiLinkTarget(target, options.fileRoutePrefix));
				return href
					? createReplacement(
							replacements,
							`<a href="${escapeHtmlAttribute(href)}" class="obsidian-embed-note">${escapeHtmlAttribute(cleanAlt)}</a>`,
						)
					: escapeHtmlAttribute(cleanAlt);
			}
			// A `![[Note#Heading]]` inside a card slices the note with the same
			// rules the build-time transclusion pass uses, rather than inlining
			// the whole note and dropping the fragment.
			const section = extractNoteSection(note, targetInfo.subpath);
			const embeddedNote = renderMarkdown(section ?? note, {
				...options,
				depth: (options.depth || 0) + 1,
			});
			return createReplacement(
				replacements,
				`<div class="obsidian-embed-note">${embeddedNote}</div>`,
			);
		}

		const extension = targetInfo.file.toLowerCase().split(".").pop() || "";
		// A subpath is resolved against the file, not the whole link: the asset
		// map keys attachments by file name, so `doc.pdf#page=3` has to find
		// `doc.pdf` before the fragment goes back on.
		const url = sanitizeUrl(
			resolveAssetUrl(targetInfo.subpath ? targetInfo.file : target, options),
		);
		if (!url) return escapeHtmlAttribute(cleanAlt);
		const safeTarget = escapeHtmlAttribute(target);
		const subpath = (targetInfo.subpath ?? "").slice(1);
		// Obsidian puts a PDF's two knobs in the subpath, and the markdown
		// pipeline reads them there: `#page=3` opens the viewer at a page, so it
		// stays in the URL, and `#height=400` sizes the frame, so it is a
		// property of this embed and never travels to the file. Only one of the
		// two is a subpath Obsidian writes, never both.
		const pdfKnob = extension === PDF_EXT ? subpath : "";
		const pdfPage = pdfKnob.match(/^page=(\d+)$/i)?.[1];
		const pdfHeight = pdfKnob.match(/^height=(\d+)$/i)?.[1];
		// Any other subpath rides along verbatim, the way it does in a note.
		const fragment = pdfPage ? `#page=${pdfPage}` : pdfKnob ? "" : subpath ? `#${subpath}` : "";
		const safeUrl = escapeHtmlAttribute(`${url}${fragment}`);
		const sizeAttr = sizeStyle ? ` style="${sizeStyle}"` : "";
		if (IMAGE_EXTS.has(extension)) {
			return createReplacement(
				replacements,
				`<img src="${safeUrl}" alt="${escapeHtmlAttribute(cleanAlt)}"${sizeAttr} class="obsidian-embed-image">`,
			);
		}
		if (AUDIO_EXTS.has(extension)) {
			return createReplacement(
				replacements,
				`<audio controls src="${safeUrl}" title="${safeTarget}"${sizeAttr}></audio>`,
			);
		}
		if (VIDEO_EXTS.has(extension)) {
			return createReplacement(
				replacements,
				`<video controls src="${safeUrl}" title="${safeTarget}"${sizeAttr}></video>`,
			);
		}
		if (extension === PDF_EXT) {
			// The same figure-with-a-caption-bar a note gets, from the same builder,
			// so a card and a page never disagree about how a PDF looks. A size pipe
			// on the embed wins over the subpath height, as it does everywhere else,
			// and keeps the trailing semicolon the other card embeds use.
			return createReplacement(
				replacements,
				pdfEmbedHtml({
					src: `${url}${fragment}`,
					target,
					page: pdfPage,
					height: Number(pdfHeight ?? 600),
					style: sizeStyle || undefined,
				}),
			);
		}
		return createReplacement(
			replacements,
			`<a href="${safeUrl}" class="obsidian-embed-link">${escapeHtmlAttribute(cleanAlt)}</a>`,
		);
	});
}

function processWikiLinks(
	text: string,
	replacements: Replacement[],
	options: MarkdownOptions,
): string {
	return text.replace(
		/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
		(_match, rawTarget: string, rawLabel?: string) => {
			const target = rawTarget.trim();
			const label = rawLabel?.trim() || splitTarget(target).file.split("/").pop() || target;
			const href = sanitizeUrl(resolveWikiLinkTarget(target, options.fileRoutePrefix));
			if (!href) return escapeHtmlAttribute(label);
			return createReplacement(
				replacements,
				`<a href="${escapeHtmlAttribute(href)}" class="wiki-link">${escapeHtmlAttribute(label)}</a>`,
			);
		},
	);
}

function preprocessObsidianSyntax(
	text: string,
	options: MarkdownOptions,
): {
	text: string;
	replacements: Replacement[];
	footnotes: Footnote[];
} {
	const replacements: Replacement[] = [];
	const footnotes: Footnote[] = [];

	const segments = splitByFences(text);

	// First pass: collect every footnote definition so references that appear
	// before their definition (or after a code fence) still resolve.
	for (const segment of segments) {
		if (segment.type !== "prose") continue;
		segment.text = collectFootnoteDefinitions(segment.text, footnotes);
	}

	let result = "";
	for (const segment of segments) {
		if (segment.type === "code") {
			result += segment.text;
			continue;
		}

		let prose = segment.text;

		// Protect inline code spans before any other inline processing.
		prose = prose.replace(/`([^`\n]+)`/g, (_match, code: string) =>
			createReplacement(replacements, `<code>${escapeHtmlAttribute(code)}</code>`),
		);

		// Obsidian highlights. Same pattern and same `====` exemption as the
		// Markdown plugin, so a card and a note page agree on where a span ends.
		prose = prose.replace(HIGHLIGHT_RE, (_match, inner: string) =>
			createReplacement(replacements, `<mark>${escapeHtmlText(inner)}</mark>`),
		);

		// Display math before inline math so `$$` is not split.
		prose = prose.replace(DISPLAY_MATH_RE, (_match, tex: string) =>
			createReplacement(
				replacements,
				`<div class="canvas-math-display">${renderMath(tex, true)}</div>`,
			),
		);
		prose = prose.replace(INLINE_MATH_RE, (_match, tex: string) =>
			createReplacement(replacements, `<span class="canvas-math">${renderMath(tex, false)}</span>`),
		);
		prose = processInlineFootnotes(prose, replacements, footnotes);
		prose = resolveFootnoteReferences(prose, replacements, footnotes);
		prose = processEmbeds(prose, replacements, options);
		prose = processWikiLinks(prose, replacements, options);

		result += prose;
	}

	return { text: result, replacements, footnotes };
}

function createRenderer(options: MarkdownOptions) {
	const renderer = new marked.Renderer();
	renderer.html = ({ text }) => escapeHtmlAttribute(text);
	renderer.link = function ({ href, title, tokens }) {
		const safeHref = sanitizeUrl(href);
		const linkText = this.parser.parseInline(tokens);
		if (!safeHref) return linkText;
		const titleAttribute = title ? ` title="${escapeHtmlAttribute(title)}"` : "";
		return `<a href="${escapeHtmlAttribute(safeHref)}"${titleAttribute}>${linkText}</a>`;
	};
	renderer.image = function ({ href, title, text, tokens }) {
		const assetUrl = options.assets?.[normalizeAssetKey(href)] || href;
		const safeHref = sanitizeUrl(assetUrl);
		const altText = tokens ? this.parser.parseInline(tokens, this.parser.textRenderer) : text;
		if (!safeHref) return escapeHtmlAttribute(altText);
		const titleAttribute = title ? ` title="${escapeHtmlAttribute(title)}"` : "";
		return `<img src="${escapeHtmlAttribute(safeHref)}" alt="${escapeHtmlAttribute(altText)}"${titleAttribute}>`;
	};
	renderer.code = ({ text: code, lang }) => {
		if (lang?.toLowerCase() === "mermaid") {
			const placeholder = escapeHtmlAttribute(code);
			return `<pre class="${MERMAID_BLOCK_CLASS}" data-code="${placeholder}">${placeholder}</pre>\n`;
		}
		const clean = code.replace(/\n$/, "");
		const className = lang ? ` class="language-${escapeHtmlAttribute(lang)}"` : "";
		return `<pre><code${className}>${escapeHtmlAttribute(clean)}\n</code></pre>\n`;
	};
	renderer.blockquote = function (token) {
		const headerMatch = token.text.match(/^\[!([A-Za-z]+)\][^\n]*(?:\n|$)/);
		if (!headerMatch) {
			return `<blockquote>\n${this.parser.parse(token.tokens)}</blockquote>\n`;
		}
		const type = (headerMatch[1] ?? "note").toLowerCase();
		const title =
			headerMatch[0]
				.replace(/^\[![A-Za-z]+\]\s*/, "")
				.replace(/\n$/, "")
				.trim() || type;
		const body = token.text.slice(headerMatch[0].length);
		const bodyHtml = body ? renderMarkdown(body, options) : "";
		return `<div class="canvas-callout canvas-callout-${type}"><div class="canvas-callout-title">${escapeHtmlAttribute(title)}</div><div class="canvas-callout-body">${bodyHtml}</div></div>\n`;
	};
	renderer.text = function (token) {
		// Paragraph-level text carries nested inline tokens (strong/em/code);
		// delegate so they render through the same renderer. Leaf text is
		// escaped and tag-ified directly.
		if ("tokens" in token && token.tokens) {
			return this.parser.parseInline(token.tokens);
		}
		return escapeHtmlAttribute(token.text).replace(
			TAG_RE,
			(_match, prefix: string, tag: string) =>
				`${prefix}<span class="canvas-tag">${escapeHtmlAttribute(tag)}</span>`,
		);
	};
	return renderer;
}

function renderFootnoteContent(content: string, options: MarkdownOptions): string {
	const preprocessed = preprocessObsidianSyntax(content, options);
	let html = marked.parseInline(preprocessed.text, {
		gfm: true,
		breaks: true,
		renderer: createRenderer(options),
		async: false,
	}) as string;
	for (const replacement of preprocessed.replacements) {
		html = html.replaceAll(replacement.token, replacement.html);
	}
	return html;
}

function renderFootnotes(footnotes: Footnote[], options: MarkdownOptions): string {
	if (footnotes.length === 0) return "";
	const items = footnotes
		.map(
			(footnote, index) =>
				`<li id="canvas-fn-${index + 1}"><p>${renderFootnoteContent(footnote.content, options)} <a href="#canvas-fnref-${index + 1}" class="canvas-footnote-backref" aria-label="Back to content">↩</a></p></li>`,
		)
		.join("\n");
	return `<section class="canvas-footnotes" role="doc-endnotes"><ol>${items}</ol></section>`;
}

export function renderMarkdown(text: string, options: MarkdownOptions = {}): string {
	if (!text) return "";
	const preprocessed = preprocessObsidianSyntax(text, options);
	const renderer = createRenderer(options);
	let html = marked.parse(preprocessed.text, {
		gfm: true,
		breaks: true,
		renderer,
		async: false,
	}) as string;
	for (const replacement of preprocessed.replacements) {
		html = html.replaceAll(replacement.token, replacement.html);
	}
	html += renderFootnotes(preprocessed.footnotes, options);
	return html;
}
