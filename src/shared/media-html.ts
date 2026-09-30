import { escapeHtmlAttribute } from "../shared/escape.js";

/**
 * The one PDF embed markup, shared by the Markdown pipeline and the canvas
 * renderer.
 *
 * Both renderers used to emit a bare `<iframe>`, which on its own is a white
 * rectangle with no name on it. That is a poor result even where the browser can
 * display the PDF — the reader cannot tell which document they are looking at or
 * how to get a full-screen view — and it is a dead end where it cannot: headless
 * Chromium, iOS webviews and desktop Firefox all show an empty frame with no
 * indication that a document was there at all. Obsidian labels its PDF embeds
 * for the same reason.
 *
 * So the embed is a `figure` with a caption bar: the file's name, and a link
 * that opens the document on its own. The bar is the only ornament; the frame
 * itself keeps the site's own border colour and radius so it reads as part of
 * the page rather than as a pasted-in object.
 */
export interface PdfEmbedOptions {
	/** The frame's URL, including any `#page=` subpath. */
	src: string;
	/** The link target as written, e.g. `media/sample.pdf#page=2`. */
	target: string;
	/** The page a `#page=` subpath opened at, shown in the bar when there is one. */
	page?: string;
	/** Frame height in pixels. Ignored when `style` supplies a height. */
	height?: number;
	/** Inline style, for a canvas size pipe that sets its own dimensions. */
	style?: string;
}

/** The bare file name a reader recognises, with any subpath dropped. */
function fileNameOf(target: string): string {
	const withoutSubpath = target.split("#")[0] ?? target;
	const segments = withoutSubpath.split("/").filter(Boolean);
	return segments[segments.length - 1] ?? withoutSubpath;
}

/**
 * Split a file name so the extension can be de-emphasised: the name identifies
 * the document, the extension only says what it is, and the reader already
 * knows it is a PDF from the frame.
 */
function splitExtension(name: string): { stem: string; extension: string } {
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return { stem: name, extension: "" };
	return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

export function pdfEmbedHtml({ src, target, page, height, style }: PdfEmbedOptions): string {
	const name = fileNameOf(target);
	const { stem, extension } = splitExtension(name);
	const label = `${stem}${extension}`;
	const srcAttr = escapeHtmlAttribute(src);
	const heightPx = height ?? 600;
	const frameStyle = style
		? ` style="${escapeHtmlAttribute(style)}"`
		: ` width="100%" height="${heightPx}px"`;

	return [
		'<figure class="obsidian-pdf">',
		'<figcaption class="obsidian-pdf-bar">',
		`<span class="obsidian-pdf-name">${escapeHtmlAttribute(stem)}`,
		extension ? `<span class="obsidian-pdf-ext">${escapeHtmlAttribute(extension)}</span>` : "",
		"</span>",
		// The frame opens partway into a document, and the reader can see that in
		// the source but not in the output, so the bar says which page it is on.
		page ? `<span class="obsidian-pdf-page">page ${escapeHtmlAttribute(page)}</span>` : "",
		`<a class="obsidian-pdf-open" href="${srcAttr}" target="_blank" rel="noopener noreferrer"`,
		` aria-label="Open ${escapeHtmlAttribute(label)} in a new tab">Open`,
		// A span rather than an inline <svg>: Rspress parses emitted HTML as MDX,
		// which drops an <svg> element and keeps its children, so a drawn arrow
		// arrived as two stray glyphs. The icon is a CSS mask instead, the same
		// way the callout icons in this stylesheet are drawn.
		'<span class="obsidian-pdf-open-icon" aria-hidden="true"></span></a>',
		"</figcaption>",
		// Deliberately not sandboxed: Chromium's PDF viewer needs scripts and
		// renders a broken-document icon inside a sandboxed frame (verified in a
		// browser), so a sandbox here would break the embed rather than harden it.
		// The file is served from the site's own origin.
		`<iframe class="obsidian-pdf-frame" src="${srcAttr}" title="${escapeHtmlAttribute(label)}"`,
		`${frameStyle} frameborder="0" loading="lazy"></iframe>`,
		"</figure>",
	].join("");
}
