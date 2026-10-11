/**
 * A drawing on a page: its file read (once per change), its links and images
 * resolved against the site, the part an embed asks for selected, and the
 * result drawn as SVG.
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isMermaidInstalled } from "../../../mermaid/install.js";
import { sanitizeUrl } from "../../../shared/escape.js";
import { stripFrontmatter } from "../../../shared/frontmatter.js";
import { extensionOf, IMAGE_EXTS, PDF_EXT } from "../../../shared/media-exts.js";
import { withSiteBase } from "../../media.js";
import { parseWikiLink } from "../../parse-wikilink.js";
import type { ContentPage, ResolvedWikiLink, WikiSubpath } from "../../types.js";
import type { PluginRenderContext } from "../types.js";
import { type Bounds, commonBounds, elementBounds } from "./bounds.js";
import { type DrawingSettings, drawingSettings, type ExcalidrawSettings } from "./config.js";
import { type DrawingNote, parseDrawingNote } from "./drawing-file.js";
import { excalidrawFontFaces, familyNames, fontFaceCss } from "./fonts.js";
import { textMeasurer } from "./measure.js";
import { type ElementLink, type ImageSource, renderSceneSvg } from "./render.js";
import {
	type ExcalidrawElement,
	type FrameRendering,
	parseSceneJson,
	type Scene,
	SceneError,
} from "./scene.js";
import { applyDisplayText, firstLink, parseElementText } from "./text.js";

/** The `setPublishedFileRoutes` kind of a plain `.excalidraw` file's page. */
export const FILE_ROUTE_KIND = "excalidraw";

/** A drawing, read from a `.excalidraw.md` note or a plain `.excalidraw` file. */
export interface Drawing extends DrawingNote {
	absolutePath: string;
}

const drawings = new Map<
	string,
	{ mtimeMs: number; size: number; drawing: Drawing | SceneError }
>();

/**
 * Read a drawing, parsing it again only when the file changed. A note
 * qualifies by its `excalidraw-plugin` frontmatter, anything else by being a
 * `.excalidraw` file.
 *
 * @throws {SceneError} When the drawing is missing or corrupt.
 */
export async function loadDrawing(absolutePath: string): Promise<Drawing> {
	const stat = await fs.stat(absolutePath).catch(() => undefined);
	if (!stat) throw new SceneError("the file cannot be read");
	const cached = drawings.get(absolutePath);
	let result =
		cached?.mtimeMs === stat.mtimeMs && cached.size === stat.size ? cached.drawing : undefined;
	if (!result) {
		const source = await fs.readFile(absolutePath, "utf8");
		try {
			result = /\.(md|mdx)$/i.test(absolutePath)
				? { ...parseDrawingNote(source), absolutePath }
				: {
						scene: parseSceneJson(source),
						textMode: "parsed",
						frontmatter: {},
						textElements: new Map(),
						embeddedFiles: new Map(),
						absolutePath,
					};
		} catch (error) {
			if (!(error instanceof SceneError)) throw error;
			result = error;
		}
		drawings.set(absolutePath, { mtimeMs: stat.mtimeMs, size: stat.size, drawing: result });
	}
	if (result instanceof SceneError) throw result;
	return result;
}

/**
 * Whether a note is an Excalidraw drawing: its frontmatter has
 * `excalidraw-plugin`. Only the start of the file is read — the frontmatter
 * comes first, and most notes are not drawings.
 */
export async function isDrawingFile(absolutePath: string): Promise<boolean> {
	const handle = await fs.open(absolutePath, "r").catch(() => undefined);
	if (!handle) return false;
	try {
		const buffer = Buffer.alloc(4096);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
		const head = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(
			buffer.toString("utf8", 0, bytesRead),
		)?.[1];
		return head !== undefined && /^excalidraw-plugin[ \t]*:/m.test(head);
	} finally {
		await handle.close();
	}
}

/** The drawing a resolved link names, if it names one: a drawing note or a `.excalidraw` file. */
export async function drawingPathOf(resolved: ResolvedWikiLink): Promise<string | undefined> {
	if (resolved.status !== "ok") return undefined;
	if (resolved.fileRoute?.kind === FILE_ROUTE_KIND) return resolved.fileRoute.absolutePath;
	const asset = resolved.targetAsset;
	if (asset && extensionOf(asset.relativePath) === "excalidraw") return asset.absolutePath;
	const page = resolved.targetPage;
	return page && (await isDrawingFile(page.absolutePath)) ? page.absolutePath : undefined;
}

const MIME_BY_EXTENSION: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	avif: "image/avif",
	bmp: "image/bmp",
	svg: "image/svg+xml",
};

/** What a drawing render needs beyond the drawing itself. */
export interface DrawingRequest {
	drawing: Drawing;
	/** The page the drawing's own links resolve from (the note itself, or a stand-in for a file). */
	page: ContentPage;
	settings: ExcalidrawSettings;
	/** `#^id`, `#^group=id`, `#^area=id`, `#^frame=name`, `#^clippedframe=name`. */
	subpath?: WikiSubpath;
	/** Accessible name. */
	label: string;
	className: string;
	/** The fonts directory of `@excalidraw/excalidraw`, when installed: text is measured with them, and they are served when `fonts` is on. */
	fontsDir?: string;
	/** Drawings already being drawn (a drawing that embeds itself stops there). */
	visited?: ReadonlySet<string>;
	/** Draw into a box of this size: an image element showing another drawing. */
	size?: { width: number; height: number };
}

interface Crop {
	elements: ExcalidrawElement[];
	viewBounds?: Bounds;
	frameRendering?: FrameRendering;
	padding?: number;
}

const CROP_REFERENCE = /^(group=|area=|frame=|clippedframe=)?(.*?)(?:,padding=(\d+(?:\.\d+)?))?$/;

/**
 * The part of a drawing a block reference selects, as the plugin's
 * `getTemplate` / `getSVG` select it; a message when it names no element.
 */
export function selectCrop(
	scene: Scene,
	elements: ExcalidrawElement[],
	subpath: WikiSubpath | undefined,
): Crop | string {
	if (subpath?.kind !== "block") return { elements };
	const match = CROP_REFERENCE.exec(subpath.value);
	const prefix = match?.[1];
	const reference = match?.[2] ?? subpath.value;
	const padding = match?.[3] === undefined ? undefined : Number(match[3]);
	const byId = new Map(scene.elements.map((element) => [element.id, element]));
	if (prefix === "frame=" || prefix === "clippedframe=") {
		const frames = elements.filter(
			(element) =>
				element.type === "frame" &&
				(element.id === reference || (element.name ?? "Frame") === reference),
		);
		const frame = frames.length === 1 ? frames[0] : undefined;
		if (!frame) return `no frame named or with id "${reference}"`;
		return {
			elements: elements.filter((element) => element === frame || element.frameId === frame.id),
			...(prefix === "clippedframe=" && {
				frameRendering: { enabled: true, name: false, outline: false, clip: true },
			}),
			padding,
		};
	}
	const target = elements.find((element) => element.id === reference);
	if (!target) return `no element with id "${reference}"`;
	const container = target.containerId ? byId.get(target.containerId) : undefined;
	if (prefix === "group=") {
		const groups = new Set(target.groupIds);
		const picked = new Set(
			target.groupIds.length > 0
				? elements.filter((element) => element.groupIds.some((id) => groups.has(id)))
				: target.type === "frame"
					? elements.filter((element) => element === target || element.frameId === target.id)
					: [target],
		);
		if (container) picked.add(container);
		const owners = new Set([...picked].map((owner) => owner.id));
		for (const element of elements) {
			if (element.containerId && owners.has(element.containerId)) picked.add(element);
		}
		return { elements: elements.filter((element) => picked.has(element)), padding };
	}
	const focus = container ? [target, container] : [target];
	const viewBounds = commonBounds(focus, byId);
	if (prefix === "area=") {
		const [ax1, ay1, ax2, ay2] = viewBounds;
		return {
			elements: elements.filter((element) => {
				if (element === target) return true;
				const [x1, y1, x2, y2] = elementBounds(element, byId);
				return x1 < ax2 && x2 > ax1 && y1 < ay2 && y2 > ay1;
			}),
			viewBounds,
			padding,
		};
	}
	return { elements, viewBounds, padding };
}

/** The markdown a `![[Note#…]]` names: the whole note, a heading's section, or a block. */
export function noteSection(content: string, subpath: WikiSubpath | undefined): string | undefined {
	const body = stripFrontmatter(content).replace(/\r\n?/g, "\n");
	if (!subpath) return body.trim();
	const lines = body.split("\n");
	if (subpath.kind === "block") {
		const marker = new RegExp(`\\s\\^${subpath.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
		const index = lines.findIndex((line) => marker.test(line));
		if (index === -1) return undefined;
		let start = index;
		while (start > 0 && lines[start - 1]?.trim()) start -= 1;
		return lines
			.slice(start, index + 1)
			.join("\n")
			.replace(marker, "")
			.trim();
	}
	const wanted = (subpath.value.split("#").pop() ?? "").trim().toLowerCase();
	const start = lines.findIndex((line) => {
		const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
		return heading?.[2]?.trim().toLowerCase() === wanted;
	});
	if (start === -1) return undefined;
	const depth = /^#+/.exec(lines[start] ?? "")?.[0].length ?? 1;
	let end = start + 1;
	while (end < lines.length && !new RegExp(`^#{1,${depth}}\\s`).test(lines[end] ?? "")) end += 1;
	return lines
		.slice(start + 1, end)
		.join("\n")
		.trim();
}

/** The diagnostic mode a broken link takes, as the rest of the plugin reports one. */
function brokenLinkMode(ctx: PluginRenderContext): "fail" | "warn" {
	return ctx.options.onBrokenLink === "error" ? "fail" : "warn";
}

/** Resolve an element's link: a wikilink through the site's resolver, a URL as written. */
async function resolveLink(
	link: string,
	request: DrawingRequest,
	ctx: PluginRenderContext,
): Promise<ElementLink> {
	const wiki = /^!?\[\[([^\]]+)]]$/.exec(link.trim());
	const name = path.basename(request.drawing.absolutePath);
	if (
		!wiki &&
		(/^[a-z][a-z0-9+.-]*:/i.test(link) || link.startsWith("/") || link.startsWith("#"))
	) {
		const href = sanitizeUrl(link);
		if (href === null) return { unresolved: `Unsafe link "${link}"` };
		return { href: withSiteBase(href, ctx.siteBase), external: /^[a-z][a-z0-9+.-]*:/i.test(href) };
	}
	const inner = wiki?.[1] ?? link.trim();
	const parsed = parseWikiLink(inner, `[[${inner}]]`);
	const resolved = await ctx.resolve(parsed, request.page);
	if (resolved.status === "ok" && resolved.href) {
		if (resolved.ambiguity) {
			ctx.report(
				`[[${inner}]] in drawing "${name}" — ${resolved.ambiguity}`,
				ctx.options.onAmbiguousLink === "error" ? "fail" : "warn",
			);
		}
		return { href: withSiteBase(resolved.href, ctx.siteBase), external: false };
	}
	const reason = resolved.message ?? "Unable to resolve wikilink.";
	ctx.report(`[[${inner}]] in drawing "${name}" — ${reason}`, brokenLinkMode(ctx));
	return { unresolved: reason };
}

/** Read the content a `![[…]]` in a text element transcludes. */
async function readTransclusion(
	target: string,
	request: DrawingRequest,
	ctx: PluginRenderContext,
): Promise<string | undefined> {
	const parsed = parseWikiLink(target, `![[${target}]]`);
	const resolved = await ctx.resolve(parsed, request.page);
	if (!resolved.targetPage) return undefined;
	const content = await fs
		.readFile(resolved.targetPage.absolutePath, "utf8")
		.catch(() => undefined);
	return content === undefined ? undefined : noteSection(content, parsed.subpath);
}

/** An image element that shows another drawing, drawn once its box is known. */
type ImageFile = ImageSource | { kind: "drawing"; absolutePath: string };

/** Whether the optional `mermaid` peer is installed, looked up once. */
let mermaidInstalled: boolean | undefined;

/**
 * A Mermaid diagram the plugin placed as an image (`customData.mermaidText`):
 * left to the site's Mermaid renderer when there is one, else shown as source.
 */
function mermaidImage(source: string, name: string, ctx: PluginRenderContext): ImageSource {
	mermaidInstalled ??= isMermaidInstalled();
	if (ctx.options.enableMermaid && mermaidInstalled) {
		return { kind: "mermaid", source, securityLevel: ctx.options.mermaidSecurityLevel };
	}
	ctx.report(
		`A Mermaid diagram in drawing "${name}" is shown as its source: ${ctx.options.enableMermaid ? "the optional peer `mermaid` is not installed" : "`enableMermaid` is off"}.`,
		"warn",
	);
	return { kind: "mermaid", source };
}

/** What an image element shows: its Mermaid diagram, or the file `## Embedded Files` (or the scene) gives it. */
async function resolveImage(
	element: ExcalidrawElement,
	request: DrawingRequest,
	ctx: PluginRenderContext,
): Promise<ImageFile> {
	const name = path.basename(request.drawing.absolutePath);
	const mermaid = element.customData.mermaidText;
	if (typeof mermaid === "string" && mermaid.trim()) return mermaidImage(mermaid, name, ctx);
	const fileId = element.fileId ?? "";
	const inline = request.drawing.scene.files[fileId];
	if (inline) return { kind: "image", href: inline.dataURL, mimeType: inline.mimeType };
	const ref = request.drawing.embeddedFiles.get(fileId);
	if (!ref) {
		const reason = `Image ${fileId} of drawing "${name}" has no file: it is neither in the scene nor under ## Embedded Files.`;
		ctx.report(reason, brokenLinkMode(ctx));
		return { kind: "missing", reason };
	}
	if (ref.kind === "url") {
		const href = sanitizeUrl(ref.url);
		return href
			? {
					kind: "image",
					href,
					mimeType: MIME_BY_EXTENSION[extensionOf(new URL(href).pathname)] ?? "",
				}
			: { kind: "missing", reason: `Unsafe image URL "${ref.url}"` };
	}
	if (ref.kind === "latex") {
		return { kind: "html", html: await ctx.renderBlock(`$$\n${ref.tex}\n$$`, request.page) };
	}
	const parsed = parseWikiLink(ref.target, `![[${ref.target}]]`);
	const pdf = extensionOf(parsed.target) === PDF_EXT;
	// A PDF's `#page=N&rect=…` names a page, not a heading of the file.
	const resolved = await ctx.resolve(
		pdf ? { ...parsed, subpath: undefined } : parsed,
		request.page,
	);
	if (resolved.status !== "ok") {
		const reason = `![[${ref.target}]] in drawing "${name}" — ${resolved.message ?? "not found"}`;
		ctx.report(reason, brokenLinkMode(ctx));
		return { kind: "missing", reason };
	}
	const nested = await drawingPathOf(resolved);
	if (nested) return { kind: "drawing", absolutePath: nested };
	const asset = resolved.targetAsset;
	if (asset) {
		const extension = extensionOf(asset.relativePath);
		const href = withSiteBase(asset.urlPath, ctx.siteBase);
		if (IMAGE_EXTS.has(extension)) {
			return { kind: "image", href, mimeType: MIME_BY_EXTENSION[extension] ?? "" };
		}
		if (extension === PDF_EXT) {
			const fragment = parsed.subpath?.value ?? "";
			if (/(?:^|&)rect=/.test(fragment)) {
				ctx.report(
					`![[${ref.target}]] in drawing "${name}": a browser's PDF viewer cannot crop to a region, so the whole page is shown.`,
					"warn",
				);
			}
			const page = Number(/(?:^|&)page=(\d+)/.exec(fragment)?.[1] ?? 1);
			return { kind: "pdf", href, name: path.basename(asset.relativePath), page: page || 1 };
		}
		const reason = `![[${ref.target}]] in drawing "${name}": a .${extension} file is drawn by Obsidian at view time and cannot be shown in a static picture.`;
		ctx.report(reason, "warn");
		return { kind: "missing", reason };
	}
	const page = resolved.targetPage as ContentPage;
	const content = await fs.readFile(page.absolutePath, "utf8");
	const section = noteSection(content, parsed.subpath) ?? "";
	return { kind: "html", html: await ctx.renderBlock(section, page) };
}

/** Another drawing an image element shows, drawn to fit the element's box. */
async function nestedDrawing(
	absolutePath: string,
	element: ExcalidrawElement,
	request: DrawingRequest,
	ctx: PluginRenderContext,
): Promise<ImageSource> {
	const name = path.basename(absolutePath);
	if (request.visited?.has(absolutePath)) {
		const reason = `Drawing "${name}" embeds itself; the loop is shown as a placeholder.`;
		ctx.report(reason, "warn");
		return { kind: "missing", reason };
	}
	try {
		const drawing = await loadDrawing(absolutePath);
		const markup = await drawingSvg(
			{
				...request,
				drawing,
				subpath: undefined,
				label: name,
				className: "excalidraw-nested",
				size: { width: element.width, height: element.height },
			},
			ctx,
		);
		return { kind: "svg", markup };
	} catch (error) {
		if (!(error instanceof SceneError)) throw error;
		const reason = `Embedded drawing "${name}": ${error.message}`;
		ctx.report(reason);
		return { kind: "missing", reason };
	}
}

/** A unique, stable id prefix for the definitions of one picture. */
function idPrefixFor(request: DrawingRequest): string {
	const key = `${request.drawing.absolutePath}#${request.subpath?.value ?? ""}#${request.size ? "nested" : ""}`;
	return `exc-${createHash("sha1").update(key).digest("hex").slice(0, 8)}-`;
}

/** The drawing as `<svg>` markup, everything site-dependent resolved. */
export async function drawingSvg(
	request: DrawingRequest,
	ctx: PluginRenderContext,
): Promise<string> {
	const { drawing } = request;
	const { scene } = drawing;
	const settings: DrawingSettings = drawingSettings(request.settings, drawing.frontmatter, scene);
	const visited = new Set([...(request.visited ?? []), drawing.absolutePath]);
	const byId = new Map(scene.elements.map((element) => [element.id, element]));
	const links = new Map<string, ElementLink>();
	const images = new Map<string, ImageSource>();
	const measure = textMeasurer(request.fontsDir);

	const elements: ExcalidrawElement[] = [];
	for (const original of scene.elements) {
		if (original.isDeleted) continue;
		let element = original;
		let link = element.link;
		if (element.type === "text") {
			const raw = drawing.textElements.get(element.id) ?? element.originalText;
			const parsed =
				drawing.textMode === "raw"
					? { text: raw, link: firstLink(raw) }
					: await parseElementText(raw, settings, (target) =>
							readTransclusion(target, request, ctx),
						);
			const container = element.containerId ? byId.get(element.containerId) : undefined;
			element = applyDisplayText(element, parsed.text, container, measure);
			link ??= parsed.link;
		}
		if (link) links.set(element.id, await resolveLink(link, request, ctx));
		if (element.type === "image" && element.fileId && !images.has(element.fileId)) {
			const source = await resolveImage(element, request, ctx);
			images.set(
				element.fileId,
				source.kind === "drawing"
					? await nestedDrawing(source.absolutePath, element, { ...request, visited }, ctx)
					: source,
			);
		}
		elements.push(element);
	}
	// A text element laid out anew moved: containers and arrows look labels up by id.
	const drawn = new Map(elements.map((element) => [element.id, element]));
	const laidOut = {
		...scene,
		elements: scene.elements.map((element) => drawn.get(element.id) ?? element),
	};

	const crop = selectCrop(laidOut, elements, request.subpath);
	let picked: Crop = { elements };
	if (typeof crop === "string") {
		ctx.report(
			`#${request.subpath?.value} of drawing "${path.basename(drawing.absolutePath)}": ${crop}; the whole drawing is shown.`,
			brokenLinkMode(ctx),
		);
	} else {
		picked = crop;
	}

	const fontCss =
		request.fontsDir && request.settings.fonts
			? fontFaceCss(
					excalidrawFontFaces(request.fontsDir, request.settings.cjkFonts),
					familyNames(
						picked.elements
							.filter((element) => element.type === "text")
							.map((element) => element.fontFamily),
					),
					ctx.siteBase,
				)
			: "";
	return renderSceneSvg({
		scene: laidOut,
		elements: picked.elements,
		viewBounds: picked.viewBounds,
		frameRendering: picked.frameRendering ?? scene.appState.frameRendering,
		padding: picked.padding ?? settings.padding,
		// A drawing inside another takes the host's theme and canvas.
		background: request.size ? false : settings.background,
		theme: request.size ? "light" : settings.theme,
		links,
		images,
		fontCss,
		idPrefix: idPrefixFor(request),
		label: request.label,
		className: request.className,
		measure,
		size: request.size,
	});
}
