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

Embeds only the content under the `Install` heading.

## Block Transclusion

```markdown
![[Notes#^important-point]]
```

Embeds only the block with the ID `important-point`.

## Circular Detection

The plugin detects circular transclusions and breaks the cycle:

```
Page A → Page B → Page A (broken, shows raw wikilink)
```

## Depth Limit

Transclusion is cycle-safe and capped at five nested levels to protect the build from recursive or excessively deep embeds.

## Configuration

```ts
pluginObsidianWikiLink({
  enableTransclusion: true,
  enableDefaultStyles: true,
});
```

## External vault example

When `vaultRoot` is configured, transclusion resolves against the vault index:

```ts
pluginObsidianWikiLink({
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

- Learn about [[wikilinks|Wikilinks]] for linking syntax
- See [[callouts|Callouts]] for styled content blocks
- Explore [[backlinks|Backlinks]] for automatic link discovery
