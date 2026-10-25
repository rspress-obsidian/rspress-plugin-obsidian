---
title: Getting Started
description: Install the Graph View with its react-force-graph-2d peer, add graphview() to rspress.config.ts, load the stylesheet, and see how the graph is built.
---

# Getting Started

This page adds the Graph View to an Rspress site: a floating panel that draws your pages and the links between them, as Obsidian's graph view does. It takes one plugin and one extra package.

## Install

Install the plugin and `react-force-graph-2d`, the library the panel draws with:

```bash
npm install rspress-plugin-obsidian react-force-graph-2d
# or
bun add rspress-plugin-obsidian react-force-graph-2d
# or
pnpm add rspress-plugin-obsidian react-force-graph-2d
```

`react-force-graph-2d` is an optional peer dependency, so your package manager does not install it for you. Without it the site still builds: the build prints a warning with the install command, and the panel shows an install hint and lists the pages as links instead of drawing the graph.

| Package | Version | |
|---------|---------|---|
| `@rspress/core` | `^2.0.21` | Required |
| `react-force-graph-2d` | `^1.29.1` | Optional peer, needed to draw the graph |
| `react`, `react-dom` | `^18 \|\| ^19` | Optional peers; an Rspress site already has them |

## Add the plugin

```ts
// rspress.config.ts
import { defineConfig } from "@rspress/core";
import { graphview } from "rspress-plugin-obsidian";

export default defineConfig({
  root: "docs",
  plugins: [graphview()],
});
```

Start the dev server (`npx rspress dev`). A round button appears in the bottom-right corner of every page; click it, or press `g`, to open the graph.

The graph works on its own, but it is built for the [Markdown](/markdown/) plugin: with `markdown()` installed, every wikilink, embed and tag a note renders becomes an edge, and vault notes are in the graph next to your docs pages. A [Canvas](/canvas/) board links to the notes on its cards.

## Add the stylesheet

The panel styles itself, but the graph stylesheet styles the [hover-preview](./graph-view.md#hover-previews) popover and switches the panel's animations off for readers who prefer reduced motion. Load it one of two ways.

Let the plugin add it:

```ts
graphview({ enableDefaultStyles: true });
```

Or `@import` it from a CSS file your site already loads, for example the file you pass to Rspress `globalStyles`:

```css
@import "rspress-plugin-obsidian/graph/styles.css";
```

`rspress-plugin-obsidian/styles.css` contains the Markdown, Canvas and Graph View stylesheets together. Use one way, not both. Do not import a `.css` file from `rspress.config.ts`: Rspress loads the config with Node, which cannot import CSS.

## How the graph is built

At build time, once Rspress knows its final list of pages (so `publish: false` notes are already gone), the plugin:

1. reads each page's links and tags from the Markdown plugin's index, or indexes the docs root itself when `markdown()` is not installed;
2. reads each `.canvas` board's cards;
3. resolves every link with the same resolver the rendered page uses, so an edge in the graph is exactly a link on the page and a backlink on its target;
4. ships the graph as a small module, and the note text for search as a separate one that loads only when a search needs it.

In the browser, the panel's code and the graph data download only when the panel opens; a reader who never opens it loads only the button. Under `rspress dev`, editing a note rebuilds the graph and updates the open page.

## Next steps

- [Using the Graph View](./graph-view.md): what readers can do in the panel, and which Obsidian content becomes nodes and edges.
- [Configure the Graph View](./configuration.md): open the panel by default, colour groups, your own colours, hover previews, broken-link reports.
- [API Reference](../api.md): every option and colour key.
