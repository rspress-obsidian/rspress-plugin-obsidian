import matter from "gray-matter";

/**
 * Frontmatter parsing shared by the content index and the graph builder.
 *
 * gray-matter picks its parser from the language marker on the opening
 * delimiter, and its stock engine map routes `---js` to a parser that `eval`s
 * the block — so any vault note is a build-time code-execution primitive. The
 * only engines this plugin will run are YAML (the default) and JSON.
 */

/**
 * Language markers gray-matter may look an engine up for.
 *
 * `js`/`javascript` are listed so they reach the engine allow-list below,
 * which refuses them by throwing — keeping one refusal path (and one message)
 * for JavaScript frontmatter. Everything else not listed here is refused
 * before gray-matter is called at all.
 */
const KNOWN_LANGUAGE_MARKERS: Record<string, true> = {
	"": true,
	yaml: true,
	yml: true,
	json: true,
	js: true,
	javascript: true,
};

const JAVASCRIPT_FRONTMATTER_REFUSED =
	'JavaScript frontmatter ("---js") is not executed; use YAML or JSON frontmatter.';

/** Thrown when frontmatter is refused or cannot be parsed. */
export class FrontmatterError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FrontmatterError";
	}
}

/**
 * The `engines` allow-list to hand gray-matter.
 *
 * The stock JavaScript engine is replaced with a stub that throws, so a
 * `---js` block becomes a named {@link FrontmatterError} rather than executed
 * code. YAML and JSON keep their stock engines.
 */
export const SAFE_FRONTMATTER_ENGINES: Record<string, { parse: (input: string) => object }> = {
	javascript: {
		parse(): object {
			throw new FrontmatterError(JAVASCRIPT_FRONTMATTER_REFUSED);
		},
	},
};

export interface ParsedFrontmatter {
	data: Record<string, unknown>;
	/** The language marker on the opening delimiter, lowercased (`""` for plain `---`). */
	language: string;
}

/**
 * The language marker after the opening delimiter, if the document has
 * frontmatter at all. Mirrors gray-matter's own test: `---` opens frontmatter,
 * `----` (a thematic break) does not.
 */
function detectLanguageMarker(markdown: string): string {
	if (!markdown.startsWith("---") || markdown.charAt(3) === "-") return "";
	const newline = markdown.indexOf("\n", 3);
	const line = newline === -1 ? markdown.slice(3) : markdown.slice(3, newline);
	return line.trim().toLowerCase();
}

/**
 * Parse a document's frontmatter without ever running an engine that can
 * execute code. Throws {@link FrontmatterError} for a refused language marker
 * or malformed YAML/JSON, so callers can name the file in their diagnostic.
 */
export function parseFrontmatter(markdown: string): ParsedFrontmatter {
	const language = detectLanguageMarker(markdown);
	if (!KNOWN_LANGUAGE_MARKERS[language]) {
		throw new FrontmatterError(
			`Unsupported frontmatter language "${language}"; only YAML and JSON frontmatter is read.`,
		);
	}

	const { data } = matter(markdown, { engines: SAFE_FRONTMATTER_ENGINES });
	return {
		// YAML happily parses a bare scalar, which is not a frontmatter object.
		data: typeof data === "object" && data !== null && !Array.isArray(data) ? data : {},
		language,
	};
}

/**
 * A leading frontmatter block: `---` alone on line one, a matching `---` line
 * somewhere after it. Deliberately byte-exact and regex-based — the callers
 * (transclusion, canvas note reading, the graph's masked link scan) want the
 * body back untouched, not a parsed document. Accepts CRLF checkouts and an
 * empty block (`---\n---\n`); anything unbalanced (no closing line, `---js`
 * opening, `----` thematic break) returns the input unchanged, which is also
 * what a document with no frontmatter gets.
 */
const FRONTMATTER_BLOCK = /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

/**
 * Drop a leading frontmatter block and return the body byte-for-byte.
 *
 * Shared by the three call sites that used to keep their own copy — each with
 * a different edge case (the canvas one trimmed, the wikilink one `trimStart`ed,
 * the graph one could not see an empty block), so one implementation now pins
 * the common contract instead of three drifting ones.
 */
export function stripFrontmatter(markdown: string): string {
	const match = FRONTMATTER_BLOCK.exec(markdown);
	return match ? markdown.slice(match[0].length) : markdown;
}
