---
title: Canvas Format
description: Full JSON Canvas 1.0 spec support — node types, edges, colors, and Markdown features.
---

# Canvas Format

This plugin parses and renders the JSON Canvas 1.0 structure in the browser. Boards are read-only by default; the `editable` option adds editing controls. Parsed boards preserve the node array z-order and validate required fields, IDs, geometry, edge references, and enum values.

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
| Wiki-links and embeds | `[[Note]]`, `[[Note\|Alias]]`, `![[image.png]]`, `![[Note#Heading]]` — resolved like Obsidian (shortest path, vault-absolute, relative to the board's folder) |
| Note transclusion | `![[Note]]` inlines any published note, whether or not it is also a card on the board |
| Callouts | `> [!note]`, `> [!tip]`, custom types such as `> [!my-type]`, foldable `> [!faq]-` / `> [!faq]+` |
| Highlights | `==text==` |
| Math | `$inline$` and `$$display$$` |
| Mermaid diagrams | ` ```mermaid ` ... ` ``` ` (needs the optional `mermaid` package installed; without it the diagram source is shown with an install hint) |
| Tags | `#tag`, `#nested/tag` |
| Footnotes | `[^1]` references, `[^1]:` definitions and `^[inline notes]`, numbered together |
| Raw HTML | attribute-less tags such as `<u>`, `<br>`, `<sub>`, `<kbd>`, `<details>`/`<summary>`; any tag with attributes is shown as text |

Card text is rendered by a context-aware Markdown renderer: link targets, image
alt text and every attribute are escaped for the place they appear, so text
like `![x [[a onerror=alert(1) b]]](x.png)` renders inert, and any number of
links or code spans in one card render in order.

Math in cards is typeset with KaTeX, which is loaded only on boards that
contain a formula. The markdown plugin's `mathEngine: "mathjax"` applies to note
pages only: a card always uses KaTeX, so TeX that only MathJax implements (for
example `\require{…}`) shows KaTeX's error rendering inside a card.

### File Nodes

Reference notes and attachments within your vault by their vault path, the way
Obsidian stores them. The file's name is shown above the card, as in Obsidian.

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

| File | Card |
|------|------|
| A published note (`.md`, `.mdx`) | The note's rendered content (frontmatter stripped), with its name above linking to the note's page. A `subpath` (`#Heading`, `#Parent#Child`, `#^block`) shows just that section, sliced by the same code the markdown plugin transcludes with; a subpath the note does not contain shows the whole note with a short notice. |
| A `publish: false` note, or a missing file | A "not available" card. The note's text is never published. |
| An image | The bare image, like Obsidian, with its file name above. |
| Audio / video | A player. |
| A PDF | The PDF viewer in an unsandboxed frame (Chromium's viewer refuses to run sandboxed); `#page=3` opens at a page. |
| Another `.canvas` | A card linking to that board's page. |
| Anything else (`.zip`, `.docx`, …) | The file name and a download link. |

Attachments are published as files, at the same `<fileRoutePrefix>/<vault
path>` URL the markdown plugin uses, and referenced by URL — never inlined into
the page.

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

Like Obsidian, a link node shows the website itself in a sandboxed frame, with
its address above the card. Set `linkPreview: false` for a plain link card.

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

Groups are containers with a label above their top-left corner; a coloured
group carries its colour on the border, the label and a translucent tint.
Groups always paint beneath the edges, and the edges beneath every other card;
within each band the order of the `nodes` array is the stacking order, as the
spec says. `background` is a vault path (published like any attachment) or an
`http(s)` URL, and supports the `cover`, `ratio`, and `repeat` styles.

## Edges

Edges render as smooth cubic Bézier curves between the requested node sides. When a side is omitted (the spec allows it), the edge attaches to the sides the two nodes face, as Obsidian does. The label sits on the curve's own midpoint, in a themed box, and may span several lines. The renderer does not perform orthogonal routing or collision avoidance.

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
| `fromSide` | `top`, `right`, `bottom`, `left` | the side facing the other node |
| `toSide` | `top`, `right`, `bottom`, `left` | the side facing the other node |
| `fromEnd` | `none`, `arrow` | `none` |
| `toEnd` | `none`, `arrow` | `arrow` |
| `color` | hex or preset `"1"`–`"6"` | theme default (`var(--canvas-edge-color)` — `#94a3b8` light / `#444444` dark) |
| `label` | any string | none |

Hovering or selecting a node highlights all connected edges. Heading subpaths (`#heading`) and block subpaths (`#^block-id`) are resolved for Markdown file cards.

## Colors

Both nodes and edges support the `canvasColor` type:

- **Hex**: `"#ff0000"`
- **RGB**: `"rgb(255, 0, 0)"`
- **Preset**: `"1"` (red), `"2"` (orange), `"3"` (yellow), `"4"` (green), `"5"` (cyan), `"6"` (purple), in Obsidian's own palette for light and dark mode

A coloured card shows the colour on its border over a translucent tint of it —
presets and custom colours alike — so text stays readable on any colour.

## Editor and persistence

The default viewer is read-only: drag anywhere (cards included) to pan, scroll
or pinch to zoom, and use the arrow keys, `F` (fit) and `0` (1:1) from the
keyboard. On touch screens one finger pans and two fingers pinch-zoom. With
`editable: true`, cards and edges can be created, moved, resized, deleted, and
multi-selected in browser memory. Export the modified board and copy it back
into the vault before the next build; the plugin never writes directly to
`.canvas` files. Fields the plugin does not understand are kept in the export.

## Graph integration

With `graphview()` enabled, Canvas references can contribute to the documentation graph:

- Markdown file nodes create edges to the matching published page;
- wikilinks, Markdown links, and tags inside text nodes are extracted;
- image, audio, video, PDF, and external URL nodes remain Canvas assets rather than graph nodes;
- Canvas-only visual edges are intentionally kept inside the Canvas view.

See the [Graph View guide](/graph/guide/graph-view#obsidian-content-support) for the combined setup.
