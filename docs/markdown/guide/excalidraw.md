---
description: Excalidraw drawings from an Obsidian vault — drawing notes, plain .excalidraw files, embeds and crops — drawn at build time as static SVG with Excalidraw's own hand-drawn strokes.
---

# Excalidraw

Enable with `enableExcalidraw: true`.

Drawings made with the [Excalidraw plugin](https://github.com/zsviczian/obsidian-excalidraw-plugin)
publish as pictures. Each one is drawn at build time as static SVG: no client
script, no canvas. The strokes come from roughjs with each element's own seed
and Excalidraw's option mapping, so a rectangle wobbles exactly as it does in
Obsidian.

![[Plugins/Excalidraw/Excalidraw Showcase.excalidraw]]

## What is a drawing

- A markdown note whose frontmatter has `excalidraw-plugin: parsed` or `raw`.
  This is usually `Name.excalidraw.md`. The scene is read from its `## Drawing`
  section, in a ```` ```json ```` or ```` ```compressed-json ```` fence, under
  `#` or `##`, with or without the `%%` around it.
- A plain `.excalidraw` JSON file. Each one gets its own page under the vault
  prefix, for example `/vault/Plain Drawing.excalidraw`, and
  `[[Plain Drawing.excalidraw]]` links to that page.
- A ```` ```excalidraw ```` fence holding scene JSON is drawn in place.

## The note's sections

- **Text Elements.** In `parsed` mode, the text written here (` ^id` suffix)
  is what the element shows. `[[Note|alias]]` shows as `alias`, a markdown
  link shows as its label, and `![[Note#^block]]` shows the block's text. The
  element links to the first link it holds. In `raw` mode the text is shown as
  written.
- **Element Links.** `id: [[Note]]` makes the element a link. URLs open in a
  new tab, and wikilinks resolve the way they do in notes. An unresolved link
  is reported through `onBrokenLink`, and the element is shown unlinked.
- **Embedded Files.** `id: [[image.png]]` draws the vault image from its
  published URL. `id: https://…` draws a web image, and `id: $$…$$` draws a
  formula. `[[Note]]` draws the note's markdown inside the image's box, and
  `[[Other.excalidraw]]` draws that drawing. `[[file.pdf#page=3]]` shows that
  page of the PDF in the browser's PDF viewer, inside the image's box. The PDF
  is published with the site, and a browser that cannot show PDFs in place
  shows a link to the page instead.
- **Mermaid diagrams.** The plugin keeps a diagram it could not turn into
  shapes as an image holding the Mermaid source. With `enableMermaid` on and
  the optional `mermaid` package installed, the site's Mermaid renderer draws
  it inside the image's box. Otherwise the box shows the source, labelled, and
  the build reports a warning.
- **Back of the note.** The markdown above `# Excalidraw Data` renders below
  the picture.

## Embeds

| Syntax | Shows |
|---|---|
| `![[Drawing]]`, `![[Drawing.excalidraw]]` | the drawing, `embedWidth` wide (400px by default) |
| `![[Drawing.excalidraw\|300]]`, `\|300x200`, `\|x150` | that width and/or height |
| `![[Drawing.excalidraw\|300\|style]]` | adds the class `excalidraw-svg-style` |
| `#^id` | the whole drawing, cropped to that element |
| `#^group=id` | only the element's group |
| `#^area=id` | the elements overlapping that element, cropped to it |
| `#^frame=name-or-id` | the frame, its name and its children |
| `#^clippedframe=name-or-id` | the frame's children, clipped, with no outline |
| `…,padding=N` | the crop with `N` pixels of padding |

![[Plugins/Excalidraw/Plain Drawing.excalidraw|320]]

## Options

```ts
markdown({
  enableExcalidraw: true,
  excalidraw: {
    theme: "auto",              // "scene" | "light" | "dark" | "auto"
    preferExportedImage: false, // show Drawing.excalidraw.svg/.png when it exists
    padding: 10,
    background: true,
    embedWidth: 400,
    fonts: true,                // serve Excalidraw's fonts when installed
    cjkFonts: false,            // also serve Xiaolai (about 12 MB)
    readVaultSettings: true,
  },
});
```

When `readVaultSettings` is on, these settings are read from the vault's
`.obsidian/plugins/obsidian-excalidraw-plugin/data.json`. Options set in the
site config win. The vault settings used are `previewMatchObsidianTheme`,
`exportWithTheme`, `displayExportedImageIfAvailable`, `exportPaddingSVG`,
`exportWithBackground`, `width`, `showLinkBrackets`, `linkPrefix` and
`urlPrefix`. A drawing's frontmatter wins over both:
`excalidraw-export-dark`, `excalidraw-export-transparent`,
`excalidraw-export-padding`, `excalidraw-link-prefix`, `excalidraw-url-prefix`
and `excalidraw-link-brackets`.

- **`theme`.** `"scene"` uses the drawing's own theme. `"auto"` follows the
  site's light/dark switch. Dark is Excalidraw's own inversion, with photos
  and PDF pages inverted back. Without vault settings the default is
  `"scene"`, which is how Obsidian shows a drawing with the plugin's defaults
  (`previewMatchObsidianTheme: false`, `exportWithTheme: true`): a drawing
  saved light stays light on a dark page. Set `theme: "auto"` (or the
  vault's `previewMatchObsidianTheme`) for drawings that follow the site.
- **`preferExportedImage`.** This uses the images the plugin auto-exports
  (`autoexportSVG` / `autoexportPNG`) next to the drawing. They are found by
  the plugin's file naming: `Drawing.excalidraw.svg`, `.png`, and
  `.light`/`.dark` pairs, which follow the site theme. It is off by default,
  as it is in the plugin, for two reasons. An export is only as current as its
  last save in Obsidian, and its links are not resolved against the site. A
  crop (`#^…`) always draws the scene.

## Fonts

When the optional peer `@excalidraw/excalidraw` is installed, its font files
are served with the site under `/excalidraw-fonts/`. These are Excalifont,
Virgil, Nunito, Lilita One, Comic Shanns, Cascadia and Liberation Sans. Each
picture declares only the families it uses, and each subset has the
`unicode-range` read from the font file itself.

Without the peer, or with `fonts: false`, text falls back to a system stack
of the same character:

- hand-drawn: `Segoe Print`, `Bradley Hand`, `Comic Sans MS`
- sans: `Segoe UI`, `Arial`
- monospace: `Cascadia Code`, `Consolas`

The text keeps its layout, but glyph widths differ slightly.

## Re-wrapped text

When a text element shows something other than what the drawing laid out (a
link shown as its alias, a transclusion), it is laid out again the way the
plugin does on load: wrapped with Excalidraw's own `wrapText`, then placed in
its container or about its alignment. With the peer installed, the widths
are read from its font files (advances, kerning and the fonts' default
ligatures and alternates), and match a browser's canvas measurement. Helvetica
is measured as Liberation Sans, its metric twin. Without the peer, and for a
character none of Excalidraw's fonts has, an average character width per font
stands in, so the wrap can differ from Obsidian's.

## Limits

These cannot be reproduced in a static picture. Each draws something close,
and the build reports a warning.

- **Other non-image files** under Embedded Files. Obsidian renders these at
  view time; a placeholder is drawn.
- **PDF crops.** `[[file.pdf#page=2&rect=…]]` shows the whole page: a
  browser's PDF viewer cannot crop to a region.
- **Live web embeds.** An embeddable element is drawn the way Excalidraw
  exports it: a box showing the link, which opens in a new tab.
