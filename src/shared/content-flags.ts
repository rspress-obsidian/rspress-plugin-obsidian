/**
 * A leading frontmatter block: `---` alone on line one, a matching `---` line
 * somewhere after it, each allowing trailing blanks but no indent. Accepts CRLF
 * checkouts and an empty block (`---\n---\n`); anything unbalanced (no closing
 * line, `---js` opening, `----` thematic break, ` ---` indented) is not
 * frontmatter. The one definition `stripFrontmatter`, the line flags below and
 * the comment scanner all read.
 */
const FRONTMATTER_BLOCK = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** Length of `markdown`'s leading frontmatter block, delimiters included; 0 when it has none. */
export function frontmatterLength(markdown: string): number {
	return FRONTMATTER_BLOCK.exec(markdown)?.[0].length ?? 0;
}

/** A fence line, after any block quote markers: indent, run, the rest. */
const FENCE_LINE = /^([ \t]*)(`{3,}|~{3,})(.*)$/;
/** One block quote marker with its optional following space. */
const QUOTE_MARKER = /^[ \t]{0,3}>[ \t]?/;

/** `line` without up to `limit` leading block quote markers, and how many it had. */
function unquote(line: string, limit: number): { rest: string; depth: number } {
	let rest = line;
	let depth = 0;
	while (depth < limit) {
		const marker = QUOTE_MARKER.exec(rest);
		if (!marker) break;
		rest = rest.slice(marker[0].length);
		depth += 1;
	}
	return { rest, depth };
}

function indentWidth(indent: string): number {
	let width = 0;
	for (const char of indent) width += char === "\t" ? 4 - (width % 4) : 1;
	return width;
}

interface OpenFence {
	char: string;
	length: number;
	indent: number;
	depth: number;
}

/**
 * Flag each line of a document as content (`true`) or as frontmatter / inside a
 * code fence (`false`). Shared by the content index, the transclusion section
 * extractors and the heading scanners, so index-time and render-time boundary
 * detection agree.
 *
 * Fences follow CommonMark: a fence is a run of three or more backticks or
 * tildes (a backtick fence's info string may not contain a backtick); it is
 * closed only by a run of the same character at least as long, with nothing
 * after it, and an unclosed fence runs to the end of its block quote or of the
 * document. Being line-based, it reads a fence at any indent so one nested in a
 * list item is found, and it does not model indented code blocks — the comment
 * scanner, which must match the page exactly, reads code from a real parse.
 *
 * Node-free on purpose: the browser-side canvas renderer needs the same boundary
 * detection as the build-time index, and importing it from `content-index.ts`
 * would drag `node:fs` into the client bundle.
 */
export function getContentLineFlags(lines: string[]): boolean[] {
	const flags = new Array<boolean>(lines.length).fill(false);
	let start = 0;
	if (lines[0]?.startsWith("---")) {
		const joined = lines.join("\n");
		const block = joined.slice(0, frontmatterLength(joined));
		// Lines the block covers: its newlines, plus a closing line that ends
		// the document without one.
		if (block) start = block.split("\n").length - (block.endsWith("\n") ? 1 : 0);
	}

	let fence: OpenFence | undefined;
	for (let index = start; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		// Inside a fence only its own block quote markers are syntax; a deeper
		// `>` is code, and a line with fewer has left the quote and the fence.
		const { rest, depth } = unquote(line, fence ? fence.depth : Number.POSITIVE_INFINITY);
		if (fence && depth < fence.depth) fence = undefined;
		const match = FENCE_LINE.exec(rest);
		const [, indent = "", run = "", info = ""] = match ?? [];
		if (fence) {
			const closes =
				run[0] === fence.char &&
				run.length >= fence.length &&
				info.trim() === "" &&
				indentWidth(indent) - fence.indent <= 3;
			if (closes) fence = undefined;
			continue;
		}

		if (match && !(run[0] === "`" && info.includes("`"))) {
			fence = { char: run[0] ?? "`", length: run.length, indent: indentWidth(indent), depth };
			continue;
		}

		flags[index] = true;
	}

	return flags;
}
