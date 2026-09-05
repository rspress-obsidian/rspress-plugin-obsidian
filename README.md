# rspress-plugin-obsidian

One Obsidian-publishing suite for Rspress. Merge of three plugins:

| Feature | Package | Export |
| --- | --- | --- |
| Markdown (wikilinks, callouts, backlinks, transclusion, Dataview, daily notes) | `rspress-plugin-obsidian-wikilink` | `pluginObsidianWikiLink` |
| Canvas (`.canvas` pages, editor) | `rspress-plugin-obsidian-canvas` | `pluginObsidianCanvas` |
| Graph view (interactive knowledge graph) | `rspress-plugin-graph-view` | `pluginGraphview` |

## Layout

- `src/markdown/` — remark pipeline, content index, dataview, backlinks, styles
- `src/canvas/` — canvas parser, renderer components, styles
- `src/graph/` — build-time graph extraction, runtime panel/sidebar
- `test/` — unit (colocated `*.test.ts`) + e2e (playwright)
- `Obsidian Vault/` — shared demo fixture

## Development

```bash
bun install
bun run typecheck
bun test
bun run build      # tsup → dist/ (ESM+CJS, d.ts, css)
```

## License

MIT. Each feature originated in its own repository; see `LICENSE-graph-view.txt`,
`LICENSE-obsidian-canvas.txt`, `LICENSE-obsidian-wikilink.txt`.
