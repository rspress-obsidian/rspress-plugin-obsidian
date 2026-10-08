import { encodeTagPathSegment, tagRoutePath } from "../shared/paths.js";
import { normalizeUnicode } from "../shared/slug.js";
import type { ContentIndex, ContentPage } from "./types.js";
import { routeHref } from "./utils.js";

export { encodeTagPathSegment };

interface TagEntry {
	/** Every spelling seen, with how many pages used it, in first-seen order. */
	spellings: Map<string, number>;
	pages: ContentPage[];
}

/**
 * Collect unique tags from all pages of every index. Obsidian treats tags
 * case-insensitively, so `#Project` and `#project` are one tag; the key is the
 * lowercased NFC form {@link tagRoutePath} publishes it under.
 *
 * Nested tags (e.g. "parent/child") also generate entries for every ancestor
 * segment ("parent"), mirroring Obsidian's tag hierarchy behaviour.
 */
function collectTags(indexes: ContentIndex[]): Map<string, TagEntry> {
	const tagMap = new Map<string, TagEntry>();

	for (const index of indexes) {
		for (const page of index.pages) {
			// One count per page per spelling, so a page repeating `#Tag` ten
			// times does not outvote ten pages writing `#tag`.
			const seen = new Set<string>();
			for (const tag of page.tags) {
				const parts = tag.split("/");
				// The tag itself first, then its ancestors.
				for (let depth = parts.length; depth >= 1; depth--) {
					const spelling = parts.slice(0, depth).join("/");
					if (seen.has(spelling)) continue;
					seen.add(spelling);
					const key = normalizeUnicode(spelling).toLowerCase();
					const entry: TagEntry = tagMap.get(key) ?? { spellings: new Map(), pages: [] };
					tagMap.set(key, entry);
					entry.spellings.set(spelling, (entry.spellings.get(spelling) ?? 0) + 1);
					if (!entry.pages.includes(page)) entry.pages.push(page);
				}
			}
		}
	}

	return tagMap;
}

/** The spelling most pages use; the first one seen on a tie. */
function displayNameOf(entry: TagEntry): string {
	let best = "";
	let bestCount = 0;
	for (const [spelling, count] of entry.spellings) {
		if (count > bestCount) {
			best = spelling;
			bestCount = count;
		}
	}
	return best;
}

function escapeYamlDoubleQuoted(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t");
}

/**
 * Escape a string for safe inclusion as inline text in the generated page —
 * a heading, or a link label.
 *
 * These pages are parsed with raw HTML enabled, so the escaping has to hold in
 * both directions. HTML special characters are entity-escaped so the value can
 * never become an element, and link-label brackets and newlines are neutralised
 * so it cannot break out of the `[…](…)` it sits in and leave the rest of the
 * title as page content.
 *
 * These were two functions that disagreed: the heading escaped `& < > [ ] \n \r`
 * and the label only `\ [ ]`, so a `title` containing a newline produced
 * `- [hello\n<img src=x onerror=alert(1)>](/Eve)` and rendered a live element.
 */
function escapeMarkdownText(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/[[\]]/g, "\\$&")
		.replace(/\r?\n/g, " ");
}

function escapeMarkdownDestination(value: string): string {
	return value.replace(/[()]/g, "\\$&").replace(/\s/g, "%20");
}

function generateTagPageContent(displayName: string, pages: ContentPage[]): string {
	const listItems = pages
		.map((p) => {
			const label = escapeMarkdownText(p.title ?? p.baseName);
			const destination = escapeMarkdownDestination(routeHref(p.routePath, p.relativePath));
			return `- [${label}](${destination})`;
		})
		.join("\n");

	const escapedHeading = escapeMarkdownText(displayName);
	return [
		"---",
		`title: "#${escapeYamlDoubleQuoted(displayName)}"`,
		"---",
		"",
		// `\#`: the page's own title is not a link to itself.
		`# \\#${escapedHeading}`,
		"",
		listItems,
		"",
	].join("\n");
}

export interface AdditionalPage {
	routePath: string;
	content: string;
}

/**
 * Generate one AdditionalPage per tag across every index given — pass the docs
 * index and the vault index together, or the two would each add the same
 * `/tags/<tag>` route and Rspress refuses a duplicate route. Each page is
 * served at {@link tagRoutePath} and lists every page carrying the tag (or a
 * nested child of it), under the spelling most pages use.
 */
export function generateTagPages(...indexes: ContentIndex[]): AdditionalPage[] {
	return [...collectTags(indexes).values()].flatMap((entry) => {
		const displayName = displayNameOf(entry);
		if (encodeTagPathSegment(displayName).length === 0) return [];
		return [
			{
				routePath: tagRoutePath(displayName),
				content: generateTagPageContent(displayName, entry.pages),
			},
		];
	});
}
