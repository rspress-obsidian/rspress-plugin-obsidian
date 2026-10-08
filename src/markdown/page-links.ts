/**
 * What a note links to and which tags it carries, read from its source.
 *
 * One extractor for every consumer that has to agree with the rendered page:
 * the content index (backlinks, tag pages, Dataview `file.outlinks`), the
 * attachment publisher, and the graph. Only text a reader sees as prose counts —
 * code spans, fenced blocks, `%%comments%%`, `<!-- comments -->` and the
 * frontmatter block are skipped, and a tag is never read out of a link
 * destination, a wikilink, a URL or an HTML attribute.
 */
import { getContentLineFlags } from "../shared/content-flags.js";
import { parseFrontmatter } from "../shared/frontmatter.js";
import { INLINE_TAG_PATTERN, tagNameFromMatch } from "../shared/paths.js";
import { findWikilinkMatches, parseWikiLink } from "./parse-wikilink.js";
import type { ParsedWikiLink, WikiSubpath } from "./types.js";

export interface PageLinks {
	/**
	 * Every link the page makes, as wikilinks: `[[…]]` and `![[…]]` in the body,
	 * markdown links and images with a relative destination (`[x](Note.md)`,
	 * `![](img.png)`, reference definitions), `obsidian://open` URIs, and
	 * wikilinks in frontmatter properties (`related: "[[X]]"`, which Obsidian
	 * ≥ 1.4 counts as links). Vault searches and same-page anchors are left out:
	 * neither points at another file.
	 */
	outlinks: ParsedWikiLink[];
	/** Frontmatter and inline tags, without `#`, first spelling per tag kept. */
	tags: string[];
}

const COMMENTS = /%%[\s\S]*?(?:%%|$)|<!--[\s\S]*?(?:-->|$)/g;
// A code span closes on a backtick run of the same length (CommonMark) and
// never crosses a blank line.
const CODE_SPAN = /(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g;
const MARKDOWN_LINK =
	/(!?)\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
// `^`-prefixed labels are footnotes and `~`-prefixed ones citations.
const DEFINITION = /^\s{0,3}\[([^\]^~][^\]]*)\]:[ \t]*(<[^>\n]+>|\S+)/gm;
const URL_LIKE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>()]+|<[a-z][a-z0-9+.-]*:[^\s<>]*>/gi;
const HTML_TAG = /<\/?[a-z][^<>\n]*>/gi;

/** Blank out ranges with spaces so line structure and offsets survive. */
function blank(text: string, pattern: RegExp): string {
	return text.replace(pattern, (match) => match.replace(/[^\n]/g, " "));
}

function subpathFrom(anchor: string): WikiSubpath | undefined {
	const value = anchor.replace(/^#/, "").trim();
	if (!value) return undefined;
	return value.startsWith("^")
		? { kind: "block", value: value.slice(1).trim() }
		: { kind: "heading", value };
}

/**
 * A markdown destination as a wikilink, or `undefined` when it is not a
 * relative file reference: external URLs, protocol-relative and root-absolute
 * paths are site URLs, and a bare `#anchor` stays on the page.
 */
export function markdownDestinationToWikiLink(
	destination: string,
	raw: string,
	isEmbed: boolean,
): ParsedWikiLink | undefined {
	let target = destination.trim();
	if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1).trim();
	if (/^obsidian:\/\//i.test(target)) return obsidianUriToWikiLink(target, raw);
	if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || /^[/#]/.test(target)) return undefined;

	const hash = target.indexOf("#");
	const query = target.indexOf("?");
	const end = Math.min(hash < 0 ? target.length : hash, query < 0 ? target.length : query);
	let pathPart = target.slice(0, end);
	try {
		pathPart = decodeURIComponent(pathPart);
	} catch {
		// A malformed escape keeps the destination as written.
	}
	pathPart = pathPart.replace(/\.(md|mdx)$/i, "").trim();
	if (!pathPart) return undefined;
	let anchor = hash >= 0 ? target.slice(hash + 1) : "";
	try {
		anchor = decodeURIComponent(anchor);
	} catch {
		// Same as the path.
	}
	return {
		raw,
		target: pathPart,
		isEmbed,
		subpath: subpathFrom(anchor),
		isCurrentPageReference: false,
	};
}

function obsidianUriToWikiLink(uri: string, raw: string): ParsedWikiLink | undefined {
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		return undefined;
	}
	if (parsed.hostname.toLowerCase() !== "open") return undefined;
	let target = parsed.searchParams.get("file") ?? parsed.searchParams.get("path") ?? "";
	let anchor = parsed.searchParams.get("subpath") ?? "";
	const hash = target.indexOf("#");
	if (hash >= 0) {
		anchor = target.slice(hash + 1);
		target = target.slice(0, hash);
	}
	target = target.replace(/\.(md|mdx)$/i, "").trim();
	if (!target) return undefined;
	return {
		raw,
		target,
		isEmbed: false,
		subpath: subpathFrom(anchor),
		isCurrentPageReference: false,
	};
}

/**
 * Frontmatter tags: a YAML list, or the legacy single string Obsidian splits
 * on commas and spaces (`tags: a, b` and `tags: a b` are two tags).
 */
export function frontmatterTagValues(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,\s]+/) : [];
	const tags: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string" && typeof entry !== "number") continue;
		const tag = tagNameFromMatch(String(entry).trim().replace(/^#/, ""));
		if (tag) tags.push(tag);
	}
	return tags;
}

/**
 * Wikilinks in frontmatter values, walked once per container: YAML anchors let
 * one list appear under many keys (an alias bomb has exponentially many paths)
 * or inside itself (`&a [*a]`), and a container already visited holds the same
 * links, so skipping it loses nothing.
 */
function collectPropertyLinks(
	value: unknown,
	into: ParsedWikiLink[],
	seen = new WeakSet<object>(),
): void {
	if (typeof value === "string") {
		for (const match of findWikilinkMatches(value)) {
			into.push(parseWikiLink(match.inner, match.fullMatch));
		}
		return;
	}
	if (!value || typeof value !== "object" || value instanceof Date || seen.has(value)) return;
	seen.add(value);
	for (const entry of Array.isArray(value) ? value : Object.values(value)) {
		collectPropertyLinks(entry, into, seen);
	}
}

/**
 * The prose of a note: content lines only, code spans then comments blanked
 * (a `%%` inside a code span is literal text in Obsidian).
 */
export function proseText(lines: string[], isContent: boolean[]): string {
	const content = lines.map((line, index) => (isContent[index] ? line : "")).join("\n");
	return blank(blank(content, CODE_SPAN), COMMENTS);
}

/** Links and tags of one note; see {@link PageLinks}. */
export function extractPageLinks(markdown: string): PageLinks {
	let frontmatter: Record<string, unknown> = {};
	try {
		frontmatter = parseFrontmatter(markdown).data;
	} catch {
		// Unreadable frontmatter contributes nothing; the index reports it.
	}
	const lines = markdown.split(/\r?\n/);
	return extractPageLinksFrom(lines, getContentLineFlags(lines), frontmatter);
}

/** {@link extractPageLinks} over an already split and parsed note. */
export function extractPageLinksFrom(
	lines: string[],
	isContent: boolean[],
	frontmatter: Record<string, unknown>,
): PageLinks {
	const prose = proseText(lines, isContent);
	const outlinks: ParsedWikiLink[] = [];
	const seen = new Set<string>();
	const add = (link: ParsedWikiLink | undefined): void => {
		if (!link || link.search || link.isCurrentPageReference || !link.target.trim()) return;
		const key = `${link.isEmbed ? "!" : ""}${link.target}#${link.subpath?.kind ?? ""}:${link.subpath?.value ?? ""}`;
		if (seen.has(key)) return;
		seen.add(key);
		outlinks.push(link);
	};

	let withoutWikilinks = "";
	let cursor = 0;
	for (const match of findWikilinkMatches(prose)) {
		// Inside a table Obsidian writes the alias pipe escaped (`[[Page\|Alias]]`)
		// and the rendered table cell sees a plain `|`, so it splits the alias too.
		const inner =
			!/(?:^|[^\\])\|/.test(match.inner) && match.inner.includes("\\|")
				? match.inner.replace("\\|", "|")
				: match.inner;
		add(parseWikiLink(inner, match.fullMatch));
		withoutWikilinks += prose.slice(cursor, match.start) + " ".repeat(match.end - match.start);
		cursor = match.end;
	}
	withoutWikilinks += prose.slice(cursor);

	const scanMarkdownLinks = (text: string): void => {
		for (const match of text.matchAll(MARKDOWN_LINK)) {
			add(markdownDestinationToWikiLink(match[3] ?? "", match[0], match[1] === "!"));
			// A linked image (`[![alt](img.png)](Note.md)`) links both files.
			if (match[2]?.includes("](")) scanMarkdownLinks(match[2]);
		}
	};
	scanMarkdownLinks(withoutWikilinks);
	for (const match of withoutWikilinks.matchAll(DEFINITION)) {
		add(markdownDestinationToWikiLink(match[2] ?? "", match[0], false));
	}

	const propertyLinks: ParsedWikiLink[] = [];
	collectPropertyLinks(frontmatter, propertyLinks);
	for (const link of propertyLinks) add(link);

	const tags = new Map<string, string>();
	const addTag = (tag: string | undefined): void => {
		if (!tag) return;
		const key = tag.normalize("NFC").toLowerCase();
		if (!tags.has(key)) tags.set(key, tag);
	};
	for (const tag of frontmatterTagValues(frontmatter.tags ?? frontmatter.tag)) addTag(tag);
	// A link's label is prose; its destination (`[x](#install)`) is not.
	const tagText = withoutWikilinks
		.replace(
			MARKDOWN_LINK,
			(_match, _bang: string, label: string) => ` ${label.replace(/\]\([^)]*\)/g, "]")} `,
		)
		.replace(DEFINITION, " ")
		.replace(URL_LIKE, " ")
		.replace(HTML_TAG, " ")
		.replace(/\\#/g, " ");
	for (const match of tagText.matchAll(INLINE_TAG_PATTERN))
		addTag(tagNameFromMatch(match[1] ?? ""));

	return { outlinks, tags: [...tags.values()] };
}
