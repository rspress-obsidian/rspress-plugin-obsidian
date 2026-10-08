import GithubSlugger from "github-slugger";

/**
 * Plain text of one line of markdown, for heading previews and node-free slug
 * matching. Approximates what the page renders: comments vanish, a wikilink
 * shows its alias or target, an embed nothing, and only real emphasis loses
 * its markers — CommonMark never treats an intraword `_` as emphasis, so
 * `my_function` keeps its underscore (and `id="my_function"` on the page).
 */
export function stripMarkdownFormatting(input: string): string {
	return input
		.replace(/%%[\s\S]*?(?:%%|$)/g, "")
		.replace(/!\[\[[^\]]*\]\]/g, "")
		.replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_match, target: string, alias?: string) =>
			alias?.trim() ? alias : target.split("#").filter(Boolean).join(" > "),
		)
		.replace(/`([^`]+)`/g, "$1")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/<[^>]+>/g, "")
		.replace(/[*~]+/g, "")
		.replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, "")
		.trim();
}

/**
 * Slugify a heading for anchor generation.
 *
 * Uses a fresh GithubSlugger instance to produce a deterministic slug
 * without counter suffixes (each call is independent).
 */
export function slugifyHeading(input: string): string {
	return new GithubSlugger().slug(stripMarkdownFormatting(input));
}

/**
 * Fold a lookup key to NFC.
 *
 * macOS stores filenames decomposed (NFD) while note text is usually composed
 * (NFC), so `[[café]]` in a note never matches `café.md` on disk. Every key
 * compared during resolution — path, basename, title, alias, tag, mention name
 * — is folded on both the index side and the lookup side. Absolute paths used
 * to read files are deliberately left byte-identical to what the filesystem
 * reported.
 */
export function normalizeUnicode(value: string): string {
	return value.normalize("NFC");
}

export function normalizeLookupValue(input: string): string {
	return normalizeUnicode(input.trim().replace(/\s+/g, " ")).toLowerCase();
}

export function humanizeBaseName(input: string): string {
	return input.replace(/[-_]+/g, " ").trim();
}
