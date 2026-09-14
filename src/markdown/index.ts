import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RspressPlugin } from "@rspress/core";
import type { RemarkPluginFactory } from "rspress-plugin-devkit";
import { buildContentIndex, type ContentIndex } from "./content-index.ts";
import { normalizeDailyNoteConfig } from "./daily-notes.ts";
import { remarkWikilink } from "./remark-wikilink.ts";
import { generateTagPages } from "./tag-pages.ts";
import type {
	NormalizedPluginOptions,
	RemarkWikiLinkPluginOptions,
	RspressPluginObsidianWikiLinkOptions,
} from "./types.ts";

export type { BacklinkRef } from "./backlinks.ts";
export {
	buildBacklinksIndex,
	getCachedBacklinksIndex,
	renderBacklinksHtml,
} from "./backlinks.ts";
export {
	buildContentIndex,
	getCachedContentIndex,
} from "./content-index.ts";
export {
	expandDailyTemplateText,
	formatDailyNoteDate,
	normalizeDailyNoteConfig,
	parseDailyNoteDate,
	renderDailyNavigation,
} from "./daily-notes.ts";
export {
	extractDataviewMetadata,
	renderDataviewInline,
	renderDataviewQuery,
} from "./dataview.ts";
export { findWikilinkMatches, parseWikiLink } from "./parse-wikilink.ts";
export { resolveWikiLink } from "./resolve-wikilink.ts";
export {
	type AdditionalPage,
	encodeTagPathSegment,
	generateTagPages,
} from "./tag-pages.ts";
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
	ResolveContext,
	ResolvedWikiLink,
	ResolveStatus,
	RspressPluginObsidianWikiLinkOptions,
	WikilinkMatch,
	WikiSubpath,
} from "./types.ts";

function normalizePluginOptions(
	options: RspressPluginObsidianWikiLinkOptions = {},
): NormalizedPluginOptions {
	return {
		vaultRoot: options.vaultRoot ? path.resolve(process.cwd(), options.vaultRoot) : undefined,
		vaultRoutePrefix: normalizeRoutePrefix(options.vaultRoutePrefix),
		onBrokenLink: options.onBrokenLink ?? "error",
		onAmbiguousLink: options.onAmbiguousLink ?? "error",
		enableFuzzyMatching: options.enableFuzzyMatching ?? false,
		enableCaseInsensitiveLookup: options.enableCaseInsensitiveLookup ?? true,
		enableMarkdownLinks: options.enableMarkdownLinks ?? true,
		onDataviewError: options.onDataviewError ?? "error",
		enableDataview: options.enableDataview ?? false,
		enableDailyNotes: options.enableDailyNotes ?? false,
		dailyNotes: normalizeDailyNoteConfig(options.dailyNotes),
		enableTagLinking: options.enableTagLinking ?? false,
		enableCallouts: options.enableCallouts ?? false,
		enableBacklinks: options.enableBacklinks ?? false,
		enableTransclusion: options.enableTransclusion ?? false,
		enableMediaEmbeds: options.enableMediaEmbeds ?? false,
		enableTagPages: options.enableTagPages ?? false,
		enableDefaultStyles: options.enableDefaultStyles ?? false,
	};
}

/** Normalize a route prefix: ensure leading slash, no trailing slash. */
function normalizeRoutePrefix(value: string | undefined): string {
	const prefix = value ?? "/vault";
	const withLeading = prefix.startsWith("/") ? prefix : `/${prefix}`;
	return withLeading.replace(/\/+$/, "") || "/vault";
}

// Resolved at module load time — works from both src/ (dev) and dist/ (published).
const STYLES_PATH = fileURLToPath(new URL("./styles.css", import.meta.url));

/**
 * Rspress plugin that rewrites Obsidian-style wikilinks and supporting syntax
 * (callouts, tags, backlinks, transclusion, media embeds, footnotes, highlights,
 * comments, and optional static Dataview DQL) during the remark pipeline.
 *
 * @example
 * ```ts
 * // rspress.config.ts
 * import { defineConfig } from "@rspress/core";
 * import { pluginObsidianWikiLink } from "rspress-plugin-obsidian-wikilink";
 *
 * export default defineConfig({
 *   plugins: [
 *     pluginObsidianWikiLink({
 *       enableCallouts: true,
 *       enableBacklinks: true,
 *       enableDefaultStyles: true,
 *     }),
 *   ],
 * });
 * ```
 *
 * @param options - Feature toggles and diagnostic behaviour. All fields are
 *   optional; see {@link RspressPluginObsidianWikiLinkOptions} for details.
 * @returns An {@link RspressPlugin} ready to append to `plugins:`.
 */
async function createVaultPages(vaultRoot: string, routePrefix: string): Promise<VaultPage[]> {
	const pages: VaultPage[] = [];
	const queue = [path.resolve(vaultRoot)];
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) continue;
		const entries = await fs.readdir(current, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const absolutePath = path.join(current, entry.name);
			if (entry.isDirectory()) {
				queue.push(absolutePath);
				continue;
			}
			if (!entry.isFile() || !/\.(md|mdx)$/i.test(entry.name)) continue;
			const relativePath = path.relative(vaultRoot, absolutePath).replaceAll(path.sep, "/");
			if (relativePath.split("/").some((part) => /^_[^_]/.test(part))) continue;
			const withoutExtension = relativePath.replace(/\.(md|mdx)$/i, "");
			const routePart = withoutExtension.replace(/\/index$/i, "");
			const routePath = `${routePrefix}/${routePart}`.replace(/\/+/g, "/").replace(/\/$/, "") || routePrefix;
			pages.push({ routePath, filepath: absolutePath });
		}
	}
	return pages;
}

type VaultPage = { routePath: string; filepath?: string; content?: string };
export function pluginObsidianWikiLink(
	options: RspressPluginObsidianWikiLinkOptions = {},
): RspressPlugin {
	const normalizedOptions = normalizePluginOptions(options);
	let docsRoot = path.resolve(process.cwd(), "docs");
	let vaultIndex: ContentIndex | undefined;

	const getIndexForFile = async (filePath: string): Promise<ContentIndex> => {
		if (normalizedOptions.vaultRoot && filePath.startsWith(`${normalizedOptions.vaultRoot}${path.sep}`)) {
			vaultIndex ??= await buildContentIndex(normalizedOptions.vaultRoot, {
				routePrefix: normalizedOptions.vaultRoutePrefix,
			});
			return vaultIndex;
		}
		return buildContentIndex(docsRoot);
	};

	const remarkPluginTuple: [
		RemarkPluginFactory<RemarkWikiLinkPluginOptions>,
		RemarkWikiLinkPluginOptions,
	] = [
		remarkWikilink,
		{
			getDocsRoot: (filePath) =>
				filePath && normalizedOptions.vaultRoot && filePath.startsWith(`${normalizedOptions.vaultRoot}${path.sep}`)
					? normalizedOptions.vaultRoot
					: docsRoot,
			getContentIndex: getIndexForFile,
			options: normalizedOptions,
		},
	];

	return {
		name: "rspress-plugin-obsidian-wikilink",

		...(normalizedOptions.enableDefaultStyles && {
			globalStyles: STYLES_PATH,
		}),

		config(config) {
			docsRoot = path.resolve(process.cwd(), config.root ?? "docs");
			vaultIndex = undefined;

			// Vault-style markdown links (`[x](Page.md)` resolved by basename,
			// not relative path) fail Rspress's own dead-link gate before this
			// plugin's remark pass can resolve them. When markdown-link
			// resolution is on, take over that gate — unresolved `.md`
			// destinations are then reported through `onBrokenLink` instead,
			// preserving build safety. An explicit user setting wins.
			if (
				normalizedOptions.enableMarkdownLinks &&
				config.markdown?.link?.checkDeadLinks === undefined
			) {
				config.markdown = {
					...config.markdown,
					link: { ...config.markdown?.link, checkDeadLinks: false },
				};
			}

			return config;
		},
		...((normalizedOptions.vaultRoot || normalizedOptions.enableTagPages) && {
			async addPages(config): Promise<VaultPage[]> {
				const root = path.resolve(process.cwd(), (config as { root?: string }).root ?? "docs");
				docsRoot = root;
				const pages = normalizedOptions.vaultRoot
					? await createVaultPages(normalizedOptions.vaultRoot, normalizedOptions.vaultRoutePrefix)
					: [];
				if (normalizedOptions.enableTagPages) {
					const index = await buildContentIndex(root);
					pages.push(...generateTagPages(index));
				}
				return pages;
			},
		}),

		markdown: {
			remarkPlugins: [remarkPluginTuple],
		},
	};
}
