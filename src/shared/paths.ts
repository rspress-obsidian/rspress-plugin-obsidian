import { normalizeFsPath } from "./route-path.js";
import { normalizeUnicode } from "./slug.js";

export function normalizeFilePathKey(input: string): string {
	return normalizeUnicode(
		// Trim first: the extension strip is anchored to the end, so a stray
		// leading or trailing space left `.md` on the key and the lookup missed.
		normalizeFsPath(input.trim())
			.replace(/\.(md|mdx)$/i, "")
			.replace(/^\/+|\/+$/g, ""),
	);
}

const TAG_UNSAFE_CHARS = /[\s"<>#?%&]/g;

/**
 * Encode a tag for use as a single URL path segment. Shared: the Markdown
 * plugin builds `/tags/<tag>` routes with it and the graph builder re-encodes a
 * tag when it derives an edge target, and those two must agree byte for byte.
 */
export function encodeTagPathSegment(tag: string): string {
	const encoded = tag.replace(TAG_UNSAFE_CHARS, (c) => encodeURIComponent(c));
	if (!encoded) {
		console.warn(
			`[rspress-plugin-obsidian:markdown] Tag "${tag}" encoded to an empty path segment — skipping.`,
		);
	}
	return encoded;
}

/**
 * The one route a tag is published at. Obsidian treats `#Project` and
 * `#project` as one tag, so the route is the lowercased, NFC-normalised tag:
 * the inline tag link, the generated tag page and the graph's tag node all
 * call this, and agree byte for byte however the tag was spelt. `tag` carries
 * no leading `#`.
 */
export function tagRoutePath(tag: string): string {
	return `/tags/${encodeTagPathSegment(normalizeUnicode(tag).toLowerCase())}`;
}

/**
 * Obsidian's inline `#tag`: letters, marks, numbers, emoji, `_`, `-` and `/`
 * for nesting, not preceded by a word character or `/` (so `foo#bar` and URL
 * fragments are not tags). Global and sticky-free: callers iterate with
 * `matchAll` and must still apply {@link tagNameFromMatch}. Shared by the
 * markdown index, the markdown renderer, canvas cards and the graph so every
 * surface agrees on what is a tag.
 */
export const INLINE_TAG_PATTERN =
	/(?<![/\p{L}\p{N}_-])#([\p{L}\p{M}\p{N}\p{Extended_Pictographic}_/-]+)/gu;

/**
 * The tag a {@link INLINE_TAG_PATTERN} match names, or `undefined` when
 * Obsidian would not treat it as one: trailing `/` is dropped, and a tag made
 * only of digits, `/` and `-` (`#1984`, `#2024-01`) is not a tag.
 */
export function tagNameFromMatch(captured: string): string | undefined {
	const tag = captured.replace(/\/+$/, "");
	return tag && !/^[\p{N}/-]+$/u.test(tag) ? tag : undefined;
}
