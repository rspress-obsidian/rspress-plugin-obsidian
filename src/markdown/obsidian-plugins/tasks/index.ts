import fs from "node:fs/promises";
import type { Element } from "hast";
import type { ListItem, Root, RootContent, Text } from "mdast";
import { visit } from "unist-util-visit";
import { escapeHtmlText } from "../../../shared/escape.js";
import { parseFrontmatter } from "../../../shared/frontmatter.js";
import type { ContentPage } from "../../types.js";
import type { ObsidianPluginFeature, PluginRenderContext } from "../types.js";
import {
	explainQuery,
	parseQuery,
	type QueryContext,
	queryFileDefaults,
	runQuery,
} from "./query.js";
import type { SearchInfo } from "./query-model.js";
import { removeGlobalFilterWord, renderQueryResult, taskDataAttributes } from "./render.js";
import { resolveTasksSettings, type TasksSettings } from "./settings.js";
import { fileBaseName, parseListLine, type Task } from "./task.js";
import { collectTasks, taskFilePath } from "./task-index.js";

type Properties = NonNullable<Element["properties"]>;

/**
 * The block's wrapper. `rp-toc-exclude` keeps its group headings out of
 * Rspress's outline, as they are out of Obsidian's: they are query output,
 * not the note's own headings, and carry no id to scroll to.
 */
const BLOCK_OPEN = '<div class="block-language-tasks rp-toc-exclude">';

function errorBlock(message: string): RootContent[] {
	return [
		{
			type: "html",
			value: `${BLOCK_OPEN}<div class="plugin-tasks-query-error"><pre>Tasks query: ${escapeHtmlText(message)}</pre></div></div>`,
		},
	];
}

/** Tasks' `explain` text: global filter, global query, query file defaults, then the block's own query. */
function explainResults(source: string, settings: TasksSettings, context: QueryContext): string {
	let text = settings.globalFilter
		? `Only tasks containing the global filter '${settings.globalFilter}'.\n\n`
		: "";
	const block = parseQuery(source, context);
	const defaults = queryFileDefaults(context.file);
	const defaultsQuery = parseQuery(defaults, context);
	if (
		!block.ignoreGlobalQuery &&
		!defaultsQuery.ignoreGlobalQuery &&
		settings.globalQuery.trim() !== ""
	) {
		text += `Explanation of the global query:\n\n${explainQuery(parseQuery(settings.globalQuery, context), "  ")}\n`;
	}
	if (defaults !== "") {
		text += `Explanation of the Query File Defaults (from properties/frontmatter in the query's file):\n\n${explainQuery(defaultsQuery, "  ")}\n`;
	}
	return `${text}Explanation of this Tasks code block query:\n\n${explainQuery(block, "  ")}`;
}

/** The frontmatter of the note holding a query; none when it cannot be read. */
async function noteProperties(page: ContentPage): Promise<Record<string, unknown>> {
	try {
		return parseFrontmatter(await fs.readFile(page.absolutePath, "utf8")).data;
	} catch {
		// The page's own frontmatter pass reports a malformed block; a query
		// just runs without properties.
		return {};
	}
}

async function renderTasksFence(source: string, ctx: PluginRenderContext): Promise<RootContent[]> {
	const settings = resolveTasksSettings(ctx.options);
	for (const problem of settings.problems) ctx.report(problem, "warn");
	const context: QueryContext = {
		file: {
			path: taskFilePath(ctx.currentPage, ctx.index),
			properties: await noteProperties(ctx.currentPage),
		},
		today: settings.today,
		presets: settings.presets,
	};
	// Instructions from the note's `TQ_*` properties come first, then the
	// block; the global query goes before both unless either opts out.
	const defaults = queryFileDefaults(context.file);
	const blockSource = defaults === "" ? source : `${defaults}\n${source}`;
	const block = parseQuery(blockSource, context);
	const query =
		block.ignoreGlobalQuery || settings.globalQuery.trim() === ""
			? block
			: parseQuery(`${settings.globalQuery}\n${blockSource}`, context);
	if (query.error !== undefined) {
		ctx.report(`Tasks query: ${query.error}`);
		return errorBlock(query.error);
	}

	const indexes = await ctx.publishedIndexes();
	const allTasks = await collectTasks(indexes, settings);
	const nameCounts = new Map<string, number>();
	for (const index of indexes) {
		for (const page of index.pages) {
			const name = fileBaseName({ page, path: taskFilePath(page, index) });
			nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
		}
	}
	const info: SearchInfo = {
		allTasks,
		today: settings.today,
		globalFilter: settings.globalFilter,
	};
	const html = await renderQueryResult({
		query,
		result: runQuery(query, info),
		info,
		explanation: query.layout.explain ? explainResults(source, settings, context) : undefined,
		tools: {
			renderInline: ctx.renderInline,
			resolve: ctx.resolve,
			isFilenameUnique: (task: Task) => (nameCounts.get(fileBaseName(task.file)) ?? 0) < 2,
			removeGlobalFilter: settings.removeGlobalFilter,
			globalFilter: settings.globalFilter,
			taskCountLocation: settings.taskCountLocation,
		},
	});
	return [{ type: "html", value: `${BLOCK_OPEN}${html}</div>` }];
}

/** `data-task-due` → `dataTaskDue`, the hast property name. */
function propertyName(attribute: string): string {
	return attribute.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

/**
 * A note's own tasks as Tasks marks them in reading view: the status name and
 * type, priority and date distances as `data-*` attributes, and the global
 * filter hidden when the settings say so. The checkbox and `data-task` stay
 * with the core task-status pass.
 */
function decorateNoteTasks(tree: Root, ctx: PluginRenderContext): void {
	const settings = resolveTasksSettings(ctx.options);
	const lines = ctx.source.split(/\r?\n/);
	const file = { page: ctx.currentPage, path: taskFilePath(ctx.currentPage, ctx.index) };
	visit(tree, "listItem", (node: ListItem) => {
		const line = node.position?.start.line;
		const text = line === undefined ? undefined : lines[line - 1];
		const paragraph = node.children[0];
		if (text === undefined || paragraph?.type !== "paragraph") return;
		// Callout bodies are re-parsed from their unquoted text, so a position
		// may point elsewhere; the line must hold the item's own words.
		const first = paragraph.children[0];
		if (first?.type === "text" && !text.includes(first.value.trim().slice(0, 40))) return;
		const entry = parseListLine(text, {
			file,
			line: line ?? 0,
			heading: undefined,
			statuses: settings.statuses,
			globalFilter: settings.globalFilter,
		});
		if (entry?.kind !== "task") return;

		const existing = node.data?.hProperties ?? {};
		const classes = Array.isArray(existing.className) ? existing.className.map(String) : [];
		const properties: Properties = {
			...existing,
			// Setting a class replaces the one GFM would add, so it is restated.
			className: [
				...classes,
				"task-list-item",
				"plugin-tasks-list-item",
				...(entry.status.symbol === " " ? [] : ["is-checked"]),
			],
			dataTaskStatusName: entry.status.name,
			dataTaskStatusType: entry.status.type,
		};
		for (const [name, value] of taskDataAttributes(entry, settings.today)) {
			properties[propertyName(name)] = value;
		}
		node.data = { ...node.data, hProperties: properties };

		if (settings.removeGlobalFilter && settings.globalFilter) {
			visit(paragraph, "text", (child: Text) => {
				child.value = removeGlobalFilterWord(child.value, settings.globalFilter);
			});
		}
	});
}

/** The Tasks plugin: ```tasks query blocks over every task in the vault, rendered at build time. */
export const tasksFeature: ObsidianPluginFeature = {
	id: "tasks",
	label: "Tasks",
	enableOption: "enableTasks",
	fences: ["tasks"],
	isEnabled: (options) => options.enableTasks,
	renderFence: (node, ctx) => renderTasksFence(node.value, ctx),
	transformTree: async (tree, ctx) => decorateNoteTasks(tree, ctx),
};
