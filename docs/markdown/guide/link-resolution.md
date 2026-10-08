---
description: Complete guide to wikilink syntax, aliases, headings, and block references.
---

# Wikilinks

Wikilinks are the core of Obsidian-style linking. They let you connect pages using simple `[[...]]` syntax instead of traditional markdown links.

## Basic Syntax

| Syntax | Description | Example |
|--------|-------------|---------|
| `[[Page]]` | Link to another page | `[[Getting Started]]` |
| `[[Page\|Alias]]` | Link with custom display text | `[[Getting Started\|Start Here]]` |
| `[[Page#Heading]]` | Link to a specific heading | `[[Getting Started#Install]]` |
| `[[Page#Heading\|Alias]]` | Link to heading with alias | `[[Getting Started#Install\|Installation Guide]]` |
| `[[#Heading]]` | Link to heading in current page | `[[#Basic Syntax]]` |
| `[[Page#^block]]` | Block reference | `[[Notes#^important-point]]` |

## How Resolution Works

When you write `[[Page]]`, the plugin resolves it in this order:

1. **Exact path match** — `docs/Page.md` exists
2. **Base name match** — `Page` matches a file's basename; `[[sub/Page]]` matches
   any `…/sub/Page.md` (a path suffix), no fuzzy matching needed
3. **Title match** — `Page` matches a page's frontmatter `title`
4. **Alias match** — `Page` matches a page's frontmatter `aliases`
5. **Case-insensitive** — Case-insensitive path resolution (on by default)
6. **Fuzzy match** — Shortest suffix path fallback (if enabled)

When several files match a step, the link resolves the way Obsidian picks: the
file in the linking note's own folder, else the shortest vault path, else the
alphabetically first. The choice and the alternatives are reported through
`onAmbiguousLink` (default `"warn"`).

With `vaultRoot` set, a docs page whose own tree has no match tries the vault,
and a vault note tries the docs root, so the two can link each other and the
backlinks follow.

If no match is found, the link is marked as broken (behavior controlled by `onBrokenLink`).

## Link Text

The link shows what Obsidian shows: the alias when there is one, otherwise the
target exactly as typed — `[[2024-01-15]]` reads `2024-01-15`, `[[my_note]]`
reads `my_note`. A subpath is shown as `Note > Heading` or `Note > ^block`, and a
same-page `[[#Heading]]` as just `Heading`.

## Headings

`[[Note#Heading]]` matches a heading exactly — its text, its id, or Obsidian's
link form of it (where `:` and the other characters a link cannot hold read as
spaces). A prefix or a word of a heading does not match: a renamed heading is
reported through `onBrokenLink` rather than sent to a different one.
`[[Note#Chapter#Details]]` picks the `Details` heading under `Chapter`.

## Aliases

Aliases let you link to pages using alternative names:

```yaml
---
title: Getting Started
aliases:
  - Start Here
  - Quick Start
  - Beginner Guide
---
```

Now all of these work:
```markdown
[[Getting Started]]
[[Start Here]]
[[Quick Start]]
[[Beginner Guide]]
```

## Heading Links

Link to specific sections using `#`:

```markdown
[[Getting Started#Install]]
[[Getting Started#Install|Installation Guide]]
```

The heading slug is auto-generated from the heading text. Custom IDs are also supported:

```markdown
## Install {#custom-id}

[[Getting Started#custom-id]]
```

## Block References

Block references target specific paragraphs or list items:

```markdown
Add a block ID: This is important. ^important-point

Reference it: [[Notes#^important-point]]
```

## Markdown Link Resolution

Standard markdown links to `.md` files are also resolved as wikilinks:

```markdown
[Getting Started](getting-started.md)
[Install](getting-started.md#install)
```

This means you can use either syntax — both work identically.

## Vault search and the picker

`[[##query]]` searches the whole vault's headings, `[[^^query]]` its block ids.
A query that matches exactly one target links straight to it, the way
`[[Page#Heading]]` would.

When several targets match — two pages with a `## Setup Guide` heading, say —
the link renders as an inline picker: a button that opens a filterable list of
the matches, with the page each one lives in shown beside it. That is the
equivalent of the picker Obsidian opens for an ambiguous vault search, on a page
that can only ship static files. Pick a row to navigate; nothing is resolved in
the browser, so the list keeps working with JavaScript-free export, hydration
included.

A query that matches nothing stays marked as an unresolved link, so the gap is
visible rather than silent.

## Configuration

```ts
markdown({
  onBrokenLink: "error",        // "error" | "warn"
  onAmbiguousLink: "warn",      // "warn" (default) | "error"
  enableFuzzyMatching: false,   // Enable shortest-suffix fallback
  enableCaseInsensitiveLookup: true,  // Case-insensitive resolution
  enableMarkdownLinks: true,    // Resolve .md links as wikilinks
});
```

## Publishing an external Obsidian vault

Point the plugin at an existing vault when your notes live outside the Rspress `docs/` directory:

```ts
markdown({
  vaultRoot: "./Obsidian Vault",
  vaultRoutePrefix: "/vault",
  enableTransclusion: true,
  enableMediaEmbeds: true,
  enableBacklinks: true,
});
```

For a vault containing:

```text
Obsidian Vault/
├── Welcome.md
├── guide/Setup Guide.md
└── assets/diagram.png
```

These references resolve inside the vault:

```md
[[Welcome]]
[[guide/Setup Guide|Setup guide]]
[[guide/Setup Guide#Installation]]
![[guide/Setup Guide]]
![[assets/diagram.png|640]]
```

The generated routes are `/vault/Welcome`, `/vault/guide/Setup%20Guide`, and `/vault/assets/diagram.png`. Vault pages use the vault index, so similarly named files in the normal docs tree do not shadow vault targets.

## Next Steps

- Learn about [[callouts|Callouts]] for styled content blocks
- See [[backlinks|Backlinks]] for automatic link discovery
- Explore [[transclusion|Transclusion]] for embedding content
