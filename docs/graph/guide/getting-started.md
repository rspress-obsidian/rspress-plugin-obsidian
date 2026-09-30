---
title: Getting Started
description: Install the graph view plugin, add it to rspress.config.ts, and see how the build-time graph extraction and runtime panel fit together.
---

# Getting Started

Welcome to **Rspress Graph View** — an interactive graph visualization plugin for [Rspress](https://rspress.dev/) documentation sites.

Think of it as [Obsidian's graph view](https://obsidian.md) for your docs. The plugin automatically extracts internal markdown links and renders them as a navigable force-directed graph, helping readers discover connections across your knowledge base.

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

**Build time** — When Rspress generates routes, the plugin:
1. Collects all route metadata
2. Reads each `.md`/`.mdx` file and `.canvas` board
3. Extracts `[title](./path.md)` internal links and canvas file references
4. Resolves relative and absolute link targets
5. Builds a graph data structure and injects it as a virtual module

**Runtime** — The client:
1. Loads `react-force-graph-2d` dynamically (lazy-loaded)
2. Renders an interactive force-directed graph
3. Highlights the current page and its neighbors
4. Lets users click nodes to navigate between pages

## Features

- [Interactive force-directed graph](./graph-view.md) with custom canvas rendering
- [Click-to-navigate](./graph-view.md#navigation) — click any node to jump to that page
- [Dark mode](./graph-view.md#dark-mode) — seamlessly adapts to light and dark themes
- [Build caching](./configuration.md#caching) — incremental rebuilds with mtime-based invalidation
- [Large graph optimization](./graph-view.md#large-graphs) — automatically reduces visual cost for 80+ node graphs
- [Color customization](./configuration.md#custom-colors) — override the default palette to match your brand


## Unified Obsidian content

The graph plugin works with the Markdown and Canvas plugins in the same Rspress site. It extracts ordinary Markdown links, Obsidian wikilinks, generated tag-page references, and Markdown references inside Canvas text/file nodes. Headings, block IDs, media assets, and external URLs remain attached to their source page instead of becoming separate graph nodes.

See [Graph View: Obsidian content support](./graph-view.md#obsidian-content-support) for the complete integration table.
See also:
- [Configuration](./configuration.md)
- [API Reference](../api.md)
