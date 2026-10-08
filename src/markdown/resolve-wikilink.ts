import path from "node:path";
import GithubSlugger from "github-slugger";
import { findCanvasBoard, findCanvasBoardByPath } from "../shared/canvas-routes.js";
import { findPublishedFileRoute } from "../shared/file-routes.js";
import { normalizeLookupValue, normalizeUnicode } from "../shared/slug.js";
import { headingAnchorText } from "./heading-text.js";
import type {
	ContentAsset,
	ContentIndex,
	ContentPage,
	HeadingEntry,
	ParsedWikiLink,
	ResolveContext,
	ResolvedWikiLink,
	WikiSubpath,
} from "./types.js";
import {
	formatAvailableBlocks,
	formatAvailableHeadings,
	normalizeFilePathKey,
	resolveRelativePathKey,
	routeHref,
	wikiLinkDisplayText,
} from "./utils.js";

type Candidate = ContentPage | ContentAsset;
type Match<T extends Candidate> = { found: T; ambiguity?: string };

/**
 * Resolve a parsed wikilink against the content index, returning a
 * {@link ResolvedWikiLink} with either an `href` + `label` on success or
 * a diagnostic status + `message` on failure.
 *
 * Resolution order for non-current-page links:
 * 1. `./` / `../` targets, relative to the linking note (no fallback)
 * 2. Exact vault path (page, then attachment); a published canvas board
 * 3. File name, or path suffix for `[[sub/Note]]` (attachment, then page)
 * 4. Frontmatter title or alias
 * 5. Case-insensitive path and name (on by default; `enableCaseInsensitiveLookup`)
 * 6. Case-insensitive suffix anywhere in the path (opt-in; `enableFuzzyMatching`)
 *
 * Steps 2–6 run against `context.index`, then against each fallback index (the
 * other tree published on the site). A name several files share resolves like
 * Obsidian — same folder as the linking note, then the shortest path, then the
 * alphabetically first — and carries `ambiguity` so the caller can report it.
 *
 * `label` is Obsidian's display text: see {@link wikiLinkDisplayText}.
 */
export function resolveWikiLink(parsed: ParsedWikiLink, context: ResolveContext): ResolvedWikiLink {
	if (parsed.search) {
		return resolveVaultSearch(parsed, context);
	}

	if (parsed.isCurrentPageReference) {
		return resolveCurrentPageReference(context.currentPage, parsed);
	}

	if (parsed.target.trim().length === 0) {
		return {
			status: "broken-page",
			message: `Wikilink target is empty in ${parsed.raw}.`,
		};
	}

	const caseInsensitive = context.options?.enableCaseInsensitiveLookup === true;
	const relativePathKey = resolveRelativePathKey(context.currentPage.relativePath, parsed.target);
	if (relativePathKey !== undefined) {
		const { index } = context;
		const source = context.currentPage;
		const exactPage = index.byFilePathKey.get(relativePathKey);
		const page = exactPage
			? { found: exactPage }
			: caseInsensitive
				? pickMany(index.byFilePathKeyCI.get(normalizeLookupValue(relativePathKey)), parsed, source)
				: undefined;
		if (page) return withAmbiguity(resolveAgainstPage(page.found, parsed), page.ambiguity);
		const exactAsset = index.byAssetPath.get(relativePathKey);
		const asset = exactAsset
			? { found: exactAsset }
			: caseInsensitive
				? pickMany(index.byAssetPathCI.get(relativePathKey.toLowerCase()), parsed, source)
				: undefined;
		if (asset) return withAmbiguity(resolveAgainstAsset(asset.found, parsed), asset.ambiguity);
		return {
			status: "broken-page",
			message: `Unable to resolve relative wikilink target "${parsed.target}" from ${context.currentPage.relativePath}.`,
		};
	}

	const indexes = [
		context.index,
		...(context.fallbackIndexes ?? context.index.linkedIndexes ?? []).filter(
			(index) => index !== context.index,
		),
	];
	const exactPathKey = normalizeFilePathKey(parsed.target);
	for (const [position, index] of indexes.entries()) {
		const exactPage = index.byFilePathKey.get(exactPathKey);
		if (exactPage) return resolveAgainstPage(exactPage, parsed);
		const exactAsset = index.byAssetPath.get(exactPathKey);
		if (exactAsset) return resolveAgainstAsset(exactAsset, parsed);

		// Before the name fan-out, consult the canvas registry directly: a page
		// whose index does not contain vault files would otherwise match stray
		// `.canvas` copies in that tree and pick the wrong one. The registry holds
		// the one board the canvas feature actually publishes.
		if (position === 0) {
			const canvasBoard = findCanvasBoard(parsed.target, caseInsensitive);
			if (canvasBoard) {
				return {
					status: "ok",
					href: canvasBoard.routePath,
					label: wikiLinkDisplayText(parsed),
					canvasSrc: canvasBoard.source,
				};
			}
		}

		const resolved = resolveByName(parsed, context, index, exactPathKey);
		if (resolved) return resolved;
	}

	return {
		status: "broken-page",
		message: `Unable to resolve wikilink target "${parsed.target}".`,
	};
}

/** Steps 3–6 of the ladder against one index. */
function resolveByName(
	parsed: ParsedWikiLink,
	context: ResolveContext,
	index: ContentIndex,
	pathKey: string,
): ResolvedWikiLink | undefined {
	const source = context.currentPage;
	const baseName = path.posix.basename(pathKey);
	const hasFolder = pathKey.includes("/");
	const lowerKey = pathKey.toLowerCase();
	// `[[sub/Note]]` names any `…/sub/Note` first; when no file sits under a
	// matching folder (a moved note, a link written against another layout)
	// the file name alone still decides, as it did before folders were read.
	const suffixFilter = <T extends Candidate>(candidates: T[] | undefined, lower: boolean) => {
		if (!hasFolder || !candidates) return candidates;
		const suffix = `/${lower ? lowerKey : pathKey}`;
		const under = candidates.filter((candidate) => {
			const key = "filePathKey" in candidate ? candidate.filePathKey : candidate.pathKey;
			return (lower ? key.toLowerCase() : key).endsWith(suffix);
		});
		return under.length > 0 ? under : candidates;
	};

	const asset = pickMany(suffixFilter(index.byAssetBaseName.get(baseName), false), parsed, source);
	if (asset) return withAmbiguity(resolveAgainstAsset(asset.found, parsed), asset.ambiguity);

	const page = pickMany(suffixFilter(index.byBaseName.get(baseName), false), parsed, source);
	if (page) return withAmbiguity(resolveAgainstPage(page.found, parsed), page.ambiguity);

	const metadata = pickMany(getMetadataCandidates(index, parsed.target), parsed, source);
	if (metadata)
		return withAmbiguity(resolveAgainstPage(metadata.found, parsed), metadata.ambiguity);

	if (context.options?.enableCaseInsensitiveLookup) {
		const ciAsset = pickMany(
			index.byAssetPathCI.get(lowerKey) ??
				suffixFilter(index.byAssetBaseNameCI.get(baseName.toLowerCase()), true),
			parsed,
			source,
		);
		if (ciAsset)
			return withAmbiguity(resolveAgainstAsset(ciAsset.found, parsed), ciAsset.ambiguity);

		const ciPage = pickMany(
			index.byFilePathKeyCI.get(normalizeLookupValue(pathKey)) ??
				suffixFilter(index.byBaseNameCI.get(normalizeLookupValue(baseName)), true),
			parsed,
			source,
		);
		if (ciPage) return withAmbiguity(resolveAgainstPage(ciPage.found, parsed), ciPage.ambiguity);
	}

	if (context.options?.enableFuzzyMatching) {
		const fuzzy = pickMany(
			index.pages.filter((candidate) => {
				const key = candidate.filePathKey.toLowerCase();
				return key === lowerKey || key.endsWith(`/${lowerKey}`);
			}),
			parsed,
			source,
		);
		if (fuzzy) return withAmbiguity(resolveAgainstPage(fuzzy.found, parsed), fuzzy.ambiguity);
	}

	return undefined;
}

function withAmbiguity(result: ResolvedWikiLink, ambiguity: string | undefined): ResolvedWikiLink {
	return ambiguity && result.status === "ok" ? { ...result, ambiguity } : result;
}

/**
 * Obsidian's choice among files sharing a name: one in the linking note's own
 * folder, else the one with the shortest path, else the alphabetically first.
 */
function pickMany<T extends Candidate>(
	candidates: T[] | undefined,
	parsed: ParsedWikiLink,
	source: ContentPage,
): Match<T> | undefined {
	if (!candidates || candidates.length === 0) return undefined;
	const unique = [...new Map(candidates.map((c) => [c.absolutePath, c])).values()];
	const first = unique[0];
	if (unique.length === 1 && first) return { found: first };

	const sourceFolder = path.posix.dirname(source.relativePath);
	const rank = (candidate: Candidate): [number, number, number] => [
		path.posix.dirname(candidate.relativePath) === sourceFolder ? 0 : 1,
		candidate.relativePath.split("/").length,
		candidate.relativePath.length,
	];
	const sorted = unique
		.map((candidate) => ({ candidate, rank: rank(candidate) }))
		.sort(
			(left, right) =>
				left.rank[0] - right.rank[0] ||
				left.rank[1] - right.rank[1] ||
				left.rank[2] - right.rank[2] ||
				(left.candidate.relativePath < right.candidate.relativePath ? -1 : 1),
		)
		.map((entry) => entry.candidate);
	const found = sorted[0] as T;
	return {
		found,
		ambiguity: `Wikilink target "${parsed.target}" matches ${sorted.length} files (${sorted
			.map((candidate) => candidate.relativePath)
			.join(", ")}); linked to ${found.relativePath}. Use a path-qualified link to choose.`,
	};
}

function resolveVaultSearch(parsed: ParsedWikiLink, context: ResolveContext): ResolvedWikiLink {
	const query = parsed.subpath?.value.trim().toLowerCase() ?? "";
	if (!query || !parsed.search) {
		return {
			status: "broken-page",
			message: `Vault search target is empty in ${parsed.raw}.`,
		};
	}

	const matches: Array<{
		page: ContentPage;
		fragment: string;
		label: string;
		description?: string;
	}> = [];

	for (const page of context.index.pages) {
		if (parsed.search === "heading") {
			for (const heading of page.headings) {
				if (heading.rawText.toLowerCase().includes(query)) {
					matches.push({
						page,
						fragment: heading.explicitId ?? heading.slug,
						label: heading.rawText,
						description: heading.preview,
					});
				}
			}
		} else {
			for (const block of page.blocks) {
				if (block.id.toLowerCase().includes(query)) {
					matches.push({
						page,
						fragment: `^${block.id}`,
						label: `^${block.id}`,
					});
				}
			}
		}
	}

	if (matches.length === 0) {
		return {
			status: "broken-page",
			message: `Vault search target "${parsed.subpath?.value}" did not match any ${parsed.search}.`,
		};
	}
	if (matches.length > 1) {
		// Obsidian opens a picker of matches here rather than refusing the link,
		// so the candidates travel with the result and the remark pass renders
		// them as an inline picker.
		return {
			status: "ambiguous-page",
			message: `Vault search target "${parsed.subpath?.value}" matched multiple ${parsed.search} results.`,
			candidates: matches.map((match) => ({
				href: `${routeHref(match.page.routePath, match.page.relativePath)}#${match.fragment}`,
				label: parsed.alias ?? (parsed.search === "block" ? match.label.slice(1) : match.label),
				pageLabel: match.page.title ?? match.page.baseName,
				description: match.description,
			})),
		};
	}

	const match = matches[0];
	if (!match) {
		return {
			status: "broken-page",
			message: `Vault search target "${parsed.subpath?.value}" did not match any ${parsed.search}.`,
		};
	}

	return {
		status: "ok",
		href: `${routeHref(match.page.routePath, match.page.relativePath)}#${match.fragment}`,
		label: parsed.alias ?? (parsed.search === "block" ? match.label.slice(1) : match.label),
		description: match.description,
		targetPage: match.page,
	};
}

function resolveCurrentPageReference(page: ContentPage, parsed: ParsedWikiLink): ResolvedWikiLink {
	const subpath = parsed.subpath;
	if (!subpath?.value) {
		return {
			status: "broken-anchor",
			message: "Missing current-page anchor target.",
		};
	}

	const resolved = resolveSubpath(page, subpath);
	if (!resolved) {
		return brokenAnchor(page, subpath);
	}

	return {
		status: "ok",
		href: `#${resolved.fragment}`,
		label: wikiLinkDisplayText(parsed),
		description: resolved.heading?.preview,
		targetPage: page,
	};
}

function brokenAnchor(page: ContentPage, subpath: WikiSubpath): ResolvedWikiLink {
	const suffix =
		subpath.kind === "heading" ? formatAvailableHeadings(page) : formatAvailableBlocks(page);
	return {
		status: "broken-anchor",
		message: `Unable to resolve ${describeSubpath(subpath)} in ${page.relativePath}.${suffix}`,
		// The page exists, so the link still counts as a backlink.
		targetPage: page,
	};
}

function resolveAgainstPage(page: ContentPage, parsed: ParsedWikiLink): ResolvedWikiLink {
	const label = wikiLinkDisplayText(parsed);
	const href = routeHref(page.routePath, page.relativePath);

	if (!parsed.subpath) {
		return { status: "ok", href, label, targetPage: page };
	}

	const resolved = resolveSubpath(page, parsed.subpath);
	if (!resolved) {
		return brokenAnchor(page, parsed.subpath);
	}

	return {
		status: "ok",
		href: `${href}#${resolved.fragment}`,
		label,
		description: resolved.heading?.preview,
		targetPage: page,
	};
}

function resolveAgainstAsset(asset: ContentAsset, parsed: ParsedWikiLink): ResolvedWikiLink {
	// A board the canvas feature published routes to its viewer page instead of
	// the raw JSON attachment, and carries its vault-relative path for the embed
	// syntax. A `#heading`/`#^block` subpath is dropped rather than appended: a
	// `.canvas` has no headings or block ids, and a dead anchor on the viewer
	// page would be worse than opening the board.
	const board = findCanvasBoardByPath(asset.absolutePath);
	if (board) {
		return {
			status: "ok",
			href: board.routePath,
			label: wikiLinkDisplayText(parsed),
			canvasSrc: board.source,
		};
	}
	// A file a feature publishes as a page (a `.base` view, a drawing) opens
	// that page; its `#subpath` (a base's view name) is kept as the fragment.
	const fileRoute = findPublishedFileRoute(asset.absolutePath);
	const fragment = parsed.subpath ? `#${parsed.subpath.value}` : "";
	if (fileRoute) {
		return {
			status: "ok",
			href: `${fileRoute.routePath}${fragment}`,
			label: wikiLinkDisplayText(parsed),
			fileRoute,
		};
	}
	return {
		status: "ok",
		href: `${asset.urlPath}${fragment}`,
		label: wikiLinkDisplayText(parsed),
		targetAsset: asset,
	};
}

function resolveSubpath(
	page: ContentPage,
	subpath: WikiSubpath,
): { fragment: string; heading?: HeadingEntry } | undefined {
	if (subpath.kind === "block") {
		const normalizedBlockId = normalizeLookupValue(subpath.value);
		const block = page.blocks.find((entry) => normalizeLookupValue(entry.id) === normalizedBlockId);
		return block ? { fragment: `^${block.id}` } : undefined;
	}

	const heading = findHeading(page, subpath.value);
	return heading ? { fragment: heading.explicitId ?? heading.slug, heading } : undefined;
}

/**
 * Obsidian's heading-name fold: link text cannot hold `#`, `|`, `^`, `:`, `%`,
 * `[`, `]` or `\`, so Obsidian writes a space in their place when it links a
 * heading containing them (`## Step 1: Setup` → `[[Note#Step 1 Setup]]`).
 */
function headingKey(text: string): string {
	return normalizeLookupValue(text.replace(/[#|^:%[\]\\]/g, " "));
}

/**
 * The heading an anchor names, matched exactly — by its id, its rendered text,
 * its source text, or the slug of the anchor — never by prefix or substring,
 * so a renamed heading is reported instead of silently landing elsewhere.
 * `A#B` is a path: `B` must sit under an `A` (intermediate levels may be
 * skipped, as in Obsidian).
 */
export function findHeading(page: ContentPage, anchor: string): HeadingEntry | undefined {
	const parts = anchor
		.split("#")
		.map((part) => part.trim())
		.filter(Boolean);
	if (parts.length === 0) return undefined;

	const keys = parts.map((part) => ({
		raw: part,
		key: headingKey(part),
		slug: new GithubSlugger().slug(headingAnchorText(normalizeUnicode(part))),
	}));
	const matches = (heading: HeadingEntry, key: (typeof keys)[number]): boolean =>
		heading.explicitId === key.raw ||
		heading.slug === key.raw ||
		headingKey(heading.rawText) === key.key ||
		(heading.sourceText !== undefined && headingKey(heading.sourceText) === key.key) ||
		(key.slug !== "" && heading.slug === key.slug);

	const last = keys[keys.length - 1];
	if (!last) return undefined;
	for (const [position, heading] of page.headings.entries()) {
		if (!matches(heading, last)) continue;
		let level = heading.depth ?? 7;
		let wanted = keys.length - 2;
		for (let previous = position - 1; previous >= 0 && wanted >= 0; previous -= 1) {
			const ancestor = page.headings[previous];
			if (!ancestor || (ancestor.depth ?? 0) >= level) continue;
			level = ancestor.depth ?? 0;
			const key = keys[wanted];
			if (key && matches(ancestor, key)) wanted -= 1;
		}
		if (wanted < 0) return heading;
	}
	return undefined;
}

/** The fragment a heading anchor resolves to on `page`, if it names one. */
export function resolveHeadingSlug(page: ContentPage, anchor: string): string | undefined {
	const heading = findHeading(page, anchor);
	return heading ? (heading.explicitId ?? heading.slug) : undefined;
}

function getMetadataCandidates(index: ContentIndex, target: string): ContentPage[] {
	const normalizedTarget = normalizeLookupValue(target);
	if (!normalizedTarget) {
		return [];
	}
	return [
		...(index.byTitle.get(normalizedTarget) ?? []),
		...(index.byAlias.get(normalizedTarget) ?? []),
	];
}

function describeSubpath(subpath: WikiSubpath): string {
	if (subpath.kind === "block") {
		return `block reference "^${subpath.value}"`;
	}

	return `anchor "${subpath.value}"`;
}
