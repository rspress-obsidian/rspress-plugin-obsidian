import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RspressPlugin } from "@rspress/core";
import { slug } from "github-slugger";
import { parseCanvas } from "./parser";
import type { CanvasPluginOptions } from "./types";

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
const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".markdown"]);

function normalizeRelativePath(value: string): string {
	return value
		.replace(/\\/g, "/")
		.split("/")
		.filter((segment) => segment && segment !== "." && segment !== "..")
		.join("/");
}

function normalizeAssetKey(value: string): string {
	const [assetPath] = value.split("#");
	return normalizeRelativePath(assetPath || "").toLowerCase();
}

function getSafeVaultPath(vaultRoot: string, relativePath: string): string | null {
	const root = path.resolve(vaultRoot);
	const candidate = path.resolve(root, relativePath);
	if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) return null;
	return candidate;
}

function stripFrontmatter(content: string): string {
	const trimmed = content.trim();
	if (!trimmed.startsWith("---")) return content;
	const lines = trimmed.split("\n");
	const endIndex = lines.findIndex((line, index) => index > 0 && /^---\s*$/.test(line.trim()));
	return endIndex === -1
		? content
		: lines
				.slice(endIndex + 1)
				.join("\n")
				.trim();
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
		if (match[1]) targets.add(match[1].trim());
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
	const canvasData = JSON.parse(canvasJson) as {
		nodes?: Array<Record<string, unknown>>;
		assets?: Record<string, string>;
		notes?: Record<string, string>;
	};
	if (!canvasData || !Array.isArray(canvasData.nodes)) return canvasJson;

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
			if (MARKDOWN_EXTENSIONS.has(extension)) {
				const safePath = getSafeVaultPath(vaultRoot, node.file);
				if (safePath) {
					try {
						let content = stripFrontmatter(await readFile(safePath, "utf-8"));
						notes[normalizeAssetKey(node.file)] = content;
						if (typeof node.subpath === "string" && node.subpath.startsWith("#")) {
							const resolved = resolveSubpath(content, node.subpath);
							content = resolved.content;
							if (resolved.error) node.isError = true;
						}
						node.fileContent = content;
					} catch {
						console.warn(
							`[rspress-plugin-obsidian-canvas] Could not load vault file: ${node.file}`,
						);
					}
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

	const markdownSources = canvasData.nodes
		.filter((node) => node.type === "text" || typeof node.fileContent === "string")
		.map((node) => (node.type === "text" ? node.text : node.fileContent))
		.filter((value): value is string => typeof value === "string");
	for (const source of markdownSources) {
		for (const target of extractAssetTargets(source)) await registerAsset(target);
	}

	if (Object.keys(assets).length > 0) canvasData.assets = assets;
	if (Object.keys(notes).length > 0) canvasData.notes = notes;
	const enrichedJson = JSON.stringify(canvasData);
	parseCanvas(enrichedJson);
	return enrichedJson;
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

export { CanvasParseError, parseCanvas } from "./parser";
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
} from "./types";
export { renderMarkdown, sanitizeUrl } from "./utils/markdown";
export { resolveFileRoute } from "./utils/resolver";

export function pluginObsidianCanvas(options?: CanvasPluginOptions): RspressPlugin {
	const resolvedOptions = {
		vaultRoot: options?.vaultRoot || process.cwd(),
		routePrefix: options?.routePrefix || "/canvas",
		include: options?.include || ["**/*.canvas"],
		exclude: options?.exclude || [],
		fileRoutePrefix: options?.fileRoutePrefix,
		linkPreview: options?.linkPreview || false,
		editable: options?.editable || false,
		editorTitle: options?.editorTitle || "Canvas editor",
		iframeSandbox: options?.iframeSandbox || "allow-scripts allow-same-origin allow-popups",
	};
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
		name: "rspress-plugin-obsidian-canvas",
		globalStyles: stylePath,
		async addPages(config, _isProd) {
			// Runtime loading keeps fast-glob server-only in the published package.
			const { default: glob } = await import("fast-glob");
			const canvasFiles = await glob(resolvedOptions.include, {
				ignore: resolvedOptions.exclude,
				absolute: true,
				cwd: resolvedOptions.vaultRoot,
			});
			const routeOwners = new Map<string, string>();

			// Resolve the docs root for writing embed JSON into the public dir.
			const rootDir =
				config && typeof config === "object" && "root" in config
					? String((config as Record<string, unknown>).root)
					: path.join(process.cwd(), "docs");
			const publicCanvasesDir = path.join(rootDir, "public", "__canvases__");

			const pages = await Promise.all(
				canvasFiles.map(async (filePath) => {
					const routePath = resolveCanvasRoute(
						filePath,
						resolvedOptions.vaultRoot,
						resolvedOptions.routePrefix,
					);
					const previousOwner = routeOwners.get(routePath);
					if (previousOwner) {
						throw new Error(
							`[rspress-plugin-obsidian-canvas] Canvas route collision: ${routePath} is generated by both ${previousOwner} and ${filePath}`,
						);
					}
					routeOwners.set(routePath, filePath);
					const canvasJson = await readFile(filePath, "utf-8");
					let enrichedCanvasJson = canvasJson;
					try {
						enrichedCanvasJson = await enrichCanvas(canvasJson, resolvedOptions.vaultRoot);
					} catch (error) {
						console.error(
							`[rspress-plugin-obsidian-canvas] Failed to process canvas file: ${filePath}`,
							error,
						);
					}

					// Write enriched JSON so `<CanvasEmbed src="X.canvas" />` can fetch it.
					const relPath = path.relative(resolvedOptions.vaultRoot, filePath);
					const jsonName = relPath.replace(/\.canvas$/i, ".json");
					const outFilePath = path.join(publicCanvasesDir, jsonName);
					try {
						await mkdir(path.dirname(outFilePath), { recursive: true });
						await writeFile(outFilePath, enrichedCanvasJson, "utf-8");
					} catch (writeErr) {
						console.error(
							`[rspress-plugin-obsidian-canvas] Failed to write embed JSON: ${outFilePath}`,
							writeErr,
						);
					}

					return {
						routePath,
						content: `<CanvasViewer canvasJson={${JSON.stringify(enrichedCanvasJson)}} fileRoutePrefix={${JSON.stringify(resolvedOptions.fileRoutePrefix)}} linkPreview={${JSON.stringify(resolvedOptions.linkPreview)}} editable={${JSON.stringify(resolvedOptions.editable)}} editorTitle={${JSON.stringify(resolvedOptions.editorTitle)}} iframeSandbox={${JSON.stringify(resolvedOptions.iframeSandbox)}} />`,
					};
				}),
			);
			return pages;
		},
		markdown: { globalComponents: [componentPath, embedComponentPath] },
	};
}
