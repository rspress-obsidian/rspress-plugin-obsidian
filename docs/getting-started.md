---
title: Getting Started
description: End-to-end setup for the suite — publish an Obsidian vault, its Canvas files, generated tag pages, daily notes, and the combined graph view.
---

# Getting Started

## Unified graph view

The graph view connects the full Obsidian publishing surface: wikilinks, Markdown links, generated tag pages, daily notes, and Markdown references embedded in Canvas files. Open the [Graph Features](/graph/guide/graph-view) guide for the combined configuration and extraction rules.

## Complete publishing example

This configuration publishes the local Obsidian vault, renders Canvas files from the same vault, generates tag pages and daily-note navigation, and enables the Graph View over the combined content:

```bash
bun add rspress-plugin-obsidian react-force-graph-2d
```

`react-force-graph-2d` is an optional peer of the package but a required one for
the graph panel, so install it yourself if you use `graphview()`.

```ts
import path from "node:path";
import { defineConfig } from "@rspress/core";
import { pluginObsidian } from "rspress-plugin-obsidian";

const vaultRoot = path.join(import.meta.dirname, "Obsidian Vault");

export default defineConfig({
  root: "docs",
  // Each feature injects its own stylesheet; the aggregate is for a site that
  // composes them by hand. It cannot be `import`ed from this file — Rspress
  // loads the config with Node, not the bundler — so prefer the option.
  plugins: pluginObsidian((markdown, canvas, graphview) => [
    markdown({
      vaultRoot,
      vaultRoutePrefix: "/vault",
      enableDefaultStyles: true,
      enableCallouts: true,
      enableBacklinks: true,
      enableTransclusion: true,
      enableMediaEmbeds: true,
      enableTagLinking: true,
      enableTagPages: true,
      enableDailyNotes: true,
      dailyNotes: {
        folder: "daily",
        dateFormat: "YYYY-MM-DD",
        navigation: true,
      },
      onBrokenLink: "error",
      onAmbiguousLink: "error",
    }),
    canvas({
      vaultRoot,
      routePrefix: "/canvas",
      fileRoutePrefix: "/vault",
      include: ["**/*.canvas"],
    }),
    graphview({
      defaultOpen: false,
      enableHoverPreviews: true,
    }),
  ]),
});
```

`fileRoutePrefix` must match the markdown plugin's `vaultRoutePrefix`: a Canvas file node such as `{ "file": "Welcome.md" }` links to `/vault/Welcome` only when both name the same prefix. Without it the card links to `/Welcome`, which the vault build never publishes.

> The individual factories (`markdown`, `canvas`, `graphview`) are also exported if you only need one — in that case pass them directly to your `plugins` array.

The resulting site separates normal docs, vault notes, Canvas routes, generated tag pages, and the combined interactive graph:

| Content | Example route |
|---|---|
| Vault note | `/vault/Welcome` |
| Vault wikilink target | `/vault/guide/intro` |
| Canvas | [`/canvas/demo`](/canvas/demo) |
| Generated tag page | `/tags/tutorial` |
| Graph View | Floating panel on every page |

## Section guides

- [Markdown plugin](/markdown/guide/getting-started) — install, syntax, the full option reference, and worked examples.
- [Wikilinks & Markdown](/markdown/) — feature tour: wikilinks, callouts, backlinks, transclusion.
- [Tags & Daily Notes](/markdown/guide/tags-and-daily-notes) — tag pages, daily-note navigation, Dataview queries.
- [Canvas](/canvas/) — configure Canvas pages, style them, and open the [live demo](/canvas/demo).
- [Graph Features](/graph/) — the interactive graph view, hover previews, and combined configuration.
