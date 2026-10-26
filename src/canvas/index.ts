import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RspressPlugin } from "@rspress/core";
import { deferInvalidationPlugin } from "../dev-invalidation.js";
import { KATEX_STYLESHEET_PATH, katexStylesheetPlugin } from "../katex-stylesheet.js";
import { removeAllComments } from "../markdown/comments.js";
import {
	buildContentIndex,
	getCachedContentIndex,
	isRoutableRelativePath,
} from "../markdown/content-index.js";
import { linkContentIndexes } from "../markdown/linked-indexes.js";
import { parseWikiLink } from "../markdown/parse-wikilink.js";
import { resolveWikiLink } from "../markdown/resolve-wikilink.js";
import type { ContentAsset, ContentIndex, ContentPage, ResolveContext } from "../markdown/types.js";
import {
	type DirectoryListings,
	findAssetByPath,
	findPageByPath,
	isPrivateVaultFile,
} from "../markdown/vault-files.js";
import { mermaidBuilderConfig } from "../mermaid/install.js";
import { moduleDir, resolveRuntimeFile } from "../runtime-paths.js";
import {
	attachCanvasBoards,
	type CanvasBoardRoute,
	type CanvasBoards,
	createCanvasBoards,
} from "../shared/canvas-routes.js";
import { NOTE_MARKDOWN_EXTENSIONS } from "../shared/extensions.js";
import { stripFrontmatter } from "../shared/frontmatter.js";
import { AUDIO_EXTS, extensionOf, IMAGE_EXTS, PDF_EXT, VIDEO_EXTS } from "../shared/media-exts.js";
import { normalizeFilePathKey } from "../shared/paths.js";
import { findPublishedContent, type PublishedContentConfig } from "../shared/published-content.js";
import { normalizeFsPath, normalizeRoutePrefix } from "../shared/route-path.js";
import { extractBlockSection, extractHeadingSection } from "../shared/transclusion.js";
import { DEFAULT_IFRAME_SANDBOX } from "./constants.js";
import { parseCanvas } from "./parser.js";
import type {
	CanvasData,
	CanvasFileKind,
	CanvasLink,
	CanvasNode,
	CanvasPluginOptions,
	CanvasResolvedFile,
} from "./types.js";
import { canvasLinkKey, normalizeAssetKey } from "./utils/asset-key.js";
import { normalizeSiteBase } from "./utils/base.js";
import { anchorHref, collectMarkdownTargets } from "./utils/markdown.js";

const LOG_PREFIX = "[rspress-plugin-obsidian:canvas]";

/** URL directory (under the site base) the published board JSON is served from. */
export const CANVAS_JSON_DIR = "__canvases__";

/**
 * Transclusion depth the client renders before it falls back to a link (see
 * `renderMarkdown`). Links inside notes deeper than this are never rendered,
 * so they are not resolved either.
 */
const MAX_TRANSCLUSION_DEPTH = 2;

/**
 * Default home of the files this plugin publishes: board JSON and the
 * attachments boards reference. It is plugin-owned and rebuilt from scratch on
 * every build, so a deleted board or attachment disappears with it; nothing is
 * written into the site's own `public/` directory.
 */
const DEFAULT_OUT_DIR = path.join("node_modules", ".rspress-plugin-obsidian", "canvas");

function normalizeRelativePath(value: string): string {
	return value
		.replace(/\\/g, "/")
		.split("/")
		.filter((segment) => segment && segment !== "." && segment !== "..")
		.join("/");
}

function resolveCanvasRoute(filePath: string, vaultRoot: string, routePrefix: string): string {
	const relativePath = normalizeRelativePath(path.relative(vaultRoot, filePath)).replace(
		/\.canvas$/i,
		"",
	);
	const routeParts = relativePath
		.split("/")
		.filter(Boolean)
		.map((part) => part.replace(/\s+/g, "-").toLowerCase());
	const prefix = `/${normalizeRelativePath(routePrefix)}`.replace(/\/{2,}/g, "/");
	return `${prefix}/${routeParts.join("/")}`.replace(/\/{2,}/g, "/");
}

/** The kind a file node renders as, by extension. */
function fileKind(file: string): CanvasFileKind {
	const extension = extensionOf(file);
	if (NOTE_MARKDOWN_EXTENSIONS.has(`.${extension}`)) return "note";
	if (extension === "canvas") return "canvas";
	if (IMAGE_EXTS.has(extension)) return "image";
	if (AUDIO_EXTS.has(extension)) return "audio";
	if (VIDEO_EXTS.has(extension)) return "video";
	if (extension === PDF_EXT) return "pdf";
	return "file";
}

/**
 * A page standing in for the board itself, so links written in a text card
 * resolve the way Obsidian resolves them: relative paths from the board's
 * folder, everything else vault-wide. It has no headings or blocks of its own.
 */
function boardPage(relativePath: string, absolutePath: string): ContentPage {
	const filePathKey = normalizeFilePathKey(relativePath);
	return {
		absolutePath,
		relativePath,
		routePath: `/${filePathKey}`,
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
		headingBySlug: new Map(),
		headingByText: new Map(),
		blocks: [],
		dataviewFields: {},
		dataviewTasks: [],
		dataviewLists: [],
	} as ContentPage;
}

/** Everything one build shares across boards. */
interface PublishContext {
	vaultRoot: string;
	index: ContentIndex;
	resolveOptions: ResolveContext["options"];
	outDir: string;
	/** Attachments already copied this build, by absolute source path. */
	copied: Map<string, Promise<boolean>>;
	/** Note bodies already read this build, by absolute path. */
	noteBodies: Map<string, Promise<string | null>>;
	/** The resolver reports an attachment by its URL; this maps it back. */
	assetsByUrl: Map<string, ContentAsset>;
	/** Vault directories read this build by the private-file check. */
	listings: DirectoryListings;
}

/** Whether a path a board names is on disk but unpublished (see {@link isPrivateVaultFile}). */
function isPrivate(file: string, context: PublishContext): boolean {
	return isPrivateVaultFile(
		context.index,
		context.vaultRoot,
		file,
		(board) => context.resolveOptions?.canvasBoards?.bySource(board, true) !== undefined,
		context.listings,
	);
}

/**
 * Copy an attachment to the URL it is served at, once per build. The URL is
 * the content index's own (`<fileRoutePrefix>/<vault path>`), the same one the
 * Markdown plugin gives the file, so a card and a note never disagree.
 */
function publishAsset(asset: ContentAsset, context: PublishContext): Promise<boolean> {
	let pending = context.copied.get(asset.absolutePath);
	if (!pending) {
		const segments = asset.urlPath
			.split("/")
			.filter(Boolean)
			.map((segment) => decodeURIComponent(segment));
		const target = path.join(context.outDir, ...segments);
		pending = (async () => {
			try {
				await mkdir(path.dirname(target), { recursive: true });
				await copyFile(asset.absolutePath, target);
				return true;
			} catch (error) {
				console.warn(`${LOG_PREFIX} Could not publish attachment: ${asset.relativePath}`, error);
				return false;
			}
		})();
		context.copied.set(asset.absolutePath, pending);
	}
	return pending;
}

/**
 * A note's body as a card shows it: no frontmatter, no `%%comments%%` and no
 * `<!-- comments -->`. The board JSON is public and the browser renders it, so
 * anything the note page hides has to be gone before it is written. Comments
 * are found in the whole file, as the page finds them, so a body that opens
 * with a `---` rule is not mistaken for frontmatter.
 */
function readNoteBody(page: ContentPage, context: PublishContext): Promise<string | null> {
	let pending = context.noteBodies.get(page.absolutePath);
	if (!pending) {
		pending = readFile(page.absolutePath, "utf-8").then(
			(content) =>
				removeAllComments(content, { from: content.length - stripFrontmatter(content).length }),
			() => null,
		);
		context.noteBodies.set(page.absolutePath, pending);
	}
	return pending;
}

/** Per-board output: the maps the enriched JSON carries. */
interface BoardMaps {
	assets: Record<string, string>;
	notes: Record<string, string>;
	links: Record<string, Record<string, CanvasLink>>;
}

async function registerAsset(
	asset: ContentAsset,
	context: PublishContext,
	maps: BoardMaps,
): Promise<string | undefined> {
	if (!(await publishAsset(asset, context))) return undefined;
	const key = normalizeAssetKey(asset.relativePath);
	maps.assets[key] = asset.urlPath;
	return key;
}

async function registerNote(
	page: ContentPage,
	context: PublishContext,
	maps: BoardMaps,
): Promise<string | undefined> {
	const body = await readNoteBody(page, context);
	if (body === null) {
		console.warn(`${LOG_PREFIX} Could not load vault file: ${page.relativePath}`);
		return undefined;
	}
	const key = normalizeAssetKey(page.relativePath);
	maps.notes[key] = body;
	return key;
}

/**
 * Resolve one target written in card markdown with the Markdown plugin's
 * resolver, publishing whatever it names. A note the reader cannot see
 * (`publish: false`, or missing) is not in the index, so it resolves to an
 * empty entry and its text never reaches the board.
 */
async function resolveCardTarget(
	target: string,
	embed: boolean,
	page: ContentPage,
	context: PublishContext,
	maps: BoardMaps,
): Promise<{ link: CanvasLink; note?: ContentPage }> {
	const key = canvasLinkKey(target);
	const raw = `${embed ? "!" : ""}[[${key}]]`;
	const parsed = parseWikiLink(key, raw);
	const resolveContext: ResolveContext = {
		currentPage: page,
		index: context.index,
		options: context.resolveOptions,
	};
	let resolved = resolveWikiLink(parsed, resolveContext);
	// Obsidian opens the note when a heading or block is missing; only the
	// fragment is lost.
	if (resolved.status === "broken-anchor" && parsed.subpath && parsed.target) {
		resolved = resolveWikiLink({ ...parsed, subpath: undefined }, resolveContext);
	}
	if (resolved.status !== "ok") return { link: {} };

	const link: CanvasLink = {};
	if (resolved.href) link.href = resolved.href;
	if (resolved.label) link.label = resolved.label;
	if (resolved.canvasSrc !== undefined) return { link };
	if (resolved.targetPage) {
		if (resolved.targetPage === page) return { link };
		if (embed) {
			const note = await registerNote(resolved.targetPage, context, maps);
			if (note) {
				link.note = note;
				return { link, note: resolved.targetPage };
			}
		}
		return { link };
	}

	const asset = context.assetsByUrl.get(resolved.href?.split("#")[0] ?? "");
	if (asset) {
		const assetKey = await registerAsset(asset, context, maps);
		if (assetKey) link.asset = assetKey;
	}
	return { link };
}

/**
 * Resolve every link and embed in one markdown source, then in each note it
 * transcludes, down to the depth the client renders.
 */
async function resolveMarkdownLinks(
	sources: { scope: string; text: string; page: ContentPage; depth: number }[],
	context: PublishContext,
	maps: BoardMaps,
): Promise<void> {
	// Breadth-first, so a note reached at two depths is resolved at the
	// shallower one, where the client renders the most of it.
	const queue = [...sources];
	const visited = new Set<string>();
	for (let item = queue.shift(); item; item = queue.shift()) {
		if (visited.has(item.scope)) continue;
		visited.add(item.scope);
		const scoped: Record<string, CanvasLink> = {};
		maps.links[item.scope] = scoped;
		const targets = collectMarkdownTargets(item.text);
		// One resolution per target. It transcludes when any occurrence is a
		// wikilink embed; a markdown `![](…)` embeds attachments only, and a
		// markdown link to a note is always a link.
		const embeds = new Map<string, boolean>();
		for (const { target, embed } of targets.wikilinks) {
			const key = canvasLinkKey(target);
			embeds.set(key, (embeds.get(key) ?? false) || embed);
		}
		for (const url of targets.urls) {
			const key = canvasLinkKey(url);
			if (!embeds.has(key)) embeds.set(key, false);
		}
		for (const [key, embed] of embeds) {
			const { link, note } = await resolveCardTarget(key, embed, item.page, context, maps);
			scoped[key] = link;
			if (note && link.note && item.depth + 1 < MAX_TRANSCLUSION_DEPTH) {
				const body = maps.notes[link.note];
				if (body !== undefined) {
					queue.push({ scope: link.note, text: body, page: note, depth: item.depth + 1 });
				}
			}
		}
	}
}

async function resolveFileNode(
	node: Extract<CanvasNode, { type: "file" }>,
	context: PublishContext,
	maps: BoardMaps,
): Promise<{ resolved: CanvasResolvedFile; note?: ContentPage }> {
	// Not published: missing, or on disk but private (`publish: false`, a dot,
	// `_`-prefixed or excluded folder, outside the vault). A private file's card
	// says the file is unavailable and its name is never published.
	const unavailable = (): { resolved: CanvasResolvedFile } => ({
		resolved: { kind: isPrivate(node.file, context) ? "private" : "missing" },
	});
	const kind = fileKind(node.file);
	if (kind === "note") {
		const page = findPageByPath(context.index, node.file);
		if (!page) return unavailable();
		const key = await registerNote(page, context, maps);
		if (!key) return { resolved: { kind: "missing" } };
		const route = `/${page.routePath.replace(/^\/+/, "")}`;
		const resolved: CanvasResolvedFile = { kind, key, href: anchorHref(route, node.subpath) };
		if (node.subpath) {
			// The whole note stays on the card when the subpath names nothing (the
			// documented fallback); the card says so and links to the note itself.
			const anchor = node.subpath.replace(/^#/, "");
			const body = maps.notes[key] ?? "";
			const section = anchor.startsWith("^")
				? extractBlockSection(body, anchor.slice(1))
				: extractHeadingSection(body, anchor);
			if (anchor && section === undefined) {
				resolved.missingSubpath = true;
				resolved.href = route;
			}
		}
		return { resolved, note: page };
	}
	if (kind === "canvas") {
		const board = context.resolveOptions?.canvasBoards?.bySource(node.file, true);
		return board ? { resolved: { kind, href: board.routePath } } : unavailable();
	}
	const asset = findAssetByPath(context.index, node.file);
	if (!asset) return unavailable();
	const key = await registerAsset(asset, context, maps);
	return { resolved: key ? { kind, key } : { kind: "missing" } };
}

/**
 * Turn a source board into the published one: resolve every file node, group
 * background and card link, publish the attachments they name, and carry the
 * results in one JSON document. Every attachment is stored once, as a URL in
 * `assets`; nodes and links refer to it by key.
 */
async function enrichCanvas(
	canvasJson: string,
	board: CanvasBoardRoute,
	context: PublishContext,
): Promise<string> {
	const canvasData = parseCanvas(canvasJson);

	// A dropped node is a silent content loss unless it is reported, so the
	// tolerance in `parseCanvas` is only safe because this prints what it skipped.
	for (const problem of canvasData.problems ?? []) {
		console.warn(`${LOG_PREFIX} ${problem}`);
	}
	delete canvasData.problems;

	const maps: BoardMaps = { assets: {}, notes: {}, links: {} };
	const page = boardPage(board.source, board.absolutePath);
	const sources: { scope: string; text: string; page: ContentPage; depth: number }[] = [];
	const boardText: string[] = [];

	for (const node of canvasData.nodes) {
		if (node.type === "text") {
			// A card has no frontmatter: a leading `---` pair is two rules.
			node.text = removeAllComments(node.text, { fragment: true });
			boardText.push(node.text);
		} else if (node.type === "file") {
			const { resolved, note } = await resolveFileNode(node, context, maps);
			node.resolvedFile = resolved;
			if (resolved.kind === "private" || resolved.kind === "missing") {
				console.warn(`${LOG_PREFIX} Could not load vault file: ${node.file}`);
			}
			if (resolved.kind === "private") {
				// The path names an unpublished file; the card only needs to know
				// there is nothing to show.
				node.file = "";
				delete node.subpath;
			}
			if (note && resolved.key) {
				const body = maps.notes[resolved.key];
				if (body !== undefined)
					sources.push({ scope: resolved.key, text: body, page: note, depth: 0 });
			}
		} else if (node.type === "group" && node.background) {
			const asset = findAssetByPath(context.index, node.background);
			const key = asset ? await registerAsset(asset, context, maps) : undefined;
			if (key) node.resolvedBackground = key;
			// Like a file card's path: an unpublished file is not named.
			else if (isPrivate(node.background, context)) delete node.background;
		}
	}
	if (boardText.length > 0) {
		sources.unshift({ scope: "", text: boardText.join("\n\n"), page, depth: 0 });
	}
	await resolveMarkdownLinks(sources, context, maps);

	const published: CanvasData = { ...canvasData };
	if (Object.keys(maps.assets).length > 0) published.assets = maps.assets;
	if (Object.keys(maps.notes).length > 0) published.notes = maps.notes;
	const links = Object.fromEntries(
		Object.entries(maps.links).filter(([, targets]) => Object.keys(targets).length > 0),
	);
	if (Object.keys(links).length > 0) published.links = links;
	return JSON.stringify(published);
}

export { CanvasParseError, parseCanvas, serializeCanvas } from "./parser.js";
export type {
	BackgroundStyle,
	CanvasColor,
	CanvasData,
	CanvasEdgeData,
	CanvasFileData,
	CanvasFileKind,
	CanvasGroupData,
	CanvasLink,
	CanvasLinkData,
	CanvasLinks,
	CanvasNode,
	CanvasNodeData,
	CanvasPluginOptions,
	CanvasResolvedFile,
	CanvasTextData,
	EdgeEnd,
	NodeSide,
	NodeType,
} from "./types.js";
export { renderMarkdown, sanitizeUrl } from "./utils/markdown.js";
export { resolveFileRoute } from "./utils/resolver.js";

/**
 * Skipped no matter what `exclude` says. The default `include`
 * (`**\/*.canvas`) walks the whole tree, so without these a dependency
 * install, a build output or VCS metadata inside the vault costs glob time at
 * best and publishes a stray canvas from `node_modules` at worst. User
 * entries are appended to this list, so `exclude` adds patterns rather than
 * replacing them.
 */
const DEFAULT_EXCLUDES = [
	"**/node_modules/**",
	"**/dist/**",
	"**/.git/**",
	"**/doc_build/**",
	"**/coverage/**",
];

/**
 * `canvasFiles.map(...)` under `Promise.all` starts a read, a copy and a
 * resolution pass for every board at once; a vault with hundreds of canvases
 * spikes open descriptors and memory together. Eight in flight keeps the disk
 * busy without the cliff, and results keep input order.
 */
async function mapWithLimit<T, R>(
	items: readonly T[],
	limit: number,
	worker: (item: T) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		for (;;) {
			const index = next;
			next += 1;
			if (index >= items.length) return;
			results[index] = await worker(items[index] as T);
		}
	});
	await Promise.all(runners);
	return results;
}

/**
 * Which of the Markdown plugin's trees `vaultRoot` is — `"vault"` or
 * `"docs"` — or `undefined` when that plugin does not publish this root.
 */
function sharedTree(
	vaultRoot: string,
	published: PublishedContentConfig | undefined,
): "vault" | "docs" | undefined {
	if (!published) return undefined;
	const root = normalizeFsPath(path.resolve(vaultRoot));
	const sameRoot = (candidate: string | undefined) =>
		candidate !== undefined && normalizeFsPath(path.resolve(candidate)) === root;
	if (published.vaultIndexOptions && sameRoot(published.vaultRoot)) return "vault";
	return sameRoot(published.docsRoot) ? "docs" : undefined;
}

/** The content index the site's Markdown plugin publishes this vault with, or our own. */
async function loadVaultIndex(
	vaultRoot: string,
	fileRoutePrefix: string | undefined,
	published: PublishedContentConfig | undefined,
): Promise<{ index: ContentIndex; resolveOptions: ResolveContext["options"] }> {
	const resolveOptions = {
		enableCaseInsensitiveLookup: published?.enableCaseInsensitiveLookup ?? true,
		enableFuzzyMatching: published?.enableFuzzyMatching ?? false,
	};
	// Sharing the Markdown plugin's indexes (and its options) means a card link
	// resolves to exactly the route the note page was published at, and — as on
	// a note page — falls back to the site's other tree.
	const tree = sharedTree(vaultRoot, published);
	if (published && tree) {
		const [docs, vault] = await Promise.all([
			getCachedContentIndex(published.docsRoot, published.docsIndexOptions),
			published.vaultRoot && published.vaultIndexOptions
				? getCachedContentIndex(published.vaultRoot, published.vaultIndexOptions)
				: undefined,
		]);
		const linked = linkContentIndexes(docs, vault);
		return { index: (tree === "vault" ? linked.vault : undefined) ?? linked.docs, resolveOptions };
	}
	return {
		index: await buildContentIndex(vaultRoot, {
			routePrefix: normalizeRoutePrefix(fileRoutePrefix),
		}),
		resolveOptions,
	};
}

/**
 * Every board to publish, with its route. A board sits under the same rules
 * as a note: none in a `_`-prefixed folder (fast-glob already skips dot
 * folders), and, when the Markdown plugin publishes this root, none in the
 * folders it excludes — `include`/`exclude` narrow that further.
 */
async function scanBoards(
	vaultRoot: string,
	published: PublishedContentConfig | undefined,
	options: { include: string[]; exclude: string[]; routePrefix: string },
): Promise<CanvasBoardRoute[]> {
	const tree = sharedTree(vaultRoot, published);
	const excludeFolders = (
		(tree === "vault"
			? published?.vaultIndexOptions?.excludeFolders
			: tree === "docs"
				? published?.docsIndexOptions.excludeFolders
				: undefined) ?? []
	)
		.map((folder) => normalizeFsPath(folder).replace(/^\/+|\/+$/g, ""))
		.filter(Boolean);
	// Runtime loading keeps fast-glob server-only in the published package.
	const { default: glob } = await import("fast-glob");
	const canvasFiles = await glob(options.include, {
		ignore: options.exclude,
		absolute: true,
		cwd: vaultRoot,
		// A symlinked canvas (or symlinked directory of them) inside the vault
		// would otherwise be published from outside it. The content index
		// covers the files a canvas references; this covers the canvases.
		followSymbolicLinks: false,
	});
	canvasFiles.sort();

	// Every route first, so a file node or card link naming another board
	// resolves to it while the boards are enriched.
	const routeOwners = new Map<string, string>();
	const boards: CanvasBoardRoute[] = [];
	for (const filePath of canvasFiles) {
		const source = normalizeFsPath(path.relative(vaultRoot, filePath));
		if (
			!isRoutableRelativePath(source) ||
			excludeFolders.some((folder) => source.startsWith(`${folder}/`))
		) {
			continue;
		}
		const routePath = resolveCanvasRoute(filePath, vaultRoot, options.routePrefix);
		const previousOwner = routeOwners.get(routePath);
		if (previousOwner) {
			throw new Error(
				`${LOG_PREFIX} Canvas route collision: ${routePath} is generated by both ${previousOwner} and ${filePath}`,
			);
		}
		routeOwners.set(routePath, filePath);
		boards.push({ absolutePath: filePath, routePath, source });
	}
	return boards;
}

/**
 * Canvas feature: publishes every `.canvas` board under `routePrefix`. Board
 * JSON and the attachments boards reference are written to a plugin-owned
 * directory (`outDir`) that is served as an extra public directory and
 * rebuilt on every build.
 *
 * @param options - Vault location, route and scan filters, viewer behaviour;
 *   all fields optional. See {@link CanvasPluginOptions} for details.
 * @returns An {@link RspressPlugin} ready to append to `plugins:`.
 */
export function canvas(options?: CanvasPluginOptions): RspressPlugin {
	const resolvedOptions = {
		// Deferred to `addPages`: the plugin factory runs while the config is
		// being assembled, before Rspress's content root is known. See the
		// `vaultRoot` fallback there.
		vaultRoot: options?.vaultRoot,
		routePrefix: options?.routePrefix || "/canvas",
		include: options?.include || ["**/*.canvas"],
		exclude: [...DEFAULT_EXCLUDES, ...(options?.exclude ?? [])],
		fileRoutePrefix: options?.fileRoutePrefix,
		linkPreview: options?.linkPreview ?? true,
		editable: options?.editable || false,
		editorTitle: options?.editorTitle || "Canvas editor",
		// `??`: an empty string is a valid choice, the strictest sandbox.
		iframeSandbox: options?.iframeSandbox ?? DEFAULT_IFRAME_SANDBOX,
		// Defaults to true: the canvas stylesheet has always been injected, so the
		// opt-out is additive and existing sites keep their styling.
		enableDefaultStyles: options?.enableDefaultStyles ?? true,
		outDir: path.resolve(process.cwd(), options?.outDir ?? DEFAULT_OUT_DIR),
	};
	if (options?.vaultRoot && !options.fileRoutePrefix) {
		console.warn(
			`${LOG_PREFIX} \`vaultRoot\` is set without \`fileRoutePrefix\`: canvas file cards link to \`/Note\`-style routes while the markdown plugin publishes vault pages under its own prefix (e.g. \`/vault/Note\`). Set \`fileRoutePrefix\` to that prefix to avoid broken links.`,
		);
	}
	// Published (from dist/canvas.js / dist/canvas.cjs): chunks live at
	// dist/canvas/components/*.js. Dev (src/canvas/index.ts): sibling
	// components/*.tsx.
	const componentPath = resolveRuntimeFile(
		path.join(moduleDir, "canvas", "components", "CanvasViewer.js"),
		path.join(moduleDir, "components", "CanvasViewer.tsx"),
		path.join(moduleDir, "canvas", "components", "CanvasViewer.tsx"),
	);
	const embedComponentPath = resolveRuntimeFile(
		path.join(moduleDir, "canvas", "components", "CanvasEmbed.js"),
		path.join(moduleDir, "components", "CanvasEmbed.tsx"),
		path.join(moduleDir, "canvas", "components", "CanvasEmbed.tsx"),
	);
	const stylePath = resolveRuntimeFile(
		path.join(moduleDir, "canvas.css"),
		path.join(moduleDir, "..", "canvas.css"),
		path.join(moduleDir, "styles", "canvas.css"),
		path.join(moduleDir, "canvas", "styles", "canvas.css"),
	);

	// Read by Rspress when it creates the bundler, after `addPages` has run, so
	// `addPages` fills in the site base it learns from the final config.
	const define: Record<string, string> = {
		__RSPRESS_OBSIDIAN_CANVAS_BASE__: JSON.stringify("/"),
		__RSPRESS_OBSIDIAN_KATEX_STYLESHEET__: JSON.stringify(KATEX_STYLESHEET_PATH),
	};
	const mermaidConfig = mermaidBuilderConfig({ diagramsRequested: false });
	const builderConfig: NonNullable<RspressPlugin["builderConfig"]> = {
		...mermaidConfig,
		// Cards typeset their math in the browser, which loads KaTeX's stylesheet
		// from this public directory first.
		plugins: [...(mermaidConfig.plugins ?? []), deferInvalidationPlugin, katexStylesheetPlugin()],
		source: { ...mermaidConfig.source, define },
		server: {
			...mermaidConfig.server,
			// Rsbuild concatenates this with Rspress's own `<root>/public`, serving
			// both in dev and copying both into the build output.
			publicDir: [{ name: resolvedOptions.outDir, copyOnBuild: true, watch: false }],
		},
	};

	// The boards the latest scan published, read back by the markdown and graph
	// features of the same site (see `findCanvasBoards`). Pending while a scan
	// runs, so a reader in a sibling's `addPages` waits for this build's boards.
	let publishedBoards: Promise<CanvasBoards> = Promise.resolve(createCanvasBoards([]));
	const plugin: RspressPlugin = {
		name: "rspress-plugin-obsidian:canvas",
		...(resolvedOptions.enableDefaultStyles && { globalStyles: stylePath }),
		builderConfig,
		// The markdown and graph features find this plugin in `config.plugins`,
		// the only plugin list a hook sees. A plugin added with `utils.addPlugin`
		// from another plugin's `config` hook runs without being listed there, so
		// it lists itself — on a copy, leaving the caller's config untouched.
		config(config) {
			const listed = config.plugins ?? [];
			return listed.includes(plugin) ? config : { ...config, plugins: [...listed, plugin] };
		},
		async addPages(config, _isProd) {
			define.__RSPRESS_OBSIDIAN_CANVAS_BASE__ = JSON.stringify(normalizeSiteBase(config.base));
			// The vault defaults to the Rspress content root — the same
			// `config.root` rule `rootDir` uses below. `process.cwd()` was the
			// old default, but that is usually the project root one level above
			// the content, so an out-of-the-box `canvas()` found nothing.
			const vaultRoot =
				resolvedOptions.vaultRoot ?? path.resolve(process.cwd(), config.root ?? "docs");
			const published = findPublishedContent(config);
			// Started before this hook's first `await`: Rspress calls every
			// plugin's `addPages` in one go, so any sibling that asks for the
			// boards from its own `addPages` already gets this scan's promise.
			const scan = scanBoards(vaultRoot, published, resolvedOptions).then((boards) => ({
				boards,
				canvasBoards: createCanvasBoards(boards),
			}));
			// A failed scan fails this hook (and the build); readers see no boards.
			publishedBoards = scan.then(
				(scanned) => scanned.canvasBoards,
				() => createCanvasBoards([]),
			);
			const { boards, canvasBoards } = await scan;

			// Earlier versions wrote board JSON into the site's own `public/`; left
			// there it would keep publishing deleted boards and, in dev, shadow
			// the fresh copies.
			const rootDir = path.resolve(process.cwd(), config.root ?? "docs");
			await rm(path.join(rootDir, "public", CANVAS_JSON_DIR), { recursive: true, force: true });
			// The output directory is rebuilt from scratch: a board or attachment
			// removed from the vault must stop being published.
			await rm(resolvedOptions.outDir, { recursive: true, force: true });
			await mkdir(resolvedOptions.outDir, { recursive: true });

			const { index, resolveOptions } = await loadVaultIndex(
				vaultRoot,
				resolvedOptions.fileRoutePrefix,
				published,
			);
			const context: PublishContext = {
				vaultRoot,
				index,
				resolveOptions: { ...resolveOptions, canvasBoards },
				outDir: resolvedOptions.outDir,
				copied: new Map(),
				noteBodies: new Map(),
				assetsByUrl: new Map(index.assets.map((asset) => [asset.urlPath, asset])),
				listings: new Map(),
			};
			return mapWithLimit(boards, 8, async (board) => {
				const canvasJson = await readFile(board.absolutePath, "utf-8");
				// Only the enriched board is ever published: the source file holds
				// what enrichment strips (comments, unpublished paths). A board it
				// cannot read gets no JSON, and its page shows the viewer's load error.
				let publishedJson: string | undefined;
				try {
					publishedJson = await enrichCanvas(canvasJson, board, context);
				} catch (error) {
					console.error(
						`${LOG_PREFIX} Failed to process canvas file, not publishing it: ${board.absolutePath}`,
						error,
					);
				}

				if (publishedJson !== undefined) {
					const outFilePath = path.join(
						resolvedOptions.outDir,
						CANVAS_JSON_DIR,
						board.source.replace(/\.canvas$/i, ".json"),
					);
					try {
						await mkdir(path.dirname(outFilePath), { recursive: true });
						await writeFile(outFilePath, publishedJson, "utf-8");
					} catch (writeErr) {
						console.error(`${LOG_PREFIX} Failed to write board JSON: ${outFilePath}`, writeErr);
					}
				}

				// The page carries only the board's name: the viewer fetches the one
				// JSON copy, rather than every route chunk embedding it again.
				const props = {
					src: board.source,
					fileRoutePrefix: resolvedOptions.fileRoutePrefix,
					linkPreview: resolvedOptions.linkPreview,
					editable: resolvedOptions.editable,
					editorTitle: resolvedOptions.editorTitle,
					iframeSandbox: resolvedOptions.iframeSandbox,
				};
				const attributes = Object.entries(props)
					.filter(([, value]) => value !== undefined)
					.map(([name, value]) => `${name}={${JSON.stringify(value)}}`)
					.join(" ");
				return { routePath: board.routePath, content: `<CanvasViewer ${attributes} />` };
			});
		},
		markdown: { globalComponents: [componentPath, embedComponentPath] },
	};
	return attachCanvasBoards(plugin, () => publishedBoards);
}
