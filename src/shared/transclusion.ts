/**
 * Slicing a note down to one heading section or block, for transclusion.
 *
 * Node-free so the browser-side canvas renderer can honour a `![[Note#Heading]]`
 * fragment with the same rules the build-time transclusion pass uses, rather
 * than inlining the whole note or keeping a second, drifting implementation.
 *
 * Both extractors split on `\r?\n` and return LF: vault content read from a
 * Windows checkout carries CRLF, and a trailing `\r` makes the ATX-heading
 * patterns below (which end in `[ \t]*$`) match nothing.
 */

import { getContentLineFlags } from "../shared/content-flags.js";
import { slugifyHeading } from "../shared/slug.js";

/**
 * The note slice a `#subpath` selects: a `^block` id, a heading name or slug, or
 * the whole note when the subpath is empty. `undefined` when the subpath names
 * something the note does not contain.
 */
export function extractNoteSection(content: string, subpath?: string): string | undefined {
	if (!subpath) return content;
	const anchor = subpath.replace(/^#/, "");
	// `extractBlockSection` takes the bare id — it prepends the `^` itself when
	// it matches the marker line — so a subpath arriving as `#^id` must not
	// carry the caret through or nothing ever matches.
	if (anchor.startsWith("^")) return extractBlockSection(content, anchor.slice(1)) ?? content;
	return extractHeadingSection(content, anchor) ?? content;
}

/** One heading line of a note. */
interface SectionHeading {
	line: number;
	level: number;
	text: string;
	explicitId?: string;
}

/** Every ATX and setext heading outside frontmatter and fences, in order. */
function scanHeadings(lines: string[], isContent: boolean[]): SectionHeading[] {
	const headings: SectionHeading[] = [];
	const push = (line: number, level: number, raw: string): void => {
		const explicit = /\s*\{#([^{}]+)\}\s*$/.exec(raw);
		headings.push({
			line,
			level,
			text: (explicit ? raw.slice(0, explicit.index) : raw).trim(),
			explicitId: explicit?.[1]?.trim(),
		});
	};
	for (let i = 0; i < lines.length; i++) {
		if (!isContent[i]) continue;
		const line = lines[i] ?? "";
		const atx = line.match(/^\s{0,3}(#{1,6})[ \t]+(.+?)(?:\s+#+)?[ \t]*$/);
		if (atx) {
			push(i, (atx[1] ?? "").length, atx[2] ?? "");
			continue;
		}
		const underline = isContent[i + 1] ? (lines[i + 1] ?? "").match(/^\s{0,3}(=+|-+)\s*$/) : null;
		if (underline && line.trim().length > 0) {
			push(i, (underline[1] ?? "").startsWith("=") ? 1 : 2, line);
			i += 1;
		}
	}
	return headings;
}

/**
 * Obsidian's heading-name fold: link text cannot hold `#`, `|`, `^`, `:`, `%`,
 * `[`, `]` or `\`, so a heading containing them is linked with a space in their
 * place (`## Step 1: Setup` → `[[Note#Step 1 Setup]]`). Compared without case.
 */
function headingKey(text: string): string {
	return text
		.normalize("NFC")
		.replace(/[#|^:%[\]\\]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

/**
 * The section a heading path names: from the heading to the next heading of
 * the same or a higher level.
 *
 * Matching is exact — by explicit `{#id}`, heading name, or slug — never by
 * prefix or substring, so a renamed heading is not silently replaced by a
 * neighbour. `A#B` is a path: `B` must sit under an `A` (intermediate levels
 * may be skipped, as in Obsidian), so a `Details` under `B` is not confused
 * with one under `A`.
 */
export function extractHeadingSection(content: string, heading: string): string | undefined {
	const lines = content.split(/\r?\n/);
	const headings = scanHeadings(lines, getContentLineFlags(lines));
	const parts = heading
		.split("#")
		.map((part) => part.trim())
		.filter(Boolean);
	if (parts.length === 0) return undefined;

	const matches = (entry: SectionHeading, part: string): boolean =>
		entry.explicitId === part ||
		headingKey(entry.text) === headingKey(part) ||
		slugifyHeading(entry.text) === part.toLowerCase();

	for (const [position, entry] of headings.entries()) {
		if (!matches(entry, parts[parts.length - 1] ?? "")) continue;
		let level = entry.level;
		let wanted = parts.length - 2;
		for (let previous = position - 1; previous >= 0 && wanted >= 0; previous -= 1) {
			const ancestor = headings[previous];
			if (!ancestor || ancestor.level >= level) continue;
			level = ancestor.level;
			if (matches(ancestor, parts[wanted] ?? "")) wanted -= 1;
		}
		if (wanted >= 0) continue;
		const end = headings.slice(position + 1).find((next) => next.level <= entry.level);
		return lines
			.slice(entry.line, end ? end.line : lines.length)
			.join("\n")
			.trim();
	}
	return undefined;
}

export function extractBlockSection(content: string, blockId: string): string | undefined {
	// Same CRLF reason as `extractHeadingSection`: the extracted section is
	// re-parsed as markdown, so it is returned with LF endings on any platform.
	const lines = content.split(/\r?\n/);
	const isContent = getContentLineFlags(lines);
	const normalizedId = blockId.trim().toLowerCase();

	for (let i = 0; i < lines.length; i++) {
		if (!isContent[i]) continue;

		const line = lines[i] ?? "";
		const lineNorm = line.trim().toLowerCase();

		// Standalone block ID on its own line: references the block above it
		// (blank lines between the block and the marker are tolerated).
		if (lineNorm === `^${normalizedId}`) {
			let start = i - 1;
			while (start >= 0 && (lines[start] ?? "").trim() === "") {
				start -= 1;
			}
			// Stop at frontmatter, a fence delimiter, or the fence's own lines so
			// a block marker never swallows the code block above it.
			while (start >= 0 && isContent[start] && (lines[start] ?? "").trim() !== "") {
				start -= 1;
			}
			const block = lines
				.slice(start + 1, i)
				.join("\n")
				.trim();
			return block || undefined;
		}

		// Inline block ID appended to a line: references that whole block.
		const inlineMatch = line.match(/^(.*?)\s+\^([A-Za-z0-9_-]+)\s*$/);
		if (inlineMatch && inlineMatch[2]?.toLowerCase() === normalizedId) {
			const text = (inlineMatch[1] ?? "").trimEnd();
			return extractInlineBlock(lines, isContent, i, text) || undefined;
		}
	}

	return undefined;
}

/**
 * Extract the markdown block whose last-or-first line is `index`, with `text`
 * standing for that line (already stripped of the inline block ID).
 *
 * A list item is extended forward to include its nested sub-items and
 * continuation lines. Any other block — a paragraph, a quote, a table — ends on
 * the marked line, so it is extended backwards to where the block starts: the
 * previous blank line, heading, fence or frontmatter. Obsidian embeds the whole
 * paragraph for `![[Note#^id]]`, not just its last line. A heading carrying the
 * id is a block of its own.
 *
 * Lines that are not content — frontmatter and code fences, per
 * {@link getContentLineFlags} — never end a list item, so a fenced block nested
 * in a list item (whose lines are commonly dedented) stays with its item.
 */
function extractInlineBlock(
	lines: string[],
	isContent: boolean[],
	index: number,
	text: string,
): string {
	const listItem = text.match(/^(\s*)([-*+]|\d+[.)])\s+/);
	if (!listItem) {
		if (/^\s{0,3}#{1,6}(?:\s|$)/.test(text)) return text.trim();
		let start = index;
		while (start > 0) {
			const previous = lines[start - 1] ?? "";
			if (!isContent[start - 1] || previous.trim() === "") break;
			if (/^\s{0,3}#{1,6}(?:\s|$)/.test(previous)) break;
			// A setext underline or thematic break closes the block above it.
			if (/^\s{0,3}(?:=+|-+|\*{3,}|_{3,})\s*$/.test(previous)) break;
			start -= 1;
		}
		return [...lines.slice(start, index), text].join("\n").trim();
	}

	const indent = (listItem[1] ?? "").length;
	const block: string[] = [];
	for (let j = index; j < lines.length; j++) {
		if (j === index) {
			block.push(text);
			continue;
		}

		const line = lines[j] ?? "";
		if (line.trim() === "" || !isContent[j]) {
			block.push(line);
			continue;
		}

		const leading = line.length - line.trimStart().length;
		if (leading > indent) {
			block.push(line);
			continue;
		}

		// A sibling item at the same indent, or a dedented line, ends the block.
		break;
	}

	return block.join("\n").trim();
}
