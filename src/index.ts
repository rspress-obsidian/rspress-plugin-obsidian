// rspress-plugin-obsidian — umbrella entry.
// Re-exports the three feature plugins and their public helpers/types.
//
// The `graph` entry additionally exposes the plugin's runtime GraphPanel /
// GraphSidebar components (see `graph/runtime/...` subpath exports).
export { pluginObsidianCanvas } from "./canvas/index.ts";
export {
	pluginGraphview,
	type RspressPluginGraphViewOptions,
} from "./graph/index.ts";
export { pluginObsidianWikiLink } from "./markdown/index.ts";

// markdown feature helpers/types (stable public API of the wikilink plugin).
export {
	buildBacklinksIndex,
	getCachedBacklinksIndex,
	renderBacklinksHtml,
	type BacklinkRef,
} from "./markdown/backlinks.ts";
export { buildContentIndex, getCachedContentIndex } from "./markdown/content-index.ts";
export {
	expandDailyTemplateText,
	formatDailyNoteDate,
	normalizeDailyNoteConfig,
	parseDailyNoteDate,
	renderDailyNavigation,
} from "./markdown/daily-notes.ts";
export {
	extractDataviewMetadata,
	renderDataviewInline,
	renderDataviewQuery,
} from "./markdown/dataview.ts";
export { findWikilinkMatches, parseWikiLink } from "./markdown/parse-wikilink.ts";
export { resolveWikiLink } from "./markdown/resolve-wikilink.ts";
export {
	type AdditionalPage,
	encodeTagPathSegment,
	generateTagPages,
} from "./markdown/tag-pages.ts";
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
} from "./markdown/types.ts";

// canvas helpers/types.
export { CanvasParseError, parseCanvas } from "./canvas/parser.ts";
export { renderMarkdown, sanitizeUrl } from "./canvas/utils/markdown.ts";
export { resolveFileRoute } from "./canvas/utils/resolver.ts";
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
	CanvasPluginOptions,
	CanvasTextData,
	EdgeEnd,
	NodeSide,
	NodeType,
} from "./canvas/types.ts";
