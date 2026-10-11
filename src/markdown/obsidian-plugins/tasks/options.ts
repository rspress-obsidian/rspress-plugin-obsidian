/** A Tasks status type: how a status counts in `done`/`not done` and in sorting. */
export type TasksStatusType =
	| "TODO"
	| "DONE"
	| "IN_PROGRESS"
	| "ON_HOLD"
	| "CANCELLED"
	| "NON_TASK";

/** A custom task status, as Tasks' "Task Statuses" settings define one. */
export interface TasksStatusOption {
	/** The character between the brackets: `/` in `- [/] task`. */
	symbol: string;
	/** Shown in `status.name` filters, grouping and the `data-task-status-name` attribute. */
	name: string;
	/** The status a click moves to. Kept for parity with Tasks' settings. Default: `x`. */
	nextStatusSymbol?: string;
	/** Default: `TODO`. */
	type?: TasksStatusType;
}

/** Options for the Tasks feature (`enableTasks`). */
export interface TasksOptions {
	/**
	 * Read the vault's Tasks settings
	 * (`.obsidian/plugins/obsidian-tasks-plugin/data.json`). An option set here wins
	 * over the vault's setting. Default: `true`.
	 */
	readVaultSettings?: boolean;
	/**
	 * "Today" for every relative date (`due before tomorrow`, `this week`,
	 * urgency, `data-task-due="past-2d"`), so a build is reproducible.
	 * A `Date`, or a string such as `"2024-05-01"`. Default: the build's date.
	 */
	now?: Date | string;
	/**
	 * Only list items containing this text are tasks (Tasks' "Global task
	 * filter"), for example `#task`. Default: the vault's setting, else none.
	 */
	globalFilter?: string;
	/** Hide the global filter from rendered task descriptions. Default: the vault's setting, else `false`. */
	removeGlobalFilter?: boolean;
	/**
	 * Instructions prepended to every ` ```tasks ` block (Tasks' "Global
	 * query"); a block opts out with `ignore global query`. Default: the
	 * vault's setting, else none.
	 */
	globalQuery?: string;
	/**
	 * Extra task statuses, added to the vault's (or Tasks' defaults: `[ ]`,
	 * `[x]`, `[/]`, `[-]`); a symbol already defined is replaced.
	 */
	statuses?: TasksStatusOption[];
	/**
	 * A task with no start, scheduled or due date, in a note whose file name
	 * holds a date (a daily note), takes that date as its scheduled date
	 * (Tasks' "Use filename as Scheduled date"). Default: the vault's setting,
	 * else `false`.
	 */
	useFilenameAsScheduledDate?: boolean;
	/**
	 * A Moment format for file-name dates, tried before `YYYY-MM-DD` and
	 * `YYYYMMDD`. Default: the vault's setting, else none.
	 */
	filenameAsScheduledDateFormat?: string;
	/**
	 * Folders (vault-relative, no trailing `/`) the file-name date applies in;
	 * empty for every folder. Default: the vault's setting, else every folder.
	 */
	filenameAsDateFolders?: string[];
	/**
	 * Named instruction lists a block uses with `preset <name>`, added to the
	 * vault's presets and Tasks' built-in ones.
	 */
	presets?: Record<string, string>;
}
