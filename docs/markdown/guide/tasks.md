---
title: Tasks
description: Run Tasks plugin queries when the site is built, and give each note's own tasks the classes and attributes Tasks adds in reading view.
---

# Tasks

The [Tasks](https://publish.obsidian.md/tasks/) plugin turns list items into
tasks with dates, priorities, recurrence and dependencies, and collects them
with ` ```tasks ` query blocks. With `enableTasks`, the site runs every query
when it is built, over every task in every published note (docs and vault),
and renders the result with the markup Tasks uses in reading view, so a CSS
snippet written for Obsidian styles the page too.

A published page shows what the query found at build time; nobody can tick a
task on it. [Limitations](#limitations) lists what stays in Obsidian, and the
[compatibility table](/obsidian-compatibility#plugin-ecosystem) sums it up. The
demo vault's [[Plugins/Tasks/Query Gallery|Query Gallery]] shows query blocks
rendered.

## Enable it

```ts
markdown({
  vaultRoot: "./vault",
  enableTasks: true,
  enableDefaultStyles: true, // or import "rspress-plugin-obsidian/markdown/styles.css"
  tasks: { now: "2026-10-08" }, // pin "today" for a reproducible build
});
```

Tasks needs no extra package. `enableTasks` and the `tasks` object are listed
with every other option in the [API reference](./api.md#obsidian-plugins); the keys of `tasks`
are documented [below](#options).

## Options

The vault's Tasks settings, `.obsidian/plugins/obsidian-tasks-plugin/data.json`,
are read first, so the site matches Obsidian without restating them: the
global filter, **Remove global filter from description**, the global query,
presets, task statuses, **Use filename as Scheduled date** (with its format and
folders) and the task count position. A key set in `tasks` wins over the
vault's setting.

| Option | Type | Default | Meaning |
|---|---|---|---|
| `now` | `Date \| string` | the build's date | "Today" for relative dates, urgency and the `data-task-due` distances. Pin it for a reproducible build; a value that is not a date is reported and today is used. |
| `globalFilter` | `string` | the vault's, else none | Only list items containing this text are tasks (for example `#task`). |
| `removeGlobalFilter` | `boolean` | the vault's, else `false` | Hide the global filter from task descriptions. |
| `globalQuery` | `string` | the vault's, else none | Instructions put before every block's own; a block opts out with `ignore global query`. |
| `statuses` | `{ symbol, name, nextStatusSymbol?, type? }[]` | none | Statuses added to the vault's (or, without vault statuses, to Tasks' defaults `[ ]`, `[x]`, `[/]`, `[-]`); one with an existing symbol replaces it. `type` is `TODO` (default), `DONE`, `IN_PROGRESS`, `ON_HOLD`, `CANCELLED` or `NON_TASK`. |
| `presets` | `Record<string, string>` | none | Presets added to Tasks' built-in ones and the vault's; a name already defined is replaced. |
| `useFilenameAsScheduledDate` | `boolean` | the vault's, else `false` | Schedule undated tasks on their note's file-name date ([Dates from the file name](#dates-from-the-file-name)). |
| `filenameAsScheduledDateFormat` | `string` | the vault's, else none | A Moment format for those file names, tried (strictly) before `YYYY-MM-DD` and `YYYYMMDD`. |
| `filenameAsDateFolders` | `string[]` | the vault's, else every folder | Vault folders the file-name date applies in (no trailing `/`). |
| `readVaultSettings` | `boolean` | `true` | Read the vault's `data.json` at all. |

The task count position (above or below the results) has no option: it is
the vault's setting, else below.

## Write tasks

Tasks reads the fields at the end of a task line, in its emoji format or its
Dataview format:

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

- Any list marker works (`-`, `*`, `+`, `1.`, `1)`), in blockquotes too. Tasks
  in code blocks, `%%comments%%` and frontmatter are not tasks. A trailing
  `^block-id` stays a block link.
- A recurrence rule is read with rrule, as Tasks reads it, and shown, grouped
  and filtered as Tasks restates it: `🔁 every Monday` becomes
  `every week on Monday`, and a trailing ` when done` is kept. A rule rrule
  cannot read (`every banana`) is dropped, so that task does not recur.
- With a global filter, only list items containing it are tasks. A tag equal
  to the global filter does not count as one of the task's tags, and
  `description` filters and sorting ignore it.

### Dates from the file name

With **Use filename as Scheduled date** on (or `useFilenameAsScheduledDate`), a
task with no start, scheduled or due date, in a note whose file name holds a
date (`2026-10-08.md`, `Journal 20261008.md`, or the format you set), is
scheduled on that date. As in Tasks, the date is inferred: filters, sorting,
grouping and urgency see it, but no ⏳ is shown on the task and no
`data-task-scheduled` attribute is set. A folder list limits it to notes in
those folders.

## Query tasks

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

Each result shows its checkbox (disabled), its description rendered as
markdown of its own note (links and tags resolve as they do there), its fields,
and a backlink to the note and heading it came from. The backlink names the
file, or its path when another published note has the same name. Group
headings and the task count follow, as in Obsidian.

A block runs, in order: the global query, the note's
[query file defaults](#query-file-defaults), then its own lines.

### Filters

| Family | Instructions |
|---|---|
| Status | `done`, `not done`, `status.type is (not) TODO\|DONE\|IN_PROGRESS\|ON_HOLD\|CANCELLED\|NON_TASK`, `status.name includes …` |
| Dates | `due`, `scheduled`, `starts`, `created`, `done`, `cancelled`, `happens`, followed by `before`, `after`, `on`, `on or before`, `on or after`, `in`, `in or before`, `in or after` and a date; `has/no <field> date`; `<field> date is invalid` (not for `happens`) |
| Text | `description`, `path`, `folder`, `root`, `filename`, `heading`, `tag`/`tags`, `status.name`, `recurrence`, `id`, with `includes`, `does not include`, `regex matches`, `regex does not match` |
| Other | `priority is (above\|below\|not) <level>` (levels `highest` … `lowest`, and `none`), `is recurring`, `is not recurring`, `exclude sub-items`, `has id`, `no id`, `has depends on`, `no depends on`, `is blocked`, `is not blocked`, `is blocking`, `is not blocking`, `has tags`, `no tags` |
| Boolean | `(…) AND (…)`, `OR`, `NOT`, `AND NOT`, `OR NOT`, `XOR`, with `()`, `[]`, `{}` or `""` around each filter; `NOT` binds first, then `XOR`, `AND`, `OR` |

The start date is `starts` in a filter (`starts before tomorrow`) and `start`
everywhere else (`has start date`, `sort by start`). As in Tasks, a task with
no start date passes every `starts` filter.

Dates accept an ISO date, natural language (`tomorrow`, `in two weeks`, `last
friday`), two dates as a range (`in 2026-10-01 2026-10-31`), `last`, `this` or
`next` `week`, `month`, `quarter` or `year` (lowercase; weeks run Monday to
Sunday), and `2026`, `2026-Q4`, `2026-10`, `2026-W41`. They are resolved
against the [`now` option](#options).

### Sort, group and limit

- `sort by` `status`, `status.name`, `status.type`, `priority`, `urgency`,
  `due`, `scheduled`, `start`, `created`, `done`, `cancelled`, `happens`,
  `description`, `path`, `filename`, `heading`, `tag`, `recurring`, `id`,
  `random`, each with `reverse`. `sort by tag 2` sorts by the second tag
  (`sort by tag reverse 2` reverses it). After the block's own sort lines come
  Tasks' defaults: status type, urgency, due, priority, path.
- `group by` `status`, `status.name`, `status.type`, `priority`, `urgency`
  (most urgent first), the date fields, `path`, `folder`, `root`, `filename`,
  `backlink`, `heading`, `tags`, `recurring`, `recurrence`, `id`, each with
  `reverse`. Nested groups print `h4`, `h5` and `h6` headings.
- `limit N` (or `limit to N tasks`) and `limit groups N`; the count then reads
  `3 of 12 tasks`.

### Layout

`hide` or `show` `backlink(s)`, `nested backlinks`, `urgency`, `task count`,
`group count`, `tree`, `tags`, `priority`, `id`, `depends on`,
`recurrence rule`, `on completion`, and the `start`, `scheduled`, `due`,
`created`, `done` and `cancelled date`. Urgency, the group count and the tree
are hidden until you `show` them. `show tree` nests a task's sub-items, tasks
or not, under it.

`short mode` shows each field as its emoji, with the value in a tooltip, and
the backlink as 🔗; `full mode` undoes it.

`view columns by <field>` (any `group by` field, with `reverse`) lays the
results out as columns, one per group, with each task as a card; `view list`
is the default.

### Explain, comments, placeholders and presets

- `explain` prints Tasks' explanation above the results: every date spelled
  out, Boolean logic as a tree, the global filter, the global query and the
  note's query file defaults.
- A line starting with `#` is a comment; a line ending in `\` continues on the
  next.
- `{{query.file.path}}`, `{{query.file.pathWithoutExtension}}`,
  `{{query.file.folder}}`, `{{query.file.root}}`, `{{query.file.filename}}`,
  `{{query.file.filenameWithoutExtension}}`, `{{query.file.property('key')}}`
  and `{{query.file.hasProperty('key')}}` expand for the note holding the
  query; a Mustache comment, `{{! … }}`, is dropped.
- `preset <name>` inserts a preset: one of Tasks' built-in ones
  (`this_file`, `this_folder`, `this_root`, `hide_date_fields`,
  `hide_non_date_fields`, `hide_query_elements`, `hide_everything`), the
  vault's, or one from the [`presets` option](#options). Presets nest up to
  ten levels deep. The built-in `this_folder_only` is a `filter by function`,
  so it fails like one (see [Limitations](#limitations)).
- `ignore global query` skips the global query.

### Query file defaults

Frontmatter properties starting with `TQ_` add instructions before every
block in the note, as Tasks' query file defaults do. Keys match
case-insensitively.

```yaml
---
TQ_short_mode: true
TQ_show_tree: true
TQ_extra_instructions: |
  not done
  sort by due
---
```

`TQ_explain`, `TQ_short_mode` (`false` means `full mode`) and
`TQ_extra_instructions` (text) are read, and so is each `TQ_show_<field>`
for `toolbar`, `tree`, `tags`, `id`, `depends_on`, `priority`,
`recurrence_rule`, `on_completion`, `created_date`, `start_date`,
`scheduled_date`, `due_date`, `cancelled_date`, `done_date`, `urgency`,
`backlink`, `edit_button`, `postpone_button` and `task_count`, where
`false` means `hide`.

## Output and styling

A task in a note keeps rendering as a checkbox item and gains what Tasks adds
in reading view: the `plugin-tasks-list-item` class, `data-task-status-name`,
`data-task-status-type`, `data-task-priority` and the date attributes
(`data-task-due="today"`, `past-1d` … `past-7d`, `past-far`, `future-1d` …
`future-far`). A date that cannot be read shows as "Invalid date" and gets no
attribute. With **Remove global filter from description** on, the filter text
is hidden where it stands as a whole word.

Query results use Tasks' classes too: `tasks-group-heading` for group
headings, `tasks-columns`, `tasks-columns-column` and
`tasks-columns-column-card` for the columns view, and a
`tasks-layout-hide-…` class on the list for every hidden field.

The bundled stylesheet styles the columns, counts, urgency, explanation,
errors, short mode and cancelled tasks. It ships only with
`enableDefaultStyles` (or when you import
`rspress-plugin-obsidian/markdown/styles.css`). `hide tags` depends on it: the
tags stay in the description and the stylesheet hides those that link to a tag
page.

## Errors

A query that cannot run — an unknown instruction, an unreadable date, a broken
Boolean combination, an unknown preset, a JavaScript instruction — shows
Tasks' own error message in a `plugin-tasks-query-error` block in place of the
results. The build reports it through [`onPluginError`](./api.md#diagnostics), whose default,
`"error"`, fails the build; set it to `"warn"` to publish anyway.

Settings that cannot be used — a malformed status in the vault or in
`tasks.statuses`, a `tasks.now` that is not a date — are skipped and reported
as warnings.

## Limitations

| In Obsidian | On the site |
|---|---|
| Clicking a checkbox, the edit button, the postpone button, date pickers | Checkboxes render disabled; the edit and postpone buttons and the toolbar's search box are not drawn (`hide`/`show` for them is accepted). |
| `filter by function`, `sort by function`, `group by function`, and placeholders that run JavaScript | Never run. The block shows Tasks' error in place and the build reports it. |
| Results that update as you edit | Results are computed when the page is built (`rspress dev` rebuilds a page when a note changes). |
| Dragging a card between columns, and the hover tooltip in short mode | Columns render without drag and drop; short mode puts each value in a `title` tooltip. |
