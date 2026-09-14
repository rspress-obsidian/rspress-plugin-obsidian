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
2. **Base name match** — `Page` matches a file's basename
3. **Title match** — `Page` matches a page's frontmatter `title`
4. **Alias match** — `Page` matches a page's frontmatter `aliases`
5. **Fuzzy match** — Shortest suffix path fallback (if enabled)
6. **Case-insensitive** — Case-insensitive path resolution (if enabled)

If no match is found, the link is marked as broken (behavior controlled by `onBrokenLink`).

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

## Configuration

```ts
pluginObsidianWikiLink({
  onBrokenLink: "error",        // "error" | "warn"
  onAmbiguousLink: "error",     // "error" | "warn"
  enableFuzzyMatching: false,   // Enable shortest-suffix fallback
  enableCaseInsensitiveLookup: true,  // Case-insensitive resolution
  enableMarkdownLinks: true,    // Resolve .md links as wikilinks
});
```

## Publishing an external Obsidian vault

Point the plugin at an existing vault when your notes live outside the Rspress `docs/` directory:

```ts
pluginObsidianWikiLink({
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
