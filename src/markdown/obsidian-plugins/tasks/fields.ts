/**
 * Every task property a query can filter, sort or group by, tried in Tasks'
 * own order (more specific instructions first, Boolean combinations last), so
 * a line means here what it means in Obsidian.
 */
import { compileSafeRegex } from "../../safe-regex.js";
import { BOOLEAN_LINE, parseBooleanFilter } from "./boolean.js";
import {
	compareTaskDates,
	type Day,
	type DayRange,
	formatDay,
	isoDay,
	parseDateRange,
	parseNaturalDate,
	type TaskDate,
} from "./dates.js";
import {
	type Comparator,
	escapeRegExp,
	type FilterOrError,
	type Grouper,
	makeExplanation,
	makeFilter,
	makeStatement,
	type SearchInfo,
	type Sorter,
} from "./query-model.js";
import {
	fileBaseName,
	happensDay,
	isBlocked,
	isBlocking,
	isDone,
	PRIORITY_NAMES,
	type Priority,
	statusTypeGroupText,
	type Task,
	urgencyOf,
} from "./task.js";

/** What parsing a query line may depend on. */
export interface ParseContext {
	today: Day;
}

type FilterParser = (line: string, context: ParseContext) => FilterOrError | undefined;
/** A sorter or grouper for the line, an error message, or `undefined` when the line is not this field's. */
type SorterParser = (line: string) => Sorter | string | undefined;
type GrouperParser = (line: string) => Grouper | string | undefined;
type GroupNames = (task: Task, info: SearchInfo) => string[];
type TaskText = (task: Task, info: SearchInfo) => string;

interface Field {
	filter?: FilterParser;
	sorter?: SorterParser;
	grouper?: GrouperParser;
}

const JS_UNSUPPORTED =
	"JavaScript in queries is not run when the site is built, so this instruction cannot be reproduced. Use the built-in filters, sorting and grouping instead.";

function compareText(a: string, b: string): number {
	return a.localeCompare(b, undefined, { numeric: true });
}

/** Markdown-escape a path, so `_` and `\` in a group heading print as written. */
function escapeMarkdown(text: string): string {
	return text.replace(/\\/g, "\\\\").replace(/_/g, "\\_");
}

function sortBy(name: string, compare: Comparator): SorterParser {
	const pattern = new RegExp(`^sort by ${escapeRegExp(name)}( reverse)?`, "i");
	return (line) => {
		const match = pattern.exec(line);
		if (!match) return undefined;
		return {
			statement: makeStatement(line),
			property: name,
			compare: match[1] ? (a, b, info) => -compare(a, b, info) : compare,
		};
	};
}

function groupBy(name: string, names: GroupNames, reversedByDefault = false): GrouperParser {
	const pattern = new RegExp(`^group by ${escapeRegExp(name)}( reverse)?$`, "i");
	return (line) => {
		const match = pattern.exec(line);
		if (!match) return undefined;
		return {
			statement: makeStatement(line),
			property: name,
			reverse: Boolean(match[1]) !== reversedByDefault,
			names,
		};
	};
}

type Instruction = [
	instruction: string,
	matches: (task: Task, info: SearchInfo) => boolean,
	explanation?: string,
];

/** Fixed instructions (`done`, `has due date`), matched whole and case-insensitively. */
function instructions(...entries: Instruction[]): FilterParser {
	return (line) => {
		const entry = entries.find(([text]) => text.toLowerCase() === line.toLowerCase());
		return entry ? makeFilter(line, entry[1], entry[2] ?? line) : undefined;
	};
}

function firstOf(...parsers: FilterParser[]): FilterParser {
	return (line, context) => {
		for (const parser of parsers) {
			const result = parser(line, context);
			if (result) return result;
		}
		return undefined;
	};
}

const REGEX_HELP = `See https://publish.obsidian.md/tasks/Queries/Regular+Expressions

Regular expressions must look like this:
    /pattern/
or this:
    /pattern/flags

Where:
- pattern: The 'regular expression' pattern to search for.
- flags:   Optional characters that modify the search.
           i => make the search case-insensitive
           u => add Unicode support`;

type Matcher = { test(text: string): boolean; explanation: string } | { error: string };

function makeMatcher(operator: string, value: string, line: string): Matcher {
	if (!operator.includes("regex")) {
		const needle = value.toLocaleLowerCase();
		return { test: (text) => text.toLocaleLowerCase().includes(needle), explanation: line };
	}
	const literal = /^\/(.+)\/([^/]*)$/.exec(value);
	if (!literal) return { error: `Invalid instruction: '${line}'\n\n${REGEX_HELP}` };
	const [, pattern = "", flags = ""] = literal;
	let regex: RegExp;
	try {
		regex = compileSafeRegex(pattern, flags);
	} catch (error) {
		return {
			error: `Error: Parsing regular expression.\nThe error message was:\n    "${String(error)}"\n\n${REGEX_HELP}`,
		};
	}
	const described = `'${regex.source}' with ${
		regex.flags.length === 0
			? "no flags"
			: regex.flags.length === 1
				? `flag '${regex.flags}'`
				: `flags '${regex.flags}'`
	}`;
	// Tasks lines the regex up under the one in the instruction.
	const intro = "using regex: ".padEnd(Math.max(0, line.indexOf("/") - 2));
	return { test: (text) => regex.test(text), explanation: `${intro}${described}` };
}

const TEXT_OPERATORS = "includes|does not include|regex matches|regex does not match";

/** `<field> includes|does not include|regex matches|regex does not match <value>`. */
function textFilter(
	pattern: string,
	values: (task: Task, info: SearchInfo) => string[],
	multi = false,
): FilterParser {
	const operators = multi ? `${TEXT_OPERATORS}|include|do not include` : TEXT_OPERATORS;
	const regex = new RegExp(`^(?:${pattern}) (${operators}) (.*)`, "i");
	return (line) => {
		const match = regex.exec(line);
		if (!match) return undefined;
		const operator = (match[1] ?? "").toLowerCase();
		const matcher = makeMatcher(operator, match[2] ?? "", line);
		if ("error" in matcher) return { error: matcher.error };
		const negate = operator.includes("not");
		return makeFilter(
			line,
			(task, info) => values(task, info).some((value) => matcher.test(value)) !== negate,
			matcher.explanation,
		);
	};
}

/** A text property: filterable, and optionally sortable and groupable by its value. */
function textField(
	name: string,
	value: TaskText,
	{ sort = false, group }: { sort?: boolean; group?: GroupNames | true } = {},
): Field {
	return {
		filter: textFilter(escapeRegExp(name), (task, info) => [value(task, info)]),
		sorter: sort
			? sortBy(name, (a, b, info) => compareText(value(a, info), value(b, info)))
			: undefined,
		grouper: group
			? groupBy(name, group === true ? (task, info) => [value(task, info)] : group)
			: undefined,
	};
}

const EXPLAIN_DATE = "YYYY-MM-DD (dddd Do MMMM YYYY)";

function explainDates(
	name: string,
	keyword: string | undefined,
	ifMissing: boolean,
	range: DayRange,
) {
	const missing = ifMissing ? ` OR no ${name} date` : "";
	const start = formatDay(range.start, EXPLAIN_DATE);
	const end = formatDay(range.end, EXPLAIN_DATE);
	switch (keyword) {
		case "before":
		case "on or after":
			return makeExplanation(`${name} date is ${keyword} ${start}${missing}`);
		case "after":
		case "on or before":
			return makeExplanation(`${name} date is ${keyword} ${end}${missing}`);
		case "in or before":
			return makeExplanation(`${name} date is on or before ${end}${missing}`);
		case "in or after":
			return makeExplanation(`${name} date is on or after ${start}${missing}`);
		default:
			if (range.start === range.end)
				return makeExplanation(`${name} date is on ${start}${missing}`);
			return makeExplanation(`${name} date is between:`, [
				makeExplanation(`${start} and`),
				makeExplanation(`${end} inclusive`),
				...(ifMissing ? [makeExplanation(`OR no ${name} date`)] : []),
			]);
	}
}

function dayMatcher(keyword: string | undefined, range: DayRange): (day: Day) => boolean {
	switch (keyword) {
		case "before":
			return (day) => day < range.start;
		case "after":
			return (day) => day > range.end;
		case "on or before":
		case "in or before":
			return (day) => day <= range.end;
		case "on or after":
		case "in or after":
			return (day) => day >= range.start;
		default:
			return (day) => day >= range.start && day <= range.end;
	}
}

interface DateFieldSpec {
	/** The name in `has <name> date`, sorting and grouping. */
	name: string;
	/** The word filters start with (`starts before …`). Default: `name`. */
	filterWord?: string;
	/** In explanations. Default: `name`. */
	explainName?: string;
	/** Whether a task without the date passes a date comparison (`starts` does). */
	ifMissing: boolean;
	/** The date sorted and grouped by. */
	date: (task: Task) => TaskDate | undefined;
	/** The dates a comparison may match; default: `[date]`. */
	dates?: (task: Task) => (TaskDate | undefined)[];
}

function dateField(spec: DateFieldSpec): Field {
	const { name, ifMissing, date } = spec;
	const dates = spec.dates ?? ((task: Task) => [date(task)]);
	const explainName = spec.explainName ?? name;
	const regex = new RegExp(
		`^${spec.filterWord ?? name} (((?:on|in) or before|before|(?:on|in) or after|after|on|in)? ?(.*))`,
		"i",
	);
	const fixed = spec.dates
		? instructions(
				[`has ${name} date`, (task) => dates(task).some(Boolean)],
				[`no ${name} date`, (task) => !dates(task).some(Boolean)],
			)
		: instructions(
				[`has ${name} date`, (task) => date(task) !== undefined],
				[`no ${name} date`, (task) => date(task) === undefined],
				[`${name} date is invalid`, (task) => Number.isNaN(date(task)?.day)],
			);
	const comparison: FilterParser = (line, { today }) => {
		const match = regex.exec(line);
		if (!match) return undefined;
		const keyword = match[2]?.toLowerCase();
		let range = parseDateRange(match[3] ?? "", today);
		if (!range) {
			const day = parseNaturalDate(match[1] ?? "", today);
			if (day !== undefined) range = { start: day, end: day };
		}
		if (!range) return { error: `do not understand ${name} date` };
		const test = dayMatcher(keyword, range);
		return makeFilter(
			line,
			(task) => dates(task).some((value) => (value ? test(value.day) : ifMissing)),
			explainDates(explainName, keyword, ifMissing, range),
		);
	};
	return {
		filter: firstOf(fixed, comparison),
		sorter: sortBy(name, (a, b) => compareTaskDates(date(a), date(b))),
		grouper: groupBy(name, (task) => {
			const value = date(task);
			if (!value) return [`No ${name} date`];
			if (Number.isNaN(value.day)) return [`%%0%% Invalid ${name} date`];
			return [formatDay(value.day, "YYYY-MM-DD dddd")];
		}),
	};
}

const PRIORITY_FILTER =
	/^priority(\s+is)?(\s+(above|below|not))?(\s+(lowest|low|none|medium|high|highest))$/i;

const PRIORITY_BY_NAME: Record<string, Priority> = {
	highest: 0,
	high: 1,
	medium: 2,
	none: 3,
	low: 4,
	lowest: 5,
};

/** `%%1%%High priority`: the priority's group heading, sortable by its hidden prefix. */
function priorityGroupName(task: Task): string {
	return `%%${task.priority}%%${PRIORITY_NAMES[task.priority]} priority`;
}

function folderOf(task: Task): string {
	const slash = task.file.path.lastIndexOf("/");
	return slash === -1 ? "/" : task.file.path.slice(0, slash + 1);
}

function rootOf(task: Task): string {
	const slash = task.file.path.indexOf("/");
	return slash === -1 ? "/" : task.file.path.slice(0, slash + 1);
}

function descriptionWithoutFilter(task: Task, info: SearchInfo): string {
	return task.description.replace(info.globalFilter, "").trim();
}

/** Tasks sorts descriptions as they read, ignoring a leading link's brackets and emphasis markers. */
function sortableDescription(task: Task, info: SearchInfo): string {
	let description = descriptionWithoutFilter(task, info);
	const link = /^\[\[?([^\]]*)]]?/.exec(description);
	if (link) {
		const inner = link[1] ?? "";
		description = inner.slice(inner.indexOf("|") + 1) + description.slice(link[0].length);
	}
	for (const marker of [
		/^\*\*([^*]+)\*\*/,
		/^\*([^*]+)\*/,
		/^==([^=]+)==/,
		/^__([^_]+)__/,
		/^_([^_]+)_/,
	]) {
		const match = marker.exec(description);
		if (match) description = (match[1] ?? "") + description.slice(match[0].length);
	}
	return description;
}

/** Sort by a task's Nth tag (`sort by tag 2`); tasks with fewer tags go last. */
function compareTags(instance: number): Comparator {
	return (a, b) => {
		if (a.tags.length === 0 && b.tags.length === 0) return 0;
		if (a.tags.length === 0) return 1;
		if (b.tags.length === 0) return -1;
		const aHas = a.tags.length >= instance;
		const bHas = b.tags.length >= instance;
		if (aHas !== bHas) return aHas ? -1 : 1;
		if (!aHas) return 0;
		return compareText(a.tags[instance - 1] ?? "", b.tags[instance - 1] ?? "");
	};
}

function happensDate(task: Task): TaskDate | undefined {
	const day = happensDay(task);
	return day === undefined ? undefined : { text: "", day };
}

function backlinkGroup(task: Task): string[] {
	const name = fileBaseName(task.file);
	return task.heading ? [`[[${name}#${task.heading}|${name} > ${task.heading}]]`] : [`[[${name}]]`];
}

function statusName(task: Task): string {
	return isDone(task) ? "Done" : "Todo";
}

const compareStatusType: Comparator = (a, b) =>
	compareText(statusTypeGroupText(a), statusTypeGroupText(b));
const compareUrgency: Comparator = (a, b, info) =>
	urgencyOf(b, info.today) - urgencyOf(a, info.today);
const comparePriority: Comparator = (a, b) => a.priority - b.priority;

const FIELDS: readonly Field[] = [
	textField("status.name", (task) => task.status.name, { sort: true, group: true }),
	{
		filter: (line) => {
			if (!/^status\.type/i.test(line)) return undefined;
			const match = /^status\.type (is|is not) ([^ ]+)$/i.exec(line);
			const type = match?.[2]?.toUpperCase();
			const known = ["TODO", "DONE", "IN_PROGRESS", "ON_HOLD", "CANCELLED", "NON_TASK", "EMPTY"];
			if (!match || !type || !known.includes(type)) {
				return {
					error: `Invalid status.type instruction: '${line}'.
    Allowed options: 'is' and 'is not' (without quotes).
    Allowed values:  TODO DONE IN_PROGRESS ON_HOLD CANCELLED NON_TASK
                     Note: values are case-insensitive,
                           so 'in_progress' works too, for example.
    Example:         status.type is not NON_TASK`,
				};
			}
			const negate = (match[1] ?? "").toLowerCase() === "is not";
			return makeFilter(line, (task) => (task.status.type === type) !== negate);
		},
		sorter: sortBy("status.type", compareStatusType),
		grouper: groupBy("status.type", (task) => [statusTypeGroupText(task)]),
	},
	{
		filter: instructions(
			["done", isDone, "status type is DONE or CANCELLED or NON_TASK"],
			["not done", (task) => !isDone(task), "status type is TODO or IN_PROGRESS or ON_HOLD"],
		),
		// Todo before Done, by the old two-state names.
		sorter: sortBy("status", (a, b) => -compareText(statusName(a), statusName(b))),
		grouper: groupBy("status", (task) => [statusName(task)]),
	},
	{
		filter: instructions(
			["is recurring", (task) => task.recurrence !== ""],
			["is not recurring", (task) => task.recurrence === ""],
		),
		sorter: sortBy(
			"recurring",
			(a, b) => Number(a.recurrence === "") - Number(b.recurrence === ""),
		),
		grouper: groupBy("recurring", (task) => [task.recurrence ? "Recurring" : "Not Recurring"]),
	},
	{
		filter: (line) => {
			const match = PRIORITY_FILTER.exec(line);
			if (!match) return undefined;
			const level = (match[5] ?? "").toLowerCase();
			const priority = PRIORITY_BY_NAME[level] ?? 3;
			switch (match[3]?.toLowerCase()) {
				case "above":
					return makeFilter(line, (task) => task.priority < priority);
				case "below":
					return makeFilter(line, (task) => task.priority > priority);
				case "not":
					return makeFilter(line, (task) => task.priority !== priority);
				default:
					return makeFilter(line, (task) => task.priority === priority, `priority is ${match[5]}`);
			}
		},
		sorter: sortBy("priority", comparePriority),
		grouper: groupBy("priority", (task) => [priorityGroupName(task)]),
	},
	dateField({
		name: "happens",
		explainName: "due, start or scheduled",
		ifMissing: false,
		date: happensDate,
		dates: (task) => [task.dates.start, task.dates.scheduled, task.dates.due],
	}),
	dateField({ name: "cancelled", ifMissing: false, date: (task) => task.dates.cancelled }),
	dateField({ name: "created", ifMissing: false, date: (task) => task.dates.created }),
	dateField({
		name: "start",
		filterWord: "starts",
		ifMissing: true,
		date: (task) => task.dates.start,
	}),
	dateField({ name: "scheduled", ifMissing: false, date: (task) => task.dates.scheduled }),
	dateField({ name: "due", ifMissing: false, date: (task) => task.dates.due }),
	dateField({ name: "done", ifMissing: false, date: (task) => task.dates.done }),
	textField("path", (task) => task.file.path, {
		sort: true,
		group: (task) => [escapeMarkdown(task.file.path.replace(".md", ""))],
	}),
	textField("folder", folderOf, { group: (task) => [escapeMarkdown(folderOf(task))] }),
	textField("root", rootOf, { group: (task) => [escapeMarkdown(rootOf(task))] }),
	{
		grouper: groupBy("backlink", backlinkGroup),
	},
	{
		filter: textFilter("description", (task, info) => [descriptionWithoutFilter(task, info)]),
		sorter: sortBy("description", (a, b, info) =>
			compareText(sortableDescription(a, info), sortableDescription(b, info)),
		),
	},
	{
		filter: firstOf(
			instructions(
				["has tag", (task) => task.tags.length > 0],
				["has tags", (task) => task.tags.length > 0],
				["no tag", (task) => task.tags.length === 0],
				["no tags", (task) => task.tags.length === 0],
			),
			textFilter("tag|tags", (task) => task.tags, true),
		),
		sorter: (line) => {
			const match = /^sort by tag( reverse)?[\s]*(\d+)?/i.exec(line);
			if (!match) return undefined;
			const compare = compareTags(match[2] ? Number(match[2]) : 1);
			return {
				statement: makeStatement(line),
				property: "tag",
				compare: match[1] ? (a, b, info) => -compare(a, b, info) : compare,
			};
		},
		grouper: groupBy("tags", (task) => (task.tags.length === 0 ? ["(No tags)"] : task.tags)),
	},
	textField("heading", (task) => task.heading ?? "", {
		sort: true,
		group: (task) => [task.heading || "(No heading)"],
	}),
	{
		filter: instructions([
			"exclude sub-items",
			(task) => {
				if (task.indentation === "") return true;
				const quote = task.indentation.lastIndexOf(">");
				return quote !== -1 && /^ ?$/.test(task.indentation.slice(quote + 1));
			},
		]),
	},
	textField("filename", (task) => `${fileBaseName(task.file)}.md`, {
		sort: true,
		group: (task) => [`[[${fileBaseName(task.file)}]]`],
	}),
	{
		sorter: sortBy("urgency", compareUrgency),
		// Most urgent first unless reversed.
		grouper: groupBy("urgency", (task, info) => [urgencyOf(task, info.today).toFixed(2)], true),
	},
	textField("recurrence", (task) => task.recurrence, {
		group: (task) => [task.recurrence || "None"],
	}),
	{
		filter: (line) => (/^filter by function/i.test(line) ? { error: JS_UNSUPPORTED } : undefined),
		sorter: (line) => (/^sort by function/i.test(line) ? JS_UNSUPPORTED : undefined),
		grouper: (line) => (/^group by function/i.test(line) ? JS_UNSUPPORTED : undefined),
	},
	{
		...textField("id", (task) => task.id, { sort: true, group: true }),
		filter: firstOf(
			instructions(["has id", (task) => task.id !== ""], ["no id", (task) => task.id === ""]),
			textFilter("id", (task) => [task.id]),
		),
	},
	{
		filter: instructions(
			["has depends on", (task) => task.dependsOn.length > 0],
			["no depends on", (task) => task.dependsOn.length === 0],
		),
	},
	{
		filter: instructions(
			["is blocking", (task, info) => isBlocking(task, info.allTasks)],
			["is not blocking", (task, info) => !isBlocking(task, info.allTasks)],
			["is blocked", (task, info) => isBlocked(task, info.allTasks)],
			["is not blocked", (task, info) => !isBlocked(task, info.allTasks)],
		),
	},
	{
		// Tasks' "random" order: a hash of the day and the description, so it
		// is stable through a day and reshuffles the next.
		sorter: sortBy("random", (a, b, info) => randomKey(a, info) - randomKey(b, info)),
	},
];

function randomKey(task: Task, info: SearchInfo): number {
	const text = `${isoDay(info.today)} ${task.description}`;
	let hash = 9;
	for (let index = 0; index < text.length; index += 1) {
		hash = Math.imul(hash ^ text.charCodeAt(index), 9 ** 9);
	}
	return hash ^ (hash >>> 9);
}

/** The filter a query line describes, its error, or `undefined` when no field claims the line. */
export function parseFilter(line: string, context: ParseContext): FilterOrError | undefined {
	for (const field of FIELDS) {
		const result = field.filter?.(line, context);
		if (result) return result;
	}
	if (!BOOLEAN_LINE.test(line)) return undefined;
	return parseBooleanFilter(line, (operand) => parseFilter(operand, context));
}

export function parseSorter(line: string): Sorter | string | undefined {
	if (!/^sort by /i.test(line)) return undefined;
	for (const field of FIELDS) {
		const result = field.sorter?.(line);
		if (result) return result;
	}
	return undefined;
}

export function parseGrouper(line: string): Grouper | string | undefined {
	if (!/^group by /i.test(line)) return undefined;
	for (const field of FIELDS) {
		const result = field.grouper?.(line);
		if (result) return result;
	}
	return undefined;
}

/** Tasks' default order, applied after a query's own `sort by` lines. */
export const DEFAULT_COMPARATORS: readonly Comparator[] = [
	compareStatusType,
	compareUrgency,
	(a, b) => compareTaskDates(a.dates.due, b.dates.due),
	comparePriority,
	(a, b) => compareText(a.file.path, b.file.path),
];
