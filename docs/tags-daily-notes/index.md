---
description: Tags, daily notes, and Dataview features for organizing your vault.
---

# Tags & Daily Notes

This section covers vault organization features: tags for categorization, daily notes for journaling, and Dataview for querying your content.

## Tags

Tags provide a flexible way to categorize and link your pages.

### Inline Tags

When `enableTagLinking` is on, inline `#tag` tokens become links to tag pages:

```markdown
This page covers #javascript and #typescript.
```

Nested tags work too:

```markdown
Check out #project/ideas for related content.
```

### Frontmatter Tags

Tags can also be defined in frontmatter:

```yaml
---
tags:
  - tutorial
  - obsidian
  - rspress
---
```

### Tag Pages

When `enableTagPages` is on, the plugin auto-generates `/tags/{name}` pages that list all pages with that tag.

| Feature | Option | Description |
|---------|--------|-------------|
| Inline tag linking | `enableTagLinking` | `#tag` → `[#tag](/tags/tag)` |
| Tag page generation | `enableTagPages` | Auto-generate `/tags/{name}` pages |
| Nested tags | Both | `#tag/subtag` creates hierarchical structure |
| Unicode tags | Both | `#日本語`, `#émoji` supported |

## Daily Notes

Daily notes provide date-based organization with automatic navigation.

### Setup

```ts
pluginObsidianWikiLink({
  enableDailyNotes: true,
  dailyNotes: {
    folder: "daily",           // Folder for daily notes
    dateFormat: "YYYY-MM-DD",  // File naming format
    navigation: true,          // Show prev/next navigation
  },
});
```

### File Structure

```
docs/
  daily/
    2024-01-01.md
    2024-01-02.md
    2024-01-03.md
```

### Date Expansion

Template tokens expand in content:

| Token | Output |
|-------|--------|
| `YYYY` | 2024 |
| `YY` | 24 |
| `MMMM` | January |
| `MMM` | Jan |
| `MM` | 01 |
| `DD` | 01 |
| `dddd` | Monday |
| `ddd` | Mon |

### Navigation

When `navigation: true`, each daily note shows previous/next links based on date.

## Dataview

Dataview provides static query evaluation at build time.

### Inline Fields

```markdown
status:: open
priority:: high
assignee:: Alice
```

### List Items as Fields

```markdown
- [x] Completed task
- [ ] Pending task due:: 2024-01-15
```

### Query Blocks

````markdown
```dataview
LIST
FROM #tutorial
SORT file.name ASC
```
````

### Task Queries

````markdown
```dataview
TASK
FROM "daily"
WHERE completed = false
```
````

### DataviewJS (Sandboxed)

````markdown
```dataviewjs
const pages = dv.pages("#tutorial");
dv.list(pages.map(p => p.file.link));
```
```

> **Note**: DataviewJS runs in a sandboxed interpreter. Host APIs (`process`, `fetch`, `eval`) are blocked.

## Graph integration

When `pluginGraphview()` is enabled alongside this plugin, published tag pages and daily notes participate in the same graph as regular documentation pages:

- frontmatter tags connect a page to its generated `/tags/{tag}` page;
- inline tags use the same tag-page target when `enableTagLinking` is enabled;
- daily-note pages are nodes, and their wikilinks form edges to related notes;
- generated daily navigation is rendered as page navigation and is available to the graph when represented as links in the source content.

See the [Graph View guide](/graph/guide/graph-view#obsidian-content-support) for the combined configuration.

## Combined vault and graph example

```ts
pluginObsidianWikiLink({
  vaultRoot: "./Obsidian Vault",
  vaultRoutePrefix: "/vault",
  enableTagLinking: true,
  enableTagPages: true,
  enableDailyNotes: true,
  dailyNotes: {
    folder: "daily",
    dateFormat: "YYYY-MM-DD",
    navigation: true,
  },
});
pluginGraphview({ defaultOpen: true });
```

For example, a note with `tags: [project/ideas]` links to `/tags/project/ideas`, while `[[2026-09-14]]` links one daily note to another. Both relationships appear in the Graph View.

See the [Graph View guide](/graph/guide/graph-view#obsidian-content-support) for the complete integration table.


