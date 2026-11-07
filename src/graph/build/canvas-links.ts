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
 * `publishedExactly` reports whether the site publishes that exact path — the
 * same rule `resolveFileNode` in `src/canvas/index.ts` applies with
 * `findPageByPath` / `findAssetByPath`. A card the canvas renders as missing
 * or private adds no link, so the graph never connects `old/Note.md` to a
 * `new/Note.md` that only the resolver's name fallback would find.
 */
export function extractCanvasLinks(
	json: string,
	cardState: (file: string) => "link" | "ghost" | "none",
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
		const state = cardState(card.file);
		if (state === "none") continue;
		const link = fileCardLink(card.file);
		if (state === "ghost") link.ghost = true;
		outlinks.push(link);
	}
	return { outlinks, tags: [...new Set(tags)] };
}
