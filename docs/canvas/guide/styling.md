---
title: Styling
description: Restyle canvas boards with CSS variables and the plugin's CSS classes, in light and dark mode.
---

# Styling

Boards ship with a stylesheet that follows Obsidian's look and switches with
Rspress's dark mode. This page lists the CSS variables and classes you can
override. Change a variable when you only want different colours; target a
class when you want to change layout or type.

## Add your own CSS

Put your rules in a stylesheet that Rspress loads on every page, for example
through `globalStyles` in `rspress.config.ts`:

```ts
import path from "node:path";
import { defineConfig } from "@rspress/core";

export default defineConfig({
  globalStyles: path.join(import.meta.dirname, "theme.css"),
});
```

Scope your rules under `.canvas-container`, the element around every board.
Variables set there apply to the board whatever order the stylesheets load in,
and a selector that starts with `.canvas-container` is more specific than the
plugin's own rules.

The plugin injects its stylesheet for you. With
[`enableDefaultStyles: false`](./configuration.md#enabledefaultstyles) it does
not, and you import `rspress-plugin-obsidian/canvas/styles.css` yourself, for
example from your theme.

## Variables

Light values are set on `:root`; dark values on `html.dark`, `.dark` and
`[data-theme="dark"]`.

| Variable | Colours |
|----------|---------|
| `--canvas-bg`, `--canvas-grid-dot` | The board background and its dot grid |
| `--canvas-node-bg`, `--canvas-node-border`, `--canvas-node-border-hover` | Card background and border |
| `--canvas-node-text`, `--canvas-node-text-subtle` | Card text, and the names above cards |
| `--canvas-accent`, `--canvas-accent-subtle` | Links in cards, and the focus and selection ring |
| `--canvas-edge-color`, `--canvas-edge-label-bg`, `--canvas-edge-label-text` | Edges without a colour, and edge labels |
| `--canvas-group-bg`, `--canvas-group-border`, `--canvas-group-label` | Groups without a colour |
| `--canvas-code-bg`, `--canvas-code-text`, `--canvas-blockquote-border` | Code and quotes in cards |
| `--canvas-shadow`, `--canvas-shadow-hover` | Card shadows |
| `--canvas-toolbar-bg`, `--canvas-toolbar-btn-hover` | The toolbar |

For example, a warmer board in both modes:

```css
.canvas-container {
  --canvas-bg: #fbf7f0;
  --canvas-grid-dot: #e2d6c3;
  --canvas-accent: #9a3412;
}

html.dark .canvas-container {
  --canvas-bg: #1c1917;
  --canvas-grid-dot: rgba(255, 255, 255, 0.06);
  --canvas-accent: #fdba74;
}
```

## Colours

The six JSON Canvas presets use Obsidian's palette:

| Variable | Light | Dark |
|----------|-------|------|
| `--canvas-color-1` (red) | `#e93147` | `#fb464c` |
| `--canvas-color-2` (orange) | `#ec7500` | `#e9973f` |
| `--canvas-color-3` (yellow) | `#e0ac00` | `#e0de71` |
| `--canvas-color-4` (green) | `#08b94e` | `#44cf6e` |
| `--canvas-color-5` (cyan) | `#00bfbc` | `#53dfdd` |
| `--canvas-color-6` (purple) | `#7852ee` | `#a882ff` |

A coloured card gets the class `.canvas-node-colored`, and its colour, preset or
custom, in `--canvas-node-accent`. The card is tinted with
`--canvas-card-tint` of that colour (10% light, 14% dark) and a group with
`--canvas-group-tint` (7% light, 9% dark).

## Classes

### Board

| Class | Element |
|-------|---------|
| `.canvas-container` | The frame around a board. Also has `.canvas-editor` when the editor is on. |
| `.canvas-viewport` | The visible area. Its height is `min(80vh, 700px)`. |
| `.canvas-background` | The dot grid |
| `.canvas-world` | The layer that pans and zooms, holding cards and edges |
| `.canvas-toolbar` | The toolbar in the top-right corner; each button is `.canvas-toolbar-btn` |
| `.canvas-help-modal` | The controls dialog the **?** button opens |
| `.canvas-loading` | The placeholder while a board page loads |
| `.canvas-error` | The message shown when a board page cannot load its board |
| `.canvas-embed` | The wrapper of a board embedded in a page |
| `.canvas-embed-loading` | The placeholder while an embedded board loads. Unstyled by default. |
| `.canvas-embed-error` | The message shown when an embedded board cannot load. Unstyled by default. |

### Cards

| Class | Element |
|-------|---------|
| `.canvas-node-frame` | The positioned, focusable frame around a card. Also has `.is-selected` when selected. |
| `.canvas-node` | The card itself: border, background, shadow |
| `.canvas-node-text`, `.canvas-node-file`, `.canvas-node-link`, `.canvas-node-group` | The card type, on `.canvas-node` |
| `.canvas-file-note`, `.canvas-file-image`, `.canvas-file-pdf`, … | The kind of file a file card shows, on `.canvas-node`: `canvas-file-` followed by `note`, `image`, `audio`, `video`, `pdf`, `canvas`, `file`, `missing`, `private`, or `unresolved` for a card the build did not resolve |
| `.canvas-node-hovered` | A card being hovered |
| `.canvas-node-selected` | A selected card |
| `.canvas-node-colored` | A card or group with a colour |
| `.canvas-node-label` | The name above a file or link card |
| `.canvas-node-content` | The card's content box, which clips its content |
| `.canvas-group-label` | A group's label, above its top-left corner |
| `.canvas-group-collapse` | A group's collapse button |
| `.canvas-resize-handle` | The resize handle of a selected card in the editor |
| `.canvas-editor-banner` | The editor's banner above the board |
| `.canvas-editor-textarea` | The text field while you edit a text card |

### Card content

| Class | Element |
|-------|---------|
| `.canvas-markdown` | The Markdown body of a text card or a note card. When it overflows, it scrolls only while the pointer is over the card or focus is inside it. |
| `.wiki-link` | A wikilink in a card |
| `.canvas-unresolved-link` | A link whose target is missing or not published |
| `.canvas-tag` | A `#tag` |
| `.canvas-callout` | A callout; the type is added as `canvas-callout-<type>`, with `.canvas-callout-title` and `.canvas-callout-body` inside |
| `.canvas-math` | A formula; display math also has `.canvas-math-display`, and TeX KaTeX cannot render has `.canvas-math-error` |
| `.canvas-footnotes` | The footnote list at the end of a card |
| `.obsidian-mermaid-block` | A Mermaid diagram; a diagram that cannot render also has `.obsidian-mermaid-error` |
| `.canvas-file-notice` | The notice on a note card whose `subpath` is not in the note |
| `.canvas-file-fallback` | The card for another board, any other file, or a file that is not available |
| `.canvas-file-error-text` | The "not available" text of a missing or unpublished file |
| `.canvas-file-media` | The audio or video player |
| `.canvas-link` | A link card with `linkPreview: false` |
| `.canvas-link-frame` | The website preview of a link card |

### Edges

| Class | Element |
|-------|---------|
| `.canvas-edges` | The SVG that holds every edge |
| `.canvas-edge` | One edge; its line is `.canvas-edge-path` |
| `.canvas-edge-highlighted` | An edge of the hovered or selected card |
| `.canvas-edge-selected` | The selected edge in the editor |
| `.canvas-edge-label` | An edge's label |

## Examples

```css
/* Taller boards */
.canvas-container .canvas-viewport {
  height: 90vh;
}

/* Thicker card borders */
.canvas-container .canvas-node {
  border-width: 3px;
}

/* Text in cards */
.canvas-container .canvas-markdown {
  font-size: 15px;
}
.canvas-container .canvas-markdown h1 {
  font-size: 1.6em;
}
```
