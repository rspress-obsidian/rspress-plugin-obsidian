---
title: Canvas Format
description: Full JSON Canvas 1.0 spec support — node types, edges, colors, and Markdown features.
---

# Canvas Format

This plugin parses and renders the JSON Canvas 1.0 structure in read-only mode. It preserves the node array z-order and validates required fields, IDs, geometry, edge references, and enum values.

## Node Types

### Text Nodes

Store Markdown content. Standard Markdown and common Obsidian link/embed syntax are supported. HTML and unsafe URL protocols are escaped or rejected.

```json
{
  "id": "n1",
  "type": "text",
  "x": 0,
  "y": 0,
  "width": 300,
  "height": 200,
  "text": "# Title\n\nContent with **bold** and *italic*.",
  "color": "4"
}
```

**Supported Markdown features:**

| Feature | Syntax |
|---------|--------|
| Headings | `# H1` through `###### H6` |
| Bold | `**text**` |
| Italic | `*text*` or `_text_` |
| Bold+Italic | `***text***` |
| Inline code | `` `code` `` |
| Code blocks | ` ```lang ` ... ` ``` ` |
| Links | `[text](url)` |
| Images | `![alt](url)` |
| Blockquotes | `> quote` |
| Unordered lists | `- item` or `* item` |
| Ordered lists | `1. item` |
| Horizontal rules | `---`, `***`, `___` |
| Auto-links | `<https://url>` |
| Wiki-links and embeds | `[[Note]]`, `[[Note\|Alias]]`, `![[image.png]]` |
| Callouts | `> [!note]`, `> [!tip]`, `> [!warning]`, `> [!danger]`, etc. |
| Math | `$inline$` and `$$display$$` (KaTeX) |
| Mermaid diagrams | ` ```mermaid ` ... ` ``` ` |
| Tags | `#tag`, `#nested/tag` |
| Footnotes | `[^1]` references and `[^1]:` definitions |

### File Nodes

Reference notes and attachments within your vault. These render as clickable cards that link to the corresponding Rspress page or as embedded media when the file is available at build time.

```json
{
  "id": "n2",
  "type": "file",
  "x": 400,
  "y": 0,
  "width": 200,
  "height": 100,
  "file": "Welcome.md",
  "subpath": "#getting-started",
  "color": "5"
}
```

Markdown files (`.md`, `.mdx`, `.markdown`) are resolved to Rspress routes. Images, audio, video, and PDFs are embedded into generated pages as build-time data URLs. Other files remain link cards.

### Link Nodes

Reference external URLs.

```json
{
  "id": "n3",
  "type": "link",
  "x": 200,
  "y": 200,
  "width": 250,
  "height": 80,
  "url": "https://rspress.dev",
  "color": "2"
}
```

Enable `linkPreview: true` in plugin options to render an embedded iframe.

### Group Nodes

Visual containers for organizing other nodes.

```json
{
  "id": "n4",
  "type": "group",
  "x": -50,
  "y": -50,
  "width": 600,
  "height": 400,
  "label": "Project Overview",
  "background": "bg.png",
  "backgroundStyle": "cover",
  "color": "6"
}
```

Groups are visual containers rendered according to their canvas array z-order, with a dashed border and optional label. Background images support `cover`, `ratio`, and `repeat` styles.

## Edges

Edges render as smooth cubic Bézier curves between the requested node sides. The renderer does not perform orthogonal routing or collision avoidance.

```json
{
  "id": "e1",
  "fromNode": "n1",
  "fromSide": "right",
  "fromEnd": "arrow",
  "toNode": "n2",
  "toSide": "left",
  "toEnd": "none",
  "color": "3",
  "label": "references"
}
```

| Field | Values | Default |
|-------|--------|---------|
| `fromSide` | `top`, `right`, `bottom`, `left` | center of node |
| `toSide` | `top`, `right`, `bottom`, `left` | center of node |
| `fromEnd` | `none`, `arrow` | `none` |
| `toEnd` | `none`, `arrow` | `arrow` |
| `color` | hex or preset `"1"`–`"6"` | `#999999` |
| `label` | any string | none |

Hovering or selecting a node highlights all connected edges. Heading subpaths (`#heading`) and block subpaths (`#^block-id`) are resolved for Markdown file cards.

## Colors

Both nodes and edges support the `canvasColor` type:

- **Hex**: `"#ff0000"`
- **RGB**: `"rgb(255, 0, 0)"`
- **Preset**: `"1"` (red), `"2"` (orange), `"3"` (yellow), `"4"` (green), `"5"` (cyan), `"6"` (purple)

## Editor and persistence

The default viewer is read-only. With `editable: true`, cards and edges can be created, moved, resized, deleted, and multi-selected in browser memory. Export the modified JSON Canvas and copy it back into the vault before the next build; the plugin never writes directly to `.canvas` files.
