---
title: Intro
tags:
  - guide
---
# Intro Guide

A vault-level intro page reachable at `/vault/guide/intro`.

Back to [[Welcome|Welcome home]].

## Transclusion Target

A canvas card can embed exactly this section and nothing else — the card and a
note page slice a section with the same rules, so the two cannot drift. The
board in this vault points a text card at this heading.

## Block Anchors

A block id is a line of its own, and `[[Note#^id]]` or `![[Note#^id]]` reaches
it. This paragraph carries one: ^anchor-demo

> A standalone `^id` refers to the paragraph above it; a trailing ` ^id` refers
> to the line it sits on. Both are indexed and both resolve.

## Daily Notes

Daily notes are filed by date. The documentation site's own
[tag and daily-note page](/markdown/guide/tags-and-daily-notes) covers what a vault produces.

That link is a plain Markdown link on purpose: a note inside the vault resolves
against the vault's own index, so a `[[wikilink]]` from here can only name
another vault note. A docs page is reached by its published route.
