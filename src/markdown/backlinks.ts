import { escapeHtmlText } from "../shared/escape.js";
import type { MentionRef } from "./mentions.js";
import { parseWikiLink } from "./parse-wikilink.js";
import { resolveWikiLink } from "./resolve-wikilink.js";
import type { BacklinkRef, ContentIndex, ContentPage, NormalizedPluginOptions } from "./types.js";
import { backlinkLabel, routeHref } from "./utils.js";

export type { BacklinkRef };

type ResolveOptions = Partial<
	Pick<NormalizedPluginOptions, "enableCaseInsensitiveLookup" | "enableFuzzyMatching">
>;

/**
 * Record in `into` every link from a page of `sourceIndex` to a page of
 * `targetIndex`, keyed by the target's route.
 *
 * Each link is resolved with {@link resolveWikiLink} — the resolver the
 * rendered page uses — so a backlink exists exactly when the link renders as a
 * link to that page (an ambiguous name counts for the file it resolves to, a
 * missing heading still for its page). When the two indexes differ the source
 * page's own tree is tried first, so a docs page only backlinks a vault note
 * its link actually reaches.
 */
export function collectBacklinks(
	sourceIndex: ContentIndex,
	targetIndex: ContentIndex,
	options: ResolveOptions,
	into: Map<string, BacklinkRef[]>,
): void {
	const fallbackIndexes = sourceIndex === targetIndex ? [] : [targetIndex];
	for (const page of sourceIndex.pages) {
		const links =
			page.outlinks ?? page.wikilinkTargets.map((target) => parseWikiLink(target, `[[${target}]]`));
		for (const link of links) {
			const target = resolveWikiLink(link, {
				currentPage: page,
				index: sourceIndex,
				fallbackIndexes,
				options,
			}).targetPage;
			if (!target || target.absolutePath === page.absolutePath) continue;
			if (targetIndex.byAbsolutePath.get(target.absolutePath) !== target) continue;
			addBacklink(into, target.routePath, page);
		}
	}
}

/**
 * Backlinks for the pages of `index`: its own, plus those from the other trees
 * published on the site (`index.linkedIndexes`), so a docs page linking a
 * vault note shows up in that note's panel and vice versa.
 *
 * Cached per index and per set of linked indexes; a hand-built index without
 * a precomputed map gets one built here.
 */
const backlinksCache = new WeakMap<
	ContentIndex,
	{ linked: ContentIndex[]; result: Map<string, BacklinkRef[]> }
>();

export async function getCachedBacklinksIndex(
	index: ContentIndex,
): Promise<Map<string, BacklinkRef[]>> {
	const linked = index.linkedIndexes ?? [];
	const cached = backlinksCache.get(index);
	if (
		cached &&
		cached.linked.length === linked.length &&
		cached.linked.every((entry, position) => entry === linked[position])
	) {
		return cached.result;
	}

	const own =
		index.backlinks.size > 0 || index.pages.length === 0
			? index.backlinks
			: await buildBacklinksIndex(index);
	let result = own;
	if (linked.length > 0) {
		result = new Map([...own].map(([route, refs]) => [route, [...refs]]));
		for (const other of linked) {
			if (other !== index)
				collectBacklinks(other, index, { enableCaseInsensitiveLookup: true }, result);
		}
	}
	backlinksCache.set(index, { linked: [...linked], result });
	return result;
}

/**
 * Build a map from each page's routePath to the list of pages that link to it,
 * for an index assembled by hand (one from `buildContentIndex` already has it).
 */
export async function buildBacklinksIndex(
	index: ContentIndex,
): Promise<Map<string, BacklinkRef[]>> {
	const backlinks = new Map<string, BacklinkRef[]>();
	collectBacklinks(index, index, { enableCaseInsensitiveLookup: true }, backlinks);
	return backlinks;
}

function addBacklink(
	backlinks: Map<string, BacklinkRef[]>,
	targetRoutePath: string,
	sourcePage: ContentPage,
): void {
	const existing = backlinks.get(targetRoutePath) ?? [];
	const already = existing.some((e) => e.routePath === sourcePage.routePath);
	if (!already) {
		existing.push({
			routePath: sourcePage.routePath,
			relativePath: sourcePage.relativePath,
			title: backlinkLabel(sourcePage),
		});
		backlinks.set(targetRoutePath, existing);
	}
}

/**
 * Render a backlinks panel as raw HTML. Returns the empty string when
 * there are no refs so the caller can unconditionally append the result.
 * The output is wrapped in `<div class="obsidian-backlinks">` and uses the
 * `.obsidian-backlinks` selectors in the bundled stylesheet. `rp-toc-exclude`
 * keeps its id-less headings out of Rspress's outline, where they would link
 * nowhere; Obsidian's outline does not list the backlinks pane either.
 */
export function renderBacklinksHtml(refs: BacklinkRef[], mentions: MentionRef[] = []): string {
	const sections: string[] = [];

	if (refs.length > 0) {
		const items = refs
			.map(
				(r) =>
					`<li><a href="${routeHref(r.routePath, r.relativePath ?? "")}">${escapeHtmlText(r.title)}</a></li>`,
			)
			.join("\n");
		sections.push(
			`<div class="obsidian-backlinks rp-toc-exclude">\n<h2>Backlinks</h2>\n<ul>\n${items}\n</ul>\n</div>`,
		);
	}

	// Obsidian lists pages that name this one without linking to it next to the
	// linked ones; the two lists are rendered as separate sections so a reader can
	// tell a real link from a passing mention.
	if (mentions.length > 0) {
		const items = mentions
			.map(
				(mention) =>
					`<li><a href="${routeHref(mention.routePath, mention.relativePath ?? "")}">${escapeHtmlText(mention.title)}</a> <span class="obsidian-mention-context">${escapeHtmlText(mention.snippet)}</span></li>`,
			)
			.join("\n");
		sections.push(
			`<div class="obsidian-backlinks obsidian-unlinked-mentions rp-toc-exclude">\n<h2>Unlinked mentions</h2>\n<ul>\n${items}\n</ul>\n</div>`,
		);
	}

	return sections.join("\n");
}
