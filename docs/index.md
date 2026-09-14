---
pageType: home
title: Rspress × Obsidian
description: One Obsidian-publishing suite for Rspress — wikilinks, canvas, graph view, and more.
hero:
  name: Rspress × Obsidian
  text: Publish your Obsidian vault with Rspress
  tagline: Wikilinks, callouts, backlinks, transclusion, tags, daily notes, Dataview, canvas, and interactive knowledge graphs.
  actions:
    - theme: brand
      text: Get Started
      link: /wikilinks/
    - theme: alt
      text: Graph Features
      link: /graph/
features:
  - icon: 🔗
    title: Wikilinks & Markdown
    details: Wikilinks, callouts, backlinks, transclusion, media embeds, highlights, footnotes.
    link: /wikilinks/
  - icon: 🏷️
    title: Tags & Daily Notes
    details: Tag linking, tag pages, daily notes with navigation, Dataview queries.
    link: /tags-daily-notes/
  - icon: 🕸️
    title: Graph Features
    details: Interactive graph view, hover previews.
    link: /graph/
  - icon: 🖼️
    title: Interactive Canvas
    details: Canvas nodes, edges, groups, pan/zoom, editor mode.
    link: /canvas/
---

## Unified graph view

The graph view connects the full Obsidian publishing surface: wikilinks, Markdown links, generated tag pages, daily notes, and Markdown references embedded in Canvas files. Open the [Graph Features](/graph/guide/graph-view) guide for the combined configuration and extraction rules.

## Complete publishing example

This configuration publishes the local Obsidian vault, renders Canvas files from the same vault, generates tag pages and daily-note navigation, and enables the Graph View over the combined content:

```ts
import path from "node:path";
import { defineConfig } from "@rspress/core";
import {
  pluginGraphview,
  pluginObsidianCanvas,
  pluginObsidianWikiLink,
} from "rspress-plugin-obsidian";

const vaultRoot = path.join(import.meta.dirname, "Obsidian Vault");

export default defineConfig({
  root: "docs",
  plugins: [
    pluginObsidianWikiLink({
      vaultRoot,
      vaultRoutePrefix: "/vault",
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
    pluginObsidianCanvas({
      vaultRoot,
      routePrefix: "/canvas",
      include: ["**/*.canvas"],
    }),
    pluginGraphview({
      defaultOpen: false,
      enableHoverPreviews: true,
    }),
  ],
});
```

The resulting site separates normal docs, vault notes, Canvas routes, generated tag pages, and the combined interactive graph:

| Content | Example route |
|---|---|
| Vault note | `/vault/Welcome` |
| Vault wikilink target | `/vault/guide/intro` |
| Canvas | `/canvas/Demo` |
| Generated tag page | `/tags/tutorial` |
| Graph View | Floating panel on every page |

## Try the Canvas demo

The [live Canvas demo](/canvas/demo) is a generated page from the sample Obsidian vault. Use it to verify file nodes, text nodes, groups, links, Markdown, Mermaid, pan/zoom, and edge interactions.
