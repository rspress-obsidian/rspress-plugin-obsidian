---
title: Getting Started
description: Publish the .canvas files in your Obsidian vault as interactive pages — install, a minimal config, and what you get.
---

# Getting Started

This guide publishes the `.canvas` files in your Obsidian vault as interactive
board pages, next to the notes the [Markdown](/markdown/) section publishes. If
your vault is not on the site yet, start with
[Markdown → Getting Started](/markdown/guide/getting-started); this guide adds
`canvas()` to that setup.

## Install

```bash
bun add rspress-plugin-obsidian
```

Your Rspress site already has the other packages Canvas needs (`@rspress/core`,
`react` and `react-dom`). To draw Mermaid diagrams inside cards, also install
the optional `mermaid` package; without it a diagram shows its source.

## Configure

Give `canvas()` the same `vaultRoot` as `markdown()`, and set `fileRoutePrefix`
to the markdown plugin's `vaultRoutePrefix`:

```ts
import path from "node:path";
import { defineConfig } from "@rspress/core";
import { canvas, markdown } from "rspress-plugin-obsidian";

const vaultRoot = path.join(import.meta.dirname, "Obsidian Vault");

export default defineConfig({
  root: "docs",
  plugins: [
    markdown({ vaultRoot, vaultRoutePrefix: "/vault" }),
    canvas({ vaultRoot, routePrefix: "/canvas", fileRoutePrefix: "/vault" }),
  ],
});
```

`fileRoutePrefix` must match `vaultRoutePrefix`. A file card for `Welcome.md`
then links to `/vault/Welcome`, the page the markdown plugin publishes. Without
it the card links to `/Welcome`, which no page serves, and the build logs a
warning.

The canvas stylesheet is injected for you. Every other option is described in
[Configuration](./configuration.md).

### Boards in your docs folder

If your boards sit next to your docs pages rather than in a vault, `canvas()`
needs no options: it scans the Rspress content root (`docs/` by default) and
publishes each board at `/canvas/<name>`.

## Try it

Any board you made in Obsidian works. To try one without Obsidian, save this as
`Hello.canvas` in the vault root. It has a text card, a file card for a note
called `Welcome.md`, and an arrow between them:

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
      "text": "# Hello Canvas\n\nThis is a **text card** with Markdown."
    },
    {
      "id": "n2",
      "type": "file",
      "x": 400,
      "y": 0,
      "width": 300,
      "height": 150,
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

Run `bunx rspress dev` and open `/canvas/hello`.

## What you get

- **A page per board.** `Hello.canvas` becomes `/canvas/hello`, and
  `Projects/Road Map.canvas` becomes `/canvas/projects/road-map`.
- **A board you can explore.** Drag to pan, scroll or pinch to zoom, and use the
  arrow keys, `+`, `-`, `0` (1:1) and `F` (fit). A board reopens where you left
  it: the last pan and zoom are kept in the browser per board. On a first visit
  the board is fitted to the view.
- **Cards that look like Obsidian's.** Text cards render Obsidian Markdown,
  including wikilinks, callouts, math and Mermaid. File cards show the note's
  content, an image, a player or a PDF. Link cards show the website. See
  [Canvas Format](./canvas-format.md).
- **Links that work.** Links in cards resolve to the same pages as links in
  notes. A link to a missing or `publish: false` note is shown as plain text.
- **Boards in your notes.** `![[Hello.canvas]]` in a note embeds the board, and
  `[[Hello.canvas]]` links to its page. See [Embedding](./embed.mdx).
- **Graph View.** With `graphview()` enabled, each board is a node in the graph,
  linked to the notes on it.

The [live demo](/canvas/demo) shows all of this on the repository's
`Obsidian Vault/Demo.canvas`.

## Next steps

- [Configuration](./configuration.md): routes, scan patterns, link previews and
  the in-browser editor.
- [Canvas Format](./canvas-format.md): what each card type and edge renders.
- [Embedding](./embed.mdx): put a board inside any page.
- [Styling](./styling.md): CSS classes and variables.
