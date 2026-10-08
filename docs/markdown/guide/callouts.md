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
| `tip` | Teal | Helpful suggestions |
| `info` | Cyan | Supplementary details |
| `todo` | Blue | Tasks and checklists |
| `success` | Green | Positive outcomes |
| `question` | Lime | Open questions |
| `warning` | Orange | Cautionary information (aliases: `caution`, `attention`) |
| `danger` | Red | Critical warnings |
| `failure` | Red | Negative outcomes |
| `bug` | Pink | Known issues |
| `example` | Purple | Code samples |
| `abstract` | Cyan | Summaries |
| `quote` | Gray | Citations |

## Custom Callout Types

A type outside the table above — for example `[!roadmap]` or `[!my-roadmap]`;
any characters up to `]` work — keeps its own `callout-roadmap` class and falls
back to Obsidian's `note` styling: a blue card with the pencil glyph. Without a
title the type is the title, capitalised (`> [!tip]` reads "Tip"). The plugin
also emits Obsidian's `data-callout` attribute with the type as written (so
`[!caution]` is `class="callout callout-warning" data-callout="caution"`), and
Obsidian's metadata — `> [!roadmap|wide]` — as `data-callout-metadata`, so the
documented Obsidian customization recipes work unchanged:

```css
.callout[data-callout="roadmap"] {
  --callout-color: #7c4dff;
}

.callout[data-callout="roadmap"] .callout-title::before {
  content: "🏁";
}

.callout[data-callout-metadata~="wide"] {
  max-width: none;
}
```

This requires `enableDefaultStyles: true` (the bundled stylesheet provides the
colours and title glyphs).

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
markdown({
  enableCallouts: true,
  enableDefaultStyles: true,  // Inject bundled CSS
});
```

## Next Steps

- Learn about [[backlinks|Backlinks]] for automatic link discovery
- Explore [[transclusion|Transclusion]] for embedding content
