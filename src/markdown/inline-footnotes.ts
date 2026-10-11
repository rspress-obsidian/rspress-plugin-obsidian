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
 * content is real source text, which the footnote pass parses again. That is
 * why `**bold**`, `` `code` ``, `[[wikilink]]` and `[text](url)` inside an
 * inline footnote all come out as markup.
 *
 * Each construct is replaced by an {@link InlineFootnoteNode}; numbering is the
 * footnote pass's job, because Obsidian numbers label and inline footnotes in
 * one sequence, by first reference.
 */

import type { Link, PhrasingContent, Root } from "mdast";
import type { Node, Parent } from "unist";
import { visit } from "unist-util-visit";

/** The `^[…]` construct, before the footnote pass numbers it. */
export interface InlineFootnoteNode extends Node {
	type: "inlineFootnote";
	/** The footnote's markdown, as written between `^[` and `]`. */
	content: string;
}
declare module "mdast" {
	interface PhrasingContentMap {
		inlineFootnote: InlineFootnoteNode;
	}
	interface RootContentMap {
		inlineFootnote: InlineFootnoteNode;
	}
}

/** Node types whose children are phrasing content, where an inline footnote can sit. */
const PHRASING_CONTAINER_TYPES: Record<string, true> = {
	paragraph: true,
	heading: true,
	tableCell: true,
	emphasis: true,
	strong: true,
	delete: true,
	link: true,
	highlight: true,
};

/** Inline nodes whose text is never prose, so never holds a footnote. */
const LITERAL_TYPES: Record<string, true> = {
	inlineCode: true,
	html: true,
	inlineMath: true,
	wikiLink: true,
};
function createText(value: string): PhrasingContent {
	return { type: "text", value };
}

/**
 * Markdown for one inline node, so a footnote spanning it keeps its formatting.
 *
 * Only the constructs remark actually splits on are serialized; anything else
 * falls back to its plain text, since the footnote pass re-parses the collected
 * content.
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
		case "highlight":
			return `==${node.children.map(serializeInline).join("")}==`;
		case "inlineMath":
			return `$${node.value}$`;
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
			// An extension's node (`wikiLink` keeps its raw source as `value`), or
			// an inline run this pass does not model. Its text is kept so the
			// footnote content is not lost.
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

/** A located `^[…]`: stream indexes of the `^` and of the closing `]`. */
interface Match {
	start: number;
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
 *
 * A match lying wholly inside one non-text child (`**claim ^[x]**`, a code span,
 * a raw HTML run) is not this level's to take: emphasis and links are visited
 * on their own and rebuilt there with their formatting intact, and code and
 * HTML never hold a footnote at all.
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
		const owner = chars[index]?.child;
		if (
			owner &&
			chars[close]?.child === owner &&
			(PHRASING_CONTAINER_TYPES[owner.type] || LITERAL_TYPES[owner.type])
		) {
			index = close + 1;
			continue;
		}
		matches.push({ start: index, end: close });
		index = close + 1;
	}

	return matches;
}

/**
 * Replace the inline footnotes among one container's phrasing children.
 * Returns the original array when there are none.
 */
export function extractInlineFootnotes(children: PhrasingContent[]): PhrasingContent[] {
	const chars: Char[] = [];
	for (const child of children) {
		for (const value of serializeInline(child)) chars.push({ value, child });
	}
	if (!chars.some((char, index) => char.value === "^" && chars[index + 1]?.value === "[")) {
		return children;
	}

	const matches = findMatches(chars);
	if (matches.length === 0) return children;

	const out: PhrasingContent[] = [];
	let at = 0;
	const textBetween = (from: number, to: number) =>
		chars
			.slice(from, to)
			.map((char) => char.value)
			.join("");

	for (const child of children) {
		// Each child's characters are contiguous and in order, so the span this
		// child owns runs from the cursor to the first character of another node.
		// A child with no characters (a `footnoteReference`) spans nothing and is
		// carried across untouched.
		const start = at;
		while (at < chars.length && chars[at]?.child === child) at += 1;
		const end = at;

		let first = 0;
		while (first < matches.length && (matches[first] as Match).end + 1 < start) first += 1;
		let last = first;
		while (last < matches.length && (matches[last] as Match).start < end) last += 1;

		// No construct touches this child: keep the node itself so emphasis,
		// links and footnote references survive as real nodes.
		const touching = matches
			.slice(first, last)
			.some((match) => match.end >= start && match.start < end);
		if (!touching) {
			out.push(child);
			continue;
		}

		let cursorAt = start;
		for (let index = first; index < last; index += 1) {
			const match = matches[index] as Match;
			if (match.end < start) continue;
			if (match.start > cursorAt) {
				out.push(createText(textBetween(cursorAt, match.start)));
				cursorAt = match.start;
			}
			// A match can span several children; the marker belongs to the one
			// that owns its `^`, and the rest contribute only their tail text.
			if (match.start >= start && match.start < end) {
				out.push({
					type: "inlineFootnote",
					content: textBetween(match.start + 2, match.end),
				});
			}
			cursorAt = Math.max(cursorAt, match.end + 1);
		}

		if (end > cursorAt) out.push(createText(textBetween(cursorAt, end)));
	}

	return out;
}

/** Replace every inline footnote in the tree with an {@link InlineFootnoteNode}. */
export function replaceInlineFootnotes(tree: Root): void {
	visit(tree, (node) => {
		if (!PHRASING_CONTAINER_TYPES[node.type]) return;
		const container = node as Parent & { children: PhrasingContent[] };
		if (!Array.isArray(container.children)) return;
		container.children = extractInlineFootnotes(container.children);
		// Descend regardless: a link or emphasis can itself hold one.
	});
}
