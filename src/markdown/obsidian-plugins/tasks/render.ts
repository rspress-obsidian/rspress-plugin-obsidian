/**
 * Query results as Tasks draws them in reading view — the same elements,
 * classes and `data-*` attributes, so a theme or CSS snippet written for
 * Obsidian styles the published page too. Checkboxes are disabled: a static
 * page cannot edit the note a task lives in.
 */

import type { Day } from "../../../shared/day.js";
import { escapeHtmlAttribute, escapeHtmlText, escapeRegExp } from "../../../shared/escape.js";
import { parseWikiLink } from "../../parse-wikilink.js";
import type { ContentPage, ParsedWikiLink, ResolvedWikiLink } from "../../types.js";
import {
	COMPONENTS,
	DATE_COMPONENTS,
	TASK_COMPONENTS,
	type TaskComponentSpec,
} from "./components.js";
import type { TaskDate } from "./dates.js";
import { type Query, type QueryResult, type TaskGroup, taskCountText } from "./query.js";
import type { SearchInfo } from "./query-model.js";
import { closestParentTask, fileBaseName, type ListEntry, type Task, urgencyOf } from "./task.js";
import { priorityTitle } from "./task-fields.js";

/** What rendering needs from the page being built. */
interface RenderTools {
	renderInline(markdown: string, page?: ContentPage): Promise<string>;
	resolve(parsed: ParsedWikiLink, page?: ContentPage): Promise<ResolvedWikiLink>;
	/** Whether no other published note shares a task's file name. */
	isFilenameUnique(task: Task): boolean;
	removeGlobalFilter: boolean;
	globalFilter: string;
	taskCountLocation: "top" | "bottom";
}

/** `today`, `past-3d`, `future-far`…: how far a date is from today, for CSS. */
function relativeDateAttribute(date: TaskDate, today: Day): string | undefined {
	if (Number.isNaN(date.day)) return undefined;
	const days = today - date.day;
	if (days === 0) return "today";
	const distance = Math.abs(days) <= 7 ? `${Math.abs(days)}d` : "far";
	return `${days > 0 ? "past" : "future"}-${distance}`;
}

/** The `data-*` attributes Tasks puts on a task's `<li>`: priority and each date's distance. */
export function taskDataAttributes(task: Task, today: Day): [string, string][] {
	const attributes: [string, string][] = [
		["data-task-priority", priorityTitle(task.priority).toLowerCase()],
	];
	for (const { field, attribute } of DATE_COMPONENTS) {
		// Tasks writes nothing for a scheduled date inferred from the file name.
		if (field === "scheduled" && task.scheduledInferred) continue;
		const date = task.dates[field];
		const value = date && relativeDateAttribute(date, today);
		if (value) attributes.push([attribute, value]);
	}
	return attributes;
}

function attributesHtml(attributes: [string, string][]): string {
	return attributes.map(([name, value]) => ` ${name}="${escapeHtmlAttribute(value)}"`).join("");
}

/**
 * Text with the global filter removed where it stands as a word, keeping one
 * space between the words around it.
 */
export function removeGlobalFilterWord(text: string, globalFilter: string): string {
	if (!globalFilter) return text;
	const word = new RegExp(`(^|\\s)${escapeRegExp(globalFilter)}(?=$|\\s)(\\s?)`, "g");
	return text.replace(word, (_, before: string, after: string) => (before && after ? before : ""));
}

function hiddenClasses(query: Query): string[] {
	const { layout } = query;
	const classes = TASK_COMPONENTS.filter((component) => layout.hidden[component]).map(
		(component) => `tasks-layout-hide-${component}`,
	);
	if (layout.hideTags) classes.push("tasks-layout-hide-tags");
	if (layout.hideUrgency) classes.push("tasks-layout-hide-urgency");
	if (layout.hideBacklinks) classes.push("tasks-layout-hide-backlinks");
	if (layout.hideEditButton) classes.push("tasks-layout-hide-edit-button");
	if (layout.hidePostponeButton) classes.push("tasks-layout-hide-postpone-button");
	if (layout.shortMode) classes.push("tasks-layout-short-mode");
	return classes;
}

class ResultRenderer {
	private added = new Set<ListEntry>();

	constructor(
		private readonly query: Query,
		private readonly info: SearchInfo,
		private readonly tools: RenderTools,
	) {}

	private listOpen(): string {
		const classes = [
			"contains-task-list",
			"plugin-tasks-query-result",
			...hiddenClasses(this.query),
		];
		const groupBy = this.query.groupers.map((grouper) => grouper.property).join(",");
		return `<ul class="${classes.join(" ")}"${groupBy ? ` data-task-group-by="${escapeHtmlAttribute(groupBy)}"` : ""}>`;
	}

	async group(group: TaskGroup): Promise<string> {
		let html = "";
		for (const [index, heading] of group.headings.entries()) {
			const tag = heading.level === 0 ? "h4" : heading.level === 1 ? "h5" : "h6";
			const text = await this.tools.renderInline(heading.name.replace(/%%.*?%%/g, ""));
			const count =
				!this.query.layout.hideGroupCount && index === group.headings.length - 1
					? ` <span class="tasks-group-count">(${taskCountText(group.tasks.length, group.countBeforeLimit)})</span>`
					: "";
			html += `<${tag} class="tasks-group-heading">${text}${count}</${tag}>`;
		}
		this.added.clear();
		return html + (await this.list(group.tasks, 0));
	}

	private async list(entries: readonly ListEntry[], depth: number): Promise<string> {
		let items = "";
		for (const [index, entry] of entries.entries()) {
			if (this.query.layout.hideTree) {
				if (entry.kind === "task") items += await this.task(entry, index, depth, "");
				continue;
			}
			if (this.added.has(entry)) continue;
			const parent = closestParentTask(entry);
			if (parent && !this.added.has(parent) && entries.includes(parent)) continue;
			this.added.add(entry);
			const children = entry.children.length > 0 ? await this.list(entry.children, depth + 1) : "";
			items +=
				entry.kind === "task"
					? await this.task(entry, index, depth, children)
					: await this.item(entry, index, children);
		}
		return `${this.listOpen()}${items}</ul>`;
	}

	private async item(
		entry: Extract<ListEntry, { kind: "item" }>,
		index: number,
		children: string,
	): Promise<string> {
		const text = await this.tools.renderInline(entry.description, entry.file.page);
		if (entry.statusCharacter === undefined) return `<li><span>${text}</span>${children}</li>`;
		const checked = entry.statusCharacter !== " ";
		return `<li class="task-list-item${checked ? " is-checked" : ""}" data-task="${escapeHtmlAttribute(entry.statusCharacter.trim())}" data-line="${index}"><input class="task-list-item-checkbox" type="checkbox" disabled${checked ? " checked" : ""}><span>${text}</span>${children}</li>`;
	}

	private async task(task: Task, index: number, depth: number, children: string): Promise<string> {
		const { layout } = this.query;
		const short = layout.shortMode;
		const checked = task.status.symbol !== " ";
		const attributes: [string, string][] = [
			...taskDataAttributes(task, this.info.today),
			["data-task", task.status.symbol.trim()],
			["data-line", String(index)],
			["data-task-status-name", task.status.name],
			["data-task-status-type", task.status.type],
		];

		const description = this.tools.removeGlobalFilter
			? removeGlobalFilterWord(task.description, this.tools.globalFilter).trim()
			: task.description;
		let text = `<span class="task-description"><span>${await this.tools.renderInline(description, task.file.page)}</span></span>`;
		for (const component of TASK_COMPONENTS) {
			const spec: TaskComponentSpec = COMPONENTS[component];
			if (layout.hidden[component]) continue;
			if (component === "scheduledDate" && task.scheduledInferred) continue;
			const rendered = spec.text(task, short);
			if (!rendered) continue;
			const date = spec.date && task.dates[spec.date.field];
			const relative = date && relativeDateAttribute(date, this.info.today);
			const spanAttributes: [string, string][] = [];
			if (spec.date && relative) spanAttributes.push([spec.date.attribute, relative]);
			if (component === "priority") {
				spanAttributes.push(["data-task-priority", priorityTitle(task.priority).toLowerCase()]);
			}
			if (short) spanAttributes.push(["title", rendered.full]);
			text += `<span class="${spec.className}"${attributesHtml(spanAttributes)}><span>${escapeHtmlText(rendered.text)}</span></span>`;
		}
		if (task.blockLink) {
			text += `<span class="task-block-link"><span>${escapeHtmlText(task.blockLink)}</span></span>`;
		}

		let extras = "";
		if (!layout.hideUrgency) {
			extras += `<span class="tasks-urgency">${new Intl.NumberFormat("en-US").format(urgencyOf(task, this.info.today))}</span>`;
		}
		if (!layout.hideBacklinks && !(layout.hideNestedBacklinks && depth > 0)) {
			extras += await this.backlink(task, short);
		}

		const card = this.query.columns && depth === 0 ? " tasks-columns-column-card" : "";
		return `<li class="task-list-item plugin-tasks-list-item${checked ? " is-checked" : ""}${card}"${attributesHtml(attributes)}><input class="task-list-item-checkbox" type="checkbox" disabled${checked ? " checked" : ""} data-line="${index}"><span class="tasks-list-text">${text}</span><span class="task-extras">${extras}</span>${children}</li>`;
	}

	private async backlink(task: Task, short: boolean): Promise<string> {
		const name = fileBaseName(task.file);
		let label = this.tools.isFilenameUnique(task) ? name : `/${task.file.path}`;
		if (task.heading && task.heading !== label) label += ` > ${task.heading}`;
		const target = `${task.file.path.replace(/\.md$/, "")}${task.heading ? `#${task.heading}` : ""}`;
		const resolved = await this.tools.resolve(
			parseWikiLink(target, `[[${target}]]`),
			task.file.page,
		);
		const text = short ? " 🔗" : label;
		const classes = short ? "internal-link internal-link-short-mode" : "internal-link";
		const link = resolved.href
			? `<a class="${classes}" href="${escapeHtmlAttribute(resolved.href)}">${escapeHtmlText(text)}</a>`
			: `<span class="${classes}">${escapeHtmlText(text)}</span>`;
		return `<span class="tasks-backlink">${short ? link : ` (${link})`}</span>`;
	}
}

export interface RenderInput {
	query: Query;
	result: QueryResult;
	info: SearchInfo;
	tools: RenderTools;
	/** `explain` output, when the query asked for it. */
	explanation?: string;
}

/** The whole result block: explanation, group headings, task lists and the task count. */
export async function renderQueryResult({
	query,
	result,
	info,
	tools,
	explanation,
}: RenderInput): Promise<string> {
	const renderer = new ResultRenderer(query, info, tools);
	let html = explanation
		? `<pre class="plugin-tasks-query-explanation">${escapeHtmlText(explanation)}</pre>`
		: "";
	const count = query.layout.hideTaskCount
		? ""
		: `<div class="task-count">${taskCountText(result.count, result.countBeforeLimit)}</div>`;
	if (tools.taskCountLocation === "top") html += count;
	if (query.columns) {
		// Each top-level group is a column; its subgroups stay inside it.
		let columns = "";
		let open = false;
		for (const group of result.groups) {
			if (group.tasks.length === 0) continue;
			if (group.headings.length === 0 || group.headings[0]?.level === 0) {
				columns += `${open ? "</div>" : ""}<div class="tasks-columns-column">`;
				open = true;
			}
			columns += await renderer.group(group);
		}
		html += `<div class="tasks-columns">${columns}${open ? "</div>" : ""}</div>`;
	} else {
		for (const group of result.groups) html += await renderer.group(group);
	}
	if (tools.taskCountLocation !== "top") html += count;
	return html;
}
