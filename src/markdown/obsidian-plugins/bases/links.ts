/**
 * A note's links the way Obsidian's metadata cache lists them, which is what
 * `file.links` and `file.embeds` read: frontmatter links first, then the body's
 * links in source order, then its embeds in source order. Repeats are kept,
 * markdown links count (with their destination decoded as `decodeURI` does),
 * and external URLs do not. Each link keeps its path as written (with its
 * `#subpath`) and the text Obsidian displays for it.
 */
import { getContentLineFlags } from "../../../shared/content-flags.js";
import { proseText } from "../../page-links.js";
import { findWikilinkMatches } from "../../parse-wikilink.js";

/** One link of a note, before it is resolved. */
export interface LinkRecord {
	/** The target as written: `Other#Section One`, `./Other.md`, `Report Final.pdf`. */
	path: string;
	/** The alias or link text, else Obsidian's default (`Other > Section One`). */
	display: string;
	isEmbed: boolean;
}

export interface NoteLinks {
	/** `file.links`: frontmatter links, body links, then embeds. */
	links: LinkRecord[];
	/** `file.embeds`. */
	embeds: LinkRecord[];
}

// A destination may hold balanced parentheses: `[x](Notes/Plan (v2).md)`.
const MARKDOWN_LINK =
	/(!?)\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*(<[^>\n]+>|(?:[^()\s]|\([^()\s]*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
const WHOLE_MARKDOWN_LINK = /^\[([^\]]*)\]\(\s*(<[^>\n]+>|(?:[^()\s]|\([^()\s]*\))+)\s*\)$/;
const WHOLE_WIKILINK = /^!?\[\[([^\]]+)\]\]$/;
const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i;

/** Obsidian's display for a link without an alias: its name, or its path when it has folders, then `> subpath`. */
function defaultDisplay(path: string): string {
	const hash = path.indexOf("#");
	const base = hash < 0 ? path : path.slice(0, hash);
	const label = base.includes("/") ? base : base.replace(/\.md$/i, "");
	return hash < 0 ? label : `${label} > ${path.slice(hash + 1)}`;
}

/** `Target#sub|Alias` → its record; `undefined` for an empty target. */
function wikilinkRecord(inner: string, isEmbed: boolean): LinkRecord | undefined {
	const pipe = inner.search(/(?<!\\)\|/);
	const path = (pipe < 0 ? inner : inner.slice(0, pipe)).trim();
	if (path === "") return undefined;
	const alias = pipe < 0 ? "" : inner.slice(pipe + 1).trim();
	return { path, display: alias || defaultDisplay(path), isEmbed };
}

/** `[text](destination)` → its record; `undefined` for a URL or a link to a heading of the same note. */
function markdownRecord(
	text: string,
	destination: string,
	isEmbed: boolean,
): LinkRecord | undefined {
	let path = destination.replace(/^<|>$/g, "");
	if (path === "" || path.startsWith("#") || URL_SCHEME.test(path)) return undefined;
	try {
		// decodeURI, as Obsidian does: `%20` is a space, `%26` stays as written.
		path = decodeURI(path);
	} catch {
		// A malformed escape is kept as written.
	}
	return { path, display: text, isEmbed };
}

function frontmatterLinks(value: unknown, into: LinkRecord[]): void {
	if (typeof value === "string") {
		const text = value.trim();
		const wiki = WHOLE_WIKILINK.exec(text);
		const markdown = wiki ? null : WHOLE_MARKDOWN_LINK.exec(text);
		const record = wiki
			? wikilinkRecord(wiki[1] ?? "", false)
			: markdown
				? markdownRecord(markdown[1] ?? "", markdown[2] ?? "", false)
				: undefined;
		if (record) into.push(record);
		return;
	}
	if (!value || typeof value !== "object" || value instanceof Date) return;
	for (const entry of Array.isArray(value) ? value : Object.values(value)) {
		frontmatterLinks(entry, into);
	}
}

/** The links of a note, from its source and its parsed frontmatter. */
export function noteLinks(markdown: string, frontmatter: Record<string, unknown>): NoteLinks {
	const lines = markdown.split(/\r?\n/);
	const prose = proseText(lines, getContentLineFlags(lines));
	const found: { at: number; record: LinkRecord }[] = [];
	let withoutWikilinks = "";
	let cursor = 0;
	for (const match of findWikilinkMatches(prose)) {
		const record = wikilinkRecord(match.inner, match.fullMatch.startsWith("!"));
		if (record) found.push({ at: match.start, record });
		withoutWikilinks += prose.slice(cursor, match.start) + " ".repeat(match.end - match.start);
		cursor = match.end;
	}
	withoutWikilinks += prose.slice(cursor);
	for (const match of withoutWikilinks.matchAll(MARKDOWN_LINK)) {
		const record = markdownRecord(match[2] ?? "", match[3] ?? "", match[1] === "!");
		if (record) found.push({ at: match.index, record });
	}
	found.sort((a, b) => a.at - b.at);
	const head: LinkRecord[] = [];
	frontmatterLinks(frontmatter, head);
	const body = found.map(({ record }) => record);
	const embeds = body.filter((record) => record.isEmbed);
	return { links: [...head, ...body.filter((record) => !record.isEmbed), ...embeds], embeds };
}
