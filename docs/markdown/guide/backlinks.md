---
description: Automatic backlinks panel showing pages that link to the current page.
---

# Backlinks

Backlinks automatically show which pages link to the current page, creating a bidirectional link system like Obsidian.

## How It Works

When `enableBacklinks` is on, the plugin:
1. Collects every link each page makes during build: wikilinks and embeds,
   Markdown links and images, reference definitions, `obsidian://open` URIs, and
   wikilinks in frontmatter properties (`related: "[[Target]]"`, `up: ["[[a/b]]"]`,
   which Obsidian 1.4+ counts as links)
2. Resolves each one exactly as the rendered link is resolved, and records a
   backlink on the page it reaches — an ambiguous name only on the page it
   resolved to
3. Appends a backlinks panel to each page

With `vaultRoot` set, a docs page linking a vault note shows up in that note's
panel, and the other way round.

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
