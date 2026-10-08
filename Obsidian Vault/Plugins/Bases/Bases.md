---
tags:
  - plugins
---
# Bases

Obsidian's core **Bases** plugin, rendered at build time. The data lives in the
notes under `Books/` and `Places/`; the views are described by
[[Library.base]] and [[Places.base]], which each get their own page.

## Embedding a base

`![[Library.base]]` shows every view, with a tab for each:

![[Library.base]]

`![[Library.base#Shelf]]` shows only the **Shelf** view:

![[Library.base#Shelf]]

Link straight to one view of a base page: [[Library.base#Board|the reading board]].

## A base in a code block

A ```` ```base ```` block is a base written inline. Here `this` is this note:

```base
filters:
  and:
    - file.hasTag("book")
    - rating >= 4
formulas:
  verdict: if(rating == 5, "Must read", "Recommended")
  embedded_in: this.file.name
views:
  - type: table
    name: Favourites
    order:
      - file.name
      - rating
      - formula.verdict
      - formula.embedded_in
    sort:
      - property: file.name
        direction: ASC
```

## Map views

A map view draws an interactive map, as the Maps plugin does: a marker per
located place, coloured by its `color` property, with a popup of its other
properties. Click a marker to open its note. Without JavaScript, and in the search
index, the view is the table of its places.

![[Places.base]]
