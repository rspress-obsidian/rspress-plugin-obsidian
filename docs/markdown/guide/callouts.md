---
title: Callouts
description: Render Obsidian callouts — every built-in type and alias, custom types, foldable and nested callouts — and style them with CSS.
---

# Callouts

Callouts are blockquotes that start with `[!type]`, rendered as coloured boxes
with an icon and a title, as in Obsidian. Turn them on with
[`enableCallouts`](./api.md#features). Load the bundled stylesheet too, since it
provides the colours and icons:

```ts
markdown({
  enableCallouts: true,
  enableDefaultStyles: true,
});
```

With `enableCallouts` off, callouts stay plain blockquotes.

## Syntax

```markdown
> [!warning] Back up first
> This deletes the generated files.
```

The first line holds the type and an optional title. The lines after it are
the body, which can contain any Markdown. If you leave out the title, the type
becomes the title, capitalised: `> [!tip]` reads "Tip". The title is inline
Markdown, so bold text, code and wikilinks render in it:

```markdown
> [!question] See [[getting-started|Getting Started]] for **setup**
> Body text.
```

## Types

| Type | Colour | Aliases |
|------|--------|---------|
| `note` | Blue | |
| `abstract` | Cyan | `summary`, `tldr` |
| `info` | Cyan | |
| `todo` | Blue | |
| `tip` | Teal | `hint`, `important` |
| `success` | Green | `check`, `done` |
| `question` | Lime | `help`, `faq` |
| `warning` | Orange | `caution`, `attention` |
| `failure` | Red | `fail`, `missing` |
| `danger` | Red | `error` |
| `bug` | Pink | |
| `example` | Purple | |
| `quote` | Grey | `cite` |

An alias renders exactly like its type. The output follows Obsidian's markup:
the class names the canonical type, and `data-callout` keeps the type as you
wrote it. `> [!caution] Watch out` followed by one line of body renders as:

```html
<div class="callout callout-warning" data-callout="caution">
  <div class="callout-title">Watch out</div>
  <div class="callout-content"><p>This will be transformed.</p></div>
</div>
```

## Foldable callouts

Add `-` after the type to collapse a callout by default, or `+` to expand it.
Foldable callouts render as native `<details>` elements, so they need no
JavaScript:

```markdown
> [!note]- Collapsed by default
> Hidden until the reader opens it.

> [!tip]+ Expanded by default
> Visible, but the reader can collapse it.
```

## Nested callouts

To nest a callout, quote it one level deeper:

```markdown
> [!example] Outer callout
> The outer body.
>
> > [!question] Nested question
> > The inner callout renders too.
```

## Custom types

You can use any type, for example `[!roadmap]`. An unknown type keeps its own
`callout-roadmap` class, gets `data-callout="roadmap"`, and looks like a `note`
until you style it. Text after a `|` in the type, as in `> [!roadmap|wide]`,
becomes `data-callout-metadata`. The CSS recipes from Obsidian's documentation
work unchanged:

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

Put these rules in a stylesheet listed in your Rspress `globalStyles`.

## Callouts and Rspress alerts

Rspress has its own GitHub-style alerts that use the same syntax for `note`,
`tip`, `info`, `warning`, `caution`, `danger` and `details`. Rspress converts
them before plugins run, which loses Obsidian's fold marker and the first
paragraph of a multi-paragraph callout. With `enableCallouts` on, the plugin
detects those converted blocks, restores the original blockquote from the
source, and renders it as an Obsidian callout. Rspress's `:::note` containers
are a different syntax and keep Rspress's styling.

The [Live Examples](./examples.md#callouts) page renders every type.
