/**
 * Which file extensions count as Markdown, and as what.
 *
 * Two lookups that differ on purpose, kept side by side so they stay
 * consistent: note-shaped content is readable wherever notes are embedded
 * (transclusions, canvas file cards, `[[…]]` embeds), while only the two
 * extensions Rspress actually routes become pages. `.markdown` reads as note
 * text but is never published as a route, so it belongs to the first set only.
 */

/** Extensions whose file content is Markdown note text wherever notes are embedded. */
export const NOTE_MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".markdown"]);

/** Extensions that become published pages (and are excluded from the asset list). */
export const PAGE_MARKDOWN_EXTENSIONS = new Set([".md", ".mdx"]);
