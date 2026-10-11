---
title: Graph View
description: The interactive force-directed graph panel — navigation, Obsidian's filters, display and force settings, search syntax, colour groups, accessibility, large-graph limits, and how notes, tags, attachments and canvas boards become nodes.
---

# Graph View

The graph view shows how your pages are connected. Each published note is a node, and each link a note makes is an edge, the same links its page renders and its Backlinks pane lists. Tags, attachments and links to notes that do not exist yet can be shown as nodes too, as in Obsidian.

## Navigation

Click a node to open its page. Pages and tag pages open through Rspress's router, so there is no full page reload; an attachment node opens the file. **Cmd/Ctrl-click** opens the node in a new tab. A tag without a generated tag page, and an unresolved link, cannot be opened.

## Local and global graph

The panel draws the **local graph** by default: the current page and its neighborhood. Depth 1 shows direct neighbors, and the depth control goes up to five hops. The current page always has a node, so a page with no links shows on its own.

The **Local / Global** switch in the settings drawer changes the scope. The global graph draws the whole site with the current page highlighted. It also works on a page that is not in the graph, such as a 404 page; nothing is highlighted then. The depth and link-direction controls apply to the local graph only.

The graph re-centers as you navigate. A page whose route has spaces or non-ASCII characters (`/Deep Note`, `/日本語ノート`) finds its node: the browser's percent-encoded path is decoded before matching.

## Settings

The funnel button opens a search bar and a settings drawer laid out like Obsidian's.

### Filters

| Control | What it does | Default |
|--------|----------------|---------|
| Search | Narrows the graph to matching nodes; the current page always stays | empty |
| Local / Global | Neighborhood or whole site | Local |
| Depth | Hops from the current page, 1–5 (local graph) | 1 |
| Incoming links | Follow links into the current page (local graph) | on |
| Outgoing links | Follow links out of the current page (local graph) | on |
| Neighbor links | Also draw links between neighbors at the same distance (local graph) | on |
| Tags | Show tag nodes. A hidden tag does not connect the notes that share it | on |
| Attachments | Show images, PDFs and other files that notes link or embed | off |
| Existing files only | Hide links to notes that do not exist. Turn it off to see them as unresolved nodes | on |
| Orphans | Keep nodes that have no link left in the view | on |

### Display

| Control | What it does |
|--------|----------------|
| Arrows | Draw an arrowhead at each link's target |
| Text fade threshold | Labels fade in as you zoom; a higher value shows them from further out |
| Node size | Scales every node. Nodes also grow with their number of links |
| Link thickness | Scales every link |
| Animate | Replays the graph growing: nodes appear in file-creation order, and tags, attachments and unresolved links appear with the first note that links them |

### Forces

| Control | What it does |
|--------|----------------|
| Center force | Pulls nodes toward the middle, so unlinked nodes and separate clusters stay in view |
| Repel force | How strongly nodes push each other apart |
| Link force | How strongly a link pulls its two ends together |
| Link distance | The resting length of a link |

Every setting except the search text is remembered per visitor in `localStorage`, so the graph opens the way you left it. **Restore defaults** resets them.

## Filters and search

The search box uses Obsidian's search syntax, which [colour groups](#colour-groups) share:

| Syntax | Matches |
|--------|---------|
| `word` | The node's name or path, case-insensitively, and the note's text once it has loaded |
| `"a phrase"` | The phrase exactly |
| `/regex/` | A regular expression (case-insensitive) instead of plain text |
| `path:folder` | The file path |
| `file:name` | The file name |
| `tag:project` | Tag nodes and notes carrying the tag; subtags included, so `project` also matches `project/ideas` |
| `content:text` | The note's text only |
| `line:(a b)` | `a` and `b` on the same line |
| `section:(a b)` | `a` and `b` under the same heading |
| `a b` / `a OR b` / `-a` | Both / either / not |
| `( … )` | Grouping; an operator applies to a whole group, as in `path:(daily OR journal)` |

The note text that `content:`, `line:`, `section:` and plain words search is loaded as a separate file, the first time a query needs it. Until then, plain words match names and paths only. Text inside comments is never searched, because the page hides it.

Matching runs before the render cap, so a search can find a page that a hub would otherwise push out. **Escape** clears a non-empty search first and closes the panel on the second press.

## Colour groups

Colour groups pair a query with a CSS colour. You configure them in `rspress.config.ts` rather than in the panel, because they describe the site's own taxonomy (see [Configuration](./configuration.md#groups)). A node that matches a group paints in its colour, and the first matching group wins. The current page keeps its own colour, and an invalid colour falls back to the palette. Type a group's query into the search box first to see which nodes it matches.

Without a group, nodes are coloured by kind: notes in the node colour, tags in `tagNode`, attachments in `attachmentNode` and unresolved links in `unresolvedNode`.

## Hover interactions

Hovering a node:
- changes the node's fill colour
- dims every node and link **not** connected to it, so the neighborhood stays bright
- highlights the links connected to it
- shows the node's label

Hovering a link highlights it and dims the other links. The highlight keeps working after the layout has settled. Each hover repaints the canvas without restarting the simulation, so nodes do not move under the cursor.

## Labels

A label is the note's frontmatter `title`, or else its file name, as in Obsidian. An `index` note takes its folder's name, and the docs home page is "Home". Labels fade in as you zoom past the text fade threshold. The current page and a hovered node are always labelled.

## Zoom controls

| Button | Action |
|--------|--------|
| `+` | Zoom in (×1.3) |
| `−` | Zoom out (÷1.3) |
| `⤢` | Toggle fullscreen for the panel |
| `↺` | Reset to 1× zoom |
| `▽` | Show or hide the search bar and settings |

You can also pan by dragging and zoom with the scroll wheel.

## Large graphs

When the view has **80+ nodes** or **160+ links**, nodes are drawn smaller, links are drawn thinner, and the physics settles faster.

A local graph is capped at **250 neighbors**. If the current page links to more pages than that, the graph keeps the 250 with the most links (ties broken by id) and the footer reports it, for example `250 of 1234 neighbors`. Without the cap, a hub note would hand thousands of nodes to the force simulation and freeze the panel. The global graph has a higher ceiling of **1000 nodes**, and the footer says how many it left undrawn (`12 more not drawn`). Every filter and the search run before the cap, so the cap only trims what you asked to see.

## Dark mode

The graph detects the theme and switches palettes. It checks for:
- `<html class="dark">`
- `<html data-theme="dark">`
- any parent element with `data-theme="dark"`

A `MutationObserver` picks up theme changes, so switching themes while the graph is open updates the colours immediately.

## Keyboard and screen readers

- **`g`** opens or closes the panel. Opening it with `g` or the button moves focus into the panel, even when the panel's code is still loading.
- **Tab** moves through the panel's controls and then on to the page. The floating panel is a non-modal dialog. In fullscreen it is modal, and Tab stays inside.
- **Escape** clears a non-empty search, then closes the panel and returns focus to the button. It is handled only while focus is in the panel, so it never steals Escape from the search modal or another widget.
- **Pages in this graph**: every node you can open is also a link in a list after the graph. The list is hidden until it takes focus, then it covers the graph so you can see where focus is. Screen readers can read it at any time.

## Performance

The graph build runs once Rspress has its final route list. Measured with the synthetic benchmark (750 pages, 6 links per page, 3 iterations):

| Scenario | Wikilink vault (default) | Markdown-link pages (`--style=markdown`) |
|---|---|---|
| Cold build (index, resolve, read every note) | ~28 ms | ~30 ms |
| Warm rebuild (no changes) | ~1.2 ms | ~1.2 ms |
| Single-file change | ~7 ms | ~8 ms |

A rebuild after one edit resolves every link again, which costs about 4,500 resolutions here, but it reads only the edited note. The benchmark's `filesRead` column counts the graph's own reads. `resolvedLinks` counts links run through the resolver. `moduleReuseRate` is the share of runs that reused the whole module.

The work counts, not the times, are what the tests assert (`src/graph/build/graph-build.test.ts`). An unchanged site resolves nothing and reads nothing. An edit re-reads only the edited note.

Run the benchmark yourself:

```bash
bun run bench:graph --pages=1000 --links=6 --iterations=5
bun run bench:graph --pages=1000 --links=6 --style=markdown
```

The benchmark also accepts `--shape` (`sequential` | `ring` | `hub` | `clustered`), `--json` and `--csv`. Every flag takes its value as `--pages=1000` or as `--pages 1000`, and an unknown or valueless flag fails the run. To profile your own site's build, set `RSPRESS_GRAPH_VIEW_PROFILE=1`.

## Obsidian content support

Edges are the links each page makes, resolved by the markdown plugin's own resolver. A link in the graph is therefore exactly a link on the page and a backlink on its target.

| Source | Graph behaviour |
|---|---|
| Wikilinks and embeds: `[[Page]]`, `[[Page#Heading]]`, `[[Page\|Alias]]`, `![[Page]]` | An edge to the page, whatever the heading, block or alias, and also when the heading no longer exists. In a table, the escaped form `[[Page\|Alias]]` works. |
| Markdown links: `[x](Page.md)`, `[x](My%20Note.md)`, reference definitions | An edge to the page. Escapes such as `%20` are decoded. |
| `obsidian://open?file=Note` | An edge to the note it opens |
| Frontmatter properties: `related: "[[X]]"`, `up: ["[[a/b]]"]` | Edges, as in Obsidian 1.4 and later |
| Resolution | The resolver's own order: exact path, file name, then frontmatter `title`/`aliases`, then a case-insensitive match. Vault-root paths, path suffixes and links between the docs root and the vault resolve as they do on the page. |
| Tags, inline and frontmatter | One tag node per tag, matched without regard to case or Unicode normalization (`#Project` and `#project` are one node; `#日本語` and `#café` are whole tags). The node links to the tag page when the markdown plugin generates it. |
| Attachments: `![[diagram.png]]`, `[spec](assets/spec.pdf)` | Attachment nodes. Shown when **Attachments** is on. |
| Links to missing notes | Unresolved nodes. Shown when **Existing files only** is off, and reported per `onUnresolvedLink`. |
| Canvas boards | A board links to each file card's note or file and to the links and tags in its text cards, read from the `.canvas` file. Link cards (web pages) and canvas-only arrows add nothing. |
| Daily notes | Ordinary notes |

Links inside fenced code, inline code, `%%comments%%` and `<!-- comments -->` are not links, because the page does not render them as links. Pages with `publish: false` are not in the graph. Their title, links and text are never shipped, and a link to one becomes an unresolved node named by the link text.

To use the features together:

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

`fileRoutePrefix` must match the markdown plugin's `vaultRoutePrefix`; otherwise a canvas file node links to the bare `/Welcome` instead of the published `/vault/Welcome`.

The graph does not create nodes for headings or block IDs; those are fragments of their page.

See also:
- [Getting Started](./getting-started.md)
- [Configuration](./configuration.md)
