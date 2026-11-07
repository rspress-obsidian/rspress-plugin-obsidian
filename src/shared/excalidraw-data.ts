/**
 * The Obsidian Excalidraw plugin's data block: the headings it writes under a
 * drawing's markdown, and where that block starts in a note.
 *
 * The vocabulary lives here because two readers look for it — the note parser,
 * which reads the sections, and the page renderer, which cuts the block off a
 * drawing page — and a heading one of them knew and the other did not would
 * show the block as body text.
 */

/** The `<h1>` that opens the plugin's data block. */
export const EXCALIDRAW_DATA_TITLE = "Excalidraw Data";

/** The block's headings, as a table of contents reports them. */
export const EXCALIDRAW_HEADINGS: ReadonlySet<string> = new Set([
	EXCALIDRAW_DATA_TITLE,
	"Text Elements",
	"Element Links",
	"Embedded Files",
	"Drawing",
]);

/** Where the block begins, under `#` or `##`, with or without the `%%` comment. */
const EXCALIDRAW_DATA_HEADING =
	/^(?:%%[\r\n]*)?(?:# Excalidraw Data|##? Text Elements|##? Drawing)[ \t\r]*$/m;

/** Only the block's own headings end a section: a text element may hold `# Title`. */
export const EXCALIDRAW_SECTION_END =
	/^(?:##? (?:Excalidraw Data|Text Elements|Element Links|Embedded [Ff]iles|Drawing)[ \t]*$|%%)/m;

/** Where the block begins in a note's markdown: everything above it is the back of the note. */
export function backOfNoteEnd(markdown: string): number {
	const start = markdown.search(EXCALIDRAW_DATA_HEADING);
	return start === -1 ? markdown.length : start;
}
