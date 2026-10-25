---
title: Canvas Format
description: How each JSON Canvas 1.0 card type, edge and colour renders, the Markdown a text card supports, and the board's viewer controls.
---

# Canvas Format

This page describes what a published board shows for each part of a `.canvas`
file. Obsidian saves boards in the [JSON Canvas 1.0](https://jsoncanvas.org/)
format, and the plugin renders that format as Obsidian does. Read this page when
a card does not look the way you expect.

The plugin checks each card and edge when it publishes a board. A malformed card
is dropped and named in a console message; a duplicate `id` keeps the first
card; an edge whose card was dropped is dropped too. The rest of the board still
renders.

## Text cards

A text card holds Markdown:

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

| Feature | Syntax |
|---------|--------|
| Headings | `# H1` through `###### H6` |
| Bold, italic | `**text**`, `*text*` or `_text_`, `***text***` |
| Inline code and code blocks | `` `code` ``, ` ```lang ` … ` ``` ` |
| Links and images | `[text](url)`, `![alt](url)`, `<https://url>` |
| Blockquotes | `> quote` |
| Lists | `- item`, `* item`, `1. item` |
| Horizontal rules | `---`, `***`, `___` |
| Wikilinks and embeds | `[[Note]]`, `[[Note\|Alias]]`, `![[image.png]]`, `![[Note#Heading]]`. They resolve as in Obsidian: see [`fileRoutePrefix`](./configuration.md#filerouteprefix). |
| Transclusion | `![[Note]]` inlines any published note, whether or not it is also a card on the board. |
| Callouts | `> [!note]`, `> [!tip]`, custom types such as `> [!my-type]`, foldable `> [!faq]-` and `> [!faq]+` |
| Highlights | `==text==` |
| Math | `$inline$` and `$$display$$` |
| Mermaid diagrams | ` ```mermaid ` … ` ``` ` |
| Tags | `#tag`, `#nested/tag` |
| Footnotes | `[^1]` references with `[^1]:` definitions, and `^[inline notes]`, numbered together |
| Raw HTML | Tags without attributes, such as `<u>`, `<br>`, `<sub>`, `<kbd>`, `<details>` and `<summary>`. A tag with attributes is shown as text. |

Cards render all of these whatever options the markdown plugin has: you do not
need `enableCallouts`, `enableMath` or `enableMermaid` for cards. A
` ```dataview ` block is shown as a code block, because a query needs the
build-time page index, which the browser does not have.

Card text is escaped for the place it appears in: link targets, alt text and
attributes cannot inject markup, and URLs with unsafe protocols such as
`javascript:` are not linked.

### Math

Cards typeset math with KaTeX in the browser. A board loads KaTeX's code and
stylesheet only when it has a formula, and it loads the stylesheet before it
typesets. The markdown plugin's `mathEngine: "mathjax"` applies to note pages
only. TeX that only MathJax supports, such as `\require{…}`, shows KaTeX's error
inside a card.

### Mermaid

Diagrams need the optional `mermaid` package. Without it, a diagram shows its
source with an install hint. Diagrams in cards always render with Mermaid's
`securityLevel: "strict"`, whatever the markdown plugin's `mermaidSecurityLevel`
is, so a `click` directive cannot run script. A diagram that fails to parse keeps
its source, marked as an error, and nothing else on the page changes.

## File cards

A file card names a note or attachment by its path in the vault, the way
Obsidian stores it. The file's name is shown above the card.

```json
{
  "id": "n2",
  "type": "file",
  "x": 400,
  "y": 0,
  "width": 200,
  "height": 100,
  "file": "Welcome.md",
  "subpath": "#Getting started",
  "color": "5"
}
```

| File | Card |
|------|------|
| A published note (`.md`, `.mdx`) | The note's content, without frontmatter. The name above links to the note's page. A `subpath` (`#Heading`, `#Parent#Child`, `#^block`) shows only that section, cut the same way a transclusion cuts it. If the note has no such section, the card shows the whole note with a short notice. |
| A `publish: false` note, or a missing file | A "not available" card. The note's text is never published. |
| An image | The image alone, as in Obsidian. |
| Audio or video | A player. |
| A PDF | The PDF viewer. `#page=3` opens at that page. |
| Another `.canvas` | A card that links to that board's page. |
| Any other file (`.zip`, `.docx`, …) | The file name and a download link. |

Attachments are published as files at the same `<fileRoutePrefix>/<vault path>`
URL the markdown plugin uses, and the board refers to them by URL.

## Link cards

A link card names a web page:

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

As in Obsidian, the card shows the website itself in a sandboxed frame, with
its address above the card. Set [`linkPreview: false`](./configuration.md#linkpreview-and-iframesandbox)
for a plain link instead.

## Groups

A group is a labelled box that holds other cards:

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

The label sits above the group's top-left corner. `background` is a vault path,
published like any attachment, or an `http(s)` URL; `backgroundStyle` is
`cover`, `ratio` or `repeat`. The collapse button on a group hides the cards
inside it until you expand it again or reload the page.

Groups always paint beneath the edges, and the edges beneath every other card.
Within each layer, the order of the `nodes` array is the stacking order, as the
spec says.

## Edges

An edge is a curved arrow between two cards:

```json
{
  "id": "e1",
  "fromNode": "n1",
  "fromSide": "right",
  "fromEnd": "none",
  "toNode": "n2",
  "toSide": "left",
  "toEnd": "arrow",
  "color": "3",
  "label": "references"
}
```

| Field | Values | Default |
|-------|--------|---------|
| `fromSide`, `toSide` | `top`, `right`, `bottom`, `left` | The side that faces the other card, as in Obsidian |
| `fromEnd` | `none`, `arrow` | `none` |
| `toEnd` | `none`, `arrow` | `arrow` |
| `color` | A [colour](#colours) | The theme's edge colour (`--canvas-edge-color`) |
| `label` | Any text, including line breaks | None |

The label sits on the middle of the curve. Edges are drawn as Bézier curves; they
do not route around cards. Hovering or selecting a card highlights its edges.

## Colours

Cards and edges take a `color`:

- a preset: `"1"` red, `"2"` orange, `"3"` yellow, `"4"` green, `"5"` cyan,
  `"6"` purple, in Obsidian's palette for light and dark mode;
- a hex colour such as `"#ff0000"`, or `"rgb(255, 0, 0)"`.

A coloured card shows the colour on its border over a light tint of it, so its
text stays readable. To change the palette, see [Styling](./styling.md#colours).

## Viewer controls

A board page is read-only unless you turn on the
[editor](./configuration.md#editor). The **?** button in the toolbar lists these
controls:

| Action | Mouse or touch | Keyboard |
|--------|----------------|----------|
| Pan | Drag anywhere, cards included; one finger on a touch screen | Arrow keys (`Shift` for larger steps) |
| Zoom | Scroll, pinch, or the ＋ and − buttons | `+` and `-` |
| Fit the board to the view | Double-click the background, or the ⛶ button | `F` |
| Zoom to 100% | The ◎ button | `0` |

The `.canvas` format stores no viewport, so the browser keeps each board's last
pan and zoom and restores it on your next visit. A first visit fits the board
to the view. A board [embedded in a page](./embed.mdx) leaves a plain scroll to
the page.

## Graph View

With [`graphview()`](/graph/) enabled, each board is a node in the graph. It
links to the note or file of each file card, and to the links and tags in its
text cards, as Obsidian's graph reads a canvas. Link cards, groups and the
board's own edges add nothing. See
[Graph View → Obsidian content support](/graph/guide/graph-view#obsidian-content-support).
