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
| `.canvas-node` | Base node styling (border-radius, shadow) |
| `.canvas-node-hovered` | Active hover state (elevated shadow) |
| `.canvas-node-text` | Text node border color |
| `.canvas-node-file` | File node border color |
| `.canvas-node-link` | Link node left accent border |
| `.canvas-node-group` | Group node dashed border and transparency |

### Edges

| Class | Purpose |
|-------|---------|
| `.canvas-edges` | SVG container for all edge paths |
| `.canvas-edge` | Default edge transition |
| `.canvas-edge-highlighted` | Glow effect on connected edges |

### Content

| Class | Purpose |
|-------|---------|
| `.canvas-markdown` | Markdown content wrapper inside text nodes |
| `.canvas-group-label` | Group node label text |
| `.canvas-file-fallback` | File node card (clickable link or bare filename) |
| `.canvas-file-media` | Audio/video element inside a file node |
| `.canvas-file-pdf` | PDF iframe inside a file node |
| `.canvas-link` | Link node URL display |
| `.wiki-link` | Obsidian wiki-link color |
| `.canvas-error` | Parse error message display |

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
