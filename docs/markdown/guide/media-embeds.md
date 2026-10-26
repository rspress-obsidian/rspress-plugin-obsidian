---
title: Media Embeds
description: Embed images, audio, video, PDFs, YouTube videos and posts on X with ![[file]] or a Markdown image, with sizes, PDF page and height, and how attachments are found and published.
---

# Media Embeds

With [`enableMediaEmbeds`](./api.md#features), `![[file]]` renders every
image, audio, video and PDF format that Obsidian accepts as a native element,
sized with the same pipe syntax:

```ts
markdown({
  enableMediaEmbeds: true,
  enableDefaultStyles: true, // styles the PDF frame
});
```

Every embed on this page is a real file in this site's demo vault, rendered by
the plugin. With the option off, `![[file]]` renders as a link to the file, and
a Markdown-image embed of audio, video, a PDF or a web page renders as a
link. Markdown images of image files work either way.

## Images

An image embed renders as a lazy-loaded `<img>`. A number after the pipe sets
the width, and `WxH` sets the width and the height:

![[media/gradient.png|420]]

![[media/gradient.png|300]]

![[media/gradient.png|300x180]]

Text after the pipe that is not a size is a caption, used as the image's `alt`
text. `![[image.png|A caption|300]]` gives both:

![[media/gradient.png|A gradient, unsized]]

SVG is an image format too:

![[media/diagram.svg|320]]

### Markdown images

`![](image.png)` is core Markdown, so the plugin resolves it in every
configuration, the same way it resolves an embed. Paths with spaces work as
`![](<my image.png>)` or `![](my%20image.png)`. Obsidian also lets the alt text
carry a size, alone or after a caption:

![300](/vault/media/gradient.png)

![300x180](/vault/media/gradient.png)

![A caption, then a size|300](/vault/media/gradient.png)

Alt text that is not a bare size, such as `![A caption|wide](image.png)`,
stays caption text.

## Audio

Each player below plays the same one-second tone in a different encoding:

![[media/tone.mp3]]

![[media/tone.ogg]]

![[media/tone.wav]]

![[media/tone.m4a]]

![[media/tone.flac]]

## Video

A width after the pipe sizes the player:

![[media/clip.mp4]]

![[media/clip.webm|320]]

## PDF

A PDF renders as a frame with a bar above it. The bar names the file and has an
**Open** link, which a reader can use to view the PDF full screen or on a
browser that cannot show PDFs in place, such as iOS webviews or Firefox.

`#page=N` opens the frame at that page, and the bar shows which page:

![[media/sample.pdf#page=2]]

`#height=N` sets the frame's height in pixels. The height never becomes part of
the file's URL:

![[media/sample.pdf#height=240]]

Without either, the frame is 600px tall:

![[media/sample.pdf]]

Join both with `&`, as Obsidian does:

![[media/sample.pdf#page=2&height=320]]

The frame is not sandboxed, because Chromium's PDF viewer needs scripts and
shows a broken document inside a sandboxed frame. So the frame only ever loads
a file from your own site: a PDF on another site, such as
`![](https://example.com/report.pdf)`, renders as a link to it instead. If you
would rather link to every PDF than embed it, leave `enableMediaEmbeds` off.
The frame's look comes from the `.obsidian-pdf` rules in
`rspress-plugin-obsidian/markdown/styles.css`.

## Markdown-image embeds

When **`Use [[Wikilinks]]`** is off in Obsidian, every embed is written as a
Markdown image. Audio, video and PDFs embed the same way in that form:

![](/vault/media/tone.mp3)

![320](/vault/media/clip.mp4)

![](/vault/media/sample.pdf#page=2&height=320)

## YouTube and X

A Markdown image of a YouTube video or a post on X becomes an embedded frame,
as in Obsidian:

![](https://www.youtube.com/watch?v=NnTvZWp5Q7o)

`watch?v=`, `youtu.be/`, `/shorts/` and `/embed/` links all work, as does a
`t=` start time, and so do `x.com` and `twitter.com` status links. The plugin
validates the id and builds the frame URL from it, and the frame is sandboxed
to what the player needs. `![560x315](…)` sets the size. Otherwise a video is
16:9 at full width, and a post is a 550 × 700 px card that scrolls when the post
is longer. Any other external URL is treated as an image. An `<iframe>` that you
write yourself is kept as written.

## In a canvas card

A text card on a canvas renders attachments with the same renderer and the
same list of formats, including both PDF options. Pan and zoom the board below:

![[Media.canvas]]

## Syntax

| You write | Result |
|-----------|--------|
| `![[image.png]]`, `![](image.png)` | Image |
| `![[image.png\|300]]`, `![300](image.png)` | Image 300px wide |
| `![[image.png\|300x180]]`, `![300x180](image.png)` | Image 300 × 180 |
| `![[image.png\|A caption]]` | Image with alt text, unsized |
| `![[image.png\|A caption\|300]]`, `![A caption\|300](image.png)` | Alt text and width |
| `![[audio.mp3]]`, `![](audio.mp3)` | `<audio controls>` |
| `![[video.mp4]]`, `![](video.mp4)` | `<video controls>` |
| `![[video.mp4\|320]]`, `![320](video.mp4)` | Video 320px wide |
| `![[doc.pdf]]`, `![](doc.pdf)` | PDF in a 600px frame |
| `![[doc.pdf#page=3]]` | PDF opened at page 3 |
| `![[doc.pdf#height=400]]` | PDF in a 400px frame |
| `![[doc.pdf#page=3&height=400]]` | Both |
| `![](https://youtu.be/…)` | YouTube video, 16:9 |
| `![](https://x.com/user/status/…)` | Post on X |
| `![560x315](https://youtu.be/…)` | Web embed at 560 × 315 |

## Formats

These are the formats Obsidian accepts. Notes and canvas cards read them from
one shared list, so a format embeds in both or in neither.

| Kind | Extensions | Element |
|------|------------|---------|
| Image | `avif`, `bmp`, `gif`, `jpeg`, `jpg`, `png`, `svg`, `webp` | `<img loading="lazy">` |
| Audio | `3gp`, `flac`, `m4a`, `mp3`, `ogg`, `wav` | `<audio controls>` |
| Video | `mkv`, `mov`, `mp4`, `ogv`, `webm` | `<video controls>` |
| Document | `pdf` | `<iframe>` in a `<figure class="obsidian-pdf">` |

Obsidian lists `.webm` as both audio and video. The plugin renders it as video,
so an audio-only `.webm` plays in a video element with no picture. Whether a
browser can decode a format, `3gp` in particular, depends on the browser, as it
does in Obsidian.

## How a file is found

The plugin looks for an embedded file, or a Markdown image, in this order:

1. Next to the note, relative to its folder.
2. At that path in the index, which covers attachments in the vault.
3. Relative to the docs root.
4. At that path from the root in the index.
5. By file name anywhere in the index, if exactly one file has that name
   (first matching case, then ignoring case). This is what makes a bare
   `![[photo.png]]` work.

An embed whose file is found nowhere logs a warning and gets the URL it would
be published at, such as `/vault/media/x.png` for a vault note, so it starts
working once the file exists. A Markdown image that is found nowhere is
reported through `onBrokenLink`.

Vault attachments are published only when a published note uses them, at
`<vaultRoutePrefix>/<path in the vault>`. Rspress turns a relative image into a
bundler import before plugins run. The plugin points that import at the file
it found, so the image is bundled like any other Rspress image. The plugin
also exempts relative images from Rspress's own dead-image check
(`markdown.image.checkDeadImages`, unless your config sets it). Audio, video and
PDF URLs include the site `base`.
