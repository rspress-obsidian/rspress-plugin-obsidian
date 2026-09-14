---
description: Automatic backlinks panel showing pages that link to the current page.
---

# Backlinks

Backlinks automatically show which pages link to the current page, creating a bidirectional link system like Obsidian.

## How It Works

When `enableBacklinks` is on, the plugin:
1. Scans all pages for wikilinks during build
2. Builds a reverse index (target → sources)
3. Appends a backlinks panel to each page

## Basic Usage

```ts
pluginObsidianWikiLink({
  enableBacklinks: true,
});
```

The panel appears at the bottom of each page:

```
┌─────────────────────────────────────┐
│ Backlinks (3)                       │
│                                     │
│ • Getting Started                   │
│ • Advanced Configuration            │
│ • Examples                          │
└─────────────────────────────────────┘
```

## What Counts as a Backlink

| Source | Counted |
|--------|---------|
| `[[Page]]` wikilinks | ✅ |
| `![[Page]]` transclusions | ✅ |
| `#tag` inline tags | ❌ |
| External URLs | ❌ |
| Pure anchor links `[[#Heading]]` | ❌ |

## Configuration

```ts
pluginObsidianWikiLink({
  enableBacklinks: true,
  enableDefaultStyles: true,  // Inject bundled CSS
});
```

## Styling

The backlinks panel uses these CSS classes:

- `.obsidian-backlinks` — Container
- `.obsidian-backlinks h2` — Title
- `.obsidian-backlinks ul` — Link list
- `.obsidian-backlinks a` — Individual links

## Next Steps

- Learn about [[transclusion|Transclusion]] for embedding content
- Explore [[wikilinks|Wikilinks]] for linking syntax
