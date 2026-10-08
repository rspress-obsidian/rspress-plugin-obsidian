import { readFile } from "node:fs/promises";
import type { GraphSearchEntry } from "../types.js";
import type { DocumentText, GraphDocument } from "./documents.js";
import { toVisibleSource } from "./page-text.js";
import { PREVIEW_CONTENT_LENGTH, toPreviewText } from "./preview-content.js";

/** Reads in flight at once — a large vault would otherwise open one handle per note. */
const READ_CONCURRENCY = 16;

export interface PageContent {
	routePath: string;
	title: string;
	content: string;
}

/** A note's visible text from an earlier build, valid while its stamp matches. */
export type PageTextCache = Map<string, { stamp: string; visible: string }>;

/**
 * Derive both texts the client can ask for from each published note: the
 * hover-preview head and the full visible source the graph's `content:`,
 * `line:` and `section:` searches run against. A note unchanged since the last
 * build (same mtime and size) is not read again. Only routes Rspress still
 * publishes reach this, so a `publish: false` note's text never ships.
 */
export async function collectPageTexts(
	documents: GraphDocument[],
	withPreviews: boolean,
	cache: PageTextCache,
): Promise<{ previews: PageContent[]; search: GraphSearchEntry[]; filesRead: number }> {
	const previews: PageContent[] = [];
	const search: GraphSearchEntry[] = [];
	let filesRead = 0;
	const seen = new Set<string>();
	const readable = documents.filter((document) => document.text);

	const visibleText = async (text: DocumentText): Promise<string> => {
		seen.add(text.file);
		const cached = cache.get(text.file);
		if (cached && cached.stamp === text.stamp && text.source === undefined) return cached.visible;
		let source = text.source;
		if (source === undefined) {
			filesRead += 1;
			source = await readFile(text.file, "utf8");
		}
		const visible = toVisibleSource(source);
		cache.set(text.file, { stamp: text.stamp, visible });
		return visible;
	};

	for (let start = 0; start < readable.length; start += READ_CONCURRENCY) {
		const batch = await Promise.all(
			readable.slice(start, start + READ_CONCURRENCY).map(async (document) => {
				try {
					return document.text
						? { document, visible: await visibleText(document.text) }
						: undefined;
				} catch {
					// A note removed mid-build ships no text; its node stays.
					return undefined;
				}
			}),
		);
		for (const entry of batch) {
			if (!entry) continue;
			const { document, visible } = entry;
			search.push({ id: document.route.routePath, text: visible });
			if (withPreviews) {
				previews.push({
					routePath: document.route.routePath,
					title: document.label,
					// Strip markdown before slicing: the budget caps what ships, not what
					// is read. One character past the budget marks a truncated body.
					content: toPreviewText(visible).slice(0, PREVIEW_CONTENT_LENGTH + 1),
				});
			}
		}
	}
	// Forget notes that left the site, so the cache tracks the routes it serves.
	for (const file of cache.keys()) {
		if (!seen.has(file)) cache.delete(file);
	}
	return { previews, search, filesRead };
}

export function pageContentModuleSource(previews: PageContent[], base: string): string {
	return `export const base = ${JSON.stringify(base)};\nexport const pageContentData = JSON.parse(${JSON.stringify(JSON.stringify(previews))});\nexport default pageContentData;\n`;
}

export function searchModuleSource(search: GraphSearchEntry[]): string {
	return `export const searchEntries = JSON.parse(${JSON.stringify(JSON.stringify(search))});\nexport default searchEntries;\n`;
}
