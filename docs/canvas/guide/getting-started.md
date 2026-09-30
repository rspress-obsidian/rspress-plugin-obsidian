---
title: Getting Started
description: Install and configure rspress-plugin-obsidian in your Rspress site.
---

# Getting Started

Render Obsidian vault `.canvas` files as interactive pages in your Rspress documentation site.

## Install

```bash
bun add rspress-plugin-obsidian
```

Add the required peer dependencies if you don't have them:

```bash
bun add @rspress/core react react-dom
```

## Basic Setup

Add the plugin to your `rspress.config.ts`:

```ts
import { defineConfig } from '@rspress/core';
import { canvas } from 'rspress-plugin-obsidian';

export default defineConfig({
  plugins: [
    canvas({
      vaultRoot: './Obsidian Vault',
      routePrefix: '/canvas',
    }),
  ],
});
```

The bundled stylesheet is injected automatically (`enableDefaultStyles` defaults to `true`). To opt out and import it yourself — for example to control load order from a theme entry point or a global layout file — set `enableDefaultStyles: false`:

```ts
canvas({ enableDefaultStyles: false }),
```

```ts
import 'rspress-plugin-obsidian/canvas/styles.css';
```

## How It Works

1. **Build time** — The plugin scans your vault directory for `.canvas` files
2. Each file is parsed, validated against the JSON Canvas 1.0 spec, and embedded as JSON
3. **Runtime** — A `CanvasViewer` component renders an interactive React canvas on each page
4. Nodes are positioned absolutely on a pannable/zoomable viewport with SVG bezier edges
5. A board reopens where you left it: the last pan/zoom is kept in `localStorage` per board, the way Obsidian restores a canvas viewport. A first visit frames the nodes instead, and **Fit to View** (or the `F` key) re-frames a board you have moved.

## Your First Canvas

Place a `.canvas` file in your vault directory:

```json
{
  "nodes": [
    {
      "id": "n1",
      "type": "text",
      "x": 0,
      "y": 0,
      "width": 300,
      "height": 150,
      "text": "# Hello Canvas\n\nThis is a **text node** with Markdown."
    },
    {
      "id": "n2",
      "type": "file",
      "x": 400,
      "y": 0,
      "width": 200,
      "height": 100,
      "file": "Welcome.md"
    }
  ],
  "edges": [
    {
      "id": "e1",
      "fromNode": "n1",
      "fromSide": "right",
      "toNode": "n2",
      "toSide": "left",
      "label": "links to"
    }
  ]
}
```

Run `rspress dev` and visit `/canvas/<filename>` to see it rendered.

## Canvas, vault notes, and Graph View together

Use the same `vaultRoot` for Markdown notes and Canvas files:

```ts
const vaultRoot = path.join(import.meta.dirname, "Obsidian Vault");

plugins: [
  markdown({
    vaultRoot,
    vaultRoutePrefix: "/vault",
    enableTransclusion: true,
    enableMediaEmbeds: true,
  }),
  canvas({ vaultRoot, routePrefix: "/canvas", fileRoutePrefix: "/vault" }),
  graphview({ defaultOpen: true }),
]
```

`fileRoutePrefix` must match the markdown plugin's `vaultRoutePrefix`. A Canvas file node such as `{ "file": "Welcome.md" }` links to `/vault/Welcome`; without the prefix it would link to `/Welcome`, which no route serves. Wikilinks and Markdown links inside text nodes also contribute edges to the Graph View.

Text cards render attachments with the same renderer as notes, from the same table of Obsidian's accepted formats (`src/shared/media-exts.ts`) — so a `![[photo.bmp]]` embeds identically in a note and in a card, `|300x200` sizes either one, and a PDF takes the same subpath knobs (`![[doc.pdf#page=3]]`, `![[doc.pdf#height=400]]`) in both. A PDF with no height of its own is drawn in a 600px frame, the same default a note uses.

## Live demo

Open the [interactive Canvas demo](/canvas/demo) to try the published Obsidian Canvas fixture. It includes text, file, link, and group nodes, Markdown rendering, Mermaid, footnotes, pan/zoom, edge highlighting, and keyboard controls.

The demo is generated from the repository fixture at `Obsidian Vault/Demo.canvas` and is available after `bun run docs:build` or while running `bun run docs:dev`.

## Next Steps

- [Configure plugin options](/canvas/guide/configuration) for vault paths and route prefixes
- [Learn about the canvas format](/canvas/guide/canvas-format) and supported features
- [Customize the appearance](/canvas/guide/styling) with CSS overrides
