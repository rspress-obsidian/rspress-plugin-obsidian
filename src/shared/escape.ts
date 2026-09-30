/**
 * HTML escaping shared by the build-time remark pipeline, the Dataview
 * renderers and the browser canvas renderer.
 *
 * Exactly two variants: text sinks escape `& < >`, attribute sinks additionally
 * escape `"`. Every attribute this package emits is double-quoted, so `'` needs
 * no escape — add a third variant only with a call site that proves it.
 */
// One pass, not three: `escapeHtmlAttribute` calls this for every href and
// the Dataview renderers for every cell, and each `.replace` allocated a full
// copy of the string even when it matched nothing. Measured 13% of a remark
// pass; byte-identical output, 1.4x faster.
const HTML_TEXT_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

export function escapeHtmlText(value: string): string {
	return value.replace(/[&<>]/g, (character) => HTML_TEXT_ESCAPES[character] ?? character);
}

export function escapeHtmlAttribute(value: string): string {
	return escapeHtmlText(value).replace(/"/g, "&quot;");
}

const SAFE_PROTOCOL = /^(?:https?:|mailto:|tel:)/i;
// The image subtypes have to be the ones the shared table lists, or a format
// embeds by path and then silently degrades to a bare filename the moment the
// attachment arrives inlined as a data URL. `svg\+xml` is escaped because `+`
// is a regex quantifier.
const MEDIA_DATA_URL =
	/^data:(?:image\/(?:avif|bmp|gif|jpe?g|png|svg\+xml|webp)|audio\/[^;,]+|video\/[^;,]+|application\/pdf);base64,/i;

/**
 * Allow only URLs that are safe to put in an `href`/`src` attribute, or `null`
 * when the caller must drop the link entirely.
 *
 * Lives here rather than with the canvas renderer because it is the only
 * defence for every URL this package emits: HTML escaping does not stop
 * `javascript:`. The Dataview renderers build hrefs from note frontmatter, so
 * that value is attacker-controlled whenever the vault is.
 */
export function sanitizeUrl(value: string): string | null {
	const url = value.trim();
	// A regex, not `[...url].some(...)`: the spread built a code-point array
	// for the whole string on every URL this package emits, which measured 10x
	// slower than the equivalent character class (294ms vs 30ms per 680k
	// calls) and dominated Dataview link rendering. Rejecting control
	// characters is the rule's own subject here, so the escapes are deliberate.
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
	if (/[\u0000-\u001f\u007f]/.test(url)) {
		return null;
	}
	if (!url) return null;
	if (
		url.startsWith("#") ||
		(url.startsWith("/") && !url.startsWith("//")) ||
		url.startsWith("./") ||
		url.startsWith("../")
	) {
		return url;
	}
	if (MEDIA_DATA_URL.test(url) || SAFE_PROTOCOL.test(url)) {
		return url;
	}
	return null;
}
