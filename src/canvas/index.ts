import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RspressPlugin } from "@rspress/core";
import { slug } from "github-slugger";
import { isRealPathInsideRoot } from "../markdown/utils.js";
import type { CanvasBoardRoute } from "../shared/canvas-routes.js";
import { setCanvasRoutes } from "../shared/canvas-routes.js";
import { NOTE_MARKDOWN_EXTENSIONS } from "../shared/extensions.js";
import { stripFrontmatter } from "../shared/frontmatter.js";
import { normalizeFsPath } from "../shared/route-path.js";
import { parseCanvas } from "./parser.js";
import type { CanvasPluginOptions } from "./types.js";
import { normalizeAssetKey } from "./utils/asset-key.js";

const MIME_TYPES: Record<string, string> = {
	".avif": "image/avif",
	".flac": "audio/flac",
	".gif": "image/gif",
	".jpeg": "image/jpeg",
	".jpg": "image/jpeg",
	".m4a": "audio/mp4",
	".md": "text/markdown",
	".mov": "video/quicktime",
	".mp3": "audio/mpeg",
	".mp4": "video/mp4",
	".ogg": "audio/ogg",
	".ogv": "video/ogg",
	".pdf": "application/pdf",
	".png": "image/png",
	".svg": "image/svg+xml",
	".wav": "audio/wav",
	".webm": "video/webm",
	".webp": "image/webp",
};

function normalizeRelativePath(value: string): string {
	return value
		.replace(/\\/g, "/")
		.split("/")
		.filter((segment) => segment && segment !== "." && segment !== "..")
		.join("/");
}

function getSafeVaultPath(vaultRoot: string, relativePath: string): string | null {
	const root = path.resolve(vaultRoot);
	const candidate = path.resolve(root, relativePath);
	if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
	// Lexical containment is not containment: a symlink inside a shared vault
	// resolves to a path outside it, and both the read and the data URL published
	// into `public/__canvases__` would follow it. Re-run the prefix test on the
	// real paths, and treat an unresolvable path (a broken link, a missing file)
	// as unsafe rather than reading through it.
	let realRoot: string;
	let realCandidate: string;
	try {
		realRoot = realpathSync(root);
		realCandidate = realpathSync(candidate);
	} catch {
		return null;
	}
	// `realpathSync` can hand back an extended-length path (`\\?\C:\vault`) on
	// Windows where `root` did not, so compare with the prefix stripped.
	if (!isRealPathInsideRoot(realCandidate, realRoot)) return null;
	return realCandidate;
}

function normalizeHeading(value: string): string {
	return slug(value);
}

function resolveSubpath(content: string, subpath: string): { content: string; error?: string } {
	const target = subpath.slice(1);
	const lines = content.split("\n");
	if (target.startsWith("^")) {
		const blockId = target.slice(1);
		const blockIndex = lines.findIndex((line) => line.trimEnd().endsWith(`^${blockId}`));
		if (blockIndex === -1) return { content: `Unable to find "${target}"`, error: target };
		return { content: lines[blockIndex]?.replace(/\s+\^[\w-]+\s*$/, "").trim() || "" };
	}

	const headingName = normalizeHeading(target);
	let headingLineIndex = -1;
	let headingLevel = 0;
	for (let index = 0; index < lines.length; index++) {
		const match = lines[index]?.trim().match(/^(#{1,6})\s+(.+?)\s*#*$/);
		if (match?.[1] && match[2] && normalizeHeading(match[2]) === headingName) {
			headingLineIndex = index;
			headingLevel = match[1].length;
			break;
		}
	}
	if (headingLineIndex === -1) return { content: `Unable to find "${target}"`, error: target };

	const sectionLines: string[] = [];
	for (let index = headingLineIndex + 1; index < lines.length; index++) {
		const line = lines[index];
		const match = line?.trim().match(/^(#{1,6})\s+/);
		if (match?.[1] && match[1].length <= headingLevel) break;
		if (line !== undefined) sectionLines.push(line);
	}
	return { content: sectionLines.join("\n").trim() };
}

function extractAssetTargets(markdown: string): string[] {
	const targets = new Set<string>();
	for (const match of markdown.matchAll(/!\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
		// A subpath is a location inside the document, not part of its name, so
		// `![[media/sample.pdf#page=2]]` is a request for `media/sample.pdf`. Kept
		// whole, the read looked for a file with a `#` in its name, failed, and the
		// board shipped without the asset — leaving a PDF card pointing at a URL
		// that 404s.
		const target = match[1]?.split("#")[0]?.trim();
		if (target) targets.add(target);
	}
	for (const match of markdown.matchAll(/!\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^)]*["'])?\)/g)) {
		if (match[1] && !/^(?:https?:|data:|\/)/i.test(match[1])) targets.add(match[1]);
	}
	return [...targets];
}

async function createAssetDataUrl(
	vaultRoot: string,
	relativePath: string,
): Promise<{ key: string; url: string; mimeType: string } | null> {
	const safePath = getSafeVaultPath(vaultRoot, relativePath);
	if (!safePath) return null;
	const extension = path.extname(relativePath).toLowerCase();
	const mimeType = MIME_TYPES[extension];
	if (!mimeType) return null;
	try {
		const content = await readFile(safePath);
		return {
			key: normalizeAssetKey(relativePath),
			url: `data:${mimeType};base64,${content.toString("base64")}`,
			mimeType,
		};
	} catch {
		return null;
	}
}

async function enrichCanvas(canvasJson: string, vaultRoot: string): Promise<string> {
	// One pass, decode and validation together: `parseCanvas` JSON.parses and
	// checks the shape itself, so the board no longer gets a lenient parse here
	// and a second `parseCanvas` of the enriched output — which re-parsed every
	// base64 asset it had just embedded — only to throw that result away.
	// Rejecting up front also skips the asset work for a board that would fail
	// validation anyway. Like the old trailing check, a bad board throws and the
	// caller publishes the original JSON with a logged error.
	const canvasData = parseCanvas(canvasJson);

	// A dropped node is a silent content loss unless it is reported, so the
	// tolerance in `parseCanvas` is only safe because this prints what it skipped.
	for (const problem of canvasData.problems ?? []) {
		console.warn(`[rspress-plugin-obsidian:canvas] ${problem}`);
	}

	const assets: Record<string, string> = { ...(canvasData.assets || {}) };
	const notes: Record<string, string> = { ...(canvasData.notes || {}) };
	const registerAsset = async (relativePath: string) => {
		const asset = await createAssetDataUrl(vaultRoot, relativePath);
		if (asset) assets[asset.key] = asset.url;
		return asset;
	};

	for (const node of canvasData.nodes) {
		if (node.type === "file" && typeof node.file === "string") {
			const extension = path.extname(node.file).toLowerCase();
			if (NOTE_MARKDOWN_EXTENSIONS.has(extension)) {
				const safePath = getSafeVaultPath(vaultRoot, node.file);
				let content: string | null = null;
				try {
					// A rejected path (missing, or a symlink resolving outside the vault)
					// is skipped exactly like an unreadable file.
					if (safePath) content = stripFrontmatter(await readFile(safePath, "utf-8"));
				} catch {
					content = null;
				}
				if (content === null) {
					console.warn(`[rspress-plugin-obsidian:canvas] Could not load vault file: ${node.file}`);
				} else {
					notes[normalizeAssetKey(node.file)] = content;
					if (typeof node.subpath === "string" && node.subpath.startsWith("#")) {
						const resolved = resolveSubpath(content, node.subpath);
						content = resolved.content;
						if (resolved.error) node.isError = true;
					}
					node.fileContent = content;
				}
			} else {
				const asset = await registerAsset(node.file);
				if (asset) {
					node.assetUrl = asset.url;
					node.mediaType = asset.mimeType;
					node.isImage = asset.mimeType.startsWith("image/");
					node.isAudio = asset.mimeType.startsWith("audio/");
					node.isVideo = asset.mimeType.startsWith("video/");
					node.isPdf = asset.mimeType === "application/pdf";
					if (node.isImage) node.imageUrl = asset.url;
				}
			}
		}

		if (node.type === "group" && typeof node.background === "string") {
			const asset = await registerAsset(node.background);
			if (asset) node.backgroundUrl = asset.url;
		}
	}

	const markdownSources = canvasData.nodes.flatMap((node) => {
		if (node.type === "text") return [node.text];
		if (node.type === "file" && typeof node.fileContent === "string") return [node.fileContent];
		return [];
	});
	for (const source of markdownSources) {
		for (const target of extractAssetTargets(source)) await registerAsset(target);
	}

	if (Object.keys(assets).length > 0) canvasData.assets = assets;
	if (Object.keys(notes).length > 0) canvasData.notes = notes;
	return JSON.stringify(canvasData);
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

export { CanvasParseError, parseCanvas } from "./parser.js";
export type {
	BackgroundStyle,
	CanvasColor,
	CanvasData,
	CanvasEdgeData,
	CanvasFileData,
	CanvasGroupData,
	CanvasLinkData,
	CanvasNode,
	CanvasNodeData,
	CanvasPluginOptions,
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
 * `canvasFiles.map(...)` under `Promise.all` starts a read, a base64 encode and
 * a markdown render for every board at once; a vault with hundreds of canvases
 * spikes open descriptors and memory together. Eight in flight keeps the disk
 * busy without the cliff, results keep input order, and the per-route collision
 * check still runs synchronously before each worker's first `await`.
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
 * Canvas feature: publishes every `.canvas` board under `routePrefix`, with
 * assets and note content inlined into the board JSON at build time.
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
		linkPreview: options?.linkPreview || false,
		editable: options?.editable || false,
		editorTitle: options?.editorTitle || "Canvas editor",
		iframeSandbox: options?.iframeSandbox || "allow-scripts allow-same-origin allow-popups",
		// Defaults to true: the canvas stylesheet has always been injected, so the
		// opt-out is additive and existing sites keep their styling.
		enableDefaultStyles: options?.enableDefaultStyles ?? true,
	};
	if (options?.vaultRoot && !options.fileRoutePrefix) {
		console.warn(
			"[rspress-plugin-obsidian:canvas] `vaultRoot` is set without `fileRoutePrefix`: canvas file cards link to `/Note`-style routes while the markdown plugin publishes vault pages under its own prefix (e.g. `/vault/Note`). Set `fileRoutePrefix` to that prefix to avoid broken links.",
		);
	}
	const baseDir = import.meta.dirname || __dirname;
	// Published (from dist/canvas.js / dist/canvas.cjs): chunks live at
	// dist/canvas/components/*.js. Dev (src/canvas/index.ts): sibling
	// components/*.tsx.
	let componentPath = path.join(baseDir, "canvas", "components", "CanvasViewer.js");
	if (!existsSync(componentPath)) {
		componentPath = path.join(baseDir, "components", "CanvasViewer.tsx");
	}
	let embedComponentPath = path.join(baseDir, "canvas", "components", "CanvasEmbed.js");
	if (!existsSync(embedComponentPath)) {
		embedComponentPath = path.join(baseDir, "components", "CanvasEmbed.tsx");
	}
	let stylePath = path.join(baseDir, "canvas.css");
	if (!existsSync(stylePath)) {
		stylePath = path.join(baseDir, "..", "canvas.css");
	}
	if (!existsSync(stylePath)) {
		stylePath = path.join(baseDir, "styles", "canvas.css");
	}

	return {
		name: "rspress-plugin-obsidian:canvas",
		...(resolvedOptions.enableDefaultStyles && { globalStyles: stylePath }),
		async addPages(config, _isProd) {
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
				// would otherwise be published from outside it. The path guard in
				// `enrichCanvas` covers the files a canvas references; this covers the
				// canvases themselves.
				followSymbolicLinks: false,
			});
			const routeOwners = new Map<string, string>();
			// Board → published route, handed to the shared registry the markdown
			// plugin and the graph read (see src/shared/canvas-routes.ts).
			const routeEntries: CanvasBoardRoute[] = [];

			// Resolve the docs root for writing embed JSON into the public dir.
			// Same rule as the markdown hook: resolve Rspress's `root` against the
			// working directory, falling back to `docs/`. Reading it via
			// `"root" in config` used to stringify an explicitly-undefined root
			// into the literal directory `undefined/public/__canvases__`.
			const rootDir = path.resolve(process.cwd(), config.root ?? "docs");
			const publicCanvasesDir = path.join(rootDir, "public", "__canvases__");

			const pages = await mapWithLimit(canvasFiles, 8, async (filePath) => {
				const routePath = resolveCanvasRoute(filePath, vaultRoot, resolvedOptions.routePrefix);
				const previousOwner = routeOwners.get(routePath);
				if (previousOwner) {
					throw new Error(
						`[rspress-plugin-obsidian:canvas] Canvas route collision: ${routePath} is generated by both ${previousOwner} and ${filePath}`,
					);
				}
				routeOwners.set(routePath, filePath);
				routeEntries.push({
					absolutePath: filePath,
					routePath,
					source: normalizeFsPath(path.relative(vaultRoot, filePath)),
				});
				const canvasJson = await readFile(filePath, "utf-8");
				let enrichedCanvasJson = canvasJson;
				try {
					enrichedCanvasJson = await enrichCanvas(canvasJson, vaultRoot);
				} catch (error) {
					console.error(
						`[rspress-plugin-obsidian:canvas] Failed to process canvas file: ${filePath}`,
						error,
					);
				}

				// Write enriched JSON so `<CanvasEmbed src="X.canvas" />` can fetch it.
				const relPath = path.relative(vaultRoot, filePath);
				const jsonName = relPath.replace(/\.canvas$/i, ".json");
				const outFilePath = path.join(publicCanvasesDir, jsonName);
				try {
					await mkdir(path.dirname(outFilePath), { recursive: true });
					await writeFile(outFilePath, enrichedCanvasJson, "utf-8");
				} catch (writeErr) {
					console.error(
						`[rspress-plugin-obsidian:canvas] Failed to write embed JSON: ${outFilePath}`,
						writeErr,
					);
				}

				return {
					routePath,
					content: `<CanvasViewer canvasJson={${JSON.stringify(enrichedCanvasJson)}} fileRoutePrefix={${JSON.stringify(resolvedOptions.fileRoutePrefix)}} linkPreview={${JSON.stringify(resolvedOptions.linkPreview)}} editable={${JSON.stringify(resolvedOptions.editable)}} editorTitle={${JSON.stringify(resolvedOptions.editorTitle)}} iframeSandbox={${JSON.stringify(resolvedOptions.iframeSandbox)}} />`,
				};
			});
			// Publish the route table before returning: `addPages` completes before
			// any page compiles, so by the time a `[[Board.canvas]]` resolves the
			// registry is populated (and a scan that found no boards correctly
			// leaves it empty, disabling canvas-aware resolution).
			setCanvasRoutes(routeEntries);
			return pages;
		},
		markdown: { globalComponents: [componentPath, embedComponentPath] },
	};
}
