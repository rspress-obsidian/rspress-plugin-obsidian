/**
 * A scene drawn as static SVG markup, element by element, the way
 * Excalidraw's own `exportToSvg` (`renderer/staticSvgScene.ts`) draws it: the
 * same transforms, opacity attributes, frame clipping and text layout, so a
 * drawing published here and one exported from Obsidian line up.
 *
 * Everything that depends on the site — where a link goes, where an image is
 * served, which fonts are available — is resolved beforehand and handed in.
 */
import {
	MERMAID_BLOCK_CLASS,
	MERMAID_SECURITY_ATTRIBUTE,
	type MermaidSecurityLevel,
} from "../../../mermaid/classes.js";
import { escapeHtmlAttribute, escapeHtmlText } from "../../../shared/escape.js";
import {
	arrowLabelPosition,
	type Bounds,
	commonBounds,
	type ElementsById,
	elementCoords,
} from "./bounds.js";
import { baselineOffset, fontFamilyCss } from "./fonts.js";
import type { TextMeasurer } from "./measure.js";
import type { ExcalidrawElement, FrameRendering, Scene } from "./scene.js";
import {
	cornerRadius,
	drawablePaths,
	elementDrawables,
	freedrawPath,
	isPathALoop,
} from "./shapes.js";
import { textWidth, wrapText } from "./text.js";

/** `light` and `dark` are fixed; `auto` follows the site's `.dark` class. */
export type DrawingTheme = "light" | "dark" | "auto";

/** Where an element links: an href, or the reason it could not be resolved. */
export type ElementLink = { href: string; external: boolean } | { unresolved: string };

/** What an image element shows. */
export type ImageSource =
	| { kind: "image"; href: string; mimeType: string }
	/** HTML laid into the element's box: a markdown note or a formula. */
	| { kind: "html"; html: string }
	/** Another drawing, already drawn to fit the element's box. */
	| { kind: "svg"; markup: string }
	/**
	 * A Mermaid diagram (`customData.mermaidText`). With `securityLevel`, the
	 * site's Mermaid renderer draws it in the browser; without, its source shows.
	 */
	| { kind: "mermaid"; source: string; securityLevel?: MermaidSecurityLevel }
	/** A page of a PDF (`[[file.pdf#page=N]]`), shown by the browser's PDF viewer. */
	| { kind: "pdf"; href: string; name: string; page: number }
	| { kind: "missing"; reason: string };

export interface RenderInput {
	scene: Scene;
	/** The elements to draw, in z-order (a crop draws a subset). */
	elements: ExcalidrawElement[];
	/** The scene area the picture shows; without it, the drawn elements' bounds. */
	viewBounds?: Bounds;
	frameRendering: FrameRendering;
	padding: number;
	background: boolean;
	theme: DrawingTheme;
	links: ReadonlyMap<string, ElementLink>;
	images: ReadonlyMap<string, ImageSource>;
	/** `@font-face` rules for the fonts the drawing uses. */
	fontCss: string;
	/** Prefix for the ids the SVG defines, unique per picture on a page. */
	idPrefix: string;
	/** Accessible name of the picture. */
	label: string;
	className: string;
	/** Measures the labels the picture adds: frame names, embed placeholders. */
	measure: TextMeasurer;
	/** Draw into a box of this size, stretched: another drawing's image element. */
	size?: { width: number; height: number };
}

/** Excalidraw's dark export (`THEME_FILTER`) and the counter-filter that keeps photos natural. */
export const THEME_FILTER = "invert(93%) hue-rotate(180deg)";
export const IMAGE_INVERT_FILTER = "invert(100%) hue-rotate(180deg) saturate(1.25)";

const FRAME_STYLE = {
	strokeColor: "#bbb",
	strokeWidth: 2,
	radius: 8,
	nameOffsetY: 3,
	nameColorLight: "#999999",
	nameColorDark: "#7a7a7a",
	nameFontSize: 14,
	nameLineHeight: 1.25,
};

const IFRAME_LIKE: Record<string, true> = { iframe: true, embeddable: true };

function round(value: number): string {
	return String(Math.round(value * 100) / 100);
}

/** A frame's name as a text element above it (`addFrameLabelsAsTextElements`), cut to the frame's width. */
export function frameLabel(
	frame: ExcalidrawElement,
	dark: boolean,
	measure: TextMeasurer,
): ExcalidrawElement {
	const fontSize = FRAME_STYLE.nameFontSize;
	const height = fontSize * FRAME_STYLE.nameLineHeight;
	let text = frame.name ?? (frame.type === "magicframe" ? "AI Frame" : "Frame");
	let width = measure.lineWidth(text, fontSize, 2);
	if (width > frame.width) {
		// `truncateText`: the longest start that fits with an ellipsis.
		for (let end = text.length; end > 0; end -= 1) {
			const cut = `${text.slice(0, end)}...`;
			if (measure.lineWidth(cut, fontSize, 2) <= frame.width) {
				text = cut;
				break;
			}
		}
		width = frame.width;
	}
	return {
		...frame,
		id: `${frame.id}-label`,
		type: "text",
		x: frame.x,
		y: frame.y - FRAME_STYLE.nameOffsetY - height,
		width,
		height,
		angle: 0,
		opacity: 100,
		strokeColor: dark ? FRAME_STYLE.nameColorDark : FRAME_STYLE.nameColorLight,
		text,
		originalText: text,
		fontSize,
		fontFamily: 2,
		textAlign: "left",
		verticalAlign: "top",
		containerId: null,
		lineHeight: FRAME_STYLE.nameLineHeight,
		frameId: null,
		link: null,
		groupIds: [],
		boundElements: [],
	};
}

interface Context {
	input: RenderInput;
	byId: ElementsById;
	offsetX: number;
	offsetY: number;
	defs: string[];
	dark: boolean;
}

function transform(
	element: ExcalidrawElement,
	ctx: Context,
	offsetX: number,
	offsetY: number,
): string {
	const [x1, y1, x2, y2] = elementCoords(element, ctx.byId);
	const cx = (x2 - x1) / 2 - (element.x - x1);
	const cy = (y2 - y1) / 2 - (element.y - y1);
	const degree = (180 * element.angle) / Math.PI;
	return `translate(${round(offsetX)} ${round(offsetY)}) rotate(${round(degree)} ${round(cx)} ${round(cy)})`;
}

function opacityOf(element: ExcalidrawElement, ctx: Context): number {
	const frame = element.frameId ? ctx.byId.get(element.frameId) : undefined;
	return ((frame?.opacity ?? 100) * element.opacity) / 10000;
}

function opacityAttributes(opacity: number): string {
	return opacity === 1 ? "" : ` stroke-opacity="${opacity}" fill-opacity="${opacity}"`;
}

function textNode(
	element: ExcalidrawElement,
	ctx: Context,
	offsetX: number,
	offsetY: number,
): string {
	const lines = element.text.replace(/\r\n?/g, "\n").split("\n");
	const lineHeightPx = element.fontSize * element.lineHeight;
	const horizontal =
		element.textAlign === "center"
			? element.width / 2
			: element.textAlign === "right"
				? element.width
				: 0;
	const vertical = baselineOffset(element.fontFamily, element.fontSize, lineHeightPx);
	const rtl = /[\u0591-\u07FF\uFB1D-\uFDFD\uFE70-\uFEFC]/.test(element.text);
	const anchor =
		element.textAlign === "center"
			? "middle"
			: element.textAlign === "right" || rtl
				? "end"
				: "start";
	const family = escapeHtmlAttribute(fontFamilyCss(element.fontFamily));
	const fill = escapeHtmlAttribute(element.strokeColor);
	const texts = lines
		.map(
			(line, i) =>
				`<text x="${round(horizontal)}" y="${round(i * lineHeightPx + vertical)}" font-family="${family}" font-size="${element.fontSize}px" fill="${fill}" text-anchor="${anchor}" style="white-space: pre;" direction="${rtl ? "rtl" : "ltr"}" dominant-baseline="alphabetic">${escapeHtmlText(line)}</text>`,
		)
		.join("");
	return `<g${opacityAttributes(opacityOf(element, ctx))} transform="${transform(element, ctx, offsetX, offsetY)}">${texts}</g>`;
}

function shapeNode(
	element: ExcalidrawElement,
	ctx: Context,
	offsetX: number,
	offsetY: number,
): string {
	const paths = elementDrawables(element, ctx.input.scene.appState.viewBackgroundColor)
		.map(drawablePaths)
		.join("");
	return `<g stroke-linecap="round"${opacityAttributes(opacityOf(element, ctx))} transform="${transform(element, ctx, offsetX, offsetY)}">${paths}</g>`;
}

function linearNode(
	element: ExcalidrawElement,
	ctx: Context,
	offsetX: number,
	offsetY: number,
): string {
	const opacity = opacityAttributes(opacityOf(element, ctx));
	const loopFill =
		element.type === "line" &&
		isPathALoop(element.points) &&
		element.backgroundColor !== "transparent"
			? ` fill-rule="evenodd"`
			: "";
	const groups = elementDrawables(element, ctx.input.scene.appState.viewBackgroundColor)
		.map(
			(drawable) =>
				`<g${opacity} transform="${transform(element, ctx, offsetX, offsetY)}"${loopFill}>${drawablePaths(drawable)}</g>`,
		)
		.join("");
	const labelRef = element.boundElements.find((bound) => bound.type === "text");
	const label = labelRef ? ctx.byId.get(labelRef.id) : undefined;
	if (!label || label.isDeleted) return `<g stroke-linecap="round">${groups}</g>`;
	// The label sits on the line: the line is masked out behind it.
	const maskId = `${ctx.input.idPrefix}mask-${element.id}`;
	const [lx, ly] = arrowLabelPosition(element, label);
	ctx.defs.push(
		`<mask id="${escapeHtmlAttribute(maskId)}"><rect x="0" y="0" fill="#fff" width="${round(element.width + 100 + offsetX)}" height="${round(element.height + 100 + offsetY)}"/><rect x="${round(offsetX + lx - element.x)}" y="${round(offsetY + ly - element.y)}" fill="#000" width="${round(label.width)}" height="${round(label.height)}" opacity="1"/></mask>`,
	);
	return `<g mask="url(#${escapeHtmlAttribute(maskId)})" stroke-linecap="round">${groups}</g>`;
}

function freedrawNode(
	element: ExcalidrawElement,
	ctx: Context,
	offsetX: number,
	offsetY: number,
): string {
	const fill = elementDrawables(element, ctx.input.scene.appState.viewBackgroundColor)
		.map(drawablePaths)
		.join("");
	return `<g${opacityAttributes(opacityOf(element, ctx))} transform="${transform(element, ctx, offsetX, offsetY)}" stroke="none">${fill}<path fill="${escapeHtmlAttribute(element.strokeColor)}" d="${freedrawPath(element)}"/></g>`;
}

function imageNode(
	element: ExcalidrawElement,
	ctx: Context,
	offsetX: number,
	offsetY: number,
): string {
	const source = element.fileId ? ctx.input.images.get(element.fileId) : undefined;
	const width = Math.round(element.width);
	const height = Math.round(element.height);
	const place = transform(element, ctx, offsetX, offsetY);
	if (!source || source.kind === "missing") {
		// Excalidraw's placeholder for an image whose file is not loaded.
		const reason =
			source?.kind === "missing" ? `<title>${escapeHtmlText(source.reason)}</title>` : "";
		return `<g class="excalidraw-missing-image" transform="${place}">${reason}<rect width="${width}" height="${height}" fill="#e9ecef" stroke="#adb5bd" stroke-dasharray="4 4"/></g>`;
	}
	const opacity = opacityOf(element, ctx);
	if (source.kind === "html") {
		return `<g transform="${place}" opacity="${opacity}"><foreignObject width="${width}" height="${height}"><div xmlns="http://www.w3.org/1999/xhtml" class="excalidraw-embedded-markdown">${source.html}</div></foreignObject></g>`;
	}
	if (source.kind === "svg")
		return `<g transform="${place}" opacity="${opacity}">${source.markup}</g>`;
	if (source.kind === "mermaid") {
		// The site's renderer replaces the placeholder's source with the
		// diagram; without it, the source stays, under its label. A `<div>`,
		// not the notes' `<pre>`: Rspress wraps a `<pre>` in its code block frame.
		const block = source.securityLevel
			? `<div class="${MERMAID_BLOCK_CLASS}" ${MERMAID_SECURITY_ATTRIBUTE}="${escapeHtmlAttribute(source.securityLevel)}" data-code="${escapeHtmlAttribute(source.source)}">${escapeHtmlText(source.source)}</div>`
			: `<div class="excalidraw-mermaid-source">${escapeHtmlText(source.source)}</div>`;
		return `<g transform="${place}" opacity="${opacity}"><foreignObject width="${width}" height="${height}"><div xmlns="http://www.w3.org/1999/xhtml" class="excalidraw-embedded-mermaid"><span class="excalidraw-embed-label">Mermaid</span>${block}</div></foreignObject></g>`;
	}
	if (source.kind === "pdf") {
		const href = escapeHtmlAttribute(`${source.href}#page=${source.page}`);
		const name = escapeHtmlText(source.name);
		// Excalidraw draws the page as a bitmap, so a dark drawing turns it back
		// like a photo. A browser that cannot show a PDF in place shows the link.
		const filter = ctx.dark ? ` filter="${IMAGE_INVERT_FILTER}"` : "";
		return `<g transform="${place}" opacity="${opacity}"><foreignObject width="${width}" height="${height}" data-bitmap=""${filter}><div xmlns="http://www.w3.org/1999/xhtml" class="excalidraw-embedded-pdf"><object data="${escapeHtmlAttribute(`${source.href}#page=${source.page}&toolbar=0&view=Fit`)}" type="application/pdf" aria-label="${escapeHtmlAttribute(`${source.name}, page ${source.page}`)}"><a class="excalidraw-pdf-link" href="${href}" target="_blank" rel="noopener noreferrer"><span class="excalidraw-embed-label">PDF</span><span class="excalidraw-pdf-name">${name}</span><span class="excalidraw-pdf-page">page ${source.page}</span></a></object></div></foreignObject></g>`;
	}
	let uncroppedWidth = element.width;
	let uncroppedHeight = element.height;
	let cropX = 0;
	let cropY = 0;
	if (element.crop) {
		uncroppedWidth = element.width / (element.crop.width / element.crop.naturalWidth);
		uncroppedHeight = element.height / (element.crop.height / element.crop.naturalHeight);
		cropX = element.crop.x / (element.crop.naturalWidth / uncroppedWidth);
		cropY = element.crop.y / (element.crop.naturalHeight / uncroppedHeight);
	}
	const [sx, sy] = element.scale;
	const flip =
		sx !== 1 || sy !== 1
			? ` transform="translate(${round(element.width / 2)} ${round(element.height / 2)}) scale(${sx} ${sy}) translate(${round(-element.width / 2)} ${round(-element.height / 2)})"`
			: "";
	const bitmap = source.mimeType !== "image/svg+xml";
	const filter = bitmap && ctx.dark ? ` filter="${IMAGE_INVERT_FILTER}"` : "";
	const image = `<image href="${escapeHtmlAttribute(source.href)}" x="${round(-cropX)}" y="${round(-cropY)}" width="${round(uncroppedWidth)}" height="${round(uncroppedHeight)}" preserveAspectRatio="none"${bitmap ? ` data-bitmap=""` : ""}${filter}/>`;
	const radius = element.roundness
		? cornerRadius(Math.min(element.width, element.height), element)
		: 0;
	const clipId = `${ctx.input.idPrefix}image-clip-${element.id}`;
	ctx.defs.push(
		`<clipPath id="${escapeHtmlAttribute(clipId)}"><rect width="${round(element.width)}" height="${round(element.height)}"${radius ? ` rx="${round(radius)}" ry="${round(radius)}"` : ""}/></clipPath>`,
	);
	return `<g transform="${place}" opacity="${opacity}"><g clip-path="url(#${escapeHtmlAttribute(clipId)})"><g${flip}>${image}</g></g></g>`;
}

function frameNode(
	element: ExcalidrawElement,
	ctx: Context,
	offsetX: number,
	offsetY: number,
): string {
	const { frameRendering } = ctx.input;
	if (!frameRendering.enabled || !frameRendering.outline) return "";
	return `<rect transform="${transform(element, ctx, offsetX, offsetY)}" width="${round(element.width)}" height="${round(element.height)}" rx="${FRAME_STYLE.radius}" ry="${FRAME_STYLE.radius}" fill="none" stroke="${FRAME_STYLE.strokeColor}" stroke-width="${FRAME_STYLE.strokeWidth}"/>`;
}

/** The label Excalidraw draws inside an embed it does not render live (`createPlaceholderEmbeddableLabel`). */
function embeddableLabel(element: ExcalidrawElement, measure: TextMeasurer): ExcalidrawElement {
	const label = element.type === "iframe" ? "IFrame element" : element.link || "Empty Web-Embed";
	const fontSize = Math.max(
		Math.min(element.width / 2, element.width / label.length),
		element.width / 30,
	);
	const lineWidth = (line: string) => measure.lineWidth(line, fontSize, 2);
	const text = wrapText(label, element.width - 20, lineWidth);
	const width = textWidth(text, lineWidth);
	const height = text.split("\n").length * fontSize * 1.15;
	return {
		...element,
		id: `${element.id}-label`,
		type: "text",
		x: element.x + (element.width - width) / 2,
		y: element.y + (element.height - height) / 2,
		width,
		height,
		strokeColor: element.strokeColor !== "transparent" ? element.strokeColor : "black",
		text,
		originalText: label,
		fontSize,
		fontFamily: 2,
		textAlign: "center",
		verticalAlign: "middle",
		lineHeight: 1.15,
		containerId: null,
		link: null,
	};
}

function elementNode(element: ExcalidrawElement, ctx: Context): string {
	const offsetX = element.x + ctx.offsetX;
	const offsetY = element.y + ctx.offsetY;
	switch (element.type) {
		case "rectangle":
		case "diamond":
		case "ellipse":
			return shapeNode(element, ctx, offsetX, offsetY);
		case "iframe":
		case "embeddable": {
			const label = embeddableLabel(element, ctx.input.measure);
			return `${shapeNode(element, ctx, offsetX, offsetY)}${textNode(label, ctx, label.x + ctx.offsetX, label.y + ctx.offsetY)}`;
		}
		case "line":
		case "arrow":
			return linearNode(element, ctx, offsetX, offsetY);
		case "freedraw":
			return freedrawNode(element, ctx, offsetX, offsetY);
		case "image":
			return imageNode(element, ctx, offsetX, offsetY);
		case "frame":
		case "magicframe":
			return frameNode(element, ctx, offsetX, offsetY);
		case "text": {
			const container = element.containerId ? ctx.byId.get(element.containerId) : undefined;
			if (container?.type === "arrow") {
				const [x, y] = arrowLabelPosition(container, element);
				return textNode(element, ctx, x + ctx.offsetX, y + ctx.offsetY);
			}
			return textNode(element, ctx, offsetX, offsetY);
		}
		default:
			return "";
	}
}

/** An element, behind its link and inside its frame's clip. */
function placedNode(element: ExcalidrawElement, ctx: Context): string {
	let node = elementNode(element, ctx);
	if (!node) return "";
	const frame = element.frameId ? ctx.byId.get(element.frameId) : undefined;
	if (frame && ctx.input.frameRendering.enabled && ctx.input.frameRendering.clip) {
		node = `<g clip-path="url(#${escapeHtmlAttribute(`${ctx.input.idPrefix}frame-${frame.id}`)})">${node}</g>`;
	}
	const link = ctx.input.links.get(element.id);
	if (!link) return node;
	if ("unresolved" in link) {
		return `<g class="excalidraw-unresolved-link"><title>${escapeHtmlText(link.unresolved)}</title>${node}</g>`;
	}
	const target = link.external ? ` target="_blank" rel="noopener noreferrer"` : "";
	return `<a href="${escapeHtmlAttribute(link.href)}"${target}>${node}</a>`;
}

/** Elements whose frame is drawn too are clipped by it and do not widen the picture (`getRootElements`). */
function rootElements(elements: readonly ExcalidrawElement[]): ExcalidrawElement[] {
	const frames = new Set(
		elements
			.filter((element) => element.type === "frame" || element.type === "magicframe")
			.map((frame) => frame.id),
	);
	return elements.filter((element) => !element.frameId || !frames.has(element.frameId));
}

/** The scene, drawn as one `<svg>` element. */
export function renderSceneSvg(input: RenderInput): string {
	const dark = input.theme === "dark";
	const labelled: ExcalidrawElement[] = [];
	for (const element of input.elements) {
		const isFrame = element.type === "frame" || element.type === "magicframe";
		if (isFrame && input.frameRendering.enabled && input.frameRendering.name) {
			labelled.push(frameLabel(element, dark, input.measure));
		}
		labelled.push(element);
	}
	const byId: Map<string, ExcalidrawElement> = new Map(
		input.scene.elements.map((element) => [element.id, element]),
	);
	for (const element of labelled) byId.set(element.id, element);
	const [minX, minY, maxX, maxY] = input.viewBounds ?? commonBounds(rootElements(labelled), byId);
	const width = maxX - minX + input.padding * 2;
	const height = maxY - minY + input.padding * 2;
	const ctx: Context = {
		input,
		byId,
		offsetX: -minX + input.padding,
		offsetY: -minY + input.padding,
		defs: [],
		dark,
	};

	for (const frame of labelled) {
		if (frame.type !== "frame" && frame.type !== "magicframe") continue;
		const [x1, y1, x2, y2] = elementCoords(frame, byId);
		const cx = (x2 - x1) / 2 - (frame.x - x1);
		const cy = (y2 - y1) / 2 - (frame.y - y1);
		ctx.defs.push(
			`<clipPath id="${escapeHtmlAttribute(`${input.idPrefix}frame-${frame.id}`)}"><rect transform="translate(${round(frame.x + ctx.offsetX)} ${round(frame.y + ctx.offsetY)}) rotate(${round(frame.angle)} ${round(cx)} ${round(cy)})" width="${round(frame.width)}" height="${round(frame.height)}" rx="${FRAME_STYLE.radius}" ry="${FRAME_STYLE.radius}"/></clipPath>`,
		);
	}

	const bound = new Set(
		labelled
			.filter(
				(element) =>
					element.type === "text" && element.containerId && byId.has(element.containerId),
			)
			.map((element) => element.id),
	);
	const body: string[] = [];
	const draw = (element: ExcalidrawElement): void => {
		if (bound.has(element.id)) return;
		body.push(placedNode(element, ctx));
		const label = element.boundElements.find((ref) => ref.type === "text");
		const text = label ? byId.get(label.id) : undefined;
		if (text && !text.isDeleted && bound.has(text.id)) body.push(placedNode(text, ctx));
	};
	for (const element of labelled) if (!IFRAME_LIKE[element.type]) draw(element);
	for (const element of labelled) if (IFRAME_LIKE[element.type]) draw(element);

	const style = input.fontCss ? `<style>${input.fontCss}</style>` : "";
	const backdrop = input.background
		? `<rect class="excalidraw-background" x="0" y="0" width="${round(width)}" height="${round(height)}" fill="${escapeHtmlAttribute(input.scene.appState.viewBackgroundColor)}"/>`
		: "";
	const filter = dark ? ` filter="${THEME_FILTER}"` : "";
	const themeClass = input.theme === "auto" ? " excalidraw-theme-auto" : "";
	const size = input.size
		? `width="${round(input.size.width)}" height="${round(input.size.height)}" preserveAspectRatio="none"`
		: `width="${round(width)}" height="${round(height)}"`;
	return `<svg version="1.1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${round(width)} ${round(height)}" ${size} class="${escapeHtmlAttribute(input.className)}${themeClass}"${filter} role="img" aria-label="${escapeHtmlAttribute(input.label)}"><defs>${style}${ctx.defs.join("")}</defs>${backdrop}${body.join("")}</svg>`;
}
