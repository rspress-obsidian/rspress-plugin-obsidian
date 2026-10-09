---
description: Interactive graph view and hover previews for your documentation.
---

# Graph Features

This section covers the graph-related features: the interactive graph view and hover previews.

## Graph View

The graph draws your pages and the links between them as a force-directed field, either the current page's neighborhood (the local graph) or the whole site (the global graph). Tags, attachments and links to notes that do not exist yet can be shown as nodes, and the settings drawer offers Obsidian's Filters, Display and Forces settings. See [Graph View](./guide/graph-view.md).

### Setup

```ts
import { graphview } from "rspress-plugin-obsidian";

export default defineConfig({
  plugins: [
    graphview({
      defaultOpen: false,    // Start with panel closed (true = open)
      colors: {              // Custom colors
        node: "#3b82f6",
        link: "#94a3b8",
        currentNode: "#f59e0b",
      },
    }),
  ],
});
```

### Features

| Feature | Description |
|---------|-------------|
| Force-directed layout | Nodes auto-arrange based on connections |
| Node size by links | Nodes grow with their number of links; the Node size setting scales them |
| Obsidian settings | Filters, Display (arrows, text fade, node size, link thickness, animate) and Forces |
| Search | Obsidian's search syntax, including `OR`, `/regex/`, `content:`, `line:` and `section:` |
| Click to navigate | Click any node to go to that page |
| Drag to reposition | Drag nodes to rearrange the layout |
| Zoom/pan | Mouse wheel to zoom, drag background to pan |
| Fullscreen mode | Expand to fullscreen for better overview |
| Keyboard shortcut | Press `g` to toggle the graph panel |
| Keyboard access | Every node you can open is also listed as a link for keyboard and screen-reader users |
| Dark mode | Automatically adapts to theme |

### Controls

| Control | Action |
|---------|--------|
| FAB button (bottom-right) | Toggle graph panel |
| `g` key | Toggle graph panel |
| `Escape` | Clear the search, then close the panel (when focus is in the panel) |
| Mouse wheel | Zoom in/out |
| Drag node | Reposition node |
| Drag background | Pan view |
| Click node | Navigate to page (Cmd/Ctrl-click: new tab) |

## Hover Previews

Hover previews reproduce Obsidian's Page preview: hovering a link in a page
shows the linked note, rendered, in a popover you can scroll.

### Setup

```ts
graphview({
  enableHoverPreviews: true,
});
```

### Features

- Shows the linked note as its own page renders it: headings, lists, callouts,
  code, tables, math, images and Mermaid diagrams
- A `[[Note#Heading]]` link shows only that section, a `[[Note#^block]]` link
  only that block, and `[[#Heading]]` works on the same page
- Opens after the mouse rests on a link for 300 ms, under the hovered line of
  the link, or above it when there is no room below
- Stays open while the pointer is on the link or in the popover, so a long
  note can be scrolled; closes 300 ms after the pointer leaves both, and on
  Escape, a click elsewhere, a page scroll or navigation
- Fires only for links in the article and only for a mouse: the sidebar, nav,
  outline, heading anchors, footnote markers, touch and pen never open one
- Works on any link whose `href` resolves to a route — plugin wikilinks, tag
  pages and Rspress's own page links, with or without the site `base`, an
  `.html` suffix, a query, or percent-encoding (`/My%20Note`)
- Loads nothing extra: the popover renders the page's own module, which
  Rspress already fetches when the pointer enters the link, so it works the
  same in `rspress dev` and with SSG off

### Styling

The popover is a 450 px wide, at most 400 px tall `.obsidian-hover-preview`
element above the graph panel, styled by `graph-panels.css` (included in
`rspress-plugin-obsidian/styles.css`). The note inside keeps the site's article
typography at 87.5%, on the page background in light and dark themes, and
fades in unless the reader prefers reduced motion.

## Configuration Reference

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultOpen` | `boolean` | `false` | Start with the graph panel expanded, except on screens narrower than 640px (a stored visitor preference overrides it) |
| `profileBuild` | `boolean` | `false` | Log build counts and timings |
| `colors` | `object` | See below | Custom color scheme |
| `enableHoverPreviews` | `boolean` | `false` | Enable hover previews |
| `enableDefaultStyles` | `boolean` | `false` | Inject the bundled panel stylesheet (already included in `rspress-plugin-obsidian/styles.css`) |
| `groups` | `GraphViewGroup[]` | `[]` | Colour groups |
| `onUnresolvedLink` | `"warn" \| "error" \| "ignore"` | `"warn"` | What to do about a link that resolves to nothing |

### Default Colors

The runtime uses a light/dark palette automatically. Key keys you can override:

```ts
{
  node: "#9a9a9a",       // Node fill
  nodeHover: "#4f4f4f",  // Hovered node
  nodeDimmed: "rgba(154,154,154,0.28)", // Non-neighbor on hover
  link: "rgba(218,218,218,0.85)",   // Link stroke
  currentNode: "#5b5b5b", // Current page node
  tagNode: "#5f9e6e",     // Tag nodes
  attachmentNode: "#b8913a", // Attachment nodes
  unresolvedNode: "#c9c9c9", // Links to notes that do not exist yet
}
```
