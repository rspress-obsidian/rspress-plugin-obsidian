/**
 * The parts of a task Tasks prints after its description — one table naming
 * each part for `hide`/`show`, giving it the class and `data-*` attribute it is
 * drawn with, and writing its text.
 */
import { isoDay, type TaskDate } from "./dates.js";
import type { Task } from "./task.js";
import { priorityEmoji, type TaskDateField, taskFieldEmoji } from "./task-fields.js";

/** A component's text: what it shows, and the unabbreviated form a tooltip carries. */
export interface ComponentText {
	text: string;
	full: string;
}

/** One component of a task line. */
export interface TaskComponentSpec {
	/** The option `hide`/`show` takes (`hide due date`). */
	option: string;
	/** The class the component's span is drawn with. */
	className: string;
	/** The date the component shows, absent when it shows no date. */
	date?: { field: TaskDateField; attribute: string };
	/** What the component says about a task, `undefined` when the task has nothing to show. */
	text(task: Task, short: boolean): ComponentText | undefined;
}

/** ` 📅 2024-05-01`, or just the emoji in short mode; `undefined` for an empty value. */
function symbolAndValue(symbol: string, value: string, short: boolean): ComponentText | undefined {
	if (!value) return undefined;
	return { text: short ? ` ${symbol}` : ` ${symbol} ${value}`, full: `${symbol} ${value}` };
}

function dateText(task: Task, field: TaskDateField, short: boolean): ComponentText | undefined {
	const date: TaskDate | undefined = task.dates[field];
	if (!date) return undefined;
	return symbolAndValue(
		taskFieldEmoji(field),
		Number.isNaN(date.day) ? "Invalid date" : isoDay(date.day),
		short,
	);
}

/** A date component: its class and attribute are its field's name. */
function dateComponent(field: TaskDateField): TaskComponentSpec {
	return {
		option: `${field} date`,
		className: `task-${field}`,
		date: { field, attribute: `data-task-${field}` },
		text: (task, short) => dateText(task, field, short),
	};
}

/** Every component of a task line, in the order Tasks prints them. */
export const COMPONENTS = {
	id: {
		option: "id",
		className: "task-id",
		text: (task: Task, short: boolean) => symbolAndValue("🆔", task.id, short),
	},
	dependsOn: {
		option: "depends on",
		className: "task-dependsOn",
		text: (task: Task, short: boolean) => symbolAndValue("⛔", task.dependsOn.join(","), short),
	},
	priority: {
		option: "priority",
		className: "task-priority",
		text: (task: Task): ComponentText | undefined => {
			const emoji = priorityEmoji(task.priority);
			return emoji ? { text: ` ${emoji}`, full: emoji } : undefined;
		},
	},
	recurrenceRule: {
		option: "recurrence rule",
		className: "task-recurring",
		text: (task: Task, short: boolean) => symbolAndValue("🔁", task.recurrence, short),
	},
	onCompletion: {
		option: "on completion",
		className: "task-onCompletion",
		text: (task: Task, short: boolean) =>
			symbolAndValue("🏁", task.onCompletion === "ignore" ? "" : task.onCompletion, short),
	},
	createdDate: dateComponent("created"),
	startDate: dateComponent("start"),
	scheduledDate: dateComponent("scheduled"),
	dueDate: dateComponent("due"),
	cancelledDate: dateComponent("cancelled"),
	doneDate: dateComponent("done"),
} as const satisfies Record<string, TaskComponentSpec>;

export type TaskComponent = keyof typeof COMPONENTS;

/** Every component, in the order Tasks prints them. */
export const TASK_COMPONENTS = Object.keys(COMPONENTS) as readonly TaskComponent[];

/** The option each component answers to, in the same order. */
export const COMPONENT_OPTIONS: readonly (readonly [string, TaskComponent])[] = TASK_COMPONENTS.map(
	(component) => [COMPONENTS[component].option, component] as const,
);

/** Every date component, in the same order. */
export const DATE_COMPONENTS = TASK_COMPONENTS.flatMap((component) => {
	const spec: TaskComponentSpec = COMPONENTS[component];
	return spec.date ?? [];
});
