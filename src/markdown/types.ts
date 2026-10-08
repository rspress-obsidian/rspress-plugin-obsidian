import type { Root as MDASTRoot } from "mdast";
import type { Plugin } from "unified";
import type { MathEngine } from "../math.js";
import type { MermaidSecurityLevel } from "../mermaid/classes.js";
import type { PublishedFileRoute } from "../shared/file-routes.js";
import type { BasesOptions } from "./obsidian-plugins/bases/options.js";
import type { ExcalidrawOptions } from "./obsidian-plugins/excalidraw/options.js";
import type { KanbanOptions } from "./obsidian-plugins/kanban/options.js";
import type { TasksOptions } from "./obsidian-plugins/tasks/options.js";
import type { TemplaterOptions } from "./obsidian-plugins/templater/options.js";

/**
 * A remark plugin factory: called with its options, returns a unified plugin
 * operating on an mdast tree. Declared locally so the package does not depend
 * on the devkit helper package this replaces.
 */
export type RemarkPluginFactory<PluginOptions = unknown> = Plugin<[PluginOptions], MDASTRoot>;

/**
 * How diagnostic events are surfaced to the Rspress build.
 * - `"error"` — calls VFile's `fail()`, failing the build.
 * - `"warn"` — calls VFile's `message()`, emitting a warning.
 */
export type DiagnosticMode = "error" | "warn";

/** Options for the daily-notes navigation feature (`enableDailyNotes`). */
export interface DailyNotesOptions {
	/** Vault-relative folder containing date-formatted daily notes. */
	folder?: string;
	/** Moment-style date format used in filenames. Default: `YYYY-MM-DD`. */
	dateFormat?: string;
	/** Add previous/current/next links to published daily notes. Default: `true`. */
	navigation?: boolean;
	/**
	 * Vault-relative path of a note used as the body of a daily note that is
	 * still empty, the way Obsidian's daily-notes core fills a new note from a
	 * template. `{{date}}`, `{{date:FORMAT}}`, `{{date±Nd/w/m/y}}` and
	 * `{{title}}` expand; a note that already has content is never touched.
	 * Default: none.
	 */
	template?: string;
	/**
	 * Route of a generated calendar page listing every daily note, grouped by
	 * month — the published equivalent of Obsidian's daily-notes calendar view.
	 * Set it to a path such as `/daily`. Default: none.
	 */
	calendar?: string;
}

/**
 * Plugin options accepted by the {@link markdown} factory (the package's
 * `rspress-plugin-obsidian/markdown` entry). All fields are optional and the
 * normalized defaults are conservative — most opt-in features are disabled.
 *
 * The fields fall into four groups, in this order:
 *
 * - **Where content comes from** — `vaultRoot`, `vaultRoutePrefix`, and
 *   `enableMarkdownLinks` / `enableCaseInsensitiveLookup` / `enableFuzzyMatching`,
 *   which decide what a link is allowed to name.
 * - **What renders** — the `enable*` toggles: `enableCallouts`,
 *   `enableTransclusion`, `enableMediaEmbeds`, `enableBacklinks`,
 *   `enableUnlinkedMentions`, `enableTagLinking`, `enableTagPages`,
 *   `enableDailyNotes` (+ `dailyNotes`), `enableDataview`, `enableMath`
 *   (+ `mathEngine`), `enableMermaid`, the plugin reproductions
 *   `enableTasks`, `enableKanban`, `enableExcalidraw`, `enableBases`,
 *   `enableTemplater` (each + its option object), `enableDefaultStyles`.
 * - **What counts as a link** — the resolution options above feed
 *   `wikilinkTargets`, which is what the backlinks panel and the graph read.
 * - **What happens when it does not work** — `onBrokenLink`,
 *   `onAmbiguousLink`, `onDataviewError`, `onUnsupportedBlock`,
 *   `onPluginError`, and
 *   `mermaidSecurityLevel`. `onBrokenLink` defaults to `"error"`: an
 *   unresolvable `[[wikilink]]` fails the build rather than shipping dead.
 *   An ambiguous one resolves the way Obsidian does and only warns.
 *
 * Note that the renderers emit markup, not rules: `enableCallouts`,
 * `enableBacklinks`, `enableTagPages` and the Kanban, Bases and Tasks layouts
 * need `enableDefaultStyles` (or the stylesheet imported by hand) before any
 * of it is visible.
 */
export interface RspressPluginMarkdownOptions {
	/**
	 * Absolute path to an external Obsidian vault to publish alongside the
	 * Rspress docs directory. When set, every routable `.md`/`.mdx` file in
	 * the vault is published as a page under `vaultRoutePrefix`, with the
	 * full Obsidian pipeline (wikilinks, embeds, callouts, Dataview, daily
	 * notes, backlinks, tags) applied as if the vault were the docs root.
	 *
	 * The vault is indexed separately from the docs root: wikilinks inside
	 * vault pages resolve against vault files first, and docs pages against
	 * docs files first; a link with no match in its own tree falls back to the
	 * other one, so the two can link (and backlink) each other.
	 *
	 * Only attachments a published page references (embeds, links, markdown
	 * images, frontmatter property links) are published, at
	 * `{vaultRoutePrefix}/<vault path>`. Dotfiles, files in dot-directories and
	 * attachments used only by `publish: false` notes never are. They are
	 * staged in `node_modules/.rspress-plugin-obsidian/` and served from there
	 * (dev and build alike); nothing is written into the docs tree.
	 * Default: unset (docs directory only).
	 */
	vaultRoot?: string;
	/**
	 * Route prefix for published vault pages. Default: `"/vault"`. Vault
	 * `Notes/Setup.md` publishes at `{vaultRoutePrefix}/Notes/Setup` — routes
	 * preserve the file's case and spacing, with `index` and the extension
	 * dropped.
	 */
	vaultRoutePrefix?: string;
	/** How to report unresolvable wikilinks. Default: `"error"`. */
	onBrokenLink?: DiagnosticMode;
	/**
	 * How to report a wikilink whose name matches several pages. The link still
	 * resolves like Obsidian's: a match in the linking note's folder first, then
	 * the shortest vault path, then the alphabetically first. Default: `"warn"`.
	 */
	onAmbiguousLink?: DiagnosticMode;
	/**
	 * Enable shortest-suffix fuzzy matching when exact, basename, title,
	 * and alias lookups all fail. Default: `false`.
	 */
	enableFuzzyMatching?: boolean;
	/**
	 * Enable case-insensitive path and basename fallback. Obsidian resolves
	 * links to existing files case-insensitively, so the default is `true`.
	 * Set to `false` for strict case-sensitive matching.
	 */
	enableCaseInsensitiveLookup?: boolean;
	/**
	 * Resolve standard markdown links (`[label](Page.md)`, including
	 * `#anchor` destinations and the `![alt](note.md)` embed form) against
	 * the vault index using the same resolution ladder as wikilinks.
	 * Default: `true`. External URLs, pure anchors, and unresolvable targets
	 * are left untouched.
	 */
	enableMarkdownLinks?: boolean;
	/**
	 * How invalid or unsupported Dataview blocks are reported. Default: `"error"`.
	 */
	onDataviewError?: DiagnosticMode;
	/**
	 * How a fenced block belonging to a plugin this site has not enabled
	 * (`tasks`, `base`, `excalidraw`, and Dataview while `enableDataview` is
	 * off) is reported; the message names the option that turns it on. The
	 * block stays in the page as code. Default: `"warn"`.
	 */
	onUnsupportedBlock?: DiagnosticMode;
	/**
	 * Evaluate static Dataview DQL blocks and inline expressions at build time.
	 * DataviewJS is never executed. Default: `false`.
	 */
	enableDataview?: boolean;
	/**
	 * Enable static Daily Notes date expansion and navigation. Default: `false`.
	 */
	enableDailyNotes?: boolean;
	/** Daily Notes folder, filename format, and navigation settings. */
	dailyNotes?: DailyNotesOptions;
	/**
	 * Rewrite inline `#tag` tokens into links to `/tags/<tag>`. Default: `false`.
	 */
	enableTagLinking?: boolean;
	/**
	 * Transform Obsidian callouts (`> [!note]`) into styled HTML. Default: `false`.
	 */
	enableCallouts?: boolean;
	/**
	 * Append a backlinks panel to each page listing inbound wikilinks.
	 * Default: `false`.
	 */
	enableBacklinks?: boolean;
	/**
	 * Also list pages that name the current page without linking to it, with a
	 * context snippet — Obsidian's "unlinked mentions". Implies
	 * {@link RspressPluginMarkdownOptions.enableBacklinks}, because
	 * that panel is where they appear, and keeps
	 * a stripped copy of each page body (capped) for the duration of the index.
	 * Default: `false`.
	 */
	enableUnlinkedMentions?: boolean;
	/**
	 * Inline the target of `![[Page]]` / `![[Page#Heading]]` / `![[Page#^block]]`.
	 * Default: `false`.
	 */
	enableTransclusion?: boolean;
	/**
	 * Render `![[image.png]]`, `![[video.mp4]]`, etc. as native HTML media
	 * elements. Default: `false`.
	 */
	enableMediaEmbeds?: boolean;
	/**
	 * Auto-generate `/tags/{name}` index pages for every frontmatter tag.
	 * Requires `enableTagLinking: true` to make inline `#tag` links reach
	 * these pages. Default: `false`.
	 */
	enableTagPages?: boolean;
	/**
	 * Render Obsidian math — `$inline$` and `$$display$$` — to KaTeX HTML
	 * during the remark pass. Enabling this also loads KaTeX's stylesheet:
	 * alongside the plugin's own stylesheet when `enableDefaultStyles` is set,
	 * on its own otherwise. Default: `false`.
	 */
	enableMath?: boolean;
	/**
	 * Which engine renders the math `enableMath` turns on. `"katex"` (the
	 * default) is fast and small; `"mathjax"` is the engine Obsidian itself
	 * uses, and covers the TeX KaTeX does not implement. MathJax is an optional
	 * dependency — install `mathjax-full` to use it — and its generated
	 * stylesheet is emitted inline with the page. Default: `"katex"`.
	 */
	mathEngine?: MathEngine;
	/**
	 * Render ` ```mermaid ` fences in notes as diagrams. Placeholders are
	 * emitted at build time and drawn by a client component registered through
	 * `globalUIComponents` (Mermaid needs the DOM), using the same
	 * `securityLevel: "strict"` renderer as the canvas feature. Default: `false`.
	 */
	enableMermaid?: boolean;
	/**
	 * Mermaid's `securityLevel` for client-rendered diagrams. `"strict"`
	 * (the default) runs mermaid's sanitising pass, which strips unsafe link
	 * URLs: a `click` directive with a `javascript:` URL is removed instead of
	 * rendered as a live anchor. The looser levels allow markup and handlers a
	 * strict build refuses, so they match Obsidian's more permissive rendering
	 * at the cost of trusting every diagram in the vault.
	 *
	 * Applies to note diagrams; canvas text nodes are emitted by the canvas
	 * feature and keep the strict default unless a note on the page has set the
	 * level. Default: `"strict"`.
	 */
	mermaidSecurityLevel?: MermaidSecurityLevel;
	/**
	 * Inject the bundled `.obsidian-*` and `.callout-*` stylesheet via the
	 * Rspress `globalStyles` hook. Default: `false`.
	 */
	enableDefaultStyles?: boolean;
	/**
	 * Obsidian's "Strict line breaks" setting. Obsidian's default (off) shows a
	 * single newline inside a paragraph as a line break; CommonMark (on) joins
	 * the lines. Unset: vault pages follow Obsidian's default and docs-root
	 * pages stay CommonMark, as Rspress renders them. `false`: every page
	 * renders newlines as `<br>`. `true`: no page does. Default: unset.
	 */
	strictLineBreaks?: boolean;
	/**
	 * The Tasks plugin: ` ```tasks ` query blocks over every task in the site,
	 * evaluated at build time. Default: `false`.
	 */
	enableTasks?: boolean;
	tasks?: TasksOptions;
	/** The Kanban plugin: notes with `kanban-plugin` frontmatter render as boards. Default: `false`. */
	enableKanban?: boolean;
	kanban?: KanbanOptions;
	/**
	 * The Excalidraw plugin: `.excalidraw.md` and `.excalidraw` drawings render
	 * as pictures, as pages and as embeds. Default: `false`.
	 */
	enableExcalidraw?: boolean;
	excalidraw?: ExcalidrawOptions;
	/** Obsidian Bases: `.base` files and ` ```base ` blocks render as views. Default: `false`. */
	enableBases?: boolean;
	bases?: BasesOptions;
	/** The Templater plugin: `<% %>` commands evaluate where Obsidian evaluates them. Default: `false`. */
	enableTemplater?: boolean;
	templater?: TemplaterOptions;
	/**
	 * What a Tasks, Kanban, Excalidraw, Bases or Templater block that cannot
	 * render does to the build. The block shows its error in place either way.
	 * Default: `"error"`.
	 */
	onPluginError?: DiagnosticMode;
}
export interface NormalizedPluginOptions {
	/** Resolved vault directory, or `undefined` when vault publishing is off. */
	vaultRoot?: string;
	/** Route prefix vault pages publish under. Default: `"/vault"`. */
	vaultRoutePrefix: string;
	onBrokenLink: DiagnosticMode;
	onAmbiguousLink: DiagnosticMode;
	enableFuzzyMatching: boolean;
	enableCaseInsensitiveLookup: boolean;
	enableMarkdownLinks: boolean;
	onDataviewError: DiagnosticMode;
	onUnsupportedBlock: DiagnosticMode;
	enableDataview: boolean;
	enableDailyNotes: boolean;
	dailyNotes: Required<DailyNotesOptions>;
	enableTagLinking: boolean;
	enableCallouts: boolean;
	enableBacklinks: boolean;
	enableUnlinkedMentions: boolean;
	enableTransclusion: boolean;
	enableMediaEmbeds: boolean;
	enableTagPages: boolean;
	enableMath: boolean;
	mathEngine: MathEngine;
	enableMermaid: boolean;
	mermaidSecurityLevel: MermaidSecurityLevel;
	enableDefaultStyles: boolean;
	/** As given; `undefined` keeps the vault-only default. */
	strictLineBreaks?: boolean;
	enableTasks: boolean;
	tasks: TasksOptions;
	enableKanban: boolean;
	kanban: KanbanOptions;
	enableExcalidraw: boolean;
	excalidraw: ExcalidrawOptions;
	enableBases: boolean;
	bases: BasesOptions;
	enableTemplater: boolean;
	templater: TemplaterOptions;
	onPluginError: DiagnosticMode;
}

/**
 * A fragment extracted from a wikilink target.
 *
 * Heading fragments may contain multiple `#`-separated levels because
 * Obsidian supports links such as `[[Page#Heading#Subheading]]`.
 */
export interface WikiSubpath {
	kind: "heading" | "block";
	value: string;
}

/** The structured form of a single wikilink token. */
export interface ParsedWikiLink {
	/** Original source text, including `[[...]]` or `![[...]]` delimiters. */
	raw: string;
	/** The target page or attachment reference. */
	target: string;
	/** Optional alias text after `|`. */
	alias?: string;
	/** `true` for transclusion / media embeds (`![[...]]`). */
	isEmbed: boolean;
	/** Heading or block scope fragment after `#`, if any. */
	subpath?: WikiSubpath;
	/** Vault-wide search syntax (`[[## heading]]` or `[[^^block]]`). */
	search?: "heading" | "block";
	/** `true` for `[[#Heading]]` style links that stay on the current page. */
	isCurrentPageReference: boolean;
}

/** Raw match metadata produced by the tokenizer before parsing. */
export interface WikilinkMatch {
	fullMatch: string;
	inner: string;
	start: number;
	end: number;
}

/** A single heading entry indexed from a page. */
export interface HeadingEntry {
	/** The heading's text as the page renders it (comments dropped, wikilinks
	 *  shown as their display text, emphasis markers removed). */
	rawText: string;
	/** The id the rendered heading carries, unless `explicitId` is set. */
	slug: string;
	explicitId?: string;
	/** Heading level, 1–6. Absent on hand-built entries. */
	depth?: number;
	/** The heading's inline markdown as written, for `[[Note#**Bold** text]]`. */
	sourceText?: string;
	/** Short plain-text preview of the content following this heading
	 *  (the first ~200 characters, markdown and comments stripped). Used for
	 *  tooltip previews on heading wikilinks. */
	preview?: string;
}

/** A single block anchor indexed from a page. */
export interface BlockEntry {
	id: string;
}

/** A non-Markdown file that can be addressed by an Obsidian wikilink. */
export interface ContentAsset {
	absolutePath: string;
	relativePath: string;
	pathKey: string;
	baseName: string;
	urlPath: string;
}

/**
 * A Dataview list item extracted from a Markdown list — Dataview's `ListItem`.
 * Tasks are list items too and appear in both `dataviewLists` and
 * `dataviewTasks`.
 */
export interface DataviewListItem {
	/** Item text without the list marker or checkbox; continuation lines joined with `\n`. */
	text: string;
	/** Zero-based source line of the item, as Dataview numbers it. */
	line: number;
	/** Number of source lines the item spans (continuation lines included). */
	lineCount: number;
	path: string;
	/** Inline fields of the item (`[key:: value]`, task emoji shorthands). */
	fields: Record<string, unknown>;
	/** List marker as written: `-`, `*`, `+`, `1.`, `1)`. */
	symbol: string;
	/** `line` of the enclosing list item; absent at the top level of a list. */
	parent?: number;
	/** `line` of each directly nested list item, in source order. */
	children: number[];
	/** Text of the nearest heading above the item, if any. */
	section?: string;
	/** `#tags` written in the item, with their `#`. */
	tags: string[];
	/** Checkbox character (` `, `x`, `/`, `-`, …) for a task; absent on plain items. */
	status?: string;
}

/** A Dataview task: a list item with a one-character checkbox status. */
export interface DataviewTask extends DataviewListItem {
	status: string;
	/** `true` only for the `x`/`X` status. */
	completed: boolean;
	/** Completed, and so is every task nested under it. */
	fullyCompleted: boolean;
}

/** The normalized, searchable representation of a single docs page. */
export interface ContentPage {
	absolutePath: string;
	relativePath: string;
	routePath: string;
	/** Rspress route-oriented key; may collapse an `index.md` suffix. */
	pathKey: string;
	/** Exact vault-relative key with only the Markdown extension removed. */
	filePathKey: string;
	baseName: string;
	title?: string;
	aliases: string[];
	tags: string[];
	cssclasses: string[];
	excerpt?: string;
	publish: boolean;
	fileCtimeMs: number;
	fileMtimeMs: number;
	fileSizeBytes: number;
	headings: HeadingEntry[];
	/** Pre-extracted normalized wikilink targets from this page's content. */
	wikilinkTargets: string[];
	/**
	 * Every link the page makes, as parsed wikilinks: body wikilinks and embeds,
	 * relative markdown links/images and reference definitions, `obsidian://`
	 * URIs, and frontmatter property links. Backlinks and attachment publishing
	 * resolve exactly this list. Absent on hand-built pages.
	 */
	outlinks?: ParsedWikiLink[];
	/** Maps slugified heading text → HeadingEntry for O(1) resolution. */
	headingBySlug: Map<string, HeadingEntry>;
	/** Maps normalized (lowercased, single-spaced) raw heading text → first heading. */
	headingByText: Map<string, HeadingEntry>;
	blocks: BlockEntry[];
	/** Frontmatter and inline fields indexed for static Dataview queries. */
	dataviewFields: Record<string, unknown>;
	dataviewTasks: DataviewTask[];
	dataviewLists: DataviewListItem[];
}

/**
 * The pre-computed lookup tables used by the resolver. Produced by
 * `buildContentIndex()` or its memoized sibling `getCachedContentIndex()`.
 */
export interface ContentIndex {
	rootDir: string;
	pages: ContentPage[];
	assets: ContentAsset[];
	byAbsolutePath: Map<string, ContentPage>;
	/** Legacy route-oriented lookup retained for callers inspecting Rspress routes. */
	byPathKey: Map<string, ContentPage>;
	/** Exact vault-relative page lookup, without route `index` collapsing. */
	byFilePathKey: Map<string, ContentPage>;
	byBaseName: Map<string, ContentPage[]>;
	byTitle: Map<string, ContentPage[]>;
	byAlias: Map<string, ContentPage[]>;
	byTag: Map<string, ContentPage[]>;
	byAssetPath: Map<string, ContentAsset>;
	byAssetBaseName: Map<string, ContentAsset[]>;
	/** Case-insensitive pathKey → pages lookup. */
	byPathKeyCI: Map<string, ContentPage[]>;
	/** Case-insensitive exact vault path → pages lookup. */
	byFilePathKeyCI: Map<string, ContentPage[]>;
	/** Case-insensitive basename → pages lookup. */
	byBaseNameCI: Map<string, ContentPage[]>;
	/** Case-insensitive exact vault attachment path → assets lookup. */
	byAssetPathCI: Map<string, ContentAsset[]>;
	/** Case-insensitive attachment basename → assets lookup. */
	byAssetBaseNameCI: Map<string, ContentAsset[]>;
	/**
	 * Pre-built backlinks map, constructed during content indexing.
	 * Maps each page's routePath to the pages that link to it.
	 * Built once during index construction; no separate pass needed.
	 */
	backlinks: Map<string, BacklinkRef[]>;
	/**
	 * The other trees published on the same site (the docs root for a vault, the
	 * vault for the docs root), consulted by `resolveWikiLink` when this index
	 * has no match and merged into the backlinks panel. Set by the plugin per
	 * build generation.
	 */
	linkedIndexes?: ContentIndex[];
}

/**
 * A reference to a page that links to another page, used in the backlinks
 * panel and the pre-built backlinks map on {@link ContentIndex}.
 */
export interface BacklinkRef {
	routePath: string;
	/** Vault-relative source path; absent on hand-built refs, which then get no index-page trailing slash. */
	relativePath?: string;
	title: string;
}

/** Outcome of attempting to resolve a wikilink. */
export type ResolveStatus = "ok" | "broken-page" | "broken-anchor" | "ambiguous-page";

/**
 * The resolved form of a wikilink. On success, `href` and `label` are set
 * and `targetPage` references the indexed page. On failure, `message`
 * carries a human-readable diagnostic.
 */
export interface ResolvedWikiLink {
	status: ResolveStatus;
	href?: string;
	label?: string;
	targetPage?: ContentPage;
	message?: string;
	/** Plain-text preview of the heading section content, for tooltips. */
	description?: string;
	/**
	 * Vault-relative path of the `.canvas` file when the target is a board the
	 * canvas feature has published (set together with `href` pointing at that
	 * board's route). The embed syntax uses it as the `<CanvasEmbed src>` value;
	 * its presence also marks "canvas feature active for this file".
	 */
	canvasSrc?: string;
	/**
	 * The page a feature publishes the target file on (a `.base` view, a plain
	 * `.excalidraw` drawing), set together with `href` pointing at that page.
	 * Such a target is never a `targetAsset`: it is not staged as a download.
	 */
	fileRoute?: PublishedFileRoute;
	/**
	 * Every target a vault search (`[[##query]]`) matched, when more than one did.
	 *
	 * The remark pass turns this into a `<WikiPicker>`: Obsidian opens a list of
	 * matches for an ambiguous vault search, and a build-time-only pipeline has
	 * nowhere else to put them. A single match resolves to a plain link instead
	 * and never sets this.
	 */
	candidates?: WikiLinkCandidate[];
	/**
	 * Set on an `ok` result whose name matched several files: the link resolved
	 * the way Obsidian picks (same folder, then shortest path, then
	 * alphabetical), and this message lists the alternatives so the caller can
	 * report it through `onAmbiguousLink`.
	 */
	ambiguity?: string;
	/** The attachment an `ok` result points at, when it is not a page. */
	targetAsset?: ContentAsset;
}

/** One entry of a vault-search picker. */
export interface WikiLinkCandidate {
	href: string;
	label: string;
	/** Page the match lives on, shown next to the label in the picker. */
	pageLabel: string;
	/** Plain-text preview of the section, when the heading carries one. */
	description?: string;
}

/** Input required by `resolveWikiLink()`. */
export interface ResolveContext {
	currentPage: ContentPage;
	index: ContentIndex;
	/**
	 * Indexes to try, in order, when `index` has no match. Defaults to
	 * `index.linkedIndexes`.
	 */
	fallbackIndexes?: ContentIndex[];
	options?: Partial<
		Pick<NormalizedPluginOptions, "enableFuzzyMatching" | "enableCaseInsensitiveLookup">
	>;
}

/**
 * Options accepted by the underlying remark plugin. Normally constructed
 * by the plugin entry; exported for advanced users composing their own
 * unified pipeline.
 */
export interface RemarkWikiLinkPluginOptions {
	getDocsRoot: (filePath?: string) => string;
	getContentIndex?: (filePath: string) => Promise<ContentIndex>;
	/**
	 * Every published content index (docs, then the vault). Queries that span
	 * the whole site — Tasks, Bases — read these. Defaults to the file's own
	 * index.
	 */
	getPublishedIndexes?: () => Promise<readonly ContentIndex[]>;
	options: NormalizedPluginOptions;
	/**
	 * The site's Rspress `base` (always starting and ending with `/`). Raw HTML
	 * the pass emits for `<audio>`, `<video>` and `<iframe>` is not rewritten by
	 * Rspress, so those URLs must be prefixed here. Defaults to `/`.
	 */
	getSiteBase?: () => string;
}
