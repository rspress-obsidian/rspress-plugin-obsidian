/**
 * Comment stripping: Obsidian's `%% … %%` and HTML's `<!-- … -->`.
 *
 * A comment is not a single-line construct: Obsidian hides everything from an
 * opening `%%` to the next closing `%%`, paragraphs and headings included. The
 * remark pass therefore works on source offsets rather than on text values —
 * by the time a text node reaches the pipeline its value no longer lines up
 * with the source (escapes are resolved), and the content between the delimiters
 * lives in *sibling* nodes.
 *
 * Delimiters inside frontmatter, code blocks (fenced and indented) and inline
 * code spans are not delimiters. Which text is code is read from the page's own
 * CommonMark parse ({@link parseObsidianMarkdown}), not from line rules, so a
 * `~~~` line inside a backtick fence, an escaped backtick, a code span that
 * would cross a block boundary or a fence nested in a block quote reads here
 * exactly as the page renders it.
 *
 * An unclosed `%%` follows Obsidian's Reading view: one that begins a line
 * opens a block comment, and a block comment nobody closes hides the rest of
 * the note; one written mid-line is literal text. An unclosed `<!--` hides the
 * rest of the note, as it does in a browser.
 */

import { createHash } from "node:crypto";
import type { Root } from "mdast";
import type { Parent } from "unist";
import { frontmatterLength } from "../shared/content-flags.js";
import { slugifyHeading, stripMarkdownFormatting } from "../shared/slug.js";
import { parseObsidianMarkdown } from "./syntax.js";
import { visit } from "./visit.js";

const DELIMITER = "%%";

/** The comment delimiter, exported so callers can skip work when absent. */
export const COMMENT_DELIMITER = DELIMITER;

/** A half-open `[start, end)` source range Obsidian hides. */
export interface CommentRange {
	start: number;
	end: number;
}

/**
 * Text without which a source holds no code: a backtick, a tilde fence, an
 * indent of four columns. A source with none of them is not parsed.
 */
const MAY_HOLD_CODE = /`|~~~|\t| {4}/;

/**
 * Parsed code ranges by source digest. One note is scanned for comments by
 * many stages of a build — the content index, unlinked mentions, Tasks, the
 * page render (twice), the graph and canvas cards — and the parse is the
 * expensive part, so each source is parsed once. Keyed by digest so the cache
 * holds no note text; least recently used entries go first.
 */
const literalCache = new Map<string, CommentRange[]>();
const LITERAL_CACHE_SIZE = 16_384;

/**
 * Where a comment delimiter is literal text, sorted and non-overlapping: the
 * frontmatter block (unless `fragment`: a canvas card has none, so a leading
 * `---` pair is two rules), code blocks and code spans.
 */
function literalRanges(source: string, fragment: boolean): readonly CommentRange[] {
	const frontmatter = fragment ? 0 : frontmatterLength(source);
	const ranges: CommentRange[] = frontmatter > 0 ? [{ start: 0, end: frontmatter }] : [];
	if (!MAY_HOLD_CODE.test(source)) return ranges;

	const key = `${frontmatter}:${createHash("sha1").update(source).digest("base64")}`;
	const cached = literalCache.get(key);
	if (cached) {
		literalCache.delete(key);
		literalCache.set(key, cached);
		return cached;
	}

	// The frontmatter is blanked rather than parsed: a ``` line in a YAML
	// string must not open a fence that swallows the body. Blanking keeps
	// every offset.
	const body =
		frontmatter > 0
			? source.slice(0, frontmatter).replace(/[^\r\n]/g, " ") + source.slice(frontmatter)
			: source;
	visit(parseObsidianMarkdown(body, { enableMath: false }), (node) => {
		if (node.type !== "code" && node.type !== "inlineCode") return;
		const span = offsetsOf(node);
		if (span) ranges.push(span);
	});

	if (literalCache.size >= LITERAL_CACHE_SIZE) {
		literalCache.delete(literalCache.keys().next().value as string);
	}
	literalCache.set(key, ranges);
	return ranges;
}

/** A comment delimiter found outside code, in absolute source offsets. */
interface Marker {
	at: number;
	text: string;
	/** Only whitespace precedes it on its line. */
	startsLine: boolean;
}

/** Every match of the global `pattern` in `source` that starts outside `literal`, in document order. */
function markersOutsideCode(
	source: string,
	literal: readonly CommentRange[],
	pattern: RegExp,
): Marker[] {
	const markers: Marker[] = [];
	let next = 0;
	for (const match of source.matchAll(pattern)) {
		const at = match.index;
		while (next < literal.length && (literal[next] as CommentRange).end <= at) next += 1;
		if (next < literal.length && (literal[next] as CommentRange).start <= at) continue;
		const lineStart = source.lastIndexOf("\n", at - 1) + 1;
		markers.push({ at, text: match[0], startsLine: source.slice(lineStart, at).trim() === "" });
	}
	return markers;
}

function obsidianRanges(source: string, literal: readonly CommentRange[]): CommentRange[] {
	const ranges: CommentRange[] = [];
	let open: Marker | undefined;
	for (const marker of markersOutsideCode(source, literal, /%%/g)) {
		if (!open) {
			open = marker;
			continue;
		}
		ranges.push({ start: open.at, end: marker.at + DELIMITER.length });
		open = undefined;
	}
	if (open?.startsLine) ranges.push({ start: open.at, end: source.length });
	return ranges;
}

const HTML_COMMENT_OPEN = "<!--";

function htmlRanges(source: string, literal: readonly CommentRange[]): CommentRange[] {
	const ranges: CommentRange[] = [];
	let openAt = -1;
	for (const marker of markersOutsideCode(source, literal, /<!--|-->/g)) {
		if (openAt === -1 && marker.text === HTML_COMMENT_OPEN) {
			openAt = marker.at;
		} else if (openAt !== -1 && marker.text !== HTML_COMMENT_OPEN) {
			ranges.push({ start: openAt, end: marker.at + marker.text.length });
			openAt = -1;
		}
	}
	if (openAt !== -1) ranges.push({ start: openAt, end: source.length });
	return ranges;
}

/**
 * Every `%%` comment range in `source`, in document order and
 * non-overlapping. `fragment`: `source` is a piece of markdown with no
 * frontmatter of its own (a canvas text card), so a leading `---` is a rule.
 */
export function findCommentRanges(source: string, fragment = false): CommentRange[] {
	// Most notes have no `%%`; skip parsing them.
	if (!source.includes(DELIMITER)) return [];
	return obsidianRanges(source, literalRanges(source, fragment));
}

/**
 * Every `<!-- … -->` range in `source` outside code, in document order. A
 * comment ends at the first `-->` after its opener; an unclosed one runs to
 * the end of `source`.
 */
export function findHtmlCommentRanges(source: string, fragment = false): CommentRange[] {
	if (!source.includes(HTML_COMMENT_OPEN)) return [];
	return htmlRanges(source, literalRanges(source, fragment));
}

/**
 * Both kinds of comment in `source`, merged into sorted, non-overlapping
 * ranges. HTML comments are looked for after the `%%` ones are blanked, so a
 * `<!--` inside a `%%` comment opens nothing; both read code from the source
 * as written.
 */
function findAllCommentRanges(source: string, fragment: boolean): CommentRange[] {
	const hasObsidian = source.includes(DELIMITER);
	const hasHtml = source.includes(HTML_COMMENT_OPEN);
	if (!hasObsidian && !hasHtml) return [];
	const literal = literalRanges(source, fragment);
	const obsidian = hasObsidian ? obsidianRanges(source, literal) : [];
	const html = hasHtml
		? htmlRanges(obsidian.length > 0 ? blankCommentRanges(source, obsidian) : source, literal)
		: [];
	if (html.length === 0) return obsidian;
	const merged: CommentRange[] = [];
	for (const range of [...obsidian, ...html].sort((a, b) => a.start - b.start)) {
		const last = merged.at(-1);
		if (last && range.start <= last.end) {
			last.end = Math.max(last.end, range.end);
		} else {
			merged.push({ ...range });
		}
	}
	return merged;
}

function rangeContaining(
	start: number,
	end: number,
	ranges: CommentRange[],
): CommentRange | undefined {
	return ranges.find((range) => start >= range.start && end <= range.end);
}

/** Whether a single source offset falls inside one of `ranges`. */
function isOffsetIn(offset: number, ranges: readonly CommentRange[]): boolean {
	return ranges.some((range) => offset >= range.start && offset < range.end);
}

const HEADING_LINE = /^\s{0,3}#{1,6}[ \t]+(.+?)\s*#*\s*$/;

/** How often each heading text occurs in `source`, split by whether a comment hides it. */
function countHeadings(
	source: string,
	ranges: CommentRange[],
	commented: boolean,
): Map<string, number> {
	const lines = source.split("\n");
	const literal = literalRanges(source, false);
	const counts = new Map<string, number>();
	let offset = 0;

	for (const line of lines) {
		const lineStart = offset;
		offset += line.length + 1;
		const text = HEADING_LINE.exec(line)?.[1];
		if (!text) continue;
		const at = lineStart + line.indexOf(text);
		if (isOffsetIn(at, literal) || isOffsetIn(at, ranges) !== commented) continue;
		counts.set(text, (counts.get(text) ?? 0) + 1);
	}

	return counts;
}

/** The part of a page outline entry this module reads. */
interface TocEntry {
	/** Offset of the heading in the page content; `-1` when Rspress has none. */
	charIndex: number;
	text: string;
	/** Anchor id Rspress derived from the heading, when the outline carries one. */
	id?: string;
}

/**
 * Drop the outline entries whose heading a comment hides.
 *
 * Rspress builds the page outline and the search index from its own parse of the
 * source, before plugin remark plugins run, so a heading a comment hides would be
 * listed in the outline while the body no longer contains it.
 *
 * Entries are matched by `charIndex`, which Rspress records for the page data and
 * the search index alike. With the search index disabled those offsets are `-1`,
 * so the leftover entries are reconciled by identity instead: the heading text as
 * written, the same text without its markdown, and the anchor id derived from it.
 * A live heading sharing a commented heading's identity keeps its entry, because
 * what is removed is the surplus over the live headings rather than a match on
 * the text.
 */
export function filterCommentedToc<T extends TocEntry>(toc: T[], source: string): T[] {
	const ranges = findCommentRanges(source);
	if (ranges.length === 0 || toc.length === 0) return toc;

	// Offset pass: Rspress records where a heading sits in the page content, so an
	// entry inside a comment is dropped outright.
	const byOffset = toc.filter((entry) => !isOffsetIn(entry.charIndex, ranges));
	// A build with the search index disabled records no offsets at all, which is
	// the only case the identity pass has to decide.
	if (!byOffset.some((entry) => entry.charIndex < 0)) {
		return byOffset.length === toc.length ? toc : byOffset;
	}

	const commented = countHeadings(source, ranges, true);
	if (commented.size === 0) return byOffset;
	const live = countHeadings(source, ranges, false);

	const owners = new Map<string, string>();
	const anchors = new Map<string, string>();
	for (const text of commented.keys()) {
		owners.set(text, text);
		owners.set(stripMarkdownFormatting(text), text);
		anchors.set(slugifyHeading(text), text);
	}
	const owner = (entry: TocEntry): string | undefined =>
		owners.get(entry.text) ?? (entry.id ? anchors.get(entry.id) : undefined);

	// Identity pass: drop the surplus each commented heading accounts for, so a
	// live heading sharing a commented heading's text keeps its entry.
	const toDrop = new Map<string, number>();
	for (const [text, commentedCount] of commented) {
		const survivors = byOffset.filter((entry) => owner(entry) === text).length;
		const excess = Math.min(survivors - (live.get(text) ?? 0), commentedCount);
		if (excess > 0) toDrop.set(text, excess);
	}

	const kept: T[] = [];
	for (const entry of byOffset) {
		const text = owner(entry);
		const left = text ? (toDrop.get(text) ?? 0) : 0;
		if (left > 0) {
			toDrop.set(text as string, left - 1);
			continue;
		}
		kept.push(entry);
	}
	return kept;
}

/**
 * `source` with every comment range blanked out (newlines kept).
 *
 * Same length as the input, so offsets computed against the original — Rspress's
 * `toc[].charIndex`, which its search UI uses to attribute a hit to a heading —
 * stay valid.
 */
export function blankCommentRanges(source: string, ranges: CommentRange[]): string {
	let result = "";
	let cursor = 0;
	for (const range of ranges) {
		if (range.start < cursor) continue;
		result += source.slice(cursor, range.start);
		result += source.slice(range.start, range.end).replace(/[^\n]/g, " ");
		cursor = range.end;
	}
	return result + source.slice(cursor);
}

/**
 * A note's source with every `%%` and `<!-- -->` comment blanked out (newlines
 * kept, same length), for text that is searched or previewed rather than
 * rendered: the hover preview, the graph search, link and tag extraction.
 */
export function blankAllComments(source: string): string {
	const ranges = findAllCommentRanges(source, false);
	return ranges.length > 0 ? blankCommentRanges(source, ranges) : source;
}

/**
 * `source` from offset `from` on, with every `%%` and `<!-- -->` comment cut
 * out, for text that is published as markdown rather than rendered here
 * (canvas cards, which the browser renders). Cutting, not blanking: a run of
 * spaces where an inline comment opened a line would read as an indented
 * code block.
 *
 * Comments are found in the whole of `source`, so pass a note with its
 * frontmatter and the body's offset as `from`: a body that opens with a `---`
 * rule is then scanned as the note page scans it, not as frontmatter. Pass
 * `fragment` for markdown that has no frontmatter at all (a text card).
 */
export function removeAllComments(
	source: string,
	{ from = 0, fragment = false }: { from?: number; fragment?: boolean } = {},
): string {
	let result = "";
	let cursor = from;
	for (const range of findAllCommentRanges(source, fragment)) {
		if (range.end <= cursor) continue;
		result += source.slice(cursor, Math.max(cursor, range.start));
		cursor = range.end;
	}
	return result + source.slice(cursor);
}

function intersects(start: number, end: number, ranges: CommentRange[]): boolean {
	return ranges.some((range) => range.start < end && range.end > start);
}

function offsetsOf(node: {
	position?: { start?: { offset?: number }; end?: { offset?: number } };
}): { start: number; end: number } | undefined {
	const start = node.position?.start?.offset;
	const end = node.position?.end?.offset;
	if (typeof start !== "number" || typeof end !== "number") return undefined;
	return { start, end };
}

/**
 * Cut a text node's value down to the parts outside `ranges`.
 *
 * Offsets are mapped into the value directly when the value still matches the
 * source span (the common case). When the node contains escapes or character
 * references the value is shorter than its span and there is no reliable way to
 * map offsets into it, so the value is left untouched: guessing with a search
 * for `%%` can pick a delimiter belonging to an unrelated comment and delete
 * live prose. Complete `%%…%%` pairs inside such a node are still removed by the
 * value-level pass in `remark-wikilink.ts`, which runs right after this one.
 */
function cutTextValue(value: string, start: number, end: number, ranges: CommentRange[]): string {
	const overlapping = ranges.filter((range) => range.start < end && range.end > start);
	if (overlapping.length === 0) return value;
	if (value.length !== end - start) return value;

	let result = "";
	let cursor = 0;
	for (const range of overlapping) {
		const cutStart = Math.max(range.start, start) - start;
		const cutEnd = Math.min(range.end, end) - start;
		result += value.slice(cursor, cutStart);
		cursor = cutEnd;
	}
	return result + value.slice(cursor);
}

/**
 * Remove every node that lies inside a comment range, cut the text nodes that
 * straddle a boundary, and drop containers a cut emptied (a heading that only
 * held commented-out text must not survive as `<h2></h2>`).
 */
export function stripComments(tree: Root, source: string): void {
	const ranges = findCommentRanges(source);
	if (ranges.length === 0) return;

	// 1. Whole nodes inside a comment. A table cell is emptied rather than
	// removed: its delimiters sit outside the cell, so splicing it out would
	// shift the row's columns against the header.
	visit(tree, (node, index, parent) => {
		if (!parent || typeof index !== "number") return;
		const span = offsetsOf(node);
		if (!span) return;
		if (!rangeContaining(span.start, span.end, ranges)) return;

		if (node.type === "tableCell") {
			(node as Parent & { children: unknown[] }).children = [];
			return;
		}
		(parent as Parent & { children: unknown[] }).children.splice(index, 1);
		return index;
	});

	// 2. Text nodes straddling a boundary.
	visit(tree, "text", (node, index, parent) => {
		if (!parent || typeof index !== "number") return;
		const span = offsetsOf(node);
		if (!span) return;
		if (!intersects(span.start, span.end, ranges)) return;

		node.value = cutTextValue(node.value, span.start, span.end, ranges);
		if (node.value.length === 0) {
			(parent as Parent & { children: unknown[] }).children.splice(index, 1);
			return index;
		}
	});

	// 3. Containers the cut emptied. Table cells are exempt: an emptied cell is
	// the correct result, and removing it would shift the row's columns.
	visit(tree, (node, index, parent) => {
		if (!parent || typeof index !== "number") return;
		if (node.type === "tableCell") return;
		const children = (node as Parent & { children?: unknown[] }).children;
		if (!Array.isArray(children) || children.length > 0) return;
		const span = offsetsOf(node);
		if (!span || !intersects(span.start, span.end, ranges)) return;
		(parent as Parent & { children: unknown[] }).children.splice(index, 1);
		return index;
	});
}
