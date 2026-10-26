---
title: Note Syntax
description: The Obsidian syntax that works with no options set — comments, highlights, footnotes, frontmatter fields and publish false drafts — and how each one renders.
---

# Note Syntax

This page covers the Obsidian syntax that `markdown()` handles with no options
set: comments, highlights, footnotes, and the frontmatter fields the plugin
reads. Links and embeds have their own guide, [Wikilinks](./link-resolution.md).

## Comments

Text between `%%` delimiters is private. The plugin removes it from the page,
the page outline and the search index:

```markdown
Visible text. %% Private note, not published. %% More visible text.

%%
A whole private paragraph.
%%
```

A comment runs from an opening `%%` to the next `%%`, so it can span
paragraphs, lists and headings. Everything between the delimiters is dropped,
along with any heading inside it:

```markdown
Visible text. %%
## This heading is private
And so is this paragraph.
%% Still visible.
```

Inside frontmatter, fenced code and inline code, `%%` is plain text. A
comment left open follows Obsidian's Reading view: a line that begins with `%%`
starts a block comment, and if nothing closes it the rest of the note is
hidden; a `%%` written mid-line with no closing `%%` stays as written.

## Highlights

`==text==` renders as `<mark>text</mark>`:

```markdown
This is ==highlighted text== in a sentence.
```

## Footnotes

Write a reference as `[^label]` and define it anywhere on the page, or write
the footnote inline as `^[text]`:

```markdown
This is a statement[^note] with a footnote, and an aside^[Written inline].

[^note]: This is the footnote definition.
```

Footnotes are numbered in the order they are first referenced, whatever their
labels, and listed at the end of the page with a link back to each reference.
A repeated reference reuses its number. Definitions are rendered as Markdown,
so they can contain bold text, links, wikilinks and math. The reference's
tooltip shows the definition's text.

Inside a transcluded note, footnote ids carry the embed's prefix
(`embed-1-fn-1`), so they cannot collide with the host page's footnotes.

## Frontmatter

The plugin reads these frontmatter fields:

| Field | What it does |
|-------|--------------|
| `title` | Lets you link to the note by its title (`[[My Title]]`). |
| `aliases` (or `alias`) | Lets you link to the note by each alias (`[[Alias Name]]`). |
| `tags` (or `tag`) | Tags the note. These feed tag pages, Dataview and the graph. See [Tags](./tags-and-daily-notes.md). |
| `cssclasses` (or `cssclass`) | Wraps the page body in a `<div>` with these classes, for your own CSS. |
| `excerpt` | Becomes the page description (`<meta name="description">`) unless the page sets `description`. |
| `publish` | `false` keeps the note off the site. See below. |

A list field accepts a YAML list or a comma-separated string:

```yaml
---
title: Onboarding Guide
aliases:
  - Start Here
  - Quick Start
tags: [tutorial, obsidian]
cssclasses: wide-tables
excerpt: How to set up the vault in ten minutes.
---
```

The plugin does not render other properties on the page, as Obsidian does
above a note. To show them, use a [Dataview](./dataview.md) query or a
[Bases](./bases.md) view.

## Drafts: `publish: false`

To keep a note off the site, set `publish: false`:

```yaml
---
title: Rough Draft
publish: false
---
```

An unpublished note:

- has no page. A note in `docs/` loses its route, so it is not built and does
  not appear in the generated sidebar, the nav or search.
- cannot be linked or embedded. A wikilink to it is reported as broken.
- appears in no tag page, backlinks panel, Dataview result or graph.
- does not publish its attachments. A file that only unpublished notes use stays
  private.

The index also reads `no` and `0` as false, but only a YAML boolean `false`
removes the route of a page in `docs/`, so prefer `false`. If a hand-written
`_meta.json` or `themeConfig` lists the page, remove that entry as well.
Otherwise it becomes a link to nothing.
