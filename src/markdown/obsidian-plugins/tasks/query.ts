/**
 * A ` ```tasks ` block: its instructions parsed (line continuations, comments,
 * presets and `{{query.file.*}}` placeholders included), run over the vault's
 * tasks, and explained, the way the Tasks plugin does each step.
 */
import { isStackOverflow, STACK_OVERFLOW_MESSAGE } from "../../interpreter-limits.js";
import type { Day } from "./dates.js";
import { DEFAULT_COMPARATORS, parseFilter, parseGrouper, parseSorter } from "./fields.js";
import {
	explainFilter,
	explainStatement,
	type Filter,
	type Grouper,
	makeStatement,
	type SearchInfo,
	type Sorter,
	type Statement,
} from "./query-model.js";
import type { Task } from "./task.js";

/** The most instructions a query's presets may expand to. */
const MAX_PRESET_INSTRUCTIONS = 10_000;

/** The task fields `hide`/`show` toggle, in the order Tasks prints them. */
export const TASK_COMPONENTS = [
	"id",
	"dependsOn",
	"priority",
	"recurrenceRule",
	"onCompletion",
	"createdDate",
	"startDate",
	"scheduledDate",
	"dueDate",
	"cancelledDate",
	"doneDate",
] as const;

export type TaskComponent = (typeof TASK_COMPONENTS)[number];

const COMPONENT_BY_OPTION: Record<string, TaskComponent> = {
	"cancelled date": "cancelledDate",
	"created date": "createdDate",
	"depends on": "dependsOn",
	"done date": "doneDate",
	"due date": "dueDate",
	id: "id",
	"on completion": "onCompletion",
	priority: "priority",
	"recurrence rule": "recurrenceRule",
	"scheduled date": "scheduledDate",
	"start date": "startDate",
};

export interface QueryLayout {
	hideBacklinks: boolean;
	hideEditButton: boolean;
	hideNestedBacklinks: boolean;
	hidePostponeButton: boolean;
	hideTaskCount: boolean;
	hideGroupCount: boolean;
	hideToolbar: boolean;
	hideTree: boolean;
	hideUrgency: boolean;
	hideTags: boolean;
	/** Hidden task fields. */
	hidden: Partial<Record<TaskComponent, true>>;
	shortMode: boolean;
	explain: boolean;
}

type LayoutFlag = Exclude<keyof QueryLayout, "hidden" | "shortMode" | "explain">;

const LAYOUT_BY_OPTION: Record<string, LayoutFlag> = {
	backlink: "hideBacklinks",
	"edit button": "hideEditButton",
	"nested backlink": "hideNestedBacklinks",
	"postpone button": "hidePostponeButton",
	"task count": "hideTaskCount",
	"group count": "hideGroupCount",
	toolbar: "hideToolbar",
	tree: "hideTree",
	urgency: "hideUrgency",
	tags: "hideTags",
};

export interface Query {
	filters: Filter[];
	sorters: Sorter[];
	groupers: Grouper[];
	layoutStatements: Statement[];
	limit?: number;
	groupLimit?: number;
	layout: QueryLayout;
	/** `view columns by …`: the grouper that makes the columns, in front of `groupers`. */
	columns?: Grouper;
	ignoreGlobalQuery: boolean;
	error?: string;
}

const COLUMN_EXAMPLES = `For example:
    view columns by priority
    view columns by root
    view columns by status.type reverse`;

/** `view list` / `view columns by <group field>`, or the error Tasks gives. */
function parseView(view: string, query: Query): string | undefined {
	const [modeWord = "", ...rest] = view.trim().split(/\s+/);
	const mode = modeWord.toLowerCase();
	const remainder = rest.join(" ");
	if (mode === "list" && remainder === "") {
		query.columns = undefined;
		return undefined;
	}
	if (mode !== "columns") {
		return `do not understand view mode "${view}"\n\nThe available view modes are:\n    list\n    columns\n\nFor example:\n    view list`;
	}
	if (remainder === "") return `columns view requires a grouping expression\n\n${COLUMN_EXAMPLES}`;
	const grouper = parseGrouper(`group ${remainder}`);
	if (grouper === undefined || typeof grouper === "string") {
		return `do not understand columns grouping "${remainder}"\n\nColumns view grouping uses the same fields as "group by".\n\n${COLUMN_EXAMPLES}`;
	}
	query.columns = grouper;
	return undefined;
}

/** The note a query is written in, for `{{query.file.*}}` placeholders. */
export interface QueryFile {
	/** Relative to the note's root, with the extension. */
	path: string;
	/** The note's frontmatter, for `query.file.property(…)` and query file defaults. */
	properties: Record<string, unknown>;
}

/** A frontmatter property looked up as Obsidian does, ignoring case; `undefined` when unset or null. */
function propertyOf(file: QueryFile, name: string): unknown {
	const key = Object.keys(file.properties).find(
		(candidate) => candidate.toLowerCase() === name.toLowerCase(),
	);
	const value = key === undefined ? undefined : file.properties[key];
	if (value === null || value === undefined) return undefined;
	return Array.isArray(value) ? value.filter((item) => item !== null) : value;
}

type QueryProperty =
	| { name: string; instruction: [whenTrue: string, whenFalse: string] }
	| { name: string; display: string }
	| { name: string; extra: true };

/** Tasks' "query file defaults": `TQ_*` properties of the query's note, turned into instructions. */
const QUERY_PROPERTIES: readonly QueryProperty[] = [
	{ name: "TQ_show_toolbar", display: "toolbar" },
	{ name: "TQ_explain", instruction: ["explain", ""] },
	{ name: "TQ_short_mode", instruction: ["short mode", "full mode"] },
	{ name: "TQ_show_tree", display: "tree" },
	{ name: "TQ_show_tags", display: "tags" },
	{ name: "TQ_show_id", display: "id" },
	{ name: "TQ_show_depends_on", display: "depends on" },
	{ name: "TQ_show_priority", display: "priority" },
	{ name: "TQ_show_recurrence_rule", display: "recurrence rule" },
	{ name: "TQ_show_on_completion", display: "on completion" },
	{ name: "TQ_show_created_date", display: "created date" },
	{ name: "TQ_show_start_date", display: "start date" },
	{ name: "TQ_show_scheduled_date", display: "scheduled date" },
	{ name: "TQ_show_due_date", display: "due date" },
	{ name: "TQ_show_cancelled_date", display: "cancelled date" },
	{ name: "TQ_show_done_date", display: "done date" },
	{ name: "TQ_show_urgency", display: "urgency" },
	{ name: "TQ_show_backlink", display: "backlink" },
	{ name: "TQ_show_edit_button", display: "edit button" },
	{ name: "TQ_show_postpone_button", display: "postpone button" },
	{ name: "TQ_show_task_count", display: "task count" },
	{ name: "TQ_extra_instructions", extra: true },
];

/** The instructions a note's `TQ_*` properties add before each of its queries. */
export function queryFileDefaults(file: QueryFile): string {
	return QUERY_PROPERTIES.map((property) => {
		const value = propertyOf(file, property.name);
		if (value === undefined) return "";
		if ("instruction" in property) return value ? property.instruction[0] : property.instruction[1];
		if ("display" in property) return `${value ? "show" : "hide"} ${property.display}`;
		return typeof value === "string" ? value : "";
	})
		.filter((instruction) => instruction !== "")
		.join("\n");
}

export interface QueryContext {
	file: QueryFile;
	today: Day;
	presets: Record<string, string>;
}

/**
 * Join `\`-continued lines into statements; `\\` at the end of a line is a
 * literal backslash. Blank statements are dropped.
 */
export function continueLines(source: string): Statement[] {
	const statements: Statement[] = [];
	let continuing = false;
	let raw = "";
	let joined = "";
	for (const line of `${source}\n`.split("\n")) {
		let adjusted = continuing ? line.replace(/^[ \t]*/, "") : line;
		if (adjusted.endsWith("\\\\")) adjusted = adjusted.slice(0, -1);
		else if (line.endsWith("\\")) adjusted = adjusted.replace(/[ \t]*\\$/, "");
		raw = continuing ? `${raw}\n${line}` : line;
		joined = continuing ? `${joined} ${adjusted}` : adjusted;
		continuing = !line.endsWith("\\\\") && line.endsWith("\\");
		if (!continuing && joined.trim() !== "") statements.push(makeStatement(raw, joined));
	}
	return statements;
}

function fileValues(file: QueryFile): Record<string, string> {
	const filename = file.path.slice(file.path.lastIndexOf("/") + 1);
	const folder = file.path.slice(0, file.path.length - filename.length);
	const slash = file.path.indexOf("/");
	return {
		path: file.path,
		pathWithoutExtension: file.path.replace(/\.md$/, ""),
		folder: folder === "" ? "/" : folder,
		root: slash === -1 ? "/" : file.path.slice(0, slash + 1),
		filename,
		filenameWithoutExtension: filename.replace(/\.md$/, ""),
	};
}

function placeholderError(text: string, message: string): Error {
	return new Error(`There was an error expanding one or more placeholders.

The error message was:
    ${message}

The problem is in:
    ${text}`);
}

/**
 * Expand the placeholders Tasks resolves without running JavaScript:
 * `{{query.file.path}}` and its siblings, `{{query.file.property('key')}}` and
 * `{{query.file.hasProperty('key')}}`, and drop Mustache comments
 * (`{{! … }}`), which Tasks removes the same way. Anything else is an error.
 */
function expandPlaceholders(text: string, file: QueryFile): string {
	if (!text.includes("{{") || !text.includes("}}") || text.startsWith("#")) return text;
	const values = fileValues(file);
	return text.replace(/\{\{(.*?)\}\}/g, (_, inner: string) => {
		if (inner.startsWith("!")) return "";
		const placeholder = inner.trim();
		const name = /^query\.file\.(\w+)$/.exec(placeholder)?.[1];
		// Own names only: `{{query.file.constructor}}` must not reach Object's prototype.
		const known = name !== undefined && Object.hasOwn(values, name) ? values[name] : undefined;
		if (known !== undefined) return known;
		const call = /^query\.file\.(property|hasProperty)\(\s*(['"])(.*?)\2\s*\)$/.exec(placeholder);
		if (!call) throw placeholderError(text, `Unknown property: ${placeholder}`);
		const value = propertyOf(file, call[3] ?? "");
		if (call[1] === "hasProperty") return String(value !== undefined);
		if (value === undefined) {
			throw placeholderError(
				text,
				`Invalid placeholder result 'null'.\n    Check for missing file property in this expression:\n        {{${inner}}}`,
			);
		}
		return typeof value === "object" ? JSON.stringify(value) : String(value);
	});
}

function errorFor(statement: Statement, message: string): string {
	if (statement.raw === statement.continued && statement.raw === statement.expanded) {
		return `${message}\nProblem line: "${statement.raw}"`;
	}
	return `${message}\nProblem statement:\n${explainStatement(statement, "    ")}\n`;
}

function newLayout(): QueryLayout {
	return {
		hideBacklinks: false,
		hideEditButton: false,
		hideNestedBacklinks: false,
		hidePostponeButton: false,
		hideTaskCount: false,
		hideGroupCount: true,
		hideToolbar: false,
		hideTree: true,
		hideUrgency: true,
		hideTags: false,
		hidden: {},
		shortMode: false,
		explain: false,
	};
}

function unknownPreset(name: string, presets: Record<string, string>): string {
	const names = Object.keys(presets).sort((a, b) => a.localeCompare(b));
	const width = Math.max(...names.map((key) => key.length));
	const listed = names
		.map((key) => {
			const value = presets[key] ?? "";
			let summary = value.split("\n")[0] ?? "";
			if (summary.length > 50) summary = summary.slice(0, 50);
			if (summary !== value) summary += "...";
			return `${key.padEnd(width)}: ${summary}`;
		})
		.join("\n  ");
	return `Cannot find preset "${name}" in the Tasks settings\nThe following presets are defined in the Tasks settings:\n  ${listed}`;
}

/** Parse a query's source. A problem sets `error`, and the query then shows only that. */
export function parseQuery(source: string, context: QueryContext): Query {
	const query: Query = {
		filters: [],
		sorters: [],
		groupers: [],
		layoutStatements: [],
		layout: newLayout(),
		ignoreGlobalQuery: false,
	};

	// Presets may name presets: ten levels of a few names each multiply into millions of lines.
	let presetInstructions = 0;
	const parseLine = (statement: Statement, depth: number): void => {
		const line = statement.expanded;
		const preset = /^preset +(.*)/i.exec(line);
		if (preset) {
			const name = (preset[1] ?? "").trim();
			// Own names only: `preset constructor` must not run Object's prototype as instructions.
			const instructions = Object.hasOwn(context.presets, name) ? context.presets[name] : undefined;
			if (instructions === undefined || depth > 10) {
				query.error = errorFor(statement, unknownPreset(name, context.presets));
				return;
			}
			for (const instruction of continueLines(instructions)) {
				presetInstructions += 1;
				if (presetInstructions > MAX_PRESET_INSTRUCTIONS) {
					query.error = errorFor(
						statement,
						`The presets expand to more than ${MAX_PRESET_INSTRUCTIONS} instructions. Obsidian would keep expanding them, but a site build must finish.`,
					);
					return;
				}
				const nested: Statement = {
					raw: statement.raw,
					continued: statement.continued,
					expanded: expandPlaceholders(instruction.continued, context.file),
				};
				parseLine(nested, depth + 1);
				if (query.error) return;
			}
			return;
		}
		if (/^short/i.test(line) || /^full/i.test(line)) {
			query.layout.shortMode = /^short/i.test(line);
			query.layoutStatements.push(statement);
			return;
		}
		if (/^explain/i.test(line)) {
			query.layout.explain = true;
			return;
		}
		if (/^ignore global query/i.test(line)) {
			query.ignoreGlobalQuery = true;
			return;
		}
		const limit = /^limit (groups )?(to )?(\d+)( tasks?)?/i.exec(line);
		if (limit) {
			const value = Number.parseInt(limit[3] ?? "0", 10);
			if (limit[1]) query.groupLimit = value;
			else query.limit = value;
			return;
		}
		const sorter = parseSorter(line);
		if (sorter !== undefined) {
			if (typeof sorter === "string") query.error = errorFor(statement, sorter);
			else query.sorters.push({ ...sorter, statement });
			return;
		}
		const grouper = parseGrouper(line);
		if (grouper !== undefined) {
			if (typeof grouper === "string") query.error = errorFor(statement, grouper);
			else query.groupers.push({ ...grouper, statement });
			return;
		}
		const view = /^view +(.*)/i.exec(line);
		if (view) {
			const error = parseView(view[1] ?? "", query);
			if (error) query.error = errorFor(statement, error);
			else query.layoutStatements.push(statement);
			return;
		}
		const showHide = /^(hide|show) +(.*)/i.exec(line);
		if (showHide) {
			const hide = (showHide[1] ?? "").toLowerCase() === "hide";
			const option = (showHide[2] ?? "").toLowerCase();
			const flag = Object.entries(LAYOUT_BY_OPTION).find(([key]) => option.startsWith(key));
			const component = Object.entries(COMPONENT_BY_OPTION).find(([key]) => option.startsWith(key));
			if (flag) {
				query.layout[flag[1]] = hide;
			} else if (component) {
				if (hide) query.layout.hidden[component[1]] = true;
				else delete query.layout.hidden[component[1]];
			} else {
				query.error = errorFor(makeStatement(line), "do not understand hide/show option");
				return;
			}
			query.layoutStatements.push(statement);
			return;
		}
		if (line.startsWith("#")) return;
		const filter = parseFilter(line, { today: context.today });
		if (!filter) {
			query.error = errorFor(statement, "do not understand query");
		} else if (filter.error !== undefined) {
			query.error = errorFor(statement, filter.error);
		} else {
			query.filters.push({ ...filter.filter, statement });
		}
	};

	for (const statement of continueLines(source)) {
		try {
			statement.expanded = expandPlaceholders(statement.continued, context.file);
			// A preset's own placeholders are expanded inside, and fail the same way.
			parseLine(statement, 0);
		} catch (error) {
			query.error = isStackOverflow(error)
				? errorFor(statement, STACK_OVERFLOW_MESSAGE)
				: error instanceof Error
					? error.message
					: String(error);
			return query;
		}
		if (query.error) return query;
	}
	return query;
}

export interface GroupHeading {
	level: number;
	name: string;
}

export interface TaskGroup {
	names: string[];
	/** The headings to print before this group: only the levels that changed. */
	headings: GroupHeading[];
	tasks: Task[];
	countBeforeLimit: number;
}

export interface QueryResult {
	groups: TaskGroup[];
	/** Tasks shown. */
	count: number;
	/** Tasks matched before `limit`. */
	countBeforeLimit: number;
}

function compareGroupNames(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true });
}

/** Split tasks by each grouper in turn; a task with several names (tags) joins each group. */
function groupTasks(tasks: Task[], groupers: Grouper[], info: SearchInfo): TaskGroup[] {
	let level: { names: string[]; tasks: Task[] }[] = [{ names: [], tasks }];
	for (const grouper of groupers) {
		const next: { names: string[]; tasks: Task[] }[] = [];
		for (const node of level) {
			const children = new Map<string, Task[]>();
			for (const task of node.tasks) {
				const names = grouper.names(task, info);
				for (const name of names.length > 0 ? names : [""]) {
					const members = children.get(name);
					if (members) members.push(task);
					else children.set(name, [task]);
				}
			}
			for (const [name, members] of children) {
				next.push({ names: [...node.names, name], tasks: members });
			}
		}
		level = next;
	}
	level.sort((a, b) => {
		for (const [index, grouper] of groupers.entries()) {
			const result = compareGroupNames(a.names[index] ?? "", b.names[index] ?? "");
			if (result !== 0) return grouper.reverse ? -result : result;
		}
		return 0;
	});
	const lastAtLevel: string[] = groupers.map(() => "");
	return level.map((group) => {
		const headings: GroupHeading[] = [];
		group.names.forEach((name, depth) => {
			if (name === lastAtLevel[depth]) return;
			headings.push({ level: depth, name });
			lastAtLevel.fill("", depth);
			lastAtLevel[depth] = name;
		});
		return { ...group, headings, countBeforeLimit: group.tasks.length };
	});
}

/** Run a parsed query: filter, sort (then Tasks' default order), limit, group. */
export function runQuery(query: Query, info: SearchInfo): QueryResult {
	let tasks = [...info.allTasks];
	for (const filter of query.filters) tasks = tasks.filter((task) => filter.matches(task, info));
	const comparators = [...query.sorters.map((sorter) => sorter.compare), ...DEFAULT_COMPARATORS];
	tasks.sort((a, b) => {
		for (const compare of comparators) {
			const result = compare(a, b, info);
			if (result !== 0) return result;
		}
		return 0;
	});
	const countBeforeLimit = tasks.length;
	const groupers = query.columns ? [query.columns, ...query.groupers] : query.groupers;
	const groups = groupTasks(tasks.slice(0, query.limit), groupers, info);
	let count = Math.min(countBeforeLimit, query.limit ?? countBeforeLimit);
	if (query.groupLimit !== undefined && groupers.length > 0) {
		for (const group of groups) group.tasks = group.tasks.slice(0, query.groupLimit);
		count = new Set(groups.flatMap((group) => group.tasks)).size;
	}
	return { groups, count, countBeforeLimit };
}

/** `N tasks`, or `N of M tasks` when a limit cut the list. */
export function taskCountText(count: number, countBeforeLimit: number): string {
	const noun = (total: number) => `task${total === 1 ? "" : "s"}`;
	return count === countBeforeLimit
		? `${count} ${noun(count)}`
		: `${count} of ${countBeforeLimit} ${noun(countBeforeLimit)}`;
}

function explainStatements(statements: Statement[], indent: string): string {
	if (statements.length === 0) return "";
	return `${statements.map((statement) => explainStatement(statement, indent)).join("\n\n")}\n`;
}

/** What `explain` prints for one query. */
export function explainQuery(query: Query, indent: string): string {
	if (query.error !== undefined) return `Query has an error:\n${query.error}\n`;
	const plural = (limit: number) => `At most ${limit} task${limit === 1 ? "" : "s"}`;
	const limits = [
		...(query.limit !== undefined ? [`${indent}${plural(query.limit)}.\n`] : []),
		...(query.groupLimit !== undefined
			? [
					`${indent}${plural(query.groupLimit)} per group (if any "group by" options are supplied).\n`,
				]
			: []),
	].join("\n");
	return [
		query.ignoreGlobalQuery ? `${indent}ignore global query\n` : "",
		query.filters.length === 0
			? `${indent}No filters supplied. All tasks will match the query.\n`
			: query.filters.map((filter) => explainFilter(filter, indent)).join("\n"),
		explainStatements(
			query.groupers.map((grouper) => grouper.statement),
			indent,
		),
		explainStatements(
			query.sorters.map((sorter) => sorter.statement),
			indent,
		),
		explainStatements(query.layoutStatements, indent),
		limits,
	]
		.filter((part) => part !== "")
		.join("\n");
}
