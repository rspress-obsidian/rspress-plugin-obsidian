/**
 * What the feature publishes besides page markup: a page for every plain
 * `.excalidraw` file, and the files the pictures load — the images a
 * drawing embeds, the images Obsidian auto-exported next to it, and
 * Excalidraw's fonts. Those are staged in a directory of the feature's own,
 * served as an extra public directory at the URLs the content index gives
 * them, so a drawing's image is served even when no note links it.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import type { PublishedFileRoute } from "../../../shared/file-routes.js";
import { extensionOf, IMAGE_EXTS, PDF_EXT } from "../../../shared/media-exts.js";
import { deriveRoutePath } from "../../../shared/route-path.js";
import { parseWikiLink } from "../../parse-wikilink.js";
import { resolveWikiLink } from "../../resolve-wikilink.js";
import type { ContentAsset, ContentIndex, NormalizedPluginOptions } from "../../types.js";
import type { PluginBuildContext } from "../types.js";
import type { ExcalidrawSettings } from "./config.js";
import { type Drawing, FILE_ROUTE_KIND, isDrawingFile, loadDrawing } from "./drawing.js";
import { excalidrawFontFaces, FONT_URL_DIR } from "./fonts.js";
import type { DrawingTheme } from "./render.js";
import { SceneError } from "./scene.js";

/**
 * How a plain drawing's generated page names its file: an MDX comment, since
 * Rspress hands the remark pass the page without its frontmatter.
 */
const FILE_MARKER = /\{\/\*\s*excalidraw-file:\s*("(?:[^"\\]|\\.)*")\s*\*\/\}/;

/** The directory the feature stages served files in, one per vault and prefix. */
export function stagingDir(options: NormalizedPluginOptions): string {
	const key = `${options.vaultRoot ?? ""}|${options.vaultRoutePrefix}`;
	return path.join(
		process.cwd(),
		"node_modules",
		".rspress-plugin-obsidian",
		`excalidraw-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`,
	);
}

/** The vault-relative path a generated page's marker names, if it has one. */
export function markedDrawing(source: string): string | undefined {
	const quoted = FILE_MARKER.exec(source)?.[1];
	if (quoted === undefined) return undefined;
	const value: unknown = JSON.parse(quoted);
	return typeof value === "string" ? value : undefined;
}

/** A plain `.excalidraw` file's page, keyed so the page and the file never part. */
export function plainDrawingRoutes(ctx: PluginBuildContext): PublishedFileRoute[] {
	const index = ctx.vault ?? ctx.docs;
	const prefix = ctx.vault ? ctx.vaultRoutePrefix : "";
	const taken = new Set(index.pages.map((page) => page.routePath));
	const routes: PublishedFileRoute[] = [];
	for (const asset of index.assets) {
		if (extensionOf(asset.relativePath) !== "excalidraw") continue;
		const routePath = deriveRoutePath(asset.relativePath, prefix);
		if (taken.has(routePath)) {
			console.warn(
				`[rspress-plugin-obsidian:excalidraw] ${asset.relativePath} is not published as a page: a note already has the route ${routePath}.`,
			);
			continue;
		}
		routes.push({
			kind: FILE_ROUTE_KIND,
			absolutePath: asset.absolutePath,
			routePath,
			source: asset.relativePath,
		});
	}
	return routes;
}

/** The MDX of a plain drawing's page: its title, and the marker `renderNote` draws it from. */
export function plainDrawingPage(route: PublishedFileRoute): string {
	const title = path.basename(route.source).replace(/\.excalidraw$/i, "");
	// `\/` keeps a `*/` in a file name from closing the comment early.
	const marker = JSON.stringify(route.source).replace(/\//g, "\\/");
	return `---\ntitle: ${JSON.stringify(title)}\n---\n\n{/* excalidraw-file: ${marker} */}\n`;
}

/** An image Obsidian auto-exported next to a drawing. */
export interface ExportedImage {
	asset: ContentAsset;
	/** `light`/`dark` for a themed pair, `undefined` for a single image. */
	theme?: "light" | "dark";
}

const assetsByPath = new WeakMap<ContentIndex, Map<string, ContentAsset>>();

function assetAt(index: ContentIndex, absolutePath: string): ContentAsset | undefined {
	let byPath = assetsByPath.get(index);
	if (!byPath) {
		byPath = new Map(index.assets.map((asset) => [path.resolve(asset.absolutePath), asset]));
		assetsByPath.set(index, byPath);
	}
	return byPath.get(path.resolve(absolutePath));
}

/**
 * The images the plugin's auto-export wrote for a drawing: `<name>.svg` /
 * `.png` beside it, or a `.light`/`.dark` pair when it exports both themes
 * (`getIMGFilename`: the drawing's path with its last extension replaced).
 */
export function exportedImages(
	drawingPath: string,
	theme: DrawingTheme,
	index: ContentIndex,
): ExportedImage[] {
	const base = drawingPath.slice(0, drawingPath.length - path.extname(drawingPath).length);
	for (const format of ["svg", "png"]) {
		const light = assetAt(index, `${base}.light.${format}`);
		const dark = assetAt(index, `${base}.dark.${format}`);
		const plain = assetAt(index, `${base}.${format}`);
		if (theme === "auto" && light && dark) {
			return [
				{ asset: light, theme: "light" },
				{ asset: dark, theme: "dark" },
			];
		}
		const themed = theme === "dark" ? dark : theme === "light" ? light : undefined;
		const single = themed ?? plain;
		if (single) return [{ asset: single }];
	}
	return [];
}

/** Where a staged file is served, relative to the site root — the asset's own URL. */
function servedPath(asset: ContentAsset, ctx: PluginBuildContext): string | undefined {
	if (ctx.vault?.byAssetPath.get(asset.pathKey) === asset) {
		return path.posix.join(ctx.vaultRoutePrefix.replace(/^\/+|\/+$/g, ""), asset.relativePath);
	}
	// A docs-root file under `public/` is served by Rspress already.
	return asset.relativePath.startsWith("public/") ? undefined : asset.relativePath;
}

/** A note's drawing, if it is one; a corrupt one is reported where it is shown. */
async function readDrawingIfAny(absolutePath: string): Promise<Drawing | undefined> {
	if (!(await isDrawingFile(absolutePath))) return undefined;
	try {
		return await loadDrawing(absolutePath);
	} catch (error) {
		if (error instanceof SceneError) return undefined;
		throw error;
	}
}

/**
 * Every file the published pictures load, as staging path → source file:
 * vault images and PDFs under `## Embedded Files`, auto-exported images when
 * they are preferred, and the fonts when they are served.
 */
export async function filesToStage(
	ctx: PluginBuildContext,
	settings: ExcalidrawSettings,
	routes: readonly PublishedFileRoute[],
	fontsDir: string | undefined,
): Promise<Map<string, string>> {
	const wanted = new Map<string, string>();
	const stage = (asset: ContentAsset): void => {
		const served = servedPath(asset, ctx);
		if (served) wanted.set(served, asset.absolutePath);
	};
	// A page may be shown in any theme, so every variant it could pick is served.
	const stageExports = (drawingPath: string, index: ContentIndex): void => {
		if (!settings.preferExportedImage) return;
		for (const theme of ["auto", "light", "dark"] as const) {
			for (const image of exportedImages(drawingPath, theme, index)) stage(image.asset);
		}
	};
	for (const index of ctx.vault ? [ctx.vault, ctx.docs] : [ctx.docs]) {
		for (const page of index.pages) {
			const drawing = await readDrawingIfAny(page.absolutePath);
			if (!drawing) continue;
			for (const ref of drawing.embeddedFiles.values()) {
				if (ref.kind !== "link") continue;
				// The file is staged whole: a PDF's `#page=N` is not part of its path.
				const parsed = { ...parseWikiLink(ref.target, `![[${ref.target}]]`), subpath: undefined };
				const asset = resolveWikiLink(parsed, {
					currentPage: page,
					index,
					options: ctx.resolveOptions,
				}).targetAsset;
				const extension = asset ? extensionOf(asset.relativePath) : "";
				if (asset && (IMAGE_EXTS.has(extension) || extension === PDF_EXT)) stage(asset);
			}
			stageExports(page.absolutePath, index);
		}
	}
	for (const route of routes) stageExports(route.absolutePath, ctx.vault ?? ctx.docs);
	if (fontsDir && settings.fonts) {
		for (const face of excalidrawFontFaces(fontsDir, settings.cjkFonts)) {
			wanted.set(`${FONT_URL_DIR}/${face.file}`, path.join(fontsDir, face.file));
		}
	}
	return wanted;
}
