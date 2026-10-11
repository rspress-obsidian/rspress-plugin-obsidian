import fs from "node:fs";
import path from "node:path";
import type { Html, PhrasingContent, Root } from "mdast";
import type { Node, Parent } from "unist";
import { visit } from "unist-util-visit";
import type { VFile } from "vfile";
import { escapeHtmlText } from "../shared/escape.js";
import { stripFrontmatter } from "../shared/frontmatter.js";
import {
	expandDailyTemplateTokens,
	formatDailyNoteDate,
	isEmptyDailyNoteBody,
	parseDailyNoteDate,
	renderDailyNavigation,
} from "./daily-notes.js";
import { type DataviewSettings, renderDataviewInline, renderDataviewQuery } from "./dataview.js";
import { parseExpression } from "./dataview-expression.js";
import { renderDataviewJs, renderDataviewJsInline } from "./dataview-js.js";
import { extractInlineFields } from "./dataview-metadata.js";
import { createTextNode, reportPluginDiagnostic, SKIP_PARENT_TYPES } from "./remark-diagnostics.js";
import { parseObsidianMarkdown } from "./syntax.js";
import type { ContentIndex, ContentPage, NormalizedPluginOptions } from "./types.js";

/** The plugin options the Dataview pass reads. */
type DataviewPassOptions = Pick<
	NormalizedPluginOptions,
	"onDataviewError" | "dailyNotes" | "enableCaseInsensitiveLookup" | "enableFuzzyMatching"
>;

function reportDataviewDiagnostic(
	file: VFile,
	options: DataviewPassOptions,
	message: string,
): void {
	reportPluginDiagnostic(
		file,
		"dataview",
		message,
		options.onDataviewError === "error" ? "fail" : "warn",
	);
}

function toHtml(node: Node, value: string): void {
	// The code node is rewritten in place so the tree keeps its position.
	const html = node as Html;
	html.type = "html";
	html.value = value;
}

/**
 * Render `dataview` / `dataviewjs` fences, inline queries — `` `= expr` `` and
 * `` `$= expr` ``, inline code starting with Dataview's prefixes — and
 * `[key:: value]` / `(key:: value)` inline fields. Plain prose is never
 * evaluated: `x = name` in a sentence is text, as it is in Obsidian.
 */
export function processDataviewNodes(
	tree: Root,
	currentPage: ContentPage,
	index: ContentIndex,
	file: VFile,
	options: DataviewPassOptions,
): void {
	const settings: DataviewSettings = {
		resolve: {
			enableCaseInsensitiveLookup: options.enableCaseInsensitiveLookup,
			enableFuzzyMatching: options.enableFuzzyMatching,
		},
	};
	const report = (result: { html?: string; error?: string }, node: Node) => {
		if (result.error) {
			reportDataviewDiagnostic(file, options, result.error);
			return;
		}
		if (result.html !== undefined) toHtml(node, result.html);
	};

	visit(tree, "code", (node) => {
		const language = node.lang?.toLowerCase();
		if (language === "dataviewjs") {
			report(renderDataviewJs(node.value, currentPage, index, options.dailyNotes, settings), node);
		} else if (language === "dataview") {
			report(
				renderDataviewQuery(node.value, currentPage, index, options.dailyNotes, settings),
				node,
			);
		}
	});

	visit(tree, "inlineCode", (node, _position, parent) => {
		// Code inside a link is the link's label, not a query.
		if (parent?.type === "link" || parent?.type === "linkReference") return;
		const text = node.value;
		if (text.startsWith("$=")) {
			const source = text.slice(2).trim();
			if (source) {
				report(
					renderDataviewJsInline(source, currentPage, index, options.dailyNotes, settings),
					node,
				);
			}
		} else if (text.startsWith("=")) {
			const expression = text.slice(1).trim();
			if (!expression) return;
			// Code that merely begins with `=` — `==highlight==` shown as
			// syntax, a spreadsheet formula — is code, not a query: Dataview
			// would print a parse error into the note, and a published page
			// should not. Only a complete expression is evaluated, and only its
			// evaluation errors are reported.
			try {
				parseExpression(expression);
			} catch {
				return;
			}
			report(
				renderDataviewInline(expression, currentPage, index, options.dailyNotes, settings),
				node,
			);
		}
	});

	const parents: Parent[] = [];
	visit(tree, (node) => {
		if (!("children" in node) || SKIP_PARENT_TYPES[node.type]) return;
		if (node.children.some((child) => child.type === "text" && child.value.includes("::"))) {
			parents.push(node);
		}
	});
	for (const parent of parents) renderInlineFields(parent);
}

/** Stand-in for a non-text child, so a field value may span links, emphasis or code. */
const OPAQUE = "\uFFFC";

/**
 * Show `[key:: value]` as key and value and `(key:: value)` as the value
 * alone, as Dataview's reading view does. The children are read as one string
 * with every non-text child as a single opaque character, so a value holding
 * a `[[link]]` or `**bold**` keeps those nodes (and their later rendering)
 * intact.
 */
function renderInlineFields(parent: Parent): void {
	const children = parent.children as PhrasingContent[];
	const segments: Array<{ node: PhrasingContent; start: number; end: number }> = [];
	let flat = "";
	for (const node of children) {
		const text = node.type === "text" ? node.value : OPAQUE;
		segments.push({ node, start: flat.length, end: flat.length + text.length });
		flat += text;
	}
	const fields = extractInlineFields(flat).filter(
		(field) => (field.wrapping === "[" || field.wrapping === "(") && !field.key.includes(OPAQUE),
	);
	if (fields.length === 0) return;

	const slice = (from: number, to: number): PhrasingContent[] => {
		const nodes: PhrasingContent[] = [];
		for (const { node, start, end } of segments) {
			if (end <= from || start >= to) continue;
			if (node.type !== "text") {
				nodes.push(node);
				continue;
			}
			const value = node.value.slice(Math.max(0, from - start), Math.min(end, to) - start);
			if (value) nodes.push(createTextNode(value));
		}
		return nodes;
	};

	const next: PhrasingContent[] = [];
	let cursor = 0;
	for (const field of fields) {
		next.push(...slice(cursor, field.start));
		const separator = flat.indexOf("::", field.start + 1);
		let valueStart = separator + 2;
		let valueEnd = field.end - 1;
		while (valueStart < valueEnd && /\s/.test(flat[valueStart] ?? "")) valueStart += 1;
		while (valueEnd > valueStart && /\s/.test(flat[valueEnd - 1] ?? "")) valueEnd -= 1;
		next.push({
			type: "html",
			value:
				field.wrapping === "["
					? `<span class="dataview inline-field"><span class="dataview inline-field-key">${escapeHtmlText(field.key)}</span><span class="dataview inline-field-value">`
					: '<span class="dataview inline-field"><span class="dataview inline-field-standalone-value">',
		});
		next.push(...slice(valueStart, valueEnd));
		next.push({ type: "html", value: "</span></span>" });
		cursor = field.end;
	}
	next.push(...slice(cursor, flat.length));
	parent.children = next;
}

/**
 * Read the configured daily-note template, if it exists.
 *
 * The path is relative to the root the page came from, so a vault template works
 * for vault pages and a docs template for docs pages. A missing file is not an
 * error: the option is a convenience, and a template that has not been written
 * yet should not fail the build.
 */
function readDailyNoteTemplate(template: string, docsRoot: string): string | undefined {
	const relative =
		template.endsWith(".md") || template.endsWith(".mdx") ? template : `${template}.md`;
	const absolute = path.join(docsRoot, relative);
	try {
		if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return undefined;
		return stripFrontmatter(fs.readFileSync(absolute, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * Daily-note template filling and previous/next navigation.
 *
 * `{{date}}`, `{{time}}`, `{{title}}` and the other template tokens belong to
 * the template: Obsidian expands them once, when it creates a note from the
 * template. So they are expanded only in a template applied to an empty daily
 * note; a note's own text keeps any `{{…}}` it contains. A template plugin
 * (Templater) then runs over the result, as it does after the core plugin.
 */
export async function processDailyNoteNodes(
	tree: Root,
	currentPage: ContentPage,
	index: ContentIndex,
	options: Pick<NormalizedPluginOptions, "dailyNotes" | "enableMath">,
	includePageDecorations: boolean,
	docsRoot: string,
	source: string,
	{
		now = new Date(),
		expandTemplate,
	}: {
		/** The clock `{{time}}` reads; the build time by default. */
		now?: Date;
		/** Runs over the filled template before it is parsed (Templater). */
		expandTemplate?: (template: string) => Promise<string>;
	} = {},
): Promise<void> {
	const date = parseDailyNoteDate(currentPage.relativePath, options.dailyNotes);
	if (!date) return;

	if (options.dailyNotes.template && isEmptyDailyNoteBody(stripFrontmatter(source))) {
		const template = readDailyNoteTemplate(options.dailyNotes.template, docsRoot);
		if (template) {
			const format = options.dailyNotes.dateFormat;
			const tokensExpanded = expandDailyTemplateTokens(
				template,
				date,
				formatDailyNoteDate(date, format),
				{ format, now },
			);
			const filled = expandTemplate ? await expandTemplate(tokensExpanded) : tokensExpanded;
			// The template is note content: it must tokenize `[[links]]`,
			// `==highlights==` and math exactly as the page it replaces would.
			tree.children = parseObsidianMarkdown(filled, { enableMath: options.enableMath }).children;
		}
	}

	if (includePageDecorations && options.dailyNotes.navigation) {
		const navigation = renderDailyNavigation(currentPage, index.pages, options.dailyNotes);
		if (navigation) {
			tree.children.unshift({ type: "html", value: navigation });
		}
	}
}
