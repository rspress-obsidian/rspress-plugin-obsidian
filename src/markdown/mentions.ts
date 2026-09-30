/**
 * Unlinked mentions: pages that name another page without linking to it.
 *
 * Obsidian's backlinks pane lists these next to the linked ones, and this
 * plugin only had the linked half. The matcher is a pure function over text the
 * caller has already collected, so it stays testable without a vault and
 * without importing the index that will import it.
 *
 * Deliberately self-contained: `src/markdown/content-index.ts` will call this,
 * so it must not import that module's fence helpers back.
 */
import { normalizeUnicode } from "../shared/slug.js";
import type { ContentIndex, ContentPage } from "./types.js";

/** One page that mentions the target, with the surrounding text. */
export interface MentionRef {
	/** Route of the mentioning page. */
	routePath: string;
	/** Its vault-relative path, so the panel can emit the index-page href form. */
	relativePath: string;
	/** Its panel label. */
	title: string;
	/** Plain text around the match, whitespace-collapsed. */
	snippet: string;
}

export interface MentionSource {
	page: ContentPage;
	/** The page's body, already stripped of frontmatter and code. */
	text: string;
}

/** Characters of context kept on each side of a match. */
const SNIPPET_RADIUS = 70;
/** Mentions kept per target page — a long page can name another page many times. */
const MAX_MENTIONS_PER_PAGE = 20;
/** Names shorter than this are noise ("A", "vs") and match almost everything. */
const MIN_NAME_LENGTH = 3;

/** Drop a leading `---` frontmatter block, leaving an unclosed one alone. */
function stripLeadingFrontmatter(markdown: string): string {
	const lines = markdown.split(/\r?\n/);
	if ((lines[0] ?? "").trim() !== "---") return markdown;
	const end = lines.findIndex((line, index) => index > 0 && /^---\s*$/.test(line.trim()));
	return end === -1 ? markdown : lines.slice(end + 1).join("\n");
}

/** Strip frontmatter, fenced blocks, inline code and comments; keep prose. */
export function stripMentionText(markdown: string): string {
	const kept: string[] = [];
	let fence: string | null = null;

	for (const line of stripLeadingFrontmatter(markdown).split(/\r?\n/)) {
		const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
		if (fenceMatch) {
			const marker = fenceMatch[1] ?? "";
			if (fence === null) fence = marker[0] ?? "`";
			else if (marker[0] === fence) fence = null;
			continue;
		}
		if (fence !== null) continue;
		kept.push(line);
	}

	return (
		kept
			.join("\n")
			.replace(/%%[\s\S]*?%%/g, " ")
			.replace(/`[^`\n]*`/g, " ")
			// A markdown link's label is prose a reader sees; its destination is not.
			.replace(/\[([^\]]*)\]\([^)\s]*(?:\s+["'][^)]*["'])?\)/g, "$1")
			// Wikilinks and embeds are links, so only their display text can mention.
			.replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, _target: string, label?: string) =>
				label ? ` ${label} ` : " ",
			)
			.replace(/\[\^[^\]]*\]/g, " ")
			.replace(/\s+/g, " ")
			.trim()
	);
}

/** Names a page can be mentioned by: its title, aliases and file basename. */
function namesFor(page: ContentPage): string[] {
	const names = new Set<string>();
	// Fold to NFC: macOS hands back a decomposed basename while the prose that
	// mentions it is composed, so an unfolded key would never match its text.
	if (page.title) names.add(normalizeUnicode(page.title));
	for (const alias of page.aliases) names.add(normalizeUnicode(alias));
	if (page.baseName) names.add(normalizeUnicode(page.baseName));
	return [...names].filter((name) => name.trim().length >= MIN_NAME_LENGTH);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Map each page's route to the pages that name it without linking to it.
 *
 * A name shared by several pages is skipped, matching how the resolver treats an
 * ambiguous link target rather than guessing. Callers subtract the linked
 * mentions (`index.backlinks`) themselves; this function does not read the
 * index.
 */
export function buildMentionsIndex(sources: MentionSource[]): Map<string, MentionRef[]> {
	const routeByName = new Map<string, string>();
	const ambiguousNames = new Set<string>();
	const nameToRoute = new Map<string, string>();

	for (const { page } of sources) {
		for (const name of namesFor(page)) {
			const key = name.toLowerCase();
			const owner = nameToRoute.get(key);
			if (owner === undefined) {
				nameToRoute.set(key, page.routePath);
			} else if (owner !== page.routePath) {
				ambiguousNames.add(key);
			}
		}
	}

	for (const [key, route] of nameToRoute) {
		if (!ambiguousNames.has(key)) routeByName.set(key, route);
	}

	const pattern = [...routeByName.keys()]
		// Longest first so "Getting Started Guide" wins over "Getting Started".
		.sort((left, right) => right.length - left.length)
		.map(escapeRegExp)
		.join("|");

	const mentions = new Map<string, MentionRef[]>();
	if (!pattern) return mentions;

	const matcher = new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${pattern})(?![\\p{L}\\p{N}_-])`, "giu");

	for (const { page, text } of sources) {
		// Same fold as the name keys: a composed mention in a decomposed body
		// (or vice versa) would otherwise miss the pattern entirely.
		const haystack = normalizeUnicode(text);
		matcher.lastIndex = 0;
		for (const match of haystack.matchAll(matcher)) {
			const targetRoute = routeByName.get(match[0].toLowerCase());
			if (!targetRoute || targetRoute === page.routePath) continue;

			const start = Math.max(0, match.index - SNIPPET_RADIUS);
			const end = Math.min(haystack.length, match.index + match[0].length + SNIPPET_RADIUS);
			const snippet = `${start > 0 ? "…" : ""}${haystack.slice(start, end).trim()}${
				end < haystack.length ? "…" : ""
			}`;

			const bucket = mentions.get(targetRoute) ?? [];
			if (bucket.some((entry) => entry.routePath === page.routePath)) continue;
			if (bucket.length >= MAX_MENTIONS_PER_PAGE) continue;
			bucket.push({
				routePath: page.routePath,
				relativePath: page.relativePath,
				title: page.title ?? page.baseName,
				snippet,
			});
			mentions.set(targetRoute, bucket);
		}
	}

	return mentions;
}

/**
 * Stripped page text is kept beside the index rather than on `ContentPage`: the
 * index is the public type every consumer holds, and a mention source is only
 * ever needed while rendering the backlink panel.
 *
 * Keyed by index object, like `backlinks.ts` does for hand-built indexes, so a
 * rebuilt index never serves the previous generation's mentions.
 */
const sourcesByIndex = new WeakMap<ContentIndex, MentionSource[]>();
const mentionsByIndex = new WeakMap<ContentIndex, Map<string, MentionRef[]>>();

export function rememberMentionSources(index: ContentIndex, sources: MentionSource[]): void {
	sourcesByIndex.set(index, sources);
}

/**
 * Unlinked mentions for an index, computed once and cached.
 *
 * Pages that already link to the target are subtracted, because Obsidian lists
 * those under backlinks — the two lists must not overlap.
 */
export function getMentions(index: ContentIndex): Map<string, MentionRef[]> {
	const cached = mentionsByIndex.get(index);
	if (cached) return cached;

	const sources = sourcesByIndex.get(index) ?? [];
	const mentions = buildMentionsIndex(sources);

	for (const [targetRoute, entries] of mentions) {
		const linked = new Set(index.backlinks.get(targetRoute)?.map((ref) => ref.routePath) ?? []);
		if (linked.size === 0) continue;
		mentions.set(
			targetRoute,
			entries.filter((entry) => !linked.has(entry.routePath)),
		);
	}

	mentionsByIndex.set(index, mentions);
	return mentions;
}
