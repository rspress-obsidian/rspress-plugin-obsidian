---
title: Wikilinks
description: Wikilink and Markdown-link syntax, how a link finds its note, heading and block links, vault search, and what happens when a link does not resolve.
---

# Wikilinks

Wikilinks connect notes with `[[…]]` instead of URLs. They work with no options
set, and so do Markdown links to `.md` files. This guide shows the syntax, the
order the plugin tries when it looks for a target, and what happens when a link
finds nothing. The options that change resolution are listed under
[Link resolution](./api.md#link-resolution).

## Syntax

| You write | Renders as |
|-----------|------------|
| `[[Setup]]` | A link to the note `Setup`, with the text "Setup" |
| `[[Setup\|Start here]]` | The same link, with the text "Start here" |
| `[[Setup#Install]]` | A link to the `Install` heading, with the text "Setup > Install" |
| `[[Setup#Install\|Install it]]` | The heading link, with the text "Install it" |
| `[[#Install]]` | A link to a heading on the current page, with the text "Install" |
| `[[Setup#^step-1]]` | A link to a block, with the text "Setup > ^step-1" |
| `[[Setup#Linux#Install]]` | A link to the `Install` heading under `Linux` |
| `[Start here](Setup.md)` | A Markdown link, resolved the same way |

Without an alias, the link text is the target exactly as you typed it, as in
Obsidian. `[[2024-01-15]]` reads `2024-01-15`, and `[[my_note]]` reads
`my_note`.

## How a link resolves

For `[[target]]`, the plugin tries these steps in order and stops at the first
match:

1. **A relative path.** `[[./Plan]]` or `[[../shared/Concept]]` resolves from
   the linking note's folder. A relative link never falls back to the other
   steps.
2. **An exact path** from the vault root, such as `[[guide/Setup]]`. Notes and
   attachments both count, as do published canvas boards.
3. **A file name.** `[[Setup]]` matches any `Setup.md`, and `[[guide/Setup]]`
   matches any `…/guide/Setup.md`.
4. **A frontmatter `title` or alias.** `[[Start Here]]` matches a note with
   `aliases: [Start Here]`.
5. **A case-insensitive path or file name.** This step is on by default
   (`enableCaseInsensitiveLookup`).
6. **A path ending**, ignoring case. This step is off by default
   (`enableFuzzyMatching`).

With `vaultRoot` set, the docs and the vault are indexed separately. A vault
note tries steps 2–6 in the vault first, then in `docs/`. A docs page does the
reverse. This way, links work in both directions, and backlinks follow them.

When several files match at one step, the link resolves the way Obsidian picks:
the file in the linking note's folder, then the one with the shortest path,
then the first alphabetically. The build reports the choice and the
alternatives through `onAmbiguousLink` (default `"warn"`). To choose a file
yourself, write a longer path: `[[guide/Setup]]` instead of `[[Setup]]`.

If the vault folder is a symlink, or sits under one, links still resolve.
Rspress compiles each note at its real path, and the plugin maps that path back
to the `vaultRoot` you configured. Symlinks inside the vault are not followed,
so files reached only through one are not published.

## Headings

`[[Note#Heading]]` matches a heading by its text, its id, or the form Obsidian
writes when it links a heading. Characters that a link cannot hold, such as `:`,
become spaces: `## Step 1: Setup` is linked as `[[Note#Step 1 Setup]]`. The
match ignores case but is otherwise exact. A prefix or a single word of a
heading does not match, so a renamed heading is reported as broken instead of
landing on a different one. If a page has two headings with the same text,
reach the second by its id (`#install-1`).

The plugin indexes ATX headings (`# Heading`, with or without closing `#`s and
up to three leading spaces) and setext headings (`Heading` underlined with `===`
or `---`). Anchors use the same GitHub-style slugs as Rspress, and keep Unicode
letters. A custom id wins over the slug:

```markdown
## Install {#custom-id}

[[Setup#custom-id]]
```

## Blocks

A block id names one paragraph, list item or table. Write it at the end of the
block, or on its own line after it:

```markdown
This paragraph carries an id. ^key-point

| A | B |
|---|---|
| 1 | 2 |

^the-table
```

`[[Note#^key-point]]` links to the block, and `![[Note#^key-point]]` embeds it
(see [Transclusion](./transclusion.md)). A standalone id can be separated from
its block by a blank line and still names the block above it.

## Markdown links

With [`enableMarkdownLinks`](./api.md#link-resolution) (on by default), a
Markdown link to a `.md` or `.mdx` file goes through the same steps as a
wikilink. Obsidian accepts both forms, so a vault can mix them:

```markdown
[Setup](Setup.md)
[Install](Setup.md#install)
[Concept](../shared/Concept.md)
```

External URLs, `#anchor`-only links and extensionless routes are left alone.

Rspress normally checks every relative `.md` link itself, before the plugin
runs, and would fail on a vault-style `[x](Setup.md)` that names a note
elsewhere in the vault. The plugin therefore exempts exactly the `.md`
destinations it resolves from Rspress's `markdown.link.checkDeadLinks`, unless
your config sets that option itself. A broken `[x](missing.md)` is still
reported, by the plugin through `onBrokenLink`. A broken `/typo-route` is still
reported by Rspress.

## Vault search

`[[##query]]` searches the headings of the whole vault, and `[[^^query]]`
searches its block ids. A query that matches exactly one target becomes a
normal link to it.

When several targets match, the link renders as a picker: a button that opens a
filterable list of the matches, with the page each one belongs to. This is the
static counterpart of the list Obsidian opens. The list is built at build time,
so it works without client-side resolution. A query that matches nothing is
shown as an unresolved link.

## When a link does not resolve

By default (`onBrokenLink: "error"`), a link whose note, heading or block does
not exist fails the build. The error names the page and the target. For a
missing heading or block, it also lists the headings or blocks that exist.

With `onBrokenLink: "warn"`, the build continues and the link renders as its
text inside `<span class="obsidian-unresolved">`, with the reason as a tooltip.
[Diagnostics](./advanced.md#diagnostics) covers the full set of reports.
