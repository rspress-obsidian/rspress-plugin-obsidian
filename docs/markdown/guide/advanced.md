---
description: Complete configuration reference for rspress-plugin-obsidian. Covers all options, callout types and aliases, transclusion, media embeds, highlights, footnotes, comments, link resolution rules, and frontmatter fields.
---

# Advanced

## All Configuration Options

```ts
markdown({
  // Where content comes from
  vaultRoot: undefined,               // absolute path to an external Obsidian vault
  vaultRoutePrefix: "/vault",         // route prefix for published vault pages

  // Link diagnostics
  onBrokenLink: "error",              // "error" | "warn" (default: "error")
  onAmbiguousLink: "error",           // "error" | "warn" (default: "error")
  onDataviewError: "error",           // "error" | "warn" (default: "error")
  onUnsupportedBlock: "warn",         // "error" | "warn" (default: "warn")

  // Resolution
  enableFuzzyMatching: false,         // shortest-suffix path fallback
  enableCaseInsensitiveLookup: true,  // case-insensitive path lookup (default)
  enableMarkdownLinks: true,          // [x](Page.md) resolved like wikilinks

  // Content features
  enableTagLinking: false,            // #tag → /tags/tag
  enableTagPages: false,              // generate /tags/{name} index pages
  enableCallouts: false,              // > [!note] → styled HTML
  enableBacklinks: false,             // append backlinks panel
  enableUnlinkedMentions: false,      // pages that name this one without linking
  enableTransclusion: false,          // ![[Page]] → inline content
  enableMediaEmbeds: false,           // ![[img.png]] → <img>
  enableDataview: false,              // ```dataview blocks + inline = expr
  enableDailyNotes: false,            // date-filed notes + navigation
  dailyNotes: undefined,              // { folder, dateFormat, navigation, template, calendar }
  enableMath: false,                  // $inline$ / $$display$$ → KaTeX
  mathEngine: "katex",                // "katex" | "mathjax"
  enableMermaid: false,               // ```mermaid fences → diagrams
  mermaidSecurityLevel: "strict",     // Mermaid's own sanitising level

  // Styling
  enableDefaultStyles: false,         // inject bundled CSS
});
```

### `vaultRoot`

Absolute path to an Obsidian vault published alongside the Rspress `docs/`
directory. When set, every routable `.md`/`.mdx` file in the vault becomes a
page under `vaultRoutePrefix`, with the full pipeline applied. Unset (the
default) means the docs directory is the only source.

The vault is indexed **separately** from the docs root: wikilinks inside vault
pages resolve against vault files, and wikilinks inside normal docs pages are
unaffected. A `[[wikilink]]` in the vault cannot therefore name a docs page —
reach one by its published route.

```ts
markdown({
  vaultRoot: "./Obsidian Vault",
  vaultRoutePrefix: "/vault",
  enableTransclusion: true,
  enableMediaEmbeds: true,
  enableBacklinks: true,
});
```

### `vaultRoutePrefix`

Route prefix published vault pages sit under. Default `"/vault"`. If the canvas
feature also publishes boards, its `fileRoutePrefix` must name the same prefix
so a canvas file card links to `/vault/Note` rather than `/Note`.

### `onBrokenLink`

Controls how the plugin handles links to non-existent pages or headings:

- `"error"` (default) — fail the build when a link target is missing
- `"warn"` — emit a warning and render the link's label as an unresolved marker (`<span class="obsidian-unresolved">`) instead of a link

### `onDataviewError`

Controls how a `dataview` block that will not evaluate is handled:

- `"error"` (default) — fail the build
- `"warn"` — emit a warning and leave the block as code

### `onUnsupportedBlock`

Reports fences belonging to a plugin runtime this plugin cannot run — `tasks`,
`excalidraw`, `base`, `kanban`, `dataviewjs`, and `dataview` while
`enableDataview` is off. They stay published as code either way.

- `"warn"` (default) — report and continue
- `"error"` — fail the build

### `onAmbiguousLink`

Controls how the plugin handles ambiguous links (multiple pages share the same basename):

- `"error"` (default) — fail the build when multiple pages match
- `"warn"` — emit a warning and render the label as an unresolved marker

### `enableFuzzyMatching`

- `false` (default) — no suffix fallback: lookups stop after exact path, basename, title, alias, and (when `enableCaseInsensitiveLookup` is on) case-insensitive matches
- `true` — additionally tries a shortest-suffix path match, so a unique `guide/setup.md` can resolve `[[setup]]`

### `enableCaseInsensitiveLookup`

- `true` (default) — falls back to case-insensitive matching when exact case fails; matches Obsidian, which resolves links to existing files case-insensitively
- `false` — strict case-sensitive path/basename lookups

### `enableMarkdownLinks`

- `true` (default) — standard markdown links to vault pages (`[label](Page.md)`, including `#anchors` and `./relative.md` forms) resolve through the same ladder as wikilinks, matching Obsidian's acceptance of both link forms
- `false` — markdown links are left to Rspress's own handling

Only `.md` / `.mdx` destinations are considered; external URLs, pure `#anchors`, and extensionless routes are untouched. The embed form `![alt](note.md)` transcludes like `![[note]]` when `enableTransclusion` is on and renders as a styled link otherwise.

**Dead-link gate.** Rspress resolves `[](x.md)` relative to the current page and
fails the build on misses — before plugin remark plugins can resolve
vault-style basename links. When this option is on, the plugin therefore
rewrites `markdown.link.checkDeadLinks` to exempt exactly the `.md`/`.mdx`
destinations it resolves itself (`{ excludes: … }`) rather than switching the
gate off (an explicit setting in your Rspress config wins). Rspress keeps
checking everything else — extensionless routes, anchors, queries and external
URLs — so a broken `[x](../missing.md)` is still reported, now by the plugin
through `onBrokenLink`, while a broken `/typo-route` is still reported by
Rspress.

### `enableTagLinking`

- `false` (default) — tags are left as-is in the output
- `true` — converts `#tag` to `[#tag](/tags/tag)`; skips code blocks and URL fragments

A tag links only when its name contains at least one character that is not a digit, slash, or hyphen — `#123` and `#2024/12` stay plain text, while `#1a` and `#2024-report` link. Nested tags (`#parent/child`) and Unicode letters (Latin extended, CJK) are supported.

### `enableTagPages`

- `false` (default) — no tag pages generated
- `true` — auto-generates a `/tags/{name}` index page for every unique tag found across pages: frontmatter `tags:` fields **and** inline `#tags` in body text. Nested tags also get an index page for each parent segment (`#parent/child` generates `/tags/parent/child` and `/tags/parent`).

Each generated page lists all pages with that tag:

```yaml
---
tags:
  - tutorial
  - obsidian
---
```

Produces `/tags/tutorial` and `/tags/obsidian`, each listing all pages tagged with that value.

> **Note**: combine with `enableTagLinking: true` so that inline `#tag` links point to the generated pages.

### `enableCallouts`

- `false` (default) — Obsidian callouts remain as plain blockquotes
- `true` — transforms callouts to styled HTML `<div>` (static) or `<details>` (foldable)

**Supported base types:**

| Type | Visual treatment |
|------|------------------|
| `note` | Blue accent |
| `tip` | Teal accent |
| `info` | Cyan accent |
| `todo` | Blue accent |
| `success` | Green accent |
| `question` | Lime accent |
| `warning` | Orange accent |
| `danger` | Red accent |
| `bug` | Pink accent |
| `example` | Purple accent |
| `quote` | Neutral accent |
| `abstract` | Cyan accent |
| `caution` | Orange accent |
| `failure` | Red accent |

Any other type (or `details`, restored from Rspress's alert transform) keeps its own `callout-<type>` class and falls back to Obsidian's `note` styling — the blue card and pencil glyph — not to a neutral placeholder. Add a rule to give it its own colour and icon; see [Callouts](./callouts#custom-callout-types).

**Supported aliases** (map to canonical type above):

| Aliases | Canonical |
|---------|-----------|
| `summary`, `tldr` | `abstract` |
| `check`, `done` | `success` |
| `help`, `faq` | `question` |
| `hint`, `important` | `tip` |
| `attention` | `caution` |
| `failure`, `fail`, `missing` | `failure` |
| `error` | `danger` |
| `cite` | `quote` |

**Static callout:**
```markdown
> [!failure] Watch out
> This will be transformed.
```

Output:
```html
<div class="callout callout-failure" data-callout="failure">
  <div class="callout-title">Watch out</div>
  <div class="callout-content">This will be transformed.</div>
</div>
```

**Foldable callouts** use native `<details>`/`<summary>` — no JavaScript required:

```markdown
> [!success]- Collapsed by default
> Hidden until the user clicks.

> [!example]+ Expanded by default
> Visible immediately, but collapsible.
```

**Callout titles are inline markdown.** Bold, italics, code, and wikilinks
render inside the title, matching Obsidian:

```markdown
> [!question] See [[guide/getting-started|Getting Started]] for **setup**
> Body text
```

**Rspress built-in alert conflict — resolved automatically.** Rspress
registers its own GitHub-style alert transform before plugin remark plugins
run, so `> [!note]`, `[!tip]`, `[!warning]`, `[!caution]`, `[!danger]`,
`[!info]`, and `[!details]` blockquotes arrive already converted — with
Obsidian's fold suffix (`[!note]-`) leaked into the content and the first
paragraph of multi-paragraph alerts dropped. When `enableCallouts` is on, the
plugin detects those converted nodes, verifies them against the original
source via position information, restores the original blockquotes, and
renders every Obsidian callout type with full semantics. Standard `:::note`
directive containers keep Rspress's native styling.

### `enableBacklinks`

- `false` (default) — no backlinks appended
- `true` — scans all pages for incoming links and appends a `<div class="obsidian-backlinks">` panel at the bottom of each page

The backlinks index is built during content indexing and stored on the `ContentIndex` object. No extra file reads or regex scans are needed at build time.

### `enableTransclusion`

- `false` (default) — `![[Page]]` is rewritten to an embed anchor
- `true` — inlines the referenced file's content at the embed location

| Syntax | Result |
|--------|--------|
| `![[Page]]` | Full file content (frontmatter stripped) |
| `![[Page#Heading]]` | Only the section under that heading |
| `![[Page#^block]]` | Only the paragraph annotated with `^block` |
| `![alt](Page.md)` | Markdown embed form — same as `![[Page]]` |

A standalone `^block-id` separated from its block by a blank line still
references the block above it. When a section cannot be located in the target
file, the embed renders as a link to the page (with a build warning) instead
of inlining the entire page — matching Obsidian's unresolved-embed behaviour.

Supports ATX and setext headings in the target file. Any `[[wikilinks]]` found inside transcluded content are resolved automatically.

Output wraps content in:
```html
<div class="obsidian-transclusion" data-src="/page">
  ...inlined content...
</div>
```

### `enableMath`

- `false` (default) — `$…$` stays literal text
- `true` — inline and display math are rendered to KaTeX HTML during the build

| Syntax | Result |
|--------|--------|
| `$E = mc^2$` | inline formula |
| `$$…$$` | display formula, may span lines |

Delimiters follow Obsidian's rules: no space directly inside them and no
newline for inline math, so `$5 and $10` stays prose. Code fences, inline code
and raw HTML are never touched. Malformed TeX is rendered by KaTeX as its own
inline error rather than failing the build.

Enabling math also loads KaTeX's stylesheet through the `globalStyles` hook —
together with the plugin's own stylesheet when `enableDefaultStyles` is set, on
its own otherwise. KaTeX is already a dependency, so the site build resolves its
fonts from the installed package. You never need to import KaTeX's stylesheet
yourself: it is injected whenever math is enabled, regardless of
`enableDefaultStyles`.

### `mathEngine`

- `"katex"` (default) — what `enableMath` has always used
- `"mathjax"` — the engine Obsidian itself renders math with

KaTeX covers most notes and is much faster, but it is not MathJax: TeX that
only MathJax understands will not render under it. Set `mathEngine: "mathjax"`
for those pages' worth of formulas:

```ts
markdown({ enableMath: true, mathEngine: "mathjax" });
```

MathJax is an **optional** dependency — around 40 MB with its TeX packages, so
it is not installed for you. Add it when you want the engine:

```bash
bun add mathjax-full
```

Selecting `"mathjax"` without it fails the build with that instruction rather
than quietly falling back to KaTeX. The engine is loaded once, on the first file
that renders math, and its CommonHTML stylesheet — which MathJax generates at
render time — is emitted inline with each page, so no stylesheet import is
needed. MathJax loads its web fonts from its default CDN; the KaTeX stylesheet
is not loaded at all in this mode.

### `enableMermaid`

- `false` (default) — ` ```mermaid ` stays a code block
- `true` — the fence becomes a diagram drawn in the browser

Mermaid needs the DOM, so the plugin emits a placeholder at build time and
registers a client component (`globalUIComponents`) that draws it after mount
and on navigation. Diagrams are rendered with `securityLevel: "strict"` by
default: mermaid runs its own sanitizer over the SVG and drops unsafe link
URLs. Set `mermaidSecurityLevel` to `"loose"`, `"antiscript"` or `"sandbox"`
to render what a strict build refuses — the level is stamped on every
placeholder, so it configures the shared client instance before the first
diagram draws. A diagram that fails to render keeps its source and gains an
`.obsidian-mermaid-error` class.

### `enableMediaEmbeds`

- `false` (default) — `![[file]]` is rewritten to an embed anchor
- `true` — renders media files as native HTML elements

These are the formats Obsidian accepts, kept in one table
(`src/shared/media-exts.ts`) that the canvas renderer reads too, so a format
embeds in a note and in a canvas text card or neither.

| Extension | Output element |
|-----------|---------------|
| `avif`, `bmp`, `gif`, `jpeg`, `jpg`, `png`, `svg`, `webp` | `<img loading="lazy">` |
| `3gp`, `flac`, `m4a`, `mp3`, `ogg`, `wav` | `<audio controls>` |
| `mkv`, `mov`, `mp4`, `ogv`, `webm` | `<video controls>` |
| `pdf` | `<iframe loading="lazy">` |

Obsidian lists `.webm` under both audio and video. It is rendered as video here:
the renderers test audio first, so claiming it for audio would turn every video
`.webm` into an `<audio>` element. An audio-only `.webm` still plays through the
video element. Whether a browser can decode a format at all — `3gp` audio most of
all — is the same codec question it is in Obsidian.

A PDF embed is a `figure` with a caption bar naming the file and an "Open" link to
it, above the frame. The bar is not decoration: a bare `<iframe>` gives a reader
no way to tell which document they are looking at, and on a browser that cannot
display a PDF in place — iOS webviews, desktop Firefox, anything headless — it is
all they get, since a frame with nothing in it is indistinguishable from a bug.

The frame is deliberately not sandboxed: Chromium's PDF viewer needs scripts and
renders a broken-document icon inside a sandboxed one (verified in a browser), so
a sandbox there would break the embed instead of hardening it. The file is served
from the site's own origin. Turn `enableMediaEmbeds` off if you would rather link
to PDFs than embed them.

Styling the frame is yours: the bar, border and radius are plain CSS in
`rspress-plugin-obsidian/markdown/styles.css`, under `.obsidian-pdf`. The canvas
renderer emits the same markup and pulls the same rules from its own stylesheet, so
a card and a note never disagree.

Size parameter: `![[image.png|300x200]]` → `width="300" height="200"`. Width-only: `![[image.png|300]]` → `width="300"`. A markdown image takes the same syntax, which is how Obsidian documents it — the size alone (`![300](image.png)`) or after a caption (`![A caption|300](image.png)`); anything that is not a bare dimension, `![A caption|wide](image.png)`, stays caption text.

PDF embeds take their two knobs from the subpath: `![[doc.pdf#page=3]]` opens the frame at that page, `![[doc.pdf#height=400]]` sizes the frame (default 600). Only the page reaches the URL — the height is an attribute of the embed, not something the file is asked for.

Media paths are resolved in order:
1. On disk relative to the current file's directory
2. Indexed asset at that docs-root-relative path (finds attachments outside the docs tree, e.g. under `vaultRoot`)
3. On disk relative to the docs root
4. Indexed asset at the docs-root path
5. Unique asset basename anywhere in the index (exact, then case-insensitive) — this is what makes a bare `![[photo.png]]` work
6. Root-relative URL fallback (`/filename`), reported as unresolved

### `enableDefaultStyles`

- `false` (default) — no styles injected
- `true` — automatically injects the bundled stylesheet via Rspress `globalStyles`

Styles the plugin's main classes — `.callout-*`, `.obsidian-backlinks`, `.obsidian-transclusion`, `.obsidian-embed` (footnote output is intentionally unstyled). Uses Rspress CSS variables (`--rp-c-brand`, `--rp-c-bg-soft`, etc.) for automatic dark/light mode compatibility.

If you would rather wire it up yourself, turn `enableDefaultStyles` off and
point `globalStyles` at the resolved file. It cannot be `import`ed from
`rspress.config.ts`: Rspress loads the config with Node rather than the
bundler, so a `.css` specifier — with or without a `?url` suffix — fails before
the build starts, with `ERR_UNKNOWN_FILE_EXTENSION` or
`ERR_PACKAGE_PATH_NOT_EXPORTED`.

```ts
// rspress.config.ts
import path from "node:path";
import { createRequire } from "node:module";
import { defineConfig } from "@rspress/core";
import { markdown } from "rspress-plugin-obsidian";

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve("rspress-plugin-obsidian/package.json"));

export default defineConfig({
  globalStyles: path.join(pkgDir, "dist/markdown.css"),
  plugins: [markdown({ enableDefaultStyles: false })],
});
```

Or from a CSS file of your own, which the bundler *does* resolve:

```css
@import "rspress-plugin-obsidian/markdown/styles.css";
```

## Obsidian Comments

`%% ... %%` comments are stripped automatically — no option required:

```markdown
Visible text. %% Private note — not published. %% More visible text.
```

Multi-line block comments:

```markdown
%%
This entire paragraph is a private draft.
%%
```

A comment runs from an opening `%%` to the next closing `%%`, so it may span
paragraphs, headings and lists — everything between the delimiters is dropped,
including the container it empties:

```markdown
Visible text. %%
## This heading is private
And so is this paragraph.
%% Still visible.
```

Delimiters inside frontmatter, fenced code and inline code spans are literal,
and an unclosed `%%` is left as written.

The body, the page outline and the search index are all cleaned. A *heading*
inside a comment is removed from the outline too: Rspress builds that outline
from its own parse of the source, before plugin remark plugins run, so the plugin
drops the matching entries from the page data afterwards. Entries are matched by
the offsets Rspress records; with `search: false` those are absent, and the
entries are reconciled by heading identity instead, which still keeps a live
heading that happens to share its text with the commented one.

## Text Highlighting

`==text==` is transformed to `<mark>` tags — no option required:

```markdown
This is ==highlighted text== in a sentence.
```

Output:
```html
This is <mark>highlighted text</mark> in a sentence.
```

## Footnotes

Footnote references `[^1]` are converted to superscript links, with definitions rendered at the end of the page — no option required:

```markdown
This is a statement[^1] with a footnote.

[^1]: This is the footnote definition.
```

Output:
```html
This is a statement<sup class="footnote-ref" id="fnref-1"><a href="#fn-1" title="This is the footnote definition.">1</a></sup> with a footnote.

<hr />
<ol class="footnotes">
<li id="fn-1">This is the footnote definition. <a href="#fnref-1">↩</a></li>
</ol>
```

Inline footnotes are also supported:
```markdown
Inline footnote^[This is inline] works differently.
```

## Link Resolution

Resolution order for `[[target]]`:

1. **Explicitly relative path** — `[[../shared/Concept]]`, resolved from the current note
2. **Exact vault path** — `[[guide/getting-started]]`
3. **Unique basename** — `[[getting-started]]` (one page matches)
4. **Frontmatter `title`** — `[[Onboarding Guide]]` (unique match)
5. **Frontmatter `aliases`** — `[[Start Here]]` (unique match)
6. **Case-insensitive** — (default; disable with `enableCaseInsensitiveLookup: false`)
7. **Fuzzy matching** — (when `enableFuzzyMatching` is on) case-insensitive, shortest-suffix
8. **Rejected** — broken or ambiguous

Explicit `./` and `../` paths do not fall back to basename or metadata lookup when
their target is missing.

## Heading Resolution

Supported heading formats in target files:

- Standard ATX: `# Heading`
- ATX with closing: `# Heading ##`
- Up to 3 leading spaces: `   # Heading`
- Setext H1: `Heading\n=======`
- Setext H2: `Heading\n-------`
- Explicit IDs: `## Heading {#custom-anchor}`

Heading anchors use Rspress-compatible GitHub slugging. Unicode letters are
preserved, duplicate headings receive `-1`, `-2`, and explicit IDs take
precedence over generated slugs.

## Block ID Formats

The plugin indexes both block ID formats:

```markdown
Standalone block ID on its own line:

^my-block

Inline block ID appended to a paragraph: ^inline-block
```

Both are reachable via `[[Page#^my-block]]` and `[[Page#^inline-block]]`.

## Frontmatter Fields

The plugin reads these frontmatter fields from each page:

| Field | Purpose | Default |
|-------|---------|---------|
| `title` | Used as a lookup key (`[[My Title]]`) and as the default label | — |
| `aliases` | Additional lookup keys (`[[Alias Name]]`). Also accepts singular `alias` | `[]` |
| `tags` | Indexed in `byTag`; used to generate tag pages when `enableTagPages` is on. Also accepts singular `tag` | `[]` |
| `cssclasses` | Custom CSS classes applied to the page container. Also accepts singular `cssclass` | `[]` |
| `excerpt` | Page excerpt/description for SEO | — |
| `publish` | Set to `false` to exclude the page from indexing | `true` |

### `publish: false` — Draft Pages

The `publish` field controls whether a page is included in the content index:

```yaml
---
title: Work in Progress
tags:
  - draft
publish: false
---
```

When `publish` is `false`:
- The page is excluded from all lookup tables (`byPathKey`, `byBaseName`, `byTitle`, `byAlias`, `byTag`)
- Wikilinks pointing to the page are treated as broken links
- The page does not appear in tag index pages or backlinks panels
- Other pages cannot transclude its content

Accepted values:
- `true` / `yes` / `1` — page is included (default when field is absent)
- `false` / `no` / `0` — page is excluded

YAML strings are case-insensitive: `publish: "False"` and `publish: "No"` both exclude the page.

## Debugging

Use `"warn"` to inspect which links can't be resolved without failing the build:

```ts
markdown({
  onBrokenLink: "warn",
  onAmbiguousLink: "warn",
});
```

## Troubleshooting & FAQ

### My build fails with "Unable to resolve wikilink target"

The plugin's default `onBrokenLink: "error"` stops the build on any unresolvable wikilink. To find which links are broken:

```ts
markdown({
  onBrokenLink: "warn",
  onAmbiguousLink: "warn",
});
```

With `"warn"`, the build continues and each broken link prints a message showing exactly which page and target are problematic. The broken-anchor variant now lists available headings/blocks to help you find the right name.

### My `[[Page]]` wikilink reports as ambiguous

Multiple pages share the same filename (e.g. `docs/guide/getting-started.md` and `docs/tutorial/getting-started.md`). Fix by using a path-qualified link: `[[guide/getting-started]]` instead of `[[getting-started]]`.

### Transcluded content shows "Heading not found" but the heading exists

The heading lookup is case-insensitive (matching is done on normalized slugs), but it does respect exact text including punctuation — `[[Page#Getting Started!]]` will not match a heading written `Getting Started?`. Check the available headings listed in the diagnostic message — you may have a subtle character difference. An unmatched heading falls back to a plain link to the page itself.

### My `![[image.png|300x200]]` renders as a broken embed anchor

The file isn't found. The plugin resolves media paths in this order:
1. On disk relative to the current markdown file
2. Indexed asset at that docs-root-relative path
3. On disk relative to the docs root
4. Indexed asset at the docs-root path
5. Unique asset basename anywhere in the index (exact, then case-insensitive)
6. As a root-relative URL (fallback, with a warning)

Move the file into your docs directory or update the path.

### Callouts render as plain blockquotes

Callouts require `enableCallouts: true` in the plugin options. Wikilinks, comments, highlights, footnotes, and markdown-link resolution (`enableMarkdownLinks`) are on by default; everything else — callouts, tags, backlinks, transclusion, media embeds, Dataview, daily notes, tag pages, math, mermaid, and the bundled styles — is opt-in.

### My `publish: false` page still appears in the build

The `publish` field excludes a page from the **content index** — it won't appear in search, tag pages, or backlinks. It may still be rendered by Rspress if it's in the docs directory. To fully exclude a page, move it outside the docs root or prefix the filename with an underscore (Rspress convention).

### Footnotes render as raw `[^1]` text

Footnote definitions must match the pattern `[^label]: definition text` with a colon after the label. Single-word definitions like `[^a]: Alpha` can be misinterpreted by the remark parser as link definitions. Use multi-word prose: `[^alpha]: Alpha definition here.`

### Memory usage grows when building many documentation sites in one process

The content index cache is bounded to 10 entries with LRU eviction. If you need more simultaneous cached indexes, adjust `MAX_CACHED_INDEXES` in the source.

### I found a bug or have a feature request

Open an issue at [github.com/rspress-obsidian/rspress-plugin-obsidian/issues](https://github.com/rspress-obsidian/rspress-plugin-obsidian/issues). Releases are cut by semantic-release from Conventional Commits, so commit messages follow that convention.

## Changelog

See the [CHANGELOG](https://github.com/rspress-obsidian/rspress-plugin-obsidian/blob/main/CHANGELOG.md) for version history and release notes.
