import { createHash } from "node:crypto";
import path from "node:path";
import type { Code, Html, RootContent } from "mdast";
import { escapeHtmlAttribute, escapeHtmlText } from "../../../shared/escape.js";
import { publishedFileRoutes, setPublishedFileRoutes } from "../../../shared/file-routes.js";
import { extensionOf } from "../../../shared/media-exts.js";
import { withSiteBase } from "../../media.js";
import { mirrorFiles } from "../../mirror-files.js";
import { publicDirectoryPlugin } from "../../public-dir.js";
import type { ContentPage, ParsedWikiLink } from "../../types.js";
import type { ObsidianPluginFeature, PluginRenderContext } from "../types.js";
import { drawingSettings, type ExcalidrawSettings, resolveSettings } from "./config.js";
import {
	type Drawing,
	drawingPathOf,
	drawingSvg,
	FILE_ROUTE_KIND,
	isDrawingFile,
	loadDrawing,
} from "./drawing.js";
import { backOfNoteEnd } from "./drawing-file.js";
import { excalidrawFontsDir } from "./fonts.js";
import {
	exportedImages,
	filesToStage,
	markedDrawing,
	plainDrawingPage,
	plainDrawingRoutes,
	stagingDir,
} from "./publish.js";
import { parseSceneJson, SceneError } from "./scene.js";

/** The fonts folder of the optional peer, looked up once. */
let peerFontsDir: { dir: string | undefined } | undefined;

function fontsDir(): string | undefined {
	peerFontsDir ??= { dir: excalidrawFontsDir() };
	return peerFontsDir.dir;
}

function html(value: string): Html {
	return { type: "html", value };
}

function errorMarkup(tag: "div" | "span", message: string): string {
	return `<${tag} class="excalidraw-error">${escapeHtmlText(`Excalidraw: ${message}`)}</${tag}>`;
}

/** What a published picture is: the scene drawn here, or the image Obsidian exported. */
async function pictureMarkup(
	drawing: Drawing,
	page: ContentPage,
	settings: ExcalidrawSettings,
	ctx: PluginRenderContext,
	options: { subpath?: ParsedWikiLink["subpath"]; className: string; style?: string },
): Promise<string> {
	const label = path.basename(drawing.absolutePath).replace(/\.md$/i, "");
	const style = options.style ? ` style="${escapeHtmlAttribute(options.style)}"` : "";
	if (settings.preferExportedImage && !options.subpath) {
		const { theme } = drawingSettings(settings, drawing.frontmatter, drawing.scene);
		const images = exportedImages(
			drawing.absolutePath,
			theme,
			await ctx.indexFor(drawing.absolutePath),
		);
		if (images.length > 0) {
			return images
				.map(
					({ asset, theme: variant }) =>
						`<img class="${options.className} excalidraw-exported${variant ? ` excalidraw-exported-${variant}` : ""}" src="${escapeHtmlAttribute(withSiteBase(asset.urlPath, ctx.siteBase))}" alt="${escapeHtmlAttribute(label)}"${style}/>`,
				)
				.join("");
		}
	}
	const svg = await drawingSvg(
		{
			drawing,
			page,
			settings,
			subpath: options.subpath,
			label,
			className: options.className,
			fontsDir: fontsDir(),
		},
		ctx,
	);
	return style ? svg.replace("<svg ", `<svg${style} `) : svg;
}

/** Nodes that carry the page's metadata rather than its body (frontmatter, MDX imports). */
const METADATA_NODES: Record<string, true> = { yaml: true, toml: true, mdxjsEsm: true };

/** The back of the note: what sits above the plugin's data, without its "switch views" banner. */
function backOfNote(children: RootContent[], source: string, dataStart: number): RootContent[] {
	return children.filter((node) => {
		const start = node.position?.start.offset;
		const end = node.position?.end.offset;
		if (start === undefined || end === undefined || end > dataStart || METADATA_NODES[node.type]) {
			return false;
		}
		return !/Switch to EXCALIDRAW VIEW/.test(source.slice(start, end));
	});
}

/** The drawing a plain `.excalidraw` file's generated page names, and a page to resolve its links from. */
function generatedDrawing(
	ctx: PluginRenderContext,
): { absolutePath: string; page: ContentPage } | undefined {
	const source = markedDrawing(ctx.source);
	const route = publishedFileRoutes(FILE_ROUTE_KIND).find(
		(candidate) => candidate.source === source,
	);
	if (!route) return undefined;
	return {
		absolutePath: route.absolutePath,
		page: {
			...ctx.currentPage,
			absolutePath: route.absolutePath,
			relativePath: route.source,
			routePath: route.routePath,
			baseName: path.basename(route.source),
		},
	};
}

/** The plugin's own headings: where a drawing note's outline stops being the author's. */
const DATA_HEADINGS: Record<string, true> = {
	"Excalidraw Data": true,
	"Text Elements": true,
	"Element Links": true,
	"Embedded Files": true,
	Drawing: true,
};

/** The page data Rspress derives from a note's source, which for a drawing is its raw data. */
interface PageData {
	title: string;
	toc: { text: string }[];
	content: string;
	_filepath: string;
}

/**
 * A drawing note's page as a reader sees it: titled by its name rather than
 * `# Excalidraw Data`, its outline the back of the note's, and its search text
 * the back of the note plus the drawing's own words instead of the scene data.
 */
async function cleanDrawingPage(page: PageData, search: boolean): Promise<void> {
	if (!(await isDrawingFile(page._filepath))) return;
	if (page.title === "Excalidraw Data")
		page.title = path.basename(page._filepath).replace(/\.md$/i, "");
	const cut = page.toc.findIndex((heading) => DATA_HEADINGS[heading.text.trim()]);
	if (cut !== -1) page.toc = page.toc.slice(0, cut);
	if (!search || !page.content) return;
	const words = await loadDrawing(page._filepath).then(
		(drawing) =>
			drawing.scene.elements
				.filter((element) => element.type === "text" && !element.isDeleted)
				.map((element) => drawing.textElements.get(element.id) ?? element.originalText),
		() => [],
	);
	// Cut, not blanked: the outline's offsets all fall before the data.
	page.content = [page.content.slice(0, backOfNoteEnd(page.content)).trimEnd(), ...words].join(
		"\n",
	);
}

function reportScene(error: unknown, name: string, ctx: PluginRenderContext): string {
	if (!(error instanceof SceneError)) throw error;
	const message = `drawing "${name}" cannot be shown: ${error.message}.`;
	ctx.report(message);
	return message;
}

/**
 * An embed's size and style, from its alias as the plugin reads it
 * (`parseAlias`): `400`, `400x300`, `x300`, `alias|400`, `400|style`.
 */
export function embedPresentation(
	alias: string | undefined,
	defaultWidth: string,
): { style: string; className: string } {
	const parts = (alias ?? "")
		.split("|")
		.map((part) => part.trim())
		.filter(Boolean);
	const dimension = (part: string | undefined) => /^(\d*)(?:x(\d+))?$/.exec(part ?? "");
	let size = dimension(parts[0]);
	let styleName: string | undefined;
	if (parts.length === 1 && !size?.[0]) styleName = parts[0];
	if (parts.length >= 2) {
		const second = dimension(parts[1]);
		if (second?.[0]) {
			size = second;
			styleName = parts[2];
		} else {
			styleName = parts.at(-1);
			if (!size?.[0]) size = null;
		}
	}
	const width = size?.[1] ? `${size[1]}px` : size?.[2] ? undefined : defaultWidth;
	const height = size?.[2];
	const style = [
		width ? `width:${width}` : "",
		height ? `${width ? "min-height" : "max-height"}:${height}px` : "",
	]
		.filter(Boolean)
		.join(";");
	return {
		style,
		className: styleName ? `excalidraw-svg-${styleName.replace(/[^\w-]/g, "")}` : "excalidraw-svg",
	};
}

/** The Excalidraw plugin: `.excalidraw.md` / `.excalidraw` drawings rendered as pictures, in pages and embeds. */
export const excalidrawFeature: ObsidianPluginFeature = {
	id: "excalidraw",
	label: "Excalidraw",
	enableOption: "enableExcalidraw",
	fences: ["excalidraw"],
	isEnabled: (options) => options.enableExcalidraw,

	async renderNote(tree, ctx) {
		const indexed = ctx.index.byAbsolutePath.get(ctx.currentPage.absolutePath) === ctx.currentPage;
		const generated = indexed ? undefined : generatedDrawing(ctx);
		if (!generated && !(indexed && (await isDrawingFile(ctx.currentPage.absolutePath)))) {
			return undefined;
		}
		const absolutePath = generated?.absolutePath ?? ctx.currentPage.absolutePath;
		const settings = resolveSettings(ctx.options);
		let drawing: Drawing;
		try {
			drawing = await loadDrawing(absolutePath);
		} catch (error) {
			return [html(errorMarkup("div", reportScene(error, path.basename(absolutePath), ctx)))];
		}
		const picture = await pictureMarkup(
			drawing,
			generated?.page ?? ctx.currentPage,
			settings,
			ctx,
			{
				className: "excalidraw-svg",
			},
		);
		return [
			...tree.children.filter((node) => METADATA_NODES[node.type]),
			html(`<div class="excalidraw-drawing">${picture}</div>`),
			...(generated ? [] : backOfNote(tree.children, ctx.source, backOfNoteEnd(ctx.source))),
		];
	},

	async renderEmbed(parsed, ctx) {
		const whole = { ...parsed, subpath: undefined };
		let resolved = await ctx.resolve(whole);
		// `![[Drawing]]` names `Drawing.excalidraw.md` the way the plugin's links do.
		if (resolved.status !== "ok" && extensionOf(parsed.target) === "") {
			const named = await ctx.resolve({ ...whole, target: `${parsed.target}.excalidraw` });
			if (named.status === "ok") resolved = named;
		}
		const absolutePath = await drawingPathOf(resolved);
		if (!absolutePath) return undefined;
		const settings = resolveSettings(ctx.options);
		let drawing: Drawing;
		try {
			drawing = await loadDrawing(absolutePath);
		} catch (error) {
			return html(errorMarkup("span", reportScene(error, path.basename(absolutePath), ctx)));
		}
		const page = resolved.targetPage ?? {
			...ctx.currentPage,
			absolutePath,
			relativePath:
				resolved.fileRoute?.source ??
				resolved.targetAsset?.relativePath ??
				path.basename(absolutePath),
		};
		const { style, className } = embedPresentation(parsed.alias, settings.embedWidth);
		const picture = await pictureMarkup(drawing, page, settings, ctx, {
			subpath: parsed.subpath,
			className: `${className} excalidraw-embedded-img`,
			style,
		});
		return html(
			`<span class="internal-embed media-embed image-embed excalidraw-embed" data-src="${escapeHtmlAttribute(parsed.target)}">${picture}</span>`,
		);
	},

	async renderFence(node: Code, ctx) {
		const key = createHash("sha1").update(node.value).digest("hex").slice(0, 8);
		const name = `${path.basename(ctx.currentPage.absolutePath)}#excalidraw-${key}`;
		try {
			const drawing: Drawing = {
				scene: parseSceneJson(node.value),
				textMode: "parsed",
				frontmatter: {},
				textElements: new Map(),
				embeddedFiles: new Map(),
				absolutePath: `${ctx.currentPage.absolutePath}#excalidraw-${key}`,
			};
			const picture = await pictureMarkup(
				drawing,
				ctx.currentPage,
				resolveSettings(ctx.options),
				ctx,
				{
					className: "excalidraw-svg",
				},
			);
			return [html(`<div class="excalidraw-drawing">${picture}</div>`)];
		} catch (error) {
			return [html(errorMarkup("div", reportScene(error, name, ctx)))];
		}
	},

	async extendPageData(pageData) {
		await cleanDrawingPage(pageData, false);
	},

	async modifySearchIndexData(pages) {
		for (const page of pages) await cleanDrawingPage(page, true);
	},

	async addPages(ctx) {
		const routes = plainDrawingRoutes(ctx);
		setPublishedFileRoutes(FILE_ROUTE_KIND, routes);
		const settings = resolveSettings(ctx.options);
		await mirrorFiles(
			stagingDir(ctx.options),
			await filesToStage(ctx, settings, routes, fontsDir()),
		);
		return routes.map((route) => ({
			routePath: route.routePath,
			content: plainDrawingPage(route),
		}));
	},

	builderConfig: (options) => ({
		plugins: [publicDirectoryPlugin("rspress-plugin-obsidian:excalidraw", stagingDir(options))],
	}),
};
