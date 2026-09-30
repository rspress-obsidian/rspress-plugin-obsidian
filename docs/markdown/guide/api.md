---
description: Complete API reference for rspress-plugin-obsidian. Covers the plugin, content and backlink indexes, daily-note and Dataview helpers, wikilink parsing and resolution, tag pages, and all public TypeScript types.
---

# API Reference

This document covers the public API exported from `rspress-plugin-obsidian`.

> **Quick start:** If you use wikilinks, Canvas, and graph view together, use the umbrella factory `pluginObsidian((markdown, canvas, graphview) => [ markdown({...}), canvas({...}), graphview({...}) ])` from `rspress-plugin-obsidian`.

## Plugin Function

Creates an Rspress plugin that rewrites wikilinks during the remark pipeline.

```ts
import { markdown } from "rspress-plugin-obsidian";
import { defineConfig } from "@rspress/core";

export default defineConfig({
  plugins: [
    markdown({
      onBrokenLink: "error",
      enableCallouts: true,
      enableTagLinking: true,
      enableTagPages: true,
      enableDefaultStyles: true,
    }),
  ],
});
```

#### Options

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `vaultRoot` | `string` | unset | Absolute path to an Obsidian vault published alongside `docs/`, with wikilinks resolving against the vault |
| `vaultRoutePrefix` | `string` | `"/vault"` | Route prefix vault pages publish under |
| `onBrokenLink` | `DiagnosticMode` | `"error"` | How to handle missing link targets |
| `onAmbiguousLink` | `DiagnosticMode` | `"error"` | How to handle ambiguous links |
| `enableFuzzyMatching` | `boolean` | `false` | Enable shortest-suffix path fallback |
| `enableCaseInsensitiveLookup` | `boolean` | `true` | Case-insensitive path resolution (matches Obsidian; set `false` for strict matching) |
| `enableMarkdownLinks` | `boolean` | `true` | Resolve `[label](Page.md)` markdown links and `![alt](note.md)` embeds against the vault |
| `onDataviewError` | `DiagnosticMode` | `"error"` | How to report invalid or unsupported Dataview blocks |
| `onUnsupportedBlock` | `DiagnosticMode` | `"warn"` | How to report fences from an Obsidian plugin runtime this plugin cannot execute (`tasks`, `excalidraw`, `base`, `kanban`, and Dataview while `enableDataview` is off) — the block stays in the page as code |
| `enableDataview` | `boolean` | `false` | Evaluate static Dataview DQL blocks and inline expressions at build time |
| `enableDailyNotes` | `boolean` | `false` | Enable static Daily Notes date expansion and navigation |
| `dailyNotes` | `DailyNotesOptions` | `{ folder: "", dateFormat: "YYYY-MM-DD", navigation: true, template: "", calendar: "" }` | Configure the Daily Notes folder, filename format, navigation, template note and calendar page |
| `enableTagLinking` | `boolean` | `false` | Convert `#tag` to `/tags/tag` links |
| `enableCallouts` | `boolean` | `false` | Transform `> [!note]` callouts |
| `enableBacklinks` | `boolean` | `false` | Append backlinks panel to each page |
| `enableUnlinkedMentions` | `boolean` | `false` | Also list pages that name the current page without linking to it. Implies `enableBacklinks` and keeps a capped copy of each page body while indexing |
| `enableTransclusion` | `boolean` | `false` | Inline `![[Page]]` content |
| `enableMediaEmbeds` | `boolean` | `false` | Render `![[img.png]]` as `<img>` |
| `enableTagPages` | `boolean` | `false` | Generate `/tags/{name}` index pages |
| `enableMath` | `boolean` | `false` | Render `$inline$` / `$$display$$` math with KaTeX (loads KaTeX's stylesheet) |
| `mathEngine` | `"katex" \| "mathjax"` | `"katex"` | Which engine renders that math. `"mathjax"` is Obsidian's own engine and needs the optional `mathjax-full` package; it emits its own generated stylesheet inline |
| `enableMermaid` | `boolean` | `false` | Render ` ```mermaid ` fences as diagrams in the browser |
| `mermaidSecurityLevel` | `"strict" \| "loose" \| "antiscript" \| "sandbox"` | `"strict"` | Mermaid `securityLevel` for note diagrams. `strict` sanitizes the SVG and strips unsafe link URLs; looser levels allow what a strict build refuses |
| `enableDefaultStyles` | `boolean` | `false` | Inject bundled CSS stylesheet |

## Remark Plugin

### `remarkWikilink(options: RemarkWikiLinkPluginOptions)`

The remark pass itself, for composing your own unified pipeline instead of using `markdown()`. Calling it returns the unified plugin. It expects the plugin's runtime context: `getDocsRoot(filePath?)`, an optional `getContentIndex(filePath)`, and `options` as an already-normalized `NormalizedPluginOptions` object ([shape documented below](#normalizedpluginoptions)). Sites that just want the feature should use `markdown()`.

## Content Index

### `buildContentIndex(rootDir: string, options?: ContentIndexOptions): Promise<ContentIndex>`

Scans all `.md` and `.mdx` files under `rootDir` and builds a lookup index. Runs on every call.

`ContentIndexOptions` (exported) has two optional fields:

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `routePrefix` | `string` | `""` | Prefix prepended to emitted page and asset route paths |
| `unlinkedMentions` | `boolean` | `false` | Keep a stripped copy of each page body so `getMentions` can find pages that name another page without linking to it (the only option that retains page text) |

```ts
import { buildContentIndex } from "rspress-plugin-obsidian";

const index = await buildContentIndex("/path/to/docs");
console.log(index.pages.length);
console.log(index.byTag.get("tutorial"));
```

### `getCachedContentIndex(rootDir: string, options?: ContentIndexOptions): Promise<ContentIndex>`

Returns a cached index when file mtimes and sizes are unchanged since the last call. The options are part of the cache key, so calls with different options get separate entries. Preferred over `buildContentIndex` in hot paths.

```ts
import { getCachedContentIndex } from "rspress-plugin-obsidian";

const index = await getCachedContentIndex("/path/to/docs");
```

## Daily Notes

The daily-note helpers are also available for integrations that need to expand
date templates or render navigation outside the plugin pipeline. Their
configuration uses this structural shape:

```ts
{
  folder: string;
  dateFormat: string;
  navigation: boolean;
  template: string;
  calendar: string;
}
```

The helper module calls this shape `DailyNoteConfig`; that name is not
re-exported from the package. For plugin configuration, use the exported
`DailyNotesOptions` type instead.

### `normalizeDailyNoteConfig(config?: Partial<DailyNoteConfig>): DailyNoteConfig`

Normalizes an optional daily-note configuration. The defaults are an empty
folder, `YYYY-MM-DD` filenames, and navigation enabled.

```ts
import { normalizeDailyNoteConfig } from "rspress-plugin-obsidian";

const config = normalizeDailyNoteConfig({
  folder: "Daily",
  dateFormat: "YYYY-MM-DD",
  navigation: true,
});
```

### `parseDailyNoteDate(relativePath: string, config: DailyNoteConfig): Date | undefined`

Parses a date-formatted daily-note path. Returns `undefined` when the path is
outside the configured folder, does not match the configured format, or
contains an invalid calendar date.

### `formatDailyNoteDate(date: Date, format: string): string`

Formats a UTC date using the supported tokens `YYYY`, `YY`, `MMMM`, `MMM`,
`MM`, `M`, `DD`, `D`, `dddd`, and `ddd`.

### `expandDailyTemplateText(value: string, date: Date): string`

Expands `{{date}}` placeholders and optional format/offset expressions such as
`{{date:MMMM D, YYYY}}` and `{{date-1d}}`.

> The template and calendar pages a `dailyNotes` config produces are built by the
> plugin, not by you — `dailyNotes.template` and `dailyNotes.calendar` are covered
> in [Advanced Usage](./advanced). Only the helpers above are exported.

### `renderDailyNavigation(currentPage: ContentPage, pages: ContentPage[], config: DailyNoteConfig): string`

Renders the previous/current/next daily-note navigation HTML. Returns an empty
string when navigation is disabled or the current page is not a dated note.

## Dataview

These helpers evaluate the static Dataview subset supported by the plugin.
DataviewJS blocks run through a restricted interpreter, not a JavaScript
engine: it supports `const`/`let`/`var` declarations, `dv.pages`/`dv.page`/
`dv.current`/`dv.date`/`dv.array`, and the `dv.table`/`dv.list`/`dv.taskList`/
`dv.paragraph`/`dv.header` render calls. Source that mentions a host or runtime
API (`process`, `require`, `fetch`, `eval`, `Function`, `globalThis`, …) is
rejected and reported through `onDataviewError`.

### `extractDataviewMetadata(markdown: string, frontmatter: Record<string, unknown>, filePath: string): { fields: Record<string, unknown>; tasks: DataviewTask[]; lists: DataviewListItem[] }`

Extracts normalized fields, tasks, and list items from a Markdown document:

```ts
{
  fields: Record<string, unknown>;
  tasks: DataviewTask[];
  lists: DataviewListItem[];
}
```

### `renderDataviewQuery(query: string, currentPage: ContentPage, index: ContentIndex, dailyConfig?: DailyNoteConfig): { html?: string; error?: string }`

Evaluates a static `TABLE`, `LIST`, `TASK`, or `CALENDAR` query and returns
rendered HTML on success. Unsupported or invalid queries return an `error`
instead.

### `renderDataviewInline(expression: string, currentPage: ContentPage, index: ContentIndex, dailyConfig?: DailyNoteConfig): { html?: string; error?: string }`

Evaluates one static Dataview inline expression and returns a rendered
`<span>` on success, or an `error` for an unsupported expression.


## Wikilink Parsing

### `findWikilinkMatches(input: string): WikilinkMatch[]`

Finds all wikilinks (including embed syntax) in a markdown string.

```ts
import { findWikilinkMatches } from "rspress-plugin-obsidian";

const matches = findWikilinkMatches("Check [[Page1]] and ![[Page2|Embed]].");
// matches[0] → { fullMatch: "[[Page1]]", inner: "Page1", start: 6, end: 15 }
// matches[1] → { fullMatch: "![[Page2|Embed]]", inner: "Page2|Embed", start: 20, end: 36 }
```

### `parseWikiLink(inner: string, raw: string): ParsedWikiLink`

Parses the inner content of a wikilink into its components.

```ts
import { parseWikiLink } from "rspress-plugin-obsidian";

const parsed = parseWikiLink(
  "guide/getting-started#Install|Install guide",
  "[[guide/getting-started#Install|Install guide]]",
);
// {
//   raw: "[[guide/getting-started#Install|Install guide]]",
//   target: "guide/getting-started",
//   alias: "Install guide",
//   isEmbed: false,
//   subpath: { kind: "heading", value: "Install" },
//   isCurrentPageReference: false
// }
```

## Wikilink Resolution

### `resolveWikiLink(parsed: ParsedWikiLink, context: ResolveContext): ResolvedWikiLink`

Resolves a parsed wikilink to its final href using the content index.

```ts
import {
  buildContentIndex,
  findWikilinkMatches,
  parseWikiLink,
  resolveWikiLink,
} from "rspress-plugin-obsidian";

const index = await buildContentIndex("/path/to/docs");
const currentPage = index.byPathKey.get("guide/intro")!;

const [match] = findWikilinkMatches("See [[getting-started]].");
const parsed = parseWikiLink(match.inner, match.fullMatch);
const resolved = resolveWikiLink(parsed, { currentPage, index });

if (resolved.status === "ok") {
  console.log(resolved.href);  // "/guide/getting-started"
  console.log(resolved.label); // "getting started"
}
```

## Backlinks

### `buildBacklinksIndex(index: ContentIndex): Promise<Map<string, BacklinkRef[]>>`

Builds the backlinks map from the content index. Backlinks are now built automatically during content indexing (via `buildContentIndex`), so you seldom need this function directly. Use `getCachedBacklinksIndex` instead.

### `getCachedBacklinksIndex(index: ContentIndex): Promise<Map<string, BacklinkRef[]>>`

Returns the backlinks map for the given content index. When the index was built via `buildContentIndex` or `getCachedContentIndex`, backlinks are already populated — this is a simple property access with no I/O. A fallback cache handles indexes constructed manually.

```ts
import { getCachedContentIndex, getCachedBacklinksIndex } from "rspress-plugin-obsidian";

const index = await getCachedContentIndex("/path/to/docs");
const backlinks = await getCachedBacklinksIndex(index);
const refs = backlinks.get("/guide/getting-started") ?? [];
// refs: [{ routePath: "/guide/intro", title: "Introduction" }]
```

### `renderBacklinksHtml(refs: BacklinkRef[], mentions?: MentionRef[]): string`

Renders the backlink references as a `<div class="obsidian-backlinks">` HTML string. When `mentions` is non-empty, a second `<div class="obsidian-backlinks obsidian-unlinked-mentions">` section follows it, listing pages that name the current page without linking to it, each with its context snippet. Returns an empty string when both lists are empty.

## Mentions

Helpers behind `enableUnlinkedMentions`: finding pages that *name* another page without linking to it (Obsidian's "unlinked mentions").

### `getMentions(index: ContentIndex): Map<string, MentionRef[]>`

Returns unlinked mentions for every page, keyed by target route path. Only answers when the index was built with `unlinkedMentions: true`; otherwise the map is empty. Pages that also link to the target are dropped — a real link already appears in the backlinks panel.

```ts
import { getCachedContentIndex, getMentions } from "rspress-plugin-obsidian";

const index = await getCachedContentIndex("/path/to/docs", { unlinkedMentions: true });
const mentions = getMentions(index);
console.log(mentions.get("/guide/getting-started"));
// [{ routePath: "/inbox/idea", relativePath: "inbox/idea.md", title: "Idea", snippet: "…" }]
```

### `buildMentionsIndex(sources: MentionSource[]): Map<string, MentionRef[]>`

The low-level builder `getMentions` uses internally: matches each source's stripped `text` against every page name derived from its `page`. Names shorter than 3 characters and names shared by multiple pages are ignored, self-mentions are skipped, and each target keeps at most 20 mentions with a ±70-character snippet.

### `stripMentionText(markdown: string): string`

Strips frontmatter, fenced blocks, inline code, and comments from a note, leaving the prose that mention matching runs against.

## Tag Pages

### `generateTagPages(index: ContentIndex): AdditionalPage[]`

Generates one page entry per unique tag found across all pages. Each entry has the shape `{ routePath, content }` compatible with the Rspress `addPages` hook.

```ts
import { buildContentIndex, generateTagPages } from "rspress-plugin-obsidian";

const index = await buildContentIndex("/path/to/docs");
const pages = generateTagPages(index);
// [
//   { routePath: "/tags/tutorial", content: "---\ntitle: \"#tutorial\"\n---\n..." },
//   { routePath: "/tags/obsidian", content: "..." },
// ]
```

### `encodeTagPathSegment(tag: string): string`

Encodes a tag name for safe use in URL path segments. Preserves Unicode letters, hyphens, underscores, and nested-tag separators (`/`). Encodes whitespace, HTML-reserved, and URL-reserved characters.

```ts
import { encodeTagPathSegment } from "rspress-plugin-obsidian";

encodeTagPathSegment("hello world");  // "hello%20world"
encodeTagPathSegment("parent/child"); // "parent/child"
encodeTagPathSegment("中文");          // "中文"
```

## Types

### `RspressPluginMarkdownOptions`

All properties are optional. The defaults below are applied by
`markdown`.

```ts
interface RspressPluginMarkdownOptions {
  vaultRoot?: string;
  vaultRoutePrefix?: string;
  onBrokenLink?: DiagnosticMode;
  onAmbiguousLink?: DiagnosticMode;
  enableFuzzyMatching?: boolean;
  enableCaseInsensitiveLookup?: boolean;
  enableMarkdownLinks?: boolean;
  onDataviewError?: DiagnosticMode;
  onUnsupportedBlock?: DiagnosticMode;
  enableDataview?: boolean;
  enableDailyNotes?: boolean;
  dailyNotes?: DailyNotesOptions;
  enableTagLinking?: boolean;
  enableCallouts?: boolean;
  enableBacklinks?: boolean;
  enableUnlinkedMentions?: boolean;
  enableTransclusion?: boolean;
  enableMediaEmbeds?: boolean;
  enableTagPages?: boolean;
  enableMath?: boolean;
  mathEngine?: MathEngine;
  enableMermaid?: boolean;
  mermaidSecurityLevel?: MermaidSecurityLevel;
  enableDefaultStyles?: boolean;
}
```

`MermaidSecurityLevel` is `"strict" | "loose" | "antiscript" | "sandbox"`, and
`MathEngine` is `"katex" | "mathjax"`.

### `NormalizedPluginOptions`

The fully populated options object passed to the remark pipeline:

```ts
interface NormalizedPluginOptions {
  vaultRoot?: string;
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
}
```


### `DailyNotesOptions`

```ts
interface DailyNotesOptions {
  folder?: string;
  dateFormat?: string;
  navigation?: boolean;
  template?: string;
  calendar?: string;
}
```

### `ParsedWikiLink`

```ts
interface ParsedWikiLink {
  raw: string;
  target: string;
  alias?: string;
  isEmbed: boolean;
  subpath?: WikiSubpath;
  search?: "heading" | "block";
  isCurrentPageReference: boolean;
}
```

### `ContentAsset`

```ts
interface ContentAsset {
  absolutePath: string;
  relativePath: string;
  pathKey: string;
  baseName: string;
  urlPath: string;
}
```
### `WikilinkMatch`

The raw match metadata returned by `findWikilinkMatches` before parsing:

```ts
interface WikilinkMatch {
  fullMatch: string;
  inner: string;
  start: number;
  end: number;
}
```

`start` and `end` are JavaScript string offsets, with `end` exclusive.

### `DataviewTask`

```ts
interface DataviewTask {
  text: string;
  completed: boolean;
  line: number;
  path: string;
  fields: Record<string, unknown>;
}
```

### `DataviewListItem`

```ts
interface DataviewListItem {
  text: string;
  line: number;
  path: string;
  fields: Record<string, unknown>;
}
```


### `ContentPage`

```ts

interface ContentPage {
  absolutePath: string;        // Absolute file path on disk
  relativePath: string;        // Relative to docs root e.g. "guide/intro.md"
  routePath: string;           // Rspress route e.g. "/guide/intro"
  pathKey: string;             // Route-oriented key e.g. "guide/intro"
  filePathKey: string;         // Exact vault-relative key without ".md"
  baseName: string;            // Filename without extension e.g. "intro"
  title?: string;              // Frontmatter title
  aliases: string[];           // Frontmatter aliases
  tags: string[];              // Frontmatter tags
  cssclasses: string[];        // Frontmatter cssclasses
  excerpt?: string;            // Frontmatter excerpt
  publish: boolean;             // Frontmatter publish (default: true)
  fileCtimeMs: number;          // File creation time in milliseconds
  fileMtimeMs: number;          // File modification time in milliseconds
  fileSizeBytes: number;        // File size in bytes
  headings: HeadingEntry[];    // Parsed headings from the file
  wikilinkTargets: string[];   // Pre-extracted wikilink targets (used for backlinks)
  headingBySlug: Map<string, HeadingEntry>;   // Slug → heading, O(1) resolution
  headingByText: Map<string, HeadingEntry>;   // Normalized text → heading, O(1) resolution
  blocks: BlockEntry[];        // Parsed block IDs from the file
  dataviewFields: Record<string, unknown>; // Frontmatter and inline Dataview fields
  dataviewTasks: DataviewTask[];            // Tasks extracted for static Dataview queries
  dataviewLists: DataviewListItem[];        // List items extracted for static Dataview queries
}
```

### `ContentIndex`

```ts
interface ContentIndex {
  rootDir: string;
  pages: ContentPage[];
  assets: ContentAsset[];
  byAbsolutePath: Map<string, ContentPage>;
  byPathKey: Map<string, ContentPage>;          // Route-oriented lookup
  byFilePathKey: Map<string, ContentPage>;      // Exact vault-relative lookup
  byBaseName: Map<string, ContentPage[]>;
  byTitle: Map<string, ContentPage[]>;
  byAlias: Map<string, ContentPage[]>;
  byTag: Map<string, ContentPage[]>;
  byAssetPath: Map<string, ContentAsset>;
  byAssetBaseName: Map<string, ContentAsset[]>;
  byPathKeyCI: Map<string, ContentPage[]>;
  byFilePathKeyCI: Map<string, ContentPage[]>;
  byBaseNameCI: Map<string, ContentPage[]>;
  byAssetPathCI: Map<string, ContentAsset[]>;   // Case-insensitive exact asset lookup
  byAssetBaseNameCI: Map<string, ContentAsset[]>;
  backlinks: Map<string, BacklinkRef[]>;       // Pre-built during indexing
}
```

### `HeadingEntry`

```ts
interface HeadingEntry {
  rawText: string;          // Heading text (markdown formatting stripped)
  slug: string;             // GitHub-style slug
  explicitId?: string;      // Custom anchor from {#custom-anchor}
  preview?: string;         // Plain-text content snippet after heading (for tooltips)
}
```

### `BlockEntry`

```ts
interface BlockEntry {
  id: string; // Block ID without the leading ^
}
```

### `ResolveStatus`

```ts
type ResolveStatus =
  | "ok"
  | "broken-page"
  | "broken-anchor"
  | "ambiguous-page";
```

### `ResolvedWikiLink`

```ts
interface ResolvedWikiLink {
  status: ResolveStatus;
  href?: string;
  label?: string;
  targetPage?: ContentPage;
  message?: string;
  description?: string;
}
```

### `ResolveContext`

```ts
interface ResolveContext {
  currentPage: ContentPage;
  index: ContentIndex;
  options?: Partial<
    Pick<
      NormalizedPluginOptions,
      "enableFuzzyMatching" | "enableCaseInsensitiveLookup"
    >
  >;
}
```


### `BacklinkRef`

```ts
interface BacklinkRef {
  routePath: string;       // Route of the linking page
  relativePath?: string;   // Vault-relative source path (absent on hand-built refs)
  title: string;           // Title or basename of the linking page
}
```

### `MentionRef`

```ts
interface MentionRef {
  routePath: string;   // Route of the mentioning page
  relativePath: string; // Its vault-relative path
  title: string;       // Its panel label
  snippet: string;     // Plain text around the match, ±70 characters
}
```

### `MentionSource`

```ts
interface MentionSource {
  page: ContentPage; // The page doing the naming
  text: string;      // Its body, stripped of frontmatter and code
}
```

### `ContentIndexOptions`

```ts
interface ContentIndexOptions {
  routePrefix?: string;     // Prefix for emitted route paths. Default: ""
  unlinkedMentions?: boolean; // Retain page text for getMentions. Default: false
}
```

### `DiagnosticMode`

```ts
type DiagnosticMode = "error" | "warn";
```

### `WikiSubpath`

```ts
interface WikiSubpath {
  kind: "heading" | "block";
  value: string; // Heading text or block ID (without ^)
}
```

### `AdditionalPage`

```ts
interface AdditionalPage {
  routePath: string; // e.g. "/tags/tutorial"
  content: string;   // Raw markdown content for the generated page
}
```

