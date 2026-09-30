---
title: Graph View
description: The interactive force-directed graph panel — navigation, filters and search, colour groups, hover highlighting, zoom controls, large-graph limits, and Obsidian content support.
---

# Graph View

The graph view shows how your documentation pages are connected through internal markdown links. Each page becomes a node, and each `[link](./path.md)` becomes an edge.

## Navigation

Click any node in the graph to navigate directly to that page. The graph uses Rspress's internal router, so navigation is instant — no full page reload.

## Current Page Highlighting

The panel renders a **local graph** by default: the current page and its neighborhood within the filter depth, drawn as a force-directed field — direct neighbors at the default depth 1, up to five hops away at the maximum. Each page is a node and each internal markdown link between them is an edge. When you're on a page, the panel highlights the current node with a brighter fill.

A **Local / Global** switch in the filter bar changes the scope. Global draws every published page at once with the current one still highlighted — Obsidian's global graph — while the depth control steps aside, since a whole site has no neighborhood.

Node size is **uniform** — every node renders at the same radius regardless of degree. The graph re-centers on the current node as you navigate so you always find yourself.

If the current page has no links, the panel shows an empty state.

## Filters and search

The funnel button in the control cluster toggles a filter bar under the panel header. The bar decides what the local graph draws:

| Control | What it does |
|--------|----------------|
| Search box | Narrows the graph to nodes matching the query. The current page always stays visible. |
| Local / Global | Draws the current page's neighborhood, or every published page. Local is the default. |
| Neighborhood depth | Hops from the current page to show — 1 (the default, Obsidian's local graph) through 5. Local scope only. |
| Tags toggle | Show or hide generated tag pages (`/tags/...`). On by default. |
| Orphans toggle | Show or hide nodes left without any visible link after the other filters. On by default. |

The search box understands a small query language, shared with [colour groups](#colour-groups):

- plain text matches a node's label or route path, case-insensitively
- `path:some/folder` matches the route path
- `file:name` matches the last route segment
- `tag:project` matches the tag page and the pages linked to that tag (subtags included, so `project` also matches `project/ideas`)
- `-term` hides matches; `"quoted phrase"` searches for the phrase literally
- several terms are ANDed together

Matching runs before the 250-neighbor render cap, so a search can find a page a hub would otherwise push out. Depth, tag and orphan settings are remembered per visitor in `localStorage`; the search text is not, so every page opens unsearched. **Escape** clears a non-empty search first, and only closes the panel on a second press.

Search, tag, orphan and scope settings are remembered per visitor in `localStorage`, so the graph opens the way you left it.

## Colour groups

Colour groups pair a query in the search language with a CSS colour, configured in `rspress.config.ts` rather than the panel (see [Configuration](./configuration.md#groups)). Every node that matches a group paints in its colour — first group wins — while the current page keeps its dedicated "you are here" colour and an invalid colour falls back to the palette. A group query can be prototyped by typing it into the panel's search box first: whatever it matches is what the group would colour.

## Hover Interactions

Hovering over a node:
- Changes the node's fill color
- Dims all nodes and links **not** connected to it — the neighborhood stays bright, matching Obsidian
- Highlights the links connected to it
- Reveals the node's label
- Turns the cursor into a pointer to indicate the node is clickable

Hovering over a link highlights it and dims the other links. Nodes are unaffected — hover a *node* instead to dim its non-neighbors. The cursor also turns into a pointer over links.

## Link Rendering

Links are drawn as thin, straight lines — no arrows, no particles, no curves. This keeps the view clean and Obsidian-like, so you can scan the structure at a glance rather than follow edge decorations.

## Labels

Like Obsidian's graph view, the graph starts as a clean dot-field — labels are hidden. Hover over a node, zoom past 1.4×, or open the node for the current page (always labeled) to reveal a title.

## Zoom Controls

The graph provides four actions via the control panel in the bottom-right:

| Button | Action |
|--------|--------|
| `+` | Zoom in (×1.3) |
| `−` | Zoom out (÷1.3) |
| `⤢` | Toggle fullscreen for the panel |
| `↺` | Reset to 1× zoom |
| `▽` | Show or hide the filter bar |

You can also pan by dragging and zoom with the scroll wheel.

## Large Graphs

For documentation sites with **80+ nodes** or **160+ links**, the graph automatically optimizes:
- Node dots shrink (uniform size — radius drops from 5 to 4, no per-degree scaling)
- Link widths are thinned
- Physics simulation uses faster decay rates

These optimizations keep the graph interactive even with hundreds of nodes. A strong repulsion force keeps nodes apart — hubs spread out instead of stacking on their neighbors.

A local graph is additionally capped at **250 neighbors**. If the current page
links to more pages than that, the graph keeps the 250 with the most links (ties
broken by route path) and the footer reports it, for example
`250 of 1234 neighbors`. Without the cap a hub note would hand thousands of
nodes to the force simulation and freeze the panel. The global scope has its own,
much higher ceiling of **1000 nodes**, and says in the footer how many it left
undrawn (`12 more not drawn`) rather than passing a partial vault off as the
whole one. Depth, tag, orphan and search filters all run before the cap, so the
cap only ever trims what the reader asked to see.

## Dark Mode

The graph automatically detects your theme and switches palettes:
- **Light mode**: slate-toned nodes with indigo accents
- **Dark mode**: brighter nodes with enhanced glow for visibility

Theme detection checks for:
- `<html class="dark">`
- `<html data-theme="dark">`
- Any parent element with `data-theme="dark"`

Changes are observed in real-time via `MutationObserver`, so switching themes while the graph is open updates colors instantly.

## Keyboard Accessibility

- **Escape** — clears a non-empty search first; otherwise closes the graph panel and returns focus to the FAB button
- **Tab** — navigates through the filter and zoom controls when the panel is open

## Performance

The graph build runs during Rspress's route scanning phase. Measured with the synthetic benchmark (750 pages, 6 links/page, 5 iterations):

| Scenario | Wikilink vault (default) | Markdown-link pages (`--style=markdown`) |
|---|---|---|
| Cold build (all files read + parsed) | **~10ms** | **~260ms** |
| Warm rebuild (no changes) | **~0.8ms** | ~0.7ms |
| Single-file change | **~8ms** | ~16ms |

The difference is the link extractor: a note that contains only wikilinks and tags
never needs a markdown parse — the masked-source scan finds the same targets for
about 400× less time (measured 0.9µs vs 379µs per note), and 81% of the notes in
this repo's own corpus take that path. Pages with markdown links (inline,
reference, autolink) still go through the parser, which is why a
documentation-style site pays the parse cost and a vault does not.

Two consequences worth knowing. A wikilink vault's cold build is no longer
parse-bound: it is dominated by file stats and reads, so the *single-file change*
is nearly as expensive as the whole cold build (8ms vs 9ms) — the percentage
"improvement" is small for the same reason. And the parser path is only taken
when the source actually contains markdown-link syntax, so a vault with a few
markdown links pays it per note, not per site.

The benchmark's `cacheHits`/`cacheMisses` columns count files, while `moduleReuseRate`
is the share of runs that reused the whole module — a single-file change reports
`749 hits / 1 miss` and `0%` module reuse, which is correct, not a contradiction.

`src/graph/build/build-diagnostics.test.ts` holds the contract that keeps this
honest — each file is read and parsed at most once per build, a warm cache
re-parses nothing, and build time stays sub-quadratic as the site doubles.

Run the synthetic benchmark yourself:

```bash
bun run bench:graph --pages=1000 --links=6 --iterations=5
bun run bench:graph --pages=1000 --links=6 --style=markdown   # parser path
```

Or profile your own site's build with `RSPRESS_GRAPH_VIEW_PROFILE=1`. The benchmark also accepts `--shape` (`sequential` | `ring` | `hub` | `clustered`), `--style` (`wikilink` | `markdown`, which decides whether the synthetic notes take the extractor's fast path), `--json`, and `--csv` for machine-readable output, and every flag takes its value either as `--pages=1000` or as `--pages 1000`; an unknown or valueless flag fails the run. Note the columns measure different things: `parseCpuMs` is parse CPU time (title, links, and content hash) summed across routes and, because parsing is main-thread work, it stays under `totalMs`; `statWaitMs` (`avgStatWaitMs` in the CSV report) is file-stat latency summed across routes, which can exceed `totalMs` because routes are stat'ed concurrently; `totalMs` is the wall-clock build duration.

See also:
- [Getting Started](./getting-started.md)
- [Configuration](./configuration.md)

## Obsidian content support

The graph is built from the same content surface used by the Obsidian plugins. These references become page-to-page edges when their targets publish as Rspress routes:

| Source feature | Graph behavior |
|---|---|
| Wikilinks: `[[Page]]`, `[[Page#Heading]]`, `[[Page\|Alias]]` | The page target becomes an edge; heading and alias text do not create separate nodes. A bare target is resolved by path first, then by file basename (case-insensitively) — an ambiguous basename creates no edge. |
| Markdown links: `[Page](./page.md)` | Relative, extensionless, `.md`, `.mdx`, and reference-style links are resolved, with the same basename fallback when the path misses. |
| Frontmatter and inline tags | Tag pages generated by `enableTagPages` are graph nodes; pages with tags link to those `/tags/...` nodes. |
| Daily notes | Date pages are ordinary graph nodes. Wikilinks and generated previous/current/next navigation connect them. |
| Canvas file nodes | Markdown file nodes point to their published page. Text nodes contribute their wikilinks, Markdown links, and tags. |
| Canvas edges | Canvas-only visual edges are not duplicated as graph edges unless the node content also names a page target. |

Code fences, inline code and frontmatter are not scanned: `[[Page]]` written inside
backticks is documentation, and a `description` field that mentions a link is
metadata, not an edge. References that resolve to no route are reported once per
build with the source page and the target.

Enable the features together:

```ts
plugins: [
  markdown({
    enableTagLinking: true,
    enableTagPages: true,
    enableDailyNotes: true,
    dailyNotes: { folder: "daily", dateFormat: "YYYY-MM-DD", navigation: true },
  }),
  canvas({ vaultRoot: "./vault", routePrefix: "/canvas", fileRoutePrefix: "/vault" }),
  graphview({ defaultOpen: true, enableHoverPreviews: true }),
]
```

`fileRoutePrefix` must match the markdown plugin's `vaultRoutePrefix`, or a Canvas file node links to the bare `/Welcome` instead of the published `/vault/Welcome`.

The graph does not create standalone nodes for headings, block IDs, inline tags, or external assets. Those remain metadata or presentation details attached to their page.

## Example routes in a combined vault site

With the configuration above, the graph can connect routes across all three surfaces:

```text
/vault/Welcome              # Markdown vault page
/vault/guide/Setup Guide     # Wikilink target with a spaced filename
/tags/project/ideas          # Generated nested tag page
/canvas/demo                 # Canvas page
```

The graph links page references, not headings or assets. A link such as `[[Setup Guide#Installation]]` creates an edge to `/vault/guide/Setup Guide`; `#Installation` remains a fragment on that page.
