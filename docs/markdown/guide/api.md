---
title: API Reference
description: Every markdown() option with its type and default, plus the helpers and types the rspress-plugin-obsidian/markdown entry exports for building your own pipeline.
---

# API Reference

This page lists every option `markdown()` accepts, then the helpers and types
for building your own pipeline. To learn how a feature works, read its guide.
Come here when you need an option's exact name, type or default.

The package root, `rspress-plugin-obsidian`, exports the three plugins,
`pluginObsidian` and the types of their options. The helpers and the index
types below come from the Markdown feature's own entry,
`rspress-plugin-obsidian/markdown`.

## Options

`markdown()` takes one optional object of type `RspressPluginMarkdownOptions`,
and every field in it is optional. Some syntax is always on:
wikilinks, embeds, heading and block links, `==highlights==`, `%%comments%%`,
footnotes and Markdown links to notes. Everything else stays off until you
turn it on.

```ts
import { defineConfig } from "@rspress/core";
import { markdown } from "rspress-plugin-obsidian";

export default defineConfig({
  plugins: [
    markdown({
      vaultRoot: "./vault",
      enableCallouts: true,
      enableTransclusion: true,
      enableMediaEmbeds: true,
      enableDefaultStyles: true,
    }),
  ],
});
```

To combine Markdown with Canvas and Graph View, register all three through
`pluginObsidian`. Its optional first argument takes the options every feature
shares, `vaultRoot` and `vaultRoutePrefix`, so the vault is named once:
`pluginObsidian({ vaultRoot }, (markdown, canvas, graphview) => [...])`. An
option passed to `markdown()` itself wins over the shared one. The options
below are the same either way.

### Vault and routes

| Option | Type | Default | What it does |
|--------|------|---------|--------------|
| `vaultRoot` | `string` | unset | Path to an Obsidian vault, published alongside `docs/`. A relative path resolves from the working directory. When unset, the plugin publishes only the docs directory. See [Publishing a vault](./advanced.md#publishing-a-vault). |
| `vaultRoutePrefix` | `string` | `"/vault"` | Route prefix for vault pages and attachments. `Notes/Setup.md` publishes at `/vault/Notes/Setup`. If you use Canvas, its `fileRoutePrefix` must match this value; set both at once with `pluginObsidian`'s shared `vaultRoutePrefix`. |

### Link resolution

| Option | Type | Default | What it does |
|--------|------|---------|--------------|
| `enableMarkdownLinks` | `boolean` | `true` | Resolves `[label](Note.md)` links and `![alt](Note.md)` embeds the same way it resolves wikilinks. When `false`, Rspress handles Markdown links itself. |
| `enableCaseInsensitiveLookup` | `boolean` | `true` | Falls back to a case-insensitive path or file-name match, as Obsidian does. Set it to `false` for strict matching. |
| `enableFuzzyMatching` | `boolean` | `false` | Adds a last resort: any page whose path ends with the target, ignoring case. |

The order the plugin tries these in is described in
[How a link resolves](./link-resolution.md#how-a-link-resolves).

### Diagnostics

Each of these options takes a `DiagnosticMode`, which is `"error" | "warn"`.
`"error"` fails the build. `"warn"` prints a warning and continues.

| Option | Default | What it reports |
|--------|---------|-----------------|
| `onBrokenLink` | `"error"` | A wikilink, Markdown link or image whose file, heading or block does not exist. With `"warn"`, the link renders as unresolved text instead of a link. |
| `onAmbiguousLink` | `"warn"` | A name that several files share. Either way the link resolves the way Obsidian picks, and the message lists the alternatives. |
| `onDataviewError` | `"error"` | A Dataview query or inline expression that does not parse or evaluate. |
| `onUnsupportedBlock` | `"warn"` | A `tasks`, `base`, `excalidraw`, `dataview` or `dataviewjs` fence whose feature is off. The block stays on the page as code, and the message names the option that turns the feature on. |
| `onPluginError` | `"error"` | A Tasks, Kanban, Excalidraw, Bases or Templater block that cannot render. The error is shown in place either way. |

For what each message looks like and how to work through a first build, see
[Diagnostics](./advanced.md#diagnostics).

### Features

| Option | Type | Default | What it does |
|--------|------|---------|--------------|
| `enableCallouts` | `boolean` | `false` | Turns `> [!note]` blockquotes into callouts, foldable with `+` or `-`. See [Callouts](./callouts.md). |
| `enableTransclusion` | `boolean` | `false` | `![[Note]]`, `![[Note#Heading]]` and `![[Note#^block]]` insert the target's content. See [Transclusion](./transclusion.md). |
| `enableMediaEmbeds` | `boolean` | `false` | `![[file]]` renders images, audio, video and PDFs as native elements. Markdown-image embeds of audio, video, PDFs, YouTube and X do the same. See [Media Embeds](./media-embeds.md). |
| `enableBacklinks` | `boolean` | `false` | Adds a panel to each page listing the pages that link to it. See [Backlinks](./backlinks.md). |
| `enableUnlinkedMentions` | `boolean` | `false` | Also lists pages that name this page without linking to it. Setting it turns on `enableBacklinks`. |
| `enableTagLinking` | `boolean` | `false` | Turns inline `#tag` into a link to `/tags/<tag>`. See [Tags & Daily Notes](./tags-and-daily-notes.md). |
| `enableTagPages` | `boolean` | `false` | Generates a `/tags/<tag>` page for every tag in the docs and the vault. |
| `enableDailyNotes` | `boolean` | `false` | Treats date-named notes as daily notes: previous/next navigation, plus optional template and calendar. |
| `dailyNotes` | `DailyNotesOptions` | see [below](#dailynotes) | Folder, file-name format, navigation, template and calendar for daily notes. |
| `enableDataview` | `boolean` | `false` | Evaluates `dataview` and `dataviewjs` blocks and inline queries at build time. See [Dataview](./dataview.md). |
| `enableMath` | `boolean` | `false` | Renders `$inline$` and `$$display$$` math. See [Math](./advanced.md#math). |
| `mathEngine` | `"katex" \| "mathjax"` | `"katex"` | Picks the math engine. `"mathjax"` needs the optional `mathjax-full` package. |
| `enableMermaid` | `boolean` | `false` | Draws ` ```mermaid ` fences as diagrams in the browser. Needs the optional `mermaid` package. See [Mermaid](./advanced.md#mermaid-diagrams). |
| `mermaidSecurityLevel` | `"strict" \| "loose" \| "antiscript" \| "sandbox"` | `"strict"` | Mermaid's `securityLevel` for diagrams in notes. `"strict"` sanitizes the SVG and drops unsafe link URLs. |

#### `dailyNotes`

| Key | Type | Default | What it does |
|-----|------|---------|--------------|
| `folder` | `string` | `""` (the root) | Folder of daily notes, relative to the vault or docs root. |
| `dateFormat` | `string` | `"YYYY-MM-DD"` | Moment.js format that daily-note file names follow. |
| `navigation` | `boolean` | `true` | Adds previous/next links to each daily note. |
| `template` | `string` | unset | Note whose content fills a daily note that is still empty. |
| `calendar` | `string` | unset | Route of a generated page that lists every daily note by month, such as `"/daily"`. |

### Obsidian plugins

Each plugin has an `enable*` switch and an options object. The guide for each
plugin documents every key of its object, including the vault setting the key
overrides.

| Option | Type | Default | What it does |
|--------|------|---------|--------------|
| `enableTasks` | `boolean` | `false` | Runs ` ```tasks ` queries over every task on the site. |
| `tasks` | `TasksOptions` | `{}` | See [Tasks options](./tasks.md#options). |
| `enableKanban` | `boolean` | `false` | Publishes Kanban boards as read-only boards. |
| `kanban` | `KanbanOptions` | `{}` | See [Kanban options](./kanban.md#options). |
| `enableExcalidraw` | `boolean` | `false` | Renders Excalidraw drawings, as pages and as embeds, as static SVG. |
| `excalidraw` | `ExcalidrawOptions` | `{}` | See [Excalidraw options](./excalidraw.md#options). |
| `enableBases` | `boolean` | `false` | Renders `.base` files as pages, along with `![[x.base]]` embeds and ` ```base ` blocks. |
| `bases` | `BasesOptions` | `{}` (pages under `/bases`) | See [Bases options](./bases.md#options). |
| `enableTemplater` | `boolean` | `false` | Runs Templater templates and `<% %>` commands at build time. |
| `templater` | `TemplaterOptions` | `{}` | See [Templater options](./templater.md#options). |

When one of these blocks fails, `onPluginError` decides what happens. When a
block's plugin is off, `onUnsupportedBlock` decides.

### Styling and rendering

| Option | Type | Default | What it does |
|--------|------|---------|--------------|
| `enableDefaultStyles` | `boolean` | `false` | Adds the bundled stylesheet through Rspress `globalStyles`. Callouts, backlinks, tag pages, embeds and the plugin layouts emit markup only, so they look unstyled without it. See [Styles](./advanced.md#styles). |
| `strictLineBreaks` | `boolean` | unset | Obsidian's "Strict line breaks". When unset, vault pages render a single newline as `<br>` (Obsidian's default) and docs pages keep CommonMark. `false` gives every page `<br>`, and `true` gives none. |

## Remark plugin

### `remarkWikilink(options: RemarkWikiLinkPluginOptions)`

`remarkWikilink` is the remark pass that `markdown()` runs. Use it only to
compose your own unified pipeline; for an Rspress site, use `markdown()`.
Register it with `.use(remarkWikilink, options)` after `remark-gfm`, because
footnotes and tables depend on GFM. When attached, it adds the Obsidian syntax
(`[[…]]`, `![[…]]`, `==…==`, and `$…$` when `enableMath` is on) to the parser.

It takes the plugin's runtime context:

- `getDocsRoot(filePath?)`: the content root that a file belongs to.
- `getContentIndex(filePath)` (optional): the index for that file.
- `getPublishedIndexes()` (optional): every published index, read by Tasks and Bases.
- `getSiteBase()` (optional): the site `base`, used to build media URLs.
- `getKatexStylesheetHref()` (optional): where KaTeX's stylesheet is served. When unset, pages link no KaTeX stylesheet.
- `getCanvasBoards()` (optional): a promise of the boards the site's
  `canvas()` plugin published, so `[[Board.canvas]]` links to the board's
  viewer route and `![[Board.canvas]]` renders `<CanvasEmbed>`. It settles
  once the canvas scan running beside it has finished. `markdown()` sets it
  from the canvas plugin listed in the same site, and then a `.canvas` file
  that plugin did not publish is a broken link rather than an attachment.
  When unset, a board link is a plain attachment link.
- `options`: a complete `NormalizedPluginOptions`. This is every option above
  with its default filled in, `vaultRoot` made absolute, and `dailyNotes` fully
  populated.

## Content index

### `buildContentIndex(rootDir: string, options?: ContentIndexOptions): Promise<ContentIndex>`

Scans every `.md` and `.mdx` file under `rootDir` and builds the lookup index.
It rescans on every call. The scan skips hidden files and folders,
`node_modules`, `_`-prefixed paths, symlinks and `publish: false` notes.

| `ContentIndexOptions` field | Type | Default | What it does |
|-------|------|---------|-------------|
| `routePrefix` | `string` | `""` | Prefix added to every page and attachment route. |
| `unlinkedMentions` | `boolean` | `false` | Keeps a stripped copy of each page body so `getMentions` can find pages that name another page. |

```ts
import { buildContentIndex } from "rspress-plugin-obsidian/markdown";

const index = await buildContentIndex("/path/to/docs");
console.log(index.pages.length);
console.log(index.byTag.get("tutorial"));
```

### `getCachedContentIndex(rootDir: string, options?: ContentIndexOptions): Promise<ContentIndex>`

Works like `buildContentIndex`, but returns the cached index while no file's
modification time or size has changed. The options are part of the cache key.
Prefer it in code that runs often.

### `extractPageLinks(markdown: string): PageLinks`

Returns the links and tags that one note contains. `outlinks` holds every link
as a `ParsedWikiLink`: wikilinks and embeds, relative Markdown links and
images, reference definitions, `obsidian://open` URIs, and wikilinks in
frontmatter properties. `tags` holds frontmatter and inline tags without the
`#`. Backlinks and attachment publishing resolve the same list.

## Wikilinks

### `findWikilinkMatches(input: string): WikilinkMatch[]`

Finds every wikilink and embed in a string.

```ts
import { findWikilinkMatches } from "rspress-plugin-obsidian/markdown";

const matches = findWikilinkMatches("Check [[Page1]] and ![[Page2|Embed]].");
// matches[0] → { fullMatch: "[[Page1]]", inner: "Page1", start: 6, end: 15 }
// matches[1] → { fullMatch: "![[Page2|Embed]]", inner: "Page2|Embed", start: 20, end: 36 }
```

`start` and `end` are string offsets, and `end` is exclusive.

### `parseWikiLink(inner: string, raw: string): ParsedWikiLink`

Splits a wikilink into its target, alias and subpath.

```ts
import { parseWikiLink } from "rspress-plugin-obsidian/markdown";

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

### `resolveWikiLink(parsed: ParsedWikiLink, context: ResolveContext): ResolvedWikiLink`

Resolves a parsed wikilink against an index, following the same steps as the
plugin. On a miss in `context.index`, it tries `context.fallbackIndexes`
(by default, `index.linkedIndexes`). Case-insensitive and fuzzy lookups run only
when you turn them on in `context.options`. The plugin turns case-insensitive
lookup on by default, but this function does not.

```ts
import {
  buildContentIndex,
  findWikilinkMatches,
  parseWikiLink,
  resolveWikiLink,
} from "rspress-plugin-obsidian/markdown";

const index = await buildContentIndex("/path/to/docs");
const currentPage = index.byPathKey.get("guide/intro")!;

const [match] = findWikilinkMatches("See [[getting-started]].");
const parsed = parseWikiLink(match.inner, match.fullMatch);
const resolved = resolveWikiLink(parsed, {
  currentPage,
  index,
  options: { enableCaseInsensitiveLookup: true },
});

if (resolved.status === "ok") {
  console.log(resolved.href);  // "/guide/getting-started"
  console.log(resolved.label); // "getting-started", the target as typed
}
```

## Backlinks and mentions

### `getCachedBacklinksIndex(index: ContentIndex): Promise<Map<string, BacklinkRef[]>>`

Returns the backlinks map, keyed by target route. Indexing builds backlinks, so
for an index from `buildContentIndex` or `getCachedContentIndex` this call just
reads a property. Indexes you build by hand go through a fallback cache.

```ts
import { getCachedBacklinksIndex, getCachedContentIndex } from "rspress-plugin-obsidian/markdown";

const index = await getCachedContentIndex("/path/to/docs");
const backlinks = await getCachedBacklinksIndex(index);
const refs = backlinks.get("/guide/getting-started") ?? [];
// [{ routePath: "/guide/intro", relativePath: "guide/intro.md", title: "Introduction" }]
```

### `buildBacklinksIndex(index: ContentIndex): Promise<Map<string, BacklinkRef[]>>`

Rebuilds the backlinks map from scratch. You rarely need it; use
`getCachedBacklinksIndex`.

### `renderBacklinksHtml(refs: BacklinkRef[], mentions?: MentionRef[]): string`

Renders the backlinks panel as `<div class="obsidian-backlinks">`. When
`mentions` is not empty, a second `obsidian-unlinked-mentions` panel follows,
with a snippet for each mention. Returns `""` when both lists are empty.

### `getMentions(index: ContentIndex): Map<string, MentionRef[]>`

Returns unlinked mentions for every page, keyed by target route. The index must
be built with `unlinkedMentions: true`; otherwise the map is empty. A page that
also links to the target appears only as a backlink, not as a mention.

```ts
import { getCachedContentIndex, getMentions } from "rspress-plugin-obsidian/markdown";

const index = await getCachedContentIndex("/path/to/docs", { unlinkedMentions: true });
console.log(getMentions(index).get("/guide/getting-started"));
// [{ routePath: "/inbox/idea", relativePath: "inbox/idea.md", title: "Idea", snippet: "…" }]
```

### `buildMentionsIndex(sources: MentionSource[]): Map<string, MentionRef[]>`

The builder behind `getMentions`. It matches each source's `text` against
every page name. Names shorter than 3 characters are ignored, as are names
that several pages share, and so are self-mentions. Each target keeps at most
20 mentions, each with a snippet of ±70 characters.

### `stripMentionText(markdown: string): string`

Removes frontmatter, fenced code, inline code and comments from a note, leaving
the prose that mention matching reads.

## Tag pages

### `generateTagPages(index: ContentIndex): AdditionalPage[]`

Returns one `{ routePath, content }` page per tag, in the shape that the Rspress
`addPages` hook expects.

```ts
import { buildContentIndex, generateTagPages } from "rspress-plugin-obsidian/markdown";

const index = await buildContentIndex("/path/to/docs");
const pages = generateTagPages(index);
// [{ routePath: "/tags/tutorial", content: "---\ntitle: \"#tutorial\"\n---\n..." }, ...]
```

### `encodeTagPathSegment(tag: string): string`

Encodes a tag for use in a URL path. It keeps Unicode letters, `-`, `_` and the
nested-tag `/`, and encodes whitespace and reserved characters.

```ts
import { encodeTagPathSegment } from "rspress-plugin-obsidian/markdown";

encodeTagPathSegment("hello world");  // "hello%20world"
encodeTagPathSegment("parent/child"); // "parent/child"
encodeTagPathSegment("中文");          // "中文"
```

## Daily notes

These helpers take a daily-note config shaped like `dailyNotes`, with every
field filled in (`folder`, `dateFormat`, `navigation`, `template`,
`calendar`). The module calls that shape `DailyNoteConfig`, but the package
does not export the name; use `normalizeDailyNoteConfig` to build one. The
template and calendar pages are built by the plugin, not by these helpers.

### `normalizeDailyNoteConfig(config?: Partial<DailyNoteConfig>): DailyNoteConfig`

Fills in the defaults listed in [`dailyNotes`](#dailynotes) and trims leading and
trailing slashes from `folder` and `template`.

```ts
import { normalizeDailyNoteConfig } from "rspress-plugin-obsidian/markdown";

const config = normalizeDailyNoteConfig({ folder: "Daily" });
```

### `parseDailyNoteDate(relativePath: string, config: DailyNoteConfig): Date | undefined`

Reads the local date from a daily-note path. Returns `undefined` when the path
is outside the folder, does not match the format, or names a date that does not
exist, such as `2026-02-30`.

### `formatDailyNoteDate(date: Date, format: string): string`

Formats a local date with Moment.js tokens (`YYYY`, `MM`, `Do`, `dddd`, `ww`,
`W`, `gggg`, `HH`, `mm`, `A`, `[literal]`, …).

```ts
import { formatDailyNoteDate } from "rspress-plugin-obsidian/markdown";

formatDailyNoteDate(new Date(2026, 0, 5), "dddd, MMMM Do YYYY"); // "Monday, January 5th 2026"
```

### `expandDailyTemplateText(value: string, date: Date, format?: string, now?: Date): string`

Expands `{{date}}`, `{{time}}` and `{{date|time±N unit:FORMAT}}` the same way
Obsidian's daily-notes core expands a template. Dates render in `format`
(`YYYY-MM-DD` by default) at the time of day of `now`. `{{time}}` renders `now`
as `HH:mm`.

### `renderDailyNavigation(currentPage: ContentPage, pages: ContentPage[], config: DailyNoteConfig): string`

Renders the previous/current/next navigation HTML. Returns `""` when navigation
is off or the page is not a daily note.

## Dataview

These helpers evaluate queries with the Dataview plugin's semantics. DataviewJS
runs through a restricted interpreter, not a JavaScript engine; see
[Dataview](./dataview.md#dataviewjs).

### `extractDataviewMetadata(markdown: string, frontmatter: Record<string, unknown>, filePath: string)`

Returns `{ fields, tasks, lists }`: the note's fields (frontmatter and inline),
its `DataviewTask[]`, and its `DataviewListItem[]`.

### `renderDataviewQuery(query: string, currentPage: ContentPage, index: ContentIndex, dailyConfig?: DailyNoteConfig, settings?: DataviewSettings): { html?: string; error?: string }`

Evaluates a `TABLE`, `LIST`, `TASK` or `CALENDAR` query that is written on
`currentPage`, which acts as `this`. Returns `html`, or `error` for an invalid
query, including one with leftover text after a clause. `settings.now` fixes
the clock that `date(today)` reads. `settings.resolve` sets the
link-resolution options; case-insensitive lookup is on by default.

### `renderDataviewInline(expression: string, currentPage: ContentPage, index: ContentIndex, dailyConfig?: DailyNoteConfig, settings?: DataviewSettings): { html?: string; error?: string }`

Evaluates the `expr` of one `` `= expr` `` inline query with only `this` in
scope, as Dataview does. Returns a `<span>` or an `error`.

## Types

All of these are exported as types from `rspress-plugin-obsidian/markdown`.
The declarations ship with doc comments in `dist/markdown/index.d.ts`, so your
editor shows the same information. The option types —
`RspressPluginMarkdownOptions`, `DailyNotesOptions`, `DiagnosticMode` and the
plugin option objects — are exported from the package root as well.

`RspressPluginMarkdownOptions` is the options object described in
[Options](#options). `NormalizedPluginOptions` is the same object with every
default applied. `DailyNotesOptions` is the [`dailyNotes`](#dailynotes) object,
and `DiagnosticMode` is `"error" | "warn"`.

### `ParsedWikiLink` and `WikiSubpath`

```ts
interface ParsedWikiLink {
  raw: string;                     // Source text, including [[ ]] or ![[ ]]
  target: string;
  alias?: string;                  // Text after |
  isEmbed: boolean;                // ![[…]]
  subpath?: WikiSubpath;           // After #
  search?: "heading" | "block";    // [[##query]] or [[^^query]]
  isCurrentPageReference: boolean; // [[#Heading]]
}

interface WikiSubpath {
  kind: "heading" | "block";
  value: string;                   // Heading text or block id (no ^)
}

interface WikilinkMatch {
  fullMatch: string;
  inner: string;
  start: number;
  end: number;                     // Exclusive
}
```

### `ResolveContext` and `ResolvedWikiLink`

```ts
interface ResolveContext {
  currentPage: ContentPage;
  index: ContentIndex;
  fallbackIndexes?: ContentIndex[]; // Default: index.linkedIndexes
  options?: Partial<
    Pick<NormalizedPluginOptions, "enableFuzzyMatching" | "enableCaseInsensitiveLookup">
  > & {
    canvasBoards?: CanvasBoards; // The site's published boards; unset, a board is an attachment
  };
}

type ResolveStatus = "ok" | "broken-page" | "broken-anchor" | "ambiguous-page";

interface ResolvedWikiLink {
  status: ResolveStatus;
  href?: string;
  label?: string;                  // Obsidian's display text
  targetPage?: ContentPage;
  targetAsset?: ContentAsset;      // When the target is an attachment
  message?: string;                // Why it failed
  description?: string;            // Heading preview, for tooltips
  ambiguity?: string;              // Set when several files shared the name
  candidates?: WikiLinkCandidate[]; // A vault search with several matches
  canvasSrc?: string;              // A published canvas board
  fileRoute?: PublishedFileRoute;  // A .base or .excalidraw page
}
```

### `ContentIndex`

```ts
interface ContentIndex {
  rootDir: string;
  routePrefix?: string;            // vaultRoutePrefix for the vault, "" for docs
  pages: ContentPage[];
  assets: ContentAsset[];
  byAbsolutePath: Map<string, ContentPage>;
  byPathKey: Map<string, ContentPage>;       // Route-oriented key
  byFilePathKey: Map<string, ContentPage>;   // Exact vault-relative key
  byBaseName: Map<string, ContentPage[]>;
  byTitle: Map<string, ContentPage[]>;
  byAlias: Map<string, ContentPage[]>;
  byTag: Map<string, ContentPage[]>;
  byAssetPath: Map<string, ContentAsset>;
  byAssetBaseName: Map<string, ContentAsset[]>;
  byPathKeyCI: Map<string, ContentPage[]>;   // CI = case-insensitive
  byFilePathKeyCI: Map<string, ContentPage[]>;
  byBaseNameCI: Map<string, ContentPage[]>;
  byAssetPathCI: Map<string, ContentAsset[]>;
  byAssetBaseNameCI: Map<string, ContentAsset[]>;
  backlinks: Map<string, BacklinkRef[]>;     // Built during indexing
  linkedIndexes?: ContentIndex[];            // The other tree on the site
}
```

### `ContentPage`

```ts
interface ContentPage {
  absolutePath: string;
  relativePath: string;            // "guide/intro.md"
  routePath: string;               // "/guide/intro"
  pathKey: string;                 // "guide/intro"; may drop a trailing index
  filePathKey: string;             // Vault-relative path without the extension
  baseName: string;                // "intro"
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
  wikilinkTargets: string[];
  outlinks?: ParsedWikiLink[];     // Every link the page makes
  headingBySlug: Map<string, HeadingEntry>;
  headingByText: Map<string, HeadingEntry>;
  blocks: BlockEntry[];            // { id } without the ^
  dataviewFields: Record<string, unknown>;
  dataviewTasks: DataviewTask[];
  dataviewLists: DataviewListItem[];
}

interface HeadingEntry {
  rawText: string;                 // Text as rendered
  slug: string;
  explicitId?: string;             // From {#custom-id}
  depth?: number;                  // 1–6
  sourceText?: string;             // Inline Markdown as written
  preview?: string;                // First ~200 characters of the section
}

interface ContentAsset {
  absolutePath: string;
  relativePath: string;
  pathKey: string;
  baseName: string;
  urlPath: string;
}
```

### `DataviewListItem` and `DataviewTask`

```ts
interface DataviewListItem {
  text: string;
  line: number;                    // Zero-based
  lineCount: number;
  path: string;
  fields: Record<string, unknown>;
  symbol: string;                  // "-", "*", "1." …
  parent?: number;                 // line of the parent item
  children: number[];
  section?: string;                // Nearest heading above
  tags: string[];
  status?: string;                 // Checkbox character, on tasks
}

interface DataviewTask extends DataviewListItem {
  status: string;
  completed: boolean;              // Only for x / X
  fullyCompleted: boolean;         // Completed, with every subtask
}
```

### Backlink, mention and page types

```ts
interface BacklinkRef {
  routePath: string;
  relativePath?: string;           // Absent on hand-built refs
  title: string;
}

interface MentionRef {
  routePath: string;
  relativePath: string;
  title: string;
  snippet: string;                 // ±70 characters around the match
}

interface MentionSource {
  page: ContentPage;
  text: string;                    // Body without frontmatter or code
}

interface AdditionalPage {
  routePath: string;               // "/tags/tutorial"
  content: string;                 // Markdown of the generated page
}
```
