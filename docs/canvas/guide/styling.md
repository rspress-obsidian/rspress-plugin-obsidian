---
title: Styling
description: Customize the canvas appearance with CSS class overrides and CSS variables.
---

# Styling

The plugin ships with a complete default stylesheet. Override any part by targeting the exposed CSS classes.

## Import

The default stylesheet is injected automatically (`enableDefaultStyles` defaults to `true`). Only if you set `enableDefaultStyles: false` do you need to import it yourself:

```ts
import 'rspress-plugin-obsidian/canvas/styles.css';
```

## Class Reference

### Viewport

| Class | Purpose |
|-------|---------|
| `.canvas-viewport` | Outer container; sets the viewport background color |
| `.canvas-background` | Dot-grid layer behind the world |
| `.canvas-world` | Transformable layer holding nodes and edges |

### Nodes

| Class | Purpose |
|-------|---------|
| `.canvas-node-frame` | Positioned, focusable frame around a card (`role="group"`, stacking order) |
| `.canvas-node` | Base node styling (border-radius, shadow) |
| `.canvas-node-hovered` / `.canvas-node-selected` | Hover and selection states |
| `.canvas-node-text`, `.canvas-node-file`, `.canvas-node-link`, `.canvas-node-group` | Per-type hooks |
| `.canvas-file-note`, `.canvas-file-image`, `.canvas-file-pdf`, … | File cards by kind (`canvas-file-<kind>` on `.canvas-node`) |
| `.canvas-node-colored` | A card or group with a colour; the colour is in `--canvas-node-accent` |
| `.canvas-node-label` | The name above a file or link card |

### Edges

| Class | Purpose |
|-------|---------|
| `.canvas-edges` | SVG container for all edge paths |
| `.canvas-edge` | One edge (`.canvas-edge-path` is its stroke) |
| `.canvas-edge-highlighted` | Glow effect on connected edges |
| `.canvas-edge-label` | The label box on the curve's midpoint |

### Content

| Class | Purpose |
|-------|---------|
| `.canvas-markdown` | Markdown content wrapper inside text nodes |
| `.canvas-group-label` | Group label above the group's top-left corner |
| `.canvas-file-fallback` | File node card (clickable link or bare filename) |
| `.canvas-file-media` | Audio/video element inside a file node |
| `.canvas-file-pdf` | PDF iframe inside a file node |
| `.canvas-link` | Link node URL display (with `linkPreview: false`) |
| `.canvas-link-frame` | The website preview frame of a link node |
| `.wiki-link` | Obsidian wiki-link color |
| `.canvas-unresolved-link` | A link whose target is not published |
| `.canvas-error` | Parse error message display |

## Colours

The six JSON Canvas presets use Obsidian's palette and switch with dark mode:

| Variable | Light | Dark |
|----------|-------|------|
| `--canvas-color-1` (red) | `#e93147` | `#fb464c` |
| `--canvas-color-2` (orange) | `#ec7500` | `#e9973f` |
| `--canvas-color-3` (yellow) | `#e0ac00` | `#e0de71` |
| `--canvas-color-4` (green) | `#08b94e` | `#44cf6e` |
| `--canvas-color-5` (cyan) | `#00bfbc` | `#53dfdd` |
| `--canvas-color-6` (purple) | `#7852ee` | `#a882ff` |

A coloured card is tinted with `--canvas-card-tint` of its colour over the card
background, and a coloured group with `--canvas-group-tint`, for presets and
custom colours alike.

## Override Example

```css
/* Darker grid background */
.canvas-viewport {
  background-color: #1a1a2e;
  background-image:
    linear-gradient(#2a2a3e 1px, transparent 1px),
    linear-gradient(90deg, #2a2a3e 1px, transparent 1px);
}

/* Thicker node borders */
.canvas-node {
  border-width: 3px;
}

/* Custom group style */
.canvas-node-group {
  border-color: #7b2cbf;
  background-color: rgba(123, 44, 191, 0.08);
}

/* Edge color on highlight */
.canvas-edge-highlighted path {
  filter: drop-shadow(0 0 4px rgba(123, 44, 191, 0.5));
}
```

## Markdown Content Styling

Text node Markdown inherits from `.canvas-markdown`. Override heading sizes, code block colors, and link styles:

```css
.canvas-markdown h1 { font-size: 1.6em; }
.canvas-markdown code { background-color: #2d2d2d; color: #e0e0e0; }
.canvas-markdown a { color: #7b2cbf; }
.canvas-markdown img { border: 1px solid #e0e0e0; }
.canvas-markdown hr { border-color: #c0c0c0; }
```
