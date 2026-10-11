---
description: Embed content from other pages using transclusion syntax.
---

# Transclusion

Transclusion lets you embed content from other pages directly into the current page, creating a single source of truth.

## Basic Syntax

```markdown
![[Page]]                    — Embed full page
![[Page#Heading]]            — Embed specific section
![[Page#^block]]             — Embed specific block
```

## How It Works

When `enableTransclusion` is on, the plugin:
1. Resolves the target page
2. Extracts the requested content (full page, heading, or block)
3. Inlines it at the wikilink location
4. Processes the inlined content through the full pipeline

## Full Page Transclusion

```markdown
![[Getting Started]]
```

Embeds the entire content of the Getting Started page.

## Heading Transclusion

```markdown
![[Getting Started#Install]]
```

Embeds only the content under the `Install` heading. A nested path, `![[Getting Started#Setup#Linux]]`, picks the `Linux` under `Setup`, and the second of two same-named headings is reached by its id (`#install-1`). A note can embed one of its own sections: `![[#Install]]`.

## Block Transclusion

```markdown
![[Notes#^important-point]]
```

Embeds only the block with the ID `important-point` — the whole paragraph (or list item, with its nested items) carrying it, not just its last line.

## Ids inside an embed

Every id an embedded note emits — its headings, footnotes and block anchors — is prefixed per embed (`embed-1-install`, `embed-1-fn-1`), so the host page never carries a duplicate id and its own `#install` and `#fn-1` links keep pointing at the host's headings and footnotes.

## Circular Detection

The plugin detects circular transclusions — keyed on page *and* section, so only an embed already being rendered is refused — and breaks the cycle with a link to the page plus a warning:

```
Page A → Page B → Page A (refused: rendered as a link to Page A)
Note#Part embeds ![[#Part]] (refused: the section embeds itself)
```

## Depth Limit

Transclusion is cycle-safe and capped at five nested levels to protect the build from recursive or excessively deep embeds.

## Configuration

```ts
markdown({
  enableTransclusion: true,
  enableDefaultStyles: true,
});
```

## External vault example

When `vaultRoot` is configured, transclusion resolves against the vault index:

```ts
markdown({
  vaultRoot: "./Obsidian Vault",
  vaultRoutePrefix: "/vault",
  enableTransclusion: true,
  enableMediaEmbeds: true,
});
```

```md
![[guide/Setup Guide]]
![[guide/Setup Guide#Installation]]
![[guide/Setup Guide#^setup-checklist]]
![[assets/diagram.png|800x450]]
```

Missing headings and block IDs produce a diagnostic and fall back to a link instead of silently embedding the full page.

## Styling

Transcluded content is wrapped in:

```html
<div class="obsidian-transclusion">
  <!-- Transcluded content here -->
</div>
```

## Next Steps

- Learn about [Wikilinks](/markdown/guide/link-resolution) for linking syntax
- See [[callouts|Callouts]] for styled content blocks
- Explore [[backlinks|Backlinks]] for automatic link discovery
