---
title: Getting Started
description: Install and configure rspress-plugin-obsidian-canvas in your Rspress site.
---

# Getting Started

Render Obsidian vault `.canvas` files as interactive pages in your Rspress documentation site.

## Install

```bash
bun add rspress-plugin-obsidian-canvas
```

Add the required peer dependencies if you don't have them:

```bash
bun add @rspress/core react react-dom
```

## Basic Setup

Add the plugin to your `rspress.config.ts`:

```ts
import { defineConfig } from '@rspress/core';
import { pluginObsidianCanvas } from 'rspress-plugin-obsidian-canvas';

export default defineConfig({
  plugins: [
    pluginObsidianCanvas({
      vaultRoot: './Obsidian Vault',
      routePrefix: '/canvas',
    }),
  ],
});
```

Import the stylesheet in your theme entry point or a global layout file:

```ts
import 'rspress-plugin-obsidian-canvas/style.css';
```

## How It Works

1. **Build time** — The plugin scans your vault directory for `.canvas` files
2. Each file is parsed, validated against the JSON Canvas 1.0 spec, and embedded as JSON
3. **Runtime** — A `CanvasViewer` component renders an interactive React canvas on each page
4. Nodes are positioned absolutely on a pannable/zoomable viewport with SVG bezier edges

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
  pluginObsidianWikiLink({
    vaultRoot,
    vaultRoutePrefix: "/vault",
    enableTransclusion: true,
    enableMediaEmbeds: true,
  }),
  pluginObsidianCanvas({ vaultRoot, routePrefix: "/canvas" }),
  pluginGraphview({ defaultOpen: true }),
]
```

A Canvas file node such as `{ "file": "Welcome.md" }` links to `/vault/Welcome`. Wikilinks and Markdown links inside text nodes also contribute edges to the Graph View.

## Next Steps

- [Configure plugin options](/canvas/guide/configuration) for vault paths and route prefixes
- [Learn about the canvas format](/canvas/guide/canvas-format) and supported features
- [Customize the appearance](/canvas/guide/styling) with CSS overrides
