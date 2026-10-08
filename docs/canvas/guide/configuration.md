---
title: Configuration
description: All plugin options and how to configure vault scanning, routes, and previews.
---

# Configuration

Customize how the plugin discovers canvas files and generates routes.

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `vaultRoot` | `string` | Rspress content root | Root directory to scan for `.canvas` files |
| `routePrefix` | `string` | `/canvas` | URL prefix for generated canvas pages |
| `include` | `string[]` | `['**/*.canvas']` | Glob patterns for finding canvas files |
| `exclude` | `string[]` | `node_modules`, `dist`, `.git`, `doc_build`, `coverage` | Extra glob patterns to ignore (added to the built-ins) |
| `fileRoutePrefix` | `string` | — | Route prefix of the vault's note pages and attachments (the markdown plugin's `vaultRoutePrefix`, e.g. `/vault`) |
| `linkPreview` | `boolean` | `true` | Show link nodes as a live, sandboxed preview of the website, like Obsidian; `false` for a plain link card |
| `iframeSandbox` | `string` | `allow-scripts allow-same-origin allow-popups` | Sandbox attributes for link-node previews (PDF cards are never sandboxed) |
| `editable` | `boolean` | `false` | Enable browser-side editing controls |
| `editorTitle` | `string` | `Canvas editor` | Editor banner, and the export filename when the board has no name |
| `enableDefaultStyles` | `boolean` | `true` | Inject the bundled canvas stylesheet; set `false` to import it yourself |
| `outDir` | `string` | `node_modules/.rspress-plugin-obsidian/canvas` | Plugin-owned directory for published board JSON and attachments, emptied on every build |

## vaultRoot

Canvas files are discovered relative to this path. By default it is the
Rspress content root — `root` from your `rspress.config.ts`, resolved against
the working directory and falling back to `docs/` — so the common case (canvases
living next to the pages that embed them) needs no configuration. Point it at
your Obsidian vault when the vault is somewhere else:

```ts
canvas({
  vaultRoot: './my-vault',
})
```

Setting `vaultRoot` explicitly without [`fileRoutePrefix`](#filerouteprefix)
logs a build warning: the file cards would link to `/Note`-style routes while
the markdown plugin publishes the same vault under its own prefix.

## routePrefix

Control the URL structure for canvas pages:

```ts
canvas({
  routePrefix: '/vault/canvas',
})
```

A file named `Architecture.canvas` becomes available at `/vault/canvas/architecture`.

## include / exclude

Filter which canvas files to process:

```ts
canvas({
  include: ['**/diagrams/*.canvas'],
  exclude: ['**/drafts/*.canvas'],
})
```

Uses [fast-glob](https://github.com/mrmlnc/fast-glob) pattern matching.

`exclude` never replaces the built-ins — your patterns are appended to them.
Always skipped, whatever you configure: `**/node_modules/**`, `**/dist/**`,
`**/.git/**`, `**/doc_build/**` and `**/coverage/**`. The default `include`
walks the entire tree, so without those a dependency install or build output
inside the vault would be scanned, and a stray `.canvas` under `node_modules`
would get published.

## fileRoutePrefix

The route prefix the vault's notes are published under — set it to the
markdown plugin's `vaultRoutePrefix` (`fileRoutePrefix: "/vault"` for
`vaultRoutePrefix: "/vault"`). Links in cards and file nodes are resolved at
build time with the markdown plugin's own resolver and content index, so they
land on exactly the route the note page was published at:

| Written in a card | Resolves like Obsidian |
|-------------------|------------------------|
| `[[Loose]]` | the one note called `Loose` anywhere in the vault (shortest path) |
| `[[notes/Loose]]` | the vault-absolute path |
| `[[./Sibling]]`, `[[../Other]]` | relative to the folder the `.canvas` file is in |
| `![[pic.png]]`, `![](pic.png)` | the attachment named `pic.png`, wherever it lives |
| `[[Note#Heading]]` | the note, at the heading's anchor; a missing heading opens the note |

A target that does not resolve — or that resolves to a `publish: false` note —
renders as plain text styled as an unresolved link, never as a link to a page
that does not exist. Without `fileRoutePrefix` the vault is indexed with no
prefix (`Welcome.md` → `/Welcome`), and the plugin logs a build warning
whenever `vaultRoot` is set.

## linkPreview and iframeSandbox

Link nodes show the website itself in a sandboxed, lazily loaded frame by
default, the way Obsidian embeds a web page in a link card. Turn it off for a
plain link card that loads nothing until the reader clicks, or tighten the
sandbox:

```ts
canvas({
  linkPreview: false,
})

canvas({
  iframeSandbox: 'allow-scripts allow-popups',
})
```

The default sandbox (`allow-scripts allow-same-origin allow-popups`) is the
minimum that lets most pages render: a page loses access to its own storage
and client runtime without `allow-same-origin` and renders blank, and
`allow-scripts` is required by the pages being framed. `allow-scripts
allow-popups` is the safer value for third-party URLs — it drops the
same-origin grant. Sites that send `X-Frame-Options` or a `frame-ancestors`
policy refuse to be framed anywhere; the card's label above the frame still
links to the page.

PDF file cards are **not** sandboxed: Chromium's PDF viewer refuses to run in a
sandboxed frame and shows a broken-document icon. The PDF is served from the
site's own origin.

## outDir

Board JSON (`__canvases__/<vault path>.json`) and every attachment a board
references (images, audio, video, PDFs, other files — at the same
`<fileRoutePrefix>/<vault path>` URL the markdown plugin uses) are written to
this directory and served as an extra Rsbuild public directory, honouring the
site `base`. The directory belongs to the plugin and is emptied at the start of
every build, so a deleted board or attachment stops being published; nothing is
written into your `docs/public/`. Only files a published board references are
copied, and a note with `publish: false` is never copied into a board.

Earlier versions wrote board JSON into `docs/public/__canvases__/`; the plugin
removes that directory on its next build.

## Editor mode

Enable the read/write-in-browser editor UI:

```ts
canvas({
  editable: true,
  editorTitle: 'Architecture canvas',
})
```

Editor mode supports:

- Creating text, file, link, and group cards.
- Selecting multiple cards with Shift-click.
- Dragging and resizing cards.
- Connecting cards with edges (select a card, then the connect button, then a target card).
- Selecting edges by clicking them, and deleting selected edges.
- Deleting selected cards and connected edges.
- Undo and redo.
- Keyboard shortcuts.
- Moving the selection with the arrow keys (`Shift` for larger steps); `Enter`
  edits the focused text card and `Escape` finishes the edit.
- Panning with the middle mouse button or `Space`+drag, even over a card.
- Exporting the board as a `.canvas` file with the download button or
  `Ctrl/Cmd+S`. The export is lossless — fields the plugin does not know about
  (another tool's `styleAttributes`, top-level metadata) are kept — and carries
  none of the build-time data (resolved files, attachment URLs, note bodies). It
  is named after the board (`My Board.canvas`).

Rspress builds are static. Editor changes remain in browser memory and must be exported, then copied back into the vault before the next build.
