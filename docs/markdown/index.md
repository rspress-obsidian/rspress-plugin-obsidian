---
title: Markdown
description: What the Markdown feature of rspress-plugin-obsidian renders, which syntax is always on, which features you turn on, and where each one is documented.
---

# Markdown

The Markdown feature, `markdown()`, renders Obsidian notes as Rspress pages.
It covers the pages in your `docs/` folder and, with `vaultRoot`, a whole
Obsidian vault. Wikilinks, embeds, highlights, comments, footnotes and
frontmatter work as soon as you add the plugin. Every other feature is off
until you set its option, so a site renders only what you ask for.

New to the plugin? Start with [Getting Started](./guide/getting-started.md),
then browse the [Live Examples](./guide/examples.md).

## Always on

| Guide | What it covers |
|-------|----------------|
| [Wikilinks](./guide/link-resolution.md) | `[[links]]`, heading and block links, Markdown links to notes, how a link finds its note |
| [Note Syntax](./guide/note-syntax.md) | `%%comments%%`, `==highlights==`, footnotes, frontmatter, `publish: false` drafts |

## Features you turn on

| Guide | What it covers | Option |
|-------|----------------|--------|
| [Callouts](./guide/callouts.md) | `> [!note]` boxes, foldable and nested | `enableCallouts` |
| [Transclusion](./guide/transclusion.md) | Embedding a note, section or block with `![[Note]]` | `enableTransclusion` |
| [Media Embeds](./guide/media-embeds.md) | Images, audio, video, PDFs, YouTube and X | `enableMediaEmbeds` |
| [Backlinks](./guide/backlinks.md) | A panel of the notes that link to each page, and unlinked mentions | `enableBacklinks` |
| [Tags & Daily Notes](./guide/tags-and-daily-notes.md) | Tag links, generated tag pages, daily-note navigation, templates and calendar | `enableTagLinking`, `enableTagPages`, `enableDailyNotes` |
| [Math](./guide/advanced.md#math) | `$…$` and `$$…$$` with KaTeX or MathJax | `enableMath` |
| [Mermaid](./guide/advanced.md#mermaid-diagrams) | ` ```mermaid ` diagrams | `enableMermaid` |

Most of these emit HTML classes only. Set `enableDefaultStyles: true` to load
the stylesheet that styles them.

## Obsidian plugins {#obsidian-plugins}

The plugin also renders the output of popular Obsidian plugins at build time,
using your vault's plugin settings where it can.

| Guide | What it covers | Option |
|-------|----------------|--------|
| [Dataview](./guide/dataview.md) | Inline fields, `TABLE`/`LIST`/`TASK`/`CALENDAR` queries, inline queries, DataviewJS | `enableDataview` |
| [Tasks](./guide/tasks.md) | ` ```tasks ` queries over every task on the site | `enableTasks` |
| [Kanban](./guide/kanban.md) | Kanban boards as read-only pages | `enableKanban` |
| [Excalidraw](./guide/excalidraw.md) | Drawings as static SVG, as pages and embeds | `enableExcalidraw` |
| [Bases](./guide/bases.md) | `.base` files and ` ```base ` blocks as tables, cards and maps | `enableBases` |
| [Templater](./guide/templater.md) | Templates applied to new notes, and `<% %>` commands | `enableTemplater` |

## Reference

- [Advanced](./guide/advanced.md): publishing a vault, math and diagrams,
  styles, diagnostics, security and troubleshooting.
- [API Reference](./guide/api.md): every option with its type and default,
  and the exported helpers.
