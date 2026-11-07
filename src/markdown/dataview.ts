/**
 * Static Dataview: DQL queries (`TABLE`, `LIST`, `TASK`, `CALENDAR`) and inline
 * queries evaluated at build time against the content index, following
 * blacksmithgu/obsidian-dataview's query engine (`query/engine.ts`) and page
 * model (`data-model/markdown.ts`).
 */

import { escapeHtmlAttribute, escapeHtmlText, sanitizeUrl } from "../shared/escape.js";
import { extensionOf, IMAGE_EXTS } from "../shared/media-exts.js";
import { routeHref } from "../shared/route-path.js";
import { type DailyNoteConfig, parseDailyNoteDate } from "./daily-notes.js";
import { renderCalendar } from "./dataview-calendar.js";
import { evaluate, parseExpression, type Source } from "./dataview-expression.js";
import { extractDataviewMetadata, frontmatterOf, linksInText } from "./dataview-metadata.js";
import type { EvalContext } from "./dataview-operators.js";
import {
	parseQuery,
	type QueryHeader,
	type QueryOperation,
	type QueryPlan,
} from "./dataview-plan.js";
import { type RenderContext, renderMarkdownInline, renderValue } from "./dataview-render.js";
import {
	compareValues,
	DataviewLink,
	DataviewListPair,
	DEFAULT_DATE_FORMATS,
	daysInMonth,
	isTruthy,
	startOfDay,
	typeOf,
} from "./dataview-values.js";
import { parseWikiLink } from "./parse-wikilink.js";
import { resolveWikiLink } from "./resolve-wikilink.js";
import type {
	ContentIndex,
	ContentPage,
	DataviewListItem,
	ResolveContext,
	ResolvedWikiLink,
} from "./types.js";

export { extractDataviewMetadata };

interface QueryResult {
	html?: string;
	error?: string;
}

/** Inputs of a render that are not the page or the index. */
export interface DataviewSettings {
	/** The clock `date(today)`, `date(now)` and the calendar's "today" read. Default: now. */
	now?: Date;
	/** How links resolve, as for the page's wikilinks. Default: case-insensitive lookup on. */
	resolve?: ResolveContext["options"];
}

/**
 * A row flowing through the data commands: its identity (file link or group
 * key) and data. Exported for the calendar renderer, which groups the same
 * rows by date instead of printing them.
 */
export interface Row {
	id: unknown;
	data: Record<string, unknown>;
}

/** `file.*` of a page; the keys the engine itself reads are typed. */
interface FileValues {
	link: DataviewLink;
	tasks: Record<string, unknown>[];
	[key: string]: unknown;
}

/** A page as queries see it (Dataview's `SMarkdownPage`): `file` plus its fields. */
interface PageValues {
	file: FileValues;
	[key: string]: unknown;
}

/** What the `id` of the rows means after the commands ran: the file, or a (nested) group key. */
type IdMeaning = { type: "path" } | { type: "group"; name: string; on: IdMeaning };

// ---------------------------------------------------------------------------
// Environment: link resolution, page values, sources
// ---------------------------------------------------------------------------

interface IndexLookups {
	byRelativePath: Map<string, ContentPage>;
	byRoute: Map<string, ContentPage>;
	/** Link resolutions that do not depend on the page asking, per resolve-options key. */
	resolutions: Map<string, Map<string, ResolvedWikiLink>>;
	/** The `linkedIndexes` the shared resolutions were made with. */
	linkedIndexes?: ContentIndex[];
}

const indexLookups = new WeakMap<ContentIndex, IndexLookups>();

function lookupsFor(index: ContentIndex): IndexLookups {
	let lookups = indexLookups.get(index);
	if (!lookups) {
		lookups = {
			byRelativePath: new Map(index.pages.map((page) => [page.relativePath, page])),
			byRoute: new Map(index.pages.map((page) => [page.routePath, page])),
			resolutions: new Map(),
		};
		indexLookups.set(index, lookups);
	}
	return lookups;
}

/** What a query runs against: the index, the page it is written on, and how links resolve. */
export interface DataviewEnvironment {
	index: ContentIndex;
	currentPage: ContentPage;
	dailyConfig?: DailyNoteConfig;
	ctx: EvalContext;
	rc: RenderContext;
	pageValues(page: ContentPage): PageValues;
	resolvePage(link: DataviewLink): ContentPage | undefined;
	/** The pages a `FROM` source selects, in index order. */
	pagesFor(source: Source): ContentPage[];
}

function linkInner(link: DataviewLink): string {
	if (link.type === "header") return `${link.path}#${link.subpath ?? ""}`;
	if (link.type === "block") return `${link.path}#^${link.subpath ?? ""}`;
	return link.path;
}

export function createDataviewEnvironment(
	currentPage: ContentPage,
	index: ContentIndex,
	dailyConfig?: DailyNoteConfig,
	settings: DataviewSettings = {},
): DataviewEnvironment {
	const lookups = lookupsFor(index);
	const resolveOptions = settings.resolve ?? { enableCaseInsensitiveLookup: true };
	// A target that is neither relative (`./x`) nor on this page (`#h`)
	// resolves the same from every page of one folder — a name several files
	// share picks the one in the asking page's folder — so those results are
	// shared by every fence of the build, keyed by that folder; the rest are
	// cached for this query only. The plugin links the docs and vault trees
	// through views (`linkContentIndexes`) that are replaced whenever either
	// tree is re-indexed, and a new link drops the share.
	if (lookups.linkedIndexes !== index.linkedIndexes) {
		lookups.resolutions.clear();
		lookups.linkedIndexes = index.linkedIndexes;
	}
	const sharedKey = `${resolveOptions.enableCaseInsensitiveLookup === true}|${resolveOptions.enableFuzzyMatching === true}`;
	let shared = lookups.resolutions.get(sharedKey);
	if (!shared) {
		shared = new Map();
		lookups.resolutions.set(sharedKey, shared);
	}
	const local = new Map<string, ResolvedWikiLink>();
	const folder = currentPage.relativePath.slice(
		0,
		Math.max(0, currentPage.relativePath.lastIndexOf("/")),
	);

	const resolve = (link: DataviewLink): ResolvedWikiLink => {
		const exact = link.type === "file" ? lookups.byRelativePath.get(link.path) : undefined;
		if (exact) {
			return {
				status: "ok",
				href: routeHref(exact.routePath, exact.relativePath),
				targetPage: exact,
			};
		}
		const inner = linkInner(link);
		const isLocal = inner.startsWith(".") || inner.startsWith("#");
		const cache = isLocal ? local : shared;
		const key = isLocal ? inner : `${folder}\u0000${inner}`;
		const cached = cache.get(key);
		if (cached) return cached;
		const resolved = resolveWikiLink(parseWikiLink(inner, `[[${inner}]]`), {
			currentPage,
			index,
			options: resolveOptions,
		});
		cache.set(key, resolved);
		return resolved;
	};

	const resolvePage = (link: DataviewLink): ContentPage | undefined => {
		if (link.path === "" && link.type !== "file") return currentPage;
		return resolve(link).targetPage;
	};

	const env: DataviewEnvironment = {
		index,
		currentPage,
		dailyConfig,
		resolvePage,
		pageValues: (page) => createPageValues(page, index, dailyConfig),
		ctx: {
			globals: {},
			now: settings.now ?? new Date(),
			resolveLink: (link) => {
				const page = resolvePage(link);
				return page ? createPageValues(page, index, dailyConfig) : null;
			},
			normalizeLink: (link) => resolvePage(link)?.relativePath ?? link.path,
			normalizePath: (target) =>
				resolve(new DataviewLink(target)).targetPage?.relativePath ?? target,
		},
		rc: {
			formats: DEFAULT_DATE_FORMATS,
			linkHtml: (link) => {
				const resolved = resolve(link);
				const page = link.path === "" ? currentPage : resolved.targetPage;
				const label = escapeHtmlText(
					link.display ??
						(page
							? link.subpath && link.type !== "file"
								? `${page.baseName} > ${link.subpath}`
								: page.baseName
							: link.label()),
				);
				const href = resolved.status === "ok" && resolved.href ? sanitizeUrl(resolved.href) : null;
				if (!href) return `<span class="internal-link is-unresolved">${label}</span>`;
				const asset = resolved.targetAsset;
				if (link.embed && asset && IMAGE_EXTS.has(extensionOf(asset.relativePath))) {
					return `<img src="${escapeHtmlAttribute(href)}" alt="${escapeHtmlAttribute(link.display ?? asset.baseName)}" />`;
				}
				return `<a href="${escapeHtmlAttribute(href)}">${label}</a>`;
			},
		},
		pagesFor: (source) => {
			const selected = selectPages(source, env);
			return selected ? index.pages.filter((page) => selected.has(page)) : index.pages;
		},
	};
	env.ctx.globals.this = createPageValues(currentPage, index, dailyConfig);
	return env;
}

/** The pages a source selects, or `undefined` for "every page". */
function selectPages(source: Source, env: DataviewEnvironment): Set<ContentPage> | undefined {
	const all = () => new Set(env.index.pages);
	switch (source.type) {
		case "all":
			return undefined;
		case "tag": {
			const tag = source.tag.slice(1).toLowerCase();
			return new Set(
				env.index.pages.filter((page) =>
					page.tags.some((candidate) => {
						const lower = candidate.toLowerCase();
						return lower === tag || lower.startsWith(`${tag}/`);
					}),
				),
			);
		}
		case "folder": {
			const folder = source.folder
				.replace(/\\/g, "/")
				.replace(/^\/+|\/+$/g, "")
				.replace(/\.(md|mdx)$/i, "")
				.toLowerCase();
			if (!folder) return undefined;
			return new Set(
				env.index.pages.filter((page) => {
					const key = page.relativePath.replace(/\.(md|mdx)$/i, "").toLowerCase();
					return key === folder || key.startsWith(`${folder}/`);
				}),
			);
		}
		case "link": {
			const link = DataviewLink.parseInner(source.inner);
			const target = link.path === "" ? env.currentPage : env.resolvePage(link);
			if (!target) {
				throw new Error(
					`Unsupported Dataview source: [[${source.inner}]] does not resolve to a note.`,
				);
			}
			if (source.direction === "outgoing") {
				return new Set(
					target.wikilinkTargets
						.map((linked) => env.resolvePage(new DataviewLink(linked)))
						.filter((page): page is ContentPage => page !== undefined),
				);
			}
			return new Set(incomingPages(target, env.index));
		}
		case "negate": {
			const child = selectPages(source.child, env);
			const result = all();
			if (!child) return new Set();
			for (const page of child) result.delete(page);
			return result;
		}
		case "binary": {
			const left = selectPages(source.left, env) ?? all();
			const right = selectPages(source.right, env) ?? all();
			if (source.op === "|") return new Set([...left, ...right]);
			return new Set([...left].filter((page) => right.has(page)));
		}
	}
}

/** Pages whose links resolve to `target`, from the index's backlinks. */
function incomingPages(target: ContentPage, index: ContentIndex): ContentPage[] {
	const lookups = lookupsFor(index);
	const pages: ContentPage[] = [];
	for (const ref of index.backlinks.get(target.routePath) ?? []) {
		const page =
			(ref.relativePath ? lookups.byRelativePath.get(ref.relativePath) : undefined) ??
			lookups.byRoute.get(ref.routePath);
		if (page && !pages.includes(page)) pages.push(page);
	}
	return pages;
}

/** The list item behind a `file.tasks` / `file.lists` value or a TASK row. */
const listItemSources = new WeakMap<object, { item: DataviewListItem; page: ContentPage }>();

/**
 * Per-page value objects, keyed by page identity.
 *
 * A page's values depend only on `(page, index, dailyConfig)`, but a query
 * rebuilt them for every page on every fence — so a vault with a fence on
 * each of its N notes spent O(N²) building the same objects. One entry per
 * page, replaced whenever any of those inputs changes, makes that linear.
 *
 * The entries are read-only: every consumer copies before changing anything
 * (FLATTEN and GROUP BY build new row objects, TASK rows spread the page), so
 * sharing one object between queries cannot leak a value into the next fence.
 */
const pageValuesCache = new WeakMap<
	ContentPage,
	{ index: ContentIndex; dailyConfig?: DailyNoteConfig; values: PageValues }
>();

/** `#a/b/c` and its parents `#a/b`, `#a`, as Dataview's `file.tags`. */
function withParentTags(tags: string[]): string[] {
	const result: string[] = [];
	for (const tag of tags) {
		const parts = tag.split("/");
		for (let length = parts.length; length >= 1; length -= 1) {
			const candidate = `#${parts.slice(0, length).join("/")}`;
			if (!result.includes(candidate)) result.push(candidate);
		}
	}
	return result;
}

/** A date in a file name: `2026-01-05 Meeting` or `20260105`. */
function dateInText(text: string): Date | undefined {
	const match = /(\d{4})-(\d{2})-(\d{2})/.exec(text) ?? /(\d{4})(\d{2})(\d{2})/.exec(text);
	if (!match) return undefined;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month - 1)) return undefined;
	return new Date(year, month - 1, day);
}

/**
 * `file.day`, as Dataview finds it: a `date`/`day` field holding a date (or a
 * link to a dated note), then the daily-notes format, then any date in the
 * file name.
 */
function pageDay(page: ContentPage, dailyConfig?: DailyNoteConfig): Date | undefined {
	for (const [key, value] of Object.entries(page.dataviewFields)) {
		const lower = key.toLowerCase();
		if (lower !== "date" && lower !== "day") continue;
		const candidate = Array.isArray(value) ? value[0] : value;
		if (candidate instanceof Date) return candidate;
		if (candidate instanceof DataviewLink) {
			const date =
				dateInText(candidate.path) ??
				dateInText(candidate.subpath ?? "") ??
				dateInText(candidate.display ?? "");
			if (date) return date;
		}
	}
	return (
		(dailyConfig ? parseDailyNoteDate(page.relativePath, dailyConfig) : undefined) ??
		dateInText(page.baseName)
	);
}

/** Dataview's serialized list items (`SListItem`) for one page, children linked. */
function listItemValues(page: ContentPage): {
	lists: Record<string, unknown>[];
	tasks: Record<string, unknown>[];
} {
	const byLine = new Map<number, Record<string, unknown>>();
	const fileLink = new DataviewLink(page.relativePath);
	for (const item of page.dataviewLists) {
		const section = item.section
			? new DataviewLink(page.relativePath, "header", item.section)
			: fileLink;
		const data: Record<string, unknown> = {
			symbol: item.symbol,
			link: section,
			section,
			text: item.text,
			tags: item.tags,
			line: item.line,
			lineCount: item.lineCount,
			outlinks: linksInText(item.text),
			path: page.relativePath,
			children: [],
			task: item.status !== undefined,
			annotated: Object.keys(item.fields).length > 0,
		};
		if (item.parent !== undefined) data.parent = item.parent;
		for (const [key, value] of Object.entries(item.fields)) {
			if (!(key in data)) data[key] = value;
		}
		if (item.status !== undefined) {
			const fields = item.fields;
			const pick = (...keys: string[]) =>
				keys.map((key) => fields[key]).find((value) => value != null);
			data.status = item.status;
			data.checked = item.status !== " ";
			data.completed = item.status === "x" || item.status === "X";
			data.fullyCompleted = "fullyCompleted" in item ? item.fullyCompleted : data.completed;
			const created = pick("created", "ctime", "cday");
			const due = pick("due", "duetime", "dueday");
			const completion = pick("completion", "completed", "comptime", "compday");
			if (created != null) data.created = created;
			if (due != null) data.due = due;
			if (completion != null) data.completion = completion;
			if (fields.start != null) data.start = fields.start;
			if (fields.scheduled != null) data.scheduled = fields.scheduled;
		}
		byLine.set(item.line, data);
		listItemSources.set(data, { item, page });
	}
	for (const item of page.dataviewLists) {
		const data = byLine.get(item.line);
		if (!data) continue;
		data.children = item.children
			.map((line) => byLine.get(line))
			.filter((child): child is Record<string, unknown> => child !== undefined);
	}
	const lists = page.dataviewLists
		.map((item) => byLine.get(item.line))
		.filter((data): data is Record<string, unknown> => data !== undefined);
	return { lists, tasks: lists.filter((data) => data.task === true) };
}

/** Dataview's serialized page (`SMarkdownPage`): `file.*` plus every field. */
function createPageValues(
	page: ContentPage,
	index: ContentIndex,
	dailyConfig?: DailyNoteConfig,
): PageValues {
	const cached = pageValuesCache.get(page);
	if (cached && cached.index === index && cached.dailyConfig === dailyConfig) {
		return cached.values;
	}
	const ctime = new Date(page.fileCtimeMs);
	const mtime = new Date(page.fileMtimeMs);
	const { lists, tasks } = listItemValues(page);
	const folder = page.relativePath.includes("/")
		? page.relativePath.slice(0, page.relativePath.lastIndexOf("/"))
		: "";
	const file: FileValues = {
		path: page.relativePath,
		folder,
		name: page.baseName,
		link: new DataviewLink(page.relativePath),
		outlinks: page.wikilinkTargets.map((target) => new DataviewLink(target)),
		inlinks: incomingPages(page, index).map((source) => new DataviewLink(source.relativePath)),
		etags: page.tags.map((tag) => `#${tag}`),
		tags: withParentTags(page.tags),
		aliases: page.aliases,
		lists,
		tasks,
		ctime,
		cday: startOfDay(ctime),
		mtime,
		mday: startOfDay(mtime),
		size: page.fileSizeBytes,
		starred: false,
		frontmatter: frontmatterOf(page.dataviewFields),
		ext: page.relativePath.includes(".") ? (page.relativePath.split(".").pop() ?? "md") : "",
	};
	const day = pageDay(page, dailyConfig);
	if (day) file.day = day;
	const values: PageValues = { file };
	for (const [key, value] of Object.entries(page.dataviewFields)) {
		if (key !== "file") values[key] = value;
	}
	pageValuesCache.set(page, { index, dailyConfig, values });
	return values;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Run the data commands in the order written; each may repeat. */
function executeCore(
	rows: Row[],
	operations: QueryOperation[],
	ctx: EvalContext,
): { rows: Row[]; idMeaning: IdMeaning } {
	let idMeaning: IdMeaning = { type: "path" };
	for (const operation of operations) {
		switch (operation.type) {
			case "where":
				rows = rows.filter((row) => isTruthy(evaluate(operation.clause, ctx, row.data)));
				break;
			case "sort": {
				const keyed = rows.map((row) => ({
					row,
					keys: operation.fields.map((sort) => evaluate(sort.field, ctx, row.data)),
				}));
				keyed.sort((left, right) => {
					for (let position = 0; position < operation.fields.length; position += 1) {
						const comparison = compareValues(
							left.keys[position],
							right.keys[position],
							ctx.normalizeLink,
						);
						if (comparison !== 0)
							return operation.fields[position]?.descending ? -comparison : comparison;
					}
					return 0;
				});
				rows = keyed.map((entry) => entry.row);
				break;
			}
			case "limit": {
				const amount = evaluate(operation.amount, ctx);
				if (typeof amount !== "number") {
					throw new Error(`LIMIT needs a number, but got ${typeOf(amount)} (${String(amount)}).`);
				}
				rows = rows.slice(0, Math.max(0, amount));
				break;
			}
			case "group": {
				const keyed = rows
					.map((row) => ({ row, key: evaluate(operation.field.field, ctx, row.data) }))
					.sort((left, right) => compareValues(left.key, right.key, ctx.normalizeLink));
				const groups: Row[] = [];
				let previous: { key: unknown; rows: Record<string, unknown>[] } | undefined;
				for (const { row, key } of keyed) {
					if (previous && compareValues(previous.key, key, ctx.normalizeLink) === 0) {
						previous.rows.push(row.data);
						continue;
					}
					const members = [row.data];
					previous = { key, rows: members };
					groups.push({ id: key, data: { key, rows: members, [operation.field.name]: key } });
				}
				rows = groups;
				idMeaning = { type: "group", name: operation.field.name, on: idMeaning };
				break;
			}
			case "flatten": {
				const flattened: Row[] = [];
				for (const row of rows) {
					const value = evaluate(operation.field.field, ctx, row.data);
					for (const item of Array.isArray(value) ? value : [value]) {
						const data = { ...row.data, [operation.field.name]: item };
						const source = listItemSources.get(row.data);
						if (source) listItemSources.set(data, source);
						flattened.push({ id: row.id, data });
					}
				}
				rows = flattened;
				if (idMeaning.type === "group" && idMeaning.name === operation.field.name) {
					idMeaning = idMeaning.on;
				}
				break;
			}
		}
	}
	return { rows, idMeaning };
}

function pageRows(env: DataviewEnvironment, source: Source): Row[] {
	return env.pagesFor(source).map((page) => {
		const data = env.pageValues(page);
		return { id: data.file.link, data };
	});
}

function taskRows(env: DataviewEnvironment, source: Source): Row[] {
	const rows: Row[] = [];
	for (const page of env.pagesFor(source)) {
		const pageData = env.pageValues(page);
		const tasks = pageData.file.tasks;
		for (const task of tasks) {
			const data = { ...pageData, ...task };
			const origin = listItemSources.get(task);
			if (origin) listItemSources.set(data, origin);
			rows.push({ id: `${page.relativePath}#${String(task.line)}`, data });
		}
	}
	return rows;
}

function renderTable(
	header: Extract<QueryHeader, { type: "TABLE" }>,
	rows: Row[],
	idMeaning: IdMeaning,
	env: DataviewEnvironment,
): string {
	const names = header.fields.map((field) => field.name);
	if (header.showId) names.unshift(idMeaning.type === "group" ? idMeaning.name : "File");
	const head = names.map((name) => `<th>${escapeHtmlText(name)}</th>`).join("");
	const body = rows
		.map((row) => {
			const cells = header.fields.map((field) => evaluate(field.field, env.ctx, row.data));
			if (header.showId) cells.unshift(row.id);
			return `<tr>${cells.map((cell) => `<td>${renderValue(cell, env.rc)}</td>`).join("")}</tr>`;
		})
		.join("");
	return `<table class="dataview dataview-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

function renderList(
	header: Extract<QueryHeader, { type: "LIST" }>,
	rows: Row[],
	env: DataviewEnvironment,
): string {
	const items = rows.map((row) => {
		if (!header.format) return row.id;
		const value = evaluate(header.format, env.ctx, row.data);
		return header.showId ? new DataviewListPair(row.id, value) : value;
	});
	return `<ul class="dataview dataview-list">${items.map((item) => `<li>${renderValue(item, env.rc)}</li>`).join("")}</ul>`;
}

/** Items per line, for walking a task's children. */
const itemsByLine = new WeakMap<ContentPage, Map<number, DataviewListItem>>();

function pageItem(page: ContentPage, line: number): DataviewListItem | undefined {
	let byLine = itemsByLine.get(page);
	if (!byLine) {
		byLine = new Map(page.dataviewLists.map((item) => [item.line, item]));
		itemsByLine.set(page, byLine);
	}
	return byLine.get(line);
}

function renderListItem(
	item: DataviewListItem,
	page: ContentPage,
	env: DataviewEnvironment,
): string {
	const text = renderMarkdownInline(item.text, env.rc);
	const children = item.children
		.map((line) => pageItem(page, line))
		.filter((child): child is DataviewListItem => child !== undefined)
		.map((child) => renderListItem(child, page, env))
		.join("");
	const nested = children ? `<ul class="contains-task-list">${children}</ul>` : "";
	if (item.status === undefined)
		return `<li class="dataview task-list-basic-item">${text}${nested}</li>`;
	const checked = item.status !== " ";
	return `<li class="dataview task-list-item${checked ? " is-checked" : ""}" data-task="${escapeHtmlAttribute(item.status)}"><input class="dataview task-list-item-checkbox" type="checkbox" disabled${checked ? " checked" : ""} /> ${text}${nested}</li>`;
}

/**
 * Tasks and list items as a nested checklist. A child task shown under its
 * parent is not repeated at the top level, and a parent brings all of its
 * children with it, as Dataview's task view does.
 */
export function renderTaskList(values: unknown[], env: DataviewEnvironment): string {
	const sources = values
		.map((value) => (value && typeof value === "object" ? listItemSources.get(value) : undefined))
		.filter(
			(source): source is { item: DataviewListItem; page: ContentPage } => source !== undefined,
		);
	const id = (page: ContentPage, line: number) => `${page.relativePath}\n${line}`;
	const shown = new Set<string>();
	const collect = (item: DataviewListItem, page: ContentPage) => {
		shown.add(id(page, item.line));
		for (const line of item.children) {
			const child = pageItem(page, line);
			if (child) collect(child, page);
		}
	};
	for (const { item, page } of sources) collect(item, page);
	const seen = new Set<string>();
	const roots = sources.filter(({ item, page }) => {
		const key = id(page, item.line);
		if (seen.has(key)) return false;
		seen.add(key);
		return item.parent === undefined || !shown.has(id(page, item.parent));
	});
	return `<ul class="dataview dataview-task-list contains-task-list">${roots.map(({ item, page }) => renderListItem(item, page, env)).join("")}</ul>`;
}

function renderTaskGroups(
	values: unknown[],
	idMeaning: IdMeaning,
	env: DataviewEnvironment,
): string {
	if (idMeaning.type === "path") return renderTaskList(values, env);
	return values
		.map((value) => {
			if (!value || typeof value !== "object") return "";
			const rows: unknown = Reflect.get(value, "rows");
			const key: unknown = Reflect.get(value, idMeaning.name);
			return `<h4>${renderValue(key, env.rc)}</h4><div class="dataview result-group">${renderTaskGroups(Array.isArray(rows) ? rows : [], idMeaning.on, env)}</div>`;
		})
		.join("");
}

function renderQuery(plan: QueryPlan, env: DataviewEnvironment): string {
	const header = plan.header;
	const initial = header.type === "TASK" ? taskRows(env, plan.source) : pageRows(env, plan.source);
	const { rows, idMeaning } = executeCore(initial, plan.operations, env.ctx);
	switch (header.type) {
		case "TABLE":
			return renderTable(header, rows, idMeaning, env);
		case "LIST":
			return renderList(header, rows, env);
		case "TASK": {
			const values = rows.map((row) => row.data);
			return idMeaning.type === "path"
				? renderTaskList(values, env)
				: `<div class="dataview dataview-container">${renderTaskGroups(values, idMeaning, env)}</div>`;
		}
		case "CALENDAR":
			return renderCalendar(header.field, rows, env);
	}
}

/** Run a DQL query in an existing environment (DataviewJS `dv.execute`). Throws on error. */
export function renderQueryIn(query: string, env: DataviewEnvironment): string {
	return renderQuery(parseQuery(query), env);
}

export function renderDataviewQuery(
	query: string,
	currentPage: ContentPage,
	index: ContentIndex,
	dailyConfig?: DailyNoteConfig,
	settings?: DataviewSettings,
): QueryResult {
	try {
		const plan = parseQuery(query);
		const env = createDataviewEnvironment(currentPage, index, dailyConfig, settings);
		return { html: renderQuery(plan, env) };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * An inline query — the `expr` of `` `= expr` ``. As in Dataview, it is
 * evaluated with only `this` (the current page) in scope.
 */
export function renderDataviewInline(
	expression: string,
	currentPage: ContentPage,
	index: ContentIndex,
	dailyConfig?: DailyNoteConfig,
	settings?: DataviewSettings,
): QueryResult {
	try {
		const field = parseExpression(expression.trim());
		const env = createDataviewEnvironment(currentPage, index, dailyConfig, settings);
		const value = evaluate(field, env.ctx);
		return { html: `<span class="dataview-inline">${renderValue(value, env.rc, true)}</span>` };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}
