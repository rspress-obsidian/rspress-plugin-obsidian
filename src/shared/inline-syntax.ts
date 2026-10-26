/**
 * Obsidian inline token rules shared by both markdown readers: the page
 * pipeline (remark, `src/markdown`) and the canvas card renderer (marked,
 * `src/canvas/utils/markdown.ts`). The page tokenizes `==…==` and `$…$` with
 * micromark constructs (`src/markdown/syntax.ts`); every place that has to find
 * them in a plain string — heading text, card markdown — reads them with the
 * patterns here, which encode the same rules, so a card, a heading and a note
 * page agree on where a span starts and ends.
 *
 * Tags are shared through `INLINE_TAG_PATTERN` in `paths.ts`, and comments
 * through `findCommentRanges` in `src/markdown/comments.ts`.
 */

/**
 * `==text==`, the way the page's tokenizer pairs `==` runs: the opener is not
 * followed by whitespace and the closer not preceded by it, and a run of three
 * or more `=` is never a marker, so `===` and `== a ==` stay text. Inside, a
 * single `=`, a longer run, or a `==` with whitespace on both sides (which can
 * neither open nor close) is content.
 */
const HIGHLIGHT_SOURCE = String.raw`(?<!=)==(?=[^\s=])((?:[^=]|={3,}|=(?!=)|\s==(?=\s))*?[^\s=])==(?!=)`;

/** Every highlight in a string; group 1 is its content. */
export const HIGHLIGHT_PATTERN = new RegExp(HIGHLIGHT_SOURCE, "g");

/*
 * Neither math form holds a backtick. Code spans bind tighter than anything but
 * HTML and autolinks (CommonMark), so a `$` inside `` `…` `` never pairs with
 * one outside it: `` $6, `$x$` `` is prose and a code span, not a formula.
 */

/**
 * Display math written inline, `$$…$$`; group 1 is the TeX. An escaped `\$$`
 * opens nothing.
 */
const DISPLAY_MATH_SOURCE = String.raw`(?<!\\)\$\$([^\x60]+?)\$\$`;

/**
 * Inline math, `$…$`; group 1 is the TeX. Obsidian (like Pandoc) does not let
 * the formula start or end with whitespace and does not close it on a `$`
 * followed by a digit, so `$5 and $6` stays prose. An escaped `\$` neither
 * opens nor closes, and the formula stays on one line.
 */
const INLINE_MATH_SOURCE = String.raw`(?<![\\$])\$(?![\s$])((?:\\[^\n\x60]|[^$\\\n\x60])+?)(?<!\s)\$(?!\d)`;

/** Every formula in a string: group 1 is display math, group 2 inline math. */
export const MATH_PATTERN = new RegExp(`${DISPLAY_MATH_SOURCE}|${INLINE_MATH_SOURCE}`, "g");

/** The rule {@link INLINE_MATH_SOURCE} encodes, for a tokenizer that found the delimiters itself. */
export function isInlineMathContent(tex: string): boolean {
	return !/^\s|\s$/.test(tex);
}

const STICKY_HIGHLIGHT = new RegExp(HIGHLIGHT_SOURCE, "y");
const STICKY_DISPLAY_MATH = new RegExp(DISPLAY_MATH_SOURCE, "y");
const STICKY_INLINE_MATH = new RegExp(INLINE_MATH_SOURCE, "y");

/** A token matched at the very start of a string: its source text and content. */
export interface InlineMatch {
	raw: string;
	content: string;
}

function matchAt(pattern: RegExp, src: string): InlineMatch | undefined {
	pattern.lastIndex = 0;
	const match = pattern.exec(src);
	return match ? { raw: match[0], content: match[1] ?? "" } : undefined;
}

/** The highlight `src` starts with, for a tokenizer handed the rest of a line. */
export function highlightAt(src: string): InlineMatch | undefined {
	return matchAt(STICKY_HIGHLIGHT, src);
}

/** The formula `src` starts with: `$$…$$` (display) before `$…$`. */
export function mathAt(src: string): (InlineMatch & { display: boolean }) | undefined {
	const display = matchAt(STICKY_DISPLAY_MATH, src);
	if (display) return { ...display, display: true };
	const inline = matchAt(STICKY_INLINE_MATH, src);
	return inline && { ...inline, display: false };
}

/**
 * Where a highlight could open in `src`: a `==` run of exactly two. A tokenizer
 * cut there gets a string the sticky pattern can judge on its own.
 */
export function highlightStart(src: string): number {
	return src.search(/(?<!=)==(?!=)/);
}

/** An embed's size, `|300` or `|300x200`: group 1 is the width, group 2 the height. */
export const EMBED_SIZE_PATTERN = /^(\d+)(?:x(\d+))?$/;
