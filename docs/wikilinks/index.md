---
description: Wikilinks, callouts, backlinks, transclusion, and all Obsidian markdown features.
---

# Wikilinks & Markdown

This section covers the Obsidian-style markdown features: wikilinks, callouts, backlinks, transclusion, tags, daily notes, and Dataview.

## Features

| Feature | Description | Option |
|---------|-------------|--------|
| Wikilinks | `[[Page]]`, `[[Page#Heading]]`, `[[Page\|Alias]]` | Always on |
| Callouts | `> [!note]`, `> [!warning]+`, `> [!tip]-` | `enableCallouts` |
| Backlinks | Panel listing pages that link to current page | `enableBacklinks` |
| Transclusion | `![[Page]]` inlines content from another page | `enableTransclusion` |
| Media Embeds | `![[image.png]]`, `![[video.mp4]]` | `enableMediaEmbeds` |
| Tags | `#tag` links and auto-generated tag pages | `enableTagLinking`, `enableTagPages` |
| Daily Notes | Date-based notes with navigation | `enableDailyNotes` |
| Dataview | Static query evaluation at build time | `enableDataview` |

## Quick Setup

```ts
import { pluginObsidianWikiLink } from "rspress-plugin-obsidian";

export default defineConfig({
  plugins: [
    pluginObsidianWikiLink({
      enableCallouts: true,
      enableBacklinks: true,
      enableTransclusion: true,
      enableMediaEmbeds: true,
      enableTagLinking: true,
      enableTagPages: true,
      enableDailyNotes: true,
      enableDataview: true,
      enableDefaultStyles: true,
    }),
  ],
});
```

## Basic Wikilink Syntax

| Syntax | Description |
|--------|-------------|
| `[[Page]]` | Link to another page |
| `[[Page\|Alias]]` | Link with custom display text |
| `[[Page#Heading]]` | Link to a specific heading |
| `[[Page#Heading\|Alias]]` | Link to heading with alias |
| `[[#Heading]]` | Link to heading in current page |
| `[[Page#^block]]` | Block reference |

## Embed & Transclusion Syntax

| Syntax | Description |
|--------|-------------|
| `![[Page]]` | Transclude full page content |
| `![[Page#Heading]]` | Transclude a specific section |
| `![[Page#^block]]` | Transclude a specific block |
| `![[image.png]]` | Embed an image |
| `![[image.png\|300x200]]` | Embed image with dimensions |
| `![[video.mp4]]` | Embed a video |
| `![[audio.mp3]]` | Embed audio |
| `![[doc.pdf]]` | Embed a PDF |

## Always-On Features

These features require no configuration:

- **Comments**: `%% ... %%` are stripped from output
- **Highlights**: `==text==` becomes `<mark>` tags
- **Footnotes**: `[^1]` and `^[inline]` work automatically
- **Frontmatter**: `title`, `aliases`, `tags`, `cssclasses`, `excerpt`, `publish`

```yaml
---
title: My Page
aliases:
  - Alternate Name
tags:
  - tutorial
cssclasses:
  - custom-layout
excerpt: A brief description
publish: true
---

## External vault publishing

To publish a separate Obsidian vault, set `vaultRoot`. Markdown pages are published under `vaultRoutePrefix`, and wikilinks inside those pages resolve against the vault rather than the Rspress docs directory:

```ts
pluginObsidianWikiLink({
  vaultRoot: "./Obsidian Vault",
  vaultRoutePrefix: "/vault",
  enableTransclusion: true,
  enableMediaEmbeds: true,
  enableBacklinks: true,
})
```

The implementation supports page targets, aliases, headings, block IDs, relative links, attachments, media embeds, and nested transclusion. Obsidian application features such as live editing, plugin APIs, Bases, Tasks, and Templater are outside static Rspress publishing.
