---
description: Install and configure rspress-plugin-obsidian. Covers wikilink syntax, transclusion, media embeds, callouts, tags, comments, highlights, footnotes, and frontmatter support.
---

# Getting Started

Welcome to **rspress-plugin-obsidian** — a Rspress plugin that brings Obsidian-style markdown to your documentation.

It publishes a *subset* of an Obsidian vault: the Markdown dialect, the `.canvas` format, and a link graph. There is no plugin API, no `.obsidian/` configuration, and no live preview — this is a static-site publisher, not Obsidian.
[What is and is not supported is itemised here.](/obsidian-compatibility)

Almost everything beyond the core syntax is **opt-in**. Out of the box you get
wikilinks, embeds, heading and block anchors, `==highlights==`, `%%comments%%`,
footnotes and frontmatter. Callouts, transclusion, media embeds, tags and tag
pages, daily notes, Dataview, math, Mermaid and the backlinks panel are each
behind an `enable*` flag described [below](#optional-features).

> `onBrokenLink` and `onAmbiguousLink` default to `"error"`, so the first build
> of a real vault **fails on every unresolved `[[link]]`**. That is the
> diagnostic doing its job. See
> [how to check your own vault](/obsidian-compatibility#how-to-check-your-own-vault)
> for downgrading it to a warning.

## Prerequisites

- Node.js 22.14.0 or later
- An existing Rspress project (or create one with `npx rspress init`)

## Install

```bash
# Bun (recommended)
bun add rspress-plugin-obsidian

# npm
npm install rspress-plugin-obsidian

# pnpm
pnpm add rspress-plugin-obsidian

# yarn
yarn add rspress-plugin-obsidian
```

Peer requirements:

- `@rspress/core` (required)
- `react`, `react-dom`, `react-force-graph-2d` (optional peers — only needed by the graph view)

## Quick Setup

Add the plugin to your `rspress.config.ts`:

```ts
import path from "node:path";
import { defineConfig } from "@rspress/core";
import { markdown } from "rspress-plugin-obsidian";

export default defineConfig({
  root: path.join(__dirname, "docs"),
  plugins: [
    // `enableDefaultStyles` bundles the plugin's stylesheet into the site.
    markdown({ enableDefaultStyles: true }),
  ],
});
```

Load that stylesheet. Callouts, tag links, backlink panels and PDF transclusion
frames all emit classes whose colours, glyphs and layout live in it, so without
it the build succeeds and the page renders unstyled.

It cannot be loaded by importing it from `rspress.config.ts`: Rspress loads the
config with Node, not with the bundler, so a `.css` specifier — with or without
a `?url` suffix — fails with `ERR_UNKNOWN_FILE_EXTENSION` or
`ERR_PACKAGE_PATH_NOT_EXPORTED` before the build starts. If you need control
over load order or a custom entry point, turn `enableDefaultStyles` off and
point `globalStyles` at the resolved file instead:

```ts
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve("rspress-plugin-obsidian/package.json"));

export default defineConfig({
  globalStyles: path.join(pkgDir, "dist/markdown.css"),
  plugins: [markdown({ enableDefaultStyles: false })],
});
```

## Basic Wikilink Syntax

| Syntax | Description |
|--------|-------------|
| `[[Page]]` | Link to another page |
| `[[Page\|Alias]]` | Link with custom display text |
| `[[Page#Heading]]` | Link to a specific heading |
| `[[Page#Heading\|Alias]]` | Link to heading with alias |
| `[[#Heading]]` | Link to heading in current page |
| `[[Page#^block]]` | Block reference (standalone or inline) |

## Heading Preview

When you hover over a wikilink that points to a heading (`[[Page#Heading]]` or `[[#Heading]]`), the browser shows a tooltip with a preview of the section content. The preview is extracted during the content indexing phase — it picks up the first ~200 characters of plain text following each heading.

```markdown
[[getting-started#Install|Install guide]]

<!-- Hover shows: "Install steps. ^install-block." -->
```

No configuration needed — this works for every heading wikilink out of the box.

## Embed & Transclusion Syntax

Enable with `enableTransclusion: true` and `enableMediaEmbeds: true`:

| Syntax | Description |
|--------|-------------|
| `![[Page]]` | Transclude full page content |
| `![[Page#Heading]]` | Transclude a specific section only |
| `![[Page#^block]]` | Transclude a specific block only |
| `![[image.png]]` | Embed an image |
| `![[image.png\|300x200]]` | Embed image with width×height |
| `![[video.mp4]]` | Embed a video |
| `![[audio.mp3]]` | Embed audio |
| `![[doc.pdf]]` | Embed a PDF |
| `![[doc.pdf#page=3]]` | Embed a PDF opened at page 3 |
| `![[doc.pdf#height=400]]` | Embed a PDF in a 400px-tall frame |
| `![300](image.png)` | Size a markdown image (Obsidian's syntax) |
| `![300x200](image.png)` | Size a markdown image by width×height |
| `![A caption\|300](image.png)` | Caption plus size, like the wikilink pipe |

## Obsidian Comments

`%% ... %%` comments are **always stripped** — no configuration needed:

```markdown
This is visible. %% This is a private note. %% Back to visible.
```

Multi-line block comments also work:

```markdown
%%
Draft content — not published.
%%
```

## Text Highlighting

`==text==` is transformed to `<mark>` tags — no option needed:

```markdown
This is ==highlighted text== in a sentence.
```

## Footnotes

Footnote references `[^1]` are converted to superscript links, with definitions rendered at the end of the page — no option needed:

```markdown
This is a statement[^1] with a footnote.

[^1]: This is the footnote definition.
```

Definition text is inline Markdown like the rest of the page: bold, code, links,
highlights, and resolved wikilinks all render inside the footnotes block.

Inline footnotes are also supported, and their content is full Markdown:

```markdown
Inline footnote^[with **bold**, [a link](https://example.com) and [[a page]]] works.
```

## Frontmatter

The plugin reads these frontmatter fields from each page:

| Field | Purpose |
|-------|---------|
| `title` | Used as a lookup key (`[[My Title]]`) and as the default label |
| `aliases` | Additional lookup keys (`[[Alias Name]]`). Also accepts singular `alias` |
| `tags` | Tag page generation and categorization. Also accepts singular `tag` |
| `cssclasses` | Custom CSS classes applied to the page container |
| `excerpt` | Page excerpt/description for SEO |
| `publish` | Set to `false` to exclude the page from the index |

```yaml
---
title: My Custom Title
aliases:
  - First Alias
  - Second Alias
tags:
  - tutorial
  - obsidian
cssclasses:
  - custom-layout
  - dark-theme
excerpt: A brief description of this page
---
```

### Draft Pages with `publish: false`

Add `publish: false` to frontmatter to keep a page off the site. In a vault this
takes the page out of the content index; in your own docs directory it removes
the page's route, so the page is not built, does not appear in the
auto-generated sidebar or nav, and is not in the search index. If a hand-written
`_meta.json` or `themeConfig` still lists the page, remove it there too — that
entry would be a link to nothing.

```yaml
---
title: Rough Draft
tags:
  - draft
publish: false
---
```

Pages with `publish: false` are excluded from:
- Wikilink resolution (other pages cannot link to them)
- Tag page generation
- Backlinks index
- Content lookup tables
- The build itself, when the page lives in the docs directory

If no `publish` field is set, the page defaults to being included.

## Optional Features

| Option | What it enables |
|--------|----------------|
| `enableTagLinking` | `#tag` → `[#tag](/tags/tag)` (includes nested and Unicode tags) |
| `enableTagPages` | Auto-generate `/tags/{name}` index pages |
| `enableCallouts` | `> [!note]` → styled HTML (+ foldable with `+`/`-`) |
| `enableBacklinks` | Appends backlinks panel to each page |
| `enableTransclusion` | `![[Page]]` inlines file content |
| `enableMediaEmbeds` | `![[img.png]]` renders as `<img>`; covers every format Obsidian accepts — see [Embed & Transclusion Syntax](#embed--transclusion-syntax) |
| `enableMath` | `$inline$` / `$$display$$` rendered with KaTeX (loads KaTeX's stylesheet) |
| `enableMermaid` | ` ```mermaid ` fences drawn as diagrams in the browser |
| `mermaidSecurityLevel` | Mermaid's `securityLevel`; `"strict"` (default) sanitizes, looser levels do not |
| `enableDefaultStyles` | Injects the bundled stylesheet (callouts, backlinks, transclusion, embeds) |
| `enableFuzzyMatching` | Shortest-suffix path fallback |
| `enableCaseInsensitiveLookup` | Case-insensitive path resolution |

Full configuration example:

```ts
markdown({
  onBrokenLink: "error",
  onAmbiguousLink: "error",
  enableFuzzyMatching: false,
  enableCaseInsensitiveLookup: false,
  enableTagLinking: true,
  enableTagPages: true,
  enableCallouts: true,
  enableBacklinks: true,
  enableTransclusion: true,
  enableMediaEmbeds: true,
  enableDefaultStyles: true,
});
```

## Next Steps

- Explore [[markdown/guide/advanced|Advanced Usage]] for all configuration options in detail
- See [[markdown/guide/examples|Live Examples]] to watch the plugin features in action
- See the [[markdown/guide/api|API Reference]] for programmatic usage
