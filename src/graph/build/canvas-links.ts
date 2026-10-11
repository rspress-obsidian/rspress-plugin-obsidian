import { extractPageLinks } from "../../markdown/page-links.js";
import type { ParsedWikiLink } from "../../markdown/types.js";

/**
 * What a `.canvas` board links to, the way Obsidian's graph reads one: each
 * file card is a link to that file, and each text card contributes the links
 * and tags its markdown contains. Link cards (web pages) and groups add
 * nothing. Unparseable JSON yields no links rather than failing the build.
 */
export function extractCanvasLinks(json: string): { outlinks: ParsedWikiLink[]; tags: string[] } {
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
		if (type === "file" && "file" in card && typeof card.file === "string" && card.file.trim()) {
			// Card paths are vault-root relative, which is exactly how an absolute
			// wikilink target is resolved.
			outlinks.push({
				raw: `![[${card.file}]]`,
				target: card.file,
				isEmbed: true,
				isCurrentPageReference: false,
			});
		} else if (type === "text" && "text" in card && typeof card.text === "string") {
			const extracted = extractPageLinks(card.text);
			outlinks.push(...extracted.outlinks);
			tags.push(...extracted.tags);
		}
	}
	return { outlinks, tags: [...new Set(tags)] };
}
