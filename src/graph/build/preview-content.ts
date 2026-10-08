/**
 * Hover-preview content budget in characters, shared by the build that ships the
 * text and the client component that renders it. The build sends at most one
 * character past this budget — the marker the client uses to tell a truncated
 * body from one that happens to fit exactly — and the client renders at most
 * this many.
 */
export const PREVIEW_CONTENT_LENGTH = 300;

/**
 * Reduce markdown to the plain prose a hover preview shows.
 *
 * Every marker rule requires adjacency (`**` directly before a non-space, `_`
 * on a word boundary) so arithmetic like `2 * 3` and `snake_case` survive —
 * unlike `stripMarkdownFormatting`, which deletes the marker characters
 * unconditionally.
 */
export function toPreviewText(markdown: string): string {
	// Code is shown literally: mask fence bodies and inline spans first so the
	// prose rules below cannot rewrite them (`def f(**kw)` must not lose its
	// stars), then restore the exact text at the end.
	const code: string[] = [];
	const mask = (text: string): string => {
		code.push(text);
		return `\u0000${code.length - 1}\u0000`;
	};

	const masked = markdown
		.replace(
			/^[ \t]*(?:`{3,}|~{3,})[^\n]*\n([\s\S]*?)^[ \t]*(?:`{3,}|~{3,})[^\n]*$/gm,
			(_match, body: string) => mask(body.trim()),
		)
		.replace(/`([^`\n]+)`/g, (_match, span: string) => mask(span));

	return (
		masked
			.replace(/^#{1,6}\s+/gm, "")
			.replace(/^>\s?/gm, "")
			.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "")
			.replace(/%%[\s\S]*?%%/g, "")
			// Hidden on the page, so hidden in the preview — the tag rule below
			// never matches `<!--`, and an unclosed comment hides the rest.
			.replace(/<!--[\s\S]*?(?:-->|$)/g, "")
			// Embeds and wikilinks differ only by the leading `!`.
			.replace(
				/!?\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|([^\]]*))?\]\]/g,
				(_m, target, label) => label ?? target,
			)
			.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
			.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
			.replace(/\[\^[^\]]*\]/g, "")
			.replace(/<[a-zA-Z/][^>]*>/g, "")
			.replace(/\*\*(?=\S)([\s\S]*?)(?<=\S)\*\*/g, "$1")
			.replace(/(?<!\w)__(?=\S)([\s\S]*?)(?<=\S)__(?!\w)/g, "$1")
			.replace(/\*(?=\S)([\s\S]*?)(?<=\S)\*/g, "$1")
			.replace(/(?<!\w)_(?=\S)([\s\S]*?)(?<=\S)_(?!\w)/g, "$1")
			// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is the in-band sentinel for masked code; it cannot occur in markdown text
			.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => code[Number(index)] ?? "")
			.replace(/\s+/g, " ")
			.trim()
	);
}
