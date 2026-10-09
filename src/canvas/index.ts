import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RspressPlugin } from "@rspress/core";
import { deferInvalidationPlugin } from "../dev-invalidation.js";
import { buildContentIndex, getCachedContentIndex } from "../markdown/content-index.js";
import { parseWikiLink } from "../markdown/parse-wikilink.js";
import { resolveWikiLink } from "../markdown/resolve-wikilink.js";
import type { ContentAsset, ContentIndex, ContentPage, ResolveContext } from "../markdown/types.js";
import { mermaidBuilderConfig } from "../mermaid/install.js";
import { moduleDir, resolveRuntimeFile } from "../runtime-paths.js";
import type { CanvasBoardRoute } from "../shared/canvas-routes.js";
import { findCanvasBoard, setCanvasRoutes } from "../shared/canvas-routes.js";
import { NOTE_MARKDOWN_EXTENSIONS } from "../shared/extensions.js";
import { stripFrontmatter } from "../shared/frontmatter.js";
import { AUDIO_EXTS, extensionOf, IMAGE_EXTS, PDF_EXT, VIDEO_EXTS } from "../shared/media-exts.js";
import { normalizeFilePathKey } from "../shared/paths.js";
import { getPublishedContent } from "../shared/published-content.js";
import { normalizeFsPath, normalizeRoutePrefix } from "../shared/route-path.js";
import { extractBlockSection, extractHeadingSection } from "../shared/transclusion.js";
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

function readNoteBody(page: ContentPage, context: PublishContext): Promise<string | null> {
	let pending = context.noteBodies.get(page.absolutePath);
	if (!pending) {
		pending = readFile(page.absolutePath, "utf-8").then(
			(content) => stripFrontmatter(content),
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

/** The page a file node's exact vault path names, case-insensitive like Obsidian. */
function findPage(index: ContentIndex, file: string): ContentPage | undefined {
	const key = normalizeFilePathKey(file);
	return (
		index.byFilePathKey.get(key) ??
		(index.byFilePathKeyCI.get(key.toLowerCase())?.length === 1
			? index.byFilePathKeyCI.get(key.toLowerCase())?.[0]
			: undefined)
	);
}

function findAsset(index: ContentIndex, file: string): ContentAsset | undefined {
	const key = normalizeFilePathKey(file);
	const insensitive = index.byAssetPathCI.get(key.toLowerCase());
	return index.byAssetPath.get(key) ?? (insensitive?.length === 1 ? insensitive[0] : undefined);
}

async function resolveFileNode(
	node: Extract<CanvasNode, { type: "file" }>,
	context: PublishContext,
	maps: BoardMaps,
): Promise<{ resolved: CanvasResolvedFile; note?: ContentPage }> {
	const kind = fileKind(node.file);
	if (kind === "note") {
		const page = findPage(context.index, node.file);
		if (!page) {
			// Not in the index: missing, outside the vault, or `publish: false`.
			// The two last look the same from here on purpose — a private note's
			// existence is not announced either.
			const onDisk = existsSync(path.join(context.vaultRoot, node.file));
			return { resolved: { kind: onDisk ? "private" : "missing" } };
		}
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
		const board = findCanvasBoard(node.file, true);
		return { resolved: board ? { kind, href: board.routePath } : { kind: "missing" } };
	}
	const asset = findAsset(context.index, node.file);
	if (!asset) return { resolved: { kind: "missing" } };
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
			boardText.push(node.text);
		} else if (node.type === "file") {
			const { resolved, note } = await resolveFileNode(node, context, maps);
			node.resolvedFile = resolved;
			if (resolved.kind === "private" || resolved.kind === "missing") {
				console.warn(`${LOG_PREFIX} Could not load vault file: ${node.file}`);
			}
			if (note && resolved.key) {
				const body = maps.notes[resolved.key];
				if (body !== undefined)
					sources.push({ scope: resolved.key, text: body, page: note, depth: 0 });
			}
		} else if (node.type === "group" && node.background) {
			const asset = findAsset(context.index, node.background);
			if (asset) {
				const key = await registerAsset(asset, context, maps);
				if (key) node.resolvedBackground = key;
			}
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

/** The content index the Markdown plugin publishes this vault with, or our own. */
async function loadVaultIndex(
	vaultRoot: string,
	fileRoutePrefix: string | undefined,
): Promise<{ index: ContentIndex; resolveOptions: ResolveContext["options"] }> {
	const published = getPublishedContent();
	const root = normalizeFsPath(path.resolve(vaultRoot));
	const sameRoot = (candidate: string | undefined) =>
		candidate !== undefined && normalizeFsPath(path.resolve(candidate)) === root;
	const resolveOptions = {
		enableCaseInsensitiveLookup: published?.enableCaseInsensitiveLookup ?? true,
		enableFuzzyMatching: published?.enableFuzzyMatching ?? false,
	};
	// Sharing the Markdown plugin's index (and its options) means a card link
	// resolves to exactly the route the note page was published at.
	if (published && sameRoot(published.vaultRoot) && published.vaultIndexOptions) {
		return {
			index: await getCachedContentIndex(vaultRoot, published.vaultIndexOptions),
			resolveOptions,
		};
	}
	if (published && sameRoot(published.docsRoot)) {
		return {
			index: await getCachedContentIndex(vaultRoot, published.docsIndexOptions),
			resolveOptions,
		};
	}
	return {
		index: await buildContentIndex(vaultRoot, {
			routePrefix: normalizeRoutePrefix(fileRoutePrefix),
		}),
		resolveOptions,
	};
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
		iframeSandbox: options?.iframeSandbox || "allow-scripts allow-same-origin allow-popups",
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
	};
	const mermaidConfig = mermaidBuilderConfig({ diagramsRequested: false });
	const builderConfig: NonNullable<RspressPlugin["builderConfig"]> = {
		...mermaidConfig,
		plugins: [...(mermaidConfig.plugins ?? []), deferInvalidationPlugin],
		source: { ...mermaidConfig.source, define },
		server: {
			...mermaidConfig.server,
			// Rsbuild concatenates this with Rspress's own `<root>/public`, serving
			// both in dev and copying both into the build output.
			publicDir: [{ name: resolvedOptions.outDir, copyOnBuild: true, watch: false }],
		},
	};

	return {
		name: "rspress-plugin-obsidian:canvas",
		...(resolvedOptions.enableDefaultStyles && { globalStyles: stylePath }),
		builderConfig,
		async addPages(config, _isProd) {
			define.__RSPRESS_OBSIDIAN_CANVAS_BASE__ = JSON.stringify(normalizeSiteBase(config.base));
			// The vault defaults to the Rspress content root — the same
			// `config.root` rule `rootDir` uses below. `process.cwd()` was the
			// old default, but that is usually the project root one level above
			// the content, so an out-of-the-box `canvas()` found nothing.
			const vaultRoot =
				resolvedOptions.vaultRoot ?? path.resolve(process.cwd(), config.root ?? "docs");
			// Runtime loading keeps fast-glob server-only in the published package.
			const { default: glob } = await import("fast-glob");
			const canvasFiles = await glob(resolvedOptions.include, {
				ignore: resolvedOptions.exclude,
				absolute: true,
				cwd: vaultRoot,
				// A symlinked canvas (or symlinked directory of them) inside the vault
				// would otherwise be published from outside it. The content index
				// covers the files a canvas references; this covers the canvases.
				followSymbolicLinks: false,
			});
			canvasFiles.sort();

			// Earlier versions wrote board JSON into the site's own `public/`; left
			// there it would keep publishing deleted boards and, in dev, shadow
			// the fresh copies.
			const rootDir = path.resolve(process.cwd(), config.root ?? "docs");
			await rm(path.join(rootDir, "public", CANVAS_JSON_DIR), { recursive: true, force: true });
			// The output directory is rebuilt from scratch: a board or attachment
			// removed from the vault must stop being published.
			await rm(resolvedOptions.outDir, { recursive: true, force: true });
			await mkdir(resolvedOptions.outDir, { recursive: true });

			// Every route first, so a file node or card link naming another board
			// resolves through the registry while the boards are enriched.
			const routeOwners = new Map<string, string>();
			const boards: CanvasBoardRoute[] = canvasFiles.map((filePath) => {
				const routePath = resolveCanvasRoute(filePath, vaultRoot, resolvedOptions.routePrefix);
				const previousOwner = routeOwners.get(routePath);
				if (previousOwner) {
					throw new Error(
						`${LOG_PREFIX} Canvas route collision: ${routePath} is generated by both ${previousOwner} and ${filePath}`,
					);
				}
				routeOwners.set(routePath, filePath);
				return {
					absolutePath: filePath,
					routePath,
					source: normalizeFsPath(path.relative(vaultRoot, filePath)),
				};
			});
			setCanvasRoutes(boards);

			const { index, resolveOptions } = await loadVaultIndex(
				vaultRoot,
				resolvedOptions.fileRoutePrefix,
			);
			const context: PublishContext = {
				vaultRoot,
				index,
				resolveOptions,
				outDir: resolvedOptions.outDir,
				copied: new Map(),
				noteBodies: new Map(),
				assetsByUrl: new Map(index.assets.map((asset) => [asset.urlPath, asset])),
			};

			return mapWithLimit(boards, 8, async (board) => {
				const canvasJson = await readFile(board.absolutePath, "utf-8");
				let publishedJson = canvasJson;
				try {
					publishedJson = await enrichCanvas(canvasJson, board, context);
				} catch (error) {
					console.error(
						`${LOG_PREFIX} Failed to process canvas file: ${board.absolutePath}`,
						error,
					);
				}

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
}
