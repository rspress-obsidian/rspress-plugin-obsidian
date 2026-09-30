import fs from "node:fs/promises";
import path from "node:path";
import type { RspressPlugin } from "@rspress/core";
import { moduleDir, resolveRuntimeFile } from "../runtime-paths.js";
import { parseFrontmatter } from "../shared/frontmatter.js";
import { normalizeRoutePrefix } from "../shared/route-path.js";
import {
	blankCommentRanges,
	COMMENT_DELIMITER,
	filterCommentedToc,
	findCommentRanges,
} from "./comments.js";
import { buildContentIndex, type ContentIndex, getCachedContentIndex } from "./content-index.js";
import { generateDailyNoteCalendar, normalizeDailyNoteConfig } from "./daily-notes.js";
import {
	clearTransclusionCache,
	isPluginOwnedMarkdownDestination,
	remarkWikilink,
} from "./remark-wikilink.js";
import { generateTagPages } from "./tag-pages.js";
import type {
	NormalizedPluginOptions,
	RemarkPluginFactory,
	RemarkWikiLinkPluginOptions,
	RspressPluginMarkdownOptions,
} from "./types.js";
import { isPathInsideRoot } from "./utils.js";

export type { MathEngine } from "../math.js";
export type { MermaidSecurityLevel } from "../mermaid/classes.js";
export type { BacklinkRef } from "./backlinks.js";
export {
	buildBacklinksIndex,
	getCachedBacklinksIndex,
	renderBacklinksHtml,
} from "./backlinks.js";
export {
	buildContentIndex,
	type ContentIndexOptions,
	getCachedContentIndex,
} from "./content-index.js";
export {
	expandDailyTemplateText,
	formatDailyNoteDate,
	normalizeDailyNoteConfig,
	parseDailyNoteDate,
	renderDailyNavigation,
} from "./daily-notes.js";
export {
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
		return data.publish === false;
	} catch {
		// Unreadable or malformed frontmatter: the page keeps its route, and the
		// frontmatter pass reports the problem where it always has.
		return false;
	}
}

function normalizePluginOptions(
	options: RspressPluginMarkdownOptions = {},
): NormalizedPluginOptions {
	return {
		vaultRoot: options.vaultRoot ? path.resolve(process.cwd(), options.vaultRoot) : undefined,
		vaultRoutePrefix: normalizeRoutePrefix(options.vaultRoutePrefix, "/vault"),
		onBrokenLink: options.onBrokenLink ?? "error",
		onAmbiguousLink: options.onAmbiguousLink ?? "error",
		enableFuzzyMatching: options.enableFuzzyMatching ?? false,
		enableCaseInsensitiveLookup: options.enableCaseInsensitiveLookup ?? true,
		enableMarkdownLinks: options.enableMarkdownLinks ?? true,
		onDataviewError: options.onDataviewError ?? "error",
		onUnsupportedBlock: options.onUnsupportedBlock ?? "warn",
		enableDataview: options.enableDataview ?? false,
		enableDailyNotes: options.enableDailyNotes ?? false,
		dailyNotes: normalizeDailyNoteConfig(options.dailyNotes),
		enableTagLinking: options.enableTagLinking ?? false,
		enableCallouts: options.enableCallouts ?? false,
		// Mentions render inside the backlinks panel, so asking for them asks for it.
		enableBacklinks: (options.enableBacklinks ?? false) || options.enableUnlinkedMentions === true,
		enableUnlinkedMentions: options.enableUnlinkedMentions ?? false,
		enableTransclusion: options.enableTransclusion ?? false,
		enableMediaEmbeds: options.enableMediaEmbeds ?? false,
		enableTagPages: options.enableTagPages ?? false,
		enableMath: options.enableMath ?? false,
		mathEngine: options.mathEngine ?? "katex",
		enableMermaid: options.enableMermaid ?? false,
		mermaidSecurityLevel: options.mermaidSecurityLevel ?? "strict",
		enableDefaultStyles: options.enableDefaultStyles ?? false,
	};
}

// Resolved at module load time. Candidates cover the published bundle
// (`dist/markdown.css`) and the source layout (`src/markdown/styles.css`).
const STYLES_PATH = resolveRuntimeFile(
	path.join(moduleDir, "markdown.css"),
	path.join(moduleDir, "markdown", "styles.css"),
);
// Plugin stylesheet + KaTeX, used when both `enableDefaultStyles` and
// `enableMath` are on.
const MATH_STYLES_PATH = resolveRuntimeFile(
	path.join(moduleDir, "markdown", "math.css"),
	path.join(moduleDir, "markdown", "styles-math.css"),
);
// KaTeX alone, for sites that bring their own stylesheet. The published and
// source layouts put it in the same relative place, so one candidate suffices.
const KATEX_STYLES_PATH = path.join(moduleDir, "markdown", "katex.css");
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
/**
 * Pick the single stylesheet this plugin injects. KaTeX's stylesheet is needed
 * for math to be readable, so enabling math loads it even when the plugin's own
 * styles are off.
 */
function selectStylesheet(options: NormalizedPluginOptions): string | undefined {
	// MathJax brings its own generated stylesheet, emitted inline with the page,
	// so loading KaTeX's for it would be dead weight.
	const needsKatex = options.enableMath && options.mathEngine === "katex";
	if (options.enableDefaultStyles) {
		return needsKatex ? MATH_STYLES_PATH : STYLES_PATH;
	}
	return needsKatex ? KATEX_STYLES_PATH : undefined;
}

/** Page descriptor yielded by the plugin's addPages hook. */
type VaultPage = { routePath: string; filepath?: string; content?: string };
async function vaultPagesFromIndex(
	vaultRoot: string,
	routePrefix: string,
): Promise<{ index: ContentIndex; pages: VaultPage[] }> {
	// Single source of truth: routes come from the same index the resolver
	// uses, so emitted hrefs and generated routes cannot drift. Pages with
	// `publish: false` are already excluded from the index.
	const index = await buildContentIndex(vaultRoot, { routePrefix });
	return {
		index,
		pages: index.pages.map((page) => ({ routePath: page.routePath, filepath: page.absolutePath })),
	};
}

async function copyVaultAssets(
	index: ContentIndex,
	docsRoot: string,
	routePrefix: string,
): Promise<void> {
	// Rspress serves `docsRoot/public` at `/`. Vault attachments live outside
	// the docs tree, so copy them to `public/<prefix>/…` to match the
	// `/<prefix>/…` URLs emitted for media embeds.
	const prefix = routePrefix.replace(/^\/+|\/+$/g, "");
	for (const asset of index.assets) {
		const target = path.join(docsRoot, "public", prefix, asset.relativePath);
		await fs.mkdir(path.dirname(target), { recursive: true });
		await fs.copyFile(asset.absolutePath, target);
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
 * `onBrokenLink` and `onAmbiguousLink` default to `"error"`, so an
 * unresolvable `[[wikilink]]` fails the build until you have dealt with it.
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

	const isVaultFile = (filePath: string): boolean =>
		Boolean(normalizedOptions.vaultRoot && isPathInsideRoot(filePath, normalizedOptions.vaultRoot));

	// One index per root per build generation. Without this the remark pass
	// re-indexed the whole docs tree for every file it processed (N files × N
	// parses). `afterBuild` runs after every production build and every dev
	// recompile, so the memo is dropped once per generation: the first file of
	// the next generation re-indexes through `getCachedContentIndex` — whose
	// mtime/size signature picks up edited headings, anchors, aliases and new
	// notes — and the remaining files reuse that index.
	let indexPromises = new Map<string, Promise<ContentIndex>>();

	// Both memos last for exactly one build generation: the content index and
	// the rendered transclusions must be rebuilt once a dev recompile or a new
	// production build starts, or edits to embedded pages would not show up.
	const resetGeneration = (): void => {
		indexPromises = new Map();
		clearTransclusionCache();
	};

	const getIndex = (root: string, routePrefix?: string): Promise<ContentIndex> => {
		const key = `${root}|${routePrefix ?? ""}`;
		let pending = indexPromises.get(key);
		if (!pending) {
			pending = getCachedContentIndex(root, {
				routePrefix,
				unlinkedMentions: normalizedOptions.enableUnlinkedMentions,
			});
			indexPromises.set(key, pending);
		}
		return pending;
	};

	const getIndexForFile = (filePath: string): Promise<ContentIndex> => {
		const vaultRoot = normalizedOptions.vaultRoot;
		return vaultRoot && isVaultFile(filePath)
			? getIndex(vaultRoot, normalizedOptions.vaultRoutePrefix)
			: getIndex(docsRoot);
	};

	const remarkPluginTuple: [
		RemarkPluginFactory<RemarkWikiLinkPluginOptions>,
		RemarkWikiLinkPluginOptions,
	] = [
		remarkWikilink,
		{
			getDocsRoot: (filePath) =>
				filePath &&
				normalizedOptions.vaultRoot &&
				isPathInsideRoot(filePath, normalizedOptions.vaultRoot)
					? normalizedOptions.vaultRoot
					: docsRoot,
			getContentIndex: getIndexForFile,
			options: normalizedOptions,
		},
	];

	return {
		name: "rspress-plugin-obsidian:markdown",

		// One stylesheet slot per plugin, so the math variants are pre-built:
		// plugin styles alone, plugin styles + KaTeX, or KaTeX alone.
		...(() => {
			const stylesheet = selectStylesheet(normalizedOptions);
			return stylesheet ? { globalStyles: stylesheet } : {};
		})(),

		...(normalizedOptions.enableMermaid && {
			globalUIComponents: [[MERMAID_COMPONENT_PATH, {}]],
		}),

		// Comments are stripped from the rendered body by the remark pass, but
		// Rspress extracts the page outline and search content from its own parse
		// of the source, before plugin remark plugins run. `modifySearchIndexData`
		// runs before the search index is serialized, so private text can be
		// dropped there; the same page data feeds the outline, which
		// `extendPageData` cleans below.
		modifySearchIndexData(pages) {
			for (const page of pages) {
				const content = page.content ?? "";
				if (!content.includes(COMMENT_DELIMITER)) continue;
				const ranges = findCommentRanges(content);
				if (ranges.length === 0) continue;

				// Blanked, not removed: Rspress's search UI maps `toc[].charIndex`
				// into this string, so the offsets must survive the edit.
				page.content = blankCommentRanges(content, ranges);
				page.toc = filterCommentedToc(page.toc, content);
			}
		},

		// The page outline the theme renders ("on this page") is the same `toc`
		// array the search index was built from, and this hook runs before the
		// page data is assembled — so a heading a comment hides is dropped here
		// too. With the search index disabled Rspress records no toc offsets and
		// leaves `content` empty, so the flattened source stands in.
		extendPageData(pageData) {
			const source = pageData.content || pageData._flattenContent || "";
			if (source.includes(COMMENT_DELIMITER)) {
				pageData.toc = filterCommentedToc(pageData.toc, source);
			}

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

		config(config) {
			docsRoot = path.resolve(process.cwd(), config.root ?? "docs");
			resetGeneration();
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

			return config;
		},

		// Rspress invokes `config` and `addPages` once per process, so without
		// this the per-file memo would hand the startup index to every dev-server
		// recompile. `afterBuild` runs after each production build and after each
		// dev compile, so the next generation re-indexes and picks up edits.
		afterBuild() {
			resetGeneration();
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

		...((normalizedOptions.vaultRoot ||
			normalizedOptions.enableTagPages ||
			(normalizedOptions.enableDailyNotes && normalizedOptions.dailyNotes.calendar)) && {
			async addPages(config: { root?: string }): Promise<VaultPage[]> {
				const root = path.resolve(process.cwd(), config.root ?? "docs");
				docsRoot = root;
				resetGeneration();
				let pages: VaultPage[] = [];
				if (normalizedOptions.vaultRoot) {
					const vault = await vaultPagesFromIndex(
						normalizedOptions.vaultRoot,
						normalizedOptions.vaultRoutePrefix,
					);
					pages = vault.pages;
					await copyVaultAssets(vault.index, root, normalizedOptions.vaultRoutePrefix);
				}
				const calendar =
					normalizedOptions.enableDailyNotes && normalizedOptions.dailyNotes.calendar;
				if (normalizedOptions.enableTagPages || calendar) {
					const indexes = [await buildContentIndex(root)];
					if (normalizedOptions.vaultRoot) {
						indexes.push(
							await buildContentIndex(normalizedOptions.vaultRoot, {
								routePrefix: normalizedOptions.vaultRoutePrefix,
							}),
						);
					}
					for (const index of indexes) {
						if (normalizedOptions.enableTagPages) pages.push(...generateTagPages(index));
						if (calendar) {
							pages.push(...generateDailyNoteCalendar(index, normalizedOptions.dailyNotes));
						}
					}
				}
				return pages;
			},
		}),

		markdown: {
			// The picker is emitted as a JSX element by the remark pass, so the
			// component has to be resolvable by name in every compiled page.
			globalComponents: [WIKI_PICKER_COMPONENT_PATH],
			remarkPlugins: [remarkPluginTuple],
		},
	};
}
