/**
 * A linked-page metadata key (Kanban's "Linked page metadata" setting): the
 * frontmatter property of the note a card links to, shown under the card.
 */
export interface KanbanMetadataKey {
	/** The frontmatter property (or, with `enableDataview`, inline field) to show. */
	metadataKey: string;
	/** The row's label. Default: the key. */
	label?: string;
	/** Show the value alone, without its label. Default: `false`. */
	shouldHideLabel?: boolean;
	/** Render the value as markdown (links, formatting). Default: `false`. */
	containsMarkdown?: boolean;
}

/** A tag colour (Kanban's "Tag colors" setting). */
export interface KanbanTagColor {
	/** The tag with its `#`, as written: `#urgent`. */
	tagKey: string;
	/** Any CSS colour. */
	color?: string;
	backgroundColor?: string;
}

/**
 * A date colour (Kanban's "Date colors" setting). Exactly one of `isToday`,
 * `isBefore`, `isAfter`, or a `distance`/`unit`/`direction` window applies.
 */
export interface KanbanDateColor {
	/** The card's date is today. */
	isToday?: boolean;
	/** The card's date is in the past. */
	isBefore?: boolean;
	/** The card's date is in the future. */
	isAfter?: boolean;
	/** The date lies within `distance` `unit`s of today, in `direction`. */
	distance?: number;
	unit?: "hours" | "days" | "weeks" | "months";
	direction?: "before" | "after";
	color?: string;
	backgroundColor?: string;
}

/** Where `[key:: value]` fields written in a card are shown. */
export type KanbanInlineMetadataPosition = "body" | "footer" | "metadata-table";

/**
 * Options for the Kanban feature (`enableKanban`).
 *
 * Every option below `showArchive` is one of Kanban's own settings, named in
 * camelCase (`dateFormat` is Kanban's `date-format`). A setting resolves, most
 * specific first: the board's own settings (its `%% kanban:settings %%` block
 * and setting keys in its frontmatter), then the option here, then the vault's
 * Kanban settings (`.obsidian/plugins/obsidian-kanban/data.json`), then
 * Kanban's default.
 */
export interface KanbanOptions {
	/**
	 * Read the vault's Kanban settings
	 * (`.obsidian/plugins/obsidian-kanban/data.json`). An option set here wins
	 * over the vault's setting. Default: `true`.
	 */
	readVaultSettings?: boolean;
	/**
	 * "Today" for relative dates (`in 3 days`), date colours and the
	 * `is-today`/`is-past`/`is-future` card classes, so a build is
	 * reproducible. A `Date`, or a string such as `"2024-05-01"`.
	 * Default: the build's clock.
	 */
	now?: Date | string;
	/**
	 * Show each board's archive (the cards under `***` + `## Archive`) as a
	 * last lane. Obsidian only shows it in the markdown view. Default: `false`.
	 */
	showArchive?: boolean;
	/** `date-trigger`: the text that opens a card date, `@{2024-01-01}`. Default: `@`. */
	dateTrigger?: string;
	/** `time-trigger`: the text that opens a card time, `@@{10:00}`. Default: `@@`. */
	timeTrigger?: string;
	/**
	 * `date-format`: the Moment.js format dates are written in. Default: the
	 * daily-notes format when `enableDailyNotes` is on, else `YYYY-MM-DD`.
	 */
	dateFormat?: string;
	/** `time-format`: the Moment.js format times are written and shown in. Default: `HH:mm`. */
	timeFormat?: string;
	/** `date-display-format`: the Moment.js format dates are shown in. Default: `dateFormat`. */
	dateDisplayFormat?: string;
	/** `show-relative-date`: show "in 3 days" / "yesterday" under a dated card. Default: `false`. */
	showRelativeDate?: boolean;
	/** `link-date-to-daily-note`: a card's date links to that day's daily note. Default: `false`. */
	linkDateToDailyNote?: boolean;
	/**
	 * `move-dates`: take dates and times out of the card text and show them
	 * under it. Default: `false`.
	 */
	moveDates?: boolean;
	/** `move-tags`: take tags out of the card text and show them under it. Default: `false`. */
	moveTags?: boolean;
	/**
	 * Kanban 1.x's `hide-date-in-title`, read when `moveDates` is not set
	 * anywhere: hide dates from the card text. Default: `false`.
	 */
	hideDateInTitle?: boolean;
	/** Kanban 1.x's `hide-date-display`: never show the date under the card. Default: `false`. */
	hideDateDisplay?: boolean;
	/**
	 * Kanban 1.x's `hide-tags-in-title`, read when `moveTags` is not set
	 * anywhere: hide tags from the card text. Default: `false`.
	 */
	hideTagsInTitle?: boolean;
	/** Kanban 1.x's `hide-tags-display`: never show the tags under the card. Default: `false`. */
	hideTagsDisplay?: boolean;
	/**
	 * `move-task-metadata`: take Tasks emoji fields (`📅 2024-05-01`, needs
	 * `enableTasks`) out of the card text and show them under it. Default: `false`.
	 */
	moveTaskMetadata?: boolean;
	/**
	 * `inline-metadata-position`: where Dataview `[key:: value]` fields
	 * (needs `enableDataview`) are shown. Default: `"body"` (left in the text).
	 */
	inlineMetadataPosition?: KanbanInlineMetadataPosition;
	/**
	 * `metadata-keys`: frontmatter properties of the note a card links to,
	 * shown in a table under the card. Added to the board's own keys.
	 */
	metadataKeys?: KanbanMetadataKey[];
	/** `tag-colors`. */
	tagColors?: KanbanTagColor[];
	/** `date-colors`. */
	dateColors?: KanbanDateColor[];
	/** `lane-width`: lane width in pixels. Default: `272`. */
	laneWidth?: number;
	/** `full-list-lane-width`: lanes span the page in the list view. Default: `false`. */
	fullListLaneWidth?: boolean;
	/**
	 * `max-archive-size`: how many archived cards are kept; the newest win.
	 * `-1` keeps all. Default: `-1`.
	 */
	maxArchiveSize?: number;
	/** `hide-card-count`: hide the card count (and WIP limit) in lane headers. Default: `false`. */
	hideCardCount?: boolean;
	/** `show-checkboxes`: show each card's checkbox. Default: `false`. */
	showCheckboxes?: boolean;
}
