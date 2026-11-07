import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { RspressPlugin } from "@rspress/core";
import { deferInvalidationPlugin } from "../dev-invalidation.js";
import { KATEX_STYLESHEET_PATH, katexStylesheetPlugin } from "../katex-stylesheet.js";
import { mermaidBuilderConfig } from "../mermaid/install.js";
import { moduleDir, resolveRuntimeFile } from "../runtime-paths.js";
import { findCanvasBoards } from "../shared/canvas-routes.js";
import { getContentLineFlags } from "../shared/content-flags.js";
import { createFileRoutes } from "../shared/file-routes.js";
import { isPublishedProperty, parseFrontmatter } from "../shared/frontmatter.js";
import type { ContentIndexOptions } from "../shared/index-options.js";
import {
	attachPublishedContent,
	type PublishedContentConfig,
} from "../shared/published-content.js";
import type { DocsRouteLocales } from "../shared/route-path.js";
import {
	blankCommentRanges,
	filterCommentedToc,
	findCommentRanges,
	hasComments,
} from "./comments.js";
import { type ContentIndex, getCachedContentIndex } from "./content-index.js";
import { generateDailyNoteCalendar } from "./daily-notes.js";
import { scanPageHeadings } from "./heading-text.js";
import { linkContentIndexes } from "./linked-indexes.js";
import { isPluginOwnedImageUrl } from "./media.js";
import { normalizePluginOptions } from "./normalize-options.js";
import {
	enabledPluginFeatures,
	mergeBuilderConfigs,
	type PluginBuildContext,
} from "./obsidian-plugins/index.js";
import { publicDirectoryPlugin } from "./public-dir.js";
import { rehypeRawForMdx } from "./rehype-raw-mdx.js";
import { remarkWikilink } from "./remark-wikilink.js";
import { isPluginOwnedMarkdownDestination } from "./render/markdown-links.js";
import { clearTransclusionCache } from "./render/transclusion.js";
import { generateTagPages } from "./tag-pages.js";
import type {
	RemarkPluginFactory,
	RemarkWikiLinkPluginOptions,
	RspressPluginMarkdownOptions,
} from "./types.js";
import { isPathInsideRoot, pathUnderRoot } from "./utils.js";
import { syncAssets, vaultFileForSiteUrl } from "./vault-assets.js";

export type { MathEngine } from "../math.js";
export type { MermaidSecurityLevel } from "../mermaid/classes.js";
export type { ContentIndexOptions } from "../shared/index-options.js";
export { formatMomentDate as formatDailyNoteDate } from "../shared/moment-format.js";
export type { BacklinkRef } from "./backlinks.js";
export {
	buildBacklinksIndex,
	getCachedBacklinksIndex,
	renderBacklinksHtml,
} from "./backlinks.js";
export {
	buildContentIndex,
	getCachedContentIndex,
} from "./content-index.js";
export {
	expandDailyTemplateText,
	normalizeDailyNoteConfig,
	parseDailyNoteDate,
	renderDailyNavigation,
} from "./daily-notes.js";
export {
	type DataviewSettings,
	extractDataviewMetadata,
	renderDataviewInline,
	renderDataviewQuery,
} from "./dataview.js";
export {
	buildMentionsIndex,
	getMentions,
	type MentionRef,
	type MentionSource,
	stripMentionText,
} from "./mentions.js";
export type { BasesMapTiles, BasesOptions } from "./obsidian-plugins/bases/options.js";
export type { ExcalidrawOptions } from "./obsidian-plugins/excalidraw/options.js";
export type {
	KanbanDateColor,
	KanbanInlineMetadataPosition,
	KanbanMetadataKey,
	KanbanOptions,
	KanbanTagColor,
} from "./obsidian-plugins/kanban/options.js";
export type {
	TasksOptions,
	TasksStatusOption,
	TasksStatusType,
} from "./obsidian-plugins/tasks/options.js";
export type {
	TemplaterFileTemplate,
	TemplaterFolderTemplate,
	TemplaterOptions,
} from "./obsidian-plugins/templater/options.js";
export { extractPageLinks, type PageLinks } from "./page-links.js";
export { findWikilinkMatches, parseWikiLink } from "./parse-wikilink.js";
export { remarkWikilink } from "./remark-wikilink.js";
export { resolveWikiLink } from "./resolve-wikilink.js";
export {
	type AdditionalPage,
	encodeTagPathSegment,
	generateTagPages,
} from "./tag-pages.js";
export type {
	BlockEntry,
	ContentAsset,
	ContentIndex,
	ContentPage,
	DailyNotesOptions,
	DataviewListItem,
	DataviewTask,
	DiagnosticMode,
	HeadingEntry,
	NormalizedPluginOptions,
	ParsedWikiLink,
	RemarkPluginFactory,
	RemarkWikiLinkPluginOptions,
	ResolveContext,
	ResolvedWikiLink,
	ResolveStatus,
	RspressPluginMarkdownOptions,
	WikilinkMatch,
	WikiSubpath,
} from "./types.js";

/**
 * Whether a page's own frontmatter marks it as not-for-publication.
 *
 * Obsidian reads `publish: false` as "keep this in the vault, don't put it on
 * the site". The vault side of that is handled by the content index; this covers
 * the docs tree, where Rspress would otherwise route the file like any other.
 */
async function isUnpublishedFile(absolutePath: string): Promise<boolean> {
	if (!/\.mdx?$/i.test(absolutePath)) return false;
	try {
		const markdown = await fs.readFile(absolutePath, "utf8");
		const { data } = parseFrontmatter(markdown);
		return !isPublishedProperty(data.publish);
	} catch {
		// Unreadable or malformed frontmatter: the page keeps its route, and the
		// frontmatter pass reports the problem where it always has.
		return false;
	}
}

// Resolved at module load time. Candidates cover the published bundle
// (`dist/markdown.css`) and the source layout (`src/markdown/styles.css`).
const STYLES_PATH = resolveRuntimeFile(
	path.join(moduleDir, "markdown.css"),
	path.join(moduleDir, "markdown", "styles.css"),
);
// Inline picker for an ambiguous vault search (`[[##query]]`).
const WIKI_PICKER_COMPONENT_PATH = resolveRuntimeFile(
	path.join(moduleDir, "markdown", "runtime", "WikiPicker.js"),
	path.join(moduleDir, "markdown", "runtime", "WikiPicker.tsx"),
);
// Client component that draws ```mermaid placeholders (Mermaid needs the DOM).
const MERMAID_COMPONENT_PATH = resolveRuntimeFile(
	path.join(moduleDir, "markdown", "runtime", "MermaidBlocks.js"),
	path.join(moduleDir, "markdown", "runtime", "MermaidBlocks.tsx"),
);
// Links KaTeX's stylesheet from the head of the pages that show KaTeX math.
const KATEX_STYLESHEET_COMPONENT_PATH = resolveRuntimeFile(
	path.join(moduleDir, "markdown", "runtime", "KatexStylesheet.js"),
	path.join(moduleDir, "markdown", "runtime", "KatexStylesheet.tsx"),
);

/** Page descriptor yielded by the plugin's addPages hook. */
type VaultPage = { routePath: string; filepath?: string; content?: string };

/** The site config fields a docs route depends on (see `deriveDocsRoutePath`). */
interface LocaleConfig {
	lang?: string;
	locales?: Array<{ lang: string }>;
	themeConfig?: { locales?: Array<{ lang: string }> };
	multiVersion?: { default?: string; versions?: string[] };
}

function localesOf(config: LocaleConfig): DocsRouteLocales {
	return {
		lang: config.lang || undefined,
		langs: (config.locales ?? config.themeConfig?.locales ?? []).map((locale) => locale.lang),
		version: config.multiVersion?.default || undefined,
		versions: config.multiVersion?.versions ?? [],
	};
}

/** Headings whose rendered text differs from what Rspress's outline shows. */
const OBSIDIAN_HEADING_SYNTAX = /\[\[|%%|==|\$/;

/**
 * Rewrite a page's outline (and H1-derived title) to match the rendered page.
 *
 * Rspress builds the outline from its own parse of the source before any
 * plugin runs, so `## Using [[api|the API]]` was listed as raw syntax with an
 * id no element carries. The ids are recomputed with the same per-page
 * allocation the rendered headings use; the text is replaced only where
 * Obsidian syntax made it differ, so ordinary inline markdown in the outline
 * is left as Rspress renders it. Entries are paired by position with the
 * top-level `h2`–`h4` headings Rspress lists; when the two disagree on how many
 * there are, the outline is left alone rather than mislabelled.
 */
function rewriteOutline(page: {
	toc: Array<{ id: string; text: string; depth: number }>;
	title?: string;
	frontmatter?: Record<string, unknown>;
	_flattenContent?: string;
}): void {
	const raw = page._flattenContent ?? "";
	if (!raw) return;
	const source = hasComments(raw) ? blankCommentRanges(raw, findCommentRanges(raw)) : raw;
	const lines = source.split(/\r?\n/);
	const headings = scanPageHeadings(lines, getContentLineFlags(lines));
	const outline = headings.filter((h) => h.topLevel && h.depth >= 2 && h.depth <= 4);
	if (outline.length === page.toc.length) {
		page.toc.forEach((entry, position) => {
			const heading = outline[position];
			if (!heading) return;
			entry.id = heading.id;
			if (OBSIDIAN_HEADING_SYNTAX.test(heading.source)) entry.text = heading.text;
		});
	}
	const h1 = headings.find((h) => h.topLevel && h.depth === 1);
	if (
		h1 &&
		typeof page.frontmatter?.title !== "string" &&
		OBSIDIAN_HEADING_SYNTAX.test(h1.source)
	) {
		page.title = h1.text;
	}
}

/**
 * Publish an Obsidian vault as Rspress pages: the Markdown feature of
 * rspress-plugin-obsidian.
 *
 * **Always on** (no option): wikilinks `[[Page]]`, embeds `![[Page]]`, heading
 * and block anchors, `==highlights==`, `%%comments%%`, footnotes `[^1]` and
 * inline `^[…]`, and frontmatter reading.
 *
 * **On by default**: `enableMarkdownLinks` (`[text](Note.md)`) and
 * `enableCaseInsensitiveLookup`.
 *
 * **Off by default** — the Obsidian features a docs site may not want:
 * `enableCallouts` (`> [!note]`), `enableTransclusion` (inline a note),
 * `enableMediaEmbeds` (image/audio/video/PDF embeds), `enableBacklinks` (the
 * linked-mentions panel), `enableUnlinkedMentions` (its unlinked counterpart),
 * `enableTagLinking` + `enableTagPages` (`#tag` → `/tags/<tag>`),
 * `enableDailyNotes`, `enableDataview` (DQL blocks and inline `= expr`),
 * `enableMath` (`$…$`, via KaTeX or MathJax), `enableMermaid`, and
 * `enableDefaultStyles`.
 *
 * `onBrokenLink` defaults to `"error"`, so an unresolvable `[[wikilink]]`
 * fails the build until you have dealt with it; `onAmbiguousLink` defaults to
 * `"warn"`, because an ambiguous one still resolves the way Obsidian picks.
 *
 * @example
 * ```ts
 * // rspress.config.ts
 * import path from "node:path";
 * import { defineConfig } from "@rspress/core";
 * import { markdown } from "rspress-plugin-obsidian";
 *
 * export default defineConfig({
 *   root: path.join(import.meta.dirname, "docs"),
 *   plugins: [
 *     markdown({
 *       enableCallouts: true,
 *       enableBacklinks: true,
 *       // Callouts, backlinks and tag pages emit markup but no rules unless
 *       // the stylesheet is loaded — turn this on, or import
 *       // `rspress-plugin-obsidian/markdown/styles.css` yourself.
 *       enableDefaultStyles: true,
 *     }),
 *   ],
 * });
 * ```
 *
 * @param options - Feature toggles and diagnostic behaviour. All fields are
 *   optional; see {@link RspressPluginMarkdownOptions} for details.
 * @returns An {@link RspressPlugin} ready to append to `plugins:`.
 */
export function markdown(options: RspressPluginMarkdownOptions = {}): RspressPlugin {
	const normalizedOptions = normalizePluginOptions(options);
	let docsRoot = path.resolve(process.cwd(), "docs");
	let siteBase = "/";

	let locales: DocsRouteLocales = {};
	// The site's plugins, learned from the config hooks: the canvas plugin
	// listed beside this one publishes the boards links resolve to. Its reader
	// settles once the canvas scan Rspress runs beside our `addPages` is done.
	let sitePlugins: readonly unknown[] | undefined;
	const canvasBoards = () => findCanvasBoards({ plugins: sitePlugins });
	// Files features publish as pages (`.base` views, drawings) and where each
	// is shown; one registry per build, so two sites in one process never share.
	const fileRoutes = createFileRoutes();
	const { vaultRoot, vaultRoutePrefix } = normalizedOptions;
	// The reproduced Obsidian plugins this site turned on (Tasks, Kanban, …).
	const features = enabledPluginFeatures(normalizedOptions);
	// Folders a feature keeps out of the site (Templater's templates), relative
	// to the vault — or to the docs root when there is no vault.
	const excludeFolders = features.flatMap(
		(feature) => feature.excludedFolders?.(normalizedOptions) ?? [],
	);
	const resolveOptions = {
		enableCaseInsensitiveLookup: normalizedOptions.enableCaseInsensitiveLookup,
		enableFuzzyMatching: normalizedOptions.enableFuzzyMatching,
	};
	// The same options for every reader of an index (remark pass, tag pages,
	// asset publishing, and the graph and canvas features through
	// `published-content`), so they all share one `getCachedContentIndex` entry
	// and the vault is parsed once a build.
	const sharedIndexOptions = {
		unlinkedMentions: normalizedOptions.enableUnlinkedMentions,
		dataview: normalizedOptions.enableDataview,
		...resolveOptions,
	};
	const docsIndexOptions = (): ContentIndexOptions => ({
		...sharedIndexOptions,
		locales,
		...(!vaultRoot && excludeFolders.length > 0 && { excludeFolders }),
	});
	const vaultIndexOptions: ContentIndexOptions = {
		...sharedIndexOptions,
		routePrefix: vaultRoutePrefix,
		...(excludeFolders.length > 0 && { excludeFolders }),
	};
	// What the graph and canvas features of this site read back (they find this
	// plugin among the site's `plugins`); evaluated when they ask, so it carries
	// the `config.root` and locales the hooks below learned.
	const publishedContent = (): PublishedContentConfig => ({
		docsRoot,
		vault: vaultRoot
			? { root: vaultRoot, routePrefix: vaultRoutePrefix, indexOptions: vaultIndexOptions }
			: undefined,
		docsIndexOptions: docsIndexOptions(),
	});

	// Attachments are staged outside the docs tree and served as an extra
	// Rsbuild public directory (dev server and build output alike), so nothing
	// is ever written into the site's own `public/`.
	const assetStagingDir = path.join(
		process.cwd(),
		"node_modules",
		".rspress-plugin-obsidian",
		`assets-${createHash("sha256")
			.update(`${vaultRoot ?? ""}|${vaultRoutePrefix}`)
			.digest("hex")
			.slice(0, 12)}`,
	);

	const isVaultFile = (filePath: string): boolean =>
		Boolean(vaultRoot && pathUnderRoot(filePath, vaultRoot));
	// A vault note with no `# heading` is titled by its file name on the page
	// (the remark pass's `applyPageTitle`); search results and page data match.
	const titleUntitledVaultPage = (page: { title: string; _filepath: string }): void => {
		if (page.title || !isVaultFile(page._filepath)) return;
		page.title = path.basename(page._filepath).replace(/\.mdx?$/i, "");
	};

	// One index per root per build generation. Without this the remark pass
	// re-indexed the whole docs tree for every file it processed (N files × N
	// parses). `afterBuild` runs after every production build and every dev
	// recompile, so the memo is dropped once per generation: the first file of
	// the next generation re-indexes through `getCachedContentIndex` — whose
	// mtime/size signature picks up edited headings, anchors, aliases and new
	// notes — and the remaining files reuse that index.
	let indexes:
		| {
				both: Promise<{ docs: ContentIndex; vault?: ContentIndex }>;
				docs: Promise<ContentIndex>;
				vault: Promise<ContentIndex>;
		  }
		| undefined;

	// These memos last for exactly one build generation: the content index and
	// the rendered transclusions must be rebuilt once a dev recompile or a new
	// production build starts, or edits to embedded pages would not show up.
	const resetGeneration = (): void => {
		indexes = undefined;
		clearTransclusionCache();
	};

	// Both trees, linked to each other: a docs page can link (and backlink) a
	// vault note and the other way round when its own tree has no match. The
	// links live on views of the cached indexes, which other readers share.
	const loadIndexes = async () => {
		const [docs, vault] = await Promise.all([
			getCachedContentIndex(docsRoot, docsIndexOptions()),
			vaultRoot ? getCachedContentIndex(vaultRoot, vaultIndexOptions) : undefined,
		]);
		return linkContentIndexes(docs, vault);
	};
	const getIndexes = () => {
		if (!indexes) {
			const both = loadIndexes();
			indexes = {
				both,
				docs: both.then((loaded) => loaded.docs),
				vault: both.then((loaded) => loaded.vault ?? loaded.docs),
			};
		}
		return indexes;
	};

	const getIndexForFile = (filePath: string): Promise<ContentIndex> =>
		vaultRoot && isVaultFile(filePath) ? getIndexes().vault : getIndexes().docs;

	const publishAssets = (indexes: { docs: ContentIndex; vault?: ContentIndex }) =>
		syncAssets({
			stagingDir: assetStagingDir,
			vaultRoot,
			vaultRoutePrefix,
			...indexes,
			resolveOptions,
			canvasBoards,
			fileRoutes,
		});

	let warnedLegacyCopies = false;
	const warnLegacyCopies = async (): Promise<void> => {
		if (warnedLegacyCopies) return;
		const legacy = path.join(docsRoot, "public", vaultRoutePrefix.replace(/^\/+|\/+$/g, ""));
		if (!(await fs.stat(legacy).catch(() => undefined))?.isDirectory()) return;
		warnedLegacyCopies = true;
		console.warn(
			`[rspress-plugin-obsidian:markdown] ${legacy} exists. Earlier versions copied every vault file there; vault attachments are now published from node_modules/.rspress-plugin-obsidian/ and only when a published page references them. Delete that directory so stale or private files stop being served.`,
		);
	};

	// KaTeX's stylesheet is linked per page, by the pages that show KaTeX math
	// (see `../katex-stylesheet.ts`). MathJax needs none: the pass emits its
	// generated stylesheet inline with each page that has math.
	const katexMath = normalizedOptions.enableMath && normalizedOptions.mathEngine === "katex";
	const remarkPluginTuple: [
		RemarkPluginFactory<RemarkWikiLinkPluginOptions>,
		RemarkWikiLinkPluginOptions,
	] = [
		remarkWikilink,
		{
			getDocsRoot: (filePath) =>
				vaultRoot && filePath && isVaultFile(filePath) ? vaultRoot : docsRoot,
			getContentIndex: getIndexForFile,
			getPublishedIndexes: async () => {
				const { docs, vault } = await getIndexes().both;
				return vault ? [docs, vault] : [docs];
			},
			getSiteBase: () => siteBase,
			...(katexMath && {
				getKatexStylesheetHref: () => `${siteBase}${KATEX_STYLESHEET_PATH}`,
			}),
			getCanvasBoards: canvasBoards,
			getFileRoutes: () => fileRoutes,
			options: normalizedOptions,
		},
	];

	const plugin: RspressPlugin = {
		name: "rspress-plugin-obsidian:markdown",

		...(normalizedOptions.enableDefaultStyles && { globalStyles: STYLES_PATH }),

		...(() => {
			const components = [
				...(normalizedOptions.enableMermaid ? [MERMAID_COMPONENT_PATH] : []),
				...features.flatMap((feature) => feature.globalUIComponents?.() ?? []),
			];
			return components.length > 0
				? {
						globalUIComponents: components.map(
							(component) => [component, {}] as [string, Record<string, never>],
						),
					}
				: {};
		})(),

		builderConfig: mergeBuilderConfigs(
			// `mermaid` is an optional peer: without it, alias the client import
			// away so the site still bundles.
			mermaidBuilderConfig({ diagramsRequested: normalizedOptions.enableMermaid }),
			{
				plugins: [
					deferInvalidationPlugin,
					publicDirectoryPlugin("rspress-plugin-obsidian:assets", assetStagingDir),
					...(katexMath ? [katexStylesheetPlugin()] : []),
				],
			},
			...features.map((feature) => feature.builderConfig?.(normalizedOptions) ?? {}),
		),

		// Comments are stripped from the rendered body by the remark pass, but
		// Rspress extracts the page outline and search content from its own parse
		// of the source, before plugin remark plugins run. `modifySearchIndexData`
		// runs before the search index is serialized, so private text can be
		// dropped there; the same page data feeds the outline, which
		// `extendPageData` cleans below.
		async modifySearchIndexData(pages, isProd) {
			for (const page of pages) {
				const content = page.content ?? "";
				if (!hasComments(content)) continue;
				const ranges = findCommentRanges(content);
				if (ranges.length === 0) continue;

				// Blanked, not removed: Rspress's search UI maps `toc[].charIndex`
				// into this string, so the offsets must survive the edit.
				page.content = blankCommentRanges(content, ranges);
				page.toc = filterCommentedToc(page.toc, content);
			}
			for (const page of pages) {
				rewriteOutline(page);
				titleUntitledVaultPage(page);
			}
			for (const feature of features) await feature.modifySearchIndexData?.(pages, isProd);
		},

		// The page outline the theme renders ("on this page") is the same `toc`
		// array the search index was built from, and this hook runs before the
		// page data is assembled — so a heading a comment hides is dropped here
		// too. With the search index disabled Rspress records no toc offsets and
		// leaves `content` empty, so the flattened source stands in.
		async extendPageData(pageData, isProd) {
			const source = pageData.content || pageData._flattenContent || "";
			if (hasComments(source)) {
				pageData.toc = filterCommentedToc(pageData.toc, source);
			}
			rewriteOutline(pageData);
			titleUntitledVaultPage(pageData);
			for (const feature of features) await feature.extendPageData?.(pageData, isProd);

			// Obsidian's `excerpt` frontmatter becomes the page description the
			// theme renders as `<meta name="description">` / `og:description`.
			// An explicit Rspress `description` still wins; without one, the
			// excerpt overrides the auto-extracted first paragraph.
			if (typeof pageData.frontmatter.description === "string") {
				if (pageData.frontmatter.description.trim() !== "") return;
			}
			const excerpt = pageData.frontmatter.excerpt;
			if (typeof excerpt !== "string") return;
			const normalized = excerpt.replace(/\s+/g, " ").trim();
			if (normalized) {
				pageData.description = normalized;
			}
		},

		config(siteConfig) {
			// The graph and canvas find this plugin in `config.plugins`, the only
			// plugin list a hook sees. A plugin added with `utils.addPlugin` from
			// another plugin's `config` hook runs without being listed there, so it
			// lists itself — on a copy, leaving the caller's config untouched.
			const listed = siteConfig.plugins ?? [];
			const config = listed.includes(plugin)
				? siteConfig
				: { ...siteConfig, plugins: [...listed, plugin] };
			docsRoot = path.resolve(process.cwd(), config.root ?? "docs");
			sitePlugins = config.plugins;
			siteBase = `/${(config.base ?? "/").replace(/^\/+|\/+$/g, "")}/`.replace(/\/{2,}/g, "/");
			// Docs routes follow Rspress's rules, which drop the default
			// language and version segment (`en/guide.md` → `/guide`).
			locales = localesOf(config as LocaleConfig);
			resetGeneration();
			// An Obsidian vault is full of plugin fences — ```query, ```tasks,
			// ```ad-note, ```chart — in languages Shiki has never heard of, and
			// Rspress's highlighter fails the build on the first one. Obsidian
			// shows such a fence as plain code, so fall back to plain text unless
			// the site chose its own fallback.
			config.markdown = {
				...config.markdown,
				shiki: { fallbackLanguage: "txt", ...config.markdown?.shiki },
			};
			// Vault-style markdown links (`[x](Page.md)` resolved by basename,
			// not relative path) fail Rspress's own dead-link gate before this
			// plugin's remark pass can resolve them. This plugin owns exactly
			// the `.md`/`.mdx` destinations — `parseMarkdownLinkUrl` claims
			// those and reports unresolvable ones through `onBrokenLink` — so
			// exempt only those from the gate and leave every other link
			// checked. An explicit user setting wins.
			if (
				normalizedOptions.enableMarkdownLinks &&
				config.markdown?.link?.checkDeadLinks === undefined
			) {
				config.markdown = {
					...config.markdown,
					link: {
						...config.markdown?.link,
						checkDeadLinks: { excludes: isPluginOwnedMarkdownDestination },
					},
				};
			}
			// Rspress's dead-image gate checks `![](photo.png)` relative to the
			// page and `/x.png` against `public/` only. A relative Obsidian
			// attachment stored elsewhere in the vault, and a vault attachment
			// linked at its published URL (served from the staging directory),
			// would both fail the build before the remark pass resolves them. The
			// pass resolves every relative image url and reports the unresolvable
			// ones through `onBrokenLink`; a published vault URL is exempt only
			// when the file exists. An explicit user setting wins.
			if (config.markdown?.image?.checkDeadImages === undefined) {
				config.markdown = {
					...config.markdown,
					image: {
						...config.markdown?.image,
						checkDeadImages: {
							excludes: (url: string) => {
								if (isPluginOwnedImageUrl(url)) return true;
								const file = vaultFileForSiteUrl(url, vaultRoot, vaultRoutePrefix);
								return file !== undefined && existsSync(file);
							},
						},
					},
				};
			}

			return config;
		},

		// Rspress invokes `config` and `addPages` once per process, so without
		// this the per-file memo would hand the startup index to every dev-server
		// recompile. `afterBuild` runs after each production build and after each
		// dev compile, so the next generation re-indexes and picks up edits.
		async afterBuild(_config, isProd) {
			resetGeneration();
			// A dev recompile may have added or dropped an attachment reference;
			// the dev server reads the staging directory live. Read past the memo:
			// filling it here would hand the next compile — started by an edit
			// made after this point — an index from before that edit.
			if (!isProd) await publishAssets(await loadIndexes());
		},

		// `publish: false` on a docs-root page removes its route, which is what
		// takes the page out of the build, the auto-generated sidebar and nav
		// (built from the routes after this hook) and the search index (built from
		// the same route service later). A page listed explicitly in a hand-written
		// sidebar or nav keeps its entry there, and that link has nowhere to go —
		// remove it from the config as well.
		async routeServiceGenerated(routeService: {
			routeData: Map<string, { routeMeta?: { absolutePath?: string } }>;
		}) {
			for (const [routePath, page] of [...routeService.routeData]) {
				const absolutePath = page.routeMeta?.absolutePath;
				if (!absolutePath || !isPathInsideRoot(absolutePath, docsRoot)) continue;
				if (await isUnpublishedFile(absolutePath)) routeService.routeData.delete(routePath);
			}
		},

		async addPages(config: { root?: string; plugins?: readonly unknown[] }): Promise<VaultPage[]> {
			docsRoot = path.resolve(process.cwd(), config.root ?? "docs");
			sitePlugins = config.plugins;
			resetGeneration();
			// The indexes built here seed this generation's memo, so the remark
			// pass reuses them instead of parsing the vault again.
			const both = await getIndexes().both;
			const { docs, vault } = both;
			const pages: VaultPage[] = [];
			// Features first: they register the files they publish as pages
			// (`.base` views, drawings), which must not also be staged below as
			// downloadable attachments.
			const featureContext: PluginBuildContext = {
				options: normalizedOptions,
				docsRoot,
				vaultRoot,
				vaultRoutePrefix,
				siteBase,
				docs,
				vault,
				resolveOptions: { ...resolveOptions, canvasBoards: await canvasBoards(), fileRoutes },
				fileRoutes,
			};
			for (const feature of features) {
				pages.push(...((await feature.addPages?.(featureContext)) ?? []));
			}
			await publishAssets(both);
			if (vault) {
				// Routes come from the same index the resolver uses, so emitted
				// hrefs and generated routes cannot drift. Pages with
				// `publish: false` are already excluded from the index.
				for (const page of vault.pages) {
					pages.push({ routePath: page.routePath, filepath: page.absolutePath });
				}
				await warnLegacyCopies();
			}
			if (normalizedOptions.enableTagPages) {
				// One page per tag across both trees: two `/tags/x` routes
				// would fail the build.
				pages.push(...generateTagPages(...(vault ? [docs, vault] : [docs])));
			}
			if (normalizedOptions.enableDailyNotes && normalizedOptions.dailyNotes.calendar) {
				// One calendar route: the vault's daily notes, or the docs
				// tree's when the vault has none.
				const fromVault = vault
					? generateDailyNoteCalendar(vault, normalizedOptions.dailyNotes)
					: [];
				pages.push(
					...(fromVault.length > 0
						? fromVault
						: generateDailyNoteCalendar(docs, normalizedOptions.dailyNotes)),
				);
			}
			return pages;
		},

		markdown: {
			// The picker and the KaTeX stylesheet link are emitted as JSX elements
			// by the remark pass, so each component has to be resolvable by name in
			// every compiled page.
			globalComponents: [
				WIKI_PICKER_COMPONENT_PATH,
				...(katexMath ? [KATEX_STYLESHEET_COMPONENT_PATH] : []),
				...features.flatMap((feature) => feature.globalComponents?.() ?? []),
			],
			remarkPlugins: [remarkPluginTuple],
			rehypePlugins: [[rehypeRawForMdx, { getSiteBase: () => siteBase }]],
		},
	};
	return attachPublishedContent(plugin, publishedContent);
}
