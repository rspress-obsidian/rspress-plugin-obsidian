# rspress-plugin-obsidian

Publish an Obsidian vault as an Rspress site. Three feature plugins behind one
entry, and a matrix saying exactly what is and is not supported.

> **This is a publishing subset, not Obsidian.** It renders the Markdown
> dialect, the `.canvas` format, and a link graph. There is no plugin API, no
> `.obsidian/` configuration, and no live preview — publishing is a build-time
> transform. Per-feature status, including everything deliberately left out, is
> itemised in [Obsidian compatibility](https://github.com/rspress-obsidian/rspress-plugin-obsidian/blob/main/docs/obsidian-compatibility.md).

## Install

```bash
bun add rspress-plugin-obsidian
# or: npm install rspress-plugin-obsidian
```

Requires **Node.js ≥ 22.14.0** and **Rspress `^2.0.21`**.

`graphview()` renders through `react-force-graph-2d`, which is an optional peer
and so is *not* installed for you — without it the build fails at bundle time,
before any runtime fallback can run:

```bash
bun add react-force-graph-2d
```

## Use

```ts
// rspress.config.ts
import path from "node:path";
import { defineConfig } from "@rspress/core";
import { markdown, canvas, graphview } from "rspress-plugin-obsidian";

const vaultRoot = path.join(import.meta.dirname, "Obsidian Vault");

export default defineConfig({
  root: path.join(import.meta.dirname, "docs"),
  plugins: [
    markdown({
      // Publish this vault's notes alongside your docs. Omit `vaultRoot` and
      // only `root` is published.
      vaultRoot,
      vaultRoutePrefix: "/vault",

      enableCallouts: true,
      enableBacklinks: true,
      enableDefaultStyles: true, // the stylesheet the above two need
    }),
    canvas({
      vaultRoot,
      routePrefix: "/canvas",
      // Must match `vaultRoutePrefix` above. Without it a canvas file card
      // links to `/Note`, which the vault build never publishes.
      fileRoutePrefix: "/vault",
    }),
    graphview(),
  ],
});
```

`pluginObsidian((markdown, canvas, graphview) => [...])` composes the same three
in one call — the form this repository's own `rspress.config.ts` uses — and each
feature is importable on its own.

## The three features

| Feature | Export | What you get | Stylesheet |
| --- | --- | --- | --- |
| Markdown | `markdown` | wikilinks, embeds, callouts, backlinks, transclusion, media embeds, tags + tag pages, daily notes, Dataview, math, Mermaid — see below | `rspress-plugin-obsidian/markdown/styles.css` |
| Canvas | `canvas` | `.canvas` boards as interactive pages, with an in-browser editor | `rspress-plugin-obsidian/canvas/styles.css` |
| Graph view | `graphview` | the interactive link graph, local and global | `rspress-plugin-obsidian/styles.css` (aggregate) |

## What `markdown()` turns on

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
| `enableTagLinking` | `#tag` becomes a link to its generated `/tags/<tag>` page |
| `enableTagPages` | generates those `/tags/<tag>` pages |
| `enableDailyNotes` | date-filed notes, `{{date}}` tokens, prev/next navigation |
| `enableDataview` | DQL blocks (`TABLE`/`LIST`/`TASK`/`CALENDAR`) and inline `= expr` |
| `enableMath` | `$inline$` and `$$display$$` via KaTeX, or MathJax with `mathEngine` |
| `enableMermaid` | ` ```mermaid ` fences drawn in the browser |
| `enableDefaultStyles` | injects the stylesheet the above need to be visible |

`enableCallouts`, `enableBacklinks` and `enableTagPages` emit markup but no
rules, so they need `enableDefaultStyles` (or the stylesheet imported by hand)
before any of it shows. `onBrokenLink` and `onAmbiguousLink` default to
`"error"`, so an unresolvable `[[wikilink]]` fails the build — that is the
diagnostic working, not a bug.

## Documentation

- [Getting started](https://github.com/rspress-obsidian/rspress-plugin-obsidian/blob/main/docs/getting-started.md)
- [Live examples](https://github.com/rspress-obsidian/rspress-plugin-obsidian/blob/main/docs/markdown/guide/examples.md) — every feature, rendered by this plugin
- [Obsidian compatibility](https://github.com/rspress-obsidian/rspress-plugin-obsidian/blob/main/docs/obsidian-compatibility.md) — the per-feature support matrix

The documentation site is built by this plugin with every feature enabled, so
its vault pages, tag pages, demo boards and floating graph panel are the
plugin's own output.

## Vault content is trusted input

Vault notes go through the same Markdown pipeline as any Rspress docs page, so
raw HTML in a note reaches the published page as HTML — exactly as Rspress
behaves for `docs/**/*.md`. Treat the vault as trusted input: it is your own
content, and anything that can write to it can write to the published site.

Canvas diagrams are the one sink the plugin owns itself, and raw HTML there is
escaped and URL-scheme-checked before insertion. Mermaid diagrams inside a
canvas board always render at `securityLevel: "strict"`; `mermaidSecurityLevel`
configures the Markdown pipeline only.

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
bun run docs:build     # required before the build-integration and e2e suites
bun test               # unit tests + rspress build-integration tests
bun run test:doc-examples  # type-checks the configs the docs tell you to copy
bun run build          # tsup → dist/ (ESM+CJS, d.ts, css)
bun run test:publish   # asserts every exports entry resolves from dist/ (after build)
bun run test:e2e       # playwright against doc_build/
```

Releases are cut by semantic-release (`bun run release`): versions and released
CHANGELOG sections are generated from Conventional Commits, so do not hand-edit
released sections. npm provenance attestations are only produced when publishing
from GitHub Actions with `id-token: write`; the local release flow publishes
without them.

## License

MIT — see [LICENSE](./LICENSE).
