---
title: Advanced
description: Publishing an external vault, math with KaTeX or MathJax, Mermaid diagrams, styles, line breaks, build diagnostics, security, troubleshooting and large vaults.
---

# Advanced

This page covers what you need once the basics work: how a vault is published
next to your docs, math and diagrams, loading the styles yourself, what each
diagnostic reports, what the plugin does for safety, and how to fix common
problems. Each option on this page is listed with its type and default in the
[API Reference](./api.md#options).

## Publishing a vault

With `vaultRoot` set, every `.md` and `.mdx` note in the vault is published
under `vaultRoutePrefix` (`/vault` by default), and every feature applies to it.
A route keeps the file's case and spaces, and drops the extension and a trailing
`index`: `Notes/Setup Guide.md` publishes at `/vault/Notes/Setup Guide`.

```ts
markdown({
  vaultRoot: "./Obsidian Vault",
  vaultRoutePrefix: "/vault",
});
```

**Two trees, one site.** The vault and `docs/` are indexed separately. Each
page resolves links in its own tree first, so a vault note's `[[Setup]]` finds
the vault's `Setup.md` even if `docs/` has one too. A link with no match in its
own tree tries the other tree, so docs pages and vault notes can link to each
other, and backlinks work in both directions.

**What is skipped.** The plugin never reads dotfiles or dot-folders
(`.obsidian/`, `.trash/`), `node_modules`, or paths that start with `_`.
Symlinks inside the vault are not followed. Notes with `publish: false` are
left out, along with any attachment that only they use.

**Attachments.** An attachment is published only when a published note
references it, through an embed, a link, a Markdown image or a frontmatter
property. It is served at `<vaultRoutePrefix>/<path in the vault>`. Attachments
are staged in `node_modules/.rspress-plugin-obsidian/` and served from there in
dev and in builds, so nothing is written into `docs/`. Older versions copied
every vault file to `docs/public/<vaultRoutePrefix>/`. If that folder is still
there, delete it; the build warns about it.

**Symlinked vaults.** `vaultRoot` can be a symlink or sit under one, for
example a `vault` link in your repo that points to your real Obsidian folder.
Rspress compiles each note at its real path, and the plugin maps that path back
to the `vaultRoot` you configured.

**With Canvas.** Set Canvas's `fileRoutePrefix` to the same value as
`vaultRoutePrefix`, so that a file card on a board links to `/vault/Note` and
not `/Note`. See [Canvas configuration](/canvas/guide/configuration).

## Math

[`enableMath`](./api.md#features) renders `$inline$` and `$$display$$` math at
build time:

```ts
markdown({ enableMath: true });
```

| You write | Renders as |
|-----------|------------|
| `$E = mc^2$` | An inline formula |
| `$$ … $$` | A display formula, which can span lines |

Delimiters follow Obsidian's rules. Inline math cannot start or end with a
space or contain a newline, so `$5 and $10` stays prose. Code blocks, inline
code and raw HTML are never touched. Malformed TeX renders as the engine's own
inline error instead of failing the build.

### KaTeX (default)

KaTeX renders the math to HTML at build time. The plugin publishes KaTeX's
stylesheet and fonts with the site, under `obsidian-katex/<katex version>/`.
Only pages that show math link the stylesheet from their `<head>`, counting
math in embedded notes. Pages without math never download it. A page opened by
client-side navigation waits for the stylesheet before it shows, so formulas
never flash unstyled. You never import KaTeX's CSS yourself;
`rspress-plugin-obsidian/markdown/katex.css` is there only for a theme that
renders KaTeX markup of its own.

### MathJax

KaTeX is fast and covers most notes, but some TeX only MathJax understands.
MathJax is the engine Obsidian uses. To switch, install the optional
`mathjax-full` package (about 40 MB) and set `mathEngine`:

```bash
npm install mathjax-full
```

```ts
markdown({ enableMath: true, mathEngine: "mathjax" });
```

Without the package, the build fails with an install instruction instead of
falling back to KaTeX. MathJax generates its stylesheet while it renders, and
the plugin inlines that stylesheet in each page with math. MathJax loads its
web fonts from its default CDN, and no KaTeX stylesheet is loaded.

## Mermaid diagrams

[`enableMermaid`](./api.md#features) draws ` ```mermaid ` code blocks as
diagrams. Install the optional `mermaid` package first:

```bash
npm install mermaid
```

```ts
markdown({ enableMermaid: true });
```

Mermaid 11 and 12 both work (the peer range is `^11.17.2 || ^12.2.0`).
Mermaid 12 lays out flowchart, state, class and ER diagrams with ELK by
default; a diagram that should keep Mermaid 11's layout sets `layout: dagre` in
its `config` front matter. The theme stays Mermaid's `default`, or `dark` on a
dark page, under either major.

Mermaid needs a browser, so the build leaves a placeholder and a client
component draws the diagram after the page loads and after each navigation. The
same package draws Mermaid blocks in canvas text cards.

- **Without the package**, the site still builds. The build prints one install
  hint, and each diagram stays on the page as its source, marked
  `.obsidian-mermaid-error` and `data-mermaid-unavailable`, with the hint as its
  tooltip.
- **A diagram that fails to parse** keeps its source on the page with the
  `.obsidian-mermaid-error` marker. Nothing else is added to the page.
- **Security level.** Diagrams render with Mermaid's `securityLevel: "strict"`
  by default, which sanitizes the SVG and removes unsafe link URLs: a `click`
  with a `javascript:` URL is dropped. `mermaidSecurityLevel` accepts
  `"loose"`, `"antiscript"` or `"sandbox"` to allow what a strict build
  refuses, which means trusting every diagram in the vault. It applies to
  diagrams in notes. Diagrams in canvas cards always render `"strict"`,
  including a board embedded in a note whose diagrams use a looser level.

## Styles

The plugin's renderers emit HTML classes, not styles. Callouts, backlinks, tag
pages, transclusion frames, embeds and the Tasks, Kanban and Bases layouts all
need the bundled stylesheet. The stylesheet uses Rspress's theme variables
(`--rp-c-brand`, `--rp-c-bg-soft`, …), so it follows light and dark mode.
Footnotes are left unstyled on purpose.

The simple way to load it is `enableDefaultStyles: true`, which adds it through
Rspress's `globalStyles`. To control the load order, turn that off and point
`globalStyles` at the file yourself:

```ts
// rspress.config.ts
import path from "node:path";
import { createRequire } from "node:module";
import { defineConfig } from "@rspress/core";
import { markdown } from "rspress-plugin-obsidian";

const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve("rspress-plugin-obsidian/package.json"));

export default defineConfig({
  globalStyles: path.join(pkgDir, "dist/markdown.css"),
  plugins: [markdown({ enableDefaultStyles: false })],
});
```

Do not `import` the CSS in `rspress.config.ts`. Rspress loads the config with
Node, not the bundler, so a `.css` import fails with `ERR_UNKNOWN_FILE_EXTENSION`
or `ERR_PACKAGE_PATH_NOT_EXPORTED` before the build starts, with or without
`?url`. From a CSS file of your own, which the bundler does process, `@import`
works:

```css
@import "rspress-plugin-obsidian/markdown/styles.css";
```

## Line breaks

In Obsidian, with "Strict line breaks" off (its default), a single newline
inside a paragraph shows as a line break. CommonMark joins the lines instead.
`strictLineBreaks` picks the behaviour:

| `strictLineBreaks` | Vault notes | Pages in `docs/` |
|--------------------|-------------|------------------|
| unset (default) | Line break, as in Obsidian | Joined, as Rspress renders them |
| `false` | Line break | Line break |
| `true` | Joined | Joined |

## Diagnostics

The plugin reports problems while it builds. Each kind of problem has its own
option, which is `"error"` (fail the build) or `"warn"` (print a warning and
keep building):

| Option | Default | Reports |
|--------|---------|---------|
| `onBrokenLink` | `"error"` | A link or embed whose note, heading, block or image does not exist |
| `onAmbiguousLink` | `"warn"` | A name that several files share |
| `onDataviewError` | `"error"` | A Dataview query that does not parse or evaluate |
| `onUnsupportedBlock` | `"warn"` | A plugin's code block while that plugin is off |
| `onPluginError` | `"error"` | A Tasks, Kanban, Excalidraw, Bases or Templater block that cannot render |

**Broken links.** The message names the page and the link. For a missing
heading or block, it lists the headings or blocks that exist. With `"warn"`, the
link renders as its text in `<span class="obsidian-unresolved">`, with the
reason as a tooltip. A relative `.md` link is checked by the plugin, while an
absolute route such as `/typo` is still checked by Rspress. See
[Markdown links](./link-resolution.md#markdown-links).

**Ambiguous links.** The link always resolves as Obsidian would resolve it: the
match in the linking note's folder, then the shortest path, then the first
alphabetically. The warning names the chosen file and the alternatives. Earlier
versions defaulted to `"error"`. Set `onAmbiguousLink: "error"` to keep
requiring a path-qualified link.

**Dataview.** With `"warn"`, a query that fails is reported and left on the
page as code.

**Unsupported blocks.** A `tasks`, `base`, `excalidraw`, `dataview` or
`dataviewjs` block whose feature is off stays on the page as code. The message
names the option that turns the feature on.

**Plugin blocks.** The plugin shows the problem where the block would have
rendered, whichever mode you choose, so the build only decides whether it
fails. Things a static site cannot do, such as `tp.system.prompt`, are always
warnings.

**Unexpected errors.** If the plugin itself fails on a page, the build prints a
warning with the error and its stack, and keeps going; that page may miss part
of the plugin's rendering. A page that also has an `"error"`-mode problem, such
as a broken link, still fails the build, and the failure lists the unexpected
error too.

**A first build of a real vault** usually reports many broken links at once.
To list them all in one run, start with warnings:

```ts
markdown({
  vaultRoot: "./Obsidian Vault",
  onBrokenLink: "warn",
});
```

Fix the links, then remove the override, so that a link broken later fails the
build. If Graph View is also on, set its `onUnresolvedLink: "ignore"` so that
each broken link is reported once.

## Security

- **No vault code runs.** DataviewJS and Templater commands run in restricted
  interpreters, never as JavaScript, with no way to reach host APIs such as
  `process`, `require`, `fetch` or `eval`. See
  [DataviewJS](./dataview.md#dataviewjs) and [Templater](./templater.md).
- **Mermaid** sanitizes diagrams unless you lower `mermaidSecurityLevel`.
- **Web embeds.** YouTube and X frames are built from a validated id and
  sandboxed to what the player needs. PDF frames are not sandboxed, because
  Chromium's viewer breaks in a sandbox. They load only files from your own
  site; a PDF on another site renders as a link. Canvas link previews run in a
  sandbox without `allow-same-origin` unless you add it to `iframeSandbox`.
- **Private files stay private.** Dotfiles, dot-folders, `publish: false`
  notes and attachments that only those notes use are never published; a
  canvas file card that names one publishes neither its text nor its path.
  `%%comments%%` are removed from the page, its outline and the search index,
  and `%%comments%%` and `<!-- comments -->` from canvas text cards and the
  notes canvas cards show.

## Troubleshooting

### Callouts render as plain blockquotes

Set `enableCallouts: true`. Wikilinks, embeds, highlights, comments, footnotes
and Markdown links are always on. Every other feature is opt-in; the
[overview](/markdown/) lists the options.

### Callouts, backlinks or embeds have no styling

Set `enableDefaultStyles: true`, or load the stylesheet yourself as shown under
[Styles](#styles).

### "Heading not found" for a heading that exists

Heading links ignore case but are otherwise exact. A prefix or a single word
does not match, and punctuation counts. Compare your link with the headings that
the message lists. A heading with `:` is linked with a space in its place:
`[[Note#Step 1 Setup]]`.

### `![[image.png]]` renders as a link

Either `enableMediaEmbeds` is off, or the file was not found. The build warning
names the file. [How a file is found](./media-embeds.md#how-a-file-is-found)
lists where the plugin looks.

### Footnotes render as raw `[^1]`

A definition needs a colon after the label: `[^1]: The text.`

### `rspress dev` crashes when pages open quickly

Rspack 2.2.2 to at least 2.2.8 can crash the dev server when a new build starts
while the previous one is still finishing. The plugin holds back the rebuilds
that arrive in that window. If the crash still happens, set
`RSPRESS_LAZY_COMPILATION=false`.

## Large vaults

On a 3,000-note vault with every feature on, the plugin keeps about 57 MB in
memory: content indexes take 22 MB, the graph 12 MB, Bases data 12 MB and the
Tasks index 10 MB. The build's 3–4.6 GB peak comes from Rspress and Rspack
bundling the pages and writing their build cache. Plain Rspress peaks at about
3.1 GB on the same pages. Two settings help:

- `RSPRESS_PERSISTENT_CACHE=false` lowers the peak by about 0.4–0.8 GB, at the
  cost of slower warm rebuilds.
- A base that lists thousands of rows on one page is the most expensive single
  feature, because every row becomes compiled page code: two 3,000-row tables
  cost about 600 MB. Give such views a `limit`, or split them.

Report bugs at
[github.com/rspress-obsidian/rspress-plugin-obsidian/issues](https://github.com/rspress-obsidian/rspress-plugin-obsidian/issues).
The [CHANGELOG](https://github.com/rspress-obsidian/rspress-plugin-obsidian/blob/main/CHANGELOG.md)
lists changes by version.
