---
title: Dataview
description: Evaluate Dataview queries at build time — inline fields, TABLE, LIST, TASK and CALENDAR blocks, inline queries and sandboxed DataviewJS — with the Dataview plugin's own rules.
---

# Dataview

With `enableDataview`, the plugin evaluates Dataview queries when the site
builds and publishes their results as static HTML. Queries follow the Dataview
plugin's own rules, so they render on the site the way they render in Obsidian.
Use it when your vault already relies on Dataview tables, lists or task lists.

```ts
markdown({ enableDataview: true });
```

A query that does not parse or evaluate fails the build by default. Set
[`onDataviewError`](./api.md#diagnostics) to `"warn"` to report it and keep
building. While `enableDataview` is off, `dataview` and `dataviewjs` blocks stay
on the page as code, and [`onUnsupportedBlock`](./api.md#diagnostics) reports
them.

## Fields

Frontmatter properties are fields. Inline fields work as well:

```markdown
status:: open
owner:: [[Alice]]
tags-seen:: 1, 2, 3
spent:: 2 hours

Rated [rating:: 9] and (hidden:: secret) inline.
```

A field that holds a `[[link]]` is a link, including in frontmatter
(`up: "[[Home]]"`). `1, 2, 3` is a list, `2 hours` is a duration and
`2024-01-15` is a date. On the page, `[rating:: 9]` shows its key and value,
while `(hidden:: secret)` shows only the value. A line is read as one
`key:: value` field only when it holds no bracketed field.

### Fields on list items and tasks

```markdown
- author:: Alice
- [x] Completed task
- [ ] Pending task [due:: 2024-01-15]
- [ ] Ship it 📅 2024-01-20 ⏳ 2024-01-18
    - [/] A subtask in progress
```

A field on a plain list item, such as `author`, belongs to the page. A field on
a task belongs to that task, so `TASK WHERE due` finds it. Task fields can be
bracketed fields or the Tasks emoji shorthands: 📅 due, ⏳ scheduled,
🛫 start, ✅ completion and ➕ created. Any one-character checkbox status makes
a task, but only `x` counts as completed. Indented items are subtasks of the
item above them.

## Query blocks

````markdown
```dataview
LIST
FROM #tutorial
SORT file.name ASC
```
````

A query reads as one stream of words. `LIST FROM #tutorial SORT file.name` on
one line is the same query, a condition can continue on the next line, and
`//` starts a comment.

| Query type | Renders |
|------------|---------|
| `TABLE [fields]` | A table whose first column is the file, or the group key. `WITHOUT ID` drops that column. |
| `LIST [expr]` | A list of files. With an expression, each item is `file: value`; with `WITHOUT ID`, just the value. |
| `TASK` | Checklist items with their subtasks, optionally grouped. |
| `CALENDAR <date field>` | A month grid for each month, for example `CALENDAR file.day`. |

| Clause | What it does |
|--------|--------------|
| `FROM` | Selects pages by `#tag` (with sub-tags), `"folder"`, `"folder/File"`, `[[note]]` (pages that link to it; `[[]]` is this page) or `outgoing([[note]])`. Combine sources with `and`, `or`, `-` and parentheses. |
| `WHERE` | Keeps the rows whose condition is true. |
| `SORT` | Sorts by one or more keys, each `expr ASC` or `expr DESC`. |
| `GROUP BY` | Makes one row per value of an expression, with `key` and `rows`. `AS name` names the column. |
| `FLATTEN` | Makes one row per element of a list (`FLATTEN file.tasks AS task`). |
| `LIMIT` | Keeps at most this many rows. |

After `FROM`, clauses run in the order you write them and can repeat. For
example, a `WHERE` after `GROUP BY` filters the groups.

### Grouping

````markdown
```dataview
TABLE sum(rows.priority) AS total
FROM "notes"
GROUP BY status
```
````

The first column holds the group key, under the heading `status`. `rows` holds
the grouped pages, so `rows.file.link` lists them.
`LIST rows.file.link GROUP BY status` shows each key with its pages.

### Tasks

````markdown
```dataview
TASK
FROM "daily"
WHERE !completed
GROUP BY file.link
```
````

### Calendars

`CALENDAR` places each page under the date its field holds. Pages where that
field is empty are left out.

````markdown
```dataview
CALENDAR file.day
FROM "daily"
```
````

## Expressions

Refer to a field by its name. `this` is the page the query is on. Every page
also has `file.*`: `path`, `name`, `folder`, `ext`, `size`, `link`, `tags`
(with parent tags), `etags`, `aliases`, `outlinks`, `inlinks`, `tasks`,
`lists`, `frontmatter`, `ctime`, `mtime`, `cday`, `mday` and `day`. `day` is a
daily note's date, a `date` field, or a date in the file name.

````markdown
```dataview
TABLE WITHOUT ID priority, owner, owner.status, scores[0]
FROM "notes"
WHERE file.mtime >= date(today) - dur(1 week)
SORT priority DESC
LIMIT 10
```
````

- Every Dataview function is available. That includes constructors (`date`,
  `dur`, `link`, `list`, `object`, `number`, `string`, `elink`, `embed`),
  numeric functions (`round`, `min`, `max`, `sum`, `product`, `average`,
  `minby`, `maxby`, …), list and string functions (`contains`, `icontains`,
  `econtains`, `containsword`, `filter`, `map`, `reduce`, `sort`, `reverse`,
  `unique`, `join`, `split`, `replace`, `regexreplace`, `regextest`,
  `regexmatch`, `substring`, `truncate`, …) and utilities (`default`,
  `choice`, `dateformat`, `durationformat`, `currencyformat`, `striptime`,
  `meta`, …). Lambdas look like `(x) => x * 2`.
- Dates: `date(today)`, `date(tomorrow)`, `date(sow)`, `date(eom)` and the other
  shorthands, as well as `date(2024-01-15)`. Dates have properties such as
  `.year`, `.month`, `.day`, `.hour` and `.weekday`. You can add and subtract
  dates and durations: `date(today) - dur(3 days)`.
- Times use the build machine's local time zone; set `TZ` to choose another.
  They render as Dataview renders them: `January 15, 2024`, or
  `9:30 AM - January 15, 2024` when there is a time.
- Comparisons are case-sensitive and type-aware, as in Dataview, so `"2" = 2` is
  false. A missing field is `null`, arithmetic on `null` gives `null`, and an
  empty cell shows `-`.

The query fails, and `onDataviewError` applies, when the parser finds text it
cannot place, a function Dataview does not have, or a `FROM` source that does
not resolve. A failed query never publishes a partial result.

## Inline queries

Inline code that starts with `=` is an inline query, as in Dataview:

```markdown
This note is `= this.file.name`, last changed `= this.file.mtime`.
It has `$= dv.current().file.tasks.length` tasks.
```

`` `= expr` `` is a DQL expression, and `` `$= expr` `` is an inline DataviewJS
expression. Plain prose such as `x = name` is never evaluated. If you upgrade
from a version that evaluated `Status = status` in prose, rewrite those
expressions as `` `= this.status` ``.

## DataviewJS

````markdown
```dataviewjs
for (const group of dv.pages("#project").groupBy(p => p.status)) {
  dv.header(3, group.key)
  dv.table(["Note", "Due"], group.rows.sort(p => p.due).map(p => [p.file.link, p.due]))
}
```
````

DataviewJS runs in a restricted interpreter, never as JavaScript. The
interpreter supports declarations, `if`, `for … of`, arrow functions, template
literals and the `dv` API (`pages`, `current`, `page`, `table`, `list`,
`taskList`, `paragraph`, `header`, `span`, `el`, `execute`, `func`, …). It
rejects any identifier that names a host or runtime API, such as `process`,
`require`, `fetch`, `eval`, `Function`, `globalThis` or `window`, and reports
it through `onDataviewError`. The same words inside strings are plain text.
`dv.view` and asynchronous queries are not available.
