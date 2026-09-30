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
markdown({
  enableDailyNotes: true,
  dailyNotes: {
    folder: "daily",           // Folder for daily notes
    dateFormat: "YYYY-MM-DD",  // File naming format
    navigation: true,          // Show prev/next navigation
    template: "templates/Daily",// Fill empty daily notes from this note
    calendar: "/daily",        // Generate a calendar page at this route
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

Two more tokens expand in note content: `{{title}}` (the note's title, its
date-formatted filename for a daily note) and `{{time}}`.

### Template Notes

With `template` set, a daily note whose body is still empty is filled from that
note — the way Obsidian's daily-notes core fills a new note from its template.
A note you have already started writing is never touched, because a static build
has no cursor to insert at.

```markdown
---
tags: [journal]
---
# {{title}}

Planned for {{date:dddd}}.

- [ ] First task
```

### Calendar Page

With `calendar` set to a route, the plugin generates that page listing every
daily note grouped by month, newest first — the published equivalent of
Obsidian's daily-notes calendar view.

```ts
markdown({ enableDailyNotes: true, dailyNotes: { calendar: "/daily" } });
// → /daily lists every dated note
```

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

| Query type | Renders |
|------------|---------|
| `TABLE [fields]` | A table; add `WITHOUT ID` to drop the leading file column |
| `LIST [expr]` | A list, one item per row |
| `TASK` | Checklist items, optionally grouped |
| `CALENDAR` | A month grid per month in the results |

| Clause | What it does |
|--------|--------------|
| `FROM` | `"folder"`, `"folder/File.md"`, `#tag`, `[[note]]`, `inlinks([[note]])`, `outlinks([[note]])`, combined with `AND` / `OR` / `-` / parentheses |
| `WHERE` | Filters rows; repeat the clause to AND several conditions |
| `SORT` | One or more sort keys, each `expr ASC|DESC` |
| `GROUP BY` | One or more keys — `GROUP BY status, owner` produces one row per pair |
| `THEN` | An aggregate evaluated per group, appended under it |
| `FLATTEN` | Expands an array field into one row per item |
| `LIMIT` | Row count, literal or an expression such as `LIMIT len(rows)` |

### Grouping with Totals

````markdown
```dataview
TABLE WITHOUT ID sum(rows.priority) AS total
FROM "notes"
GROUP BY status
THEN sum(rows.priority)
```
````

### Calendars

`CALENDAR` files each row under `file.day` — a daily note's date — and falls
back to the day the note was created, so an ordinary note still lands somewhere
sensible. One month grid is drawn per month, newest first.

````markdown
```dataview
CALENDAR
FROM "daily"
```
````

### Expressions and Functions

Inline fields are referenced by name. Beyond `file.*` (path, name, folder, ext,
size, link, tags, etags, outlinks, inlinks, tasks, lists, ctime, mtime, cday,
mday and `day` for daily notes), indexing and functions are available:

````markdown
```dataview
TABLE WITHOUT ID priority, owner, scores[0]
FROM "notes"
WHERE dateformat(launched, "yyyy") = "2026"
SORT priority DESC
LIMIT 10
```
````

- Indexing: `rows[0]`, `scores[-1]` (from the end), `file["name"]`. An index
  past the end reads as empty rather than failing the query.
- Dates: `date`, `now`, `today`, `year`, `month`, `weekday` (1 = Monday),
  `weeknumber`, `weekyear`, `hour`, `minute`, `second`, `striptime`,
  `dateformat` / `formatdate` (Luxon tokens: `yyyy`, `MM`, `dd`, `LLLL`, …),
  `dateplus` / `dateminus` with a duration such as `"2 weeks"` or `"1 month"`.
- Strings: `contains`, `startswith`, `endswith`, `lower`, `upper`, `trim`,
  `truncate`, `padleft`, `padright`, `titlecase`, `capitalize`, `reversestring`,
  `split`, `join`, `replace`, `regexmatch`, `length`, `typeof`, `default`,
  `choice`, `nonnull`, `defaultblank`.
- Collections: `sum`, `average`, `min`, `max`, `firstvalueof`, `lastvalueof`,
  `distinct`, `flatten`, `any`, `all`, `strictsort`.
- Math: `round`, `floor`, `ceil`, and `+ - * /` in expressions.

Anything outside this set fails the query and follows `onDataviewError`
(`"error"` by default, `"warn"` to report and skip) — there is no silent
partial result.

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

When `graphview()` is enabled alongside this plugin, published tag pages and daily notes participate in the same graph as regular documentation pages:

- frontmatter tags connect a page to its generated `/tags/{tag}` page;
- inline tags use the same tag-page target when `enableTagLinking` is enabled;
- daily-note pages are nodes, and their wikilinks form edges to related notes;
- generated daily navigation is rendered as page navigation and is available to the graph when represented as links in the source content.

See the [Graph View guide](/graph/guide/graph-view#obsidian-content-support) for the combined configuration.

## Combined vault and graph example

```ts
markdown({
  vaultRoot: "./Obsidian Vault",
  vaultRoutePrefix: "/vault",
  enableTagLinking: true,
  enableTagPages: true,
  enableDailyNotes: true,
  dailyNotes: {
    folder: "daily",
    dateFormat: "YYYY-MM-DD",
    navigation: true,
    calendar: "/daily",
  },
});
graphview({ defaultOpen: true });
```

For example, a note with `tags: [project/ideas]` links to `/tags/project/ideas`, while `[[2026-09-14]]` links one daily note to another. Both relationships appear in the Graph View.

See the [Graph View guide](/graph/guide/graph-view#obsidian-content-support) for the complete integration table.


