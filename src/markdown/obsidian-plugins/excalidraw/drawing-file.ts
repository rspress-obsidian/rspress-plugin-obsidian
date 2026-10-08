/**
 * The Obsidian Excalidraw plugin's note format, read the way the plugin reads
 * it (`ExcalidrawData.loadData`, `excalidrawMarkdownParsing.ts`):
 *
 * ```
 * ---
 * excalidraw-plugin: parsed
 * ---
 * Back-of-the-note markdown
 *
 * # Excalidraw Data
 * ## Text Elements
 * Plan [[Target]] ^txt1
 *
 * ## Element Links
 * ell1: [[Kanban Board]]
 *
 * ## Embedded Files
 * img1: [[photo.png]]
 *
 * %%
 * ## Drawing
 * ```compressed-json
 * N4Ig…
 * ```
 * %%
 * ```
 *
 * Every section is optional except the drawing. The scene sits in a ```json
 * or ```compressed-json fence (LZString base64, wrapped across lines and
 * blank lines), under `#` or `##`, with or without the `%%` comment around it.
 */
// lz-string is CommonJS that Node's ESM loader cannot list named exports for,
// so `import { decompressFromBase64 }` fails in dist/index.js under plain Node.
import LZString from "lz-string";
import { parseFrontmatter } from "../../../shared/frontmatter.js";
import { normalizeScene, type Scene, SceneError } from "./scene.js";

/** A file a drawing's `## Embedded Files` section names. */
export type EmbeddedFileRef =
	| { kind: "link"; fileId: string; target: string }
	| { kind: "url"; fileId: string; url: string }
	| { kind: "latex"; fileId: string; tex: string };

export interface DrawingNote {
	scene: Scene;
	/** `excalidraw-plugin: raw` shows text as written; `parsed` shows links as their text. */
	textMode: "parsed" | "raw";
	frontmatter: Record<string, unknown>;
	/** `## Text Elements`: element id → the text as the author wrote it. */
	textElements: Map<string, string>;
	/** `## Embedded Files`: file id → what the image is. */
	embeddedFiles: Map<string, EmbeddedFileRef>;
}

/**
 * Where the plugin's data begins in a note's markdown (`# Excalidraw Data`,
 * `## Text Elements` or the drawing): everything above it is the back of the
 * note. The note's length when it has none.
 */
export function backOfNoteEnd(markdown: string): number {
	const start = markdown.search(DATA_HEADING);
	return start === -1 ? markdown.length : start;
}

const COMPRESSED_DRAWING = /(\n##? Drawing\n[^`]*```compressed-json\n)([\s\S]*?)```(?:\n|$)/;
const JSON_DRAWING = /\n##? Drawing\n[^`]*```json\n([\s\S]*?)```(?:\n|$)/;
/** Where the plugin's own data begins, in the note as written (CRLF or LF). */
const DATA_HEADING = /^(?:%%[\r\n]*)?(?:# Excalidraw Data|##? Text Elements|##? Drawing)[ \t\r]*$/m;
/** Only the plugin's own headings end a section: a text element may hold `# Title`. */
const SECTION_END =
	/^(?:##? (?:Excalidraw Data|Text Elements|Element Links|Embedded [Ff]iles|Drawing)[ \t]*$|%%)/m;
const TEXT_ELEMENTS_HEADING = /^##? Text Elements[ \t]*\n/m;
const ELEMENT_LINKS_HEADING = /^##? Element Links[ \t]*\n/m;
const EMBEDDED_FILES_HEADING = /^(?:## Embedded Files|# Embedded files)[ \t]*\n/m;
/** The text before ` ^id` — the block id the plugin appends to each text element. */
const TEXT_ELEMENT_ID = /\s\^([\w-]+)(?:\n+|$)/g;
const ELEMENT_LINK_LINE = /^([\w-]+):\s*(.*)$/gm;
const EMBEDDED_LINK = /([\w-]+):\s*!?\[\[([^\]]*)]]\s*(?:\{[^}]*})?\n/g;
const EMBEDDED_URL = /([\w-]+):\s*((?:https?|file|ftps?):\/\/\S*)\n/g;
const EMBEDDED_LATEX = /([\w-]+):\s*\$\$([\s\S]*?)\$\$\s*\n/g;

/** The section after `heading`, up to the next heading of the plugin's or the `%%` fence. */
function sectionAfter(data: string, heading: RegExp): string | undefined {
	const match = heading.exec(data);
	if (!match) return undefined;
	const body = data.slice(match.index + match[0].length);
	const end = body.search(SECTION_END);
	return end === -1 ? body : body.slice(0, end);
}

function decodeScene(json: string): Scene {
	// The plugin keeps everything up to the last brace: a sync conflict can
	// leave a stray tail after the scene.
	const trimmed = json.slice(0, json.lastIndexOf("}") + 1);
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		throw new SceneError(
			`the drawing's scene is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
		);
	}
	return normalizeScene(parsed);
}

function readScene(data: string): { scene: Scene; position: number } {
	const compressed = COMPRESSED_DRAWING.exec(data);
	if (compressed) {
		// The base64 is wrapped at a fixed width, with blank lines between rows.
		const payload = (compressed[2] ?? "").replace(/\s+/g, "");
		const json = payload ? LZString.decompressFromBase64(payload) : "";
		if (!json) throw new SceneError("the compressed drawing could not be decompressed");
		return { scene: decodeScene(json), position: compressed.index };
	}
	const plain = JSON_DRAWING.exec(data);
	if (plain) return { scene: decodeScene(plain[1] ?? ""), position: plain.index };
	throw new SceneError("the note has no `## Drawing` section");
}

/**
 * Parse an Excalidraw drawing note.
 *
 * @throws {SceneError} When the drawing is missing or corrupt.
 */
export function parseDrawingNote(source: string): DrawingNote {
	const data = source.replace(/\r\n?/g, "\n");
	let frontmatter: Record<string, unknown> = {};
	try {
		frontmatter = parseFrontmatter(data).data;
	} catch {
		// Malformed frontmatter is reported by the page itself; the drawing
		// keeps the plugin's defaults.
	}
	const { scene, position } = readScene(data);
	const header = data.slice(0, position);

	const textElements = new Map<string, string>();
	const textSection = sectionAfter(header, TEXT_ELEMENTS_HEADING);
	if (textSection !== undefined) {
		let start = 0;
		for (const match of textSection.matchAll(TEXT_ELEMENT_ID)) {
			const id = match[1] ?? "";
			textElements.set(id, textSection.slice(start, match.index).replace(/^\n+/, ""));
			start = match.index + match[0].length;
		}
	}

	const elementLinks = new Map<string, string>();
	for (const match of (sectionAfter(header, ELEMENT_LINKS_HEADING) ?? "").matchAll(
		ELEMENT_LINK_LINE,
	)) {
		if (match[1] && match[2]?.trim()) elementLinks.set(match[1], match[2].trim());
	}

	const embeddedFiles = new Map<string, EmbeddedFileRef>();
	const filesSection = `${sectionAfter(header, EMBEDDED_FILES_HEADING) ?? ""}\n`;
	for (const match of filesSection.matchAll(EMBEDDED_LINK)) {
		const fileId = match[1] ?? "";
		embeddedFiles.set(fileId, { kind: "link", fileId, target: match[2] ?? "" });
	}
	for (const match of filesSection.matchAll(EMBEDDED_URL)) {
		const fileId = match[1] ?? "";
		embeddedFiles.set(fileId, { kind: "url", fileId, url: match[2] ?? "" });
	}
	for (const match of filesSection.matchAll(EMBEDDED_LATEX)) {
		const fileId = match[1] ?? "";
		embeddedFiles.set(fileId, { kind: "latex", fileId, tex: (match[2] ?? "").trim() });
	}

	for (const element of scene.elements) {
		const text = textElements.get(element.id);
		// Before the `## Element Links` section existed (plugin 2.0.26), a
		// shape's link was written under Text Elements with the shape's id.
		if (text !== undefined && element.type !== "text") element.link = text.trim() || null;
		const link = elementLinks.get(element.id);
		if (link) element.link = link;
	}

	return {
		scene,
		textMode: frontmatter["excalidraw-plugin"] === "raw" ? "raw" : "parsed",
		frontmatter,
		textElements,
		embeddedFiles,
	};
}
