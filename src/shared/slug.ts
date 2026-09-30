import GithubSlugger from "github-slugger";

export function stripMarkdownFormatting(input: string): string {
	return input
		.replace(/`([^`]+)`/g, "$1")
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/<[^>]+>/g, "")
		.replace(/[*_~]/g, "")
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
