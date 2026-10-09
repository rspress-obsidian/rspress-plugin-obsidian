import { readFile } from "node:fs/promises";
import type { GraphSearchEntry } from "../types.js";
import type { DocumentText, GraphDocument } from "./documents.js";
import { toVisibleSource } from "./page-text.js";

/** Reads in flight at once — a large vault would otherwise open one handle per note. */
const READ_CONCURRENCY = 16;

/** A note's visible text from an earlier build, valid while its stamp matches. */
export type PageTextCache = Map<string, { stamp: string; visible: string }>;

/**
 * Derive the full visible source of each published note, which the graph's
 * `content:`, `line:` and `section:` searches run against. A note unchanged
 * since the last build (same mtime and size) is not read again. Only routes
 * Rspress still publishes reach this, so a `publish: false` note's text never
 * ships.
 */
export async function collectPageTexts(
	documents: GraphDocument[],
	cache: PageTextCache,
): Promise<{ search: GraphSearchEntry[]; filesRead: number }> {
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
			if (entry) search.push({ id: entry.document.route.routePath, text: entry.visible });
		}
	}
	// Forget notes that left the site, so the cache tracks the routes it serves.
	for (const file of cache.keys()) {
		if (!seen.has(file)) cache.delete(file);
	}
	return { search, filesRead };
}

export function searchModuleSource(search: GraphSearchEntry[]): string {
	return `export const searchEntries = JSON.parse(${JSON.stringify(JSON.stringify(search))});\nexport default searchEntries;\n`;
}
