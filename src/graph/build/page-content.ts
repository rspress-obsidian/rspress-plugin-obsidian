import { readFile } from "node:fs/promises";
import type { GraphBuildCache } from "./cache";
import { extractDisplayTitle } from "./link-extractor";
import type { CollectedRoute } from "./types";

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

	for (const route of routes) {
		const cachedDocument = cache.documents.get(route.absolutePath);
		if (!cachedDocument) continue;

		try {
			const rawContent = await readFile(route.absolutePath, "utf8");
			const title = cachedDocument.inferredTitle ?? extractDisplayTitle(rawContent);
			// Strip frontmatter for preview content
			const content = rawContent.replace(/^---[\s\S]*?---\s*/, "").trim();
			pageContents.push({
				routePath: route.routePath,
				title: title ?? route.pageName,
				content,
			});
		} catch {
			// Skip files that can't be read
		}
	}

	const moduleSource = `export const pageContentData = ${JSON.stringify(pageContents)}; export default pageContentData;`;
	return { moduleSource };
}
