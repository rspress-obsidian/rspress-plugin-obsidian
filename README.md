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

More optional peers are needed only by the features that use them. Without
one, the site still builds, the feature falls back as described, and the build
says which package to install.

| Peer | Used for | Without it |
| --- | --- | --- |
| `mermaid` | `enableMermaid` diagrams, Mermaid in canvas cards and Excalidraw drawings | diagrams stay on the page as source |
| `mathjax-full` | `mathEngine: "mathjax"` | — (KaTeX is the default engine) |
| `@excalidraw/excalidraw` | Excalidraw's own fonts, and exact text measurement, in `enableExcalidraw` drawings | a fallback font stack and estimated text wrapping |
| `maplibre-gl` | interactive Bases map views | a table of the located notes |
| `lucide-static` | the icons Bases' `icon()` draws | the icon's name |

```bash
bun add mermaid                 # only for Mermaid diagrams
bun add mathjax-full            # only for mathEngine: "mathjax"
bun add @excalidraw/excalidraw  # only for Excalidraw's fonts and text metrics
bun add maplibre-gl             # only for Bases map views
bun add lucide-static           # only for Bases icon()
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
| Markdown | `markdown` | wikilinks, embeds, callouts, backlinks, transclusion, media embeds, tags + tag pages, daily notes, Dataview, Tasks, Kanban, Excalidraw, Bases, Templater, math, Mermaid — see below | `rspress-plugin-obsidian/markdown/styles.css` |
| Canvas | `canvas` | `.canvas` boards as interactive pages, with an in-browser editor | `rspress-plugin-obsidian/canvas/styles.css` |
| Graph view | `graphview` | the interactive link graph, local and global | `rspress-plugin-obsidian/styles.css` (aggregate) |

## What `markdown()` turns on

Always on: `[[wikilinks]]`, `![[embeds]]`, `#heading` and `#^block` anchors,
`==highlights==`, `%%comments%%`, `[^1]` and `^[…]` footnotes, frontmatter.
On by default: `[text](Note.md)` links, case-insensitive lookup, and — in vault
notes — Obsidian's soft line breaks (a single newline is a `<br>`;
`strictLineBreaks: true` turns that off, `false` extends it to docs pages).
Attachments are published only when a published page references them.

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
| `enableDataview` | DQL blocks (`TABLE`/`LIST`/`TASK`/`CALENDAR`), DataviewJS, and inline `` `= expr` `` / `` `$= expr` `` queries, as Dataview writes them |
| `enableMath` | `$inline$` and `$$display$$` via KaTeX, or MathJax with `mathEngine` |
| `enableMermaid` | ` ```mermaid ` fences drawn in the browser (needs the optional `mermaid` package) |
| `enableTasks` | ` ```tasks ` queries over every published task, with the Tasks plugin's filters, sorting, grouping, layout and markup |
| `enableKanban` | notes saved by the Kanban plugin publish as read-only boards (board, list and table views) |
| `enableExcalidraw` | Excalidraw drawings — `.excalidraw.md` notes, plain `.excalidraw` files, `![[Drawing]]` embeds and crops — as static hand-drawn SVG |
| `enableBases` | `.base` files as pages, `![[x.base]]` embeds and ` ```base ` blocks: filters, formulas, table/cards/list/kanban views |
| `enableTemplater` | Templater templates applied to empty daily, folder and regex-matched notes, `<%+ %>` dynamic commands; the templates folder stays private |
| `enableDefaultStyles` | injects the stylesheet the above need to be visible |

`enableCallouts`, `enableBacklinks`, `enableTagPages` and the Kanban, Bases
and Tasks layouts emit markup but no rules, so they need `enableDefaultStyles`
(or the stylesheet imported by hand) before any of it shows. The five plugin
features read the vault's own plugin settings
(`.obsidian/plugins/<id>/data.json`); a `tasks`/`kanban`/`excalidraw`/`bases`/
`templater` option object overrides them — each guide lists its keys.
`onBrokenLink` defaults to `"error"`, so an unresolvable `[[wikilink]]` fails
the build — that is the diagnostic working, not a bug. `onAmbiguousLink`
defaults to `"warn"`. `onPluginError` (default `"error"`) fails the build for a
plugin block that will not render, which is also shown in place.

## Documentation

- [Getting started](https://github.com/rspress-obsidian/rspress-plugin-obsidian/blob/main/docs/getting-started.md)
- [Live examples](https://github.com/rspress-obsidian/rspress-plugin-obsidian/blob/main/docs/markdown/guide/examples.md) — every feature, rendered by this plugin
- Plugin guides: [Tasks](https://github.com/rspress-obsidian/rspress-plugin-obsidian/blob/main/docs/markdown/guide/tasks.md), [Kanban](https://github.com/rspress-obsidian/rspress-plugin-obsidian/blob/main/docs/markdown/guide/kanban.md), [Excalidraw](https://github.com/rspress-obsidian/rspress-plugin-obsidian/blob/main/docs/markdown/guide/excalidraw.md), [Bases](https://github.com/rspress-obsidian/rspress-plugin-obsidian/blob/main/docs/markdown/guide/bases.md), [Templater](https://github.com/rspress-obsidian/rspress-plugin-obsidian/blob/main/docs/markdown/guide/templater.md)
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

Contributors need **Bun ≥ 1.4** (`packageManager` pins the exact version CI
uses): the committed `bun.lock` is a v2 lockfile that older Bun cannot read.

```bash
bun install
bun run typecheck
bun test               # unit tests only
bun run test:coverage  # the same suite under the coverage gate CI enforces
bun run build          # tsup → dist/ (ESM+CJS, d.ts/d.cts, css)
bun run test:publish   # packs the tarball and checks every exports entry (after build)
bun run test:types     # publint + attw against the packed tarball (after build)
bun run test:doc-examples  # type-checks the configs the docs tell you to copy (after build)
bun run docs:build     # required before the build-integration and e2e suites
RUN_DOCS_BUILD_TESTS=1 bun test test/markdown/integration.test.ts  # asserts the docs build
bun run test:e2e       # playwright against doc_build/
```

CI also installs the packed tarball into the minimal site in
`test/consumer-site/`, builds it with `rspress build`, with and without
`mermaid`, and smoke-checks the output.

## Releases

Releases are cut by semantic-release from Conventional Commits on `main`
(`fix:` → patch, `feat:` → minor, `BREAKING CHANGE:` → major). The version is
not kept in git: `package.json` holds the `0.0.0-development` placeholder that
semantic-release recommends, and the released version lives in the git tag, the
npm registry and `CHANGELOG.md`. The first release is `1.0.0`. Release sections
in `CHANGELOG.md` are generated, so describe a change in its commit message
rather than editing the file.

The Release workflow runs only after CI passes for a push to `main`, and only
for the commit that CI verified. A read-only job repeats lint, typecheck, build,
the coverage gate, the packed-tarball and type checks and the doc-example check,
then packs the tarball. A second job holds the write and OIDC tokens and runs no
project code. It stamps the computed version into the unpacked tarball, pushes
the CHANGELOG commit and the tag, and publishes those files through npm trusted
publishing, with provenance.

## License

MIT — see [LICENSE](./LICENSE).
