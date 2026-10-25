---
title: Getting Started
description: Install rspress-plugin-obsidian, add markdown() to your Rspress config, and publish an Obsidian vault with wikilinks, embeds and callouts.
---

# Getting Started

This guide sets up the Markdown feature of `rspress-plugin-obsidian`. You
install the package, add `markdown()` to your Rspress config, point it at your
vault, and turn on the features your notes use.

The plugin publishes a vault as a static site. It renders Obsidian's Markdown
at build time; it does not run Obsidian or its plugins.
[Compatibility](/obsidian-compatibility) lists what is supported and what is
not.

## Prerequisites

- Node.js 22.14.0 or later
- An Rspress 2 project. To start one, run `npm create rspress@latest`.

## Install

```bash
# Bun
bun add rspress-plugin-obsidian

# npm
npm install rspress-plugin-obsidian

# pnpm
pnpm add rspress-plugin-obsidian

# yarn
yarn add rspress-plugin-obsidian
```

The Markdown feature needs no other package. Two features use optional
packages that you install only if you use them: `mathjax-full` for the MathJax
math engine, and `mermaid` for diagrams. The plugin guides list any packages
their plugins need.

## Add the plugin

Register `markdown()` in `rspress.config.ts`:

```ts
import path from "node:path";
import { defineConfig } from "@rspress/core";
import { markdown } from "rspress-plugin-obsidian";

export default defineConfig({
  root: path.join(__dirname, "docs"),
  plugins: [markdown({ enableDefaultStyles: true })],
});
```

Pages in `docs/` can now use wikilinks, embeds, highlights, comments and
footnotes. `enableDefaultStyles` adds the plugin's stylesheet. Without it,
callouts, backlinks and embeds render with no styling. To load the stylesheet
yourself instead, see [Styles](./advanced.md#styles).

## Publish a vault

To publish an Obsidian vault that lives outside `docs/`, set `vaultRoot`. Each
note in the vault becomes a page under `/vault/`: `Projects/Plan.md` publishes
at `/vault/Projects/Plan`. The attachments that published notes use are
published too.

```ts
import path from "node:path";
import { defineConfig } from "@rspress/core";
import { markdown } from "rspress-plugin-obsidian";

export default defineConfig({
  root: path.join(__dirname, "docs"),
  plugins: [
    markdown({
      vaultRoot: path.join(__dirname, "My Vault"),
      enableCallouts: true,
      enableTransclusion: true,
      enableMediaEmbeds: true,
      enableBacklinks: true,
      enableTagLinking: true,
      enableTagPages: true,
      enableDefaultStyles: true,
    }),
  ],
});
```

This config turns on the features most vaults use. Every other feature, such as
math, Mermaid, Dataview or daily notes, is one more option; the
[Markdown overview](/markdown/) lists them all.

## Your first build

Run `npx rspress dev`, or `npx rspress build` for a production build.

A wikilink that resolves to no note fails the build by default
(`onBrokenLink: "error"`). The error names the note and the link, so you can
fix the link or create the missing note. To see every broken link in one run,
set `onBrokenLink: "warn"` while you work through them:

```ts
import path from "node:path";
import { defineConfig } from "@rspress/core";
import { markdown } from "rspress-plugin-obsidian";

export default defineConfig({
  root: path.join(__dirname, "docs"),
  plugins: [
    markdown({
      vaultRoot: path.join(__dirname, "My Vault"),
      onBrokenLink: "warn",
    }),
  ],
});
```

When several notes share a file name, the link resolves the way Obsidian
picks and the build prints a warning. To see why a link or block was reported,
read [Diagnostics](./advanced.md#diagnostics).

## What you get

The following syntax works with no options set:

| You write | You get |
|-----------|---------|
| `[[Note]]`, `[[Note\|text]]` | A link to the note, with the alias as its text when you give one. See [Wikilinks](./link-resolution.md). |
| `[[Note#Heading]]`, `[[#Heading]]`, `[[Note#^block]]` | A link to a heading or block. A heading link's tooltip shows the start of that section. |
| `[label](Note.md)` | A Markdown link to a note, resolved the same way as a wikilink. |
| `![[Note]]`, `![[image.png]]` | A link to the target. Set `enableTransclusion` and `enableMediaEmbeds` to show the content instead. |
| `==text==` | Highlighted text. |
| `%%text%%` | Nothing: comments are removed from the page, its outline and search. |
| `[^1]`, `^[inline]` | Footnotes. |
| `title`, `aliases`, `tags`, `cssclasses`, `excerpt`, `publish` in frontmatter | Link targets, tags, CSS classes, the page description, and drafts. |

[Note Syntax](./note-syntax.md) covers the last four rows in detail.

## Next steps

- [Live Examples](./examples.md): every feature, rendered on this site.
- [Markdown overview](/markdown/): every feature and the option that turns it on.
- [API Reference](./api.md#options): every option with its type and default.
