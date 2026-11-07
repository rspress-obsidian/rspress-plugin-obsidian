/**
 * What a task line can carry: the fields Tasks writes and the priorities it
 * numbers — each name, emoji and Kanban label in one place, so reading a task
 * and drawing a Kanban card cannot drift apart.
 */

/** Priorities as Tasks numbers them: 0 highest … 5 lowest; 3 is "none". */
export type Priority = 0 | 1 | 2 | 3 | 4 | 5;

/** The priority of a task without one: what `Normal` and `priority is none` mean. */
export const PRIORITY_NONE: Priority = 3;

/** One priority, with every name its readers give it. */
export interface PrioritySpec {
	/** 0 highest … 5 lowest. */
	rank: Priority;
	/** The name a group heading and `data-task-priority` give it. */
	title: string;
	/** The name a `priority is <name>` filter gives it; `none` for no priority. */
	query: string;
	/** The name a Dataview `priority::` field gives it; absent for no priority. */
	inline?: string;
	/** The emoji signifier; `""` for no priority, which is written by writing none. */
	emoji: string;
}

/** Every priority, highest first. */
export const PRIORITIES: readonly PrioritySpec[] = [
	{ rank: 0, title: "Highest", query: "highest", inline: "highest", emoji: "🔺" },
	{ rank: 1, title: "High", query: "high", inline: "high", emoji: "⏫" },
	{ rank: 2, title: "Medium", query: "medium", inline: "medium", emoji: "🔼" },
	{ rank: 3, title: "Normal", query: "none", emoji: "" },
	{ rank: 4, title: "Low", query: "low", inline: "low", emoji: "🔽" },
	{ rank: 5, title: "Lowest", query: "lowest", inline: "lowest", emoji: "⏬" },
];

/** The names a Dataview `priority::` field takes. */
export const PRIORITY_INLINE_NAMES: readonly string[] = PRIORITIES.flatMap((spec) =>
	spec.inline === undefined ? [] : [spec.inline],
);

/** The names a `priority is <name>` filter takes. */
export const PRIORITY_QUERY_NAMES: readonly string[] = PRIORITIES.map((spec) => spec.query);

/** The priority whose value is `value`, written as an emoji or as a name. */
function priorityOf(value: string): Priority | undefined {
	return PRIORITIES.find(
		(spec) => spec.emoji === value || spec.query === value || spec.inline === value,
	)?.rank;
}

/** What a priority is called as a group heading and in `data-task-priority`. */
export function priorityTitle(priority: Priority): string {
	return PRIORITIES[priority]?.title ?? "Normal";
}

/** The emoji a priority is written with, `""` for no priority. */
export function priorityEmoji(priority: Priority): string {
	return PRIORITIES[priority]?.emoji ?? "";
}

/** The emoji that writes the priority `value` names, `undefined` for a name no priority takes. */
export function priorityEmojiOfName(value: string): string | undefined {
	const priority = priorityOf(value);
	return priority === undefined ? undefined : priorityEmoji(priority);
}

/**
 * The priority a `priority::` field or a `priority is <name>` filter names;
 * `undefined` for a name no priority takes.
 */
export function priorityOfName(name: string): Priority | undefined {
	return PRIORITIES.find((spec) => spec.query === name || spec.inline === name)?.rank;
}

/** The priority an emoji signifier names; `undefined` for an emoji no priority takes. */
export function priorityOfEmoji(emoji: string): Priority | undefined {
	return PRIORITIES.find((spec) => spec.emoji !== "" && spec.emoji === emoji)?.rank;
}

/** The fields of a task line, by the name this code knows each one by. */
export type TaskField =
	| "priority"
	| "done"
	| "cancelled"
	| "due"
	| "scheduled"
	| "start"
	| "created"
	| "recurrence"
	| "id"
	| "dependsOn";

/** The dates a task carries, by the name queries use for them. */
export type TaskDateField = "created" | "start" | "scheduled" | "due" | "cancelled" | "done";

/** One field Tasks writes on a task line, and Kanban labels. */
export interface TaskFieldSpec {
	/** The Dataview keys it is written with; the first is the one Tasks writes. */
	names: readonly string[];
	/** The emoji signifiers; the first is the one Kanban shows. Absent when the field has no emoji of its own. */
	emojis?: readonly string[];
	/** Kanban's label for the field. */
	label: string;
}

/**
 * Every field a task line carries, in the order Tasks peels them.
 *
 * Tasks writes the done date as `[completion:: …]` and the recurrence as
 * `[repeat:: …]`, while the emoji shorthands Dataview and Kanban read come out
 * as `completion` and `recurrence`, so both names of each are listed.
 */
export const TASK_FIELDS: Record<TaskField, TaskFieldSpec> = {
	priority: { names: ["priority"], label: "Priority" },
	done: { names: ["completion"], emojis: ["✅"], label: "Done" },
	cancelled: { names: ["cancelled"], emojis: ["❌"], label: "Cancelled" },
	due: { names: ["due"], emojis: ["📅", "📆", "🗓"], label: "Due" },
	scheduled: { names: ["scheduled"], emojis: ["⏳", "⌛"], label: "Scheduled" },
	start: { names: ["start"], emojis: ["🛫"], label: "Start" },
	created: { names: ["created"], emojis: ["➕"], label: "Created" },
	recurrence: { names: ["repeat", "recurrence"], emojis: ["🔁"], label: "Recurrence" },
	id: { names: ["id"], emojis: ["🆔"], label: "ID" },
	dependsOn: { names: ["dependsOn"], emojis: ["⛔"], label: "Depends on" },
};

/** Every key a task field is written with, by the field it names. */
const FIELD_BY_NAME = new Map<string, TaskFieldSpec>(
	Object.values(TASK_FIELDS).flatMap((spec) => spec.names.map((name) => [name, spec] as const)),
);

/** The field an inline key names, `undefined` when the key is not a task field. */
export function taskFieldOf(key: string): TaskFieldSpec | undefined {
	return FIELD_BY_NAME.get(key);
}

/** Whether an inline key names a field Tasks owns. */
export function isTaskField(key: string): boolean {
	return FIELD_BY_NAME.has(key);
}

/** The emoji a field is written with in a task line, `""` when it has none. */
export function taskFieldEmoji(field: TaskField): string {
	return TASK_FIELDS[field].emojis?.[0] ?? "";
}
