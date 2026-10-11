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

When `enableTagPages` is on, the plugin auto-generates `/tags/{name}` pages that list all pages with that tag — one page per tag across the docs root and the vault. Tags are case-insensitive, so `#Project` and `#project` share `/tags/project`.

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
    dateFormat: "YYYY-MM-DD",  // File naming format (Moment.js tokens)
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

### Date Formats

`dateFormat` uses the Moment.js tokens Obsidian's daily notes use, and a file
is a daily note only when its name matches the format exactly and names a real
date (`2024-02-30` is not one). Dates are local calendar dates, so a note named
`2024-01-01` is January 1 whatever the build machine's time zone.

| Token | Output |
|-------|--------|
| `YYYY` / `YY` | 2024 / 24 |
| `MMMM` / `MMM` / `MM` / `M` | January / Jan / 01 / 1 |
| `DD` / `D` / `Do` | 05 / 5 / 5th |
| `dddd` / `ddd` / `dd` | Friday / Fri / Fr |
| `ww` / `w`, `gggg` | locale week (weeks start Sunday) and its year |
| `WW` / `W`, `GGGG`, `E` | ISO week, its year, ISO weekday |
| `HH`, `hh`, `mm`, `ss`, `A` | hours, 12-hour hours, minutes, seconds, AM/PM |
| `[text]` | `text`, literally — `YYYY-MM-DD [Week] ww` |

### Template Notes

With `template` set, a daily note whose body is still empty is filled from that
note — the way Obsidian's daily-notes core fills a new note from its template.
A note you have already started writing is never touched, because a static build
has no cursor to insert at.

The template's tokens expand as Obsidian expands them when it creates the note.
They belong to the template: `{{date}}` written in an ordinary note stays as
written.

| Token | Output |
|-------|--------|
| `{{date}}`, `{{title}}` | The note's file name (its date in `dateFormat`) |
| `{{time}}` | The build's time, `HH:mm` |
| `{{date:FORMAT}}`, `{{time:FORMAT}}` | The note's date at the build's time of day, in FORMAT |
| `{{date+1d}}`, `{{date-1w:dddd}}` | Moved by Moment units: `y`, `Q` (quarters), `M` (months), `w`, `d`, `h`, `m` (minutes), `s`; as in Obsidian, `q` and `D` move nothing |
| `{{yesterday}}`, `{{tomorrow}}` | The neighbouring dates in `dateFormat` |

```markdown
---
tags: [journal]
---
# {{title}}

Planned for {{date:dddd}}, created at {{time}}.

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

With `enableDataview`, Dataview queries are evaluated at build time and follow
the Dataview plugin's own rules, so a vault's queries render on the site the
way they do in Obsidian.

### Inline Fields

```markdown
status:: open
owner:: [[Alice]]
tags-seen:: 1, 2, 3
spent:: 2 hours

Rated [rating:: 9] and (hidden:: secret) inline.
```

A field holding a `[[link]]` is a link (also in frontmatter: `up: "[[Home]]"`),
`1, 2, 3` is a list, `2 hours` a duration and `2024-01-15` a date. In the page,
`[rating:: 9]` shows its key and value, `(hidden:: secret)` only the value.
A line is read as `key:: value` as a whole only when it holds no bracketed field.

### List Items as Fields

```markdown
- author:: Alice
- [x] Completed task
- [ ] Pending task [due:: 2024-01-15]
- [ ] Ship it 📅 2024-01-20 ⏳ 2024-01-18
    - [/] A subtask in progress
```

Fields on plain list items (`author`) are page fields. Fields on a task —
bracketed, or the 📅 due, ⏳ scheduled, 🛫 start, ✅ completion and ➕ created
shorthands — belong to that task, so `TASK WHERE due` finds it. Any
one-character checkbox status is a task; only `x` counts as completed.
Indented items are subtasks of the item above.

### Query Blocks

````markdown
```dataview
LIST
FROM #tutorial
SORT file.name ASC
```
````

A query is one stream of words: `LIST FROM #tutorial SORT file.name` on one
line is the same query, a condition may continue on the next line, and `//`
starts a comment.

| Query type | Renders |
|------------|---------|
| `TABLE [fields]` | A table; the first column is the file (or the group key); `WITHOUT ID` drops it |
| `LIST [expr]` | A list of files; with an expression, `file: value` (`WITHOUT ID`: just the value) |
| `TASK` | Checklist items with their subtasks, optionally grouped |
| `CALENDAR <date field>` | A month grid per month, e.g. `CALENDAR file.day` |

| Clause | What it does |
|--------|--------------|
| `FROM` | `#tag` (with sub-tags), `"folder"`, `"folder/File"`, `[[note]]` (pages linking to it; `[[]]` is this page), `outgoing([[note]])`, combined with `and` / `or` / `-` / parentheses |
| `WHERE` | Keeps the rows whose condition is true |
| `SORT` | One or more keys, each `expr ASC|DESC` |
| `GROUP BY` | One row per value of an expression, with `key` and `rows`; `AS name` names the column |
| `FLATTEN` | One row per element of a list (`FLATTEN file.tasks AS task`) |
| `LIMIT` | At most this many rows |

After the `FROM`, the commands run in the order written and may repeat — a
`WHERE` after `GROUP BY` filters the groups.

### Grouping

````markdown
```dataview
TABLE sum(rows.priority) AS total
FROM "notes"
GROUP BY status
```
````

The first column is the group key, headed `status`; `rows` holds the grouped
pages, so `rows.file.link` lists them. `LIST rows.file.link GROUP BY status`
shows each key with its pages.

### Calendars

`CALENDAR` files each page under the date its field names. Pages whose field is
empty are left out.

````markdown
```dataview
CALENDAR file.day
FROM "daily"
```
````

### Expressions and Functions

Fields are referenced by name, and `this` is the page the query is on. Beyond
fields, every page has `file.*`: `path`, `name`, `folder`, `ext`, `size`,
`link`, `tags` (with parent tags), `etags`, `aliases`, `outlinks`, `inlinks`,
`tasks`, `lists`, `frontmatter`, `ctime`, `mtime`, `cday`, `mday` and `day` (a
daily note's date, a `date` field, or a date in the file name).

````markdown
```dataview
TABLE WITHOUT ID priority, owner, owner.status, scores[0]
FROM "notes"
WHERE file.mtime >= date(today) - dur(1 week)
SORT priority DESC
LIMIT 10
```
````

- Every function of Dataview is available: constructors (`date`, `dur`,
  `link`, `list`, `object`, `number`, `string`, `elink`, `embed`), numbers
  (`round`, `min`, `max`, `sum`, `product`, `average`, `minby`, `maxby`, …),
  lists and strings (`contains`, `icontains`, `econtains`, `containsword`,
  `filter`, `map`, `reduce`, `sort`, `reverse`, `unique`, `join`, `split`,
  `replace`, `regexreplace`, `regextest`, `regexmatch`, `substring`,
  `truncate`, …) and utilities (`default`, `choice`, `dateformat`,
  `durationformat`, `currencyformat`, `striptime`, `meta`, …). Lambdas look
  like `(x) => x * 2`.
- Dates: `date(today)`, `date(tomorrow)`, `date(sow)`, `date(eom)` and the
  other shorthands; `date(2024-01-15)`; properties such as `.year`, `.month`,
  `.day`, `.hour`, `.weekday`. Dates and durations add and subtract:
  `date(today) - dur(3 days)`.
- Times are the build machine's local time (set `TZ` to choose the zone), and
  render as Dataview does: `January 15, 2024`, or `9:30 AM - January 15, 2024`
  when there is a time.
- Comparisons are case-sensitive and type-aware, like Dataview's: `"2" = 2` is
  false. A missing field is `null`, arithmetic on it gives `null`, and an
  empty cell shows `-`.

Text the parser cannot place, a function Dataview does not have, or an
unresolvable `FROM` fails the query and follows `onDataviewError` (`"error"` by
default, `"warn"` to report and skip) — there is no silent partial result.

### Inline Queries

Write an inline query as inline code starting with `=`, as in Dataview:

```markdown
This note is `= this.file.name`, last changed `= this.file.mtime`.
It has `$= dv.current().file.tasks.length` tasks.
```

`` `= expr` `` is a DQL expression and `` `$= expr` `` an inline DataviewJS
expression. Plain prose like `x = name` is never evaluated.

> **Changed:** earlier versions evaluated an equals sign followed by an
> expression anywhere in prose (`Status = status`). Write such expressions as
> inline code instead — `` `= this.status` `` — and prefix page fields with
> `this.`, which is what Obsidian's Dataview expects.

### Task Queries

````markdown
```dataview
TASK
FROM "daily"
WHERE !completed
GROUP BY file.link
```
````

### DataviewJS (Sandboxed)

````markdown
```dataviewjs
for (const group of dv.pages("#project").groupBy(p => p.status)) {
  dv.header(3, group.key)
  dv.table(["Note", "Due"], group.rows.sort(p => p.due).map(p => [p.file.link, p.due]))
}
```
````

> **Note**: DataviewJS is interpreted, never run as JavaScript. It supports
> declarations, `if`, `for … of`, arrow functions, template literals and the
> `dv` API (`pages`, `current`, `page`, `table`, `list`, `taskList`,
> `paragraph`, `header`, `span`, `el`, `execute`, `func`, …). Host APIs
> (`process`, `fetch`, `eval`, `window`) are refused, and `dv.view` and
> asynchronous queries are not available.

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


