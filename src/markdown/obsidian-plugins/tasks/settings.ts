/**
 * The Tasks settings a build uses: the vault's `data.json`, overridden by the
 * site's `tasks` options, with Tasks' own defaults underneath.
 */

import type { NormalizedPluginOptions } from "../../types.js";
import { readObsidianPluginSettings } from "../settings.js";
import { type Day, dayOfLocalDate, resolveToday } from "./dates.js";
import type { TasksStatusType } from "./options.js";

/** The upstream plugin id, which names its settings folder. */
export const TASKS_PLUGIN_ID = "obsidian-tasks-plugin";

/** Every status type, with the prefix Tasks sorts and groups them by. */
export const STATUS_TYPE_ORDER: Record<TasksStatusType | "EMPTY", number> = {
	IN_PROGRESS: 1,
	TODO: 2,
	ON_HOLD: 3,
	DONE: 4,
	CANCELLED: 5,
	NON_TASK: 6,
	EMPTY: 7,
};

export interface TaskStatus {
	symbol: string;
	name: string;
	nextStatusSymbol: string;
	type: TasksStatusType;
}

/** The statuses Tasks ships with (its core and default custom statuses). */
export const DEFAULT_STATUSES: readonly TaskStatus[] = [
	{ symbol: " ", name: "Todo", nextStatusSymbol: "x", type: "TODO" },
	{ symbol: "x", name: "Done", nextStatusSymbol: " ", type: "DONE" },
	{ symbol: "/", name: "In Progress", nextStatusSymbol: "x", type: "IN_PROGRESS" },
	{ symbol: "-", name: "Cancelled", nextStatusSymbol: " ", type: "CANCELLED" },
];

/** Tasks' built-in presets, which a vault's own presets extend. */
const DEFAULT_PRESETS: Record<string, string> = {
	this_file: "path includes {{query.file.path}}",
	this_folder: "folder includes {{query.file.folder}}",
	this_folder_only: "filter by function task.file.folder === query.file.folder",
	this_root: "root includes {{query.file.root}}",
	hide_date_fields:
		"# Hide any values for all date fields\nhide due date\nhide scheduled date\nhide start date\nhide created date\nhide done date\nhide cancelled date",
	hide_non_date_fields:
		"# Hide all the non-date fields, but not tags\nhide id\nhide depends on\nhide recurrence rule\nhide on completion\nhide priority",
	hide_query_elements:
		"# Hide toolbar, postpone, edit, backlinks and task count\nhide toolbar\nhide postpone button\nhide edit button\nhide backlinks\nhide task count",
	hide_everything:
		"# Hide everything except description and any tags\npreset hide_date_fields\npreset hide_non_date_fields\npreset hide_query_elements",
};

/** Tasks' "Use filename as Scheduled date": where it applies, and the extra format to read. */
export interface FilenameDates {
	/** Folders it is limited to; empty for the whole vault. */
	folders: string[];
	/** A Moment format tried first, strictly; `""` for just `YYYY-MM-DD` and `YYYYMMDD`. */
	format: string;
}

export interface TasksSettings {
	globalFilter: string;
	removeGlobalFilter: boolean;
	globalQuery: string;
	presets: Record<string, string>;
	/** Every known status, by symbol. */
	statuses: ReadonlyMap<string, TaskStatus>;
	taskCountLocation: "top" | "bottom";
	/** Set when undated tasks take their note's file name as their scheduled date. */
	filenameDates?: FilenameDates;
	today: Day;
	/** Settings that could not be used, to report once per query. */
	problems: string[];
}

function stringList(value: unknown): string[] | undefined {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: undefined;
}

/**
 * A status from a settings entry (`{symbol, name, nextStatusSymbol, type}`),
 * or `undefined` when the entry is not one.
 */
export function readStatus(value: unknown): TaskStatus | undefined {
	if (!value || typeof value !== "object" || !("symbol" in value) || !("name" in value)) {
		return undefined;
	}
	const { symbol, name } = value;
	if (typeof symbol !== "string" || typeof name !== "string") return undefined;
	const type =
		"type" in value && typeof value.type === "string" ? value.type.toUpperCase() : "TODO";
	if (!isStatusType(type)) return undefined;
	const next = "nextStatusSymbol" in value ? value.nextStatusSymbol : undefined;
	return { symbol, name, nextStatusSymbol: typeof next === "string" ? next : "x", type };
}

function isStatusType(value: string): value is TasksStatusType {
	return value !== "EMPTY" && value in STATUS_TYPE_ORDER;
}

/** The status a symbol names; an unknown symbol is a `TODO` named "Unknown", as in Tasks. */
export function statusFor(statuses: ReadonlyMap<string, TaskStatus>, symbol: string): TaskStatus {
	return statuses.get(symbol) ?? { symbol, name: "Unknown", nextStatusSymbol: "x", type: "TODO" };
}

function vaultStatuses(vault: Record<string, unknown> | undefined): unknown[] | undefined {
	const statusSettings = vault?.statusSettings;
	if (!statusSettings || typeof statusSettings !== "object") return undefined;
	const core = "coreStatuses" in statusSettings ? statusSettings.coreStatuses : undefined;
	const custom = "customStatuses" in statusSettings ? statusSettings.customStatuses : undefined;
	return [...(Array.isArray(core) ? core : []), ...(Array.isArray(custom) ? custom : [])];
}

/** The settings in force for `options`: site options, then the vault's `data.json`, then Tasks' defaults. */
export function resolveTasksSettings(options: NormalizedPluginOptions): TasksSettings {
	const own = options.tasks;
	const vault =
		own.readVaultSettings === false
			? undefined
			: readObsidianPluginSettings(options.vaultRoot, TASKS_PLUGIN_ID);
	const problems: string[] = [];

	const statuses = new Map<string, TaskStatus>();
	for (const entry of vaultStatuses(vault) ?? DEFAULT_STATUSES) {
		const status = readStatus(entry);
		if (status) statuses.set(status.symbol, status);
		else
			problems.push(
				`Ignoring a task status in the vault's Tasks settings: ${JSON.stringify(entry)}`,
			);
	}
	for (const entry of own.statuses ?? []) {
		const status = readStatus(entry);
		if (status) statuses.set(status.symbol, status);
		else problems.push(`Ignoring the task status option ${JSON.stringify(entry)}`);
	}

	const vaultPresets =
		vault?.presets && typeof vault.presets === "object"
			? Object.fromEntries(
					Object.entries(vault.presets).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string",
					),
				)
			: {};

	let today = resolveToday(own.now);
	if (today === undefined) {
		problems.push(`The \`tasks.now\` option "${String(own.now)}" is not a date; using today.`);
		today = dayOfLocalDate(new Date());
	}

	const searchResults = vault?.searchResults;
	const countAtTop =
		typeof searchResults === "object" &&
		searchResults !== null &&
		"taskCountLocation" in searchResults &&
		searchResults.taskCountLocation === "top";
	return {
		globalFilter:
			own.globalFilter ?? (typeof vault?.globalFilter === "string" ? vault.globalFilter : ""),
		removeGlobalFilter: own.removeGlobalFilter ?? vault?.removeGlobalFilter === true,
		globalQuery:
			own.globalQuery ?? (typeof vault?.globalQuery === "string" ? vault.globalQuery : ""),
		presets: { ...DEFAULT_PRESETS, ...vaultPresets, ...own.presets },
		statuses,
		taskCountLocation: countAtTop ? "top" : "bottom",
		filenameDates:
			(own.useFilenameAsScheduledDate ?? vault?.useFilenameAsScheduledDate === true)
				? {
						folders: own.filenameAsDateFolders ?? stringList(vault?.filenameAsDateFolders) ?? [],
						format:
							own.filenameAsScheduledDateFormat ??
							(typeof vault?.filenameAsScheduledDateFormat === "string"
								? vault.filenameAsScheduledDateFormat
								: ""),
					}
				: undefined,
		today,
		problems,
	};
}
