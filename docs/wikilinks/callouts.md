---
description: Styled callouts like Obsidian — notes, warnings, tips, and foldable sections.
---

# Callouts

Callouts are styled content blocks that highlight important information. They support multiple types, fold states, and nested structures.

## Basic Syntax

```markdown
> [!note] This is a note
> This is the content inside the callout.

> [!warning] Warning Title
> Be careful with this operation.

> [!tip] Helpful Tip
> You can use **bold**, *italics*, and `code` inside callouts.
```

## Callout Types

| Type | Color | Use For |
|------|-------|---------|
| `note` | Blue | General information |
| `tip` | Green | Helpful suggestions |
| `info` | Cyan | Supplementary details |
| `success` | Green | Positive outcomes |
| `question` | Yellow | Open questions |
| `warning` | Orange | Cautionary information |
| `danger` | Red | Critical warnings |
| `failure` | Red | Negative outcomes |
| `bug` | Red | Known issues |
| `example` | Purple | Code samples |
| `abstract` | Gray | Summaries |
| `quote` | Gray | Citations |

## Foldable Callouts

Add `+` to expand by default, `-` to collapse:

```markdown
> [!tip]+ Expanded by Default
> This content is visible immediately.

> [!note]- Collapsed by Default
> This content is hidden until expanded.
```

## Nested Callouts

Callouts can be nested inside other callouts:

```markdown
> [!example] Outer Callout
> This is the outer callout.
>
> > [!question] Nested Question
> > This inner callout is fully processed.
>
> Back to the outer content.
```

## Title Markdown

Callout titles support inline markdown:

```markdown
> [!example] A **bold** title with [[getting-started|wikilinks]]
> The title renders markdown and resolved wikilinks.
```

## Configuration

```ts
pluginObsidianWikiLink({
  enableCallouts: true,
  enableDefaultStyles: true,  // Inject bundled CSS
});
```

## Next Steps

- Learn about [[backlinks|Backlinks]] for automatic link discovery
- Explore [[transclusion|Transclusion]] for embedding content
