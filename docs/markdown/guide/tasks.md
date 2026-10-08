---
description: Tasks plugin queries and task metadata, rendered when the site is built.
---

# Tasks

The [Tasks](https://publish.obsidian.md/tasks/) plugin turns list items into
tasks with due dates, priorities, recurrence and dependencies, and collects
them anywhere in the vault with ` ```tasks ` query blocks. With `enableTasks`,
the site runs every query when it is built: a block lists the tasks it finds
in every published note, on a vault page or a docs page alike, with the
markup, classes and `data-*` attributes Tasks uses in Obsidian's reading view,
so a CSS snippet written for Obsidian styles the page too.

```ts
markdown({
  vaultRoot: "./vault",
  enableTasks: true,
  tasks: { now: "2026-10-08" },
});
```

## Writing tasks

Tasks reads the fields at the end of a task line, in either of its formats.

```markdown
- [ ] Write the release notes 📅 2026-10-12 ⏫ #docs
- [ ] Record the demo ⏳ 2026-10-09 🛫 2026-10-08 ➕ 2026-10-01
- [ ] Watch the dashboards 📅 2026-10-15 🔁 every day 🏁 delete
- [x] Freeze the feature list ✅ 2026-10-02
- [-] Print posters ❌ 2026-10-01
- [ ] Choose a host 🆔 host
- [ ] Set up DNS ⛔ host

- [ ] Review the translation [due:: 2026-10-14] [priority:: high]
- [ ] Update screenshots (scheduled:: 2026-10-09) [repeat:: every week]
```

| Field | Emoji | Dataview |
|---|---|---|
| Due | `📅` (`📆`, `🗓`) | `[due:: …]` |
| Scheduled | `⏳` (`⌛`) | `[scheduled:: …]` |
| Start | `🛫` | `[start:: …]` |
| Created | `➕` | `[created:: …]` |
| Done | `✅` | `[completion:: …]` |
| Cancelled | `❌` | `[cancelled:: …]` |
| Recurrence | `🔁 every …` | `[repeat:: every …]` |
| On completion | `🏁 delete` | `[onCompletion:: delete]` |
| Priority | `🔺` `⏫` `🔼` `🔽` `⏬` | `[priority:: highest\|high\|medium\|low\|lowest]` |
| Id / depends on | `🆔 id` / `⛔ id1,id2` | `[id:: …]` / `[dependsOn:: …]` |

A recurrence rule is read the way Tasks reads it, with rrule: it is shown,
grouped and filtered as Tasks restates it (`🔁 every Monday` becomes
`every week on Monday`; a trailing ` when done` is kept), and a rule rrule
cannot read (`every banana`) is dropped, so that task is not recurring.

Any list marker works (`-`, `*`, `+`, `1.`, `1)`), in blockquotes too. Tasks in
code blocks, `%%comments%%` and frontmatter are not tasks. A trailing
`^block-id` stays a block link.

### A note's own tasks

A task in a note keeps rendering as a checkbox item, and gains what Tasks adds
in reading view: the `plugin-tasks-list-item` class, `data-task-status-name`,
`data-task-status-type`, `data-task-priority` and the date attributes
(`data-task-due="past-2d"`, `today`, `future-far`, …). With a global filter
and **Remove global filter from description** on, the filter text is hidden.

## Query blocks

````markdown
```tasks
not done
due before in two weeks
(tag includes #docs) OR (path includes Projects)
group by filename
sort by priority
limit 10
```
````

Each result shows its checkbox (disabled: a page cannot edit the note), the
description rendered as markdown of its own note (links and tags resolve as
they do there), its fields, and a backlink to the note and heading it came
from. Group headings and the task count follow, as in Obsidian.

### Filters

| Family | Instructions |
|---|---|
| Status | `done`, `not done`, `status.type is (not) TODO\|DONE\|IN_PROGRESS\|ON_HOLD\|CANCELLED\|NON_TASK`, `status.name includes …` |
| Dates | `due`, `scheduled`, `starts`, `created`, `done`, `cancelled`, `happens` followed by `before`, `after`, `on`, `on or before`, `on or after`, `in`, `in or before`, `in or after` and a date; `has/no <field> date`; `<field> date is invalid` |
| Text | `description`, `path`, `folder`, `root`, `filename`, `heading`, `tag`/`tags`, `status.name`, `recurrence`, `id` with `includes`, `does not include`, `regex matches`, `regex does not match` |
| Other | `priority is (above\|below\|not) <level>`, `is recurring`, `is not recurring`, `exclude sub-items`, `has id`, `no id`, `has depends on`, `no depends on`, `is blocked`, `is not blocked`, `is blocking`, `is not blocking`, `has tags`, `no tags` |
| Boolean | `(…) AND (…)`, `OR`, `NOT`, `AND NOT`, `OR NOT`, `XOR`, with `()`, `[]`, `{}` or `""` around each filter; `NOT` binds first, then `XOR`, `AND`, `OR` |

Dates accept an ISO date, natural language (`tomorrow`, `in two weeks`, `last
friday`), two dates as a range (`in 2026-10-01 2026-10-31`), `last/this/next
week/month/quarter/year`, and `2026`, `2026-Q4`, `2026-10`, `2026-W41`. They
are resolved against the [`now` option](#options).

### Sorting, grouping and limits

- `sort by` `status`, `status.name`, `status.type`, `priority`, `urgency`,
  `due`, `scheduled`, `start`, `created`, `done`, `cancelled`, `happens`,
  `description`, `path`, `filename`, `heading`, `tag` (or `tag 2` for the
  second tag), `recurring`, `id`, `random`, each with `reverse`. After the
  block's own sort lines come Tasks' defaults: status type, urgency, due,
  priority, path. Urgency is Tasks' own score.
- `group by` `status`, `status.name`, `status.type`, `priority`, `urgency`, the
  date fields, `path`, `folder`, `root`, `filename`, `backlink`, `heading`,
  `tags`, `recurring`, `recurrence`, `id`, each with `reverse`. Nested groups
  print `h4`, `h5` and `h6` headings (`tasks-group-heading`).
- `limit N` and `limit groups N`; the count then reads `3 of 12 tasks`.

### Layout

`hide`/`show` `edit button`, `backlink(s)`, `nested backlinks`, `urgency`,
`task count`, `group count`, `tree`, `tags`, `priority`, `id`, `depends on`,
`recurrence rule`, `on completion`, and the `start`, `scheduled`, `due`,
`created`, `done` and `cancelled date`. `short mode` shows each field as its
emoji, with the value in a tooltip, and the backlink as 🔗; `full mode` undoes
it. `show tree` nests a task's sub-items, tasks or not, under it. A hidden
field adds Tasks' `tasks-layout-hide-…` class to the list.

`view columns by <field>` (any `group by` field, with `reverse`) lays the
results out as columns, one per group, with each task as a card
(`tasks-columns`, `tasks-columns-column`, `tasks-columns-column-card`);
`view list` is the default list.

### Explain, comments, placeholders, presets

- `explain` prints Tasks' explanation above the results: every date spelled out,
  Boolean logic as a tree, the global filter, the global query and the note's
  query file defaults.
- A line starting with `#` is a comment; a line ending in `\` continues on the
  next.
- `{{query.file.path}}`, `{{query.file.pathWithoutExtension}}`,
  `{{query.file.folder}}`, `{{query.file.root}}`, `{{query.file.filename}}`,
  `{{query.file.filenameWithoutExtension}}`, `{{query.file.property('key')}}`
  and `{{query.file.hasProperty('key')}}` expand for the note holding the query;
  a Mustache comment, `{{! … }}`, is dropped.
- `preset <name>` inserts a preset: Tasks' built-in ones (`this_file`,
  `this_folder`, `this_root`, `hide_date_fields`, …), the vault's, and the
  [`presets` option](#options).
- `ignore global query` skips the global query.
- `TQ_*` properties in the note's frontmatter (`TQ_short_mode`, `TQ_show_tree`,
  `TQ_explain`, `TQ_extra_instructions`, …) add their instructions before the
  block's, as Tasks' query file defaults do.

## Settings

The vault's Tasks settings (`.obsidian/plugins/obsidian-tasks-plugin/data.json`)
are read: the global filter, **Remove global filter from description**, the
global query, presets, custom statuses, the task count position and **Use
filename as Scheduled date**. An option set in the site config wins.

### Filename as scheduled date

With **Use filename as Scheduled date** on, a task that has no start, scheduled
or due date, in a note whose file name holds a date (`2026-10-08.md`,
`Journal 20261008.md`, or the extra format you set), is scheduled on that date.
As in Tasks, the date is inferred: filters, sorting, grouping and urgency see
it, but no ⏳ is shown on the task and no `data-task-scheduled` attribute is
set. A folder list limits it to notes in those folders.

### Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `tasks.now` | `Date \| string` | the build's date | "Today" for relative dates, urgency and the `data-task-due` distances. Pin it for a reproducible build. |
| `tasks.globalFilter` | `string` | the vault's, else none | Only list items containing this text are tasks (for example `#task`). |
| `tasks.removeGlobalFilter` | `boolean` | the vault's, else `false` | Hide the global filter from task descriptions. |
| `tasks.globalQuery` | `string` | the vault's, else none | Instructions prepended to every block. |
| `tasks.statuses` | `{ symbol, name, nextStatusSymbol?, type? }[]` | — | Statuses added to the vault's (or Tasks' default `[ ]`, `[x]`, `[/]`, `[-]`); `type` is `TODO`, `DONE`, `IN_PROGRESS`, `ON_HOLD`, `CANCELLED` or `NON_TASK`. An unknown status symbol is a `TODO` named "Unknown". |
| `tasks.presets` | `Record<string, string>` | — | Presets added to Tasks' built-in ones and the vault's. |
| `tasks.useFilenameAsScheduledDate` | `boolean` | the vault's, else `false` | Schedule undated tasks on their note's file-name date. |
| `tasks.filenameAsScheduledDateFormat` | `string` | the vault's, else none | A Moment format for those file names, tried (strictly) before `YYYY-MM-DD` and `YYYYMMDD`. |
| `tasks.filenameAsDateFolders` | `string[]` | the vault's, else every folder | Vault folders it applies in (no trailing `/`). |
| `tasks.readVaultSettings` | `boolean` | `true` | Read the vault's `data.json` at all. |

## What a static site cannot do

| In Obsidian | On the site |
|---|---|
| Clicking a checkbox, the edit button, the postpone button, date pickers | Checkboxes render disabled; the edit and postpone buttons and the toolbar's search box are not drawn (`hide`/`show` for them is accepted). |
| `filter by function`, `sort by function`, `group by function`, and placeholders that run JavaScript | Never run. The block shows Tasks' error in place and the build reports it (it fails with `onPluginError: "error"`). |
| Results that update as you edit | Results are computed when the page is built (`rspress dev` rebuilds a page when a note changes). |
| Dragging a card between columns, and the hover tooltip in short mode | Columns render without drag and drop; short mode puts each value in a `title` tooltip. |

Any other query problem — an unknown instruction, an unreadable date, a broken
Boolean combination — renders Tasks' own error message in a
`plugin-tasks-query-error` block and is reported the same way.
