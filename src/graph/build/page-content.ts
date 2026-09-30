import { readFile } from "node:fs/promises";
import type { GraphBuildCache } from "./cache.js";
import { extractDisplayTitle } from "./link-extractor.js";
import { PREVIEW_CONTENT_LENGTH, toPreviewText } from "./preview-content.js";
import type { CollectedRoute } from "./types.js";

/** Reads in flight at once — a large vault would otherwise open one handle per note. */
const READ_CONCURRENCY = 16;

export interface PageContent {
	routePath: string;
	title: string;
	content: string;
}

export async function buildPageContentModule(
	routes: CollectedRoute[],
	cache: GraphBuildCache,
): Promise<{ moduleSource: string }> {
	const pageContents: PageContent[] = [];

	for (let start = 0; start < routes.length; start += READ_CONCURRENCY) {
		const batch = await Promise.all(
			routes.slice(start, start + READ_CONCURRENCY).map((route) => loadPageContent(route, cache)),
		);
		for (const page of batch) {
			if (page) pageContents.push(page);
		}
	}

	const moduleSource = `export const pageContentData = ${JSON.stringify(pageContents)}; export default pageContentData;`;
	return { moduleSource };
}

async function loadPageContent(
	route: CollectedRoute,
	cache: GraphBuildCache,
): Promise<PageContent | null> {
	const cachedDocument = cache.documents.get(route.absolutePath);
	if (!cachedDocument) return null;

	try {
		const rawContent = await readFile(route.absolutePath, "utf8");
		const title = cachedDocument.inferredTitle ?? extractDisplayTitle(rawContent);
		// Strip frontmatter; only the preview head is shipped to the client.
		const body = toPreviewText(rawContent.replace(/^---[\s\S]*?---\s*/, ""));
		return {
			routePath: route.routePath,
			title: title ?? route.pageName,
			// Strip markdown before slicing: the budget caps what ships, not what is read.
			// One character past the budget marks the body as truncated for the client.
			content: body.slice(0, PREVIEW_CONTENT_LENGTH + 1),
		};
	} catch {
		// Skip files that can't be read
		return null;
	}
}
