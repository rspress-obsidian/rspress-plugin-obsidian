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

export function extractHeadingSection(content: string, heading: string): string | undefined {
	// Split on `\r?\n`: vault content read from a Windows checkout carries CRLF,
	// and a trailing `\r` makes the ATX-heading pattern below (which ends in
	// `[ \t]*$`) match nothing, so every transclusion of a section silently fell
	// back to a plain link.
	const lines = content.split(/\r?\n/);
	const isContent = getContentLineFlags(lines);
	const normalizedTarget =
		heading
			.split("#")
			.map((part) => part.trim())
			.filter(Boolean)
			.at(-1) ?? heading.trim();
	const normalizedLower = normalizedTarget.toLowerCase();
	let startLine = -1;
	let startLevel = 0;

	// True when `line` refers to the requested heading. Accepts a raw heading
	// name, an explicit `{#id}`, or an already-slugified heading anchor.
	const matchesTarget = (line: string): boolean => {
		const trimmed = line.trim();
		const explicitIdMatch = trimmed.match(/\s*\{#([A-Za-z0-9_:.-]+)\}\s*$/);
		const headingText = explicitIdMatch
			? trimmed.slice(0, trimmed.length - explicitIdMatch[0].length).trim()
			: trimmed;
		const slug = slugifyHeading(headingText);
		return (
			normalizedTarget === headingText ||
			normalizedLower === headingText.toLowerCase() ||
			normalizedTarget === slug ||
			normalizedLower === slug ||
			(explicitIdMatch !== null && explicitIdMatch[1] === normalizedTarget)
		);
	};

	for (let i = 0; i < lines.length; i++) {
		// Headings inside frontmatter or code fences are not headings: a `#`
		// comment in a fenced block must neither start nor end a section.
		if (!isContent[i]) continue;

		const line = lines[i] ?? "";

		// ATX heading: ## Heading text (up to 3 leading spaces, per Markdown)
		const atxMatch = line.match(/^\s{0,3}(#{1,6})[ \t]+(.+?)(?:\s+#+)?[ \t]*$/);
		if (atxMatch) {
			const level = (atxMatch[1] ?? "").length;
			const title = (atxMatch[2] ?? "").trim();
			if (startLine === -1) {
				if (matchesTarget(title)) {
					startLine = i;
					startLevel = level;
				}
			} else if (level <= startLevel) {
				return lines.slice(startLine, i).join("\n").trim();
			}
			continue;
		}

		// Setext heading: text on line i, underline (=== or ---) on line i+1
		const nextLine = lines[i + 1] ?? "";
		const setextUnderline = isContent[i + 1] ? nextLine.match(/^\s*(=+|-+)\s*$/) : null;
		if (setextUnderline && line.trim().length > 0) {
			const level = (setextUnderline[1] ?? "").startsWith("=") ? 1 : 2;
			const title = line.trim();
			if (startLine === -1) {
				if (matchesTarget(title)) {
					startLine = i;
					startLevel = level;
				}
			} else if (level <= startLevel) {
				return lines.slice(startLine, i).join("\n").trim();
			}
			i += 1; // skip underline
		}
	}

	if (startLine !== -1) {
		return lines.slice(startLine).join("\n").trim();
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
 * Extract the markdown block beginning at `index`, whose first line is `text`
 * (already stripped of the inline block ID). List items are extended to include
 * their nested sub-items and continuation lines; every other block type is
 * returned as a single line, matching the indexed block-ID semantics.
 *
 * Lines that are not content — frontmatter and code fences, per
 * {@link getContentLineFlags} — never end the block, so a fenced block nested
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
		return text.trim();
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
