---
description: Live media embeds — every image, audio, video and PDF format Obsidian accepts in both embed syntaxes, with sizing, PDF page and height subpaths, YouTube and X embeds, and the same renderer inside canvas text cards.
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

Both knobs together, joined by `&` as Obsidian documents — page 2, in a 320px
frame:

![[media/sample.pdf#page=2&height=320]]

## Markdown Syntax

With **`Use [[Wikilinks]]`** off, Obsidian writes every embed as a markdown image.
Each format embeds the same way in that form — a player, not an image:

![](/vault/media/tone.mp3)

![320](/vault/media/clip.mp4)

![](/vault/media/sample.pdf#page=2&height=320)

## Web Pages

Obsidian embeds a YouTube video or a post on X from a markdown image of its URL.
The plugin frames the site's own embed page; the size syntax sizes the frame:

![](https://www.youtube.com/watch?v=NnTvZWp5Q7o)

Short links (`youtu.be/…`), Shorts and a `t=` start time work too, as do
`twitter.com` and `x.com` post URLs. A post is a fixed-height card: X sizes it to
fit only through its own script, which the site does not load, so a long post
scrolls inside the frame. Any other external URL is an image, and an `<iframe>`
a note writes itself is kept as written.

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
| `![[image.png\|A caption\|300]]` | Caption, then width |
| `![](image.png)` | Markdown image, resolved like an embed (next to the note, from the root, or by unique name) |
| `![](<my image.png>)`, `![](my%20image.png)` | Markdown image with spaces in its name |
| `![300](image.png)` | Markdown image, width 300 |
| `![300x180](image.png)` | Markdown image, width and height |
| `![A caption\|300](image.png)` | Markdown image, caption then width |
| `![[audio.mp3]]`, `![](audio.mp3)` | `<audio controls>` |
| `![[video.mp4]]`, `![](video.mp4)` | `<video controls>` |
| `![[video.mp4\|320]]`, `![320](video.mp4)` | Video at 320px wide |
| `![[doc.pdf]]`, `![](doc.pdf)` | PDF in a 600px frame |
| `![[doc.pdf#page=3]]` | PDF opened at page 3 |
| `![[doc.pdf#height=400]]` | PDF in a 400px frame |
| `![[doc.pdf#page=3&height=400]]` | Both |
| `![](https://www.youtube.com/watch?v=…)`, `![](https://youtu.be/…)` | YouTube video, 16:9 |
| `![](https://x.com/user/status/…)` | Post on X |
| `![560x315](https://youtu.be/…)` | Web embed at 560×315 |

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
  resolves to `/vault/media/gradient.png`. Only attachments a published page
  references are published — never dotfiles, never a file only a
  `publish: false` note uses — and they are served from
  `node_modules/.rspress-plugin-obsidian/`, not written into `docs/public/`.
- A **vault-relative path** resolved through the content index, the same lookup
  that resolves `[[Some Note]]`.

A file that is missing logs a warning and gets the URL it will be published at
(`/vault/media/x.png` for a vault note), so an embed starts working once the file
lands and needs no rewrite.
