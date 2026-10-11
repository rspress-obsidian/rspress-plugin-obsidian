import { escapeHtmlAttribute, escapeHtmlText } from "../shared/escape.js";
import { type DataviewEnvironment, renderQueryIn, renderTaskList } from "./dataview.js";
import {
	DqlCursor,
	evaluate as evaluateDql,
	parseExpression,
	parseSource,
} from "./dataview-expression.js";
import type { Runtime } from "./dataview-js.js";
import { jsString } from "./dataview-js-methods.js";
import { renderValue } from "./dataview-render.js";
import { compareValues, DataviewLink, parseDatePlus, parseDuration } from "./dataview-values.js";
import type { ContentPage } from "./types.js";

/** The pages a `dv.pages()` source selects, parsed with the DQL source grammar. */
function selectPages(source: unknown, env: DataviewEnvironment): ContentPage[] {
	if (source === undefined || source === null || String(source).trim() === "")
		return env.index.pages;
	const cursor = new DqlCursor(String(source));
	cursor.skipSpace();
	const parsed = parseSource(cursor);
	cursor.skipSpace();
	if (!cursor.done) throw new Error(`Unsupported Dataview source: ${String(source)}`);
	return env.pagesFor(parsed);
}

function pagesFor(source: unknown, env: DataviewEnvironment): unknown[] {
	return selectPages(source, env).map((page) => env.pageValues(page));
}

function pageFor(target: unknown, env: DataviewEnvironment): unknown {
	const link =
		target instanceof DataviewLink
			? target
			: typeof target === "string"
				? DataviewLink.parseInner(target.replace(/^\[\[|\]\]$/g, ""))
				: undefined;
	if (!link) return undefined;
	const page = env.resolvePage(link);
	return page ? env.pageValues(page) : undefined;
}

const ELEMENT_TAGS: Record<string, true> = {
	div: true,
	span: true,
	p: true,
	b: true,
	i: true,
	strong: true,
	em: true,
	code: true,
	small: true,
	mark: true,
	blockquote: true,
	h1: true,
	h2: true,
	h3: true,
	h4: true,
	h5: true,
	h6: true,
};

export function callDv(name: string, args: unknown[], rt: Runtime): unknown {
	const { env, output } = rt;
	const rc = env.rc;
	switch (name) {
		case "pages":
			return pagesFor(args[0], env);
		case "pagePaths":
			return selectPages(args[0], env).map((page) => page.relativePath);
		case "page":
			return pageFor(args[0], env);
		case "current":
			return env.pageValues(env.currentPage);
		case "array":
			return Array.isArray(args[0]) ? args[0] : args[0] === undefined ? [] : [args[0]];
		case "isArray":
			return Array.isArray(args[0]);
		case "date":
			return args[0] instanceof Date
				? args[0]
				: typeof args[0] === "string"
					? parseDatePlus(args[0])
					: null;
		case "duration":
			return typeof args[0] === "string" ? (parseDuration(args[0])?.normalize() ?? null) : null;
		case "fileLink":
			return new DataviewLink(
				String(args[0] ?? ""),
				"file",
				undefined,
				args[2] === undefined ? undefined : String(args[2]),
				args[1] === true,
			);
		case "sectionLink":
			return new DataviewLink(
				String(args[0] ?? ""),
				"header",
				String(args[1] ?? ""),
				args[3] === undefined ? undefined : String(args[3]),
				args[2] === true,
			);
		case "blockLink":
			return new DataviewLink(
				String(args[0] ?? ""),
				"block",
				String(args[1] ?? ""),
				args[3] === undefined ? undefined : String(args[3]),
				args[2] === true,
			);
		case "compare":
			return compareValues(args[0], args[1]);
		case "equal":
			return compareValues(args[0], args[1]) === 0;
		case "evaluate":
		case "tryEvaluate": {
			const context = args[1];
			const data =
				context && typeof context === "object" && !Array.isArray(context)
					? Object.fromEntries(Object.entries(context))
					: {};
			const value = evaluateDql(parseExpression(String(args[0] ?? "")), env.ctx, data);
			return name === "evaluate" ? { successful: true, value } : value;
		}
		case "execute":
			output.push(renderQueryIn(String(args[0] ?? ""), env));
			return undefined;
		case "paragraph":
			output.push(`<p class="dataviewjs-paragraph">${renderValue(args[0], rc, true)}</p>`);
			return undefined;
		case "span":
			output.push(`<span class="dataviewjs-span">${renderValue(args[0], rc, true)}</span>`);
			return undefined;
		case "header": {
			const requested = Number(args[0]);
			const level = Number.isFinite(requested)
				? Math.min(6, Math.max(1, Math.trunc(requested)))
				: 2;
			output.push(`<h${level}>${renderValue(args[1], rc, true)}</h${level}>`);
			return undefined;
		}
		case "el": {
			const tag = String(args[0] ?? "").toLowerCase();
			if (!Object.hasOwn(ELEMENT_TAGS, tag)) {
				throw new Error(`DataviewJS: dv.el() does not create <${tag}> elements.`);
			}
			const options = args[2] && typeof args[2] === "object" ? args[2] : undefined;
			const cls =
				options && Object.hasOwn(options, "cls") ? Reflect.get(options, "cls") : undefined;
			const classes = Array.isArray(cls)
				? cls.map(String).join(" ")
				: cls === undefined
					? ""
					: String(cls);
			output.push(
				`<${tag}${classes ? ` class="${escapeHtmlAttribute(classes)}"` : ""}>${renderValue(args[1], rc, true)}</${tag}>`,
			);
			return undefined;
		}
		case "list": {
			const items = Array.isArray(args[0]) ? args[0] : args[0] === undefined ? [] : [args[0]];
			output.push(
				`<ul class="dataviewjs-list">${items.map((item) => `<li>${renderValue(item, rc)}</li>`).join("")}</ul>`,
			);
			return undefined;
		}
		case "taskList": {
			const tasks = Array.isArray(args[0]) ? args[0].flat(Number.POSITIVE_INFINITY) : [];
			if (args[1] === false) {
				output.push(`<div class="dataviewjs-task-list">${renderTaskList(tasks, env)}</div>`);
				return undefined;
			}
			// Grouped by file by default, as `dv.taskList(tasks, groupByFile = true)` is.
			const byFile = new Map<string, unknown[]>();
			for (const task of tasks) {
				const path =
					task && typeof task === "object" ? String(Reflect.get(task, "path") ?? "") : "";
				const bucket = byFile.get(path);
				if (bucket) bucket.push(task);
				else byFile.set(path, [task]);
			}
			const groups = [...byFile].map(
				([path, items]) =>
					`<h4>${rc.linkHtml(new DataviewLink(path))}</h4><div class="dataview result-group">${renderTaskList(items, env)}</div>`,
			);
			output.push(`<div class="dataviewjs-task-list">${groups.join("")}</div>`);
			return undefined;
		}
		case "table": {
			const headers = Array.isArray(args[0]) ? args[0] : [];
			const rows = Array.isArray(args[1]) ? args[1] : [];
			const head = headers.map((header) => `<th>${escapeHtmlText(jsString(header))}</th>`).join("");
			const body = rows
				.map(
					(row) =>
						`<tr>${(Array.isArray(row) ? row : [row]).map((cell) => `<td>${renderValue(cell, rc)}</td>`).join("")}</tr>`,
				)
				.join("");
			output.push(
				`<table class="dataviewjs-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`,
			);
			return undefined;
		}
		case "view":
			throw new Error(
				"Unsupported DataviewJS function: dv.view() loads script files, which a static build does not run.",
			);
	}
	throw new Error(`Unsupported DataviewJS function: dv.${name}.`);
}
