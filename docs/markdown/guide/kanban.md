---
title: Kanban
description: Publish Kanban plugin boards as static, read-only boards with lanes, cards, WIP limits, dates, tags, linked-note metadata and the list and table views.
---

# Kanban

A note saved by the [Kanban plugin](https://github.com/mgmeyers/obsidian-kanban)
publishes as the board Obsidian shows, not as the markdown behind it. With
`enableKanban`, the board is rendered when the site is built into plain HTML:
it needs no JavaScript, scrolls sideways on its own (and with the arrow keys
once focused), and reads Kanban's own settings.

The board is a picture of the file, not an editor; [Limitations](#limitations)
lists what stays in Obsidian, and the
[compatibility table](/obsidian-compatibility#plugin-ecosystem) sums it up. The
demo vault's [[Plugins/Kanban/Project Board|Project Board]] is a board rendered
this way.

## Enable it

```ts
markdown({
  vaultRoot: "./vault",
  enableKanban: true,
  enableDefaultStyles: true, // or import "rspress-plugin-obsidian/markdown/styles.css"
  kanban: { now: "2024-05-02" }, // pin "today" for a reproducible build
});
```

Kanban needs no extra package, but it does need the bundled stylesheet:
without `enableDefaultStyles` (or the import), a board renders as unstyled
stacked blocks. `enableKanban` and the `kanban` object are listed with every
other option in the [API reference](./api.md#obsidian-plugins); the keys of `kanban` are
documented [below](#options).

## Options

Kanban's settings resolve most specific first, as the plugin resolves them:

1. the board's own settings: its settings block, overridden by setting keys
   written in its frontmatter;
2. the `kanban` options of the site config;
3. the vault's Kanban settings, `.obsidian/plugins/obsidian-kanban/data.json`
   (skipped with `readVaultSettings: false`);
4. Kanban's defaults.

A value of the wrong type is skipped, as if that layer did not set it.
`metadata-keys` is the exception to the order: every layer's keys are shown
together, and when two layers name the same key the global one wins.

Every option below `showArchive` is one of Kanban's own settings, in camelCase.

| Option | Kanban setting | Default | Meaning |
| --- | --- | --- | --- |
| `readVaultSettings` | — | `true` | Read the vault's `data.json` at all. |
| `now` | — | the build's clock | "Today" for relative dates, date colours and the `is-today`/`is-past`/`is-future` classes. A `Date` or a string such as `"2024-05-02"`. |
| `showArchive` | — | `false` | Show the archive as a last lane. |
| `dateTrigger` | `date-trigger` | `@` | Text that opens a card date. |
| `timeTrigger` | `time-trigger` | `@@` | Text that opens a card time. |
| `dateFormat` | `date-format` | the daily-notes format with `enableDailyNotes`, else `YYYY-MM-DD` | Moment format dates are written in. |
| `timeFormat` | `time-format` | `HH:mm` | Moment format times are written and shown in. |
| `dateDisplayFormat` | `date-display-format` | `dateFormat` | Moment format dates are shown in. |
| `showRelativeDate` | `show-relative-date` | `false` | Show "in 3 days" under a dated card. |
| `linkDateToDailyNote` | `link-date-to-daily-note` | `false` | A card's date links to that day's daily note. |
| `moveDates` | `move-dates` | `false` | Take dates and times out of the card text and show them under it. |
| `moveTags` | `move-tags` | `false` | Take tags out of the card text and show them under it. |
| `hideDateInTitle`, `hideTagsInTitle` | Kanban 1.x `hide-date-in-title`, `hide-tags-in-title` | `false` | Read when `move-dates` / `move-tags` is set nowhere. |
| `hideDateDisplay`, `hideTagsDisplay` | Kanban 1.x `hide-date-display`, `hide-tags-display` | `false` | Never show the dates / tags under the card. |
| `moveTaskMetadata` | `move-task-metadata` | `false` | Move Tasks fields (`📅 2024-05-05`, needs `enableTasks`) under the card. |
| `inlineMetadataPosition` | `inline-metadata-position` | `"body"` | Where Dataview fields (needs `enableDataview`) go: `body`, `footer` or `metadata-table`. |
| `metadataKeys` | `metadata-keys` | `[]` | Properties of the linked note shown under the card ([Linked-note metadata](#linked-note-metadata)). |
| `tagColors` | `tag-colors` | `[]` | `{ tagKey, color?, backgroundColor? }[]`; `tagKey` includes its `#`. |
| `dateColors` | `date-colors` | `[]` | `{ isToday? \| isBefore? \| isAfter? \| distance?, unit?, direction?, color?, backgroundColor? }[]`; `unit` is `hours`, `days`, `weeks` or `months`, `direction` is `before` or `after`. |
| `laneWidth` | `lane-width` | `272` | Lane width in pixels (above 0). |
| `fullListLaneWidth` | `full-list-lane-width` | `false` | Lanes span the page in the list view. |
| `maxArchiveSize` | `max-archive-size` | `-1` (all) | How many archived cards `showArchive` shows; the newest are kept. |
| `hideCardCount` | `hide-card-count` | `false` | Hide the card count and WIP limit in lane headers. |
| `showCheckboxes` | `show-checkboxes` | `false` | Show each card's checkbox (disabled). |

## Make a board

A note is a board when its frontmatter has a `kanban-plugin` key. Its value
picks the view: `board` (or the older `basic`), `list` or `table`; any other
value is a board. The file is Kanban's own format; nothing changes on disk:

````markdown
---

kanban-plugin: board

---

## Todo

- [ ] Write the [[Spec]] #design @{2024-05-03}
- [ ] A card with more lines
	Continuation lines and nested lists belong to the card.
	- like this

## Doing (2)

- [ ] Review the plan @{2024-05-02} @@{14:00}

## Done

**Complete**
- [x] Shipped


***

## Archive

- [x] An archived card

%% kanban:settings
```
{"kanban-plugin":"board","show-relative-date":true}
```
%%
````

- **Lanes** are the note's headings, in order. A trailing `(N)` is the lane's
  WIP limit: the header shows `count/N`, flagged with `wip-exceeded` once the
  lane holds more cards than that.
- A `**Complete**` line under a heading marks the lane complete
  (`data-complete="true"`); its cards are not changed.
- **Cards** are the items of the first list after a heading, with everything
  indented under them: continuation lines, nested lists, code. A checked card
  (`- [x]`) carries `is-complete` and is struck through.
- **The archive**, the lane after `***` and `## Archive`, is hidden, as on
  Obsidian's board. `showArchive` adds it as a last lane, capped at
  `max-archive-size`.
- **The settings block** at the end holds the board's own settings, as JSON.

Card text renders through the same pipeline as a note, so links, embeds, tags,
math, callouts and formatting behave as they do anywhere else on the site.

### Dates, times and tags

`@{2024-05-03}` is a card's date and `@@{14:00}` its time; `@[[2024-05-03]]`
is a date that links to its daily note. The triggers and formats come from
the settings.

Dates and times are read the way Kanban reads them, with Moment's forgiving
parser. With a `date-format` of `MM/DD/YYYY`, `@{5/3/2024}`, `@{05-03-2024}`
and `@{5/3/24}` all mean 3 May 2024: one-digit parts and any separator are
fine, a month name needs only its first three letters (`Sept`), and text
around the date is skipped. A year the date leaves out (`@{5/3}`) comes from
`now`. A date that names no real day (`@{2/30/2024}`) stays as written.

A dated card gets `is-today`, `is-past` or `is-future`, its date is shown in
the display format and coloured by `date-colors`, and `show-relative-date`
adds "tomorrow", "in 3 days" or "2 hours ago" under it, all relative to `now`.

`move-dates` shows dates and times under the card instead of in its text (as a
link to the daily note with `link-date-to-daily-note`, when that note exists).
`move-tags` does the same for tags, sorted and coloured by `tag-colors`. Each
card gets a `has-tag-<tag>` class per tag. With `enableTagLinking`, tags link
to their tag page, and tags left in the card text are coloured too.

### Linked-note metadata

`metadata-keys` lists properties of the note a card links to (its last
`[[link]]` or markdown link). They show in a small table under the card:

```ts
kanban: {
  metadataKeys: [
    { metadataKey: "status" },
    { metadataKey: "author", label: "By", containsMarkdown: true },
    { metadataKey: "tags", shouldHideLabel: true },
  ],
},
```

`label` names the row (default: the key), `shouldHideLabel` shows the value
alone, and `containsMarkdown` renders the value as markdown; a value that is a
lone `[[link]]` always links. `tags` lists the note's tags, a dotted key
reaches into nested frontmatter, and dates are shown in the display format and
coloured by `date-colors`. With `enableDataview`, a key the frontmatter lacks
is looked up in the note's inline fields.

With [`enableDataview`](./dataview.md), `[key:: value]` and `(key:: value)` fields written in a
card are read too: `inline-metadata-position` keeps them in the text (`body`),
moves them under the card (`footer`), or merges them into the metadata table
(`metadata-table`). With `enableTasks`, the Tasks fields on a card's first
line (`📅 2024-05-05`, `⏫`, or `[due:: …]`) move under the card with
`move-task-metadata`.

### Views

| `kanban-plugin` | Renders as |
| --- | --- |
| `board` / `basic` | Lanes side by side (`kanban-plugin__horizontal`), `lane-width` px wide. |
| `list` | Lanes stacked (`kanban-plugin__vertical`), full width with `full-list-lane-width`. |
| `table` | One table row per card: Card, List, then Date, Tags and metadata columns when the board shows them. |

A lane collapsed in Obsidian (`list-collapse` in the settings block) renders
with its cards behind an "N cards" disclosure.

### Embeds

With `enableTransclusion`, `![[Board]]` embeds the whole board.
`![[Board#Todo]]` embeds one heading, which is an ordinary
[section transclusion](./transclusion.md) of the lane's markdown, as Obsidian
shows it. Lanes keep their heading ids, so `[[Board#Todo]]` lands on the lane,
and a card's `^block-id` stays a link target. Inside an embed these ids are
namespaced the way an embedded note's are (`embed-1-todo`), so a board
embedded twice repeats no id.

## Output and styling

The markup uses Kanban's own class names (`kanban-plugin`,
`kanban-plugin__board`, `kanban-plugin__lane`,
`kanban-plugin__lane-header-wrapper`, `kanban-plugin__lane-title`,
`kanban-plugin__lane-title-count`, `kanban-plugin__lane-items`,
`kanban-plugin__item`, `kanban-plugin__item-title`,
`kanban-plugin__item-metadata`, `kanban-plugin__item-tags`,
`kanban-plugin__item-tag`, `kanban-plugin__date`,
`kanban-plugin__meta-table`, …), so CSS snippets written for the plugin keep
working. A board's `cssclasses` are added to its root, as Kanban adds them.

The bundled stylesheet lays the board out and colours it from the site theme,
in light and dark mode. It ships with `enableDefaultStyles`; lane widths and
tag colours are written into the board itself and need nothing else.

## Errors

A settings block that has no code fence, or whose content is not a JSON
object, shows an error above the board (`kanban-plugin__error`). The block is
ignored; setting keys in the frontmatter still apply. A `kanban.now` that is
not a date falls back to the build's clock. Both are reported through
[`onPluginError`](./api.md#diagnostics), whose default, `"error"`, fails the build.

A vault `data.json` that is not valid JSON is ignored with a console warning.
A card date that cannot be read stays as written, without a report.

## Limitations

- Dragging cards and lanes, adding, editing, archiving, searching and the
  board's menus need Obsidian. Nothing is reported: the board shows the file's
  state.
- Checkboxes are shown (with `show-checkboxes`) but disabled. The table view
  is not sortable.
- `new-card-insertion-method`, `new-line-trigger`, `new-note-folder`,
  `new-note-template`, the archive-date settings, `date-picker-week-start`,
  `tag-action`, `tag-sort`, `table-sizing` and the `show-*` header-button
  settings only affect editing in Obsidian, so they change nothing here.
  `date-time-display-format` is not read either: a date with a time shows in
  `date-display-format` followed by `time-format`.
- Daily-note file names are matched strictly, as Obsidian matches them: a note
  named `2024-5-3` is no daily note for `YYYY-MM-DD`. Only card dates and
  times are read forgivingly.
