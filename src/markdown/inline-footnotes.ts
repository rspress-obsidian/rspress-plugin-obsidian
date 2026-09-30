/**
 * Obsidian inline footnotes (`^[content]`).
 *
 * The inline form is a *phrasing* construct, but the closing bracket rarely lands
 * in the same text node as the opening `^[`: remark splits the content at every
 * piece of markdown inside it, so `^[with **bold** here]` arrives as
 * `text("^[with ")`, `strong(bold)`, `text(" here]")`. A per-text-node scan can
 * therefore only ever see the simplest footnotes — and even inside one node it
 * stops at the first `]`, which truncates `^[see [[guide]]]`.
 *
 * This pass works on a block's phrasing children. It flattens them into a
 * bracket-aware character stream that still records which child each character
 * came from, locates every `^[…]` by bracket depth across node boundaries, and
 * serializes the spanned inline nodes back to markdown — so the collected
 * definition is real source text, the same text the footnotes block re-renders.
 * That is why `**bold**`, `` `code` ``, `[[wikilink]]` and `[text](url)` inside
 * an inline footnote all come out as markup.
 */

import type { HTML, Link, PhrasingContent, Text } from "mdast";
import type { Parent } from "unist";
import { escapeHtmlAttribute } from "../shared/escape.js";

/** An inline footnote definition collected for the footnotes block. */
export interface InlineFootnoteDef {
	id: string;
	content: string;
}

/** The `<sup>` reference emitted in place of the `^[…]` construct. */
function createFootnoteRef(id: string, counter: number, content: string): HTML {
	return {
		type: "html",
		value: `<sup class="footnote-ref" id="fnref-${escapeHtmlAttribute(id)}"><a href="#fn-${escapeHtmlAttribute(id)}" title="${escapeHtmlAttribute(content)}">${counter}</a></sup>`,
	};
}

function createText(value: string): Text {
	return { type: "text", value };
}

/**
 * Markdown for one inline node, so a footnote spanning it keeps its formatting.
 *
 * Only the constructs remark actually splits on are serialized; anything else
 * (a highlight `<mark>`, an already-resolved embed) falls back to its plain text,
 * since the footnotes block re-renders the collected content from source.
 */
function serializeInline(node: PhrasingContent): string {
	switch (node.type) {
		case "text":
			return node.value;
		case "inlineCode":
			return `\`${node.value}\``;
		case "strong":
			return `**${node.children.map(serializeInline).join("")}**`;
		case "emphasis":
			return `*${node.children.map(serializeInline).join("")}*`;
		case "delete":
			return `~~${node.children.map(serializeInline).join("")}~~`;
		case "link": {
			const link = node as Link;
			const label = link.children.map(serializeInline).join("");
			return link.title ? `[${label}](${link.url} "${link.title}")` : `[${label}](${link.url})`;
		}
		case "image":
			return `![${node.alt ?? ""}](${node.url ?? ""})`;
		case "break":
			return "\n";
		case "html":
			return node.value;
		default: {
			// An extension's node, or an inline run this pass does not model. Its
			// text is kept so the footnote content is not lost.
			const children = (node as Parent & { children?: PhrasingContent[] }).children;
			if (Array.isArray(children)) {
				return children.map((child) => serializeInline(child as PhrasingContent)).join("");
			}
			return (node as { value?: string }).value ?? "";
		}
	}
}

/** One character of the flattened stream, tagged with the child it came from. */
interface Char {
	value: string;
	child: PhrasingContent;
}

/** Every character of the block's phrasing children, in order, with its owner. */
function flatten(children: PhrasingContent[]): Char[] {
	const chars: Char[] = [];
	for (const child of children) {
		for (const value of serializeInline(child)) {
			chars.push({ value, child });
		}
	}
	return chars;
}

/** A located `^[…]`. */
interface Match {
	/** Stream index of the `^`. */
	start: number;
	/** Stream index of the `]`. */
	end: number;
}

/**
 * Locate every balanced `^[…]` in the stream.
 *
 * Bracket depth is counted from the opening `^[`: a `[[wikilink]]` or a
 * `[text](url)` inside the content raises and lowers it, so only the `]` that
 * returns to depth zero closes the construct. An unclosed opener is skipped, and
 * scanning resumes after it, so `^[dangling` stays literal text and a later
 * `^[…]` in the same block still resolves.
 */
function findMatches(chars: Char[]): Match[] {
	const matches: Match[] = [];
	let index = 0;

	while (index < chars.length - 1) {
		if (chars[index]?.value !== "^" || chars[index + 1]?.value !== "[") {
			index += 1;
			continue;
		}
		let depth = 0;
		let cursor = index + 1;
		let close = -1;
		while (cursor < chars.length) {
			const value = chars[cursor]?.value;
			if (value === "[") depth += 1;
			else if (value === "]") {
				depth -= 1;
				if (depth === 0) {
					close = cursor;
					break;
				}
			}
			cursor += 1;
		}
		if (close === -1) {
			index += 2;
			continue;
		}
		matches.push({ start: index, end: close });
		index = close + 1;
	}

	return matches;
}

/** Markdown content of a match: the characters between `^[` and `]`. */
function contentOf(chars: Char[], match: Match): string {
	return chars
		.slice(match.start + 2, match.end)
		.map((char) => char.value)
		.join("");
}

/**
 * Replace the inline footnotes in a block's phrasing children.
 *
 * `startCounter` continues the document-wide inline-footnote numbering, so ids
 * stay unique across blocks.
 */
export function extractInlineFootnotes(
	children: PhrasingContent[],
	startCounter: number,
): { children: PhrasingContent[]; defs: InlineFootnoteDef[] } {
	const chars = flatten(children);
	if (!chars.some((char, index) => char.value === "^" && chars[index + 1]?.value === "[")) {
		return { children, defs: [] };
	}

	const matches = findMatches(chars);
	if (matches.length === 0) return { children, defs: [] };

	const defs: InlineFootnoteDef[] = [];
	const out: PhrasingContent[] = [];
	let counter = startCounter;
	let at = 0;

	const textBetween = (from: number, to: number) =>
		chars
			.slice(from, to)
			.map((char) => char.value)
			.join("");

	for (const child of children) {
		// `flatten` emits each child's characters contiguously, in order, so the
		// span this child owns runs from the cursor to the first character owned
		// by a different node. A child with no characters (a `footnoteReference`,
		// for instance) spans nothing and is carried across untouched.
		const start = at;
		while (at < chars.length && chars[at]?.child === child) at += 1;
		const end = at;

		let first = 0;
		while (first < matches.length && (matches[first] as Match).end + 1 < start) first += 1;
		let last = first;
		while (last < matches.length && (matches[last] as Match).start < end) last += 1;

		// No construct inside this child: keep the node itself so emphasis, links
		// and footnotes ahead of the rebuild survived as real nodes rather than
		// being flattened to their text.
		if (first === last) {
			out.push(child);
			continue;
		}

		const firstMatch = matches[first] as Match;
		let cursorAt = start;
		if (firstMatch.start > cursorAt) {
			out.push(createText(textBetween(cursorAt, firstMatch.start)));
			cursorAt = firstMatch.start;
		}

		for (let index = first; index < last; index += 1) {
			const match = matches[index] as Match;
			if (match.start > cursorAt) {
				out.push(createText(textBetween(cursorAt, match.start)));
				cursorAt = match.start;
			}
			// A match can span several children; the `<sup>` belongs to the one
			// that owns its `^`, and the rest contribute only their tail text.
			if (match.start >= start && match.start < end) {
				counter += 1;
				const id = `inline-${counter}`;
				const content = contentOf(chars, match);
				defs.push({ id, content });
				out.push(createFootnoteRef(id, counter, content));
			}
			cursorAt = match.end + 1;
		}

		if (end > cursorAt) out.push(createText(textBetween(cursorAt, end)));
	}

	return { children: out, defs };
}
