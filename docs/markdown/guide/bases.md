---
description: Obsidian Bases — .base files, base blocks and embeds evaluated at build time into tables, cards, lists and boards.
---

# Bases

[Bases](https://obsidian.md/help/bases) is Obsidian's core plugin for
database-like views of your notes. With `enableBases: true` the plugin
evaluates every base at build time — filters, formulas, sorting, grouping and
summaries — and publishes the result as static HTML, so the page shows what
Obsidian's reading view shows and is found by the site search. Only map views
use a client script, to draw their map.

```ts
markdown({
  vaultRoot: "./vault",
  enableBases: true,
  bases: {
    now: "2024-05-10", // pin today() and now() for reproducible builds
  },
});
```

## Where a base appears

| Written as | Renders | `this` is |
|---|---|---|
| A `Projects.base` file | Its own page at `bases.routePrefix` + its path (`/bases/Projects`) | the `.base` file |
| `![[Projects.base]]` | Every view of the base, in place | the note holding the embed |
| `![[Projects.base#Board]]` | Only the view named `Board` | the note holding the embed |
| A ` ```base ` block | The base written in the block | the note holding the block |

`[[Projects.base]]` links to the base's page, and `[[Projects.base#Board]]`
to that view on it: on the base's page each view's element id is its name,
so the fragment opens and scrolls to it. A `.base` file with a page is not
published as a raw download.

A base with several views shows a tab for each. The tabs are radio buttons
styled with CSS, so they work without JavaScript; the first view is shown until
another is picked, as in Obsidian. (A base with more than twelve views lists
them one after another instead.)

## Syntax

The whole [Bases syntax](https://obsidian.md/help/bases/syntax) is read:

```yaml
filters:
  or:
    - file.hasTag("book")
    - and:
        - file.inFolder("Reading")
        - 'status != "done"'
    - not:
        - file.hasTag("archived")
formulas:
  ppu: (price / pages).toFixed(2)
  overdue: if(due < today() && !done, "Overdue", "")
properties:
  formula.ppu:
    displayName: Price per page
summaries:
  topRated: values.filter(value >= 4).length
views:
  - type: table
    name: Catalogue
    limit: 50
    order: [file.name, author, rating, formula.ppu]
    sort:
      - property: rating
        direction: DESC
    groupBy:
      property: genre
      direction: ASC
    groupOrder: [Fantasy, Science fiction, null]
    summaries:
      rating: Average
      formula.ppu: topRated
```

- **`filters`** — a statement, or `and` / `or` / `not` over a list of filters.
  `not` is "none of the following are true". The base's filters and the view's
  are combined with AND. A base with no filters lists every published file —
  docs pages, vault notes, and attachments (which have file properties only).
- **`formulas`** — formula properties, available as `formula.name`. A formula
  may use another; a circular reference shows as an error in its cell.
- **`properties`** — `displayName` heads the column (default: the property
  name without its `note.` or `formula.` prefix; `file name` for `file.name`).
- **`summaries`** — custom summary formulas over `values`, used by name in a
  view's `summaries`.
- **`views`** — `type`, `name`, `limit`, `filters`, `order`, `sort`
  (`{property, direction}`; Obsidian 1.9's `column:` is read too),
  `groupBy`, `groupOrder` (only the listed groups, in order; `null` is the
  files without a value; a listed value no file has is an empty group) and
  `summaries`, plus the layout settings below.

Malformed YAML or a section of the wrong shape is shown in place of the base and
reported through `onPluginError`. A key Obsidian does not define is shown as a
warning above the views and reported as a warning.

## Layouts

| `type` | Output | Settings read |
|---|---|---|
| `table` | A table (`bases-table`, `bases-th`, `bases-td[data-property]`), group header rows, a summary row (per group at the top of the group, as in Obsidian) | `columnSize`, `rowHeight` |
| `cards` | A grid of cards (`bases-cards-item`) with a cover image | `image`, `imageFit` (`cover`/`contain`), `imageAspectRatio`, `cardSize` |
| `list` | A bulleted or numbered list (`bases-list-item`) | `markers` (`bullets`/`number`/`none`), `indentProperties`, `separator` |
| `kanban` | One lane per `groupBy` value (`bases-kanban-column`), files without a value in **None** | `image`, `imageFit`, `imageAspectRatio`, `columnWidth`, `hideEmptyColumns` |
| `map` | An interactive map with a marker per located file, drawn in the browser over the table of those files (see [Map views](#map-views)) | `coordinates`, `markerIcon`, `markerColor`, `center`, `defaultZoom`, `minZoom`, `maxZoom`, `mapHeight`, `mapTiles`, `mapTilesDark`, `mapAttribution` |

Grouped cards and lists sit in collapsible `<details>` sections. Every view
shows its result count. Cells render by type: links resolve like the same
wikilink in the note, text renders its markdown (links, tags, emphasis),
lists are chips (`value-list-element`), dates use `dateFormat` /
`dateTimeFormat`, booleans are disabled checkboxes, and `image()` values are
pictures. The cover image of a card may be a link to an attachment, a URL or a
hex colour.

Summaries: `Average`, `Min`, `Max`, `Sum`, `Range`, `Median`, `Stddev`,
`Earliest`, `Latest`, `Checked`, `Unchecked`, `Empty`, `Filled`, `Unique`, and
any custom summary. `Average` and `Stddev` (population) show two decimals.

## Map views

A `map` view is drawn the way Obsidian's official
[Maps plugin](https://github.com/obsidianmd/obsidian-maps) draws it, with the
same library, [MapLibre GL JS](https://maplibre.org/). It is an optional peer
dependency; install it next to the plugin:

```bash
npm install maplibre-gl
```

The page is built with the table of the view's located files, which is what a
reader without JavaScript and Rspress's search index see. In the browser, a
client component turns that table into the map and hides it:

- One marker per file whose `coordinates` property holds `"lat, lng"` or a
  `[lat, lng]` list (a formula such as `[latitude, longitude]` works too). A
  marker is a link to the note: a click opens it, and hovering or focusing it
  shows a popup with the note's title and its other non-empty properties.
- `markerColor` names a property holding any CSS colour (`red`, `#e5484d`,
  `rgb(…)`, `var(--rp-c-brand)`); a value that is not a colour is reported and
  the default colour is used. `markerIcon` names a property holding a
  [Lucide](https://lucide.dev/icons/) icon name, drawn with `lucide-static` as
  in `icon()`.
- `center` is a formula (`[48.85, 2.29]`, `this.coordinates`) or
  `"lat, lng"` text; without it the map centres on its markers. `defaultZoom`
  sets the zoom; without it the map fits its markers. `minZoom` (default `0`)
  and `maxZoom` (default `18`) bound it, as in the plugin.
- Embedded (`![[Places.base]]` or a ```` ```base ```` block), the map is
  `mapHeight` pixels tall (default `400`); on the base's own page it fills most
  of the window.
- The background follows the site's light or dark mode. `mapTiles` and
  `mapTilesDark` take a style URL (such as OpenFreeMap's `liberty` or
  `positron`) or raster tile URLs with `{z}`, `{x}` and `{y}`; dark mode falls
  back to the light tiles. A view without `mapTiles` uses `bases.mapTiles`,
  then the first background configured in the Maps plugin's settings, then the
  plugin's default, OpenFreeMap's `bright` and `dark` styles (free, no key).
- A style brings its own credit. For raster tiles, `mapAttribution` (a view
  setting this plugin adds) or `bases.mapTiles.attribution` gives the credit as
  inline markdown; OpenStreetMap's own tile servers are credited by default.

```ts
markdown({
  enableBases: true,
  bases: {
    mapTiles: {
      tiles: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
      // attribution defaults to OpenStreetMap's for these tiles
    },
  },
});
```

A tile URL is published in the page, so do not use one that carries a secret
key. The map's classes are the plugin's (`bases-map`, `bases-map-popup`,
`bases-map-popup-property`), and the markers read its
`--bases-map-marker-background` and `--bases-map-marker-icon-color` variables.

## Formulas

Formulas and filters use the documented
[functions](https://obsidian.md/help/bases/functions). They are interpreted by
the plugin — never passed to JavaScript's `eval` — and support:

- literals (numbers, `'…'`/`"…"` strings, `true`/`false`/`null`, `[lists]`,
  `/regular expressions/`), `+ - * / %`, unary `-`, comparisons, `&& || !`;
- `note.x` or bare `x`, `note["x y"]`, `file.*` (`name`, `basename`, `path`,
  `folder`, `ext`, `size`, `ctime`, `mtime`, `tags`, `links`, `embeds`,
  `backlinks`, `properties`), `formula.x`, and `this`;
- date arithmetic with duration strings: `now() + "1 day"`,
  `date("2024-12-01") + "1M" + "4h"`, `due - "2w"`, and `date - date` for the
  duration between two dates;
- global `if`, `now`, `today`, `date`, `duration`, `number`, `list`, `link`,
  `image`, `icon`, `max`, `min`, `file`, `html`, `escapeHTML`, `random`;
- the functions of every type: any (`isTruthy`, `isType`, `toString`,
  `isEmpty`), string, number, date (with the `year` … `millisecond` fields,
  `format` with Moment.js tokens, `relative`), list (`filter`/`map`/`reduce`
  with `value`, `index` and `acc`, `sort`, `unique`, `mean`, `sum`, `median`,
  `min`, `max`, …), link (`asFile`, `linksTo`), file (`asLink`, `hasLink`,
  `hasProperty`, `hasTag` with nested tags, `inFolder` with subfolders), object
  (`keys`, `values`, on objects from properties) and regular expression
  (`matches`).

Properties come from each note's frontmatter, read once per build. A
`"[[wikilink]]"` property is a link, an ISO `YYYY-MM-DD[ HH:mm[:ss]]` value
is a date, and the vault's `.obsidian/types.json` decides the rest (a property
typed `number`, `checkbox` or `text` reads as one), as in Obsidian.

### Matches Obsidian's runtime where it differs from the docs

Obsidian's help pages and the Bases engine in the app disagree in places. The
plugin follows the app: a vault renders the way current Obsidian renders it.
This was checked against the corpus of results recorded from a running
Obsidian by
[obsidian-bases-expression](https://github.com/callumalpass/obsidian-bases-expression)
(293 of its 294 cases match; the one exception is listed below).

| Formula | The docs say | Obsidian (and this plugin) |
|---|---|---|
| `date("2026-06-11") - date("2026-06-10")` | `86400000` | a Duration, shown as `a day`; `number()` of it is an error. Divide it to count: `(due - today()) / 86400000` |
| `duration("2w").toString()` | — | `14 days` (moment.js's wording: `a minute`, `an hour`, `2 hours`, `a month`, `a year`) |
| `2 * duration("1h")` | — | error `Invalid operator between Number and Duration`; write `duration("1h") * 2` |
| `{"a": 1}.keys()` | an object literal | not parsed; objects come only from properties (`file.properties`, `note`) |
| `1.isTruthy()`, `+price` | valid | not parsed; write `(1).isTruthy()` and `price` |
| `file.name` | `row.md` | `row` for a note; any other file keeps its extension |
| `file.tags` | — | tags without `#` (`file.tags.contains("project/a")`) |
| `link("Note").toString()` | — | `[[Note]]` (`[[Note\|Shown]]` with a display); `file.toString()` is its path; `image(x).toString()` is `![](x)`; a date is `2026-06-10` or `2026-06-10T12:34:56` |
| `"asdf".asdfasdf`, `link("x").path` | — | error `Cannot find "path" on type Link` |

Links follow Obsidian's metadata cache. `file.links` lists the frontmatter
links, then the body's links in source order, then its embeds. Repeats are
kept, markdown links count (with their destination decoded as `decodeURI`
does, so `%26` stays as written), and external URLs do not. Two links are
equal when they reach the same file, whatever their display text or
`#subpath`. A target is resolved case-insensitively, ignoring its subpath, so
`file.hasLink("other.md")` and `file.hasLink("Other#Any heading")` match a
link to `Other`. A target that resolves to nothing matches only a link written
exactly the same way: `[[Missing Note]]` matches `"Missing Note"` but not
`"Missing Note.md"`. `unique()` removes links that read the same
(`[[Other|Other]]` twice), not every link to the same file.

Not matched: `file.backlinks` lists the linking files by path. Obsidian lists
them in the order its metadata cache indexed them, which a build cannot know.

### Errors

A missing property, or a key an object does not have, is nothing: its cell
is empty and nothing is reported. Arithmetic with nothing stays nothing.

A formula that cannot be evaluated is an error value, with Obsidian's message,
reported in one of two ways:

- **The base is wrong**, whatever the notes hold: a formula that does not
  parse, an unknown function (`Cannot find function "nope"`), an unknown or
  circular `formula.x`, or an unknown summary. The message shows in the cell
  (`⚠ …`) and is reported through `onPluginError`, so by default it fails the
  build.
- **One note's data does not fit a valid formula**: a field or method the
  value's type lacks (`(due - today()).days` is `Cannot find "days" on type
  Duration`; `status.round()` where one note's `status` is text), `number()` or
  `date()` of text they cannot read, an operator the types do not allow. The
  cell is empty, with the message in its `title`. It is reported as a warning
  and never fails the build. A filter that hits such an error leaves that file
  out.

### Icons

`icon("name")` draws a [Lucide](https://lucide.dev/icons/) icon, Obsidian's
icon set, when the optional peer `lucide-static` is installed:

```sh
npm install lucide-static
```

The icon's SVG is inlined at build time (nothing is added to the client
bundle) with Obsidian's classes, `svg-icon lucide-<name>`, plus `bases-icon`.
It is hidden from screen readers and drawn in the text colour. A name may be
written `arrow-up` or as Obsidian's icon id `lucide-arrow-up`, and Lucide's
aliases for renamed icons (`check-circle` for `circle-check`) work too.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `bases.routePrefix` | `string` | `"/bases"` | Route prefix the pages of `.base` files publish under |
| `bases.now` | `Date \| string` | the build time | The clock `now()`, `today()` and `relative()` read |
| `bases.dateFormat` | `string` | `"YYYY-MM-DD"` | Moment.js format of a date value |
| `bases.dateTimeFormat` | `string` | `"YYYY-MM-DD HH:mm"` | Moment.js format of a date-and-time value |
| `bases.mapTiles` | `{ tiles, tilesDark?, attribution? }` | the Maps plugin's first background, else OpenFreeMap | Background of map views without `mapTiles` of their own (see [Map views](#map-views)) |
| `bases.readVaultSettings` | `boolean` | `true` | Read property types from `.obsidian/types.json` and map backgrounds from `.obsidian/plugins/maps/data.json` |

## Limits

A static page cannot do everything an Obsidian base does. Each of these renders
the closest static equivalent and is reported as a warning:

- **Map views** without the optional `maplibre-gl` package show the table of
  their located files (with an OpenStreetMap link per row) and a note saying
  to install it.
- **`icon()`** shows the icon's name when `lucide-static` is not installed (the
  warning says to install it), or when Lucide has no icon of that name. A map
  marker whose icon cannot be drawn shows a dot.
- **Layouts from community plugins** (`calendar`, …) render as a table.

And without a report, because nothing is lost:

- Editing, the toolbar's sort/filter/search menus, creating notes from a view,
  dragging cards between Kanban lanes, and collapsing table groups are
  interactive features of the app; the published view is read-only.
- An attachment no published page references is not published, so a base
  lists it by name without a link. A cover image given as a plain path (not a
  `[[link]]`) is shown only when some page references the file.
- On a map, the context menus (new note here, copy coordinates, set the default
  centre and zoom), the background switcher, locating the reader and hover
  previews of the note are the app's. A map's `center` formula is evaluated
  once, with `this` the embedding note or the `.base` file.
- `random()` is seeded per base and file, so a build is reproducible.
- `this` in a sidebar (the active note) has no static equivalent; a base page
  uses the `.base` file, as Obsidian does when the base is opened on its own.
