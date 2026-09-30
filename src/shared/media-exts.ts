/**
 * The file formats Obsidian accepts as attachments, in one place.
 *
 * These mirror Obsidian's own "Accepted file formats" list, and both renderers
 * that turn a target into media markup read them from here: the Markdown
 * pipeline (`remark-wikilink.ts`) and the canvas text-card renderer
 * (`canvas/utils/markdown.ts`). They used to carry their own hand-maintained
 * copies, which drifted — the Markdown one had `mkv` but no `ogv`, the canvas
 * one the reverse — so a format could embed in a note and silently fall back to a
 * link inside a canvas card.
 *
 * Two notes on the lists themselves:
 *
 * - Obsidian lists `.webm` under *both* audio and video. It is claimed for video
 *   here, because the renderers test audio first and taking it for audio would
 *   turn every video `.webm` into an `<audio>` element. An audio-only `.webm`
 *   still plays, through a video element that has no picture to show.
 * - `.3gp` is classified as audio to match Obsidian, which is also where the
 *   format comes from (3GP audio calls). Whether a given browser can decode it
 *   is a codec question, not a classification one — Obsidian prints the same
 *   caveat about its own playback.
 *
 * Codec availability is the user's browser, exactly as it is in Obsidian.
 */

/** Formats rendered as `<img>`. */
export const IMAGE_EXTS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);

/** Formats rendered as `<audio controls>`. */
export const AUDIO_EXTS = new Set(["3gp", "flac", "m4a", "mp3", "ogg", "wav"]);

/** Formats rendered as `<video controls>`. */
export const VIDEO_EXTS = new Set(["mkv", "mov", "mp4", "ogv", "webm"]);

/** The one document format embedded in a frame. */
export const PDF_EXT = "pdf";

/**
 * Every extension above, as one lookup. An `[[image.png]]` names an attachment
 * rather than a page, so it is not a page link — but it still has to be
 * recognisable as one wherever a target is being classified. Kept beside the
 * lists above so a new format cannot be added to a renderer and forgotten here.
 */
export const ATTACHMENT_EXTS = new Set<string>([
	...IMAGE_EXTS,
	...AUDIO_EXTS,
	...VIDEO_EXTS,
	PDF_EXT,
]);

/** The lowercased extension of a target, without the dot. */
export function extensionOf(target: string): string {
	return target.split(".").pop()?.toLowerCase() ?? "";
}
