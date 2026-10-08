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

Hover previews show a tooltip with page content when hovering over internal links.

### Setup

```ts
graphview({
  enableHoverPreviews: true,
});
```

### Features

- Shows page title and a plain-text content preview — the body is reduced to
  prose at build time (heading, emphasis, link and code markers stripped), so a
  preview never ships raw markdown syntax and stays bounded in size
- Comments (`%%…%%`, `<!-- … -->`) are left out, as the page leaves them out
- The preview data loads on the first hover over an internal link, not with the page
- Appears after 300ms hover delay
- Disappears when mouse leaves
- Works on any internal link whose `href` resolves to a generated route — plugin
  wikilinks, tag pages and Rspress's own page links. Hrefs are percent-decoded
  (so `/My%20Note` finds `My Note`), and the site `base`, an `.html` suffix, a
  query and an `#anchor` are removed before the lookup.

### Styling

The preview popup has:
- Fixed positioning
- Max width: 320px
- Max height: 240px
- Scrollable content area
- Dark mode support

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
