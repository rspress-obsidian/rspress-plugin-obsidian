---
title: Transclusion
description: Embed a whole note, one section or one block in another page with ![[Note]], and how embeds handle ids, cycles and missing targets.
---

# Transclusion

Transclusion inserts the content of one note into another, so you can write a
passage once and show it in several places. Turn it on with
[`enableTransclusion`](./api.md#features):

```ts
markdown({
  enableTransclusion: true,
  enableDefaultStyles: true, // frames the embedded content
});
```

With the option off, `![[Note]]` renders as a link to the note. Images, audio,
video and PDFs are a separate option; see [Media Embeds](./media-embeds.md).

## Syntax

| You write | Embeds |
|-----------|--------|
| `![[Setup]]` | The whole note, without its frontmatter |
| `![[Setup#Install]]` | The `Install` heading and the content under it |
| `![[Setup#Linux#Install]]` | The `Install` heading under `Linux` |
| `![[Setup#^step-1]]` | The paragraph, list item (with its nested items) or table with the id `^step-1` |
| `![[#Install]]` | A section of the current note |
| `![alt](Setup.md)` | The same as `![[Setup]]`, written as a Markdown embed |

Targets resolve the same way as [wikilinks](./link-resolution.md#how-a-link-resolves),
and heading and block subpaths match the same way. Wikilinks, callouts, math
and every other feature work inside embedded content, so it renders as it does
on its own page.

The embedded content is wrapped in a container that names its source:

```html
<div class="obsidian-transclusion" data-src="/Setup">
  …the embedded content…
</div>
```

## Ids inside an embed

An embedded note keeps its headings, footnotes and block anchors, so their ids
are prefixed per embed: `embed-1-install`, `embed-1-fn-1`. The host page never
ends up with duplicate ids, and its own `#install` and `#fn-1` links still
reach its own heading and footnote.

## Edge cases

- **Missing section.** If the heading or block does not exist, the embed
  renders as a link to the note and the build reports it through
  `onBrokenLink`. The plugin never falls back to embedding the whole note.
- **Cycles.** An embed whose note and section are already being rendered
  higher up, such as A embeds B and B embeds A, or a section that embeds
  itself, renders as a link to the page with a warning.
- **Depth.** Embeds nest at most five levels deep.
- **Unpublished notes.** A note with `publish: false` cannot be embedded. The
  embed is reported as a broken link.
