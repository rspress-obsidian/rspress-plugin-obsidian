---
title: Configure the Graph View
description: How to open the panel by default, colour nodes with groups, change the palette, turn on hover previews, embed the graph in a custom layout, handle unresolved links and profile the graph build.
---

# Configure the Graph View

This page shows how to do the common configuration tasks with `graphview()`. Each option's type and default is in the [API Reference](../api.md).

## Open the panel by default

The panel starts closed. To open it when a page loads:

```ts
graphview({ defaultOpen: true });
```

On screens narrower than 640 px the panel would cover about half the article, so it still starts closed there. Once a reader opens or closes the panel, their choice is stored in `localStorage` and wins over `defaultOpen` on every later visit.

The panel's code downloads only when it opens. A panel that starts closed, because of `defaultOpen: false`, a phone-sized screen, or a reader who closed it, downloads nothing until the reader clicks the button or presses `g`.

The scope (local or global), depth, filters, display and forces are reader settings, kept per visitor in `localStorage`. No option sets their defaults, and the plugin does not read `.obsidian/graph.json`. See [Using the Graph View](./graph-view.md#settings).

## Colour nodes with groups

Colour groups tint the nodes that match a query, like Obsidian's colour groups. Each group pairs a query in the panel's search syntax with a CSS colour:

```ts
graphview({
  groups: [
    { query: "path:api", color: "#f97316" },
    { query: "tag:project", color: "#22c55e" },
    { query: "-path:api", color: "#94a3b8" },
  ],
});
```

- Groups are checked in order, and the first match wins.
- The current page always keeps its own colour.
- A colour the browser rejects falls back to the palette.
- A group whose query reads note text (`content:`, `line:`, `section:` or plain words) makes the panel load the note text as soon as it opens; its nodes take the colour when the text arrives.

To see which nodes a group will colour, type its query into the panel's search box first. The syntax is in [Using the Graph View: Search](./graph-view.md#search).

## Change the colours

`colors` overrides any key of the built-in palette; the keys you leave out keep their defaults:

```ts
graphview({
  colors: {
    currentNode: "#0ea5e9",
    nodeHover: "#38bdf8",
    linkHighlight: "rgba(14, 165, 233, 0.6)",
  },
});
```

The panel switches between a light and a dark palette with the site theme, and your overrides apply on top of both, so pick colours that read on both backgrounds. The [colour key table](../api.md#colors) lists every key with its light and dark default.

Without a group, nodes are coloured by kind: notes `node`, tags `tagNode`, attachments `attachmentNode`, links to missing notes `unresolvedNode`.

## Turn on hover previews

```ts
graphview({ enableHoverPreviews: true });
```

A reader who rests the mouse on a link in the article sees the linked note in a popover, as with Obsidian's Page preview. The popover renders the target page's own module, which Rspress already fetches when the pointer enters a link, so the option adds nothing to the build. Load the [graph stylesheet](./getting-started.md#add-the-stylesheet) to style the popover. What readers see is described in [Hover previews](./graph-view.md#hover-previews).

## Embed the graph in your layout

The plugin mounts the floating panel on every page. To show a graph inside your own layout as well, for example under the sidebar, render `GraphSidebar` from a custom theme:

```tsx
// theme/index.tsx
import { Layout as BaseLayout } from "@rspress/core/theme-original";
import GraphSidebar from "rspress-plugin-obsidian/graph/runtime/GraphSidebar";

export function Layout() {
  return <BaseLayout afterSidebar={<GraphSidebar colors={{ currentNode: "#0ea5e9" }} />} />;
}

export * from "@rspress/core/theme-original";
```

`GraphSidebar` draws the current page's neighbourhood from the same graph data as the panel. Do not render a second `GraphPanel`: the plugin already mounts one, and a second shows a duplicate button and panel.

## Handle unresolved links

The build reports every link that resolves to nothing, such as a typo, a moved file or a note not written yet:

```
[rspress-plugin-obsidian:graph] 2 page(s) reference 3 unresolved internal link(s):
  /guide/getting-started -> ./confguration
  /guide/configuration -> ../missing
  /api -> Not Yet Written
```

Links to attachments (`![[diagram.png]]`, `[spec](assets/spec.pdf)`) become attachment nodes, and site URLs such as `/downloads/app.zip` are not page links, so neither is reported.

`onUnresolvedLink` decides what the build does:

| Value | Effect |
|-------|--------|
| `"warn"` (default) | Print the report; the build succeeds |
| `"error"` | Fail the build with the report |
| `"ignore"` | Print nothing |

If you use the Markdown plugin, it already reports every unresolved wikilink through its own [`onBrokenLink`](/markdown/guide/api) option, so the graph's report repeats it. Turn one of them off:

```ts
graphview({ onUnresolvedLink: "ignore" });
```

The setting changes only the report. An unresolved link is still in the graph as an unresolved node, which the panel shows when a reader turns **Existing files only** off.

## Keep the graph current in `rspress dev`

The graph does not parse pages itself. It reads each note's links from the Markdown plugin's index and resolves them with the Markdown plugin's resolver, the same ones the rendered page and its Backlinks pane use. Without `markdown()`, the graph indexes the Rspress `root` itself with the default options.

- **Nothing changed**: the previous graph is reused; no link is resolved and no file is read.
- **One note edited**: that note is parsed again, every link is resolved again (a few milliseconds for a thousand notes), and only that note's text is read again for search.
- **`rspress dev`**: the plugin watches the docs root and the vault and pushes the new graph to the browser after each edit. Adding or removing a vault note still needs a dev-server restart, because Rspress fixes its list of pages when it starts.

Nothing is cached on disk.

## Profile the graph build

To see what each graph build did, turn on `profileBuild`, or set `RSPRESS_GRAPH_VIEW_PROFILE=1` for one run without changing the config:

```ts
graphview({ profileBuild: true });
```

```
[rspress-plugin-obsidian:graph] graph build | routes=42 | nodes=51 | links=87 | resolvedLinks=93 | filesRead=1 | reusedModule=false | total=6.3ms
```

- `resolvedLinks`: links run through the resolver in this build.
- `filesRead`: files the graph read itself (canvas boards, pages no index covers, and notes whose text changed since the last build). The index's own reads are not counted.
- `reusedModule=true`: nothing changed, so the previous graph was reused.

The repository includes a synthetic benchmark. On 750 pages with 6 links each:

| Scenario | Wikilink vault | Markdown-link pages |
|---|---|---|
| Cold build (index, resolve, read every note) | ~28 ms | ~30 ms |
| Rebuild with no changes | ~1.2 ms | ~1.2 ms |
| Rebuild after one edit | ~7 ms | ~8 ms |

Run it from a clone of the repository:

```bash
bun run bench:graph --pages=1000 --links=6 --iterations=5
bun run bench:graph --pages=1000 --links=6 --style=markdown
```

It also accepts `--shape` (`sequential`, `ring`, `hub` or `clustered`), `--json` and `--csv`.
