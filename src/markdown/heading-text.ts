/**
 * The text and anchor id of a heading, as the published page renders them.
 *
 * Three consumers have to agree on a heading's id: the content index (which
 * turns `[[Note#Heading]]` into `/note#id`), the remark pass (which stamps the
 * id on the rendered `<h2>`), and the page outline Rspress builds before any
 * plugin runs. They used to derive it three ways — the index deleted every
 * `*`, `_` and `~` (`## my_function` became `#myfunction` while the page said
 * `id="my_function"`), kept `%%comments%%` and raw `[[link|alias]]` text, and
 * Rspress's outline slugged the unrendered source. Everything now goes through
 * {@link parseHeadingText} and {@link HeadingIdAllocator}.
 */
import GithubSlugger from "github-slugger";
import type { Heading } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { findWikilinkMatches, parseWikiLink } from "./parse-wikilink.js";
import { wikiLinkDisplayText } from "./utils.js";

const inlineParser = unified().use(remarkParse).use(remarkGfm).freeze();

/** Characters that can make a heading's rendered text differ from its source. */
const MARKUP_CHARACTERS = /[[\]*_~`<>$=%\\&!{]/;
/** Rspress's custom-id syntax (`## Title {#custom-id}`), read off the end. */
const EXPLICIT_ID = /\s*\\?\{#([^{}]*)\}\s*$/;
const COMMENT = /%%[\s\S]*?(?:%%|$)/g;
const HIGHLIGHT = /==(?=\S)([\s\S]*?\S)==/g;
const MATH = /(?<!\\)\$\$([\s\S]+?)\$\$|(?<![\\$])\$(?![\s$])((?:\\.|[^$\\\n])+?)(?<!\s)\$(?!\d)/g;
const PLACEHOLDER = /\uE000(\d+)\uE001/g;

export interface HeadingText {
	/** Plain text of the heading as rendered, before slugging. */
	text: string;
	/** `{#id}` written after the heading, which Rspress uses verbatim. */
	explicitId?: string;
}

/** The parts of an mdast node the text walk reads; structural so syntax
 *  extensions that add node types keep type-checking. */
interface TextNode {
	type: string;
	value?: unknown;
	children?: TextNode[];
}

function collectText(node: TextNode): string {
	switch (node.type) {
		case "text":
		case "inlineCode":
			return typeof node.value === "string" ? node.value : "";
		// Raw HTML stays a `raw` node until after Rspress's header-anchor pass,
		// which only reads text and elements; images and line breaks render as
		// elements with no text; a footnote call's number is not part of the
		// heading's name.
		case "html":
		case "image":
		case "imageReference":
		case "footnoteReference":
		case "break":
			return "";
		default:
			return node.children?.map((child) => collectText(child)).join("") ?? "";
	}
}

/**
 * The rendered text of one heading's inline markdown (no leading `#`s).
 *
 * Obsidian syntax CommonMark does not know is settled first — comments vanish,
 * a wikilink shows its display text, an embed shows nothing, math shows its
 * TeX, `==x==` shows `x` — and parked behind placeholders so the label of
 * `[[__init__]]` cannot be re-read as emphasis. The rest goes through
 * remark + GFM, so only real emphasis loses its markers (`my_function` keeps
 * its underscore).
 */
export function parseHeadingText(markdown: string): HeadingText {
	let source = markdown;
	let explicitId: string | undefined;
	const idMatch = EXPLICIT_ID.exec(source);
	if (idMatch) {
		explicitId = idMatch[1]?.trim() || undefined;
		source = source.slice(0, idMatch.index);
	}
	if (!MARKUP_CHARACTERS.test(source)) return { text: source.trim(), explicitId };

	const parked: string[] = [];
	const park = (text: string): string => `\uE000${parked.push(text) - 1}\uE001`;

	source = source.replace(COMMENT, "");
	let withLinks = "";
	let cursor = 0;
	for (const match of findWikilinkMatches(source)) {
		withLinks += source.slice(cursor, match.start);
		const parsed = parseWikiLink(match.inner, match.fullMatch);
		withLinks += parsed.isEmbed ? "" : park(wikiLinkDisplayText(parsed));
		cursor = match.end;
	}
	source = withLinks + source.slice(cursor);
	source = source.replace(MATH, (_match, display?: string, inline?: string) =>
		park((display ?? inline ?? "").trim()),
	);
	source = source.replace(HIGHLIGHT, "$1");

	const tree = inlineParser.parse(source);
	const text = collectText(tree).replace(PLACEHOLDER, (_match, index: string) => {
		return parked[Number(index)] ?? "";
	});
	return { text: text.trim(), explicitId };
}

/** {@link parseHeadingText}, text only. */
export function headingAnchorText(markdown: string): string {
	return parseHeadingText(markdown).text;
}

/**
 * The inline markdown of a parsed heading node, sliced from the source it was
 * parsed from: no leading `#`s, closing `#`s or setext underline.
 */
export function headingSourceText(source: string, node: Heading): string {
	type Positioned = { position?: { start: { offset?: number }; end: { offset?: number } } };
	const children = node.children as Positioned[];
	const first = children[0]?.position?.start.offset;
	const last = children.at(-1)?.position?.end.offset;
	if (first === undefined || last === undefined) return "";
	return source.slice(first, last);
}

/**
 * Per-page id allocation, matching Rspress's header-anchor pass: one
 * github-slugger per page, so a repeated heading gets `-1`, `-2`…; a heading
 * with an explicit `{#id}` keeps it and does not advance the counter.
 */
export class HeadingIdAllocator {
	private readonly slugger = new GithubSlugger();

	next(text: string, explicitId?: string): string {
		return explicitId ?? this.slugger.slug(text);
	}
}

/** One heading of a page, with the id the published page gives it. */
export interface PageHeading {
	depth: number;
	/** The heading's inline markdown as written (no `#`s, no `{#id}`). */
	source: string;
	text: string;
	explicitId?: string;
	id: string;
	/** Line the heading starts on. */
	line: number;
	/** `false` for a heading inside a blockquote or callout. */
	topLevel: boolean;
}

const ATX_HEADING = /^((?:\s{0,3}>)*)\s{0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const SETEXT_UNDERLINE = /^\s{0,3}(=+|-+)[ \t]*$/;

/**
 * Every heading of a page in document order, with rendered text and id.
 *
 * Line-based rather than a full parse: the content index runs this over every
 * note of a vault, and a remark parse costs ~7 ms for a 20 kB note. ATX
 * headings are found at the top level and inside blockquotes/callouts (which
 * the rendered page gives ids too, so the slug counter must see them); setext
 * headings at the top level. `isContent` excludes frontmatter and fences; the
 * caller blanks comment ranges first, since the rendered page never shows a
 * commented heading.
 */
export function scanPageHeadings(lines: string[], isContent: boolean[]): PageHeading[] {
	const allocator = new HeadingIdAllocator();
	const headings: PageHeading[] = [];
	const push = (line: number, depth: number, raw: string, topLevel: boolean): void => {
		const { text, explicitId } = parseHeadingText(raw);
		if (!text && !explicitId) return;
		headings.push({
			depth,
			source: raw.replace(/\s*\\?\{#[^{}]*\}\s*$/, "").trim(),
			text,
			explicitId,
			id: allocator.next(text, explicitId),
			line,
			topLevel,
		});
	};

	for (let index = 0; index < lines.length; index += 1) {
		if (!isContent[index]) continue;
		const line = lines[index] ?? "";
		const atx = ATX_HEADING.exec(line);
		if (atx) {
			push(index, atx[2]?.length ?? 1, atx[3] ?? "", !atx[1]);
			continue;
		}
		const next = lines[index + 1];
		if (
			next !== undefined &&
			isContent[index + 1] &&
			SETEXT_UNDERLINE.test(next) &&
			line.trim() !== "" &&
			!/^\s{0,3}(?:[-*+>]|\d+[.)])(?:\s|$)/.test(line) &&
			(index === 0 || (lines[index - 1] ?? "").trim() === "" || !isContent[index - 1])
		) {
			push(index, next.trim().startsWith("=") ? 1 : 2, line.trim(), true);
			index += 1;
		}
	}
	return headings;
}
