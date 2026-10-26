# rspress-plugin-obsidian

[![CI](https://github.com/rspress-obsidian/rspress-plugin-obsidian/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/rspress-obsidian/rspress-plugin-obsidian/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node.js ≥ 22.14](https://img.shields.io/badge/node-%E2%89%A5%2022.14-339933.svg)](https://nodejs.org)
[![Rspress 2](https://img.shields.io/badge/rspress-%5E2.0.21-ff6b35.svg)](https://rspress.rs)

Publish an Obsidian vault as an Rspress site. Three feature plugins behind one
entry, and a matrix saying exactly what is and is not supported.

- **Markdown:** `[[wikilinks]]`, embeds, callouts, backlinks, tags and tag
  pages, daily notes, math, Mermaid, and the Dataview, Tasks, Kanban,
  Excalidraw, Bases and Templater syntaxes, rendered at build time.
- **Canvas:** `.canvas` boards as interactive pages, with an in-browser editor.
- **Graph view:** the local and global link graph, plus Obsidian's page preview
  on hover.

> **This is a publishing subset, not Obsidian.** It renders the Markdown
> dialect, the `.canvas` format, and a link graph. There is no plugin API and no
> live preview — publishing is a build-time transform. Obsidian's app settings
> in `.obsidian/` are ignored; the supported plugins' own settings
> (`.obsidian/plugins/<id>/data.json`) and the property types Bases uses
> (`.obsidian/types.json`) are read. Per-feature status, including everything
> deliberately left out, is itemised in [Obsidian compatibility](https://github.com/rspress-obsidian/rspress-plugin-obsidian/blob/main/docs/obsidian-compatibility.md).

## Contents

- [Install](#install)
- [Use](#use)
- [The three features](#the-three-features)
- [What `markdown()` turns on](#what-markdown-turns-on)
- [Coming from `rspress-plugin-graph-view`](#coming-from-rspress-plugin-graph-view)
- [Documentation](#documentation)
- [Vault content is trusted input](#vault-content-is-trusted-input)
- [Development](#development)
- [Contributing](#contributing)
- [Releases](#releases)

## Install

```bash
bun add rspress-plugin-obsidian
# or: npm install rspress-plugin-obsidian
```

Requires **Node.js ≥ 22.14.0** and **Rspress `^2.0.21`**.

`graphview()` draws the graph with `react-force-graph-2d`, an optional peer that
is *not* installed for you. Without it the site still builds and the build says
which package to install, but the panel lists the pages instead of drawing the
graph:

```bash
bun add react-force-graph-2d
```

More optional peers are needed only by the features that use them. Without
one, the site still builds, the feature falls back as described, and the build
says which package to install. The one exception is `mathjax-full`: if you
choose that engine, the build stops until the package is installed.

| Peer | Used for | Without it |
| --- | --- | --- |
| `mermaid` | `enableMermaid` diagrams, Mermaid in canvas cards and Excalidraw drawings | diagrams stay on the page as source |
| `mathjax-full` | `mathEngine: "mathjax"` | the build stops with the install command (the default KaTeX engine needs nothing) |
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
import { pluginObsidian } from "rspress-plugin-obsidian";

export default defineConfig({
  root: path.join(import.meta.dirname, "docs"),
  plugins: pluginObsidian(
    {
      // Shared by every feature: publish this vault's notes under
      // `vaultRoutePrefix`, alongside your docs; canvas reads its boards from
      // it and links their cards to those notes. Omit `vaultRoot` and only
      // `root` is published.
      vaultRoot: path.join(import.meta.dirname, "Obsidian Vault"),
      vaultRoutePrefix: "/vault",
    },
    (markdown, canvas, graphview) => [
      markdown({
        enableCallouts: true,
        enableBacklinks: true,
        enableDefaultStyles: true, // the stylesheet the above two need
      }),
      canvas({ routePrefix: "/canvas" }),
      graphview(),
    ],
  ),
});
```

An option passed to a feature itself (`markdown({ vaultRoot })`) wins over the
shared one. Each feature is also importable on its own —
`plugins: [markdown({ vaultRoot }), graphview()]` — and the graph view and
canvas find the site's markdown plugin in any order; outside `pluginObsidian`,
give `canvas` the same `vaultRoot` and a `fileRoutePrefix` matching
`vaultRoutePrefix`. Helpers such as the content index and the wikilink resolver
come from `rspress-plugin-obsidian/markdown`.

## The three features

| Feature | Export | What you get | Stylesheet |
| --- | --- | --- | --- |
| Markdown | `markdown` | wikilinks, embeds, callouts, backlinks, transclusion, media embeds, tags + tag pages, daily notes, Dataview, Tasks, Kanban, Excalidraw, Bases, Templater, math, Mermaid — see below | `rspress-plugin-obsidian/markdown/styles.css` |
| Canvas | `canvas` | `.canvas` boards as interactive pages, with an in-browser editor | `rspress-plugin-obsidian/canvas/styles.css` |
| Graph view | `graphview` | the interactive link graph, local and global, and Obsidian's Page preview of linked notes on hover (`enableHoverPreviews`) | `rspress-plugin-obsidian/graph/styles.css` |

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
| `enableMath` | `$inline$` and `$$display$$` via KaTeX, or MathJax with `mathEngine`; only pages that show math load KaTeX's stylesheet |
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

With `enableMath`, KaTeX's stylesheet and fonts are published under
`obsidian-katex/<katex version>/` and linked from the `<head>` of each page
that shows KaTeX math, its own or an embedded note's. Pages without math never
download it, and you never import it yourself;
`rspress-plugin-obsidian/markdown/katex.css` remains for a theme that renders
KaTeX markup of its own.

## Coming from `rspress-plugin-graph-view`

`graphview()` replaces the standalone `rspress-plugin-graph-view` package, which
this one supersedes. `defaultOpen`, `profileBuild`, `colors` and the
`RSPRESS_GRAPH_VIEW_PROFILE=1` variable work as before (`colors` accepts every
key the old package documented, plus a few more).

```diff
-import { pluginGraphview } from "rspress-plugin-graph-view";
+import { graphview } from "rspress-plugin-obsidian";

-  plugins: [pluginGraphview()],
+  plugins: [graphview()],
```

- A custom theme's sidebar graph imports
  `rspress-plugin-obsidian/graph/runtime/GraphSidebar` instead of
  `rspress-plugin-graph-view/runtime/GraphSidebar`.
- The panel stylesheet is not injected unless you set `enableDefaultStyles: true`;
  otherwise import `rspress-plugin-obsidian/graph/styles.css`.
- Keep `react-force-graph-2d` installed, then remove `rspress-plugin-graph-view`.

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
canvas board, including a board embedded in a note, always render at
`securityLevel: "strict"`; `mermaidSecurityLevel` configures the diagrams in
notes only.

## Development

Contributors need **Bun ≥ 1.4** (`packageManager` pins the exact version CI
uses): the committed `bun.lock` is a v2 lockfile that older Bun cannot read.
Type checking runs on **TypeScript 7** (`tsc` from the `typescript` devDependency).

```bash
bun install
bun run typecheck
bun run lint           # Biome; `bun run lint:fix` applies safe fixes
bun test               # unit tests only
bun run test:coverage  # the same suite under the coverage gate CI enforces (minus test/publish, which test:publish runs)
bun run build          # tsup → dist/ (ESM+CJS, d.ts/d.cts, css)
bun run test:publish   # packs the tarball and checks every exports entry (after build)
bun run test:types     # publint against the package's exports and files (after build)
bun run test:doc-examples  # type-checks the configs the docs tell you to copy (after build)
bun run docs:build     # required before the build-integration and e2e suites
RUN_DOCS_BUILD_TESTS=1 bun test test/markdown/integration.test.ts  # asserts the docs build
bunx playwright install chromium  # once, before the first e2e run
bun run test:e2e       # playwright against doc_build/
```

CI runs the suite on Linux, macOS and Windows, loads the published entries
under Node 22.14 and 24, and runs e2e on Linux and macOS. It also installs the
packed tarball into the minimal site in `test/consumer-site/` and builds it with
`rspress build` against the oldest and newest supported Rspress, with and
without `mermaid`, and once without `react-force-graph-2d`, then smoke-checks the
output.

Source layout:

- `src/shared/` — primitives more than one feature needs, and nothing else; node-free
- `src/markdown/` — the `markdown()` feature: remark pipeline, content index, Dataview, backlinks
- `src/canvas/` — the `canvas()` feature: parser, renderer components, editor
- `src/graph/` — the `graphview()` feature: build-time extraction, runtime panel
- `test/` — unit (colocated `*.test.ts`) + e2e (playwright)
- `Obsidian Vault/` — shared demo fixture

## Contributing

Bug reports and feature requests go through the
[issue forms](https://github.com/rspress-obsidian/rspress-plugin-obsidian/issues/new/choose),
which ask for the plugin and Rspress versions and a minimal note that shows the
problem. Check the
[compatibility matrix](https://github.com/rspress-obsidian/rspress-plugin-obsidian/blob/main/docs/obsidian-compatibility.md)
first: what it lists as unsupported is a known boundary, not a bug.

Write commit messages as Conventional Commits (`fix:`, `feat:`, `perf:`, …),
since semantic-release reads them to pick the next version, and run
`bun run lint`, `bun run typecheck` and `bun test` before pushing. CI runs on
every pull request into `main` and `dev`.

## Releases

Releases are cut by semantic-release from Conventional Commits on `main`
(`fix:` and `perf:` → patch, `feat:` → minor, `BREAKING CHANGE:` → major). The
version is not kept in git: `package.json` holds the `0.0.0-development`
placeholder that semantic-release recommends, and the released version lives in
the git tag, the npm registry and `CHANGELOG.md`. The first release is `1.0.0`.
Release sections in `CHANGELOG.md` are generated, so describe a change in its
commit message rather than editing the file.

The Release workflow runs only after CI passes for a push to `main`, and only
for the commit that CI verified. A read-only job repeats lint, typecheck, build,
the coverage gate, the packed-tarball and type checks and the doc-example check,
then packs the tarball. A second job holds the write and OIDC tokens and runs no
project code. It stamps the computed version into the unpacked tarball, pushes
the CHANGELOG commit and the tag, and publishes those files through npm trusted
publishing, with provenance.

## License

MIT — see [LICENSE](./LICENSE).
