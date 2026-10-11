import fs from "node:fs";
import path from "node:path";
import { getContentLineFlags } from "../shared/content-flags.js";
import { PAGE_MARKDOWN_EXTENSIONS } from "../shared/extensions.js";
import { parseFrontmatter } from "../shared/frontmatter.js";
import { ATTACHMENT_EXTS, extensionOf } from "../shared/media-exts.js";
import {
	type DocsRouteLocales,
	deriveDocsRoutePath,
	deriveRoutePath,
	normalizeFsPath,
	normalizeRoutePath as normalizePathKey,
	normalizeRoutePrefix,
} from "../shared/route-path.js";
import { normalizeLookupValue, normalizeUnicode, stripMarkdownFormatting } from "../shared/slug.js";
import { collectBacklinks } from "./backlinks.js";
import { blankCommentRanges, COMMENT_DELIMITER, findCommentRanges } from "./comments.js";
import { extractDataviewMetadata } from "./dataview.js";
import { scanPageHeadings } from "./heading-text.js";
import { rememberMentionSources, stripMentionText } from "./mentions.js";
import { backOfNoteEnd } from "./obsidian-plugins/excalidraw/drawing-file.js";
import { extractPageLinksFrom } from "./page-links.js";
import type {
	BacklinkRef,
	BlockEntry,
	ContentAsset,
	ContentIndex,
	ContentPage,
	HeadingEntry,
} from "./types.js";
import { normalizeFilePathKey } from "./utils.js";

export type { ContentIndex } from "./types.js";

/** Longest stripped body retained per page for mention matching. */
const MAX_MENTION_TEXT = 20_000;
/** Characters of section text kept as a heading's hover preview. */
const MAX_PREVIEW_LENGTH = 200;

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
	/**
	 * Route prefix pages publish under (a vault's `vaultRoutePrefix`). Without
	 * one, the root is the Rspress docs root and routes follow Rspress's own
	 * rules, including `locales`.
	 */
	routePrefix?: string;
	/**
	 * The site's `lang`/`locales`/`multiVersion`, for a docs root: Rspress drops
	 * the default language and version segment from a route (`en/guide.md` is
	 * served at `/guide` when `lang: "en"`). Ignored when `routePrefix` is set.
	 */
	locales?: DocsRouteLocales;
	/**
	 * Keep a stripped copy of each page's body so `getMentions` can find pages
	 * that name another page without linking to it. Off by default: it is the only
	 * thing here that retains page text.
	 */
	unlinkedMentions?: boolean;
	/**
	 * Extract Dataview fields, tasks and list items. Default `true`; the plugin
	 * turns it off with `enableDataview`, which saves roughly a third of the
	 * indexing time.
	 */
	dataview?: boolean;
	/** Resolution options the backlinks are computed with (as for links). */
	enableCaseInsensitiveLookup?: boolean;
	enableFuzzyMatching?: boolean;
	/**
	 * Root-relative folders whose files are neither indexed nor published
	 * (Templater's templates folder), on top of the hidden folders that never
	 * are. `/`-separated, matched case-sensitively from the root.
	 */
	excludeFolders?: string[];
}

interface NormalizedIndexOptions {
	routePrefix: string;
	locales?: DocsRouteLocales;
	unlinkedMentions: boolean;
	dataview: boolean;
	enableCaseInsensitiveLookup: boolean;
	enableFuzzyMatching: boolean;
	excludeFolders: string[];
}

function normalizeIndexOptions(options: ContentIndexOptions): NormalizedIndexOptions {
	return {
		routePrefix: normalizeRoutePrefix(options.routePrefix),
		locales: options.locales,
		unlinkedMentions: options.unlinkedMentions ?? false,
		dataview: options.dataview ?? true,
		enableCaseInsensitiveLookup: options.enableCaseInsensitiveLookup ?? true,
		enableFuzzyMatching: options.enableFuzzyMatching ?? false,
		excludeFolders: [
			...new Set(
				(options.excludeFolders ?? [])
					.map((folder) => normalizeFsPath(folder).replace(/^\/+|\/+$/g, ""))
					.filter(Boolean),
			),
		].sort(),
	};
}

/**
 * The URL an attachment is served from, which is not always its path in the
 * tree it was found in.
 *
 * Rspress copies `public/` to the site root and nothing else, so an attachment
 * under `<root>/public/` is served at `/<path-after-public/>` — not at
 * `/public/<path>`, which no route serves. Getting this wrong is invisible until
 * a page embeds the file: the `src` looks reasonable and 404s in the browser.
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
	const normalized = normalizeIndexOptions(options);
	const files = await scanVaultFiles(absoluteRoot, normalized.excludeFolders);
	return buildContentIndexFromFiles(absoluteRoot, files, normalized);
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
	const normalized = normalizeIndexOptions(options);
	// Every option is part of the key: an index built without mention text,
	// Dataview metadata or the site's locales cannot answer a request that
	// needs them.
	const cacheKey = `${absoluteRoot}|${JSON.stringify(normalized)}`;
	const files = await scanVaultFiles(absoluteRoot, normalized.excludeFolders);
	const signature = files
		.map((file) => `${file.relativePath}:${file.mtimeMs}:${file.size}`)
		.join("|");

	const cached = contentIndexCache.get(cacheKey);
	if (cached?.signature === signature) {
		contentIndexCache.delete(cacheKey);
		contentIndexCache.set(cacheKey, cached);
		return cached.index;
	}

	// Entries carry over only for files still in the root: reusing the previous
	// map would keep every deleted or renamed note's page (and mention text)
	// alive for the rest of a dev session, and hand a stale parse to a note
	// recreated later with the same mtime and size.
	const parsedFiles = new Map<string, ParsedFileEntry>();
	const index = await buildContentIndexFromFiles(
		absoluteRoot,
		files,
		normalized,
		cached?.files,
		parsedFiles,
	);
	contentIndexCache.set(cacheKey, { signature, index, files: parsedFiles });

	// Evict least-recently-used entry (first in insertion order) when over cap.
	if (contentIndexCache.size > MAX_CACHED_INDEXES) {
		const oldest = contentIndexCache.keys().next().value;
		if (oldest !== undefined) {
			contentIndexCache.delete(oldest);
		}
	}

	return index;
}

/**
 * `priorFiles` holds the previous build's parse of each file, reused while its
 * mtime and size are unchanged; `parsedFiles` receives this build's, and is what
 * the next build reuses.
 */
async function buildContentIndexFromFiles(
	rootDir: string,
	files: MarkdownFileEntry[],
	options: NormalizedIndexOptions,
	priorFiles?: ReadonlyMap<string, ParsedFileEntry>,
	parsedFiles?: Map<string, ParsedFileEntry>,
): Promise<ContentIndex> {
	const markdownFiles = files.filter((file) =>
		PAGE_MARKDOWN_EXTENSIONS.has(path.extname(file.relativePath).toLowerCase()),
	);
	const settled = await Promise.allSettled(
		markdownFiles.map((file) => buildContentPage(file, options, priorFiles, parsedFiles)),
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
			urlPath: assetUrlPath(file.relativePath, options.routePrefix),
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

		const tagKeys = new Set<string>();
		for (const tag of page.tags) {
			// For nested tags like "parent/child/leaf", also aggregate into
			// each ancestor segment so byTag["parent"] includes the page too.
			const parts = tag.split("/");
			for (let depth = 1; depth <= parts.length; depth++) {
				tagKeys.add(parts.slice(0, depth).join("/"));
			}
		}
		for (const tag of tagKeys) pushNamedPage(byTag, tag, page);
	}
	for (const asset of assets) {
		byAssetPath.set(asset.pathKey, asset);
		pushNamedAsset(byAssetPathCI, asset.pathKey.toLowerCase(), asset);
		const existing = byAssetBaseName.get(asset.baseName) ?? [];
		existing.push(asset);
		byAssetBaseName.set(asset.baseName, existing);
		pushNamedAsset(byAssetBaseNameCI, asset.baseName.toLowerCase(), asset);
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
		backlinks: new Map<string, BacklinkRef[]>(),
	};
	// Backlinks are the outlinks resolved with the resolver every link uses, so
	// a link and its backlink cannot disagree about where a target lives.
	collectBacklinks(index, index, options, index.backlinks);

	if (options.unlinkedMentions) {
		rememberMentionSources(
			index,
			pages.map((page) => ({
				page,
				text: parsedFiles?.get(page.absolutePath)?.mentionText ?? "",
			})),
		);
	}

	return index;
}

/**
 * Every file of a root that can be published: hidden files and directories
 * (`.env`, `.obsidian/`, `.trash/`), `node_modules`, `_`-prefixed paths and the
 * `excludeFolders` are skipped, as are symlinks (neither a file nor a directory
 * to `readdir`).
 */
async function scanVaultFiles(
	rootDir: string,
	excludeFolders: readonly string[] = [],
): Promise<MarkdownFileEntry[]> {
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
			if (entry.name.startsWith(".")) continue;
			const absolutePath = path.join(currentDir, entry.name);

			if (entry.isDirectory()) {
				const relativeDir = normalizeFsPath(path.relative(rootDir, absolutePath));
				if (entry.name !== "node_modules" && !excludeFolders.includes(relativeDir)) {
					subdirs.push(absolutePath);
				}
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
	options: NormalizedIndexOptions,
	priorFiles?: ReadonlyMap<string, ParsedFileEntry>,
	parsedFiles?: Map<string, ParsedFileEntry>,
): Promise<ContentPage> {
	const cached = priorFiles?.get(file.absolutePath);
	if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
		parsedFiles?.set(file.absolutePath, cached);
		return cached.page;
	}
	const markdown = await fs.promises.readFile(file.absolutePath, "utf-8");
	const routePath = options.routePrefix
		? deriveRoutePath(file.relativePath, options.routePrefix)
		: deriveDocsRoutePath(file.relativePath, options.locales);
	const pathKey = normalizeUnicode(normalizePathKey(file.relativePath));
	const filePathKey = normalizeFilePathKey(file.relativePath);
	const baseName = path.basename(filePathKey);
	const metadata = extractFrontmatterMetadata(markdown, file.relativePath);
	const { title, aliases, cssclasses, excerpt, publish } = metadata;
	const dataview = options.dataview
		? extractDataviewMetadata(markdown, metadata.frontmatter, file.relativePath)
		: { fields: {}, tasks: [], lists: [] };

	// Comments are blanked (not removed) once, up front: a heading, block id,
	// link, tag or preview inside `%%…%%` is not on the published page.
	const visible = markdown.includes(COMMENT_DELIMITER)
		? blankCommentRanges(markdown, findCommentRanges(markdown))
		: markdown;
	const lines = visible.split(/\r?\n/);
	const isContent = getContentLineFlags(lines);
	const links = extractPageLinksFrom(lines, isContent, metadata.frontmatter);
	// An Excalidraw note's `# Excalidraw Data` / `## Text Elements` headings are
	// the plugin's storage, not the note's outline: they would title the note
	// "Excalidraw Data" in backlinks and the graph. Links and `^element` ids in
	// that data stay indexed — the plugin links drawings through them.
	const headingLines = metadata.frontmatter["excalidraw-plugin"]
		? markdown.slice(0, backOfNoteEnd(markdown)).split(/\r?\n/).length - 1
		: lines.length;
	const headings = extractHeadings(lines.slice(0, headingLines), isContent.slice(0, headingLines));

	const headingBySlug = new Map<string, HeadingEntry>();
	const headingByText = new Map<string, HeadingEntry>();
	for (const h of headings) {
		if (!headingBySlug.has(h.slug)) headingBySlug.set(h.slug, h);
		if (h.explicitId) {
			headingBySlug.set(h.explicitId, h);
			headingBySlug.set(normalizeLookupValue(h.explicitId), h);
		}
		const normalizedText = normalizeLookupValue(h.rawText);
		if (!headingByText.has(normalizedText)) {
			headingByText.set(normalizedText, h);
		}
	}
	const page: ContentPage = {
		absolutePath: file.absolutePath,
		title,
		relativePath: file.relativePath,
		routePath,
		pathKey,
		filePathKey,
		baseName,
		tags: links.tags,
		aliases,
		cssclasses,
		excerpt,
		publish,
		fileCtimeMs: file.ctimeMs,
		fileMtimeMs: file.mtimeMs,
		fileSizeBytes: file.size,
		headings,
		wikilinkTargets: wikilinkTargetsOf(links.outlinks),
		outlinks: links.outlinks,
		headingBySlug,
		headingByText,
		blocks: extractBlocks(lines, isContent),
		dataviewFields: dataview.fields,
		dataviewTasks: dataview.tasks,
		dataviewLists: dataview.lists,
	};

	const entry: ParsedFileEntry = {
		mtimeMs: file.mtimeMs,
		size: file.size,
		page,
	};
	if (options.unlinkedMentions) {
		// ponytail: 20k chars of stripped body per page while the feature is on —
		// enough for a mention at the end of a long note; the ceiling is here so a
		// vault of 10k notes cannot pin hundreds of MB.
		entry.mentionText = stripMentionText(markdown).slice(0, MAX_MENTION_TEXT);
	}
	parsedFiles?.set(file.absolutePath, entry);

	return page;
}

export { getContentLineFlags } from "../shared/content-flags.js";
export { deriveRoutePath, normalizeRoutePath as normalizePathKey } from "../shared/route-path.js";

/**
 * The page-link targets Dataview's `file.outlinks` and the legacy backlinks
 * builder read: lowercased paths of the page links, attachments left out
 * (`[[image.png]]` names a file, not a page), each once.
 */
function wikilinkTargetsOf(outlinks: ContentPage["outlinks"]): string[] {
	const targets = new Set<string>();
	for (const link of outlinks ?? []) {
		if (ATTACHMENT_EXTS.has(extensionOf(link.target))) continue;
		targets.add(normalizeUnicode(link.target.replace(/\\/g, "/")).toLowerCase());
	}
	return [...targets];
}

/**
 * The page's headings with the ids the published page gives them, and a short
 * plain-text preview of each section for hover tooltips. `lines` already has
 * its comments blanked, so neither a commented heading nor commented text in a
 * section reaches the index.
 */
function extractHeadings(lines: string[], isContent: boolean[]): HeadingEntry[] {
	const scanned = scanPageHeadings(lines, isContent);
	return scanned.map((heading, position) => {
		const end = scanned[position + 1]?.line ?? lines.length;
		const previewLines: string[] = [];
		let charCount = 0;
		for (let i = heading.line + 1; i < end && charCount < MAX_PREVIEW_LENGTH; i++) {
			if (!isContent[i]) continue;
			const text = stripMarkdownFormatting(lines[i] ?? "").trim();
			if (!text || /^(=+|-+)$/.test(text)) continue;
			const remaining = MAX_PREVIEW_LENGTH - charCount;
			previewLines.push(text.length <= remaining ? text : text.slice(0, remaining));
			charCount += text.length;
		}
		const entry: HeadingEntry = {
			rawText: heading.text,
			slug: heading.id,
			depth: heading.depth,
			sourceText: heading.source,
		};
		if (heading.explicitId) entry.explicitId = heading.explicitId;
		if (previewLines.length > 0) entry.preview = previewLines.join(" ");
		return entry;
	});
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

function pushBlock(blocks: BlockEntry[], seen: Set<string>, id: string): void {
	const normalizedId = id.trim();
	if (!normalizedId || seen.has(normalizedId)) {
		return;
	}

	seen.add(normalizedId);
	blocks.push({ id: normalizedId });
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

/**
 * A list-valued property: a YAML list, or the legacy single string Obsidian
 * still reads as a comma-separated list (`aliases: First, Second`).
 */
function normalizeStringArray(value: unknown): string[] {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	return raw
		.filter((v): v is string => typeof v === "string")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

function extractFrontmatterMetadata(
	markdown: string,
	relativePath: string,
): {
	title?: string;
	aliases: string[];
	cssclasses: string[];
	excerpt?: string;
	publish: boolean;
	frontmatter: Record<string, unknown>;
} {
	try {
		const { data } = parseFrontmatter(markdown);

		return {
			title: normalizeStringField(data.title),
			excerpt: normalizeStringField(data.excerpt),
			aliases: [...new Set(normalizeStringArray(data.aliases ?? data.alias))],
			// Class names cannot contain spaces, so a legacy string splits on both.
			cssclasses: [
				...new Set(
					normalizeStringArray(data.cssclasses ?? data.cssclass).flatMap((entry) =>
						entry.split(/\s+/),
					),
				),
			],
			publish: normalizeBooleanField(data.publish),
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
