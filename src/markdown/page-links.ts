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
import { blankComments } from "./comments.js";
import { findWikilinkMatches, parseWikiLink } from "./parse-wikilink.js";
import type { CacheLink, ParsedWikiLink, WikiSubpath } from "./types.js";

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
	/**
	 * The same links as Obsidian's metadata cache lists them for `file.links`:
	 * frontmatter properties first, then body links in source order, then the
	 * body's embeds. Repeats are kept and every target stays as written — a
	 * wikilink keeps its `.md`, a markdown destination is decoded the way
	 * `decodeURI` decodes it (`%26` stays) — because `file.hasLink("Foo.md")`
	 * must answer exactly like Obsidian's.
	 */
	fileLinks: CacheLink[];
	/** Frontmatter and inline tags, without `#`, first spelling per tag kept. */
	tags: string[];
}

// A code span closes on a backtick run of the same length (CommonMark) and
// never crosses a blank line.
const CODE_SPAN = /(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g;
const MARKDOWN_LINK =
	/(!?)\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*(<[^>\n]+>|(?:[^()\s]|\([^()\s]*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
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

/** The cache record of a parsed wikilink, target written back with its subpath. */
function cacheLinkOf(link: ParsedWikiLink, origin: CacheLink["origin"]): CacheLink | undefined {
	if (link.search || link.isCurrentPageReference || !link.target.trim()) return undefined;
	const suffix = link.subpath
		? `#${link.subpath.kind === "block" ? "^" : ""}${link.subpath.value}`
		: "";
	const shown = link.target.replace(/\.md$/i, "");
	const display =
		link.alias ??
		(link.subpath
			? `${shown} > ${link.subpath.kind === "block" ? "^" : ""}${link.subpath.value}`
			: shown);
	return { target: `${link.target}${suffix}`, display, isEmbed: link.isEmbed, origin };
}

/** The cache record of a markdown link, with the label Obsidian shows for it. */
function markdownCacheLink(
	destination: string,
	label: string | undefined,
	isEmbed: boolean,
	origin: CacheLink["origin"] = "body",
): CacheLink | undefined {
	const target = markdownDestinationAsWritten(destination);
	if (!target) return undefined;
	const display = label?.trim() || target;
	return { target, display, isEmbed, origin };
}

/**
 * A markdown destination in the form Obsidian's metadata cache records it:
 * a relative file reference stays as written except that `decodeURI` runs on
 * its path (`%26` is reserved, so it survives), the extension included.
 * `undefined` for the destinations that name no file.
 */
function markdownDestinationAsWritten(destination: string): string | undefined {
	let target = destination.trim();
	if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1).trim();
	if (/^obsidian:\/\//i.test(target)) return obsidianUriAsWritten(target);
	if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || /^[/#]/.test(target)) return undefined;
	const hash = target.indexOf("#");
	const query = target.indexOf("?");
	const end = Math.min(hash < 0 ? target.length : hash, query < 0 ? target.length : query);
	let pathPart = target.slice(0, end);
	try {
		pathPart = decodeURI(pathPart);
	} catch {
		// A malformed escape keeps the destination as written.
	}
	pathPart = pathPart.trim();
	return pathPart || undefined;
}

/** The `file` (or `path`) an `obsidian://open` URI names, as written. */
function obsidianUriAsWritten(uri: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		return undefined;
	}
	if (parsed.hostname.toLowerCase() !== "open") return undefined;
	const target = parsed.searchParams.get("file") ?? parsed.searchParams.get("path") ?? "";
	const hash = target.indexOf("#");
	const file = (hash >= 0 ? target.slice(0, hash) : target).trim();
	return file || undefined;
}

/**
 * A markdown destination as a wikilink, or `undefined` when it is not a
 * relative file reference: external URLs, protocol-relative and root-absolute
 * paths are site URLs, and a bare `#anchor` stays on the page.
 */
function markdownDestinationToWikiLink(
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
function frontmatterTagValues(value: unknown): string[] {
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
 * Links in frontmatter values, walked once per container: YAML anchors let one
 * list appear under many keys (an alias bomb has exponentially many paths) or
 * inside itself (`&a [*a]`), and a container already visited holds the same
 * links, so skipping it loses nothing.
 *
 * Records come out in value order, both kinds: a property holding
 * `"[Front MD](Other.md)"` is a link Obsidian reports, though only wikilinks
 * join `outlinks`.
 */
function collectPropertyLinks(
	value: unknown,
	wikilinks: ParsedWikiLink[],
	records: CacheLink[],
	seen = new WeakSet<object>(),
): void {
	if (typeof value === "string") {
		const found: Array<{ at: number; link?: ParsedWikiLink; record?: CacheLink }> = [];
		for (const match of findWikilinkMatches(value)) {
			const link = parseWikiLink(match.inner, match.fullMatch);
			found.push({ at: match.start, link, record: cacheLinkOf(link, "property") });
		}
		for (const match of value.matchAll(MARKDOWN_LINK)) {
			found.push({
				at: match.index ?? 0,
				record: markdownCacheLink(match[3] ?? "", match[2], match[1] === "!", "property"),
			});
		}
		found.sort((a, b) => a.at - b.at);
		for (const entry of found) {
			if (entry.link) wikilinks.push(entry.link);
			if (entry.record) records.push(entry.record);
		}
		return;
	}
	if (!value || typeof value !== "object" || value instanceof Date || seen.has(value)) return;
	seen.add(value);
	for (const entry of Array.isArray(value) ? value : Object.values(value)) {
		collectPropertyLinks(entry, wikilinks, records, seen);
	}
}

/**
 * The prose of a note: content lines only, comments then code spans blanked.
 * Comments are found by `comments.ts`, which already skips code spans (a `%%`
 * inside one is literal text in Obsidian).
 */
function proseText(lines: string[], isContent: boolean[]): string {
	const content = lines.map((line, index) => (isContent[index] ? line : "")).join("\n");
	return blank(blankComments(content), CODE_SPAN);
}

/** Links and tags of one note; see {@link PageLinks}. */
export function extractPageLinks(markdown: string, options: PageLinkOptions = {}): PageLinks {
	let frontmatter: Record<string, unknown> = {};
	try {
		frontmatter = parseFrontmatter(markdown).data;
	} catch {
		// Unreadable frontmatter contributes nothing; the index reports it.
	}
	const lines = markdown.split(/\r?\n/);
	return extractPageLinksFrom(lines, getContentLineFlags(lines), frontmatter, options);
}

/** How a consumer wants links ordered and repeated; see {@link extractPageLinksFrom}. */
export interface PageLinkOptions {
	/**
	 * Drop a link that repeats an earlier one (same target, embed flag and
	 * subpath). Default `true`: the site model counts a link once. Obsidian's
	 * metadata cache keeps repeats, and Bases reports `file.links` from it.
	 */
	dedupe?: boolean;
	/**
	 * Report frontmatter property links before body links. Default `false` (body
	 * first, as a reader meets them); Bases wants Obsidian's cache order.
	 */
	frontmatterFirst?: boolean;
}

/** {@link extractPageLinks} over an already split and parsed note. */
export function extractPageLinksFrom(
	lines: string[],
	isContent: boolean[],
	frontmatter: Record<string, unknown>,
	options: PageLinkOptions = {},
): PageLinks {
	const prose = proseText(lines, isContent);
	const body: ParsedWikiLink[] = [];
	const property: ParsedWikiLink[] = [];
	/** Body records with where their link starts, so `fileLinks` is source order. */
	const bodyCache: Array<{ at: number; record: CacheLink }> = [];
	const propertyCache: CacheLink[] = [];
	const seen = new Set<string>();
	const add = (link: ParsedWikiLink | undefined, into: ParsedWikiLink[]): void => {
		if (!link || link.search || link.isCurrentPageReference || !link.target.trim()) return;
		if (options.dedupe !== false) {
			const key = `${link.isEmbed ? "!" : ""}${link.target}#${link.subpath?.kind ?? ""}:${link.subpath?.value ?? ""}`;
			if (seen.has(key)) return;
			seen.add(key);
		}
		into.push(link);
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
		const parsed = parseWikiLink(inner, match.fullMatch);
		add(parsed, body);
		const record = cacheLinkOf(parsed, "body");
		if (record) bodyCache.push({ at: match.start, record });
		withoutWikilinks += prose.slice(cursor, match.start) + " ".repeat(match.end - match.start);
		cursor = match.end;
	}
	withoutWikilinks += prose.slice(cursor);

	const scanMarkdownLinks = (text: string, offset: number): void => {
		for (const match of text.matchAll(MARKDOWN_LINK)) {
			const at = offset + (match.index ?? 0);
			const isEmbed = match[1] === "!";
			add(markdownDestinationToWikiLink(match[3] ?? "", match[0], isEmbed), body);
			const record = markdownCacheLink(match[3] ?? "", match[2], isEmbed);
			if (record) bodyCache.push({ at, record });
			// A linked image (`[![alt](img.png)](Note.md)`) links both files.
			if (match[2]?.includes("](")) scanMarkdownLinks(match[2], at);
		}
	};
	scanMarkdownLinks(withoutWikilinks, 0);
	for (const match of withoutWikilinks.matchAll(DEFINITION)) {
		add(markdownDestinationToWikiLink(match[2] ?? "", match[0], false), body);
		const record = markdownCacheLink(match[2] ?? "", match[1], false);
		if (record) bodyCache.push({ at: match.index ?? 0, record });
	}

	const propertyLinks: ParsedWikiLink[] = [];
	collectPropertyLinks(frontmatter, propertyLinks, propertyCache);
	for (const link of propertyLinks) add(link, property);

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

	const outlinks = options.frontmatterFirst ? [...property, ...body] : [...body, ...property];
	const bodyRecords = bodyCache.sort((a, b) => a.at - b.at).map((entry) => entry.record);
	const fileLinks = [
		...propertyCache,
		...bodyRecords.filter((link) => !link.isEmbed),
		...bodyRecords.filter((link) => link.isEmbed),
	];
	return { outlinks, fileLinks, tags: [...tags.values()] };
}
