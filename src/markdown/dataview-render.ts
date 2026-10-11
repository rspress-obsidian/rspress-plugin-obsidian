/**
 * HTML for Dataview values, the way Dataview's `Lit` component shows them:
 * `-` for null, strings as inline Markdown (so `[[links]]` in a field value
 * are links), dates in the default "MMMM dd, yyyy" / "h:mm a - MMMM dd, yyyy"
 * formats, durations in words, lists and objects as nested lists — or
 * comma-separated inside an inline query. Never JSON.
 */
import type { PhrasingContent, Root, RootContent } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { escapeHtmlAttribute, escapeHtmlText, sanitizeUrl } from "../shared/escape.js";
import { extractInlineFields } from "./dataview-metadata.js";
import {
	type DataviewDateFormats,
	DataviewDuration,
	DataviewExternalLink,
	DataviewFunction,
	DataviewLink,
	DataviewListPair,
	NULL_DISPLAY,
	renderDate,
} from "./dataview-values.js";

/** What rendering needs from the query: link targets and the date formats. */
export interface RenderContext {
	/** An `<a>` (or `<img>` for an image embed, or unresolved text) for a link. */
	linkHtml(link: DataviewLink): string;
	formats: DataviewDateFormats;
}

/** Dataview's `maxRecursiveRenderDepth`. */
const MAX_DEPTH = 4;

/** Characters that can change how a string renders as Markdown; anything else is plain text. */
const MARKDOWN_SIGNIFICANT = /[\\*_`~<[\]!=$|:]|www\./;

const markdownParser = unified().use(remarkParse).use(remarkGfm);

export function renderValue(value: unknown, rc: RenderContext, inline = false, depth = 0): string {
	if (depth >= MAX_DEPTH) return "...";
	if (value === null || value === undefined) return NULL_DISPLAY;
	if (typeof value === "string") return renderMarkdownInline(value, rc);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value instanceof Date) return escapeHtmlText(renderDate(value, rc.formats));
	if (value instanceof DataviewDuration) return escapeHtmlText(value.toHuman());
	if (value instanceof DataviewLink) return rc.linkHtml(value);
	if (value instanceof DataviewListPair) {
		return `${renderValue(value.key, rc, inline, depth)}: ${renderValue(value.value, rc, inline, depth)}`;
	}
	if (value instanceof DataviewExternalLink) {
		const href = sanitizeUrl(value.url);
		const label = escapeHtmlText(value.display ?? value.url);
		return href
			? `<a href="${escapeHtmlAttribute(href)}" rel="noopener" target="_blank" class="external-link">${label}</a>`
			: label;
	}
	if (value instanceof DataviewFunction || typeof value === "function") return "&lt;function&gt;";
	if (Array.isArray(value)) {
		if (inline) {
			if (value.length === 0) return "&lt;Empty List&gt;";
			return `<span class="dataview dataview-result-list-span">${value
				.map((item) => renderValue(item, rc, true, depth + 1))
				.join(", ")}</span>`;
		}
		return `<ul class="dataview dataview-ul dataview-result-list-ul">${value
			.map(
				(item) =>
					`<li class="dataview-result-list-li">${renderValue(item, rc, false, depth + 1)}</li>`,
			)
			.join("")}</ul>`;
	}
	const entries = Object.entries(value as Record<string, unknown>);
	if (inline) {
		if (entries.length === 0) return "&lt;Empty Object&gt;";
		return `<span class="dataview dataview-result-object-span">${entries
			.map(([key, item]) => `${escapeHtmlText(key)}: ${renderValue(item, rc, true, depth + 1)}`)
			.join(", ")}</span>`;
	}
	return `<ul class="dataview dataview-ul dataview-result-object-ul">${entries
		.map(
			([key, item]) =>
				`<li class="dataview dataview-li dataview-result-object-li">${escapeHtmlText(key)}: ${renderValue(item, rc, false, depth + 1)}</li>`,
		)
		.join("")}</ul>`;
}

/**
 * Inline Markdown for a field value or task text: emphasis, code, links,
 * `[[wikilinks]]` and inline fields render; raw HTML is shown as text.
 */
export function renderMarkdownInline(text: string, rc: RenderContext): string {
	if (!MARKDOWN_SIGNIFICANT.test(text)) return escapeHtmlText(text).replace(/\n/g, "<br>");
	const root = markdownParser.parse(text) as Root;
	return root.children.map((block) => renderBlock(block, text, rc)).join("<br>");
}

function renderBlock(block: RootContent, source: string, rc: RenderContext): string {
	if (block.type === "paragraph" || block.type === "heading") {
		return block.children.map((child) => renderPhrasing(child, rc)).join("");
	}
	const position = "position" in block ? block.position : undefined;
	const start = position?.start.offset;
	const end = position?.end.offset;
	const raw = start !== undefined && end !== undefined ? source.slice(start, end) : "";
	return escapeHtmlText(raw).replace(/\n/g, "<br>");
}

function renderChildren(children: PhrasingContent[], rc: RenderContext): string {
	return children.map((child) => renderPhrasing(child, rc)).join("");
}

function renderPhrasing(node: PhrasingContent, rc: RenderContext): string {
	switch (node.type) {
		case "text":
			return renderText(node.value, rc);
		case "emphasis":
			return `<em>${renderChildren(node.children, rc)}</em>`;
		case "strong":
			return `<strong>${renderChildren(node.children, rc)}</strong>`;
		case "delete":
			return `<del>${renderChildren(node.children, rc)}</del>`;
		case "inlineCode":
			return `<code>${escapeHtmlText(node.value)}</code>`;
		case "break":
			return "<br>";
		case "link": {
			const href = sanitizeUrl(node.url);
			const label = renderChildren(node.children, rc);
			return href ? `<a href="${escapeHtmlAttribute(href)}">${label}</a>` : label;
		}
		case "image": {
			const src = sanitizeUrl(node.url);
			return src
				? `<img src="${escapeHtmlAttribute(src)}" alt="${escapeHtmlAttribute(node.alt ?? "")}" />`
				: escapeHtmlText(node.alt ?? "");
		}
		case "html":
			return escapeHtmlText(node.value);
		case "footnoteReference":
			return escapeHtmlText(`[^${node.identifier}]`);
		default:
			return "children" in node && Array.isArray(node.children)
				? renderChildren(node.children as PhrasingContent[], rc)
				: "value" in node && typeof node.value === "string"
					? escapeHtmlText(node.value)
					: "";
	}
}

const WIKILINK = /(!?)\[\[([^[\]]+?)\]\]/g;

/** Plain text with `[[wikilinks]]` resolved. */
function renderLinkedText(text: string, rc: RenderContext): string {
	let html = "";
	let cursor = 0;
	for (const match of text.matchAll(WIKILINK)) {
		html += escapeHtmlText(text.slice(cursor, match.index));
		html += rc.linkHtml(DataviewLink.parseInner(match[2] ?? "", match[1] === "!"));
		cursor = match.index + match[0].length;
	}
	return html + escapeHtmlText(text.slice(cursor));
}

/** `[key:: value]` shows key and value; `(key:: value)` shows only the value, as in Dataview. */
export function inlineFieldHtml(key: string, valueHtml: string, wrapping: "[" | "("): string {
	return wrapping === "["
		? `<span class="dataview inline-field"><span class="dataview inline-field-key">${escapeHtmlText(key)}</span><span class="dataview inline-field-value">${valueHtml}</span></span>`
		: `<span class="dataview inline-field"><span class="dataview inline-field-standalone-value">${valueHtml}</span></span>`;
}

function renderText(text: string, rc: RenderContext): string {
	let html = "";
	let cursor = 0;
	for (const field of extractInlineFields(text)) {
		if (field.wrapping !== "[" && field.wrapping !== "(") continue;
		html += renderLinkedText(text.slice(cursor, field.start), rc);
		html += inlineFieldHtml(field.key, renderLinkedText(field.value, rc), field.wrapping);
		cursor = field.end;
	}
	return html + renderLinkedText(text.slice(cursor), rc);
}
