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
| `fileRoutePrefix` | `string` | — | URL prefix prepended to resolved Markdown file routes (e.g. `/docs`) |
| `linkPreview` | `boolean` | `false` | Render link nodes as embedded iframes |
| `iframeSandbox` | `string` | `allow-scripts allow-same-origin allow-popups` | Sandbox attributes applied to link-preview and PDF iframes |
| `editable` | `boolean` | `false` | Enable browser-side editing controls |
| `editorTitle` | `string` | `Canvas editor` | Editor banner and export filename |
| `enableDefaultStyles` | `boolean` | `true` | Inject the bundled canvas stylesheet; set `false` to import it yourself |

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

Map file nodes to your Rspress documentation routes. When a file node references `Welcome.md`, this option determines the link destination:

```ts
canvas({
  fileRoutePrefix: '/docs',
})
```

| File Node Value | Resolved Link |
|-----------------|---------------|
| `Welcome.md` | `/docs/Welcome` |
| `Notes/Setup.md` | `/docs/Notes/Setup` |
| `My Note.md` | `/docs/My Note` |

The resolver normalizes separators only. Case and spaces are preserved, so the
link target is the vault path exactly as the markdown plugin published it
(`Welcome.md` → `/docs/Welcome`, not `/docs/welcome`). A fragment never appears
in `file` — a file node carries it in the separate `subpath` field, which is
appended to the link verbatim. Fragments written *inside* a wikilink or Markdown
link in a text node are split off and slugified by the Markdown renderer, so
`[[Notes/Plan#Next Steps]]` becomes `/docs/Notes/Plan#next-steps`.

Without this option, file nodes link to the vault-relative path directly
(`Welcome.md` → `/Welcome`), and the plugin logs a build warning whenever
`vaultRoot` is set — those bare routes are not what the markdown plugin
publishes, so pass the same prefix here (`fileRoutePrefix: "/vault"` for
`vaultRoutePrefix: "/vault"`), or your docs route prefix when the notes live
under `docs/`.

## linkPreview and iframeSandbox

Enable iframe previews for link nodes and optionally customize the sandbox:

```ts
canvas({
  linkPreview: true,
  iframeSandbox: 'allow-scripts allow-same-origin',
})
```

The default (`allow-scripts allow-same-origin allow-popups`) is the minimum that
lets a preview render: a same-origin page loses access to its own storage and
client runtime without `allow-same-origin` and renders blank (verified in a
browser), and `allow-scripts` is required by the pages being framed.

Tighten it when you preview content you do not control. `allow-scripts
allow-popups` is the right value for cross-origin URLs — it drops the
same-origin grant that, combined with scripts, lets framed content reach out of
its frame. Keep `allow-same-origin` only when the previews are your own pages.

The markdown feature's inline PDF embeds (`![[doc.pdf]]`) are not sandboxed for
the same reason: Chromium's PDF viewer needs scripts and shows a
broken-document icon without them. If you would rather not embed PDFs at all,
leave `enableMediaEmbeds` off — the file is then linked instead.

When enabled, `http(s)` link nodes render an embedded iframe of the target URL; other targets fall back to a normal link.

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
- Exporting updated JSON Canvas with the download button or `Ctrl/Cmd+S`.

Rspress builds are static. Editor changes remain in browser memory and must be exported, then copied back into the vault before the next build.
