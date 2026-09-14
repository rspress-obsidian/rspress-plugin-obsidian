---
description: Interactive graph view and hover previews for your documentation.
---

# Graph Features

This section covers the graph-related features: the interactive graph view and hover previews.

## Graph View

The graph visualizes the current page's link neighborhood as a force-directed field — the current page and its direct neighbors are nodes, the links between them are edges.

### Setup

```ts
import { pluginGraphview } from "rspress-plugin-obsidian";

export default defineConfig({
  plugins: [
    pluginGraphview({
      defaultOpen: false,    // Start with panel open
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
| Uniform node size | All nodes render at the same size |
| Click to navigate | Click any node to go to that page |
| Drag to reposition | Drag nodes to rearrange the layout |
| Zoom/pan | Mouse wheel to zoom, drag background to pan |
| Fullscreen mode | Expand to fullscreen for better overview |
| Keyboard shortcut | Press `g` to toggle the graph panel |
| Dark mode | Automatically adapts to theme |

### Controls

| Control | Action |
|---------|--------|
| FAB button (bottom-right) | Toggle graph panel |
| `g` key | Toggle graph panel |
| `Escape` | Close panel |
| Mouse wheel | Zoom in/out |
| Drag node | Reposition node |
| Drag background | Pan view |
| Click node | Navigate to page |

## Hover Previews

Hover previews show a tooltip with page content when hovering over internal links.

### Setup

```ts
pluginGraphview({
  enableHoverPreviews: true,
});
```

### Features

- Shows page title and content preview
- Appears after 300ms hover delay
- Disappears when mouse leaves
- Works on all internal links (`a[data-route-path]`)

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
| `defaultOpen` | `boolean` | `false` | Start with graph panel open |
| `profileBuild` | `boolean` | `false` | Log build performance |
| `colors` | `object` | See below | Custom color scheme |
| `cacheDir` | `string` | Auto | Cache directory for parsed data |
| `enableHoverPreviews` | `boolean` | `false` | Enable hover previews |

### Default Colors

The runtime uses a light/dark palette automatically. Key keys you can override:

```ts
{
  node: "#9a9a9a",       // Node fill
  nodeHover: "#4f4f4f",  // Hovered node
  nodeDimmed: "rgba(154,154,154,0.28)", // Non-neighbor on hover
  link: "rgba(218,218,218,0.85)",   // Link stroke
  currentNode: "#5b5b5b", // Current page node
}
```
