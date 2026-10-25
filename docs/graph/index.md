---
title: Graph View
description: Overview of the Graph View section — the interactive graph of your pages and Obsidian-style hover previews, with links to setup, usage, configuration and the API reference.
---

# Graph View

`graphview()` adds Obsidian's graph view to your site: a floating panel that draws your pages and the links between them, either the current page's neighbourhood (the local graph) or the whole site (the global graph). Readers can search it with Obsidian's search syntax, filter it, and click a node to open the page. The same plugin can also show Obsidian's Page preview: rest the mouse on a link in an article and the linked note appears in a popover.

The graph reads its links from the [Markdown](/markdown/) plugin, so every wikilink, embed, tag and Markdown link a page renders is an edge, and a [Canvas](/canvas/) board links to the notes on its cards.

```ts
graphview({ defaultOpen: true, enableHoverPreviews: true });
```

| Page | Read it when you want to |
|------|--------------------------|
| [Getting Started](./guide/getting-started.md) | Install the plugin and its `react-force-graph-2d` peer, add it to `rspress.config.ts`, and load the stylesheet |
| [Using the Graph View](./guide/graph-view.md) | Know what readers can do in the panel: search syntax, filters, keyboard access, hover previews, and which Obsidian content becomes nodes |
| [Configure the Graph View](./guide/configuration.md) | Open the panel by default, colour groups, your own colours, embed the graph in a layout, handle unresolved links, profile the build |
| [API Reference](./api.md) | Look up every `graphview()` option and `colors` key with its type and default |
