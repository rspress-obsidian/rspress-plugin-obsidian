---
title: Configuration
description: Every graph view option — defaultOpen, colors, groups, hover previews, styles, plus build reuse, dev refresh, diagnostics, and peer requirements.
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
| `defaultOpen` | `boolean` | `false` | Open the graph panel by default when the site loads (not on screens narrower than 640px) |
| `profileBuild` | `boolean` | `false` | Log graph build counts, timings and module reuse |
| `colors` | `GraphViewColors` | Light/dark palette | Override the graph palette — see [Custom Colors](#custom-colors) |
| `enableHoverPreviews` | `boolean` | `false` | Show Obsidian's Page preview when a link in the article is hovered: the linked note rendered in a scrollable popover, sliced to the section or block a `#heading` or `#^block` link names |
| `enableDefaultStyles` | `boolean` | `false` | Inject the bundled graph-panel stylesheet; unnecessary if you import `rspress-plugin-obsidian/styles.css` instead |
| `groups` | `GraphViewGroup[]` | `[]` | Colour groups: nodes matching the group's query paint in its colour — see [`groups`](#groups) |
| `onUnresolvedLink` | `"warn" \| "error" \| "ignore"` | `"warn"` | What to do about a link that resolves to nothing — see [Broken Link Diagnostics](#broken-link-diagnostics) |

You can also enable build profiling ad hoc with the `RSPRESS_GRAPH_VIEW_PROFILE=1` environment variable — useful for debugging slow builds without changing config.

### `defaultOpen`

When `true`, the graph panel opens automatically on page load instead of requiring the user to click the FAB button. Useful for documentation sites where the graph is a primary navigation tool. The visitor's own toggle (remembered in `localStorage`) takes precedence after the first visit. On screens narrower than 640px the panel would cover about half the article, so it starts closed there; a reader who opens it keeps it open.

```ts
graphview({ defaultOpen: true })
```

### `profileBuild`

When enabled, the plugin logs what each graph build did:

```
[rspress-plugin-obsidian:graph] graph build | routes=42 | nodes=51 | links=87 | resolvedLinks=93 | filesRead=1 | reusedModule=false | total=6.3ms
```

- `resolvedLinks` — outlinks run through the markdown resolver in this build
- `filesRead` — files the graph read itself (canvas boards, pages no content index covers, and notes whose text changed since the last build); the content index's own reads are not counted
- `reusedModule=true` — nothing changed, so the previous modules were reused without resolving or reading anything

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

The query language is the same one the panel's search box accepts (see [Graph View: Filters and search](./graph-view.md#filters-and-search)), so type the query into the search first to see exactly which nodes a group would colour. A group that uses `content:`, `line:`, `section:` or plain words matches note text once the panel has loaded it. Groups are checked in order and the first match wins; the current page always keeps its dedicated colour, and a colour `CSS.supports` rejects falls back to the palette rather than corrupting the canvas.

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

Available color keys: `currentNode`, `currentLabel`, `node`, `nodeHover`, `nodeDimmed`, `tagNode`, `attachmentNode`, `unresolvedNode`, `label`, `labelHover`, `labelShadow`, `link`, `linkHighlight`, `fallbackLinkDim`, `loaderBorder`, `loaderTop`.

Any unspecified key falls back to the default light or dark palette.

## Link resolution, rebuilds and `rspress dev`

The graph does not parse pages itself. It reads each note's links from the
markdown plugin's content index and resolves them with the markdown plugin's
resolver, the same index and options the rendered page and its Backlinks pane
use. With `markdown()` installed it reuses that plugin's cached index; without
it, the graph indexes the Rspress `root` itself with the default options.

- **Unchanged site**: the previous modules are reused. No link is resolved and no
  file is read.
- **One note edited**: the index re-parses that note, the graph resolves the
  site's links again (a few milliseconds for a thousand notes), and only that
  note's text is read again for previews and search.
- **`rspress dev`**: the graph watches the docs root and the vault and pushes new
  graph and preview data to the browser after an edit. A note added or removed
  under the vault still needs a dev-server restart, because Rspress fixes its
  route list when it starts.

Nothing is cached on disk. Earlier versions kept a `cacheDir` parse cache; that
option is gone.

## Broken Link Diagnostics

During the build, the plugin resolves every internal link a page makes. Links that resolve to nothing (typos, moved files, notes not written yet) are reported to the console:

```
[rspress-plugin-obsidian:graph] 2 page(s) reference 3 unresolved internal link(s):
  /guide/getting-started -> ./confguration
  /guide/configuration -> ../missing
  /api -> Not Yet Written
```

This is a build-time warning, and the build still succeeds. Links to attachments (`![[diagram.png]]`, `[spec](assets/spec.pdf)`) resolve to attachment nodes, and root-absolute site URLs such as `/downloads/app.zip` are not page links, so neither is reported.

`onUnresolvedLink` decides what happens instead:

| Value | Effect |
|-------|--------|
| `"warn"` (default) | Report as above; the build still succeeds |
| `"error"` | Fail the build with the same report |
| `"ignore"` | Say nothing |

Two cases reach for `"ignore"`. A site that documents unresolved links *on
purpose* — showing readers what a broken wikilink looks like — would otherwise
report its own example on every build. And a site running the markdown plugin
already hears about every unresolved wikilink through its own
[`onBrokenLink`](/markdown/guide/api) setting, so the graph's copy is a second
report of the same fact:

```ts
graphview({ onUnresolvedLink: "ignore" });
```

The graph itself does not change either way. An unresolved link appears as an
unresolved node, which the panel hides while **Existing files only** is on (the
default).

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
