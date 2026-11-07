/**
 * One task line, read the way Tasks reads it: the checkbox status, then the
 * signifiers at the end of the line — emoji (`📅 2024-05-01`, `⏫`, `🔁 every
 * week`, `🆔 abc`, `⛔ abc,def`) or Dataview fields (`[due:: 2024-05-01]`) —
 * peeled off right to left until only the description is left.
 */
import * as rruleModule from "rrule";
import { type Day, ISO_DAY_SHAPE } from "../../../shared/day.js";
import {
	extractInlineFields,
	type InlineField,
	LIST_ITEM,
	LIST_ITEM_PREFIX,
	TASK_BOX,
} from "../../dataview-metadata.js";
import type { ContentPage } from "../../types.js";
import { parseIsoDay, type TaskDate } from "./dates.js";
import { STATUS_TYPE_ORDER, statusFor, type TaskStatus } from "./settings.js";
import {
	PRIORITIES,
	PRIORITY_INLINE_NAMES,
	PRIORITY_NONE,
	type Priority,
	priorityOfEmoji,
	priorityOfName,
	TASK_FIELDS,
	type TaskDateField,
	type TaskField,
} from "./task-fields.js";

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
interface PlainListItem extends ListEntryBase {
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

/** The `>`s and indentation before a list marker; the marker itself is `LIST_ITEM`'s. */
const LIST_PREFIX = /^[\s\t>]*/u;
const BLOCK_LINK = / \^[a-zA-Z0-9-]+$/u;
const HASHTAGS = /(^|\s)#[^ !@#$%^&*(),.?":{}|<>]+/g;
/** The tag at the end of the line, without the whitespace in front of it. */
const TRAILING_HASHTAG = /(?:^|\s)(#[^ !@#$%^&*(),.?":{}|<>]+)$/u;

const TASK_ID = "[a-zA-Z0-9-_]+";
const TASK_ID_LIST = `${TASK_ID}( *, *${TASK_ID} *)*`;

/** An emoji signifier at the end of the line, its value in group 1. */
function emojiField(symbols: string, value = ""): RegExp {
	return new RegExp(`${symbols}\uFE0F?${value ? ` *${value}` : ""}$`, "u");
}

type Setter = (task: ParsedTaskBody, value: string) => void;

const dateSetter =
	(field: TaskDateField): Setter =>
	(task, value) => {
		task.dates[field] = { text: value, day: parseIsoDay(value) };
	};

/**
 * One fact a task line carries, in both spellings Tasks writes it: an emoji
 * signifier, a Dataview field, or both. Its value is read from whichever ends
 * the line.
 */
interface Signifier {
	/** The emoji spelling, ending the line, its value in group 1. */
	pattern?: RegExp;
	/** The Dataview spelling: the keys it is written with, and the value it carries. */
	dataview?: { names: readonly string[]; value: RegExp };
	set: Setter;
}

/** A field's two spellings: its emoji signifier, and its Dataview key with the same value. */
function fieldSignifier(field: TaskField, value: string, set: Setter): Signifier {
	const spec = TASK_FIELDS[field];
	return {
		pattern: spec.emojis && emojiField(`(?:${spec.emojis.join("|")})`, `(${value})`),
		dataview: { names: spec.names, value: new RegExp(`^(?:${value})$`, "u") },
		set,
	};
}

/** Every signifier Tasks reads, in the order it peels them. */
const SIGNIFIERS: readonly Signifier[] = [
	{
		pattern: emojiField(
			`(${PRIORITIES.map((spec) => spec.emoji)
				.filter(Boolean)
				.join("|")})`,
		),
		dataview: {
			names: TASK_FIELDS.priority.names,
			value: new RegExp(`^(?:${PRIORITY_INLINE_NAMES.join("|")})$`, "u"),
		},
		set: (task, value) => {
			task.priority = priorityOfEmoji(value) ?? priorityOfName(value) ?? PRIORITY_NONE;
		},
	},
	fieldSignifier("done", ISO_DAY_SHAPE, dateSetter("done")),
	fieldSignifier("cancelled", ISO_DAY_SHAPE, dateSetter("cancelled")),
	fieldSignifier("due", ISO_DAY_SHAPE, dateSetter("due")),
	fieldSignifier("scheduled", ISO_DAY_SHAPE, dateSetter("scheduled")),
	fieldSignifier("start", ISO_DAY_SHAPE, dateSetter("start")),
	fieldSignifier("created", ISO_DAY_SHAPE, dateSetter("created")),
	fieldSignifier("recurrence", "[a-zA-Z0-9, !]+", (task, value) => {
		task.recurrence = value.trim();
	}),
	// Kanban has no on-completion field, so it is the one signifier outside the shared vocabulary.
	{
		pattern: emojiField("🏁", "([a-zA-Z]+)"),
		dataview: { names: ["onCompletion"], value: /^[a-zA-Z]+$/u },
		set: (task, value) => {
			task.onCompletion = value.toLowerCase();
		},
	},
	{
		pattern: TRAILING_HASHTAG,
		set: (task, value) => {
			const tag = value.trim();
			task.trailingTags = task.trailingTags ? `${tag} ${task.trailingTags}` : tag;
		},
	},
	fieldSignifier("id", TASK_ID, (task, value) => {
		task.id = value.trim();
	}),
	fieldSignifier("dependsOn", TASK_ID_LIST, (task, value) => {
		task.dependsOn = value.replace(/ /g, "").split(",").filter(Boolean);
	}),
];

/** The Dataview spellings, by each key they are written with. */
const DATAVIEW_SIGNIFIERS = new Map<string, Signifier>(
	SIGNIFIERS.flatMap((signifier) =>
		(signifier.dataview?.names ?? []).map((name) => [name, signifier] as const),
	),
);

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

/** The Dataview field ending `text`, in brackets or parentheses, its trailing comma allowed. */
function trailingInlineField(text: string): InlineField | undefined {
	const fields = extractInlineFields(text);
	const last = fields[fields.length - 1];
	if (!last || !/^ *,?$/u.test(text.slice(last.end))) return undefined;
	return last;
}

/** Peel the emoji signifiers off the end of the body; whether any was there. */
function peelEmojiSignifiers(task: ParsedTaskBody): boolean {
	let peeled = false;
	for (const signifier of SIGNIFIERS) {
		if (!signifier.pattern) continue;
		const match = signifier.pattern.exec(task.description);
		if (!match) continue;
		signifier.set(task, match[1] ?? "");
		task.description = task.description.slice(0, match.index).trim();
		peeled = true;
	}
	return peeled;
}

/** Peel the Dataview fields off the end of the body, one at a time; whether any was there. */
function peelDataviewFields(task: ParsedTaskBody): boolean {
	let peeled = false;
	for (;;) {
		const field = trailingInlineField(task.description);
		const signifier = field && DATAVIEW_SIGNIFIERS.get(field.key);
		if (!field || !signifier?.dataview?.value.test(field.value)) break;
		signifier.set(task, field.value);
		task.description = task.description.slice(0, field.start).trim();
		peeled = true;
	}
	return peeled;
}

/** Peel the signifiers off a task body, as Tasks' serializer does (at most 20 passes). */
function parseTaskBody(body: string): ParsedTaskBody {
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
		const emojiPeeled = peelEmojiSignifiers(parsed);
		if (!peelDataviewFields(parsed) && !emojiPeeled) break;
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
	const indentation = LIST_PREFIX.exec(text)?.[0] ?? "";
	const item = LIST_ITEM.exec(text.slice(indentation.length));
	if (!item) return undefined;
	const itemText = item[4] ?? "";
	const box = TASK_BOX.exec(itemText);
	if (box) {
		const symbol = box[1] ?? " ";
		let body = (box[2] ?? "").trim();
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
	return { ...base, kind: "item", indentation, description: itemText.trim() };
}

/** Whether a line is a list item at all, before reading the whole of it. */
export function startsListItem(text: string): boolean {
	const indentation = LIST_PREFIX.exec(text)?.[0] ?? "";
	return LIST_ITEM_PREFIX.test(text.slice(indentation.length));
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
