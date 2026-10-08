---
title: Getting Started
description: Install the graph view plugin, add it to rspress.config.ts, and see how the build-time graph extraction and runtime panel fit together.
---

# Getting Started

Welcome to **Rspress Graph View** — an interactive graph visualization plugin for [Rspress](https://rspress.dev/) documentation sites.

Think of it as [Obsidian's graph view](https://obsidian.md) for your docs. The plugin turns the links between your pages into a navigable force-directed graph, helping readers discover connections across your knowledge base.

## Prerequisites

- [Rspress](https://rspress.dev/) `^2.0.21` or later
- `react-force-graph-2d` — **required** to render the panel. It is an optional
  peer dependency, so your package manager will not install it for you, and the
  build fails without it: the panel imports it by name and the bundler resolves
  that specifier before any runtime fallback can run.
- React `^18 || ^19` — an optional peer, required only to render the panel

## Installation

Install the plugin alongside your existing Rspress setup:

```bash
bun add rspress-plugin-obsidian
# or
npm install rspress-plugin-obsidian
# or
pnpm add rspress-plugin-obsidian
```

Then install the peer the panel renders with:

```bash
bun add react-force-graph-2d
# or
npm install react-force-graph-2d
```

## Quick Start

Add the plugin to your `rspress.config.ts`:

```ts
import { defineConfig } from "@rspress/core";
import { graphview } from "rspress-plugin-obsidian";

export default defineConfig({
  root: "docs",
  plugins: [graphview()],
});
```

That's it. Start your dev server and you'll see a floating action button in the bottom-right corner. Click it to open the graph view.

## How It Works

The plugin operates in two phases:

**Build time**: once Rspress has its final route list (after every plugin has run, so `publish: false` pages are already gone), the plugin:
1. Reads each note's links and tags from the markdown plugin's content index, or indexes the docs root itself when `markdown()` is not installed
2. Reads each `.canvas` board's cards from the `.canvas` file
3. Resolves every link with the markdown plugin's resolver, the one the rendered page uses
4. Builds the graph (notes, tags, attachments, unresolved links) and publishes it as a compact virtual module, with the note text for search as a separate module

Under `rspress dev`, editing a note rebuilds the graph and updates the open page.

**Runtime** — The client:
1. Loads `react-force-graph-2d` dynamically (lazy-loaded)
2. Renders an interactive force-directed graph
3. Highlights the current page and its neighbors
4. Lets readers click nodes to open pages, or use the keyboard list of the same pages

## Features

- [Interactive force-directed graph](./graph-view.md) with custom canvas rendering
- [Click-to-navigate](./graph-view.md#navigation) — click any node to jump to that page
- [Dark mode](./graph-view.md#dark-mode) — seamlessly adapts to light and dark themes
- [Obsidian's graph settings](./graph-view.md#settings): filters, display and forces, saved per visitor
- [Fast rebuilds and live dev updates](./configuration.md#link-resolution-rebuilds-and-rspress-dev)
- [Large graph optimization](./graph-view.md#large-graphs) — automatically reduces visual cost for 80+ node graphs
- [Color customization](./configuration.md#custom-colors) — override the default palette to match your brand


## Unified Obsidian content

The graph plugin works with the Markdown and Canvas plugins in the same Rspress site. Its edges are the links each page renders: wikilinks, embeds, Markdown links, `obsidian://` links and frontmatter property links. Tags, attachments and links to notes that do not exist yet can be shown as nodes, and a canvas board links to its cards. Headings and block IDs stay fragments of their page.

See [Graph View: Obsidian content support](./graph-view.md#obsidian-content-support) for the complete integration table.
See also:
- [Configuration](./configuration.md)
- [API Reference](../api.md)
