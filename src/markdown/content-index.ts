import fs from "node:fs";
import path from "node:path";
import GithubSlugger from "github-slugger";
import { getContentLineFlags } from "../shared/content-flags.js";
import { PAGE_MARKDOWN_EXTENSIONS } from "../shared/extensions.js";
import { parseFrontmatter } from "../shared/frontmatter.js";
import { ATTACHMENT_EXTS, extensionOf } from "../shared/media-exts.js";
import { normalizeLookupValue, normalizeUnicode, stripMarkdownFormatting } from "../shared/slug.js";
import { extractDataviewMetadata } from "./dataview.js";
import { rememberMentionSources, stripMentionText } from "./mentions.js";
import { findWikilinkMatches, parseWikiLink } from "./parse-wikilink.js";
import type {
	BacklinkRef,
	BlockEntry,
	ContentAsset,
	ContentIndex,
	ContentPage,
	HeadingEntry,
} from "./types.js";

export type { ContentIndex } from "./types.js";

import {
	deriveRoutePath,
	normalizeFsPath,
	normalizeRoutePath as normalizePathKey,
	normalizeRoutePrefix,
} from "../shared/route-path.js";
import { backlinkLabel, normalizeFilePathKey, resolveRelativePathKey } from "./utils.js";

/** Longest stripped body retained per page for mention matching. */
const MAX_MENTION_TEXT = 20_000;
const INLINE_TAG_PATTERN =
	/(?<![/\p{L}\p{N}_-])#([\p{L}\p{M}\p{N}\p{Extended_Pictographic}_/-]+)/gu;

/** Maximum number of content indexes to cache simultaneously. Beyond this
 *  the least-recently-used entry is evicted. Rspress dev-server uses a single
 *  root, but tests and tooling may call {@link getCachedContentIndex} with
 *  many different directories in the same process. */
const MAX_CACHED_INDEXES = 10;

interface CacheEntry {
	signature: string;
	index: ContentIndex;
	/** Per-file parse results, keyed by absolute path, so an unchanged file is
	 *  reused across rebuilds instead of being re-read and re-parsed. */
	files: Map<string, ParsedFileEntry>;
}

interface ParsedFileEntry {
	mtimeMs: number;
	size: number;
	page: ContentPage;
	/** Stripped body, kept only while `unlinkedMentions` is on. */
	mentionText?: string;
}

interface MarkdownFileEntry {
	absolutePath: string;
	relativePath: string;
	ctimeMs: number;
	mtimeMs: number;
	size: number;
}

/** LRU cache keyed by resolved root directory. `Map` preserves insertion
 *  order — on access we delete-then-set to move the entry to the end, and
 *  evict the first entry when over capacity. */
const contentIndexCache = new Map<string, CacheEntry>();
/** Options controlling route and asset URLs for an indexed root. */
export interface ContentIndexOptions {
	routePrefix?: string;
	/**
	 * Keep a stripped copy of each page's body so `getMentions` can find pages
	 * that name another page without linking to it. Off by default: it is the only
	 * thing here that retains page text.
	 */
	unlinkedMentions?: boolean;
}

/**
 * The URL an attachment is served from, which is not always its path in the
 * tree it was found in.
 *
 * Rspress copies `public/` to the site root and nothing else, so an attachment
 * under `<root>/public/` is served at `/<path-after-public/>` — not at
 * `/public/<path>`, which no route serves. Getting this wrong is invisible until
 * a page embeds the file: the `src` looks reasonable and 404s in the browser.
 * It is not hypothetical, either. The vault plugin copies vault attachments into
 * `public/<vaultRoutePrefix>/` during the build, so on the next build the docs
 * index finds those copies and a `![[media/gradient.png]]` in a docs page
 * resolved to `/public/vault/media/gradient.png` rather than the
 * `/vault/media/gradient.png` the file was actually published at.
 */
function assetUrlPath(relativePath: string, routePrefix: string): string {
	const segments = [...routePrefix.split("/"), ...relativePath.split("/")].filter(
		(segment) => segment !== "",
	);
	// Only a leading `public` is stripped: a `public` further down the path is an
	// ordinary directory name.
	if (segments[0] === "public") segments.shift();
	return `/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

export async function buildContentIndex(
	rootDir: string,
	options: ContentIndexOptions = {},
): Promise<ContentIndex> {
	const absoluteRoot = path.resolve(rootDir);
	const routePrefix = normalizeRoutePrefix(options.routePrefix);
	const files = await scanVaultFiles(absoluteRoot);
	return buildContentIndexFromFiles(
		absoluteRoot,
		files,
		undefined,
		routePrefix,
		options.unlinkedMentions ?? false,
	);
}

/**
 * Like {@link buildContentIndex} but memoized on a per-root basis. The cache
 * is invalidated whenever any routable file changes.
 */
export async function getCachedContentIndex(
	rootDir: string,
	options: ContentIndexOptions = {},
): Promise<ContentIndex> {
	const absoluteRoot = path.resolve(rootDir);
	const routePrefix = normalizeRoutePrefix(options.routePrefix);
	// The flag is part of the key: an index built without mention text cannot
	// answer a request that needs it.
	const cacheKey = `${absoluteRoot}|${routePrefix}|mentions:${options.unlinkedMentions === true}`;
	const files = await scanVaultFiles(absoluteRoot);
	const signature = files
		.map((file) => `${file.relativePath}:${file.mtimeMs}:${file.size}`)
		.join("|");

	const cached = contentIndexCache.get(cacheKey);
	if (cached?.signature === signature) {
		contentIndexCache.delete(cacheKey);
		contentIndexCache.set(cacheKey, cached);
		return cached.index;
	}

	const priorFiles = cached?.files ?? new Map<string, ParsedFileEntry>();
	const index = await buildContentIndexFromFiles(
		absoluteRoot,
		files,
		priorFiles,
		routePrefix,
		options.unlinkedMentions ?? false,
	);
	contentIndexCache.set(cacheKey, { signature, index, files: priorFiles });

	// Evict least-recently-used entry (first in insertion order) when over cap.
	if (contentIndexCache.size > MAX_CACHED_INDEXES) {
		const oldest = contentIndexCache.keys().next().value;
		if (oldest !== undefined) {
			contentIndexCache.delete(oldest);
		}
	}

	return index;
}

async function buildContentIndexFromFiles(
	rootDir: string,
	files: MarkdownFileEntry[],
	priorFiles?: Map<string, ParsedFileEntry>,
	routePrefix = "",
	collectMentions = false,
): Promise<ContentIndex> {
	const markdownFiles = files.filter((file) =>
		PAGE_MARKDOWN_EXTENSIONS.has(path.extname(file.relativePath).toLowerCase()),
	);
	const settled = await Promise.allSettled(
		markdownFiles.map((file) => buildContentPage(file, priorFiles, routePrefix, collectMentions)),
	);
	const pages: ContentPage[] = [];
	for (const result of settled) {
		if (result.status === "fulfilled") {
			if (result.value.publish) {
				pages.push(result.value);
			}
		} else {
			console.warn(
				`[rspress-plugin-obsidian:markdown] Failed to index file: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
			);
		}
	}
	const assets: ContentAsset[] = files
		.filter((file) => !PAGE_MARKDOWN_EXTENSIONS.has(path.extname(file.relativePath).toLowerCase()))
		.map((file) => ({
			absolutePath: file.absolutePath,
			relativePath: file.relativePath,
			pathKey: normalizeUnicode(normalizePathKey(file.relativePath)),
			baseName: normalizeUnicode(path.basename(file.relativePath)),
			urlPath: assetUrlPath(file.relativePath, routePrefix),
		}));
	const byAbsolutePath = new Map<string, ContentPage>();
	const byPathKey = new Map<string, ContentPage>();
	const byFilePathKey = new Map<string, ContentPage>();
	const byBaseName = new Map<string, ContentPage[]>();
	const byTitle = new Map<string, ContentPage[]>();
	const byAlias = new Map<string, ContentPage[]>();
	const byTag = new Map<string, ContentPage[]>();
	const byAssetPath = new Map<string, ContentAsset>();
	const byAssetBaseName = new Map<string, ContentAsset[]>();
	const byPathKeyCI = new Map<string, ContentPage[]>();
	const byFilePathKeyCI = new Map<string, ContentPage[]>();
	const byBaseNameCI = new Map<string, ContentPage[]>();
	const byAssetPathCI = new Map<string, ContentAsset[]>();
	const byAssetBaseNameCI = new Map<string, ContentAsset[]>();

	for (const page of pages) {
		byAbsolutePath.set(page.absolutePath, page);
		byPathKey.set(page.pathKey, page);
		byFilePathKey.set(page.filePathKey, page);

		pushNamedPage(byPathKeyCI, page.pathKey.toLowerCase(), page);
		pushNamedPage(byFilePathKeyCI, page.filePathKey.toLowerCase(), page);

		if (page.baseName.length > 0) {
			const existing = byBaseName.get(page.baseName) ?? [];
			existing.push(page);
			byBaseName.set(page.baseName, existing);

			pushNamedPage(byBaseNameCI, page.baseName.toLowerCase(), page);
		}

		if (page.title) {
			pushNamedPage(byTitle, page.title, page);
		}

		for (const alias of page.aliases) {
			pushNamedPage(byAlias, alias, page);
		}

		for (const tag of page.tags) {
			pushNamedPage(byTag, tag, page);
			// For nested tags like "parent/child/leaf", also aggregate into
			// each ancestor segment so byTag["parent"] includes the page too.
			const parts = tag.split("/");
			for (let depth = 1; depth < parts.length; depth++) {
				pushNamedPage(byTag, parts.slice(0, depth).join("/"), page);
			}
		}
	}
	for (const asset of assets) {
		byAssetPath.set(asset.pathKey, asset);
		pushNamedAsset(byAssetPathCI, asset.pathKey.toLowerCase(), asset);
		const existing = byAssetBaseName.get(asset.baseName) ?? [];
		existing.push(asset);
		byAssetBaseName.set(asset.baseName, existing);
		pushNamedAsset(byAssetBaseNameCI, asset.baseName.toLowerCase(), asset);
	}

	const backlinks = new Map<string, BacklinkRef[]>();
	for (const page of pages) {
		for (const normalizedTarget of page.wikilinkTargets) {
			const resolved = resolveBacklinkTarget(
				byFilePathKey,
				byFilePathKeyCI,
				byBaseName,
				byBaseNameCI,
				byTitle,
				byAlias,
				normalizedTarget,
				page,
			);
			for (const candidate of resolved) {
				if (candidate.absolutePath === page.absolutePath) continue;
				addBacklinkEntry(backlinks, candidate.routePath, page);
			}
		}
	}

	const index: ContentIndex = {
		rootDir,
		pages,
		assets,
		byAbsolutePath,
		byPathKey,
		byFilePathKey,
		byBaseName,
		byTitle,
		byAlias,
		byTag,
		byAssetPath,
		byAssetBaseName,
		byPathKeyCI,
		byFilePathKeyCI,
		byBaseNameCI,
		byAssetPathCI,
		byAssetBaseNameCI,
		backlinks,
	};

	if (collectMentions) {
		rememberMentionSources(
			index,
			pages.map((page) => ({
				page,
				text: priorFiles?.get(page.absolutePath)?.mentionText ?? "",
			})),
		);
	}

	return index;
}
function resolveBacklinkTarget(
	byFilePathKey: Map<string, ContentPage>,
	byFilePathKeyCI: Map<string, ContentPage[]>,
	byBaseName: Map<string, ContentPage[]>,
	byBaseNameCI: Map<string, ContentPage[]>,
	byTitle: Map<string, ContentPage[]>,
	byAlias: Map<string, ContentPage[]>,
	normalizedTarget: string,
	sourcePage: ContentPage,
): ContentPage[] {
	const seen = new Set<string>();
	const results: ContentPage[] = [];

	const addPage = (page: ContentPage) => {
		if (!seen.has(page.absolutePath)) {
			seen.add(page.absolutePath);
			results.push(page);
		}
	};

	const relativePathKey = resolveRelativePathKey(sourcePage.relativePath, normalizedTarget);
	if (relativePathKey !== undefined) {
		const relativePages = byFilePathKeyCI.get(relativePathKey.toLowerCase());
		if (relativePages) {
			for (const page of relativePages) {
				addPage(page);
			}
		}
		return results;
	}

	const exactPage = byFilePathKey.get(normalizedTarget);
	if (exactPage) {
		addPage(exactPage);
		return results;
	}

	const exactCaseInsensitivePage = byFilePathKeyCI.get(normalizedTarget.toLowerCase());
	if (exactCaseInsensitivePage) {
		for (const page of exactCaseInsensitivePage) {
			addPage(page);
		}
		return results;
	}

	const baseName = path.basename(normalizedTarget) || normalizedTarget;
	const baseNameCandidates = byBaseName.get(baseName);
	if (baseNameCandidates) {
		for (const page of baseNameCandidates) {
			addPage(page);
		}
	}

	if (results.length === 0) {
		const ciBaseCandidates = byBaseNameCI.get(baseName);
		if (ciBaseCandidates) {
			for (const page of ciBaseCandidates) {
				addPage(page);
			}
		}
	}

	// Frontmatter title and alias lookups: targets are already lowercased and
	// slash-normalized during extraction, but title/alias keys are additionally
	// whitespace-normalized by normalizeLookupValue. Apply the same fold before
	// consulting those maps so `[[My Alias]]` records a backlink.
	if (results.length === 0) {
		const folded = normalizeUnicode(normalizeLookupValue(normalizedTarget));
		for (const page of byTitle.get(folded) ?? []) {
			addPage(page);
		}
		for (const page of byAlias.get(folded) ?? []) {
			addPage(page);
		}
	}

	return results;
}

function addBacklinkEntry(
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

async function scanVaultFiles(rootDir: string): Promise<MarkdownFileEntry[]> {
	const results: MarkdownFileEntry[] = [];
	const queue: string[] = [rootDir];

	while (queue.length > 0) {
		const currentDir = queue.shift();
		if (!currentDir) {
			continue;
		}

		const entries = await fs.promises.readdir(currentDir, {
			withFileTypes: true,
		});

		const subdirs: string[] = [];
		const fileStats: Promise<MarkdownFileEntry | undefined>[] = [];

		for (const entry of entries) {
			const absolutePath = path.join(currentDir, entry.name);

			if (entry.isDirectory()) {
				if (entry.name === ".git" || entry.name === "node_modules" || entry.name.startsWith(".")) {
					continue;
				}
				subdirs.push(absolutePath);
				continue;
			}

			if (!entry.isFile()) {
				continue;
			}

			const relativePath = normalizeFsPath(path.relative(rootDir, absolutePath));
			if (!isRoutableRelativePath(relativePath)) {
				continue;
			}

			fileStats.push(
				fs.promises
					.stat(absolutePath)
					.then((stats) => ({
						absolutePath: normalizeFsPath(path.resolve(absolutePath)),
						relativePath,
						ctimeMs: stats.ctimeMs,
						mtimeMs: stats.mtimeMs,
						size: stats.size,
					}))
					.catch(() => undefined),
			);
		}

		const settled = await Promise.all(fileStats);
		for (const entry of settled) {
			if (entry !== undefined) results.push(entry);
		}

		queue.push(...subdirs);
	}

	results.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
	return results;
}

function isRoutableRelativePath(relativePath: string): boolean {
	return relativePath.split("/").every((segment) => !/^_[^_]/.test(segment));
}

async function buildContentPage(
	file: MarkdownFileEntry,
	priorFiles?: Map<string, ParsedFileEntry>,
	routePrefix = "",
	collectMentions = false,
): Promise<ContentPage> {
	const cached = priorFiles?.get(file.absolutePath);
	if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
		return cached.page;
	}
	const markdown = await fs.promises.readFile(file.absolutePath, "utf-8");
	const routePath = deriveRoutePath(file.relativePath, routePrefix);
	const pathKey = normalizeUnicode(normalizePathKey(file.relativePath));
	const filePathKey = normalizeFilePathKey(file.relativePath);
	const baseName = path.basename(filePathKey);
	const metadata = extractFrontmatterMetadata(markdown, file.relativePath);
	const { title, aliases, tags, cssclasses, excerpt, publish } = metadata;
	const dataview = extractDataviewMetadata(markdown, metadata.frontmatter, file.relativePath);

	const lines = markdown.split(/\r?\n/);
	const isContent = getContentLineFlags(lines);
	const allTags = [...new Set([...tags, ...extractInlineTags(lines, isContent)])];
	const headings = extractHeadings(lines, isContent);

	// Pre-extract referenced page targets while we have the raw content in
	// memory. Restricted to content lines so references inside code fences,
	// inline code, comments, and frontmatter do not create backlinks.
	const wikilinkTargets = extractWikilinkTargets(lines, isContent);

	const headingBySlug = new Map<string, HeadingEntry>();
	const headingByText = new Map<string, HeadingEntry>();
	for (const h of headings) {
		headingBySlug.set(h.slug, h);
		if (h.explicitId) {
			headingBySlug.set(h.explicitId, h);
			headingBySlug.set(normalizeLookupValue(h.explicitId), h);
		}
		const normalizedText = normalizeLookupValue(h.rawText);
		if (!headingByText.has(normalizedText)) {
			headingByText.set(normalizedText, h);
		}
	}
	const blocks = extractBlocks(lines, isContent);
	const page: ContentPage = {
		absolutePath: file.absolutePath,
		title,
		relativePath: file.relativePath,
		routePath,
		pathKey,
		filePathKey,
		baseName,
		tags: allTags,
		aliases,
		cssclasses,
		excerpt,
		publish,
		fileCtimeMs: file.ctimeMs,
		fileMtimeMs: file.mtimeMs,
		fileSizeBytes: file.size,
		headings,
		wikilinkTargets,
		headingBySlug,
		headingByText,
		blocks,
		dataviewFields: dataview.fields,
		dataviewTasks: dataview.tasks,
		dataviewLists: dataview.lists,
	};

	const entry: ParsedFileEntry = {
		mtimeMs: file.mtimeMs,
		size: file.size,
		page,
	};
	if (collectMentions) {
		// ponytail: 20k chars of stripped body per page while the feature is on —
		// enough for a mention at the end of a long note; the ceiling is here so a
		// vault of 10k notes cannot pin hundreds of MB.
		entry.mentionText = stripMentionText(markdown).slice(0, MAX_MENTION_TEXT);
	}
	priorFiles?.set(file.absolutePath, entry);

	return page;
}

export { getContentLineFlags } from "../shared/content-flags.js";
export { deriveRoutePath, normalizeRoutePath as normalizePathKey } from "../shared/route-path.js";

function extractHeadings(lines: string[], isContent: boolean[]): HeadingEntry[] {
	const slugger = new GithubSlugger();
	const headings: HeadingEntry[] = [];
	const headingLineIndexes: number[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		if (!isContent[index]) {
			continue;
		}

		const line = lines[index] ?? "";

		const atxMatch = /^\s{0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(line);
		if (atxMatch) {
			pushHeading(headings, slugger, atxMatch[2] ?? "");
			headingLineIndexes.push(index);
			continue;
		}

		const nextLine = lines[index + 1] ?? "";
		if (!/^\s{0,3}(=+|-+)\s*$/.test(nextLine)) {
			continue;
		}

		const rawHeading = line.trim();
		if (rawHeading.length === 0) {
			continue;
		}

		pushHeading(headings, slugger, rawHeading);
		headingLineIndexes.push(index);
		index += 1; // skip the setext underline on the next iteration
	}

	// Second pass: extract preview text after each heading.
	// Collects content lines until the next heading at the same or higher level,
	// strips markdown formatting, and truncates to MAX_PREVIEW_LENGTH chars.
	// Extracted buildingContentPage allows showing tooltip previews on hover.
	const MAX_PREVIEW_LENGTH = 200;
	for (let h = 0; h < headings.length; h++) {
		const idx = headingLineIndexes[h];
		if (idx === undefined) continue;
		const startLine = idx + 1;
		const endLine =
			h + 1 < headings.length ? (headingLineIndexes[h + 1] ?? lines.length) : lines.length;
		const previewLines: string[] = [];
		let charCount = 0;

		for (let i = startLine; i < endLine && charCount < MAX_PREVIEW_LENGTH; i++) {
			if (!isContent[i]) continue;
			const text = stripMarkdownFormatting(lines[i] ?? "").trim();
			if (!text) continue;
			const remaining = MAX_PREVIEW_LENGTH - charCount;
			previewLines.push(text.length <= remaining ? text : text.slice(0, remaining));
			charCount += text.length;
		}

		if (previewLines.length > 0) {
			const entry = headings[h];
			if (entry) entry.preview = previewLines.join(" ");
		}
	}

	return headings;
}

function extractBlocks(lines: string[], isContent: boolean[]): BlockEntry[] {
	const blocks: BlockEntry[] = [];
	const seen = new Set<string>();

	for (let index = 0; index < lines.length; index += 1) {
		if (!isContent[index]) {
			continue;
		}

		const line = lines[index] ?? "";

		const standaloneMatch = /^\^([A-Za-z0-9_-]+)\s*$/.exec(line.trim());
		if (standaloneMatch?.[1]) {
			pushBlock(blocks, seen, standaloneMatch[1]);
			continue;
		}

		// Inline block ID: "Paragraph text ^block-id" appended at end of line
		const inlineBlockMatch = /\s\^([A-Za-z0-9_-]+)\s*$/.exec(line);
		if (inlineBlockMatch?.[1]) {
			pushBlock(blocks, seen, inlineBlockMatch[1]);
		}
	}

	return blocks;
}

/**
 * Extract unique normalized wikilink targets from a page's content lines.
 *
 * Only lines flagged as content by {@link getContentLineFlags} are scanned, and
 * inline code spans and `%% ... %%` comments are stripped first, so wikilinks
 * that never render as links (code blocks, inline code, comments, frontmatter)
 * do not create backlinks. The targets are lowercased, backslash-normalized,
 * and stripped of alias (`|...`) and anchor (`#...`) fragments — matching
 * exactly what the backlinks resolver needs, so it can skip regex scanning
 * entirely.
 */
function extractWikilinkTargets(lines: string[], isContent: boolean[]): string[] {
	const seen = new Set<string>();
	const targets: string[] = [];

	const content = lines
		.filter((_, index) => isContent[index])
		.join("\n")
		.replace(/(`+)[^`\n]*?\1/g, " ")
		.replace(/%%[\s\S]*?%%/g, " ");

	// One commit point for every target, whatever syntax produced it, so the
	// three filters below cannot drift between the loops: drop an attachment,
	// drop a repeat, keep the normalized path.
	//
	// `[[image.png]]` names a file, not a page. It can never resolve to one, so
	// keeping it bought nothing for backlinks — but it did reach Dataview, where
	// `file.outlinks` rendered it as a link to a route that does not exist.
	const addTarget = (path: string) => {
		if (!path || ATTACHMENT_EXTS.has(extensionOf(path))) return;
		const normalized = normalizeUnicode(path.replace(/\\/g, "/")).toLowerCase();
		if (seen.has(normalized)) return;
		seen.add(normalized);
		targets.push(normalized);
	};

	for (const match of findWikilinkMatches(content)) {
		const parsed = parseWikiLink(match.inner, match.fullMatch);
		if (parsed.target) addTarget(parsed.target);
	}

	// One normalizer for every Markdown-shaped destination, so an inline link
	// and a reference definition cannot drift on what counts as internal.
	const addMarkdownTarget = (raw: string) => {
		let target = raw.trim();
		if (target.startsWith("<") && target.endsWith(">")) {
			target = target.slice(1, -1);
		}
		if (
			!target ||
			/^[a-z][a-z0-9+.-]*:/i.test(target) ||
			target.startsWith("//") ||
			target.startsWith("#")
		) {
			return;
		}
		// Cut at whichever comes first, `#` or `?`, so `Note.md?from=docs`
		// resolves like the graph extractor already resolves it
		// (`cleanLinkTarget`, link-extractor.ts). Splitting at `#` alone left the
		// query in the path, the `.md` test below failed, and the link was
		// silently absent from the backlinks.
		const end = [target.indexOf("#"), target.indexOf("?")]
			.filter((index) => index >= 0)
			.reduce((min, index) => (index < min ? index : min), target.length);
		const pathPart = target.slice(0, end);
		if (!/\.(md|mdx)$/i.test(pathPart)) {
			return;
		}

		let normalized = pathPart.replace(/\.(md|mdx)$/i, "");
		try {
			normalized = decodeURIComponent(normalized);
		} catch {
			// Keep the raw path when a malformed escape appears in a link.
		}
		addTarget(normalized);
	};

	const markdownLinkPattern = /!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+["'][^)]*)?\)/g;
	for (const match of content.matchAll(markdownLinkPattern)) {
		addMarkdownTarget(match[1] ?? "");
	}

	// Reference-style definitions (`[ref]: Note.md`) are links the graph
	// extractor already counts and the resolver already rewrites, so leaving
	// them out here made the two subsystems disagree about the same vault.
	// A `^`-prefixed label is a footnote and a `~`-prefixed one a citation;
	// neither addresses a page, so both are skipped.
	const definitionPattern = /^\s{0,3}\[([^\]^~][^\]]*)\]:[ \t]*(<[^>]+>|[^\s]+)/gm;
	for (const match of content.matchAll(definitionPattern)) {
		addMarkdownTarget(match[2] ?? "");
	}

	return targets;
}
function extractInlineTags(lines: string[], isContent: boolean[]): string[] {
	const tags = new Set<string>();

	for (let index = 0; index < lines.length; index += 1) {
		if (!isContent[index]) continue;
		for (const match of (lines[index] ?? "").matchAll(INLINE_TAG_PATTERN)) {
			const tag = (match[1] ?? "").replace(/\/+$/, "");
			if (tag && !/^[\p{N}/-]+$/u.test(tag)) {
				tags.add(tag);
			}
		}
	}

	return [...tags];
}

function pushBlock(blocks: BlockEntry[], seen: Set<string>, id: string): void {
	const normalizedId = id.trim();
	if (!normalizedId || seen.has(normalizedId)) {
		return;
	}

	seen.add(normalizedId);
	blocks.push({ id: normalizedId });
}

function pushHeading(headings: HeadingEntry[], slugger: GithubSlugger, rawHeading: string): void {
	const trimmedHeading = rawHeading.trim();
	const explicitIdMatch = trimmedHeading.match(/\s*\{#([A-Za-z0-9_:.-]+)\}\s*$/);
	const explicitId = explicitIdMatch?.[1];
	const headingText = explicitIdMatch
		? trimmedHeading.slice(0, trimmedHeading.length - explicitIdMatch[0].length).trim()
		: trimmedHeading;
	const normalizedText = stripMarkdownFormatting(headingText);

	if (normalizedText.length === 0) {
		return;
	}

	headings.push({
		rawText: normalizedText,
		slug: slugger.slug(normalizedText),
		explicitId,
	});
}

function normalizeStringField(value: unknown): string | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	return undefined;
}

function normalizeBooleanField(value: unknown): boolean {
	if (typeof value === "boolean") {
		return value;
	}
	if (typeof value === "string") {
		const lowered = value.trim().toLowerCase();
		return lowered === "true" || lowered === "yes" || lowered === "1";
	}
	if (typeof value === "number") {
		return value !== 0;
	}
	return true;
}

function normalizeStringArray(value: unknown): string[] {
	if (!value) return [];
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (!trimmed) return [];
		return [trimmed];
	}
	if (Array.isArray(value)) {
		return value
			.filter((v): v is string => typeof v === "string")
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
	}
	return [];
}

function extractFrontmatterMetadata(
	markdown: string,
	relativePath: string,
): {
	title?: string;
	aliases: string[];
	tags: string[];
	cssclasses: string[];
	excerpt?: string;
	publish: boolean;
	frontmatter: Record<string, unknown>;
} {
	try {
		const { data } = parseFrontmatter(markdown);

		const title = normalizeStringField(data.title);
		const excerpt = normalizeStringField(data.excerpt);
		const aliases = normalizeStringArray(data.aliases ?? data.alias);
		const tags = normalizeStringArray(data.tags ?? data.tag);
		const cssclasses = normalizeStringArray(data.cssclasses ?? data.cssclass);
		const publish = normalizeBooleanField(data.publish);

		return {
			title,
			excerpt,
			aliases: [...new Set(aliases)],
			tags: [...new Set(tags)],
			cssclasses: [...new Set(cssclasses)],
			publish,
			frontmatter: data,
		};
	} catch (error) {
		// Unreadable frontmatter must not drop the page: publish it without
		// metadata, but name the file so the failure is not silent.
		console.warn(
			`[rspress-plugin-obsidian:markdown] Dropped frontmatter for "${relativePath}": ${error instanceof Error ? error.message : String(error)}`,
		);
		return {
			aliases: [],
			tags: [],
			cssclasses: [],
			publish: true,
			frontmatter: {},
		};
	}
}

function pushNamedPage(map: Map<string, ContentPage[]>, rawValue: string, page: ContentPage): void {
	// Title/alias/tag/basename keys all funnel through here; fold to NFC so a
	// decomposed macOS filename matches a composed frontmatter value.
	const key = normalizeUnicode(normalizeLookupValue(rawValue));
	if (!key) {
		return;
	}

	const existing = map.get(key) ?? [];
	existing.push(page);
	map.set(key, existing);
}

function pushNamedAsset(
	map: Map<string, ContentAsset[]>,
	rawValue: string,
	asset: ContentAsset,
): void {
	if (!rawValue) {
		return;
	}
	const existing = map.get(rawValue) ?? [];
	existing.push(asset);
	map.set(rawValue, existing);
}

export { normalizeFsPath } from "../shared/route-path.js";
