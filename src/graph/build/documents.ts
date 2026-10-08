import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { getCachedContentIndex } from "../../markdown/content-index.js";
import { extractPageLinks } from "../../markdown/page-links.js";
import type {
	ContentIndex,
	ContentPage,
	ParsedWikiLink,
	ResolveContext,
} from "../../markdown/types.js";
import { type CanvasBoardRoute, findCanvasBoardByRoute } from "../../shared/canvas-routes.js";
import { parseFrontmatter } from "../../shared/frontmatter.js";
import { getPublishedContent } from "../../shared/published-content.js";
import { normalizeFsPath } from "../../shared/route-path.js";
import { extractCanvasLinks } from "./canvas-links.js";
import type { CollectedRoute } from "./types.js";

/** The tag-page routes the markdown plugin generates (`tagRoutePath`). */
export const TAG_ROUTE_PREFIX = "/tags/";

/** One route of the site as the graph sees it, before any link is resolved. */
export interface GraphDocument {
	route: CollectedRoute;
	kind: "page" | "tag";
	label: string;
	/** File path relative to its root (vault or docs), for `path:`/`file:` queries. */
	path: string;
	/** Absolute source file, normalized with forward slashes; how resolved pages map back to routes. */
	filePath?: string;
	ctime: number;
	outlinks: ParsedWikiLink[];
	tags: string[];
	/** How this document's links resolve; absent for documents with nothing to resolve. */
	context?: ResolveContext;
	/** Where the hover preview and graph search text comes from. */
	text?: DocumentText;
}

/**
 * A markdown file whose text the hover preview and graph search ship, with a
 * stamp (mtime and size) that says when a cached copy is still current, and
 * the source itself when this build already read it.
 */
export interface DocumentText {
	file: string;
	stamp: string;
	source?: string;
}

/** Route bookkeeping decided without reading any file, so an unchanged site can be detected cheaply. */
interface DocumentPlan {
	route: CollectedRoute;
	type: "tag" | "board" | "indexed" | "generated" | "file";
	page?: ContentPage;
	index?: ContentIndex;
	board?: CanvasBoardRoute;
}

export interface GraphDocumentPlan {
	indexes: ContentIndex[];
	plans: DocumentPlan[];
	/** Changes whenever a file the content indexes do not track (a board, an unindexed page) changes. */
	untrackedSignature: string;
	resolveOptions: NonNullable<ResolveContext["options"]>;
	docsIndex: ContentIndex;
	vaultIndex?: ContentIndex;
	vaultRoot?: string;
}

/**
 * Index the published content the markdown plugin indexes — the same cached
 * `getCachedContentIndex` entries with the same options when `markdown()` is
 * installed, so the graph resolves every link exactly as the page and its
 * Backlinks pane do — and classify each Rspress route against it.
 */
export async function planGraphDocuments(
	routes: CollectedRoute[],
	fallbackDocsRoot: string,
): Promise<GraphDocumentPlan> {
	const published = getPublishedContent();
	const docsRoot = published?.docsRoot ?? fallbackDocsRoot;
	const docsIndex = await getCachedContentIndex(docsRoot, published?.docsIndexOptions ?? {});
	const vaultRoot = published?.vaultRoot;
	const vaultIndex = vaultRoot
		? await getCachedContentIndex(
				vaultRoot,
				published?.vaultIndexOptions ?? { routePrefix: published?.vaultRoutePrefix },
			)
		: undefined;

	const pageByFile = new Map<string, { page: ContentPage; index: ContentIndex }>();
	for (const index of vaultIndex ? [docsIndex, vaultIndex] : [docsIndex]) {
		for (const page of index.pages) {
			pageByFile.set(normalizeFsPath(page.absolutePath), { page, index });
		}
	}

	const plans: DocumentPlan[] = [];
	const untracked: string[] = [];
	for (const route of routes) {
		if (route.routePath.startsWith(TAG_ROUTE_PREFIX)) {
			plans.push({ route, type: "tag" });
			continue;
		}
		// A board's route points at the temp page the canvas feature handed
		// Rspress; its links live in the original `.canvas` file.
		const board = findCanvasBoardByRoute(route.routePath);
		if (board) {
			plans.push({ route, type: "board", board });
			untracked.push(await fileStamp(board.absolutePath));
			continue;
		}
		const indexed = pageByFile.get(normalizeFsPath(route.absolutePath));
		if (indexed) {
			plans.push({ route, type: "indexed", ...indexed });
			continue;
		}
		if (isGeneratedPage(route.absolutePath)) {
			plans.push({ route, type: "generated" });
			continue;
		}
		plans.push({ route, type: "file" });
		untracked.push(await fileStamp(route.absolutePath));
	}

	return {
		indexes: vaultIndex ? [docsIndex, vaultIndex] : [docsIndex],
		plans,
		untrackedSignature: untracked.join("|"),
		resolveOptions: {
			enableCaseInsensitiveLookup: published?.enableCaseInsensitiveLookup ?? true,
			enableFuzzyMatching: published?.enableFuzzyMatching ?? false,
		},
		docsIndex,
		vaultIndex,
		vaultRoot,
	};
}

/** Read what the plan could not take from the indexes and describe every route. */
export async function loadGraphDocuments(
	plan: GraphDocumentPlan,
): Promise<{ documents: GraphDocument[]; filesRead: number }> {
	let filesRead = 0;
	const contextFor = (page: ContentPage, index: ContentIndex): ResolveContext => {
		const other = index === plan.docsIndex ? plan.vaultIndex : plan.docsIndex;
		return {
			currentPage: page,
			index,
			options: plan.resolveOptions,
			fallbackIndexes: other && other !== index ? [other] : [],
		};
	};
	const indexFor = (absolutePath: string): { index: ContentIndex; root: string } =>
		plan.vaultIndex && plan.vaultRoot && isInside(absolutePath, plan.vaultRoot)
			? { index: plan.vaultIndex, root: plan.vaultRoot }
			: { index: plan.docsIndex, root: plan.docsIndex.rootDir };

	const documents = await Promise.all(
		plan.plans.map(async ({ route, type, page, index, board }): Promise<GraphDocument> => {
			const base: GraphDocument = {
				route,
				kind: "page",
				label: routeLabel(route.routePath),
				path: "",
				ctime: 0,
				outlinks: [],
				tags: [],
			};
			if (type === "tag") {
				return {
					...base,
					kind: "tag",
					label: `#${safeDecode(route.routePath.slice(TAG_ROUTE_PREFIX.length))}`,
				};
			}
			if (type === "indexed" && page && index) {
				return {
					...base,
					label:
						page.title ??
						// A docs page's title is Rspress's: its first H1 (code excluded by
						// the index). A vault note is labelled by its file name, as in
						// Obsidian's own graph.
						(index === plan.docsIndex
							? page.headings.find((heading) => heading.depth === 1)?.rawText
							: undefined) ??
						fileLabel(page.relativePath, route.routePath),
					path: normalizeFsPath(page.relativePath),
					filePath: normalizeFsPath(page.absolutePath),
					ctime: page.fileCtimeMs,
					outlinks: page.outlinks ?? [],
					tags: page.tags,
					context: contextFor(page, index),
					text: {
						file: page.absolutePath,
						stamp: `${page.fileMtimeMs}:${page.fileSizeBytes}`,
					},
				};
			}
			if (type === "board" && board) {
				const owner = indexFor(board.absolutePath);
				const relativePath = normalizeFsPath(path.relative(owner.root, board.absolutePath));
				let json = "";
				let ctime = 0;
				try {
					filesRead += 1;
					json = await readFile(board.absolutePath, "utf8");
					ctime = (await stat(board.absolutePath)).birthtimeMs;
				} catch {
					// A board removed mid-build keeps its node and loses its links.
				}
				const { outlinks, tags } = extractCanvasLinks(json);
				const boardPage = syntheticPage(board.absolutePath, relativePath, route.routePath);
				return {
					...base,
					label: path.basename(board.source),
					path: normalizeFsPath(board.source),
					filePath: normalizeFsPath(board.absolutePath),
					ctime,
					outlinks,
					tags,
					context: contextFor(boardPage, owner.index),
				};
			}
			if (type === "file" && /\.mdx?$/i.test(route.absolutePath)) {
				// A page Rspress routes that no index covers (another plugin's
				// `addPages` file): extract its links with the indexer's own rules
				// and resolve them from the docs root.
				let source: string;
				let ctime = 0;
				let stamp = "";
				try {
					filesRead += 1;
					source = await readFile(route.absolutePath, "utf8");
					const stats = await stat(route.absolutePath);
					ctime = stats.birthtimeMs;
					stamp = `${stats.mtimeMs}:${stats.size}`;
				} catch {
					return base;
				}
				const relativePath = normalizeFsPath(
					path.relative(plan.docsIndex.rootDir, route.absolutePath),
				);
				const { outlinks, tags } = extractPageLinks(source);
				return {
					...base,
					label: frontmatterTitle(source) ?? fileLabel(relativePath, route.routePath),
					path: relativePath,
					filePath: normalizeFsPath(route.absolutePath),
					ctime,
					outlinks,
					tags,
					context: contextFor(
						syntheticPage(route.absolutePath, relativePath, route.routePath),
						plan.docsIndex,
					),
					text: { file: route.absolutePath, stamp, source },
				};
			}
			// Generated listing pages (tag index, calendars) only restate links that
			// real notes already make, so they are nodes without outgoing links.
			return base;
		}),
	);
	return { documents, filesRead };
}

async function fileStamp(absolutePath: string): Promise<string> {
	try {
		const { mtimeMs, size } = await stat(absolutePath);
		return `${absolutePath}:${mtimeMs}:${size}`;
	} catch {
		return `${absolutePath}:missing`;
	}
}

/** Rspress writes `addPages` content to `node_modules/.rspress/runtime/temp-*.mdx`. */
function isGeneratedPage(absolutePath: string): boolean {
	return normalizeFsPath(absolutePath).split("/").includes("node_modules");
}

function isInside(file: string, root: string): boolean {
	const relative = path.relative(root, file);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/**
 * Obsidian labels a graph node with the file's name. An `index` file names its
 * folder (the docs home page is "Home" when it has no title); a `.mdx`
 * extension is dropped like `.md`.
 */
function fileLabel(relativePath: string, routePath: string): string {
	const name = path.posix.basename(normalizeFsPath(relativePath)).replace(/\.mdx?$/i, "");
	if (name.toLowerCase() !== "index") return name;
	return routeLabel(routePath);
}

function routeLabel(routePath: string): string {
	const segments = routePath.split("/").filter(Boolean);
	const last = segments[segments.length - 1];
	return last ? safeDecode(last) : "Home";
}

function frontmatterTitle(source: string): string | undefined {
	try {
		const title = parseFrontmatter(source).data.title;
		return typeof title === "string" && title.trim() ? title.trim() : undefined;
	} catch {
		return undefined;
	}
}

/**
 * A resolution context for a file the index does not hold as a page (a canvas
 * board, an unindexed route): only its location matters, for relative links
 * and same-folder preference.
 */
function syntheticPage(absolutePath: string, relativePath: string, routePath: string): ContentPage {
	const filePathKey = relativePath.replace(/\.(?:mdx?|canvas)$/i, "");
	return {
		absolutePath,
		relativePath,
		routePath,
		pathKey: filePathKey,
		filePathKey,
		baseName: path.posix.basename(filePathKey),
		aliases: [],
		tags: [],
		cssclasses: [],
		publish: true,
		fileCtimeMs: 0,
		fileMtimeMs: 0,
		fileSizeBytes: 0,
		headings: [],
		wikilinkTargets: [],
		outlinks: [],
		headingBySlug: new Map(),
		headingByText: new Map(),
		blocks: [],
		dataviewFields: {},
		dataviewTasks: [],
		dataviewLists: [],
	};
}
