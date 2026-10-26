---
title: API Reference
description: Every graphview() option with its type and default, the colors keys with their light and dark defaults, the stylesheet subpaths, and the GraphPanel and GraphSidebar components.
---

# API Reference

This page lists every option of `graphview()` and every key of its `colors` palette. For worked examples of each option, see [Configure the Graph View](./guide/configuration.md).

## `graphview(options?)`

```ts
import { graphview } from "rspress-plugin-obsidian";
```

Returns an Rspress plugin. `graphview` is a named export of the package entry (and of `rspress-plugin-obsidian/graph`). Every option is optional.

| Option | Type | Default | What it does |
|--------|------|---------|--------------|
| `defaultOpen` | `boolean` | `false` | Open the panel when a page loads. It does not apply on screens narrower than 640 px, and a reader's own open/close choice, stored in `localStorage`, wins over it. |
| `colors` | `GraphViewColors` | built-in palette | Override palette colours. See [`colors`](#colors). |
| `groups` | `readonly GraphViewGroup[]` | none | Colour groups: a node that matches a group's `query` is drawn in its `color`. See [`groups`](#groups). |
| `enableHoverPreviews` | `boolean` | `false` | Show Obsidian's Page preview when a reader rests the mouse on a link in the article. |
| `enableDefaultStyles` | `boolean` | `false` | Add the graph stylesheet to the site through Rspress `globalStyles`. Leave it off if you import the stylesheet yourself (see [Stylesheets](#stylesheets)). |
| `onUnresolvedLink` | `"warn" \| "error" \| "ignore"` | `"warn"` | What the build does about a link that resolves to nothing: report it, fail the build, or stay quiet. |
| `profileBuild` | `boolean` | `RSPRESS_GRAPH_VIEW_PROFILE === "1"` | Log each graph build's counts and timings. Unset, it follows the environment variable, so `RSPRESS_GRAPH_VIEW_PROFILE=1` turns it on without a config change. |

The options interface and the types of its `colors` and `groups` are exported
as types, from the package entry and from `rspress-plugin-obsidian/graph`:

```ts
import type {
  GraphViewColors,
  GraphViewGroup,
  RspressPluginGraphViewOptions,
} from "rspress-plugin-obsidian";
```

The graph keeps no cache on disk. The `cacheDir` option of `rspress-plugin-graph-view` no longer exists.

### `groups`

```ts
interface GraphViewGroup {
  query: string; // the panel's search syntax
  color: string; // any CSS colour
}
```

- `query` uses the [search syntax](./guide/graph-view.md#search) of the panel's search box.
- Groups are checked in order and the first match wins.
- The current page keeps its own colour (`currentNode`).
- A `color` the browser rejects (`CSS.supports("color", …)` is false) falls back to the palette.

### `colors`

`colors` is a partial palette: set only the keys you want to change. The panel picks the light or the dark palette from the site theme, then applies your keys on top, so **an override applies in both themes**.

| Key | What it colours | Light default | Dark default |
|-----|-----------------|---------------|--------------|
| `node` | Note nodes | `#9a9a9a` | `#8a8a8a` |
| `nodeHover` | The hovered node | `#4f4f4f` | `#b8b8b8` |
| `nodeDimmed` | Nodes outside the hovered node's neighbourhood | `rgba(154, 154, 154, 0.28)` | `rgba(138, 138, 138, 0.3)` |
| `currentNode` | The current page's node | `#5b5b5b` | `#d4d4d4` |
| `tagNode` | Tag nodes | `#5f9e6e` | `#7fbf8e` |
| `attachmentNode` | Attachment nodes (images, PDFs, …) | `#b8913a` | `#d1ad5b` |
| `unresolvedNode` | Links to notes that do not exist yet | `#c9c9c9` | `#555555` |
| `label` | Node labels | `#4a4a4a` | `#9a9a9a` |
| `labelHover` | The hovered node's label | `#1a1a1a` | `#ffffff` |
| `currentLabel` | The current page's label | `#1a1a1a` | `#ffffff` |
| `labelShadow` | The outline drawn behind every label | `rgba(255, 255, 255, 0.9)` | `rgba(24, 24, 24, 0.85)` |
| `link` | Links at rest | `rgba(218, 218, 218, 0.85)` | `rgba(63, 63, 63, 0.9)` |
| `linkHighlight` | Links touching the hovered node, or the hovered link | `rgba(90, 90, 90, 0.85)` | `rgba(200, 200, 200, 0.85)` |
| `fallbackLinkDim` | The other links while something is hovered | `rgba(218, 218, 218, 0.35)` | `rgba(63, 63, 63, 0.4)` |
| `loaderBorder` | Loading spinner ring | `rgba(90, 90, 90, 0.2)` | `rgba(160, 160, 160, 0.2)` |
| `loaderTop` | Loading spinner's moving arc | `#5b5b5b` | `#d4d4d4` |

The theme is dark when `<html>` has the `dark` class or `data-theme="dark"`; the panel follows a theme switch while it is open.

## Stylesheets

The panel styles itself inline. The graph stylesheet adds the hover-preview popover's look and stops the panel's animations for readers who prefer reduced motion.

| Import | Contains |
|--------|----------|
| `rspress-plugin-obsidian/graph/styles.css` | The graph stylesheet only |
| `rspress-plugin-obsidian/styles.css` | The Markdown, Canvas and Graph View stylesheets together |

Load it with `enableDefaultStyles: true`, or `@import` one of these from a CSS file the bundler builds. See [Add the stylesheet](./guide/getting-started.md#add-the-stylesheet).

## Runtime components

The plugin mounts the floating panel on every page for you. Import these only to build a custom layout.

### `GraphSidebar`

```tsx
import GraphSidebar from "rspress-plugin-obsidian/graph/runtime/GraphSidebar";
```

A collapsible graph of the current page's neighbourhood with zoom buttons, sized to its container, for a custom theme or layout slot. It reads the same graph data as the floating panel. Props: `colors?: GraphViewColors`. See [Embed the graph in your layout](./guide/configuration.md#embed-the-graph-in-your-layout).

### `GraphPanel`

```tsx
import GraphPanel from "rspress-plugin-obsidian/graph/runtime/GraphPanel";
```

The floating panel the plugin already mounts on every page. Props: `defaultOpen`, `colors`, `groups`, and `readerRequested` (the reader opened the panel before its code loaded, so it takes focus). Rendering a second one shows a second button and panel; use `GraphSidebar` for an embedded graph.
