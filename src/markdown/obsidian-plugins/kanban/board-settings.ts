/**
 * Kanban's settings, resolved the way the plugin's `StateManager` compiles
 * them: a board's own settings win over the global ones, and a setting absent
 * everywhere takes Kanban's default. Here the global layer is the site's
 * options in front of the vault's `data.json`.
 */
import type { NormalizedPluginOptions } from "../../types.js";
import type {
	KanbanDateColor,
	KanbanInlineMetadataPosition,
	KanbanMetadataKey,
	KanbanOptions,
	KanbanTagColor,
} from "./options.js";

/** The frontmatter key that makes a note a board, and names its view. */
export const KANBAN_FRONTMATTER_KEY = "kanban-plugin";

/** How a board is laid out: lanes side by side, lanes stacked, or one table. */
type KanbanView = "board" | "list" | "table";

/** A layer of raw settings, keyed as Kanban stores them (`date-format`). */
export type KanbanSettingsLayer = Record<string, unknown>;

/** Every setting a board renders with, resolved and typed. */
export interface ResolvedKanbanSettings {
	view: KanbanView;
	dateTrigger: string;
	timeTrigger: string;
	dateFormat: string;
	timeFormat: string;
	dateDisplayFormat: string;
	/** A timed date in the metadata table: `dateDisplayFormat` and `timeFormat`, as the plugin derives it. */
	dateTimeDisplayFormat: string;
	showRelativeDate: boolean;
	linkDateToDailyNote: boolean;
	/** Dates and times leave the card text. */
	moveDates: boolean;
	/** Tags leave the card text. */
	moveTags: boolean;
	/** The date line under the card is shown (it needs `moveDates`). */
	showDateFooter: boolean;
	/** The tag list under the card is shown (it needs `moveTags`). */
	showTagFooter: boolean;
	moveTaskMetadata: boolean;
	inlineMetadataPosition: KanbanInlineMetadataPosition;
	metadataKeys: Required<KanbanMetadataKey>[];
	tagColors: KanbanTagColor[];
	dateColors: KanbanDateColor[];
	laneWidth?: number;
	fullListLaneWidth: boolean;
	/** `-1` keeps every archived card. */
	maxArchiveSize: number;
	hideCardCount: boolean;
	showCheckboxes: boolean;
	/** Lanes collapsed in Obsidian, by position (Kanban's `list-collapse` view state). */
	listCollapse: boolean[];
}

/** Settings a board carries that no site option stands for, but the renderer reads. */
const BOARD_ONLY_SETTING_KEYS = ["metadata-keys", "list-collapse"] as const;

/** The site option that stands for each Kanban setting. */
const OPTION_SETTING_KEYS: Record<string, string> = {
	dateTrigger: "date-trigger",
	timeTrigger: "time-trigger",
	dateFormat: "date-format",
	timeFormat: "time-format",
	dateDisplayFormat: "date-display-format",
	showRelativeDate: "show-relative-date",
	linkDateToDailyNote: "link-date-to-daily-note",
	moveDates: "move-dates",
	moveTags: "move-tags",
	hideDateInTitle: "hide-date-in-title",
	hideDateDisplay: "hide-date-display",
	hideTagsInTitle: "hide-tags-in-title",
	hideTagsDisplay: "hide-tags-display",
	moveTaskMetadata: "move-task-metadata",
	inlineMetadataPosition: "inline-metadata-position",
	metadataKeys: "metadata-keys",
	tagColors: "tag-colors",
	dateColors: "date-colors",
	laneWidth: "lane-width",
	fullListLaneWidth: "full-list-lane-width",
	maxArchiveSize: "max-archive-size",
	hideCardCount: "hide-card-count",
	showCheckboxes: "show-checkboxes",
};

/**
 * The settings a board's frontmatter may set: the ones `resolveKanbanSettings`
 * reads, whether through a site option or not.
 */
const SETTING_KEYS: ReadonlySet<string> = new Set([
	KANBAN_FRONTMATTER_KEY,
	...Object.values(OPTION_SETTING_KEYS),
	...BOARD_ONLY_SETTING_KEYS,
]);

const VIEWS: Record<string, KanbanView> = {
	board: "board",
	basic: "board",
	list: "list",
	table: "table",
};

const METADATA_POSITIONS: Record<string, KanbanInlineMetadataPosition> = {
	body: "body",
	footer: "footer",
	"metadata-table": "metadata-table",
};

/**
 * A board's own settings: its `%% kanban:settings %%` block, overridden by
 * the setting keys in its frontmatter — the order Kanban's parser applies.
 */
export function boardSettingsLayer(
	frontmatter: Record<string, unknown>,
	footer: KanbanSettingsLayer,
): KanbanSettingsLayer {
	const layer: KanbanSettingsLayer = { ...footer };
	for (const [key, value] of Object.entries(frontmatter)) {
		if (SETTING_KEYS.has(key)) layer[key] = value;
	}
	return layer;
}

/** The site's Kanban options, keyed as Kanban stores its settings. */
export function optionSettingsLayer(options: KanbanOptions): KanbanSettingsLayer {
	const layer: KanbanSettingsLayer = {};
	for (const [option, value] of Object.entries(options)) {
		const key = OPTION_SETTING_KEYS[option];
		if (key && value !== undefined) layer[key] = value;
	}
	return layer;
}

function isString(value: unknown): value is string {
	return typeof value === "string" && value !== "";
}

function isBoolean(value: unknown): value is boolean {
	return typeof value === "boolean";
}

function isNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isObjectArray(value: unknown): value is Record<string, unknown>[] {
	return Array.isArray(value) && value.every((entry) => entry && typeof entry === "object");
}

function metadataKey(entry: Record<string, unknown>): Required<KanbanMetadataKey> | undefined {
	if (!isString(entry.metadataKey)) return undefined;
	return {
		metadataKey: entry.metadataKey,
		label: isString(entry.label) ? entry.label : entry.metadataKey,
		shouldHideLabel: entry.shouldHideLabel === true,
		containsMarkdown: entry.containsMarkdown === true,
	};
}

/**
 * Resolve every setting from `layers`, most specific first. A value of the
 * wrong type is skipped, as if that layer did not set it.
 */
export function resolveKanbanSettings(
	layers: readonly KanbanSettingsLayer[],
	options: NormalizedPluginOptions,
): ResolvedKanbanSettings {
	function pick<T>(key: string, accept: (value: unknown) => value is T): T | undefined {
		for (const layer of layers) {
			const value = layer[key];
			if (accept(value)) return value;
		}
		return undefined;
	}
	const flag = (key: string): boolean | undefined => pick(key, isBoolean);

	const dateFormat =
		pick("date-format", isString) ??
		(options.enableDailyNotes ? options.dailyNotes.dateFormat : "YYYY-MM-DD");
	const timeFormat = pick("time-format", isString) ?? "HH:mm";
	const dateDisplayFormat = pick("date-display-format", isString) ?? dateFormat;
	const moveDates = flag("move-dates") ?? flag("hide-date-in-title") ?? false;
	const moveTags = flag("move-tags") ?? flag("hide-tags-in-title") ?? false;

	// Kanban adds a board's metadata keys to the global ones.
	const metadataKeys: Required<KanbanMetadataKey>[] = [];
	const seen = new Set<string>();
	const keyLists = layers
		.map((layer) => layer["metadata-keys"])
		.filter(isObjectArray)
		.reverse();
	for (const entry of keyLists.flat()) {
		const key = metadataKey(entry);
		if (!key || seen.has(key.metadataKey)) continue;
		seen.add(key.metadataKey);
		metadataKeys.push(key);
	}

	const laneWidth = pick("lane-width", isNumber);
	return {
		view: VIEWS[String(pick(KANBAN_FRONTMATTER_KEY, isString))] ?? "board",
		dateTrigger: pick("date-trigger", isString) ?? "@",
		timeTrigger: pick("time-trigger", isString) ?? "@@",
		dateFormat,
		timeFormat,
		dateDisplayFormat,
		dateTimeDisplayFormat: `${dateDisplayFormat} ${timeFormat}`,
		showRelativeDate: flag("show-relative-date") ?? false,
		linkDateToDailyNote: flag("link-date-to-daily-note") ?? false,
		moveDates,
		moveTags,
		showDateFooter: moveDates && flag("hide-date-display") !== true,
		showTagFooter: moveTags && flag("hide-tags-display") !== true,
		moveTaskMetadata: flag("move-task-metadata") ?? false,
		inlineMetadataPosition:
			METADATA_POSITIONS[String(pick("inline-metadata-position", isString))] ?? "body",
		metadataKeys,
		tagColors: (pick("tag-colors", isObjectArray) ?? []).filter(
			(entry): entry is Record<string, unknown> & KanbanTagColor => isString(entry.tagKey),
		),
		dateColors: pick("date-colors", isObjectArray) ?? [],
		...(laneWidth !== undefined && laneWidth > 0 && { laneWidth }),
		fullListLaneWidth: flag("full-list-lane-width") ?? false,
		maxArchiveSize: pick("max-archive-size", isNumber) ?? -1,
		hideCardCount: flag("hide-card-count") ?? false,
		showCheckboxes: flag("show-checkboxes") ?? false,
		listCollapse: (pick("list-collapse", Array.isArray) ?? []).map((entry) => entry === true),
	};
}
