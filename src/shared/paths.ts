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
