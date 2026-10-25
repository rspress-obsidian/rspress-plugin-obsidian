---
title: Backlinks
description: Add a backlinks panel to every page listing the notes that link to it, and optionally the notes that mention it without linking.
---

# Backlinks

A backlinks panel lists, at the bottom of each page, the notes that link to
that page, as Obsidian's backlinks pane does. Turn it on with
[`enableBacklinks`](./api.md#features):

```ts
markdown({
  enableBacklinks: true,
  enableDefaultStyles: true, // styles the panel
});
```

Scroll to the bottom of [Live Examples](./examples.md) to see one.

## What counts as a link

A link counts as a backlink when it resolves to the page, by the same rules the
rendered link follows. A name that several notes share counts only for the note
it resolved to. These forms count:

- wikilinks and embeds: `[[Page]]`, `[[Page#Heading]]`, `![[Page]]`
- Markdown links and images: `[text](Page.md)`, `![](diagram.png)`
- reference definitions: `[ref]: Page.md`
- `obsidian://open` URIs
- wikilinks in frontmatter properties, such as `related: "[[Page]]"` or
  `up: ["[[a/b]]"]`, which Obsidian 1.4 and later counts as links

Tags, external URLs, same-page links such as `[[#Heading]]`, and footnote or
citation definitions are not links.

With `vaultRoot` set, links between `docs/` and the vault count in both
directions. The [Graph View](/graph/) uses the same set of links, so the two
always agree.

## Unlinked mentions

Obsidian's backlinks pane has a second list: notes that name this page without
linking to it. To add that list, with a snippet of the text around each
mention, set `enableUnlinkedMentions`. It turns on `enableBacklinks` as well:

```ts
markdown({ enableUnlinkedMentions: true });
```

A page's names are its frontmatter `title`, its `aliases` and its file name.
Headings are not names. A note that also links to the page appears only under
backlinks, so the two lists never repeat each other. To find mentions, the
plugin keeps a copy of each page's text while it builds, capped at about 20,000
characters per page. That cost is why the option is off by default.

## Styling

The panel is plain HTML with these classes:

```html
<div class="obsidian-backlinks">
  <h2>Backlinks</h2>
  <ul>
    <li><a href="/guide/intro">Introduction</a></li>
  </ul>
</div>
<div class="obsidian-backlinks obsidian-unlinked-mentions">
  <h2>Unlinked mentions</h2>
  …
</div>
```

`enableDefaultStyles` styles it with Rspress's theme variables, so it follows
light and dark mode. To restyle it, target `.obsidian-backlinks` in your own
stylesheet.
