---
title: Getting Started
description: Publish an Obsidian vault with Rspress — requirements, install, a minimal config, the routes you get, and how to turn on Canvas, the graph view and every other feature.
---

# Getting Started

This page takes you from an Rspress site to a published Obsidian vault, then shows how to turn on the rest. Read it top to bottom the first time; come back to [Turn on more](#turn-on-more) when you want another feature.

## Requirements

- **Node.js 22.14** or later.
- An **Rspress 2** site (`@rspress/core` `^2.0.21`). No site yet? `npm create rspress@latest` makes one.
- An **Obsidian vault**: the folder Obsidian opens. It can sit anywhere on disk, inside the site's repository or reached through a symlink.

## Install

```bash
npm install rspress-plugin-obsidian
# or: bun add rspress-plugin-obsidian
# or: pnpm add rspress-plugin-obsidian
```

That is all most features need. A few draw with a package you install only if you use them; without it, the build names the package and the feature falls back:

| Package | Needed for | Without it |
| --- | --- | --- |
| `react-force-graph-2d` | the [graph view](/graph/) | a list of pages instead of the graph |
| `mermaid` | Mermaid diagrams | diagrams stay as source |
| `@excalidraw/excalidraw` | Excalidraw fonts and text wrapping | fallback fonts, estimated wrapping |
| `maplibre-gl` | Bases map views | a table of the located notes |
| `lucide-static` | Bases `icon()` | the icon's name |
| `mathjax-full` | `mathEngine: "mathjax"` | the build fails; KaTeX, the default engine, needs nothing |

## Publish your vault

Add the plugin to `rspress.config.ts` and point `vaultRoot` at your vault:

```ts
import path from "node:path";
import { defineConfig } from "@rspress/core";
import { pluginObsidian } from "rspress-plugin-obsidian";

export default defineConfig({
  root: path.join(import.meta.dirname, "docs"),
  plugins: pluginObsidian((markdown) => [
    markdown({
      // Your vault's folder.
      vaultRoot: path.join(import.meta.dirname, "My Vault"),
      // Styles for callouts, backlinks, tags and the rest.
      enableDefaultStyles: true,
    }),
  ]),
});
```

Start the dev server and open the local URL it prints:

```bash
npx rspress dev
```

Your docs pages stay where they were, and every note in the vault becomes a page under `/vault` (change it with `vaultRoutePrefix`):

| In the vault | Published page |
| --- | --- |
| `My Vault/Welcome.md` | `/vault/Welcome` |
| `My Vault/guide/intro.md` | `/vault/guide/intro` |
| `[[Welcome]]` in any note or docs page | a link to `/vault/Welcome` |
| A note with `publish: false` in its frontmatter | no page, and links to it are reported as broken |

Without any other option you get [wikilinks](/markdown/guide/link-resolution) with heading and block anchors, Markdown links between notes, and [Obsidian's note syntax](/markdown/guide/note-syntax): `==highlights==`, `%%comments%%`, footnotes and its line breaks. Docs pages and vault notes link to each other in both directions.

### If the first build fails

Links are checked strictly by default: a wikilink or note link that resolves to nothing is reported with the page it is on, and the build fails (`onBrokenLink: "error"`). Fix the links the report names, or publish while you work through them:

```ts
markdown({
  vaultRoot: path.join(import.meta.dirname, "My Vault"),
  enableDefaultStyles: true,
  onBrokenLink: "warn",
}),
```

The [compatibility page](/obsidian-compatibility#how-to-check-your-own-vault) lists the other checks and what each one reports.

## Turn on more

Everything beyond the basics is off until you turn it on. Add the option to `markdown({ … })`, or add a feature to the `pluginObsidian` list:

| Feature | Turn it on | Guide |
| --- | --- | --- |
| Callouts | `enableCallouts` | [Callouts](/markdown/guide/callouts) |
| Note embeds (transclusion) | `enableTransclusion` | [Transclusion](/markdown/guide/transclusion) |
| Image, audio, video and PDF embeds | `enableMediaEmbeds` | [Media embeds](/markdown/guide/media-embeds) |
| Backlinks panel | `enableBacklinks` | [Backlinks](/markdown/guide/backlinks) |
| Tag links, tag pages, daily notes | `enableTagLinking`, `enableTagPages`, `enableDailyNotes` | [Tags & daily notes](/markdown/guide/tags-and-daily-notes) |
| Dataview queries | `enableDataview` | [Dataview](/markdown/guide/dataview) |
| Math and Mermaid | `enableMath`, `enableMermaid` | [Advanced](/markdown/guide/advanced) |
| Tasks queries | `enableTasks` | [Tasks](/markdown/guide/tasks) |
| Kanban boards | `enableKanban` | [Kanban](/markdown/guide/kanban) |
| Excalidraw drawings | `enableExcalidraw` | [Excalidraw](/markdown/guide/excalidraw) |
| Bases | `enableBases` | [Bases](/markdown/guide/bases) |
| Templater templates | `enableTemplater` | [Templater](/markdown/guide/templater) |
| `.canvas` boards as pages | add `canvas()` | [Canvas](/canvas/) |
| Graph view, hover previews | add `graphview()`; `enableHoverPreviews` | [Graph View](/graph/) |

Every Markdown option, with its default, is in the [Markdown API reference](/markdown/guide/api).

### Canvas and the graph view

Canvas and the graph view are separate features in the same list. Give `pluginObsidian` the vault first and every feature uses it, so you name it once:

```ts
import path from "node:path";
import { defineConfig } from "@rspress/core";
import { pluginObsidian } from "rspress-plugin-obsidian";

export default defineConfig({
  root: path.join(import.meta.dirname, "docs"),
  plugins: pluginObsidian(
    { vaultRoot: path.join(import.meta.dirname, "My Vault") },
    (markdown, canvas, graphview) => [
      markdown({ enableDefaultStyles: true }),
      canvas({ routePrefix: "/canvas" }),
      graphview(),
    ],
  ),
});
```

The shared options are `vaultRoot` and `vaultRoutePrefix`. The markdown feature publishes the vault's notes under `vaultRoutePrefix`; canvas scans the same vault for boards and links its cards to the notes under that prefix; the graph view draws whatever the markdown feature publishes. An option you pass to a feature itself, such as `markdown({ vaultRoot })`, wins over the shared one.

- **Canvas** publishes each `.canvas` file in the vault as a page under `/canvas`, its path lowercased with spaces as dashes, so `My Vault/Demo.canvas` becomes [`/canvas/demo`](/canvas/demo). A card that shows a note links to that note's page.
- **Graph view** adds a button to every page that opens a floating graph panel (or press `g`). While the panel is closed its code is not downloaded; it loads when a reader opens it, or with the page when you set `defaultOpen: true`. Install `react-force-graph-2d` to draw the graph.

The graph is built from everything the site publishes: wikilinks, Markdown links, tags (linked to their tag pages when `enableTagPages` is on), daily notes, and the notes and links inside canvas boards. Its edges are the links the markdown feature resolves, so the graph and the backlinks panel always agree. The [Graph View guide](/graph/guide/graph-view) explains the panel, its filters and search.

## Full example

This publishes a vault with callouts, embeds, backlinks, tags, daily notes and Dataview, renders its canvas boards, and adds the graph view with hover previews:

```ts
import path from "node:path";
import { defineConfig } from "@rspress/core";
import { pluginObsidian } from "rspress-plugin-obsidian";

export default defineConfig({
  root: path.join(import.meta.dirname, "docs"),
  plugins: pluginObsidian(
    {
      vaultRoot: path.join(import.meta.dirname, "My Vault"),
      vaultRoutePrefix: "/vault",
    },
    (markdown, canvas, graphview) => [
      markdown({
        enableDefaultStyles: true,
        enableCallouts: true,
        enableTransclusion: true,
        enableMediaEmbeds: true,
        enableBacklinks: true,
        enableTagLinking: true,
        enableTagPages: true,
        enableDailyNotes: true,
        dailyNotes: {
          folder: "daily",
          dateFormat: "YYYY-MM-DD",
          navigation: true,
        },
        enableDataview: true,
        onBrokenLink: "error",
        onAmbiguousLink: "warn",
      }),
      canvas({ routePrefix: "/canvas" }),
      graphview({
        defaultOpen: false,
        enableHoverPreviews: true,
      }),
    ],
  ),
});
```

With this config the site has:

| Content | Example route |
| --- | --- |
| Vault note | `/vault/Welcome` |
| Daily note `daily/2024-01-15.md` | `/vault/daily/2024-01-15` |
| Generated tag page for `#tutorial` | `/tags/tutorial` |
| Canvas board `Demo.canvas` | [`/canvas/demo`](/canvas/demo) |
| Graph view | a floating panel on every page |

`markdown`, `canvas` and `graphview` are also exported on their own. To use one without the others, import it and put its plugin straight into `plugins`: `plugins: [markdown({ vaultRoot })]`. Listed side by side without `pluginObsidian`, the graph view and canvas still find the markdown plugin of the same site, whatever order they are in; only the vault options have to be repeated (`canvas({ vaultRoot, fileRoutePrefix: "/vault" })`).

## Next steps

- [Live examples](/markdown/guide/examples): every Markdown feature, rendered by this plugin.
- [Markdown](/markdown/), [Canvas](/canvas/) and [Graph View](/graph/): each section's guides and option reference.
- [Compatibility](/obsidian-compatibility): what is supported from Obsidian, what is partial, and what is left out.
