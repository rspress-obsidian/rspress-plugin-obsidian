/**
 * A base rendered to static HTML: every view of it, or the one an embed names,
 * with Obsidian's class names (`bases-view`, `bases-table`, `bases-td`,
 * `bases-cards-item`, …) so CSS snippets written for Obsidian keep working.
 *
 * Several views share one switcher built from radio inputs and CSS (see
 * bases.css): it needs no script, and with no radio chosen the first view —
 * Obsidian's default — shows. On the base's own page each view's element id is
 * the view name, so `[[Projects.base#Board]]` lands on (and shows) that view.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { moduleDir } from "../../../runtime-paths.js";
import { escapeHtmlAttribute, escapeHtmlText, sanitizeUrl } from "../../../shared/escape.js";
import { findPublishedFileRoute } from "../../../shared/file-routes.js";
import { parseWikiLink } from "../../parse-wikilink.js";
import type { ContentPage } from "../../types.js";
import { readObsidianPluginSettings } from "../settings.js";
import type { BuilderConfig, PluginRenderContext } from "../types.js";
import { type BaseConfig, BaseConfigError, parseBaseConfig, type ViewConfig } from "./config.js";
import { type Dataset, datasetFor } from "./dataset.js";
import {
	compileExpression,
	type EvalEnv,
	evaluate,
	type PropertyRef,
	parsePropertyId,
	propertyValue,
	RowScope,
} from "./evaluate.js";
import { lucideIcon } from "./icons.js";
import type { BasesOptions } from "./options.js";
import { type QueryGroup, type QueryRow, runView, summarize } from "./query.js";
import {
	DEFAULT_MAP_TILES,
	DEFAULT_MAP_TILES_DARK,
	MAP_CONFIG_ATTRIBUTE,
	MAP_PIN_CLASS,
	MAP_ROW_ATTRIBUTES,
	MAP_VIEW_CLASS,
	type MapViewConfig,
} from "./runtime/map-markup.js";
import {
	type BaseFile,
	DateValue,
	type DisplayFormats,
	DurationValue,
	ErrorValue,
	FileValue,
	formatDate,
	HtmlValue,
	IconValue,
	ImageValue,
	isEmptyValue,
	isExternalLink,
	LinkValue,
	linkLabel,
	ObjectValue,
	parseDateText,
	plural,
	RegexValue,
	type Value,
	valueToString,
} from "./values.js";

export interface BaseRenderRequest {
	/** The base's YAML. */
	source: string;
	/** Names the base in diagnostics: its path, or "base block". */
	label: string;
	/** `this` for the base's formulas. */
	thisFile: BaseFile | undefined;
	/** Where `link()` and `file()` resolve from. Default: the page being rendered. */
	contextPage?: ContentPage;
	/** Render only this view (`![[x.base#View]]`). */
	viewName?: string;
	/** The base's own page: view elements carry their names as ids. */
	standalone: boolean;
}

/** Counts switchers per rendered file, so radio groups never share a name. */
const switcherCounts = new WeakMap<object, number>();

/** The base as HTML, its problems shown in place and reported through `ctx.report`. */
export async function renderBase(
	request: BaseRenderRequest,
	ctx: PluginRenderContext,
): Promise<string> {
	let config: BaseConfig;
	let warnings: string[];
	try {
		({ config, warnings } = parseBaseConfig(request.source));
	} catch (error) {
		if (!(error instanceof BaseConfigError)) throw error;
		ctx.report(`${request.label}: ${error.message}`);
		return `<div class="bases-error"><strong>${escapeHtmlText(request.label)}</strong>: ${escapeHtmlText(error.message)}</div>`;
	}
	for (const warning of warnings) ctx.report(`${request.label}: ${warning}`, "warn");

	const dataset = await datasetFor(await ctx.publishedIndexes(), ctx.options);
	const formulas: EvalEnv["formulas"] = {};
	for (const [name, source] of Object.entries(config.formulas)) {
		formulas[name] = compileExpression(source);
	}
	const env: EvalEnv = {
		dataset,
		now: resolveNow(ctx.options.bases.now),
		formats: {
			dateFormat: ctx.options.bases.dateFormat ?? "YYYY-MM-DD",
			dateTimeFormat: ctx.options.bases.dateTimeFormat ?? "YYYY-MM-DD HH:mm",
		},
		thisFile: request.thisFile,
		formulas,
		contextPage: request.contextPage ?? ctx.currentPage,
		seed: request.label,
	};
	const renderer = new Renderer(ctx, env, dataset);

	let views = config.views;
	if (request.viewName !== undefined) {
		const view = views.find((candidate) => candidate.name === request.viewName);
		if (!view) {
			const message = `${request.label} has no view named "${request.viewName}" (views: ${views.map((v) => `"${v.name}"`).join(", ")})`;
			ctx.report(message);
			return `<div class="bases-error">${escapeHtmlText(message)}</div>`;
		}
		views = [view];
	}

	const sections: string[] = [];
	for (const view of views) sections.push(await renderView(view, config, request, renderer));
	for (const [message, severity] of renderer.errors) {
		ctx.report(`${request.label}: ${message}`, severity === "warning" ? "warn" : undefined);
	}

	const notices = warnings
		.map((warning) => `<div class="bases-warning">${escapeHtmlText(warning)}</div>`)
		.join("");
	// `rp-toc-exclude`: a view's group and card headings are query output, not
	// the note's headings, so Rspress's outline must not list them.
	return `<div class="bases-container rp-toc-exclude" data-base="${escapeHtmlAttribute(request.label)}">${notices}${switcher(views, sections, ctx)}</div>`;
}

/** The clock option: a `Date`, a date string, or the time of rendering. */
function resolveNow(option: Date | string | undefined): Date {
	if (option instanceof Date) return option;
	if (typeof option === "string") {
		const parsed = parseDateText(option);
		if (parsed) return new Date(parsed.ms);
	}
	return new Date();
}

/** The most views the stylesheet's switcher rules cover; a base with more stacks them. */
const MAX_SWITCHER_VIEWS = 12;

function switcher(views: ViewConfig[], sections: string[], ctx: PluginRenderContext): string {
	if (views.length === 1 || views.length > MAX_SWITCHER_VIEWS) return sections.join("");
	const count = (switcherCounts.get(ctx.file) ?? 0) + 1;
	switcherCounts.set(ctx.file, count);
	const group = `bases-views-${count}`;
	const inputs = views
		.map(
			(_, i) =>
				`<input type="radio" class="bases-view-tab-input" name="${group}" id="${group}-${i + 1}" />`,
		)
		.join("");
	const tabs = views
		.map(
			(view, i) =>
				`<label class="bases-view-tab" for="${group}-${i + 1}" data-view-type="${escapeHtmlAttribute(view.type)}">${escapeHtmlText(view.name)}</label>`,
		)
		.join("");
	return `<div class="bases-views">${inputs}<div class="bases-view-tabs">${tabs}</div>${sections.join("")}</div>`;
}

/** Characters after which a string may be markdown worth rendering. */
const MARKDOWN_SYNTAX = /[[\]*_`#$<>~=!\\&|^%]|:\/\//;

/** Renders values to HTML for one base, rendering each distinct markdown text once. */
class Renderer {
	/** Each distinct error in the base's cells and filters, and its severity. */
	readonly errors = new Map<string, ErrorValue["severity"]>();
	private readonly inlineCache = new Map<string, Promise<string>>();
	/** Icon problems already reported for this base: each is reported once. */
	private readonly iconProblems = new Set<string>();

	constructor(
		readonly ctx: PluginRenderContext,
		readonly env: EvalEnv,
		readonly dataset: Dataset,
	) {}

	get formats(): DisplayFormats {
		return this.env.formats;
	}

	inline(markdown: string, page: ContentPage | undefined): Promise<string> {
		// Only a link, embed or autolink resolves against the page; other text (a
		// tag, formatting) renders the same for every row.
		const key = /[[\]<]/.test(markdown) ? `${page?.absolutePath ?? ""}\0${markdown}` : markdown;
		let rendered = this.inlineCache.get(key);
		if (!rendered) {
			rendered = this.ctx.renderInline(markdown, page ?? this.ctx.currentPage);
			this.inlineCache.set(key, rendered);
		}
		return rendered;
	}

	/** Text as Obsidian shows a text property: links, tags and formatting rendered. */
	text(value: string, page: ContentPage | undefined): Promise<string> {
		return MARKDOWN_SYNTAX.test(value)
			? this.inline(value, page)
			: Promise.resolve(escapeHtmlText(value));
	}

	/** Whether a file has a page or a published URL to link to. */
	linkable(file: BaseFile): boolean {
		return (
			file.page !== undefined ||
			findPublishedFileRoute(file.absolutePath) !== undefined ||
			// An attachment is published only when a page references it.
			this.dataset.backlinks(file).length > 0
		);
	}

	async fileLink(file: BaseFile, label: string): Promise<string> {
		if (!this.linkable(file)) return escapeHtmlText(label);
		const target = file.ext === "md" ? file.path.slice(0, -3) : file.path;
		return this.inline(`[[${target}|${escapeLabel(label)}]]`, this.ctx.currentPage);
	}

	/** The route a file's link goes to (without the site base), when it has one. */
	async route(file: BaseFile): Promise<string | undefined> {
		if (!this.linkable(file)) return undefined;
		const target = file.ext === "md" ? file.path.slice(0, -3) : file.path;
		const resolved = await this.ctx.resolve(
			parseWikiLink(target, `[[${target}]]`),
			this.ctx.currentPage,
		);
		return resolved.status === "ok" ? resolved.href : undefined;
	}

	/**
	 * A Lucide icon as inline SVG, or `undefined` when it cannot be drawn; the
	 * reason is reported once per base, worded by `describe`.
	 */
	icon(
		name: string,
		describe: (problem: string) => string = (problem) => problem,
	): string | undefined {
		const icon = lucideIcon(name);
		if ("svg" in icon) return icon.svg;
		const message = describe(icon.problem);
		if (!this.iconProblems.has(message)) {
			this.iconProblems.add(message);
			this.ctx.report(message, "warn");
		}
		return undefined;
	}

	async link(link: LinkValue): Promise<string> {
		const label = linkLabel(link);
		if (isExternalLink(link)) {
			const href = sanitizeUrl(link.target);
			if (!href) return escapeHtmlText(label);
			return `<a href="${escapeHtmlAttribute(href)}" class="external-link" target="_blank" rel="noopener noreferrer">${escapeHtmlText(label)}</a>`;
		}
		if (link.file && !this.linkable(link.file)) return escapeHtmlText(label);
		// The link renders where it was written, so it resolves (or is reported
		// broken) exactly as the same link in that note does. Shown by its name,
		// not its path, as Obsidian shows a property link.
		return this.inline(
			`[[${link.target}|${escapeLabel(label)}]]`,
			link.source ?? this.ctx.currentPage,
		);
	}

	/** The URL an image value points at, or a colour swatch for a hex colour. */
	imageSource(value: Value, page: ContentPage | undefined): { src?: string; color?: string } {
		const source = value instanceof ImageValue ? value.source : value;
		if (typeof source === "string") {
			const text = source.trim();
			if (/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(text)) return { color: text };
			if (/^(?:https?:|data:image\/)/i.test(text)) return { src: sanitizeUrl(text) ?? undefined };
			return this.imageSource(this.dataset.link(text, page ?? this.env.contextPage), page);
		}
		const file =
			source instanceof LinkValue || source instanceof FileValue ? source.file : undefined;
		if (source instanceof LinkValue && !file && /^https?:/i.test(source.target)) {
			return { src: sanitizeUrl(source.target) ?? undefined };
		}
		if (file?.asset && this.linkable(file)) return { src: file.asset.urlPath };
		return {};
	}

	async image(value: Value, page: ContentPage | undefined, className: string): Promise<string> {
		const { src, color } = this.imageSource(value, page);
		if (color) {
			return `<span class="${className} bases-color-swatch" style="background-color: ${escapeHtmlAttribute(color)}"></span>`;
		}
		if (!src) return "";
		return `<img class="${className}" src="${escapeHtmlAttribute(src)}" alt="" loading="lazy" />`;
	}

	/** A value as a cell shows it. `page` is the row's note: where its text renders. */
	async value(value: Value, page: ContentPage | undefined): Promise<string> {
		if (value === null) return "";
		if (typeof value === "string") return this.text(value, page);
		if (typeof value === "number") return escapeHtmlText(String(value));
		if (typeof value === "boolean") {
			return `<input type="checkbox" class="bases-checkbox" disabled${value ? " checked" : ""} />`;
		}
		if (Array.isArray(value)) {
			if (value.length === 0) return "";
			const items = await Promise.all(
				value.map(
					async (item) => `<span class="value-list-element">${await this.value(item, page)}</span>`,
				),
			);
			return `<span class="value-list-container">${items.join("")}</span>`;
		}
		if (value instanceof ErrorValue) {
			this.errors.set(value.message, value.severity);
			// A note whose data does not fit the formula shows an empty cell, as
			// in Obsidian; the reason stays in the markup and the build log.
			if (value.severity === "warning") {
				return `<span class="bases-error-value is-empty" title="${escapeHtmlAttribute(value.message)}"></span>`;
			}
			return `<span class="bases-error-value" title="${escapeHtmlAttribute(value.message)}">⚠ ${escapeHtmlText(value.message)}</span>`;
		}
		if (value instanceof DateValue) return escapeHtmlText(formatDate(value, this.formats));
		if (value instanceof LinkValue) return this.link(value);
		if (value instanceof FileValue) return this.fileLink(value.file, value.file.basename);
		if (value instanceof HtmlValue) return value.html;
		if (value instanceof ImageValue) return this.image(value, page, "bases-image");
		if (value instanceof IconValue) {
			return (
				this.icon(value.name) ??
				`<span class="bases-icon" data-icon="${escapeHtmlAttribute(value.name)}">${escapeHtmlText(value.name)}</span>`
			);
		}
		if (value instanceof RegexValue) return `<code>${escapeHtmlText(String(value.regex))}</code>`;
		if (value instanceof DurationValue || value instanceof ObjectValue) {
			return escapeHtmlText(valueToString(value, this.formats));
		}
		return "";
	}

	/** A property of a row: `file.name` and `file.basename` link to the file, as in Obsidian. */
	async property(ref: PropertyRef, row: QueryRow): Promise<string> {
		const value = propertyValue(ref, this.env, row.scope);
		if (ref.kind === "file" && (ref.name === "name" || ref.name === "basename")) {
			// A note is listed by its name, without `.md`, as in Obsidian's views.
			const label = row.file.ext === "md" ? row.file.basename : valueToString(value, this.formats);
			return this.fileLink(row.file, label);
		}
		// Tags are written without `#` in the value, and shown as tags, as in Obsidian.
		if (ref.kind === "file" && ref.name === "tags" && Array.isArray(value)) {
			return this.value(
				value.map((tag) => (typeof tag === "string" ? `#${tag}` : tag)),
				row.file.page,
			);
		}
		return this.value(value, row.file.page);
	}
}

/** A label inside `[[target|label]]`: `]]` would end the link early. */
function escapeLabel(label: string): string {
	return label.replace(/\]\]/g, "] ]").replace(/\n/g, " ");
}

/**
 * The entry `table` (display names, view summaries) has for a property,
 * however it is written there: `note.status` and `status` are one property.
 */
function configEntry(table: Record<string, string>, ref: PropertyRef): string | undefined {
	const keys =
		ref.kind === "note"
			? [ref.id, `note.${ref.name}`, ref.name]
			: [ref.id, `${ref.kind}.${ref.name}`];
	const key = keys.find((candidate) => Object.hasOwn(table, candidate));
	return key === undefined ? undefined : table[key];
}

/** Column header: the configured display name, else the name without its `note.`/`formula.` prefix. */
function displayName(ref: PropertyRef, config: BaseConfig): string {
	return (
		configEntry(config.displayNames, ref) ?? (ref.kind === "file" ? `file ${ref.name}` : ref.name)
	);
}

interface ViewContext {
	view: ViewConfig;
	config: BaseConfig;
	renderer: Renderer;
	columns: PropertyRef[];
	/** A column a layout adds after the view's own (the map's locations). */
	extraColumn?: { id: string; header: string; cells: Map<QueryRow, string> };
	/** Attributes a layout adds to a row's `<tr>` (a map marker's position and link). */
	rowAttributes?: Map<QueryRow, string>;
}

async function renderView(
	view: ViewConfig,
	config: BaseConfig,
	request: BaseRenderRequest,
	renderer: Renderer,
): Promise<string> {
	const result = runView(config, view, renderer.env);
	for (const error of result.errors) renderer.errors.set(error.message, error.severity);
	const context: ViewContext = {
		view,
		config,
		renderer,
		columns: view.order.map(parsePropertyId),
	};
	let body: string;
	let count = result.rows.length;
	switch (view.type) {
		case "table":
			body = await renderTable(context, result.rows, result.groups);
			break;
		case "cards":
			body = await renderCards(context, result.rows, result.groups);
			break;
		case "list":
			body = await renderList(context, result.rows, result.groups);
			break;
		case "kanban":
			body = await renderKanban(context, result.rows, result.groups);
			break;
		case "map": {
			const located = await renderMap(context, result.rows, result.groups, request);
			body = located.html;
			count = located.count;
			break;
		}
		default:
			renderer.ctx.report(
				`${request.label}: view "${view.name}" has the layout "${view.type}", which only an Obsidian plugin provides; it renders as a table`,
				"warn",
			);
			body = await renderTable(context, result.rows, result.groups);
	}
	const id = request.standalone ? ` id="${escapeHtmlAttribute(view.name)}"` : "";
	return `<section class="bases-view" data-view-type="${escapeHtmlAttribute(view.type)}" data-view-name="${escapeHtmlAttribute(view.name)}"${id}><div class="bases-toolbar"><span class="bases-toolbar-view-name">${escapeHtmlText(view.name)}</span><span class="bases-toolbar-results">${plural(count, "result")}</span></div>${body}</section>`;
}

async function groupLabel(group: QueryGroup, renderer: Renderer): Promise<string> {
	if (group.value === null) return "None";
	return renderer.value(group.value, group.rows[0]?.file.page);
}

function groupProperty(view: ViewConfig, config: BaseConfig): string {
	return view.groupBy
		? escapeHtmlText(displayName(parsePropertyId(view.groupBy.property), config))
		: "";
}

async function summaryCells(context: ViewContext, rows: QueryRow[]): Promise<string | undefined> {
	const { view, config, renderer, columns } = context;
	if (!columns.some((column) => configEntry(view.summaries, column))) return undefined;
	const cells = await Promise.all(
		columns.map(async (column) => {
			const name = configEntry(view.summaries, column);
			if (!name)
				return `<td class="bases-summary-cell" data-property="${escapeHtmlAttribute(column.id)}"></td>`;
			const values = rows.map((row) => propertyValue(column, renderer.env, row.scope));
			const summary = summarize(name, values, config, renderer.env);
			return `<td class="bases-summary-cell" data-property="${escapeHtmlAttribute(column.id)}"><span class="bases-summary-label">${escapeHtmlText(name)}</span> <span class="bases-summary-value">${await renderer.value(summary, undefined)}</span></td>`;
		}),
	);
	if (context.extraColumn) cells.push('<td class="bases-summary-cell"></td>');
	return `<tr class="bases-summary-row">${cells.join("")}</tr>`;
}

async function tableRow(context: ViewContext, row: QueryRow): Promise<string> {
	const cells = await Promise.all(
		context.columns.map(
			async (column) =>
				`<td class="bases-td" data-property="${escapeHtmlAttribute(column.id)}">${await context.renderer.property(column, row)}</td>`,
		),
	);
	const { extraColumn } = context;
	if (extraColumn) {
		cells.push(
			`<td class="bases-td" data-property="${escapeHtmlAttribute(extraColumn.id)}">${extraColumn.cells.get(row) ?? ""}</td>`,
		);
	}
	return `<tr class="bases-tr"${context.rowAttributes?.get(row) ?? ""}>${cells.join("")}</tr>`;
}

async function renderTable(
	context: ViewContext,
	rows: QueryRow[],
	groups: QueryGroup[] | undefined,
): Promise<string> {
	const { view, config, columns, renderer } = context;
	const sizes = view.settings.columnSize;
	const widths =
		sizes && typeof sizes === "object" && !Array.isArray(sizes)
			? Object.fromEntries(Object.entries(sizes).filter(([, width]) => typeof width === "number"))
			: {};
	const colgroup = Object.keys(widths).length
		? `<colgroup>${columns
				.map((column) => {
					const width = Object.hasOwn(widths, column.id) ? widths[column.id] : undefined;
					return width === undefined ? "<col />" : `<col style="width: ${Number(width)}px" />`;
				})
				.join("")}</colgroup>`
		: "";
	const head =
		columns
			.map(
				(column) =>
					`<th class="bases-th" scope="col" data-property="${escapeHtmlAttribute(column.id)}">${escapeHtmlText(displayName(column, config))}</th>`,
			)
			.join("") +
		(context.extraColumn
			? `<th class="bases-th" scope="col" data-property="${escapeHtmlAttribute(context.extraColumn.id)}">${escapeHtmlText(context.extraColumn.header)}</th>`
			: "");
	let bodies: string;
	let foot = "";
	if (groups) {
		const parts = await Promise.all(
			groups.map(async (group) => {
				const heading = `<tr class="bases-group-heading"><th colspan="${columns.length + (context.extraColumn ? 1 : 0)}" scope="colgroup"><span class="bases-group-property">${groupProperty(view, config)}</span> <span class="bases-group-value">${await groupLabel(group, renderer)}</span> <span class="bases-group-count">${group.rows.length}</span></th></tr>`;
				// Grouped, each group's summaries head the group (Table view.md).
				const summary = (await summaryCells(context, group.rows)) ?? "";
				const body = (await Promise.all(group.rows.map((row) => tableRow(context, row)))).join("");
				return `<tbody class="bases-tbody bases-group">${heading}${summary}${body}</tbody>`;
			}),
		);
		bodies = parts.join("");
	} else {
		bodies = `<tbody class="bases-tbody">${(await Promise.all(rows.map((row) => tableRow(context, row)))).join("")}</tbody>`;
		const summary = await summaryCells(context, rows);
		if (summary) foot = `<tfoot class="bases-tfoot">${summary}</tfoot>`;
	}
	const rowHeight = typeof view.settings.rowHeight === "string" ? view.settings.rowHeight : "short";
	return `<div class="bases-table-container"><table class="bases-table" data-row-height="${escapeHtmlAttribute(rowHeight)}">${colgroup}<thead class="bases-thead"><tr class="bases-tr">${head}</tr></thead>${bodies}${foot}</table></div>`;
}

/** The cover image and properties of one card (cards and Kanban layouts). */
async function card(context: ViewContext, row: QueryRow, className: string): Promise<string> {
	const { view, config, renderer, columns } = context;
	let cover = "";
	if (typeof view.settings.image === "string" && view.settings.image !== "") {
		const value = propertyValue(parsePropertyId(view.settings.image), renderer.env, row.scope);
		const image = isEmptyValue(value)
			? ""
			: await renderer.image(value, row.file.page, "bases-cards-image");
		const fit = view.settings.imageFit === "contain" ? "contain" : "cover";
		const ratio = Number(view.settings.imageAspectRatio);
		const aspect = Number.isFinite(ratio) && ratio > 0 ? ` style="aspect-ratio: 1 / ${ratio}"` : "";
		cover = `<div class="bases-cards-cover" data-image-fit="${fit}"${aspect}>${image}</div>`;
	}
	const lines: string[] = [];
	for (const [index, column] of columns.entries()) {
		const html = await renderer.property(column, row);
		if (html === "") continue;
		const label =
			index === 0 || (column.kind === "file" && column.name === "name")
				? ""
				: `<div class="bases-cards-label">${escapeHtmlText(displayName(column, config))}</div>`;
		lines.push(
			`<div class="bases-cards-property${label ? "" : " bases-cards-title"}" data-property="${escapeHtmlAttribute(column.id)}">${label}<div class="bases-cards-line">${html}</div></div>`,
		);
	}
	return `<div class="${className}">${cover}<div class="bases-cards-content">${lines.join("")}</div></div>`;
}

/** Collapsible group sections for the cards and list layouts. */
async function grouped(
	context: ViewContext,
	groups: QueryGroup[],
	content: (rows: QueryRow[]) => Promise<string>,
): Promise<string> {
	const parts = await Promise.all(
		groups.map(
			async (group) =>
				`<details class="bases-group" open><summary class="bases-group-heading"><span class="bases-group-property">${groupProperty(context.view, context.config)}</span> <span class="bases-group-value">${await groupLabel(group, context.renderer)}</span> <span class="bases-group-count">${group.rows.length}</span></summary>${await content(group.rows)}</details>`,
		),
	);
	return parts.join("");
}

async function renderCards(
	context: ViewContext,
	rows: QueryRow[],
	groups: QueryGroup[] | undefined,
): Promise<string> {
	const size = Number(context.view.settings.cardSize);
	const style = Number.isFinite(size) && size > 0 ? ` style="--bases-cards-width: ${size}px"` : "";
	const grid = async (list: QueryRow[]) =>
		`<div class="bases-cards-container"${style}>${(await Promise.all(list.map((row) => card(context, row, "bases-cards-item")))).join("")}</div>`;
	return `<div class="bases-cards">${groups ? await grouped(context, groups, grid) : await grid(rows)}</div>`;
}

async function renderList(
	context: ViewContext,
	rows: QueryRow[],
	groups: QueryGroup[] | undefined,
): Promise<string> {
	const { view, config, renderer, columns } = context;
	const markers = view.settings.markers;
	const tag = markers === "number" || markers === "numbers" ? "ol" : "ul";
	const nested = view.settings.indentProperties === true || view.settings.nestedProperties === true;
	const separator = typeof view.settings.separator === "string" ? view.settings.separator : ", ";
	const item = async (row: QueryRow): Promise<string> => {
		const [primary, ...rest] = await Promise.all(
			columns.map((column) => renderer.property(column, row)),
		);
		const others = rest
			.map((html, i) => ({ html, column: columns[i + 1] }))
			.filter(({ html }) => html !== "");
		let properties = "";
		if (nested && others.length > 0) {
			properties = `<ul class="bases-list-properties">${others
				.map(
					({ html, column }) =>
						`<li class="bases-list-property" data-property="${escapeHtmlAttribute(column?.id ?? "")}"><span class="bases-list-label">${escapeHtmlText(column ? displayName(column, config) : "")}</span> ${html}</li>`,
				)
				.join("")}</ul>`;
		} else if (others.length > 0) {
			properties = others
				.map(
					({ html, column }) =>
						`<span class="bases-list-separator">${escapeHtmlText(separator)}</span><span class="bases-list-property" data-property="${escapeHtmlAttribute(column?.id ?? "")}">${html}</span>`,
				)
				.join("");
		}
		return `<li class="bases-list-item"><span class="bases-list-primary">${primary ?? ""}</span>${properties}</li>`;
	};
	const list = async (items: QueryRow[]) =>
		`<${tag} class="bases-list" data-markers="${escapeHtmlAttribute(String(markers ?? "bullets"))}">${(await Promise.all(items.map(item))).join("")}</${tag}>`;
	return groups ? await grouped(context, groups, list) : await list(rows);
}

async function renderKanban(
	context: ViewContext,
	rows: QueryRow[],
	groups: QueryGroup[] | undefined,
): Promise<string> {
	const { view, renderer } = context;
	let columns = groups;
	if (!columns) {
		renderer.ctx.report(
			`Kanban view "${view.name}" has no groupBy; every card is in the None column`,
			"warn",
		);
		columns = [{ value: null, rows }];
	}
	if (view.settings.hideEmptyColumns === true)
		columns = columns.filter((column) => column.rows.length > 0);
	const width = Number(view.settings.columnWidth);
	const style =
		Number.isFinite(width) && width > 0 ? ` style="--bases-kanban-column-width: ${width}px"` : "";
	const lanes = await Promise.all(
		columns.map(async (column) => {
			const cards = await Promise.all(
				column.rows.map((row) => card(context, row, "bases-kanban-card")),
			);
			return `<section class="bases-kanban-column" data-group="${escapeHtmlAttribute(column.value === null ? "" : valueToString(column.value, renderer.formats))}"><div class="bases-kanban-column-header"><span class="bases-kanban-column-title">${await groupLabel(column, renderer)}</span><span class="bases-kanban-column-count">${column.rows.length}</span></div><div class="bases-kanban-cards">${cards.join("")}</div></section>`;
		}),
	);
	return `<div class="bases-kanban"${style}>${lanes.join("")}</div>`;
}

/** `"lat, lng"` or `[lat, lng]`, as the Maps plugin reads a coordinates property. */
function coordinatesOf(value: unknown): [number, number] | undefined {
	const parts =
		typeof value === "string" ? value.split(",") : Array.isArray(value) ? value : undefined;
	if (parts?.length !== 2) return undefined;
	const [lat, lng] = parts.map((part) =>
		typeof part === "string"
			? Number(part.trim() || Number.NaN)
			: typeof part === "number"
				? part
				: Number.NaN,
	);
	if (lat === undefined || lng === undefined || !Number.isFinite(lat) || !Number.isFinite(lng)) {
		return undefined;
	}
	return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? [lat, lng] : undefined;
}

/** Shown on a map view, and reported, when the site is built without the map library. */
export const MAP_INSTALL_HINT =
	"Interactive map views need the optional peer dependency `maplibre-gl`: install it next to rspress-plugin-obsidian (`npm install maplibre-gl`) and rebuild the site.";

/**
 * Whether `maplibre-gl` resolves from `fromDir`. The default is this package's
 * own directory, where the bundler starts resolving the specifier the shipped
 * map component imports, so the answer matches what the build will do.
 */
export function isMapLibraryInstalled(fromDir: string = moduleDir): boolean {
	try {
		createRequire(path.join(fromDir, "noop.js")).resolve("maplibre-gl");
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether this build draws interactive maps; resolved on first use.
 * Indirected so a test can reproduce a site built without the peer, which
 * is installed in this repository.
 */
export const mapLibrary: { installed?: boolean } = {};

/**
 * Rsbuild config for the map component: nothing when `maplibre-gl` is
 * installed, otherwise an alias that turns its import into an empty module,
 * so the site still builds and each map view keeps its table.
 */
export function mapLibraryBuilderConfig(): BuilderConfig {
	mapLibrary.installed ??= isMapLibraryInstalled();
	return mapLibrary.installed ? {} : { resolve: { alias: { "maplibre-gl": false } } };
}

/** A CSS colour as the Maps plugin takes one: hex, a name, a colour function or a custom property. */
const CSS_COLOR =
	/^(?:#[\da-f]{3,8}|[a-z]+|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\([\w\s.,%/+-]*\)|var\(--[\w-]+\))$/i;

const OSM_ATTRIBUTION = "© [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors";

/** A `mapTiles` setting (one URL or a list) as the URLs a browser may fetch. */
function tileUrls(value: unknown): string[] {
	return (Array.isArray(value) ? value : [value])
		.filter((url): url is string => typeof url === "string")
		.map((url) => url.trim())
		.filter((url) => /^(?:https?:)?\/\//i.test(url) || url.startsWith("/"));
}

interface MapBackground {
	tiles: string[];
	tilesDark: string[];
	/** Inline markdown. */
	attribution?: string;
}

/**
 * A view's background, as the Maps plugin picks it: the view's own
 * `mapTiles`, else the site's `bases.mapTiles`, else the plugin's first
 * configured background, else OpenFreeMap. Dark mode falls back to light.
 */
function mapBackground(
	view: ViewConfig,
	options: BasesOptions,
	vaultRoot: string | undefined,
): MapBackground {
	const tileSets =
		options.readVaultSettings === false
			? undefined
			: readObsidianPluginSettings(vaultRoot, "maps")?.tileSets;
	const vaultSet: unknown = Array.isArray(tileSets) ? tileSets[0] : undefined;
	const vault =
		vaultSet && typeof vaultSet === "object"
			? {
					tiles: tileUrls("lightTiles" in vaultSet ? vaultSet.lightTiles : undefined),
					tilesDark: tileUrls("darkTiles" in vaultSet ? vaultSet.darkTiles : undefined),
				}
			: undefined;
	const candidates: Array<MapBackground | undefined> = [
		{ tiles: tileUrls(view.settings.mapTiles), tilesDark: tileUrls(view.settings.mapTilesDark) },
		{
			tiles: tileUrls(options.mapTiles?.tiles),
			tilesDark: tileUrls(options.mapTiles?.tilesDark),
			attribution: options.mapTiles?.attribution,
		},
		vault,
	];
	const background = candidates.find((candidate) => candidate && candidate.tiles.length > 0) ?? {
		tiles: [DEFAULT_MAP_TILES],
		tilesDark: [DEFAULT_MAP_TILES_DARK],
	};
	const tilesDark = background.tilesDark.length > 0 ? background.tilesDark : background.tiles;
	const osm = [...background.tiles, ...tilesDark].some((url) =>
		/\btile\.openstreetmap\.org\//i.test(url),
	);
	return {
		tiles: background.tiles,
		tilesDark,
		attribution: background.attribution ?? (osm ? OSM_ATTRIBUTION : undefined),
	};
}

/** A numeric view setting, clamped as the Maps plugin clamps it; `fallback` when unset. */
function zoomSetting(value: unknown, fallback: number, min: number, max: number): number {
	return typeof value === "number" && Number.isFinite(value)
		? Math.min(max, Math.max(min, value))
		: fallback;
}

/**
 * `center`: a formula (`[48.85, 2.29]`, `this.coordinates`) evaluated with
 * `this`, else the older `"lat, lng"` text; `null` centres on the markers.
 */
function mapCenter(value: unknown, env: EvalEnv): [number, number] | null {
	if (Array.isArray(value)) return coordinatesOf(value) ?? null;
	if (typeof value !== "string" || value.trim() === "") return null;
	const expression = compileExpression(value);
	const evaluated =
		expression instanceof ErrorValue
			? undefined
			: coordinatesOf(evaluate(expression, env, new RowScope(env.thisFile)));
	return evaluated ?? coordinatesOf(value) ?? null;
}

/** A marker setting's value for a row as text (`icon()` gives its name), or `undefined`. */
function markerSetting(
	ref: PropertyRef | undefined,
	row: QueryRow,
	renderer: Renderer,
): string | undefined {
	if (!ref) return undefined;
	const value = propertyValue(ref, renderer.env, row.scope);
	if (isEmptyValue(value) || value instanceof ErrorValue) return undefined;
	const text = (
		value instanceof IconValue ? value.name : valueToString(value, renderer.formats)
	).trim();
	return text === "" || text === "null" ? undefined : text;
}

/**
 * A map view: the table of its located files, each row carrying its
 * marker (position, title, link, icon and colour), inside an element that
 * carries the view's map settings. The browser component draws the map from
 * that markup with MapLibre, the Maps plugin's own library, and hides the
 * table; without JavaScript, without `maplibre-gl`, and in the search index,
 * the table is what stays. Each location also links to OpenStreetMap.
 */
async function renderMap(
	context: ViewContext,
	rows: QueryRow[],
	groups: QueryGroup[] | undefined,
	request: BaseRenderRequest,
): Promise<{ html: string; count: number }> {
	const { view, renderer } = context;
	const { ctx } = renderer;
	mapLibrary.installed ??= isMapLibraryInstalled();
	if (!mapLibrary.installed) {
		ctx.report(
			`Map view "${view.name}" renders as a table of its located files. ${MAP_INSTALL_HINT}`,
			"warn",
		);
	}
	const setting = (key: string): PropertyRef | undefined => {
		const value = view.settings[key];
		return typeof value === "string" && value.trim() !== "" ? parsePropertyId(value) : undefined;
	};
	const coordinates = setting("coordinates");
	const markerIcon = setting("markerIcon");
	const markerColor = setting("markerColor");

	const cells = new Map<QueryRow, string>();
	const attributes = new Map<QueryRow, string>();
	for (const row of rows) {
		const at = coordinates
			? coordinatesOf(propertyValue(coordinates, renderer.env, row.scope))
			: undefined;
		if (!at) continue;
		const [lat, lng] = at;
		const iconName = markerSetting(markerIcon, row, renderer);
		const icon = iconName
			? renderer.icon(
					iconName,
					(problem) => `Map view "${view.name}": ${problem}; its markers show a dot`,
				)
			: undefined;
		let color = markerSetting(markerColor, row, renderer);
		if (color && !CSS_COLOR.test(color)) {
			renderer.errors.set(
				`Map view "${view.name}": marker colour "${color}" is not a CSS colour; the default colour is used`,
				"warning",
			);
			color = undefined;
		}
		const style = color ? ` style="--bases-map-marker-color: ${escapeHtmlAttribute(color)}"` : "";
		const href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=15/${lat}/${lng}`;
		cells.set(
			row,
			`<span class="${MAP_PIN_CLASS}"${style}>${icon ?? ""}</span><a href="${escapeHtmlAttribute(href)}" class="external-link" target="_blank" rel="noopener noreferrer">${lat}, ${lng}</a>`,
		);
		const route = await renderer.route(row.file);
		const title = row.file.page?.title || row.file.basename;
		attributes.set(
			row,
			` ${MAP_ROW_ATTRIBUTES.lat}="${lat}" ${MAP_ROW_ATTRIBUTES.lng}="${lng}" ${MAP_ROW_ATTRIBUTES.title}="${escapeHtmlAttribute(title)}"${route ? ` ${MAP_ROW_ATTRIBUTES.route}="${escapeHtmlAttribute(route)}"` : ""}`,
		);
	}
	const located = rows.filter((row) => cells.has(row));
	const locatedGroups = groups?.map((group) => ({
		...group,
		rows: group.rows.filter((row) => cells.has(row)),
	}));
	const table = await renderTable(
		{
			...context,
			extraColumn: { id: "coordinates", header: "Location", cells },
			rowAttributes: attributes,
		},
		located,
		locatedGroups,
	);

	const background = mapBackground(view, ctx.options.bases, ctx.options.vaultRoot);
	const attribution =
		typeof view.settings.mapAttribution === "string"
			? view.settings.mapAttribution
			: background.attribution;
	const markerProperties = [coordinates, markerIcon, markerColor].filter(
		(ref) => ref !== undefined,
	);
	const minZoom = zoomSetting(view.settings.minZoom, 0, 0, 24);
	const maxZoom = zoomSetting(view.settings.maxZoom, 18, 0, 24);
	const config: MapViewConfig = {
		center: mapCenter(view.settings.center, renderer.env),
		zoom:
			typeof view.settings.defaultZoom === "number"
				? zoomSetting(view.settings.defaultZoom, 0, minZoom, maxZoom)
				: null,
		minZoom,
		maxZoom,
		// Obsidian sizes an embedded map by `mapHeight`; the base's own page fills its pane.
		height: request.standalone ? null : zoomSetting(view.settings.mapHeight, 400, 100, 2000),
		tiles: background.tiles,
		tilesDark: background.tilesDark,
		attribution: attribution ? await renderer.inline(attribution, ctx.currentPage) : "",
		base: ctx.siteBase,
		popupSkip: [
			"coordinates",
			...context.columns
				.filter(
					(column) =>
						(column.kind === "file" && (column.name === "name" || column.name === "basename")) ||
						markerProperties.some((ref) => ref.kind === column.kind && ref.name === column.name),
				)
				.map((column) => column.id),
		],
	};
	const hint = mapLibrary.installed
		? ""
		: `<div class="bases-warning bases-map-install-hint">${escapeHtmlText(MAP_INSTALL_HINT).replace(/`([^`]+)`/g, "<code>$1</code>")}</div>`;
	return {
		html: `<div class="${MAP_VIEW_CLASS}" ${MAP_CONFIG_ATTRIBUTE}="${escapeHtmlAttribute(JSON.stringify(config))}">${hint}<div class="bases-map-fallback">${table}</div></div>`,
		count: located.length,
	};
}
