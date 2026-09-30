---
title: Configuration
description: Every graph view option — defaultOpen, colors, groups, cacheDir, hover previews, styles, plus caching, diagnostics, and peer requirements.
---

# Configuration

Configure the graph view plugin in your `rspress.config.ts`:

```ts
import { defineConfig } from "@rspress/core";
import { graphview } from "rspress-plugin-obsidian";

export default defineConfig({
  root: "docs",
  plugins: [
    graphview({
      defaultOpen: false,
      profileBuild: false,
    }),
  ],
});
```

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `defaultOpen` | `boolean` | `false` | Open the graph panel by default when the site loads |
| `profileBuild` | `boolean` | `false` | Log graph build timings, cache hits, and module reuse during route scanning |
| `colors` | `GraphViewColors` | Light/dark palette | Override the graph palette — see [Custom Colors](#custom-colors) |
| `cacheDir` | `string` | `<projectRoot>/node_modules/.cache/rspress-graph-view` | Directory for the persisted parse cache |
| `enableHoverPreviews` | `boolean` | `false` | Show a content preview when hovering an internal link |
| `enableDefaultStyles` | `boolean` | `false` | Inject the bundled graph-panel stylesheet; unnecessary if you import `rspress-plugin-obsidian/styles.css` instead |
| `groups` | `GraphViewGroup[]` | `[]` | Colour groups: nodes whose route matches the group's query paint in its colour — see [Colour Groups](#colour-groups) |
| `onUnresolvedLink` | `"warn" \| "error" \| "ignore"` | `"warn"` | What to do about a link that resolves to no route — see [Broken Link Diagnostics](#broken-link-diagnostics) |

You can also enable build profiling ad hoc with the `RSPRESS_GRAPH_VIEW_PROFILE=1` environment variable — useful for debugging slow builds without changing config.

### `defaultOpen`

When `true`, the graph panel opens automatically on page load instead of requiring the user to click the FAB button. Useful for documentation sites where the graph is a primary navigation tool. The visitor's own toggle (remembered in `localStorage`) takes precedence after the first visit.

```ts
graphview({ defaultOpen: true })
```

### `profileBuild`

When enabled, the plugin logs detailed timing information for each graph build:

```
[rspress-plugin-obsidian:graph] graph build | routes=42 | links=87 | cacheHits=40 | cacheMisses=2 | reusedModule=false | total=12.3ms | stat=1.2ms | parse=8.4ms | resolve=1.8ms | serialize=0.9ms
```

This helps identify bottlenecks:
- **High `stat` time** → many files being stat'd; consider reducing doc count
- **High `parse` time** → large files or cold cache; caching should help on rebuilds
- **High `reusedModule` rate** → content hasn't changed; build is fully cached

### `groups`

Colour groups tint graph nodes that match a query, the way Obsidian's colour groups work. Each group pairs a query in the panel's search language with a CSS colour:

```ts
graphview({
  groups: [
    { query: "path:api", color: "#f97316" },
    { query: "tag:project", color: "#22c55e" },
    { query: "-path:api", color: "#94a3b8" },
  ],
});
```

The query language is the same one the panel's search box accepts — plain text, `path:`, `file:`, `tag:`, `-` negation and quoted phrases — so type the query into the search first to see exactly which nodes a group would colour. Groups are checked in order and the first match wins; the current page always keeps its dedicated colour, and a colour `CSS.supports` rejects falls back to the palette rather than corrupting the canvas.

## Custom Colors

You can override the default color palette to match your brand or theme. Pass it to the plugin — the colors reach the panel the plugin registers automatically:

```ts
graphview({
  colors: {
    currentNode: "#0ea5e9",
    nodeHover: "#38bdf8",
    linkHighlight: "rgba(14, 165, 233, 0.6)",
  },
});
```

To embed a graph in a custom theme or layout slot, use the runtime components directly and pass `colors` to them. Prefer `GraphSidebar` for embedded layouts: the floating `GraphPanel` is always registered by the plugin, so a second manual `<GraphPanel>` would show a duplicate FAB and panel.

```tsx
// In your custom theme or Layout wrapper
import { Layout } from "@rspress/core/theme-original";
import GraphSidebar from "rspress-plugin-obsidian/graph/runtime/GraphSidebar";

export default function CustomLayout(props) {
  return (
    <Layout {...props}>
      <GraphSidebar
        colors={{
          currentNode: "#0ea5e9",
          nodeHover: "#38bdf8",
          linkHighlight: "rgba(14, 165, 233, 0.6)",
        }}
      />
    </Layout>
  );
}
```

Available color keys: `currentNode`, `currentLabel`, `node`, `nodeHover`, `nodeDimmed`, `label`, `labelHover`, `labelShadow`, `link`, `linkHighlight`, `fallbackLinkDim`, `loaderBorder`, `loaderTop`.

Any unspecified key falls back to the default light or dark palette.

## Caching

The plugin uses a multi-level caching strategy:

1. **File cache** — Each document is cached by `mtimeMs` + `size`. Unchanged files skip reading and parsing entirely.
2. **Module cache** — If the graph structure hasn't changed (same files, same content), the serialized virtual module is reused without rebuilding.
3. **Disk cache** — Parse results (titles + links) are persisted to `<projectRoot>/node_modules/.cache/rspress-graph-view/cache.json`. Dev-server restarts skip the expensive markdown parsing entirely — only the fast graph resolution runs (~0.5ms for a small site).
4. **Stale pruning** — Deleted or moved routes are automatically removed from the cache on the next build.

The disk cache location can be overridden with the `cacheDir` plugin option:

```ts
graphview({
  cacheDir: "./.cache/graph-view", // custom cache location
})
```

This means:
- **Cold build** (first run or cache cleared): all files are read and parsed
- **Warm rebuild** (no changes): ~0ms, fully cached
- **Single-file change**: only the modified file is re-parsed; the rest hit cache
- **Dev-server restart**: parse results load from disk; no re-parsing

## Broken Link Diagnostics

During the build, the plugin resolves every internal markdown link to a page. Links that don't resolve to any route (typos, moved files, wrong paths) are reported to the console:

```
[rspress-plugin-obsidian:graph] 2 page(s) reference 3 unresolved internal link(s):
  /guide/getting-started -> ./confguration.md
  /guide/configuration -> ../missing.md
  /api -> ./guide/typo.md
```

This is a build-time warning — the build still succeeds, and unresolved links are simply omitted from the graph. It's a useful way to catch dead links in your docs.

`onUnresolvedLink` decides what happens instead:

| Value | Effect |
|-------|--------|
| `"warn"` (default) | Report as above; the build still succeeds |
| `"error"` | Fail the build with the same report |
| `"ignore"` | Say nothing; unresolved links are still omitted from the graph |

Two cases reach for `"ignore"`. A site that documents unresolved links *on
purpose* — showing readers what a broken wikilink looks like — would otherwise
report its own example on every build. And a site running the markdown plugin
already hears about every unresolved wikilink through its own
[`onBrokenLink`](/markdown/guide/api) setting, so the graph's copy is a second
report of the same fact:

```ts
graphview({ onUnresolvedLink: "ignore" });
```

The graph itself does not change either way: a link that resolves to no route
never becomes an edge.

## Peer Dependencies

| Package | Version | Required |
|---------|---------|----------|
| `@rspress/core` | `^2.0.21` | Yes |
| `react` | `^18 \|\| ^19` | Optional peer (required to render the panel) |
| `react-dom` | `^18 \|\| ^19` | Optional peer (required to render the panel) |
| `react-force-graph-2d` | `^1.29.1` | Optional peer (lazy-loaded by the runtime) |

These are the versions the package declares; `react`, `react-dom`, and
`react-force-graph-2d` are marked optional peers so a site that only uses the
markdown plugin is not forced to install them.

See also:
- [Getting Started](./getting-started.md)
- [Graph View](./graph-view.md)
- [API Reference](../api.md)
