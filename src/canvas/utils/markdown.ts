import { slug } from "github-slugger";
import { Lexer, Marked, Parser, type Token, type Tokens } from "marked";
import { parseWikiLink } from "../../markdown/parse-wikilink.js";
import type { ParsedWikiLink } from "../../markdown/types.js";
import { MERMAID_BLOCK_CLASS } from "../../mermaid/classes.js";
import { escapeHtmlAttribute, escapeHtmlText, sanitizeUrl } from "../../shared/escape.js";
import { NOTE_MARKDOWN_EXTENSIONS } from "../../shared/extensions.js";
import {
	AUDIO_EXTS,
	extensionOf,
	IMAGE_EXTS,
	PDF_EXT,
	VIDEO_EXTS,
} from "../../shared/media-exts.js";
import { pdfEmbedHtml } from "../../shared/media-html.js";
import { INLINE_TAG_PATTERN, tagNameFromMatch } from "../../shared/paths.js";
import { extractNoteSection } from "../../shared/transclusion.js";
import type { CanvasLink, CanvasLinks } from "../types.js";
import { canvasLinkKey, normalizeAssetKey } from "./asset-key.js";
import { withSiteBase } from "./base.js";
import { resolveFileRoute } from "./resolver.js";

// Re-exported so the canvas entry keeps owning the URL allowlist it is tested
// against; the implementation lives in the shared escaping module because the
// Dataview renderers need the same guarantee.
export { sanitizeUrl };

export interface MarkdownOptions {
	/** Build-time resolution of every link and embed target, per scope. */
	links?: CanvasLinks;
	/** Which `links` scope the text was written in: `""` for a text card. */
	scope?: string;
	/** Note bodies keyed by {@link normalizeAssetKey}. */
	notes?: Record<string, string>;
	/** Attachment URLs (without the site base) keyed by {@link normalizeAssetKey}. */
	assets?: Record<string, string>;
	/** The site base; defaults to the one the build injected. */
	base?: string;
	/** Route prefix for targets the build did not resolve. */
	fileRoutePrefix?: string;
	/** Transclusion depth; embeds degrade to links at depth 2. */
	depth?: number;
	/** Unique per card instance, so footnote ids never collide on one board. */
	idPrefix?: string;
}

export interface MarkdownTargets {
	wikilinks: { target: string; embed: boolean }[];
	urls: string[];
}

// A trailing `.something` only counts as a file extension when it is short and
// alphanumeric. Obsidian note titles are ordinary prose, so `[[Chapter 1.
// Introduction]]` must read as a note name and not as a file called
// `Chapter 1` with extension `. introduction` — which silently downgraded the
// embed to a plain link.
const NOTE_FILE_EXTENSION_RE = /\.[a-z0-9]{1,8}$/i;

// Obsidian highlight: `==text==`, where a single `=` may appear inside the
// span; a bare run like `====` is left alone. Mirrors `HIGHLIGHT_PATTERN` in
// the Markdown plugin so a card and a note page agree on where a span ends.
const HIGHLIGHT_RE = /^==([^=]+(?:=[^=]+)*)==/;

// Inline math: `$...$` with no adjacent whitespace inside the delimiters and no
// digit straight after the closing one, so `$5 and $6` stays prose. Neither
// form may hold a backtick: code spans are lexed after this extension, and a
// `$` inside one must not pair with a `$` outside it.
const INLINE_MATH_RE = /^\$(?!\s)([^$\n`]+?)(?<!\s)\$(?!\d)/;
// Display math written inline: `$$...$$`.
const DISPLAY_MATH_RE = /^\$\$([^`]+?)\$\$/;
// Display math as its own block. The start finder uses the whole pattern, not
// just `$$`, because cutting a paragraph at a `$$` that turns out not to open a
// block would split it in two.
const MATH_BLOCK_RE = /^ {0,3}\$\$([\s\S]+?)\$\$[ \t]*(?:\n+|$)/;
const MATH_BLOCK_START_RE = /^ {0,3}\$\$[\s\S]+?\$\$[ \t]*$/m;

const FOOTNOTE_DEF_RE = /^\[\^([^\]\n]+)\]:[ \t]*([^\n]*)(?:\n+|$)/;
const FOOTNOTE_DEF_START_RE = /^\[\^[^\]\n]+\]:/m;
const FOOTNOTE_REF_RE = /^\[\^([^\]\n]+)\]/;

const CALLOUT_RE = /^ {0,3}> ?\[!([\w-]+)\]([+-]?)[ \t]*([^\n]*)/;
// marked's own GFM blockquote pattern, lazy continuation lines included, so a
// callout ends exactly where the blockquote it replaces would have.
const BLOCKQUOTE_RE = Lexer.rules.block.gfm.blockquote;

// Obsidian renders sanitized HTML. Attribute-less tags from this list cannot
// run script, so they render as written; every other tag, any tag carrying
// attributes, and every comment is shown as text.
const ALLOWED_HTML_TAGS: Record<string, true> = {
	u: true,
	br: true,
	sub: true,
	sup: true,
	kbd: true,
	mark: true,
	s: true,
	del: true,
	ins: true,
	small: true,
	b: true,
	i: true,
	em: true,
	strong: true,
	details: true,
	summary: true,
	abbr: true,
	span: true,
	div: true,
	p: true,
	hr: true,
	center: true,
	ul: true,
	ol: true,
	li: true,
	blockquote: true,
	code: true,
	pre: true,
};
const HTML_PIECE_RE = /<!--[\s\S]*?(?:-->|$)|<(\/?)([a-zA-Z][a-zA-Z0-9]*)\s*(\/?)>/g;

const SIZE_RE = /^(\d+)(?:x(\d+))?$/i;
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
// The `(destination "title")` half of an inline link or image.
const LINK_TAIL_RE =
	/^\(\s*(<[^<>\n]*>|[^\s()<>]*(?:\([^\s()]*\)[^\s()<>]*)*)(?:\s+("[^"]*"|'[^']*'|\([^()]*\)))?\s*\)/;

interface WikilinkToken extends Tokens.Generic {
	type: "wikilink";
	/** The part before the first unescaped `|`, as written: the `links` key. */
	target: string;
	parsed: ParsedWikiLink;
	embed: boolean;
}

interface MathToken extends Tokens.Generic {
	type: "math" | "mathBlock";
	tex: string;
	display: boolean;
}

interface FootnoteDefToken extends Tokens.Generic {
	type: "footnoteDef";
	id: string;
	tokens: Token[];
}

interface FootnoteRefToken extends Tokens.Generic {
	type: "footnoteRef";
	id: string;
}

interface CalloutToken extends Tokens.Generic {
	type: "callout";
	calloutType: string;
	fold: "" | "+" | "-";
	titleTokens: Token[];
	tokens: Token[];
}

/** Per-render state. Rendering is synchronous, so one active context suffices. */
interface RenderContext {
	options: MarkdownOptions;
	scope: string;
	idPrefix: string;
	definitions: Map<string, Token[]>;
	/** Footnote number by label, assigned at first reference. */
	labelNumbers: Map<string, number>;
	/** Content of footnote N at index N-1, labelled and inline alike. */
	footnotes: Token[][];
	/** Inside link text: tags there are part of the label, not tags. */
	linkDepth: number;
	embedCount: number;
}

let current: RenderContext | undefined;

function context(): RenderContext {
	if (!current) throw new Error("canvas markdown rendered outside renderMarkdown");
	return current;
}

/** Index of the `]]` closing a wikilink opened at `start`, honouring `\` escapes. */
function wikilinkEnd(src: string, start: number): number {
	for (let index = start; index < src.length - 1; index += 1) {
		const char = src[index];
		if (char === "\\") {
			index += 1;
			continue;
		}
		if (char === "\n") return -1;
		if (char === "]" && src[index + 1] === "]") return index + 2;
	}
	return -1;
}

function unescapedIndex(input: string, delimiter: string): number {
	for (let index = 0; index < input.length; index += 1) {
		if (input[index] === "\\") index += 1;
		else if (input[index] === delimiter) return index;
	}
	return -1;
}

/** Index of the `]` closing the `[` at `openIndex`, or -1 when unbalanced. */
function closingBracket(text: string, openIndex: number): number {
	let depth = 0;
	for (let index = openIndex; index < text.length; index += 1) {
		const char = text[index];
		if (char === "\\") index += 1;
		else if (char === "[") depth += 1;
		else if (char === "]") {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return -1;
}

function tokenizeWikilink(src: string, embed: boolean): WikilinkToken | undefined {
	const open = embed ? 3 : 2;
	if (!src.startsWith(embed ? "![[" : "[[")) return undefined;
	const end = wikilinkEnd(src, open);
	if (end < 0) return undefined;
	const inner = src.slice(open, end - 2);
	if (!inner.trim()) return undefined;
	const raw = src.slice(0, end);
	const pipe = unescapedIndex(inner, "|");
	return {
		type: "wikilink",
		raw,
		target: pipe >= 0 ? inner.slice(0, pipe) : inner,
		parsed: parseWikiLink(inner, raw),
		embed,
	};
}

function subpathOf(parsed: ParsedWikiLink): string | undefined {
	if (!parsed.subpath) return undefined;
	return `#${parsed.subpath.kind === "block" ? "^" : ""}${parsed.subpath.value}`;
}

/** Obsidian's default link text: the file's name, without its folders. */
function fileLabel(token: WikilinkToken): string {
	return token.parsed.target.split("/").pop() || token.target.trim();
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

/** The route a target gets when the build supplied no entry for it. */
function legacyRoute(file: string, subpath: string | undefined, prefix?: string): string {
	const filePath = NOTE_FILE_EXTENSION_RE.test(file) ? file : `${file}.md`;
	return anchorHref(resolveFileRoute(filePath, prefix), subpath);
}

function lookup(c: RenderContext, target: string): CanvasLink | undefined {
	return c.options.links?.[c.scope]?.[canvasLinkKey(target)];
}

function unresolvedHtml(labelHtml: string): string {
	return `<span class="canvas-unresolved-link">${labelHtml}</span>`;
}

function routeLinkHtml(c: RenderContext, route: string, label: string, className: string): string {
	const href = sanitizeUrl(withSiteBase(route, c.options.base));
	if (!href) return escapeHtmlText(label);
	return `<a href="${escapeHtmlAttribute(href)}" class="${className}" data-href="${escapeHtmlAttribute(route)}">${escapeHtmlText(label)}</a>`;
}

function renderWikilink(token: WikilinkToken): string {
	const c = context();
	const entry = lookup(c, token.target);
	const label = token.parsed.alias ?? entry?.label ?? fileLabel(token);
	if (entry) {
		const asset = entry.asset ? c.options.assets?.[entry.asset] : undefined;
		const route = entry.href ?? asset;
		return route
			? routeLinkHtml(c, route, label, "wiki-link")
			: unresolvedHtml(escapeHtmlText(label));
	}
	const route = legacyRoute(
		token.parsed.target,
		subpathOf(token.parsed),
		c.options.fileRoutePrefix,
	);
	return routeLinkHtml(c, route, label, "wiki-link");
}

interface EmbedShape {
	target: string;
	subpath: string | undefined;
	alt: string;
	sizeStyle: string;
}

function renderMedia(c: RenderContext, url: string, extension: string, shape: EmbedShape): string {
	const safe = sanitizeUrl(withSiteBase(url, c.options.base));
	if (!safe) return escapeHtmlText(shape.alt);
	const subpath = (shape.subpath ?? "").slice(1);
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
	const src = escapeHtmlAttribute(`${safe}${fragment}`);
	const title = escapeHtmlAttribute(shape.target);
	const sizeAttr = shape.sizeStyle ? ` style="${shape.sizeStyle}"` : "";
	if (IMAGE_EXTS.has(extension)) {
		return `<img src="${src}" alt="${escapeHtmlAttribute(shape.alt)}"${sizeAttr} class="obsidian-embed-image">`;
	}
	if (AUDIO_EXTS.has(extension)) {
		return `<audio controls src="${src}" title="${title}"${sizeAttr}></audio>`;
	}
	if (VIDEO_EXTS.has(extension)) {
		return `<video controls src="${src}" title="${title}"${sizeAttr}></video>`;
	}
	if (extension === PDF_EXT) {
		// The same figure-with-a-caption-bar a note gets, from the same builder,
		// so a card and a page never disagree about how a PDF looks. A size pipe
		// on the embed wins over the subpath height, as it does everywhere else.
		return pdfEmbedHtml({
			src: `${safe}${fragment}`,
			target: shape.target,
			page: pdfPage,
			height: Number(pdfHeight ?? 600),
			style: shape.sizeStyle || undefined,
		});
	}
	return `<a href="${src}" class="obsidian-embed-link">${escapeHtmlText(shape.alt)}</a>`;
}

function renderTransclusion(
	c: RenderContext,
	body: string,
	scope: string,
	subpath: string | undefined,
	route: string | undefined,
	label: string,
): string {
	const depth = c.options.depth ?? 0;
	if (depth >= 2) {
		return route
			? routeLinkHtml(c, route, label, "obsidian-embed-note")
			: unresolvedHtml(escapeHtmlText(label));
	}
	c.embedCount += 1;
	// A `![[Note#Heading]]` slices the note with the same rules the build-time
	// transclusion pass uses. The body is rendered in the note's own scope,
	// because its relative links mean something different from the card's.
	const html = renderMarkdown(extractNoteSection(body, subpath) ?? body, {
		...c.options,
		scope,
		depth: depth + 1,
		idPrefix: `${c.idPrefix}embed-${c.embedCount}-`,
	});
	return `<div class="obsidian-embed-note">${html}</div>`;
}

function renderEmbed(token: WikilinkToken): string {
	const c = context();
	const { parsed } = token;
	const target = token.target.trim();
	const subpath = subpathOf(parsed);
	// Obsidian size syntax: `![[image.png|300]]` or `![[image.png|300x200]]`.
	// A pipe value that is a bare dimension is a size, not an alias.
	const size = parsed.alias?.match(SIZE_RE);
	const alias = size ? undefined : parsed.alias;
	const width = size ? Number(size[1]) : 0;
	const height = size?.[2] ? Number(size[2]) : 0;
	const shape: EmbedShape = {
		target,
		subpath,
		alt: alias ?? target,
		sizeStyle: !size ? "" : height ? `width:${width}px;height:${height}px;` : `width:${width}px;`,
	};
	const options = c.options;
	const entry = lookup(c, token.target);

	if (entry) {
		const label = alias ?? entry.label ?? fileLabel(token);
		const note = entry.note ? options.notes?.[entry.note] : undefined;
		if (entry.note && note !== undefined) {
			return renderTransclusion(c, note, entry.note, subpath, entry.href, label);
		}
		const asset = entry.asset ? options.assets?.[entry.asset] : undefined;
		if (entry.asset && asset) return renderMedia(c, asset, extensionOf(entry.asset), shape);
		if (entry.href) return routeLinkHtml(c, entry.href, label, "obsidian-embed-link");
		return unresolvedHtml(escapeHtmlText(label));
	}

	// No entry: a map built before this target existed, or a library caller
	// with no map at all. Resolve the way the renderer always has.
	const file = parsed.target;
	const asset = options.assets?.[normalizeAssetKey(file)];
	if (asset) return renderMedia(c, asset, extensionOf(file), shape);
	const noteExtension = file.match(NOTE_FILE_EXTENSION_RE)?.[0]?.toLowerCase() ?? "";
	const noteKey = normalizeAssetKey(noteExtension ? file : `${file}.md`);
	const note = options.notes?.[noteKey];
	if (note !== undefined && (noteExtension === "" || NOTE_MARKDOWN_EXTENSIONS.has(noteExtension))) {
		const route = legacyRoute(file, subpath, options.fileRoutePrefix);
		return renderTransclusion(c, note, noteKey, subpath, route, alias ?? fileLabel(token));
	}
	return renderMedia(c, resolveFileRoute(file, options.fileRoutePrefix), extensionOf(file), shape);
}

/** A markdown href is vault-relative unless it names a scheme, a host or a fragment. */
function isVaultRelative(href: string): boolean {
	return !SCHEME_RE.test(href) && !href.startsWith("//") && !href.startsWith("#");
}

/** The URL a markdown link or image points at, or `null` for a known-unresolved target. */
function resolveMarkdownUrl(c: RenderContext, href: string): string | null {
	if (!isVaultRelative(href)) return href;
	const entry = lookup(c, href);
	if (entry) {
		if (entry.href) return withSiteBase(entry.href, c.options.base);
		const asset = entry.asset ? c.options.assets?.[entry.asset] : undefined;
		return asset ? withSiteBase(asset, c.options.base) : null;
	}
	return withSiteBase(c.options.assets?.[normalizeAssetKey(href)] || href, c.options.base);
}

/** Plain text of inline tokens, for attributes such as `alt`. */
function plainText(tokens: Token[]): string {
	let text = "";
	for (const token of tokens) {
		switch (token.type) {
			case "wikilink": {
				const link = token as WikilinkToken;
				const alias = link.parsed.alias;
				text += link.embed
					? alias && !SIZE_RE.test(alias)
						? alias
						: link.target.trim()
					: (alias ?? fileLabel(link));
				break;
			}
			case "math":
				text += (token as MathToken).tex;
				break;
			case "footnoteRef":
			case "inlineFootnote":
			case "br":
				break;
			default:
				if ("tokens" in token && token.tokens) text += plainText(token.tokens);
				else if ("text" in token && typeof token.text === "string") text += token.text;
		}
	}
	return text;
}

function tagify(text: string): string {
	let html = "";
	let last = 0;
	for (const match of text.matchAll(INLINE_TAG_PATTERN)) {
		const name = tagNameFromMatch(match[1] ?? "");
		if (!name) continue;
		const start = match.index ?? 0;
		html += escapeHtmlText(text.slice(last, start));
		html += `<span class="canvas-tag" data-tag="${escapeHtmlAttribute(name.toLowerCase())}">#${escapeHtmlText(name)}</span>`;
		last = start + 1 + name.length;
	}
	return html + escapeHtmlText(text.slice(last));
}

function sanitizeRawHtml(html: string): string {
	let out = "";
	let last = 0;
	for (const match of html.matchAll(HTML_PIECE_RE)) {
		const start = match.index ?? 0;
		const name = match[2]?.toLowerCase();
		out += escapeHtmlText(html.slice(last, start));
		out +=
			name && Object.hasOwn(ALLOWED_HTML_TAGS, name)
				? `<${match[1]}${name}${match[3]}>`
				: escapeHtmlText(match[0]);
		last = start + match[0].length;
	}
	return out + escapeHtmlText(html.slice(last));
}

function mathHtml(tex: string, display: boolean): string {
	const data = escapeHtmlAttribute(tex);
	const text = escapeHtmlText(tex);
	return display
		? `<div class="canvas-math canvas-math-display" data-tex="${data}" data-display="true">${text}</div>`
		: `<span class="canvas-math" data-tex="${data}">${text}</span>`;
}

function footnoteRefHtml(c: RenderContext, number: number, first: boolean): string {
	const prefix = escapeHtmlAttribute(c.idPrefix);
	const id = first ? ` id="${prefix}canvas-fnref-${number}"` : "";
	return `<sup class="canvas-footnote-ref"${id}><a href="#${prefix}canvas-fn-${number}">${number}</a></sup>`;
}

const md = new Marked({
	gfm: true,
	// Obsidian's "strict line breaks" is off by default: a single newline is a break.
	breaks: true,
	async: false,
	extensions: [
		{
			name: "callout",
			level: "block",
			childTokens: ["titleTokens", "tokens"],
			tokenizer(src) {
				const head = CALLOUT_RE.exec(src);
				const quote = head && BLOCKQUOTE_RE.exec(src);
				if (!head || !quote) return undefined;
				const raw = quote[0];
				const body = raw
					.replace(/\n+$/, "")
					.split("\n")
					.slice(1)
					.map((line) => line.replace(/^ {0,3}> ?/, ""))
					.join("\n");
				const titleTokens: Token[] = [];
				this.lexer.inline(head[3]?.trim() ?? "", titleTokens);
				const top = this.lexer.state.top;
				this.lexer.state.top = true;
				const tokens = this.lexer.blockTokens(body, []);
				this.lexer.state.top = top;
				const token: CalloutToken = {
					type: "callout",
					raw,
					calloutType: (head[1] ?? "note").toLowerCase(),
					fold: (head[2] ?? "") as CalloutToken["fold"],
					titleTokens,
					tokens,
				};
				return token;
			},
			renderer(token) {
				const callout = token as CalloutToken;
				const type = callout.calloutType;
				const attrs = `class="canvas-callout canvas-callout-${type.replace(/[^a-z0-9_-]/g, "")}" data-callout="${escapeHtmlAttribute(type)}"`;
				const title = callout.titleTokens.length
					? this.parser.parseInline(callout.titleTokens)
					: escapeHtmlText(type);
				const body = `<div class="canvas-callout-body">${this.parser.parse(callout.tokens)}</div>`;
				if (callout.fold) {
					const open = callout.fold === "+" ? " open" : "";
					return `<details ${attrs}${open}><summary class="canvas-callout-title">${title}</summary>${body}</details>\n`;
				}
				return `<div ${attrs}><div class="canvas-callout-title">${title}</div>${body}</div>\n`;
			},
		},
		{
			name: "footnoteDef",
			level: "block",
			start: (src) => FOOTNOTE_DEF_START_RE.exec(src)?.index,
			tokenizer(src) {
				const match = FOOTNOTE_DEF_RE.exec(src);
				if (!match) return undefined;
				const token: FootnoteDefToken = {
					type: "footnoteDef",
					raw: match[0],
					id: (match[1] ?? "").trim(),
					tokens: [],
				};
				this.lexer.inline((match[2] ?? "").trim(), token.tokens);
				return token;
			},
			// Definitions render in the footnotes section, not where they stand.
			renderer: () => "",
		},
		{
			name: "mathBlock",
			level: "block",
			start: (src) => MATH_BLOCK_START_RE.exec(src)?.index,
			tokenizer(src) {
				const match = MATH_BLOCK_RE.exec(src);
				if (!match) return undefined;
				const token: MathToken = {
					type: "mathBlock",
					raw: match[0],
					tex: (match[1] ?? "").trim(),
					display: true,
				};
				return token;
			},
			renderer: (token) => `${mathHtml((token as MathToken).tex, true)}\n`,
		},
		{
			name: "embed",
			level: "inline",
			start: (src) => {
				const index = src.indexOf("![[");
				return index < 0 ? undefined : index;
			},
			// Emits `wikilink` tokens; that renderer handles embeds too.
			tokenizer: (src) => tokenizeWikilink(src, true),
		},
		{
			// CommonMark lets an image description hold balanced brackets, which
			// marked's pattern stops at one level of, so `![x [[Note]]](a.png)`
			// fell apart into a stray link and text. Only those descriptions are
			// taken here; marked keeps every other image.
			name: "nestedImage",
			level: "inline",
			start: (src) => {
				const index = src.indexOf("![");
				return index < 0 ? undefined : index;
			},
			tokenizer(src) {
				if (!src.startsWith("![") || src[2] === "[") return undefined;
				const end = closingBracket(src, 1);
				if (end < 0) return undefined;
				const label = src.slice(2, end);
				if (!label.includes("[[")) return undefined;
				const tail = LINK_TAIL_RE.exec(src.slice(end + 1));
				if (!tail) return undefined;
				const href = tail[1] ?? "";
				const title = tail[2];
				const token: Tokens.Image = {
					type: "image",
					raw: src.slice(0, end + 1 + tail[0].length),
					href: href.startsWith("<") ? href.slice(1, -1) : href,
					title: title ? title.slice(1, -1) : null,
					text: label,
					tokens: this.lexer.inlineTokens(label),
				};
				return token;
			},
		},
		{
			name: "wikilink",
			level: "inline",
			start: (src) => {
				const index = src.indexOf("[[");
				return index < 0 ? undefined : index;
			},
			tokenizer: (src) => tokenizeWikilink(src, false),
			renderer: (token) =>
				(token as WikilinkToken).embed
					? renderEmbed(token as WikilinkToken)
					: renderWikilink(token as WikilinkToken),
		},
		{
			name: "inlineFootnote",
			level: "inline",
			start: (src) => {
				const index = src.indexOf("^[");
				return index < 0 ? undefined : index;
			},
			tokenizer(src) {
				if (!src.startsWith("^[")) return undefined;
				const end = closingBracket(src, 1);
				if (end < 0) return undefined;
				return {
					type: "inlineFootnote",
					raw: src.slice(0, end + 1),
					tokens: this.lexer.inlineTokens(src.slice(2, end)),
				};
			},
			renderer(token) {
				const c = context();
				c.footnotes.push(token.tokens ?? []);
				return footnoteRefHtml(c, c.footnotes.length, true);
			},
		},
		{
			name: "footnoteRef",
			level: "inline",
			start: (src) => {
				const index = src.indexOf("[^");
				return index < 0 ? undefined : index;
			},
			tokenizer(src) {
				const match = FOOTNOTE_REF_RE.exec(src);
				if (!match) return undefined;
				const token: FootnoteRefToken = {
					type: "footnoteRef",
					raw: match[0],
					id: (match[1] ?? "").trim(),
				};
				return token;
			},
			renderer(token) {
				const c = context();
				const { id, raw } = token as FootnoteRefToken;
				const content = c.definitions.get(id);
				if (!content) return escapeHtmlText(raw);
				const known = c.labelNumbers.get(id);
				if (known) return footnoteRefHtml(c, known, false);
				c.footnotes.push(content);
				c.labelNumbers.set(id, c.footnotes.length);
				return footnoteRefHtml(c, c.footnotes.length, true);
			},
		},
		{
			name: "math",
			level: "inline",
			start: (src) => {
				const index = src.search(/(?<!\\)\$/);
				return index < 0 ? undefined : index;
			},
			tokenizer(src) {
				const display = DISPLAY_MATH_RE.exec(src);
				const match = display ?? INLINE_MATH_RE.exec(src);
				if (!match) return undefined;
				const token: MathToken = {
					type: "math",
					raw: match[0],
					tex: (match[1] ?? "").trim(),
					display: Boolean(display),
				};
				return token;
			},
			renderer: (token) => mathHtml((token as MathToken).tex, (token as MathToken).display),
		},
		{
			name: "highlight",
			level: "inline",
			start: (src) => {
				const index = src.indexOf("==");
				return index < 0 ? undefined : index;
			},
			tokenizer(src) {
				const match = HIGHLIGHT_RE.exec(src);
				if (!match) return undefined;
				return {
					type: "highlight",
					raw: match[0],
					tokens: this.lexer.inlineTokens(match[1] ?? ""),
				};
			},
			renderer(token) {
				return `<mark>${this.parser.parseInline(token.tokens ?? [])}</mark>`;
			},
		},
	],
	renderer: {
		html: ({ text }) => sanitizeRawHtml(text),
		code({ text, lang }) {
			const language = (lang ?? "").match(/^\S*/)?.[0] ?? "";
			if (language.toLowerCase() === "mermaid") {
				const source = escapeHtmlAttribute(text);
				return `<pre class="${MERMAID_BLOCK_CLASS}" data-code="${source}">${source}</pre>\n`;
			}
			const clean = language.replace(/[^\w+#.-]/g, "");
			const className = clean ? ` class="language-${clean}"` : "";
			return `<pre><code${className}>${escapeHtmlText(text.replace(/\n$/, ""))}\n</code></pre>\n`;
		},
		codespan: ({ text }) => `<code>${escapeHtmlText(text)}</code>`,
		paragraph({ tokens }) {
			// An embed on a line of its own is block content (a note, a PDF frame);
			// inside a `<p>` the browser would tear the paragraph apart around it.
			const [only, ...rest] = tokens.filter((token) => token.raw.trim() !== "");
			if (only?.type === "wikilink" && (only as WikilinkToken).embed && rest.length === 0) {
				return `${this.parser.parseInline(tokens)}\n`;
			}
			return `<p>${this.parser.parseInline(tokens)}</p>\n`;
		},
		link({ href, title, tokens }) {
			const c = context();
			c.linkDepth += 1;
			const label = this.parser.parseInline(tokens);
			c.linkDepth -= 1;
			const url = resolveMarkdownUrl(c, href);
			if (url === null) return unresolvedHtml(label);
			const safe = sanitizeUrl(url);
			if (!safe) return label;
			const titleAttribute = title ? ` title="${escapeHtmlAttribute(title)}"` : "";
			return `<a href="${escapeHtmlAttribute(safe)}"${titleAttribute}>${label}</a>`;
		},
		image({ href, title, text, tokens }) {
			const alt = tokens ? plainText(tokens) : text;
			const url = resolveMarkdownUrl(context(), href);
			if (url === null) return unresolvedHtml(escapeHtmlText(alt));
			const safe = sanitizeUrl(url);
			if (!safe) return escapeHtmlText(alt);
			const titleAttribute = title ? ` title="${escapeHtmlAttribute(title)}"` : "";
			return `<img src="${escapeHtmlAttribute(safe)}" alt="${escapeHtmlAttribute(alt)}"${titleAttribute}>`;
		},
		text(token) {
			// Paragraph-level text carries nested inline tokens; leaf text is
			// escaped here (raw-block text included) and gets its tags.
			if ("tokens" in token && token.tokens) return this.parser.parseInline(token.tokens);
			return context().linkDepth > 0 ? escapeHtmlText(token.text) : tagify(token.text);
		},
	},
});

function renderFootnotes(c: RenderContext): string {
	if (c.footnotes.length === 0) return "";
	const prefix = escapeHtmlAttribute(c.idPrefix);
	const items: string[] = [];
	// Footnote text may reference further footnotes, which append as it renders.
	for (let index = 0; index < c.footnotes.length; index += 1) {
		const number = index + 1;
		const content = Parser.parseInline(c.footnotes[index] ?? [], md.defaults);
		items.push(
			`<li id="${prefix}canvas-fn-${number}"><p>${content} <a href="#${prefix}canvas-fnref-${number}" class="canvas-footnote-backref" aria-label="Back to content">↩</a></p></li>`,
		);
	}
	return `<section class="canvas-footnotes" role="doc-endnotes"><ol>${items.join("\n")}</ol></section>`;
}

export function renderMarkdown(text: string, options: MarkdownOptions = {}): string {
	if (!text) return "";
	const tokens = md.lexer(text);
	// Definitions may stand anywhere — after the reference, after a fence, in
	// a callout — so they are collected before anything renders.
	const definitions = new Map<string, Token[]>();
	md.walkTokens(tokens, (token) => {
		if (token.type !== "footnoteDef") return;
		const definition = token as FootnoteDefToken;
		if (!definitions.has(definition.id)) definitions.set(definition.id, definition.tokens);
	});
	const previous = current;
	const c: RenderContext = {
		options,
		scope: options.scope ?? "",
		idPrefix: options.idPrefix ?? "",
		definitions,
		labelNumbers: new Map(),
		footnotes: [],
		linkDepth: 0,
		embedCount: 0,
	};
	current = c;
	try {
		return md.parser(tokens) + renderFootnotes(c);
	} finally {
		current = previous;
	}
}

/**
 * Every link and embed target in card markdown, for the build to resolve into
 * `CanvasData.links`. Lexed with the renderer's own instance, so a target is
 * collected exactly when the renderer will look it up; code and math hold none.
 */
export function collectMarkdownTargets(text: string): MarkdownTargets {
	const targets: MarkdownTargets = { wikilinks: [], urls: [] };
	if (!text) return targets;
	const seenLinks = new Set<string>();
	const seenUrls = new Set<string>();
	md.walkTokens(md.lexer(text), (token) => {
		if (token.type === "wikilink") {
			const { target, embed } = token as WikilinkToken;
			const key = `${embed ? "!" : ""}${target}`;
			if (seenLinks.has(key)) return;
			seenLinks.add(key);
			targets.wikilinks.push({ target, embed });
		} else if (token.type === "link" || token.type === "image") {
			const { href } = token;
			if (!isVaultRelative(href) || seenUrls.has(href)) return;
			seenUrls.add(href);
			targets.urls.push(href);
		}
	});
	return targets;
}
