---
title: Configuration
description: All plugin options and how to configure vault scanning, routes, and previews.
---

# Configuration

Customize how the plugin discovers canvas files and generates routes.

## Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `vaultRoot` | `string` | `process.cwd()` | Root directory to scan for `.canvas` files |
| `routePrefix` | `string` | `/canvas` | URL prefix for generated canvas pages |
| `include` | `string[]` | `['**/*.canvas']` | Glob patterns for finding canvas files |
| `exclude` | `string[]` | `[]` | Glob patterns to ignore when scanning |
| `fileRoutePrefix` | `string` | — | URL prefix prepended to resolved Markdown file routes (e.g. `/docs`) |
| `linkPreview` | `boolean` | `false` | Render link nodes as embedded iframes |
| `iframeSandbox` | `string` | `allow-scripts allow-same-origin allow-popups` | Sandbox attributes applied to link-preview and PDF iframes |
| `editable` | `boolean` | `false` | Enable browser-side editing controls |
| `editorTitle` | `string` | `Canvas editor` | Editor banner and export filename |

## vaultRoot

Point to your Obsidian vault directory:

```ts
pluginObsidianCanvas({
  vaultRoot: './my-vault',
})
```

Canvas files are discovered relative to this path.

## routePrefix

Control the URL structure for canvas pages:

```ts
pluginObsidianCanvas({
  routePrefix: '/vault/canvas',
})
```

A file named `Architecture.canvas` becomes available at `/vault/canvas/architecture`.

## include / exclude

Filter which canvas files to process:

```ts
pluginObsidianCanvas({
  include: ['**/diagrams/*.canvas'],
  exclude: ['**/drafts/*.canvas'],
})
```

Uses [fast-glob](https://github.com/mrmlnc/fast-glob) pattern matching.

## fileRoutePrefix

Map file nodes to your Rspress documentation routes. When a file node references `Welcome.md`, this option determines the link destination:

```ts
pluginObsidianCanvas({
  fileRoutePrefix: '/docs',
})
```

| File Node Value | Resolved Link |
|-----------------|---------------|
| `Welcome.md` | `/docs/welcome` |
| `Notes/Setup.md` | `/docs/notes/setup` |
| `Guide.md#section` | `/docs/guide#section` |

Without this option, file nodes link to `/<filename>` directly.

## linkPreview and iframeSandbox

Enable iframe previews for link nodes and optionally customize the sandbox:

```ts
pluginObsidianCanvas({
  linkPreview: true,
  iframeSandbox: 'allow-scripts allow-same-origin',
})
```

When enabled, link nodes render an embedded iframe of the target URL. The default sandbox is `allow-scripts allow-same-origin allow-popups`. A stricter value can be supplied when the embedded content does not require popups.

## Editor mode

Enable the read/write-in-browser editor UI:

```ts
pluginObsidianCanvas({
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
