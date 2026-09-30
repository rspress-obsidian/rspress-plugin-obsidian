// rspress-plugin-obsidian — umbrella entry.
// Re-exports the three feature plugins and their public helpers/types.

import type { RspressPlugin } from "@rspress/core";
import type { CanvasPluginOptions } from "./canvas/index.js";
import { canvas } from "./canvas/index.js";
import type { RspressPluginGraphViewOptions } from "./graph/index.js";
import { graphview } from "./graph/index.js";
import type { RspressPluginMarkdownOptions } from "./markdown/index.js";
import { markdown } from "./markdown/index.js";

// Re-exports for the three features and their public helpers/types.
export { type CanvasPluginOptions, canvas } from "./canvas/index.js";
// canvas helpers/types.
export { CanvasParseError, parseCanvas } from "./canvas/parser.js";
export type {
	BackgroundStyle,
	CanvasColor,
	CanvasData,
	CanvasEdgeData,
	CanvasFileData,
	CanvasGroupData,
	CanvasLinkData,
	CanvasNode,
	CanvasNodeData,
	CanvasTextData,
	EdgeEnd,
	NodeSide,
	NodeType,
} from "./canvas/types.js";
export { renderMarkdown, sanitizeUrl } from "./canvas/utils/markdown.js";
export { resolveFileRoute } from "./canvas/utils/resolver.js";
export { graphview, type RspressPluginGraphViewOptions } from "./graph/index.js";
// markdown feature helpers/types (stable public API of the markdown plugin).
export {
	type BacklinkRef,
	buildBacklinksIndex,
	getCachedBacklinksIndex,
	renderBacklinksHtml,
} from "./markdown/backlinks.js";
export {
	buildContentIndex,
	type ContentIndexOptions,
	getCachedContentIndex,
} from "./markdown/content-index.js";
export {
	expandDailyTemplateText,
	formatDailyNoteDate,
	normalizeDailyNoteConfig,
	parseDailyNoteDate,
	renderDailyNavigation,
} from "./markdown/daily-notes.js";
export {
	extractDataviewMetadata,
	renderDataviewInline,
	renderDataviewQuery,
} from "./markdown/dataview.js";
export { markdown } from "./markdown/index.js";
export {
	buildMentionsIndex,
	getMentions,
	type MentionRef,
	type MentionSource,
	stripMentionText,
} from "./markdown/mentions.js";
export { findWikilinkMatches, parseWikiLink } from "./markdown/parse-wikilink.js";
// The remark pass itself, for users composing their own unified pipeline.
export { remarkWikilink } from "./markdown/remark-wikilink.js";
export { resolveWikiLink } from "./markdown/resolve-wikilink.js";
export {
	type AdditionalPage,
	encodeTagPathSegment,
	generateTagPages,
} from "./markdown/tag-pages.js";
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
} from "./markdown/types.js";

/**
 * Builder handed to {@link pluginObsidian}: receives the three feature
 * factories and returns the plugins to register.
 */
export type PluginObsidianBuilder = (
	markdown: (options?: RspressPluginMarkdownOptions) => RspressPlugin,
	canvas: (options?: CanvasPluginOptions) => RspressPlugin,
	graphview: (options?: RspressPluginGraphViewOptions) => RspressPlugin,
) => RspressPlugin[];

/**
 * Umbrella factory that composes {@link markdown}, {@link canvas}, and
 * {@link graphview} into a single flat `RspressPlugin[]` suitable for the
 * `plugins:` slot in an Rspress config.
 *
 * Pass a builder that receives the three factory functions as arguments and
 * calls them inline:
 *
 * @example
 * ```ts
 * import { defineConfig } from "@rspress/core";
 * import { pluginObsidian } from "rspress-plugin-obsidian";
 *
 * export default defineConfig({
 *   plugins: pluginObsidian((markdown, canvas, graphview) => [
 *     markdown({ vaultRoot, enableCallouts: true }),
 *     canvas({ vaultRoot, routePrefix: "/canvas" }),
 *     graphview({ defaultOpen: true }),
 *   ]),
 * });
 * ```
 *
 * @param build - Callback that picks options per feature and returns the
 *   plugins to register.
 * @returns The flattened plugin list, ready for `plugins:`.
 */
export function pluginObsidian(build: PluginObsidianBuilder): RspressPlugin[] {
	return build(markdown, canvas, graphview);
}
