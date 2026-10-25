---
title: Configuration
description: Reference for every canvas() option — type, default, and what it changes — plus the in-browser editor.
---

# Configuration

This page lists every option `canvas()` accepts. Every option is optional:
`canvas()` with no arguments publishes the `.canvas` files under your Rspress
content root at `/canvas/…`. Come here when your boards live in an Obsidian
vault, when you want different routes, or when you want to turn on the editor.

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| [`vaultRoot`](#vaultroot) | `string` | Rspress content root | Directory scanned for `.canvas` files. Every vault path on a board resolves against it. |
| [`routePrefix`](#routeprefix) | `string` | `"/canvas"` | URL prefix of the board pages. |
| [`include`](#include-and-exclude) | `string[]` | `["**/*.canvas"]` | Glob patterns, relative to `vaultRoot`, for the boards to publish. |
| [`exclude`](#include-and-exclude) | `string[]` | `[]` | Glob patterns to skip, added to the built-in ignores. |
| [`fileRoutePrefix`](#filerouteprefix) | `string` | none | Route prefix of the vault's note pages. Set it to the markdown plugin's `vaultRoutePrefix`. |
| [`linkPreview`](#linkpreview-and-iframesandbox) | `boolean` | `true` | Show a link card as a live preview of the website. `false` shows a plain link. |
| [`iframeSandbox`](#linkpreview-and-iframesandbox) | `string` | `"allow-scripts allow-same-origin allow-popups"` | `sandbox` attribute of link-card previews. |
| [`editable`](#editor) | `boolean` | `false` | Add the in-browser editor to board pages. It never saves to disk. |
| [`editorTitle`](#editor) | `string` | `"Canvas editor"` | Title in the editor's banner. |
| [`enableDefaultStyles`](#enabledefaultstyles) | `boolean` | `true` | Inject the bundled canvas stylesheet. |
| [`outDir`](#outdir) | `string` | `"node_modules/.rspress-plugin-obsidian/canvas"` | Directory, relative to the working directory, that board JSON and attachments are written to. |

## vaultRoot

The plugin looks for `.canvas` files under `vaultRoot`. By default that is the
Rspress content root: `root` from your `rspress.config.ts`, resolved against the
working directory, or `docs/` when `root` is unset. So boards that sit next to
your docs pages need no configuration. Point `vaultRoot` at your vault when the
boards live there:

```ts
canvas({
  vaultRoot: "./Obsidian Vault",
  fileRoutePrefix: "/vault",
});
```

If you set `vaultRoot` without [`fileRoutePrefix`](#filerouteprefix), the build
logs a warning. File cards would then link to `/Note`-style routes, while the
markdown plugin publishes the same notes under its own prefix.

A `.canvas` file or folder inside `vaultRoot` that is a symbolic link is
skipped, so a link cannot publish a board from outside the vault.

## routePrefix

Each board gets one page under `routePrefix`. The route is the board's path
relative to `vaultRoot`, without `.canvas`. Each path segment is lowercased, and
whitespace in it becomes `-`:

| Board | `routePrefix` | Route |
|-------|---------------|-------|
| `Demo.canvas` | `"/canvas"` | `/canvas/demo` |
| `Projects/Road Map.canvas` | `"/canvas"` | `/canvas/projects/road-map` |
| `Architecture.canvas` | `"/boards"` | `/boards/architecture` |

The build fails if two boards map to the same route, for example `Road Map.canvas`
and `road-map.canvas` in the same folder.

## include and exclude

`include` and `exclude` are [fast-glob](https://github.com/mrmlnc/fast-glob)
patterns, relative to `vaultRoot`:

```ts
canvas({
  include: ["diagrams/**/*.canvas"],
  exclude: ["**/drafts/**"],
});
```

Your `exclude` patterns are added to five built-in ignores that always apply:
`**/node_modules/**`, `**/dist/**`, `**/.git/**`, `**/doc_build/**` and
`**/coverage/**`. Without them, the default `include` would scan dependency
installs and build output inside the vault, and could publish a stray `.canvas`
file from `node_modules`.

## fileRoutePrefix

Set `fileRoutePrefix` to the markdown plugin's `vaultRoutePrefix`. For
`vaultRoutePrefix: "/vault"`, use `fileRoutePrefix: "/vault"`. A file card for
`Welcome.md` then links to `/vault/Welcome`, the page the markdown plugin
publishes. Without the prefix, it links to `/Welcome`, which no page serves.

Links in text cards and file cards are resolved at build time with the markdown
plugin's resolver and content index. They land on the same route as the same
link in a note, and resolve the way Obsidian resolves them:

| Written in a card | Resolves to |
|-------------------|-------------|
| `[[Loose]]` | The note named `Loose` anywhere in the vault. If several match, the one with the shortest path. |
| `[[notes/Loose]]` | The note at that path from the vault root. |
| `[[./Sibling]]`, `[[../Other]]` | A note relative to the folder that holds the `.canvas` file. |
| `![[pic.png]]`, `![](pic.png)` | The attachment named `pic.png`, wherever it is in the vault. |
| `[[Note#Heading]]` | The note, scrolled to the heading. If the heading does not exist, the note opens at the top. |

A link that resolves to nothing, or to a note with `publish: false`, renders as
plain text styled as an unresolved link. It never links to a page that does not
exist.

## linkPreview and iframeSandbox

A link card shows the website itself in a sandboxed frame that loads lazily, the
way Obsidian shows a web page on a canvas. Set `linkPreview: false` for a plain
link card that loads nothing until the reader clicks it:

```ts
canvas({ linkPreview: false });
```

`iframeSandbox` is the frame's `sandbox` attribute. The default,
`allow-scripts allow-same-origin allow-popups`, is what most sites need to
render: without `allow-same-origin` a site loses access to its own storage and
often renders blank. For untrusted third-party sites, `allow-scripts allow-popups`
is safer because it drops the same-origin grant:

```ts
canvas({ iframeSandbox: "allow-scripts allow-popups" });
```

Sites that send `X-Frame-Options` or a `frame-ancestors` policy refuse to be
framed anywhere. The address above the card still links to the site.

PDF file cards are not sandboxed, whatever `iframeSandbox` says: Chromium's PDF
viewer refuses to run in a sandboxed frame. The PDF is served from your own site.

## enableDefaultStyles

The plugin injects its stylesheet into every page. Set
`enableDefaultStyles: false` to load it yourself, for example to control the
order of stylesheets, and import `rspress-plugin-obsidian/canvas/styles.css`
from your theme. See [Styling](./styling.md).

## outDir

The plugin writes each board's JSON (`__canvases__/<vault path>.json`) and every
attachment a board references (images, audio, video, PDFs and other files) to
`outDir`. Rspress serves that directory as an extra public directory, under
your site `base`. An attachment is served at the same `<fileRoutePrefix>/<vault
path>` URL the markdown plugin gives it, so a card and a note never disagree.

The directory belongs to the plugin and is emptied at the start of every build.
A board or attachment you delete from the vault stops being published. Only
files that a published board references are copied, and a note with
`publish: false` is never copied. Nothing is written to `docs/public/`.

Earlier versions wrote board JSON to `docs/public/__canvases__/`. The plugin
deletes that directory on its next build.

## Editor

`editable: true` adds editing controls to every board page:

```ts
canvas({
  editable: true,
  editorTitle: "Architecture canvas",
});
```

The editor works on a copy of the board in the browser. It never writes to the
`.canvas` file, and changes are lost when you leave the page. To keep them,
export the board and copy the file back into your vault before the next build.
The banner shows `editorTitle` and whether you have unsaved changes.

| Task | How |
|------|-----|
| Add a card | Toolbar buttons add a text card, a file card (`Note.md`), a link card (`https://`) or a group. |
| Edit a text card | Double-click it, or select it and press `Enter`. `Escape` finishes. |
| Select | Click a card or an edge. Shift-click adds cards to the selection. |
| Move and resize | Drag a card, or its resize handle. Arrow keys move the selection; hold `Shift` for larger steps. Dragging a group moves the cards inside it. |
| Connect two cards | Select a card, press the connect button (⇄), then click the target card. |
| Delete | `Delete` or `Backspace` removes the selected edge, or the selected cards and their edges. |
| Undo and redo | `Ctrl/⌘+Z`; `Ctrl/⌘+Shift+Z` or `Ctrl/⌘+Y`. |
| Pan | Drag the background, or drag with the middle mouse button or `Space` held, even over a card. |
| Export | The export button or `Ctrl/⌘+S` downloads the board as `<board name>.canvas`. |

The editor changes only text. Change a file card's file, a link card's URL, edge
sides and labels, and group backgrounds in Obsidian. The export keeps fields the
plugin does not use (another tool's `styleAttributes`, extra top-level
metadata) and leaves out the build-time data the plugin added (resolved files,
attachment URLs, note bodies).

Embeds (`<CanvasEmbed>` and `![[Board.canvas]]`) are always read-only.
