---
description: Live media embeds — every image, audio, video and PDF format Obsidian accepts, with sizing, PDF page and height subpaths, and the same renderer inside canvas text cards.
---

# Media Embeds

Every embed on this page is a real file in the demo vault, rendered by the
plugin. Nothing here is a screenshot of a plugin, and nothing is a code sample
in a fence: if a format is listed here, a browser on this page is playing it.

Enable with `enableMediaEmbeds: true`.

## Images

An image embed is a lazy `<img>`, sized with the pipe Obsidian documents:

![[media/gradient.png|420]]

![[media/gradient.png|300]]

![[media/gradient.png|300x180]]

A pipe that is not a bare dimension is caption text, not a size:

![[media/gradient.png|A gradient, unsized]]

Vector images work the same way, since `svg` is on Obsidian's list:

![[media/diagram.svg|320]]

## Sizing a Markdown Image

Obsidian lets a markdown image carry the same size, either as the alt on its own
or after a caption. Both are honoured:

![300](/vault/media/gradient.png)

![300x180](/vault/media/gradient.png)

![A caption, then a size|300](/vault/media/gradient.png)

## Audio

Each of these is a different encoding of the same one-second tone. The controls
are the browser's own:

![[media/tone.mp3]]

![[media/tone.ogg]]

![[media/tone.wav]]

![[media/tone.m4a]]

![[media/tone.flac]]

## Video

![[media/clip.mp4]]

![[media/clip.webm|320]]

## PDF

A PDF is embedded in a frame with a bar naming the file and an **Open** link that
opens the document on its own — the way out for a browser that cannot display a
PDF in place, and the way to a full-screen view when it can. The subpath is read
for two knobs. The page reaches the frame, so the browser opens there, and the bar
says which page it is on:

![[media/sample.pdf#page=2]]

The height is a property of the embed rather than a location the file is asked
for, so it becomes the frame's height and never travels into the URL:

![[media/sample.pdf#height=240]]

A PDF with neither is drawn in a 600px frame:

![[media/sample.pdf]]

## In a Canvas Card

A canvas text card renders attachments with the same renderer, from the same
table of formats — including both PDF knobs. Pan and zoom the board below; the
cards are ordinary text nodes.

![[Media.canvas]]

## Syntax

| Syntax | Result |
|--------|--------|
| `![[image.png]]` | Image, unsized |
| `![[image.png\|300]]` | Image at 300px wide |
| `![[image.png\|300x180]]` | Image at 300×180 |
| `![[image.png\|A caption]]` | Caption, no size |
| `![300](image.png)` | Markdown image, width 300 |
| `![300x180](image.png)` | Markdown image, width and height |
| `![A caption\|300](image.png)` | Markdown image, caption then width |
| `![[audio.mp3]]` | `<audio controls>` |
| `![[video.mp4]]` | `<video controls>` |
| `![[video.mp4\|320]]` | Video at 320px wide |
| `![[doc.pdf]]` | PDF in a 600px frame |
| `![[doc.pdf#page=3]]` | PDF opened at page 3 |
| `![[doc.pdf#height=400]]` | PDF in a 400px frame |

## Formats

The formats are Obsidian's accepted list, kept in one table that both renderers
read (`src/shared/media-exts.ts`), so a format embeds in a note and in a card
or in neither.

| Kind | Extensions |
|------|------------|
| Image | `avif`, `bmp`, `gif`, `jpeg`, `jpg`, `png`, `svg`, `webp` |
| Audio | `3gp`, `flac`, `m4a`, `mp3`, `ogg`, `wav` |
| Video | `mkv`, `mov`, `mp4`, `ogv`, `webm` |
| Document | `pdf` |

Two of those are worth a note. Obsidian lists `.webm` under both audio and
video; it is rendered as video, so an audio-only `.webm` plays through a video
element that has no picture to show. And whether a browser can decode a format —
`3gp` audio most of all — is the same codec question it is in Obsidian.

## Where the Files Live

An embed is a URL the site has to serve, so where the file sits decides whether
it works. Rspress copies `public/` to the site root and nothing else, so a file
in the docs tree can resolve to a URL that no route serves. Two placements both
work:

- The **demo vault** (`Obsidian Vault/media/`), which is what this page uses. The
  plugin publishes vault attachments under `/vault/`, so `![[media/gradient.png]]`
  resolves and the file is copied next to it during the build.
- A **vault-relative path** resolved through the content index, the same lookup
  that resolves `[[Some Note]]`.

A file that is missing keeps its root-relative `src` and logs a warning, so an
embed starts working once the file lands and needs no rewrite.
