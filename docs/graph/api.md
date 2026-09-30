---
title: API Reference
description: Public exports of the graph view plugin — graphview(), its options interface, and the GraphPanel and GraphSidebar runtime components.
---

# API Reference

## Plugin Exports

### `graphview(options?)` — Plugin Factory

```ts
import { graphview } from 'rspress-plugin-obsidian';
```

Creates an Rspress plugin instance. It is a named export of the shared entry, so
there is no default export to import.

### `RspressPluginGraphViewOptions`

```ts
interface RspressPluginGraphViewOptions {
  defaultOpen?: boolean;
  profileBuild?: boolean;
  onUnresolvedLink?: "error" | "warn" | "ignore"; // default "warn"
  colors?: GraphViewColors;
  cacheDir?: string; // directory for the persisted parse cache
  enableHoverPreviews?: boolean;
  enableDefaultStyles?: boolean;
  groups?: readonly GraphViewGroup[]; // colour groups for matching nodes
}

interface GraphViewGroup {
  query: string; // the panel search language: text, path:, file:, tag:, -negation
  color: string; // any CSS colour; invalid values fall back to the palette
}
```

`profileBuild` can also be enabled temporarily with the `RSPRESS_GRAPH_VIEW_PROFILE=1` environment variable.

`groups` colours panel nodes that match `query` — first match wins, the current page keeps its own colour, and the query language is the search box's own, so a group can be prototyped by typing it into the panel first.

## Runtime Components

### `GraphPanel`

```tsx
import GraphPanel from 'rspress-plugin-obsidian/graph/runtime/GraphPanel';
```

Floating graph panel used by the plugin's automatic `globalUIComponents` integration.

### `GraphSidebar`

```tsx
import GraphSidebar from 'rspress-plugin-obsidian/graph/runtime/GraphSidebar';
```

Optional embedded graph component for custom themes or layout slots. It reads the same generated graph data as the floating panel and supports the same `colors` overrides.

## Related

- [Getting Started](./guide/getting-started.md)
- [Configuration](./guide/configuration.md)
- [Graph View](./guide/graph-view.md)
