---
title: Using the Graph View
description: What readers can do with the graph panel (open it, navigate, search, filter, use the keyboard and a screen reader), how hover previews behave, and which Obsidian content becomes nodes and edges.
---

# Using the Graph View

This page describes the published site from a reader's side: the graph panel's controls, its search syntax and settings, keyboard and screen-reader access, and hover previews. The last section lists which Obsidian content becomes nodes and edges.

Each published page is a node, and each link a page makes is an edge: the same links the page renders and its Backlinks pane lists. Tags, attachments and links to notes that do not exist yet can be shown as nodes too, as in Obsidian.

## Open the panel

- Click the round button in the bottom-right corner, or press **`g`** anywhere outside a text field.
- The panel opens on its own on sites that set [`defaultOpen`](./configuration.md#open-the-panel-by-default), except on screens narrower than 640 px.
- The site remembers whether you left the panel open or closed, where you dragged it (by its title bar), and every setting except the search text.

The panel's code downloads the first time it opens. While the panel stays closed, on a phone or because you closed it, the page loads only the button.

## Move around the graph

| Action | Result |
|--------|--------|
| Click a node | Open its page, without a full page reload |
| **Cmd/Ctrl**-click a node | Open it in a new tab |
| Drag a node | Move it |
| Drag the background | Pan |
| Mouse wheel | Zoom |
| `+` / `−` buttons | Zoom in or out by ×1.3 |
| Reset button | Back to 1× zoom |
| Maximize button | Fill the window; press it again to restore |
| Filter button | Show or hide the search bar and settings |

An attachment node opens the file. A tag node opens its tag page when the site generates tag pages. A link to a missing note cannot be opened.

Hovering a node highlights it and its links, dims everything not connected to it, and shows its label. Hovering a link highlights that link. The layout does not move while you hover.

A label is the note's frontmatter `title`, or else its file name. An `index` note takes its folder's name, and the docs home page is "Home". Labels fade in as you zoom in; the current page and the hovered node are always labelled.

The panel follows the site's light or dark theme, including a switch while it is open.

## Local and global graph

The panel draws the **local graph** by default: the current page and the pages it links to or is linked from. The current page always has a node, so a page with no links shows on its own.

The **Local / Global** switch in the settings changes the scope. The global graph draws the whole site with the current page highlighted. It also works on a page that is not in the graph, such as a 404 page; nothing is highlighted then.

The graph re-centres as you navigate. Pages whose routes contain spaces or non-ASCII characters (`/Deep Note`, `/日本語ノート`) find their node.

## Search

The search box filters the graph to matching nodes; the current page always stays. The graph updates when you pause typing for 200 ms, so a large graph is not redrawn on every keystroke. Clearing the box updates it at once.

The syntax is Obsidian's, and [colour groups](./configuration.md#colour-nodes-with-groups) use the same one:

| Syntax | Matches |
|--------|---------|
| `word` | The node's name or path, case-insensitively, and the note's text once it has loaded |
| `"a phrase"` | The exact phrase |
| `/regex/` | A case-insensitive regular expression |
| `path:folder` | The file path |
| `file:name` | The file name |
| `tag:project` | Tag nodes and notes with the tag, including subtags (`project/ideas`) |
| `content:text` | The note's text only |
| `line:(a b)` | `a` and `b` on the same line |
| `section:(a b)` | `a` and `b` under the same heading |
| `a b` / `a OR b` / `-a` | Both / either / not |
| `( … )` | Grouping, as in `path:(daily OR journal)` |

Note text loads separately, the first time a query needs it. Until it arrives, plain words match names and paths only. Comments (`%%…%%`, `<!-- … -->`) are never searched, because the page does not show them.

Search runs before the [size limits](#large-graphs), so it can find a page that the limit would otherwise leave out.

## Settings

The filter button opens the search bar and a settings drawer laid out like Obsidian's. **Restore defaults** resets every setting.

### Filters

| Control | What it does | Default |
|--------|----------------|---------|
| Local / Global | Neighbourhood or whole site | Local |
| Depth | Hops from the current page, 1–5 (local graph) | 1 |
| Incoming links | Follow links into the current page (local graph) | on |
| Outgoing links | Follow links out of the current page (local graph) | on |
| Neighbor links | Also draw links between neighbours at the same distance (local graph) | on |
| Tags | Show tag nodes. A hidden tag does not connect the notes that share it | on |
| Attachments | Show images, PDFs and other files that notes link or embed | off |
| Existing files only | Hide links to notes that do not exist; turn it off to see them as nodes | on |
| Orphans | Keep nodes that have no links left in the view | on |

### Display

| Control | What it does |
|--------|----------------|
| Arrows | Draw an arrowhead at each link's target |
| Text fade threshold | How far out labels appear; higher shows them from further out |
| Node size | Scales every node. Nodes also grow with their number of links |
| Link thickness | Scales every link |
| Animate | Replays the graph growing: notes appear in file-creation order, and tags, attachments and unresolved links appear with the first note that links them |

### Forces

| Control | What it does |
|--------|----------------|
| Center force | Pulls nodes toward the middle, so unlinked nodes and separate clusters stay in view |
| Repel force | How strongly nodes push each other apart |
| Link force | How strongly a link pulls its two ends together |
| Link distance | The resting length of a link |

## Keyboard and screen readers

- **`g`** opens or closes the panel. Opening it with `g` or the button moves focus into the panel, even while its code is still loading.
- **Tab** moves through the panel's controls and then on to the page. The floating panel is a non-modal dialog. Maximized, it is modal and Tab stays inside.
- **Escape** clears a non-empty search, then closes the panel and returns focus to the button. The panel handles Escape only while focus is in it, so it never takes Escape from the search dialog or another widget.
- **Pages in this graph**: every node you can open is also a link in a list after the graph. The list is hidden until it takes focus, then it covers the graph so you can see where focus is. Screen readers can read it at any time, and the graph region announces how many nodes and links it shows.

## Large graphs

When the view has 80 or more nodes, or 160 or more links, nodes and links are drawn smaller and the layout settles faster.

A local graph shows at most 250 neighbours. When the current page links to more, the graph keeps the 250 with the most links and the footer says so, for example `250 of 1234 neighbors`. The global graph draws at most 1,000 nodes, and the footer says how many it left out (`12 more not drawn`). Filters and search run before these limits, so they only trim what you asked to see.

## Hover previews

On sites that turn on [hover previews](./configuration.md#turn-on-hover-previews), resting the mouse on a link in the article shows the linked note in a popover, as Obsidian's Page preview does.

- The popover shows the note as its own page renders it: headings, lists, callouts, code, tables, math, images and Mermaid diagrams.
- A `[[Note#Heading]]` link shows only that section, and a `[[Note#^block]]` link only that block. `[[#Heading]]` works on the same page.
- It opens after the mouse rests on the link for 300 ms, below the hovered line of the link, or above it when there is no room below.
- It stays open while the pointer is on the link or in the popover, so you can scroll a long note. It closes 300 ms after the pointer leaves both, and on Escape, a click elsewhere, a page scroll or navigation.
- Only article links open a popover, and only with a mouse: the sidebar, navbar, outline, heading anchors, footnote markers, touch and pen never do. Links inside a popover do not open another one.
- It works on any link that leads to a page of the site: wikilinks, tag pages and ordinary Markdown links, with or without the site `base`, an `.html` suffix, a query or percent-encoding.

The popover is 450 px wide and at most 400 px tall. It uses the article's typography at 87.5 % on the page background, and fades in unless you prefer reduced motion.

## Obsidian content support

Edges are the links each page makes, resolved by the Markdown plugin's resolver, so a link in the graph is exactly a link on the page and a backlink on its target.

| Source | In the graph |
|---|---|
| Wikilinks and embeds: `[[Page]]`, `[[Page#Heading]]`, `[[Page\|Alias]]`, `![[Page]]` | An edge to the page, whatever the heading, block or alias, and also when the heading no longer exists. In a table, the escaped form `[[Page\|Alias]]` works. |
| Markdown links: `[x](Page.md)`, `[x](My%20Note.md)`, reference definitions | An edge to the page. Escapes such as `%20` are decoded. |
| `obsidian://open?file=Note` | An edge to the note it opens |
| Frontmatter properties: `related: "[[X]]"`, `up: ["[[a/b]]"]` | Edges, as in Obsidian 1.4 and later |
| Resolution | The resolver's order: exact path, file name, frontmatter `title`/`aliases`, then a case-insensitive match. Vault-root paths, path suffixes and links between the docs root and the vault resolve as they do on the page. |
| Tags, inline and frontmatter | One tag node per tag, matched without regard to case or Unicode normalization (`#Project` and `#project` are one node; `#日本語` and `#café` are whole tags). The node opens the tag page when the Markdown plugin generates it. |
| Attachments: `![[diagram.png]]`, `[spec](assets/spec.pdf)` | Attachment nodes, shown when **Attachments** is on |
| Links to missing notes | Unresolved nodes, shown when **Existing files only** is off and reported per [`onUnresolvedLink`](./configuration.md#handle-unresolved-links) |
| Canvas boards | A board links to each file card's note or file and to the links and tags in its text cards. Link cards (web pages) and canvas-only arrows add nothing; neither does a file card showing a `publish: false` note, which the board itself publishes without the note's name. |
| Daily notes | Ordinary notes |
| Headings and block IDs | No nodes of their own; they are parts of their page |

Links inside fenced code, inline code, `%%comments%%` and `<!-- comments -->` are not links, because the page does not render them as links. Pages with `publish: false` are not in the graph: their title, links and text are never shipped, and a link to one becomes an unresolved node named by the link text.

A site that uses all three plugins together:

```ts
plugins: [
  markdown({
    vaultRoot: "./vault",
    enableTagLinking: true,
    enableTagPages: true,
    enableDailyNotes: true,
    dailyNotes: { folder: "daily", dateFormat: "YYYY-MM-DD", navigation: true },
  }),
  canvas({ vaultRoot: "./vault", routePrefix: "/canvas", fileRoutePrefix: "/vault" }),
  graphview({ defaultOpen: true, enableHoverPreviews: true }),
]
```

`fileRoutePrefix` must match the Markdown plugin's `vaultRoutePrefix` (`/vault` by default); otherwise a canvas file card links to `/Welcome` instead of the published `/vault/Welcome`.
