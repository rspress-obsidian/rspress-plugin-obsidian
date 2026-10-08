---
description: Kanban plugin boards rendered as static, read-only boards — lanes, cards, WIP limits, dates, tags, linked-note metadata, and the list and table views.
---

# Kanban

A note saved by the [Kanban plugin](https://github.com/mgmeyers/obsidian-kanban) publishes as the board Obsidian shows, not as the markdown behind it. The board is rendered at build time into plain HTML: it needs no JavaScript, scrolls sideways on its own (and with the arrow keys once focused), and is read-only.

```ts
markdown({
  enableKanban: true,
  enableDefaultStyles: true, // the board's layout lives in the bundled stylesheet
});
```

Without `enableDefaultStyles`, import the stylesheet yourself — `import "rspress-plugin-obsidian/markdown/styles.css"` — or the board renders as unstyled stacked blocks.

## What makes a board

A note is a board when its frontmatter has a `kanban-plugin` key — `board` (or the older `basic`), `list` or `table`, which also picks the view. The file is Kanban's own format; nothing changes on disk:

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

- **Lanes** are the note's headings, in order. A trailing `(N)` is the lane's WIP limit: the header shows `count/N`, and the counter is flagged (`wip-exceeded`) once the lane holds more cards than that.
- A `**Complete**` line under a heading marks the lane complete (`data-complete="true"`).
- **Cards** are the items of the first list after a heading, with everything indented under them: continuation lines, nested lists, code. A checked card (`- [x]`) carries `is-complete` and is struck through.
- **The archive** — the lane after `***` + `## Archive` — is hidden, as in Obsidian's board. `kanban.showArchive` adds it as a last lane, capped at `max-archive-size` (the newest cards kept).
- **The settings block** at the end holds the board's own settings.

Card text renders through the same pipeline as a note, so links, embeds, tags, math, callouts and formatting behave exactly as they do elsewhere on the site.

## Dates, times and tags

`@{2024-05-03}` is a card's date and `@@{14:00}` its time; `@[[2024-05-03]]` is a date that links to its daily note. The trigger characters and the formats come from the settings (`date-trigger`, `time-trigger`, `date-format`, `time-format`, `date-display-format`).

Dates and times are read the way Kanban reads them, with Moment's forgiving parser rather than its strict one. With a `date-format` of `MM/DD/YYYY`, the dates `@{5/3/2024}`, `@{05-03-2024}` and `@{5/3/24}` all mean 3 May 2024. A one-digit month, day, hour or minute is fine, and so is any separator. A month name only needs its first three letters (`Sept`), and text around the date is skipped. A year the date leaves out (`@{5/3}`) comes from "now" (see below). A date that names no real day (`@{2/30/2024}`) or holds no date at all stays as written.

Dates are shown in the display format and coloured by `date-colors`. A dated card gets `is-today`, `is-past` or `is-future`, and `show-relative-date` adds "tomorrow", "in 3 days" or "2 hours ago" under it. All of these are relative to "now", which `kanban.now` pins so a build is reproducible:

```ts
markdown({ enableKanban: true, kanban: { now: "2024-05-02" } });
```

`move-dates` takes dates and times out of the card text and shows them under the card (as a link to the daily note with `link-date-to-daily-note`, when that note exists). `move-tags` does the same for tags, coloured by `tag-colors`; with `enableTagLinking` they link to the tag's page, and the tags still in a card's text are coloured too. A card also gets a `has-tag-<tag>` class for each tag.

## Linked-note metadata

`metadata-keys` lists frontmatter properties of the note a card links to (its last link). They show in a small table under the card, read from that note's frontmatter. `tags` lists the note's tags; dates are shown in the display format; `containsMarkdown` renders a value as markdown, and a value that is a lone `[[link]]` always links. With `enableDataview`, a key the frontmatter lacks is looked up in the note's inline fields.

With `enableDataview`, `[key:: value]` fields in a card are read too, and with `enableTasks` the Tasks emoji fields on its first line (`📅 2024-05-05`, `⏫`). `inline-metadata-position` keeps Dataview fields in the text (`body`, the default), moves them under the card (`footer`), or merges them into the metadata table (`metadata-table`); `move-task-metadata` moves the Tasks fields under the card.

## Views

| `kanban-plugin` | Renders as |
| --- | --- |
| `board` / `basic` | Lanes side by side (`kanban-plugin__horizontal`), `lane-width` px wide (default 272). |
| `list` | Lanes stacked (`kanban-plugin__vertical`), full width with `full-list-lane-width`. |
| `table` | One table row per card: Card, List, then Date, Tags and metadata columns when the board shows them. |

A lane collapsed in Obsidian (`list-collapse` in the settings block) renders with its cards behind a "N cards" disclosure.

## Embeds

`![[Board]]` embeds the whole board. `![[Board#Todo]]` embeds one heading, which is an ordinary [[transclusion|section transclusion]] — the lane's markdown — exactly as Obsidian shows it. Lanes keep their heading ids, so a `[[Board#Todo]]` link lands on the lane, and a card's `^block-id` stays a link target. Inside an embed these ids are namespaced the way an embedded note's heading ids are (`embed-1-todo`), so a board embedded twice repeats no id.

## Settings

Kanban's settings resolve most specific first, as the plugin resolves them:

1. the board's own settings — its settings block, overridden by setting keys written in its frontmatter;
2. the `kanban` options of the site config;
3. the vault's Kanban settings, `.obsidian/plugins/obsidian-kanban/data.json` (skip with `kanban.readVaultSettings: false`);
4. Kanban's defaults. The default `date-format` is the daily-notes format when `enableDailyNotes` is on, else `YYYY-MM-DD`.

`metadata-keys` is the exception: a board's keys are added to the global ones.

| Option | Kanban setting | Default |
| --- | --- | --- |
| `readVaultSettings` | — | `true` |
| `now` | — | the build's clock |
| `showArchive` | — | `false` |
| `dateTrigger` | `date-trigger` | `@` |
| `timeTrigger` | `time-trigger` | `@@` |
| `dateFormat` | `date-format` | `YYYY-MM-DD` |
| `timeFormat` | `time-format` | `HH:mm` |
| `dateDisplayFormat` | `date-display-format` | `dateFormat` |
| `showRelativeDate` | `show-relative-date` | `false` |
| `linkDateToDailyNote` | `link-date-to-daily-note` | `false` |
| `moveDates` | `move-dates` | `false` |
| `moveTags` | `move-tags` | `false` |
| `hideDateInTitle`, `hideTagsInTitle` | Kanban 1.x `hide-date-in-title`, `hide-tags-in-title` (read when `move-*` is unset) | `false` |
| `hideDateDisplay`, `hideTagsDisplay` | Kanban 1.x `hide-date-display`, `hide-tags-display` | `false` |
| `moveTaskMetadata` | `move-task-metadata` | `false` |
| `inlineMetadataPosition` | `inline-metadata-position` | `"body"` |
| `metadataKeys` | `metadata-keys` | `[]` |
| `tagColors` | `tag-colors` | `[]` |
| `dateColors` | `date-colors` | `[]` |
| `laneWidth` | `lane-width` | `272` |
| `fullListLaneWidth` | `full-list-lane-width` | `false` |
| `maxArchiveSize` | `max-archive-size` | `-1` (all) |
| `hideCardCount` | `hide-card-count` | `false` |
| `showCheckboxes` | `show-checkboxes` | `false` |

A settings block that is not valid JSON shows an error above the board, which then renders with the global settings; the build reports it (and fails while `onPluginError` is `"error"`).

## Styling

The markup uses Kanban's own class names — `kanban-plugin`, `kanban-plugin__board`, `kanban-plugin__lane`, `kanban-plugin__lane-header-wrapper`, `kanban-plugin__lane-title`, `kanban-plugin__lane-title-count`, `kanban-plugin__lane-items`, `kanban-plugin__item`, `kanban-plugin__item-title`, `kanban-plugin__item-metadata`, `kanban-plugin__item-tags`, `kanban-plugin__item-tag`, `kanban-plugin__date`, `kanban-plugin__meta-table`, … — so CSS snippets written for the plugin keep working. The bundled stylesheet colours them from the site theme, in light and dark mode. A board's `cssclasses` are added to its root, as Kanban adds them.

## Limits

The published board is a picture of the file, not an editor:

- Dragging cards and lanes, adding, editing, archiving, searching, and the board's menus need Obsidian. Nothing is reported: the board shows the file's state, which is all a reader needs.
- Checkboxes are shown (with `show-checkboxes`) but disabled.
- `new-card-insertion-method`, `new-line-trigger`, `new-note-folder`, `new-note-template`, the archive-date settings, `tag-action`, `tag-sort`, `table-sizing` and the `show-*` header-button settings only affect editing in Obsidian, so they change nothing here. The table view is not sortable.
- Daily-note file names are still matched strictly, as Obsidian matches them: a note named `2024-5-3` is no daily note for `YYYY-MM-DD`. Only card dates and times are read forgivingly.
