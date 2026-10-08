/**
 * The small tree passes of the remark pipeline, each over typed nodes.
 *
 * `remark-wikilink.ts` runs them in a documented order; none of them reads
 * syntax out of text that the tokenizer could have claimed (see `syntax.ts`),
 * so their order only matters where one creates nodes another must skip.
 */
import type { Heading, Html, ListItem, PhrasingContent, Root, Text } from "mdast";
import type { Parent } from "unist";
import { visit } from "unist-util-visit";
import { type MathEngine, renderMathHtml } from "../math.js";
import { escapeHtmlAttribute } from "../shared/escape.js";
import { INLINE_TAG_PATTERN, tagNameFromMatch, tagRoutePath } from "../shared/paths.js";
import { HeadingIdAllocator, headingSourceText, parseHeadingText } from "./heading-text.js";
import { findWikilinkMatches } from "./parse-wikilink.js";
import { createTextNode, SKIP_PARENT_TYPES } from "./remark-diagnostics.js";
import { plainText } from "./syntax.js";

type PhrasingParent = Parent & { children: PhrasingContent[] };

const COMMENT_PATTERN = /%%[\s\S]*?%%/g;
const EXPLICIT_ID = /\s*\\?\{#([^{}]*)\}\s*$/;

/**
 * Turn `[[…]]` left inside text nodes into `wikiLink` nodes.
 *
 * The page itself is tokenized with the Obsidian constructs, but a tree another
 * pass parsed with plain remark (a daily-note template) still carries its
 * wikilinks as text; they are lifted here so the link pass sees one shape.
 */
export function liftTextWikilinks(tree: Root): void {
	visit(tree, "text", (node, index, parent) => {
		if (!parent || typeof index !== "number" || SKIP_PARENT_TYPES[parent.type]) return;
		if (!node.value.includes("[[")) return;
		const matches = findWikilinkMatches(node.value);
		if (matches.length === 0) return;
		const replacement: PhrasingContent[] = [];
		let cursor = 0;
		for (const match of matches) {
			if (match.start > cursor)
				replacement.push(createTextNode(node.value.slice(cursor, match.start)));
			replacement.push({ type: "wikiLink", value: match.fullMatch });
			cursor = match.end;
		}
		if (cursor < node.value.length) replacement.push(createTextNode(node.value.slice(cursor)));
		(parent as PhrasingParent).children.splice(index, 1, ...replacement);
		return index + replacement.length;
	});
}

/**
 * Strip `%%` comments from node *values*.
 *
 * `stripComments` works from source ranges and so cannot see nodes rebuilt from
 * a fragment, which carry no positions.
 */
export function processCommentValues(tree: Root): void {
	visit(tree, "text", (node, index, parent) => {
		if (!node.value.includes("%%")) return;
		const stripped = node.value.replace(COMMENT_PATTERN, "");
		if (stripped === node.value) return;
		if (stripped.trim().length === 0 && parent && typeof index === "number") {
			parent.children.splice(index, 1);
			return index;
		}
		node.value = stripped;
	});
}

/** Drop a trailing `{#id}` from a heading's last text node, as Rspress does. */
function stripExplicitId(heading: Heading): void {
	const last = heading.children[heading.children.length - 1];
	if (last?.type === "text" && EXPLICIT_ID.test(last.value)) {
		last.value = last.value.replace(EXPLICIT_ID, "");
	}
}

/**
 * Give every heading the id the content index computed for it.
 *
 * Rspress's header-anchor pass slugs the *rendered* text, which for a heading
 * holding a formula is KaTeX's markup (`energy-emc2emc2emc2`) and for a
 * wikilink depends on how it was rendered. Stamping the id here, from the
 * heading's source through the same `parseHeadingText` + `HeadingIdAllocator`
 * the index uses, makes `[[Note#Heading]]` and the page agree by construction;
 * Rspress keeps an id that is already set. `prefix` namespaces the ids of a
 * transcluded note so they never duplicate the host's; `presetIds` are the ids
 * the note's own page gives the embedded headings (a section's second
 * `## Details` stays `details-1`), used in order before the allocator.
 */
export function assignHeadingIds(
	tree: Root,
	cleanSource: string,
	prefix: string,
	presetIds: readonly string[] = [],
): void {
	const allocator = new HeadingIdAllocator();
	let position = 0;
	visit(tree, "heading", (node) => {
		let text: string;
		let explicitId: string | undefined;
		const raw = node.position ? headingSourceText(cleanSource, node) : "";
		if (raw) {
			({ text, explicitId } = parseHeadingText(raw));
		} else {
			// Rebuilt from a fragment (callout content): no source to slice.
			const value = plainText(node.children);
			const match = EXPLICIT_ID.exec(value);
			explicitId = match?.[1]?.trim() || undefined;
			text = (match ? value.slice(0, match.index) : value).trim();
		}
		stripExplicitId(node);
		if (!text && !explicitId) return;
		const allocated = allocator.next(text, explicitId);
		const id = `${prefix}${presetIds[position] ?? allocated}`;
		position += 1;
		node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id } };
	});
}

/**
 * Rewrite inline `#tag` into a link to its tag page. A `#` written `\#` is
 * literal text in Obsidian; the parser records where each one landed
 * (`syntax.ts`, `obsidianEscapedHashes`), and those are left as text.
 */
export function processTagLinks(tree: Root): void {
	visit(tree, "text", (node, index, parent) => {
		if (!parent || typeof index !== "number" || SKIP_PARENT_TYPES[parent.type]) return;
		if (!node.value.includes("#")) return;
		const escaped = node.data?.obsidianEscapedHashes ?? [];
		const replacement: PhrasingContent[] = [];
		let cursor = 0;
		for (const match of node.value.matchAll(INLINE_TAG_PATTERN)) {
			const tag = tagNameFromMatch(match[1] ?? "");
			const start = match.index ?? 0;
			if (!tag || escaped.includes(start)) continue;
			if (start > cursor) replacement.push(createTextNode(node.value.slice(cursor, start)));
			replacement.push({
				type: "link",
				url: tagRoutePath(tag),
				children: [createTextNode(`#${tag}`)],
			});
			cursor = start + 1 + tag.length;
		}
		if (replacement.length === 0) return;
		if (cursor < node.value.length) replacement.push(createTextNode(node.value.slice(cursor)));
		(parent as PhrasingParent).children.splice(index, 1, ...replacement);
		return index + replacement.length;
	});
}

/**
 * Render `math` / `inlineMath` nodes. Returns how many formulas were rendered,
 * so the caller knows whether the page needs the engine's stylesheet.
 *
 * KaTeX is called with `throwOnError: false`, so malformed input renders as
 * KaTeX's own inline error; input an engine rejects outright stays as written.
 */
export function processMath(tree: Root, engine: MathEngine): number {
	let rendered = 0;
	visit(tree, (node, index, parent) => {
		if (node.type !== "math" && node.type !== "inlineMath") return;
		if (!parent || typeof index !== "number") return;
		const display = node.type === "math" || node.data?.obsidianDisplay === true;
		const tex = node.value.trim();
		const html = tex ? renderMathHtml(tex, display, engine) : null;
		const replacement: Html | Text = html
			? {
					type: "html",
					value:
						node.type === "math"
							? `<div class="obsidian-math-display">${html}</div>`
							: `<span class="${display ? "obsidian-math-display" : "obsidian-math"}">${html}</span>`,
				}
			: {
					type: "text",
					value: node.type === "math" ? `$$\n${node.value}\n$$` : `$${node.value}$`,
				};
		if (html) rendered += 1;
		(parent as Parent & { children: unknown[] }).children.splice(index, 1, replacement);
	});
	return rendered;
}

/**
 * The element a block id renders as. A `<span>`, not an `<a>`: Rspress maps
 * every `<a>` to its `Link`, which gave each block id an `href="/"` and a stop
 * in the keyboard tab order.
 */
function createBlockAnchor(id: string): Html {
	return {
		type: "html",
		value: `<span class="obsidian-block-anchor" id="${escapeHtmlAttribute(`${id}`)}"></span>`,
	};
}

/**
 * Materialise the `id="^block-id"` targets `[[Page#^block-id]]` links point at.
 * Standalone `^id` markers are replaced; trailing `… ^id` markers are stripped
 * and the anchor put where they stood.
 *
 * An id the index recorded on the page is honoured wherever its text node
 * ends. Content the page did not have on disk — a template a note was filled
 * from, an included section — carries ids the index never saw; those are
 * honoured only where Obsidian would read one, at the very end of a
 * paragraph, so `a ^x **bold**` keeps its text.
 */
export function emitBlockAnchors(tree: Root, blockIds: Iterable<string>, prefix: string): void {
	const ids = new Set(blockIds);
	visit(tree, "text", (node, index, parent) => {
		if (!parent || typeof index !== "number" || SKIP_PARENT_TYPES[parent.type]) return;
		if (!node.value.includes("^")) return;
		const standalone = /^\s*\^([A-Za-z0-9_-]+)\s*$/.exec(node.value);
		const inline = standalone ? null : /\s\^([A-Za-z0-9_-]+)\s*$/.exec(node.value);
		const match = standalone ?? inline;
		const id = match?.[1];
		if (!match || !id) return;
		const endsParagraph = parent.type === "paragraph" && index === parent.children.length - 1;
		if (!ids.has(id) && !endsParagraph) return;
		const leading = node.value.slice(0, node.value.length - match[0].length);
		const replacement: PhrasingContent[] = [];
		if (!standalone && leading.length > 0) replacement.push(createTextNode(leading));
		replacement.push(createBlockAnchor(`${prefix}^${id}`));
		(parent as PhrasingParent).children.splice(index, 1, ...replacement);
		return index + replacement.length;
	});
}

/**
 * Obsidian's custom task statuses — `- [/]`, `- [-]`, `- [>]`, `- [?]`, `- [!]`.
 *
 * GFM only knows `[ ]` and `[x]`, so any other status arrives as list text.
 * Obsidian draws a checked box for every non-space status and exposes the
 * character as `data-task` (for themes and snippets); GFM items get the same
 * attribute (`""` unchecked, `x` checked).
 */
export function processTaskStatuses(tree: Root): void {
	visit(tree, "listItem", (node: ListItem) => {
		if (typeof node.checked === "boolean") {
			node.data = {
				...node.data,
				hProperties: { ...node.data?.hProperties, dataTask: node.checked ? "x" : "" },
			};
			return;
		}
		const paragraph = node.children[0];
		const first = paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;
		if (first?.type !== "text") return;
		const match = /^\[([^\]\s])\](?:[ \t]+|$)/.exec(first.value);
		if (!match?.[1] || paragraph?.type !== "paragraph") return;
		first.value = first.value.slice(match[0].length);
		if (first.value.length === 0) paragraph.children.shift();
		node.checked = true;
		node.data = {
			...node.data,
			hProperties: { ...node.data?.hProperties, dataTask: match[1] },
		};
	});
}

/**
 * Obsidian's default reading view (strict line breaks off): a single newline
 * inside a paragraph is a line break, not a space.
 */
export function applySoftLineBreaks(tree: Root): void {
	visit(tree, "text", (node, index, parent) => {
		if (!parent || typeof index !== "number" || SKIP_PARENT_TYPES[parent.type]) return;
		if (!node.value.includes("\n")) return;
		const lines = node.value.split(/\r?\n/);
		const replacement: PhrasingContent[] = [];
		lines.forEach((line, position) => {
			if (position > 0) replacement.push({ type: "break" });
			const text = position > 0 ? line.trimStart() : line;
			if (text) replacement.push(createTextNode(text));
		});
		(parent as PhrasingParent).children.splice(index, 1, ...replacement);
		return index + replacement.length;
	});
}

/**
 * Drop paragraphs emptied by earlier transforms, and unwrap paragraphs left
 * holding only block-level HTML or a JSX embed.
 */
export function cleanupParagraphs(tree: Root): void {
	visit(tree, "paragraph", (node, index, parent) => {
		if (!parent || typeof index !== "number") return;
		if (
			node.children.length === 0 ||
			node.children.every((child) => {
				// `mdxJsxFlowElement` is not part of the phrasing union, but the link
				// pass splices exactly that combination when it embeds a canvas.
				const type = (child as { type: string }).type;
				return type === "html" || type === "mdxJsxFlowElement";
			})
		) {
			parent.children.splice(index, 1, ...node.children);
		}
	});
}

/**
 * Fold CRLF (and lone CR) out of every value that reaches the output.
 *
 * micromark parses the source without rewriting it, so a document edited on
 * Windows keeps `\r\n` inside text, code and raw-HTML values. Browsers
 * normalise those away, but they make the emitted HTML byte-different from the
 * same vault on Linux — and byte-identical output is what lets a Windows CI leg
 * compare artifacts. Only `value` changes: `position` still indexes the raw
 * source.
 */
export function normalizeLineEndingsInTree(tree: Root): void {
	visit(tree, (node) => {
		if (
			(node.type === "text" ||
				node.type === "code" ||
				node.type === "inlineCode" ||
				node.type === "html") &&
			node.value.includes("\r")
		) {
			node.value = node.value.replace(/\r\n?/g, "\n");
		}
	});
}
