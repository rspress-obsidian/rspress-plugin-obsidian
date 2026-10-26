import { escapeHtmlAttribute, escapeHtmlText } from "../shared/escape.js";

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

// An origin no real URL is written against: a URL that resolves under it was
// relative or root-relative, i.e. it loads from whatever site shows the page.
const SAME_SITE_PROBE = "https://same-site.invalid/";

// What a browser drops from an `src` before parsing it: leading and trailing
// C0 controls and spaces, and every tab and newline anywhere in it.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the browser strips control characters, so this must too
const URL_TRIM = /^[\u0000-\u0020]+|[\u0000-\u0020]+$/g;
const URL_TAB_OR_NEWLINE = /[\t\n\r]/g;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Whether `url` loads from the page's own site: relative or root-relative,
 * with no scheme and no host. Parsed the way a browser parses an `src`, so
 * `//host/x`, `/\host/x` and `\\host\x`, which a browser reads as another
 * host, are not same-site. Any scheme is refused before parsing: a URL like
 * `https:host/x` is relative to an `https:` page but names `https://host/x`
 * from an `http:` one, so whether it stays on the site depends on the page.
 */
export function isSameSiteUrl(url: string): boolean {
	if (URL_SCHEME.test(url.replace(URL_TRIM, "").replace(URL_TAB_OR_NEWLINE, ""))) return false;
	try {
		return new URL(url, SAME_SITE_PROBE).origin === new URL(SAME_SITE_PROBE).origin;
	} catch {
		return false;
	}
}

/**
 * A PDF as a captioned frame, or — when `src` is on another site — a plain
 * link that opens it. The frame cannot be sandboxed (see below), so it only
 * ever loads a file the site itself serves.
 */
export function pdfEmbedHtml({ src, target, page, height, style }: PdfEmbedOptions): string {
	const name = fileNameOf(target);
	const { stem, extension } = splitExtension(name);
	const label = `${stem}${extension}`;
	const srcAttr = escapeHtmlAttribute(src);
	if (!isSameSiteUrl(src)) {
		return `<a class="obsidian-pdf-link" href="${srcAttr}" target="_blank" rel="noopener noreferrer">${escapeHtmlText(label)}</a>`;
	}
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
		// That is safe only because the file is the site's own: a PDF on another
		// site never reaches this frame (see `isSameSiteUrl` above).
		`<iframe class="obsidian-pdf-frame" src="${srcAttr}" title="${escapeHtmlAttribute(label)}"`,
		`${frameStyle} frameborder="0" loading="lazy"></iframe>`,
		"</figure>",
	].join("");
}

/**
 * The two knobs of a PDF embed's subpath. Obsidian documents `#page=3`,
 * `#height=400`, and both joined by `&` (`#page=3&height=400`), in any order.
 * Anything else in the subpath is not a knob and is ignored.
 */
export function parsePdfSubpath(subpath: string): { page?: string; height?: string } {
	const knobs: { page?: string; height?: string } = {};
	for (const part of subpath.split("&")) {
		const match = /^(page|height)=(\d+)$/i.exec(part.trim());
		if (match?.[1] && match[2]) knobs[match[1].toLowerCase() as "page" | "height"] = match[2];
	}
	return knobs;
}

const YOUTUBE_ID = /^[\w-]{11}$/;
const TWEET_ID = /^\d{1,20}$/;

/** A YouTube `t`/`start` value — `90`, `90s`, `1h2m3s` — in seconds. */
function youtubeStart(value: string | null): number | undefined {
	const match = value ? /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(value) : null;
	if (!match || !value) return undefined;
	const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0);
	return seconds > 0 ? seconds : undefined;
}

/** The frame URL for a YouTube video or a tweet `url` names, if it names one. */
function webEmbedSource(url: string): { kind: "youtube" | "tweet"; src: string } | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
	const host = parsed.hostname.toLowerCase().replace(/^(?:www|m|mobile|music)\./, "");
	const segments = parsed.pathname.split("/").filter(Boolean);

	if (host === "youtu.be" || host === "youtube.com" || host === "youtube-nocookie.com") {
		const id =
			host === "youtu.be"
				? segments[0]
				: parsed.pathname === "/watch"
					? parsed.searchParams.get("v")
					: ["embed", "shorts", "live"].includes(segments[0] ?? "")
						? segments[1]
						: undefined;
		if (!id || !YOUTUBE_ID.test(id)) return undefined;
		const start = youtubeStart(parsed.searchParams.get("t") ?? parsed.searchParams.get("start"));
		return {
			kind: "youtube",
			src: `https://www.youtube.com/embed/${id}${start ? `?start=${start}` : ""}`,
		};
	}
	if (host === "twitter.com" || host === "x.com") {
		const id = segments[1] === "status" ? segments[2] : undefined;
		if (!id || !TWEET_ID.test(id)) return undefined;
		return {
			kind: "tweet",
			// X lays the post out at this width (250–550), not the frame's.
			src: `https://platform.twitter.com/embed/Tweet.html?dnt=true&width=550px&id=${id}`,
		};
	}
	return undefined;
}

/**
 * The frame for a web page Obsidian embeds from a markdown image —
 * `![](https://www.youtube.com/watch?v=…)` or `![](https://x.com/…/status/…)` —
 * or `undefined` when `url` is neither. As in Obsidian, the page is framed
 * from the site's own embed URL; nothing else on the page loads their scripts.
 * The ids are validated, so the URL is built, never copied.
 *
 * A size in the image's alt (`![560x315](…)`) sizes the frame; otherwise the
 * stylesheet gives a video a 16:9 box and a tweet a fixed-height card.
 */
export function webEmbedHtml(
	url: string,
	options: { title?: string; width?: string; height?: string } = {},
): string | undefined {
	const source = webEmbedSource(url);
	if (!source) return undefined;
	const title = options.title || (source.kind === "youtube" ? "YouTube video" : "Post on X");
	const size = options.width
		? ` width="${options.width}"${options.height ? ` height="${options.height}"` : ""}`
		: "";
	return [
		`<iframe class="obsidian-web-embed obsidian-web-embed-${source.kind}"`,
		` src="${escapeHtmlAttribute(source.src)}" title="${escapeHtmlAttribute(title)}"${size}`,
		' allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"',
		// YouTube refuses to play in a frame that sends no referrer.
		' allowfullscreen referrerpolicy="strict-origin-when-cross-origin"',
		' sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation"',
		' frameborder="0" loading="lazy"></iframe>',
	].join("");
}
