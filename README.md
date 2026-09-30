# rspress-plugin-obsidian

One Obsidian-publishing suite for Rspress. Three features, one entry:

```ts
import { markdown, canvas, graphview } from "rspress-plugin-obsidian";

export default defineConfig({
  plugins: [
    markdown({ enableCallouts: true, enableBacklinks: true, enableDefaultStyles: true }),
    canvas({}),
    graphview({}),
  ],
});
```

`pluginObsidian((markdown, canvas, graphview) => [...])` composes the same three
in one call.

| Feature | Export | What you get | Stylesheet |
| --- | --- | --- | --- |
| Markdown | `markdown` | wikilinks, embeds, callouts, backlinks, transclusion, media embeds, tags + tag pages, daily notes, Dataview, math, Mermaid — see below | `rspress-plugin-obsidian/markdown/styles.css` |
| Canvas | `canvas` | `.canvas` boards as interactive pages, with an in-browser editor | `rspress-plugin-obsidian/canvas/styles.css` |
| Graph view | `graphview` | the interactive link graph, local and global | `rspress-plugin-obsidian/styles.css` (aggregate) |

### What `markdown()` turns on

Always on: `[[wikilinks]]`, `![[embeds]]`, `#heading` and `#^block` anchors,
`==highlights==`, `%%comments%%`, `[^1]` and `^[…]` footnotes, frontmatter.
On by default: `[text](Note.md)` links, case-insensitive lookup.

Everything else is opt-in, because a docs site may not want it:

| Option | Adds |
| --- | --- |
| `enableCallouts` | `> [!note]` styled blocks, with `+`/`-` fold states and nesting |
| `enableTransclusion` | `![[Note]]` inlines another note into this one |
| `enableMediaEmbeds` | `![[clip.mp4]]` — every image, audio, video and PDF format Obsidian accepts |
| `enableBacklinks` | the linked-mentions panel at the foot of each page |
| `enableUnlinkedMentions` | pages that *name* this one without linking to it |
| `enableTagLinking` + `enableTagPages` | `#tag` links to generated `/tags/<tag>` pages |
| `enableDailyNotes` | date-filed notes, `{{date}}` tokens, prev/next navigation |
| `enableDataview` | DQL blocks (`TABLE`/`LIST`/`TASK`/`CALENDAR`) and inline `= expr` |
| `enableMath` | `$inline$` and `$$display$$` via KaTeX, or MathJax with `mathEngine` |
| `enableMermaid` | ` ```mermaid ` fences drawn in the browser |
| `enableDefaultStyles` | injects the stylesheet the above need to be visible |

`enableCallouts`, `enableBacklinks` and `enableTagPages` emit markup but no
rules, so they need `enableDefaultStyles` (or the stylesheet imported by hand)
before any of it shows. `onBrokenLink` and `onAmbiguousLink` default to
`"error"`, so an unresolvable `[[wikilink]]` fails the build.

## Layout

- `src/shared/` — primitives more than one feature needs, and nothing else; node-free
- `src/markdown/` — the `markdown()` feature: remark pipeline, content index, Dataview, backlinks
- `src/canvas/` — the `canvas()` feature: parser, renderer components, editor
- `src/graph/` — the `graphview()` feature: build-time extraction, runtime panel
- `test/` — unit (colocated `*.test.ts`) + e2e (playwright)
- `Obsidian Vault/` — shared demo fixture

## Development

```bash
bun install
bun run typecheck
bun run docs:build    # required before the build-integration and e2e suites
bun test              # unit tests + rspress build-integration tests
bun run build         # tsup → dist/ (ESM+CJS, d.ts, css)
bun run test:publish  # asserts every exports entry resolves from dist/ (after build)
bun run test:e2e      # playwright against doc_build/
```

Releases are cut by semantic-release (`bun run release`): versions and released
CHANGELOG sections are generated from Conventional Commits, so do not hand-edit
released sections. npm provenance attestations are only produced when publishing
from GitHub Actions with `id-token: write`; the local release flow publishes
without them.

## Publishing vault content

Vault notes go through the same Markdown pipeline as any Rspress docs page, so
raw HTML in a note reaches the published page as HTML — exactly as Rspress
behaves for `docs/**/*.md`. Treat the vault as trusted input: it is your own
content, and anything that can write to it can write to the published site.
Canvas diagrams are the one sink the plugin owns itself, and raw HTML there is
escaped and URL-scheme-checked before insertion. Mermaid diagrams inside a
canvas board always render at `securityLevel: "strict"`; `mermaidSecurityLevel`
configures the Markdown pipeline only.

## License

MIT — see [LICENSE](./LICENSE).
