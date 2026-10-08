/**
 * One task line, read the way Tasks reads it: the checkbox status, then the
 * signifiers at the end of the line — emoji (`📅 2024-05-01`, `⏫`, `🔁 every
 * week`, `🆔 abc`, `⛔ abc,def`) or Dataview fields (`[due:: 2024-05-01]`) —
 * peeled off right to left until only the description is left.
 */
import * as rruleModule from "rrule";
import type { ContentPage } from "../../types.js";
import { type Day, parseIsoDay, type TaskDate } from "./dates.js";
import { STATUS_TYPE_ORDER, statusFor, type TaskStatus } from "./settings.js";

// Node's ESM loader reads rrule's CommonJS `main`, so its exports arrive under
// `default` there; Bun (which reads `module`) and the CJS build see them directly.
const rrule: typeof rruleModule =
	"RRule" in rruleModule ? rruleModule : Reflect.get(rruleModule, "default");

/**
 * A 🔁 rule as Tasks reads it: rrule's own text for the rule, with ` when
 * done` kept. A rule rrule cannot parse (`every banana`) is no recurrence at
 * all, so the task is not recurring and shows no rule — as in Tasks.
 */
export function recurrenceText(rule: string): string {
	const match = /^([a-zA-Z0-9, !]+?)( when done)?$/i.exec(rule);
	if (!match) return "";
	try {
		const options = rrule.RRule.parseText((match[1] ?? "").trim());
		if (!options) return "";
		return `${new rrule.RRule(options).toText()}${match[2] ? " when done" : ""}`;
	} catch {
		// rrule throws on a rule it cannot finish reading.
		return "";
	}
}

/** The dates a task carries, by the name queries use for them. */
export type TaskDateField = "created" | "start" | "scheduled" | "due" | "cancelled" | "done";

/** Priorities as Tasks numbers them: 0 highest … 5 lowest; 3 is "none". */
export type Priority = 0 | 1 | 2 | 3 | 4 | 5;

export const PRIORITY_NONE: Priority = 3;

/** Priority names as group headings and `data-task-priority` show them (3 is "Normal"). */
export const PRIORITY_NAMES: readonly string[] = [
	"Highest",
	"High",
	"Medium",
	"Normal",
	"Low",
	"Lowest",
];

/** The emoji each priority is written with. */
export const PRIORITY_EMOJI: readonly string[] = ["🔺", "⏫", "🔼", "", "🔽", "⏬"];

/** The note a task lives in. */
export interface TaskFile {
	page: ContentPage;
	/** Path relative to the note's root, with its extension: `Projects/Plan.md`. */
	path: string;
}

interface ListEntryBase {
	file: TaskFile;
	/** 0-based line in the file. */
	line: number;
	/** Whitespace and `>` before the list marker. */
	indentation: string;
	parent: ListEntry | undefined;
	children: ListEntry[];
}

/** A list item that is not a task: shown under its parent task in `show tree`. */
export interface PlainListItem extends ListEntryBase {
	kind: "item";
	/** The checkbox character of an item the global filter excludes. */
	statusCharacter?: string;
	description: string;
}

export interface Task extends ListEntryBase {
	kind: "task";
	status: TaskStatus;
	description: string;
	priority: Priority;
	dates: Partial<Record<TaskDateField, TaskDate>>;
	/**
	 * The recurrence rule as Tasks restates it (`every week on Monday`, plus
	 * ` when done`); `""` when there is none or rrule cannot read it.
	 */
	recurrence: string;
	onCompletion: string;
	id: string;
	dependsOn: string[];
	/** Tags in the description, `#` included. */
	tags: string[];
	/** The trailing ` ^block-id`, `""` when absent. */
	blockLink: string;
	/** The nearest heading above the task, `undefined` before the first heading. */
	heading: string | undefined;
	/** The scheduled date came from the note's file name, not the task line. */
	scheduledInferred: boolean;
}

export type ListEntry = Task | PlainListItem;

const TASK_LINE = /^([\s\t>]*)([-*+]|[0-9]+[.)]) +\[(.)\] *(.*)/u;
const LIST_LINE = /^([\s\t>]*)([-*+]|[0-9]+[.)])(?:[ \t]+(.*))?$/u;
const BLOCK_LINK = / \^[a-zA-Z0-9-]+$/u;
const HASHTAGS = /(^|\s)#[^ !@#$%^&*(),.?":{}|<>]+/g;
const TRAILING_HASHTAG = /(^|\s)#[^ !@#$%^&*(),.?":{}|<>]+$/;

const TASK_ID = "[a-zA-Z0-9-_]+";
const TASK_ID_LIST = `${TASK_ID}( *, *${TASK_ID} *)*`;
const ISO_DATE = "(\\d{4}-\\d{2}-\\d{2})";

/** An emoji signifier at the end of the line. */
function emojiField(symbols: string, value = ""): RegExp {
	return new RegExp(`${symbols}\uFE0F?${value ? ` *${value}` : ""}$`);
}

/**
 * A Dataview inline field at the end of the line, in brackets or parentheses
 * (`[due:: 2024-05-01]`), with Tasks' tolerance for a trailing comma.
 */
function dataviewField(inner: string): RegExp {
	return new RegExp(`(?:(?=[^\\]]+\\])\\[|(?=[^)]+\\))\\() *${inner} *[)\\]](?: *,)?$`);
}

type Setter = (task: ParsedTaskBody, value: string) => void;

const dateSetter =
	(field: TaskDateField): Setter =>
	(task, value) => {
		task.dates[field] = { text: value, day: parseIsoDay(value) };
	};

const DATAVIEW_PRIORITY: Record<string, Priority> = {
	highest: 0,
	high: 1,
	medium: 2,
	low: 4,
	lowest: 5,
};

/** Every signifier Tasks reads, emoji then Dataview, in the order it peels them. */
const SIGNIFIERS: [RegExp, Setter][] = [
	[
		emojiField("(🔺|⏫|🔼|🔽|⏬)"),
		(task, value) => {
			task.priority = PRIORITY_EMOJI.indexOf(value) as Priority;
		},
	],
	[
		dataviewField("priority:: *(highest|high|medium|low|lowest)"),
		(task, value) => {
			task.priority = DATAVIEW_PRIORITY[value] ?? PRIORITY_NONE;
		},
	],
	[emojiField("✅", ISO_DATE), dateSetter("done")],
	[dataviewField(`completion:: *${ISO_DATE}`), dateSetter("done")],
	[emojiField("❌", ISO_DATE), dateSetter("cancelled")],
	[dataviewField(`cancelled:: *${ISO_DATE}`), dateSetter("cancelled")],
	[emojiField("(?:📅|📆|🗓)", ISO_DATE), dateSetter("due")],
	[dataviewField(`due:: *${ISO_DATE}`), dateSetter("due")],
	[emojiField("(?:⏳|⌛)", ISO_DATE), dateSetter("scheduled")],
	[dataviewField(`scheduled:: *${ISO_DATE}`), dateSetter("scheduled")],
	[emojiField("🛫", ISO_DATE), dateSetter("start")],
	[dataviewField(`start:: *${ISO_DATE}`), dateSetter("start")],
	[emojiField("➕", ISO_DATE), dateSetter("created")],
	[dataviewField(`created:: *${ISO_DATE}`), dateSetter("created")],
	[
		emojiField("🔁", "([a-zA-Z0-9, !]+)"),
		(task, value) => {
			task.recurrence = value.trim();
		},
	],
	[
		dataviewField("repeat:: *([a-zA-Z0-9, !]+)"),
		(task, value) => {
			task.recurrence = value.trim();
		},
	],
	[
		emojiField("🏁", "([a-zA-Z]+)"),
		(task, value) => {
			task.onCompletion = value.toLowerCase();
		},
	],
	[
		dataviewField("onCompletion:: *([a-zA-Z]+)"),
		(task, value) => {
			task.onCompletion = value.toLowerCase();
		},
	],
	[
		TRAILING_HASHTAG,
		(task, value) => {
			const tag = value.trim();
			task.trailingTags = task.trailingTags ? `${tag} ${task.trailingTags}` : tag;
		},
	],
	[
		emojiField("🆔", `(${TASK_ID})`),
		(task, value) => {
			task.id = value.trim();
		},
	],
	[
		dataviewField(`id:: *(${TASK_ID})`),
		(task, value) => {
			task.id = value.trim();
		},
	],
	[
		emojiField("⛔", `(${TASK_ID_LIST})`),
		(task, value) => {
			task.dependsOn = value.replace(/ /g, "").split(",").filter(Boolean);
		},
	],
	[
		dataviewField(`dependsOn:: *(${TASK_ID_LIST})`),
		(task, value) => {
			task.dependsOn = value.replace(/ /g, "").split(",").filter(Boolean);
		},
	],
];

interface ParsedTaskBody {
	description: string;
	priority: Priority;
	dates: Partial<Record<TaskDateField, TaskDate>>;
	recurrence: string;
	onCompletion: string;
	id: string;
	dependsOn: string[];
	trailingTags: string;
}

/** Peel the signifiers off a task body, as Tasks' serializer does (at most 20 passes). */
export function parseTaskBody(body: string): ParsedTaskBody {
	const parsed: ParsedTaskBody = {
		description: body,
		priority: PRIORITY_NONE,
		dates: {},
		recurrence: "",
		onCompletion: "",
		id: "",
		dependsOn: [],
		trailingTags: "",
	};
	for (let run = 0; run <= 20; run += 1) {
		let matched = false;
		for (const [pattern, set] of SIGNIFIERS) {
			const match = pattern.exec(parsed.description);
			if (!match) continue;
			// The trailing-tag pattern captures its leading whitespace in group 1.
			set(parsed, pattern === TRAILING_HASHTAG ? match[0] : (match[1] ?? ""));
			parsed.description = parsed.description.slice(0, match.index).trim();
			matched = true;
		}
		if (!matched) break;
	}
	if (parsed.trailingTags) {
		parsed.description = parsed.description
			? `${parsed.description} ${parsed.trailingTags}`
			: parsed.trailingTags;
	}
	parsed.recurrence = recurrenceText(parsed.recurrence);
	return parsed;
}

export interface TaskLineContext {
	file: TaskFile;
	line: number;
	heading: string | undefined;
	statuses: ReadonlyMap<string, TaskStatus>;
	globalFilter: string;
}

/**
 * The list entry a line holds: a task, a plain list item (including a
 * checkbox the global filter excludes), or `undefined` when the line is not a
 * list item at all.
 */
export function parseListLine(text: string, context: TaskLineContext): ListEntry | undefined {
	const base = {
		file: context.file,
		line: context.line,
		parent: undefined,
		children: [],
	};
	const task = TASK_LINE.exec(text);
	if (task) {
		const [, indentation = "", , symbol = " ", rest = ""] = task;
		let body = rest.trim();
		if (context.globalFilter && !body.includes(context.globalFilter)) {
			return { ...base, kind: "item", indentation, statusCharacter: symbol, description: body };
		}
		const blockLink = BLOCK_LINK.exec(body)?.[0] ?? "";
		if (blockLink) body = body.slice(0, -blockLink.length).trim();
		const parsed = parseTaskBody(body);
		const tags = [...parsed.description.matchAll(HASHTAGS)]
			.map((match) => match[0].trim())
			.filter((tag) => tag !== context.globalFilter);
		return {
			...base,
			kind: "task",
			indentation,
			status: statusFor(context.statuses, symbol),
			description: parsed.description,
			priority: parsed.priority,
			dates: parsed.dates,
			recurrence: parsed.recurrence,
			onCompletion: parsed.onCompletion,
			id: parsed.id,
			dependsOn: parsed.dependsOn,
			tags,
			blockLink,
			heading: context.heading,
			scheduledInferred: false,
		};
	}
	const item = LIST_LINE.exec(text);
	if (!item) return undefined;
	return { ...base, kind: "item", indentation: item[1] ?? "", description: (item[3] ?? "").trim() };
}

/** Done, cancelled and non-task statuses count as done. */
export function isDone(task: Task): boolean {
	const { type } = task.status;
	return type === "DONE" || type === "CANCELLED" || type === "NON_TASK";
}

/** The status type prefixed with its sort order, as Tasks groups and sorts it (`%%2%%TODO`). */
export function statusTypeGroupText(task: Task): string {
	return `%%${STATUS_TYPE_ORDER[task.status.type]}%%${task.status.type}`;
}

/** The nearest task above an entry in its list. */
export function closestParentTask(entry: ListEntry): Task | undefined {
	for (let parent = entry.parent; parent; parent = parent.parent) {
		if (parent.kind === "task") return parent;
	}
	return undefined;
}

/** The file name without its extension: what Tasks calls a task's `filename`. */
export function fileBaseName(file: TaskFile): string {
	return (file.path.split("/").pop() ?? file.path).replace(/\.[^.]*$/, "");
}

/** The earliest valid date among start, scheduled and due: the date a task "happens". */
export function happensDay(task: Task): Day | undefined {
	const days = [task.dates.start, task.dates.scheduled, task.dates.due]
		.map((date) => date?.day)
		.filter((day): day is Day => day !== undefined && !Number.isNaN(day));
	return days.length > 0 ? Math.min(...days) : undefined;
}

const PRIORITY_URGENCY: Record<Priority, number> = {
	0: 9,
	1: 6,
	2: 3.9,
	3: 1.95,
	4: 0,
	5: -1.8,
};

/** Tasks' urgency score (the taskwarrior-derived formula), relative to `today`. */
export function urgencyOf(task: Task, today: Day): number {
	let urgency = 0;
	const due = task.dates.due?.day;
	if (due !== undefined && !Number.isNaN(due)) {
		const daysOverdue = today - due;
		const multiplier =
			daysOverdue >= 7 ? 1 : daysOverdue >= -14 ? ((daysOverdue + 14) * 0.8) / 21 + 0.2 : 0.2;
		urgency += multiplier * 12;
	}
	const scheduled = task.dates.scheduled?.day;
	if (scheduled !== undefined && today >= scheduled) urgency += 5;
	const start = task.dates.start?.day;
	if (start !== undefined && today < start) urgency -= 3;
	urgency += PRIORITY_URGENCY[task.priority];
	return urgency;
}

/** A task blocks when a not-done task depends on its id. */
export function isBlocking(task: Task, allTasks: readonly Task[]): boolean {
	if (task.id === "" || isDone(task)) return false;
	return allTasks.some((other) => !isDone(other) && other.dependsOn.includes(task.id));
}

/** A task is blocked while any task it depends on is not done. */
export function isBlocked(task: Task, allTasks: readonly Task[]): boolean {
	if (task.dependsOn.length === 0 || isDone(task)) return false;
	return task.dependsOn.some((id) => allTasks.some((other) => other.id === id && !isDone(other)));
}
