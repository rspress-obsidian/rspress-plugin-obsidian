---
title: Tags & Daily Notes
description: Turn #tags into links, generate a page per tag, and publish date-named daily notes with navigation, templates and a calendar page.
---

# Tags & Daily Notes

This guide covers two ways to organize a vault. Tags become links and
generated tag pages. Daily notes get previous/next navigation, a template for
empty notes, and a calendar page. Each feature is off until you turn it on.

## Tags

```ts
markdown({
  enableTagLinking: true, // #tag → link to /tags/tag
  enableTagPages: true,   // generate a /tags/<tag> page for each tag
});
```

### Inline tags

With [`enableTagLinking`](./api.md#features), each inline `#tag` becomes a link
to its tag page:

```markdown
This page covers #javascript and #project/ideas.
```

The two tags render as links to `/tags/javascript` and `/tags/project/ideas`.
Nested tags (`#parent/child`) and Unicode letters (`#日本語`) work. A name made
only of digits, `/` and `-` is not a tag, so `#123` and `#2024/12` stay text,
while `#1a` and `#2024-report` become links. A `#` inside code, in a
`[[#Heading]]` link, in a link destination such as `(#install)` or in a URL is
not a tag either.

### Frontmatter tags

```yaml
---
tags:
  - tutorial
  - obsidian
---
```

A YAML list, a comma-separated string (`tags: a, b`) and the singular `tag`
all work.

### Tag pages

With [`enableTagPages`](./api.md#features), the plugin generates a page at
`/tags/<tag>` for every tag. Each page lists the notes that carry the tag. Tags
are collected from frontmatter and from inline `#tags`, across `docs/` and the
vault together:

- Tags ignore case, as in Obsidian. `#Project` and `#project` share
  `/tags/project`, and the page title uses the spelling most notes use.
- A nested tag gets a page for each level: `#parent/child` generates
  `/tags/parent/child` and `/tags/parent`.

Turn on both options. Without `enableTagLinking`, inline tags stay plain text.
Without `enableTagPages`, tag links point to routes that do not exist. Tag
pages need `enableDefaultStyles` (or the stylesheet loaded by hand) to be
styled.

## Daily notes

```ts
markdown({
  enableDailyNotes: true,
  dailyNotes: {
    folder: "daily",            // where daily notes live
    dateFormat: "YYYY-MM-DD",   // how they are named
    navigation: true,           // previous/next links (default)
    template: "templates/Daily", // fills a daily note that is still empty
    calendar: "/daily",         // generates a calendar page at this route
  },
});
```

Every key is optional. The defaults are listed under
[`dailyNotes`](./api.md#dailynotes).

### Which notes are daily notes

A note is a daily note when it sits in `folder` and its file name matches
`dateFormat` exactly and names a real date, so `2024-02-30` does not count:

```text
daily/
  2024-01-01.md
  2024-01-02.md
  2024-01-03.md
```

Dates are local calendar dates, so a note named `2024-01-01` is January 1 in any
build time zone. `dateFormat` uses the Moment.js tokens that Obsidian's daily
notes use:

| Token | Output |
|-------|--------|
| `YYYY` / `YY` | 2024 / 24 |
| `MMMM` / `MMM` / `MM` / `M` | January / Jan / 01 / 1 |
| `DD` / `D` / `Do` | 05 / 5 / 5th |
| `dddd` / `ddd` / `dd` | Friday / Fri / Fr |
| `ww` / `w`, `gggg` | Locale week (weeks start on Sunday) and its year |
| `WW` / `W`, `GGGG`, `E` | ISO week, its year, ISO weekday |
| `HH`, `hh`, `mm`, `ss`, `A` | Hours, 12-hour hours, minutes, seconds, AM/PM |
| `[text]` | `text`, as written, as in `YYYY-MM-DD [Week] ww` |

### Navigation

With `navigation: true`, the default, each daily note shows links to the
previous and next daily notes by date.

### Templates

With `template` set, a daily note whose body is empty is filled from the
template note, the way Obsidian fills a new daily note. A note you have already
written in is never changed.

These tokens expand inside the template, as Obsidian expands them when it
creates the note. In ordinary notes, `{{date}}` stays as written.

| Token | Output |
|-------|--------|
| `{{date}}`, `{{title}}` | The note's file name, which is its date in `dateFormat` |
| `{{time}}` | The build's time, as `HH:mm` |
| `{{date:FORMAT}}`, `{{time:FORMAT}}` | The note's date at the build's time of day, in FORMAT |
| `{{date+1d}}`, `{{date-1w:dddd}}` | The date moved by a Moment unit: `y`, `Q` (quarter), `M` (month), `w`, `d`, `h`, `m` (minute) or `s`. As in Obsidian, `q` and `D` do not move the date. |
| `{{yesterday}}`, `{{tomorrow}}` | The neighbouring dates, in `dateFormat` |

```markdown
---
tags: [journal]
---
# {{title}}

Planned for {{date:dddd}}, created at {{time}}.

- [ ] First task
```

For templates with logic, use [Templater](./templater.md).

### Calendar page

With `calendar` set to a route, the plugin generates a page at that route. It
lists every daily note, grouped by month and newest first, much like the
calendar view of Obsidian's daily notes.

## Tags and daily notes in the graph

When [Graph View](/graph/guide/graph-view) is on, tag pages and daily notes are
nodes like any other page. A note's tags connect it to the tag page, and
wikilinks between daily notes become edges.

To query tags and daily notes, for example to list a week's tasks, use
[Dataview](./dataview.md).
