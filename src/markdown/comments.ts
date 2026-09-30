/**
 * Obsidian comment (`%% … %%`) stripping.
 *
 * A comment is not a single-line construct: Obsidian hides everything from an
 * opening `%%` to the next closing `%%`, paragraphs and headings included. The
 * remark pass therefore works on source offsets rather than on text values —
 * by the time a text node reaches the pipeline its value no longer lines up
 * with the source (escapes are resolved), and the content between the delimiters
 * lives in *sibling* nodes.
 *
 * Delimiters inside frontmatter, fenced code and inline code spans are not
 * delimiters. Code spans pair the CommonMark way across a paragraph: an opener
 * silences the text up to the next run of the *same* length, and a run that
 * never finds its match is literal text — it does not silence the rest of the
 * paragraph. An unclosed `%%` is left as written.
 */

import type { Root } from "mdast";
import type { Parent } from "unist";
import { visit } from "unist-util-visit";
import { slugifyHeading, stripMarkdownFormatting } from "../shared/slug.js";
import { getContentLineFlags } from "./content-index.js";

const DELIMITER = "%%";

/** The comment delimiter, exported so callers can skip work when absent. */
export const COMMENT_DELIMITER = DELIMITER;

/** A half-open `[start, end)` source range Obsidian hides. */
export interface CommentRange {
	start: number;
	end: number;
}

/** A maximal run of backticks, in absolute source offsets. */
interface BacktickRun {
	start: number;
	end: number;
}

/** Backtick runs on one line, in absolute source offsets (runs never cross a
 * line break, so each line can be scanned on its own). */
function backtickRuns(line: string, lineStart: number): BacktickRun[] {
	const runs: BacktickRun[] = [];
	let index = 0;
	while (index < line.length) {
		if (line[index] !== "`") {
			index += 1;
			continue;
		}
		let length = 0;
		while (line[index + length] === "`") length += 1;
		runs.push({ start: lineStart + index, end: lineStart + index + length });
		index += length;
	}
	return runs;
}

/** Code spans of one paragraph, per CommonMark pairing rules.
 *
 * An opener pairs with the next run of the same length (runs of other
 * lengths in between are content); everything between them is code. An opener
 * with no match is literal text and silences nothing.
 */
function codeSpans(runs: BacktickRun[]): { start: number; end: number }[] {
	const spans: { start: number; end: number }[] = [];
	for (let index = 0; index < runs.length; ) {
		const length = (runs[index] as BacktickRun).end - (runs[index] as BacktickRun).start;
		let close = index + 1;
		while (close < runs.length) {
			const candidate = runs[close] as BacktickRun;
			if (candidate.end - candidate.start === length) break;
			close += 1;
		}
		if (close === runs.length) {
			index += 1;
			continue;
		}
		spans.push({
			start: (runs[index] as BacktickRun).end,
			end: (runs[close] as BacktickRun).start,
		});
		index = close + 1;
	}
	return spans;
}

/** Every comment range in `source`, in document order and non-overlapping. */
export function findCommentRanges(source: string): CommentRange[] {
	const lines = source.split("\n");
	const isContent = getContentLineFlags(lines);
	const ranges: CommentRange[] = [];
	let openAt = -1;
	let offset = 0;

	// One paragraph of consecutive content lines: backtick runs pair only
	// inside it (CommonMark code spans cannot cross a paragraph or a block
	// boundary), while `%%` pairing may span paragraphs, as in Obsidian.
	let paragraphRuns: BacktickRun[] = [];
	let paragraphDelimiters: number[] = [];

	const flushParagraph = () => {
		const spans = codeSpans(paragraphRuns);
		paragraphRuns = [];
		for (const column of paragraphDelimiters) {
			if (spans.some((span) => column >= span.start && column < span.end)) continue;
			if (openAt === -1) {
				openAt = column;
			} else {
				ranges.push({ start: openAt, end: column + DELIMITER.length });
				openAt = -1;
			}
		}
		paragraphDelimiters = [];
	};

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const lineStart = offset;
		// +1 for the newline; a trailing `\r` stays part of the line so offsets
		// remain aligned for CRLF sources.
		offset += line.length + 1;
		// Block boundaries (frontmatter, fences) and blank lines end the
		// paragraph; delimiters on them are not comment delimiters (or, for
		// blank lines, not present at all).
		if (!isContent[index] || line.trim() === "") {
			flushParagraph();
			continue;
		}

		paragraphRuns.push(...backtickRuns(line, lineStart));
		for (let column = 0; column < line.length; ) {
			if (line.startsWith(DELIMITER, column)) {
				paragraphDelimiters.push(lineStart + column);
				column += DELIMITER.length;
				continue;
			}
			column += 1;
		}
	}
	flushParagraph();

	return ranges;
}

function rangeContaining(
	start: number,
	end: number,
	ranges: CommentRange[],
): CommentRange | undefined {
	return ranges.find((range) => start >= range.start && end <= range.end);
}

/** Whether a single source offset falls inside a comment. */
export function isOffsetInComment(offset: number, ranges: CommentRange[]): boolean {
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
	const isContent = getContentLineFlags(lines);
	const counts = new Map<string, number>();
	let offset = 0;

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const lineStart = offset;
		offset += line.length + 1;
		if (!isContent[index]) continue;

		const text = HEADING_LINE.exec(line)?.[1];
		if (!text) continue;
		if (isOffsetInComment(lineStart + line.indexOf(text), ranges) !== commented) continue;
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
	const byOffset = toc.filter((entry) => !isOffsetInComment(entry.charIndex, ranges));
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
