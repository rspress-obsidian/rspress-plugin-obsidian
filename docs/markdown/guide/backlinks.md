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

## Unlinked Mentions

Obsidian's backlinks pane has two lists: pages that link here, and pages that only *name* this page. Set `enableUnlinkedMentions` to render the second one, with a snippet of the surrounding text:

```ts
markdown({
  enableBacklinks: true,
  enableUnlinkedMentions: true,
});
```

A page's names are its frontmatter `title`, its `aliases`, and its file name — a heading is not a name. A page that also links here is a backlink, not a mention, so the two lists never repeat each other. Mention matching keeps a capped copy of each page body for the duration of the index (about 20k characters per page), which is why it is off by default.

## Basic Usage

```ts
markdown({
  enableBacklinks: true,
});
```

The panel appears at the bottom of each page:

```
┌─────────────────────────────────────┐
│ Backlinks                            │
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
markdown({
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
- Explore [Wikilinks](/markdown/guide/link-resolution) for linking syntax
