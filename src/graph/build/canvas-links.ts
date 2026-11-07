import { extractPageLinks } from "../../markdown/page-links.js";
import type { ParsedWikiLink } from "../../markdown/types.js";

/**
 * What a file card links to. Card paths are vault-root relative, which is
 * exactly how an absolute wikilink target is resolved.
 */
function fileCardLink(file: string): ParsedWikiLink {
	return { raw: `![[${file}]]`, target: file, isEmbed: true, isCurrentPageReference: false };
}

/**
 * What a `.canvas` board links to, the way Obsidian's graph reads one: each
 * file card is a link to that file, and each text card contributes the links
 * and tags its markdown contains. Link cards (web pages) and groups add
 * nothing. Unparseable JSON yields no links rather than failing the build.
 *
 * A file card's target follows the canvas feature's rule — `resolveFileNode`
 * in `src/canvas/index.ts` — which links a card only when the site publishes
 * the file behind it. A private file (`publish: false`, a dot or `_` segment,
 * an excluded folder, outside the vault) publishes nothing, not even its name,
 * so it adds no link here either; a file that does not exist at all is not
 * private, and Obsidian draws it as an unresolved node.
 */
export function extractCanvasLinks(
	json: string,
	isPrivateFile: (file: string) => boolean,
): { outlinks: ParsedWikiLink[]; tags: string[] } {
	let board: unknown;
	try {
		board = JSON.parse(json);
	} catch {
		return { outlinks: [], tags: [] };
	}
	const cards = board && typeof board === "object" && "nodes" in board ? board.nodes : undefined;
	if (!Array.isArray(cards)) return { outlinks: [], tags: [] };

	const outlinks: ParsedWikiLink[] = [];
	const tags: string[] = [];
	for (const card of cards) {
		if (!card || typeof card !== "object") continue;
		const type = "type" in card ? card.type : undefined;
		if (type === "text" && "text" in card && typeof card.text === "string") {
			const extracted = extractPageLinks(card.text);
			outlinks.push(...extracted.outlinks);
			tags.push(...extracted.tags);
			continue;
		}
		if (type !== "file" || !("file" in card) || typeof card.file !== "string") continue;
		if (!card.file.trim()) continue;
		if (isPrivateFile(card.file)) continue;
		outlinks.push(fileCardLink(card.file));
	}
	return { outlinks, tags: [...new Set(tags)] };
}
