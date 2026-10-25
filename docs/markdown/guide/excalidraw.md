---
title: Excalidraw
description: Draw Excalidraw plugin drawings, plain .excalidraw files, embeds and crops as static SVG when the site is built, with Excalidraw's own hand-drawn strokes.
---

# Excalidraw

Drawings made with the
[Excalidraw plugin](https://github.com/zsviczian/obsidian-excalidraw-plugin)
publish as pictures. With `enableExcalidraw`, each one is drawn when the site
is built as static SVG: no client script, no canvas. The strokes come from
roughjs with each element's own seed and Excalidraw's option mapping, so a
rectangle wobbles exactly as it does in Obsidian.

A picture cannot do everything the editor does; [Limitations](#limitations)
lists what is drawn differently, and the
[compatibility table](/obsidian-compatibility#plugin-ecosystem) sums it up.
This drawing from the demo vault is rendered on this page:

![[Plugins/Excalidraw/Excalidraw Showcase.excalidraw]]

## Enable it

```ts
markdown({
  vaultRoot: "./vault",
  enableExcalidraw: true,
  enableDefaultStyles: true, // or import "rspress-plugin-obsidian/markdown/styles.css"
});
```

Drawings render without the optional peer `@excalidraw/excalidraw`, but
install it to publish Excalidraw's own fonts and to measure text the way the
editor does ([Fonts](#fonts)):

```bash
npm install @excalidraw/excalidraw
```

`enableExcalidraw` and the `excalidraw` object are listed with every other
option in the [API reference](./api.md#obsidian-plugins); the keys of `excalidraw` are
documented [below](#options).

## Options

With `readVaultSettings` on, the vault's Excalidraw settings,
`.obsidian/plugins/obsidian-excalidraw-plugin/data.json`, fill in what the
site config leaves unset. A drawing's frontmatter then overrides the result
for that drawing (see the table below).

| Option | Vault setting | Default | Meaning |
|---|---|---|---|
| `theme` | `previewMatchObsidianTheme` (→ `"auto"`), `exportWithTheme: false` (→ `"light"`) | `"scene"` | `"scene"`: the drawing's own theme. `"light"` / `"dark"`: always that theme. `"auto"`: follow the site's light/dark switch. |
| `preferExportedImage` | `displayExportedImageIfAvailable` | `false` | Show the image the plugin auto-exported next to the drawing instead of drawing the scene. |
| `padding` | `exportPaddingSVG` | `10` | Space around the drawing, in pixels. |
| `background` | `exportWithBackground` | `true` | Paint the drawing's canvas colour behind it. |
| `embedWidth` | `width` | `400` | Width of an embed that names none, in pixels or any CSS length. |
| `fonts` | — | `true` | Serve Excalidraw's fonts when `@excalidraw/excalidraw` is installed. |
| `cjkFonts` | — | `false` | Also serve Xiaolai, the hand-drawn CJK font (about 12 MB). |
| `readVaultSettings` | — | `true` | Read the vault's `data.json` at all. |

The vault's `showLinkBrackets`, `linkPrefix` and `urlPrefix` are read too:
they decorate links shown in text elements, as in Obsidian.

| Drawing frontmatter | Effect |
|---|---|
| `excalidraw-export-dark` | Draws dark (`true`) or light (`false`), when `theme` is `"scene"`. |
| `excalidraw-export-transparent: true` | No background. |
| `excalidraw-export-padding` (or `excalidraw-export-svgpadding`) | Padding in pixels. |
| `excalidraw-link-brackets`, `excalidraw-link-prefix`, `excalidraw-url-prefix` | Link decoration in text elements. |

**Theme.** `"scene"` is how Obsidian shows a drawing with the plugin's
defaults: a drawing saved light stays light on a dark page. Use `"auto"` for
drawings that follow the site; dark is Excalidraw's own inversion, with photos
and PDF pages inverted back. `"auto"` needs the bundled stylesheet.

**Exported images.** `preferExportedImage` uses the images the plugin
auto-exports (`autoexportSVG` / `autoexportPNG`) next to the drawing: the
drawing's path with its last extension replaced by `.svg` (preferred) or
`.png`, so `Drawing.excalidraw.md` looks for `Drawing.excalidraw.svg`. A
`.light`/`.dark` pair follows the site theme when `theme` is `"auto"`, and
otherwise the variant matching the drawing's theme is used. It is off by
default, as in the plugin: an export is only as current as its last save in
Obsidian, and its links are not resolved against the site. A crop (`#^…`) and
an `excalidraw` code block always draw the scene.

## Publish a drawing

- **A drawing note**: a markdown note whose frontmatter has an
  `excalidraw-plugin` key, usually `Name.excalidraw.md`. `raw` shows text
  elements as written; any other value (normally `parsed`) is parsed mode. The
  scene is read from its `## Drawing` section, in a ```` ```json ```` or
  ```` ```compressed-json ```` fence, under `#` or `##`, with or without the
  `%%` around it. Its page shows the drawing, then the back of the note.
- **A plain `.excalidraw` JSON file** gets its own page, at its path with the
  extension kept: `/vault/Plain Drawing.excalidraw` for a vault file, and
  `[[Plain Drawing.excalidraw]]` links to it. If a note already holds that
  route, the file gets no page and the build prints a warning.
- **An ```` ```excalidraw ```` code block** holding scene JSON is drawn in
  place.

### The note's sections

- **Text Elements.** In parsed mode, the text written here (`^id` suffix) is
  what the element shows: `[[Note|alias]]` shows as `alias`, a markdown link
  as its label, and `![[Note#^block]]` (or a whole note, or `#heading`) as
  that text, wrapped to `{N}` characters when given. The element links to the
  first link it holds.
- **Element Links.** `id: [[Note]]` makes the element a link; it wins over a
  link in the element's text. Wikilinks resolve the way they do in notes,
  URLs with a scheme open in a new tab, and `/path` or `#anchor` links are
  kept as written.
- **Embedded Files.** `id: [[image.png]]` draws the vault image from its
  published URL, `id: https://…` a web image, and `id: $$…$$` a formula (with
  `enableMath`). `[[Note]]`, `[[Note#heading]]` or `[[Note#^block]]` draws that
  markdown inside the image's box, and `[[Other.excalidraw]]` draws that
  drawing. `[[file.pdf#page=3]]` shows that page in the browser's PDF viewer
  inside the box; the PDF is published with the site, and a browser that
  cannot show PDFs in place shows a link instead. Images stored inside the
  scene itself are drawn too.
- **Mermaid diagrams.** The plugin keeps a diagram it could not turn into
  shapes as an image holding the Mermaid source. With `enableMermaid` and the
  optional `mermaid` package installed, the site's Mermaid renderer draws it
  inside the image's box; otherwise the box shows the source, labelled, with a
  warning.
- **Back of the note.** The markdown above `# Excalidraw Data` renders below
  the picture, without the plugin's "Switch to EXCALIDRAW VIEW" banner.

### Embed and crop

| Syntax | Shows |
|---|---|
| `![[Drawing]]`, `![[Drawing.excalidraw]]` | the drawing, `embedWidth` wide |
| `![[Drawing.excalidraw\|300]]` | 300 px wide |
| `![[Drawing.excalidraw\|300x200]]` | 300 px wide, at least 200 px tall |
| `![[Drawing.excalidraw\|x150]]` | at most 150 px tall, with no set width |
| `![[Drawing.excalidraw\|300\|wide]]`, `![[Drawing.excalidraw\|wide]]` | the class `excalidraw-svg-wide` in place of `excalidraw-svg` |
| `#^id` | the whole drawing, cropped to that element |
| `#^group=id` | only the element's group |
| `#^area=id` | the elements overlapping that element, cropped to it |
| `#^frame=name-or-id` | the frame, its name and its children |
| `#^clippedframe=name-or-id` | the frame's children, clipped, with no outline |
| `…,padding=N` | the crop with `N` pixels of padding |

![[Plugins/Excalidraw/Plain Drawing.excalidraw|320]]

## Fonts

With `@excalidraw/excalidraw` installed, its font files are served with the
site under `/excalidraw-fonts/`: Excalifont, Virgil, Nunito, Lilita One,
Comic Shanns, Cascadia and Liberation Sans (and Xiaolai with `cjkFonts`).
Each picture declares only the families it uses, and each subset has the
`unicode-range` read from the font file itself.

Without the peer, or with `fonts: false`, text falls back to a system stack of
the same character: `Segoe Print`, `Bradley Hand` or `Comic Sans MS` for the
hand-drawn fonts, `Segoe UI` for Nunito, `Arial` for Helvetica and Liberation
Sans, `Cascadia Code` or `Consolas` for Cascadia, `Impact` for Lilita One. The
text keeps its layout, but glyph widths differ slightly.

### Re-wrapped text

When a text element shows something other than what the drawing laid out (a
link shown as its alias, a transclusion), it is laid out again the way the
plugin does on load: wrapped with Excalidraw's own `wrapText`, then placed in
its container or about its alignment. With the peer installed (even with
`fonts: false`), widths are read from its font files (advances, kerning, the
fonts' default ligatures and alternates) and match a browser's canvas
measurement; Helvetica is measured as Liberation Sans, its metric twin.
Without the peer, and for a character none of Excalidraw's fonts has, an
average character width per font stands in, so the wrap can differ from
Obsidian's.

## Output and styling

A drawing is an inline `<svg>`; an embed wraps it in
`span.internal-embed.excalidraw-embed` with the `excalidraw-embedded-img`
class, as the plugin does. The bundled stylesheet, shipped with
`enableDefaultStyles`, sizes embeds, styles the error, Mermaid and PDF boxes,
switches `theme: "auto"` drawings to dark, and shows only the matching image
of an exported light/dark pair.

## Errors

- A drawing that cannot be read (bad JSON, no `## Drawing` section, a scene
  that does not decompress) shows an error box in its place and is reported
  through [`onPluginError`](./api.md#diagnostics), whose default, `"error"`, fails the build. So is a
  corrupt drawing embedded in another.
- A link that resolves to nothing (in an element link, in text, or under
  Embedded Files), an image whose file is missing, and a crop naming no
  element or frame are reported through `onBrokenLink`. The element is drawn
  without its link, and a bad crop shows the whole drawing. An ambiguous link
  follows `onAmbiguousLink`.
- The cases in [Limitations](#limitations), Mermaid shown as source, and a
  drawing that embeds itself are warnings and never fail the build.

## Limitations

These cannot be reproduced in a static picture; each draws something close.

- **Other non-image files** under Embedded Files: Obsidian renders these at
  view time; a placeholder is drawn, with a warning.
- **PDF crops**: `[[file.pdf#page=2&rect=…]]` shows the whole page, with a
  warning, because a browser's PDF viewer cannot crop to a region.
- **Live web embeds**: an embeddable element is drawn the way Excalidraw
  exports it, as a box showing the link, which opens in a new tab.
- **Growing containers**: bound text that would grow its container in
  Excalidraw does not resize it.
