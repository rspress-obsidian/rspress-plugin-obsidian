# Create a Link

This page demonstrates wikilinks, embeds and backlinks.

## Embed

![[guide/intro]]

![[guide/intro#Transclusion Target]]

## Cross links

- [[Welcome]] — back to home
- [[guide/intro]] — intro guide

## Reference-style links

A reference-style definition is a link like any other, and it counts as a
backlink to whatever it names — the graph and the backlink panel read the same
set, so they cannot disagree about the same vault:

- [the intro guide by reference][intro]
- [a section of it by reference][section]

Footnote and citation definitions look similar but address nothing, so they are
not links: a note[^not-a-link] and a citation[~cite] stay out of the backlinks.

[intro]: guide/intro.md
[section]: guide/intro.md#Transclusion Target
[~cite]: guide/intro.md

[^not-a-link]: A footnote definition is `[^id]: target`, and a citation is `[~id]: target`. Neither is a page link.
