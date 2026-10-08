/**
 * The values Bases formulas and filters compute with, and the operations every
 * type shares: truthiness, equality, ordering, arithmetic, and text.
 *
 * Primitives are JavaScript's own (`null`, booleans, numbers, strings, arrays
 * for lists). Everything else is a small class, so the evaluator dispatches on
 * `instanceof` and a property value can never be mistaken for a date or a link
 * because of the keys it happens to have.
 */
import { formatDailyNoteDate } from "../../daily-notes.js";
import {
	CASUAL_UNIT_MS,
	DAY_MS,
	type DurationGrammar,
	type DurationUnit,
	humanizeDuration,
	momentAdd,
	scanDuration,
	startOf,
} from "../../date-math.js";
import type { ContentAsset, ContentIndex, ContentPage } from "../../types.js";

/** A file of the dataset: a note (with properties) or any other published file. */
export interface BaseFile {
	absolutePath: string;
	/** Path from the root of the tree the file was found in, with its extension, `/`-separated. */
	path: string;
	name: string;
	basename: string;
	/** Extension without the dot, lowercased (`md`, `png`, `base`). */
	ext: string;
	/** Parent folder, `/` at the root, as Obsidian reports it. */
	folder: string;
	size: number;
	ctimeMs: number;
	mtimeMs: number;
	index: ContentIndex;
	page?: ContentPage;
	asset?: ContentAsset;
	/** Frontmatter properties, already converted to values. */
	properties: Record<string, Value>;
	/** Tags from the frontmatter and the body, without `#`. */
	tags: string[];
}

export class DateValue {
	constructor(
		readonly ms: number,
		/** `false` for a calendar date (`2024-05-01`), `true` for a datetime. */
		readonly hasTime: boolean,
	) {}
}

/**
 * A span of time. Months are kept apart from milliseconds because `"1M"` moves
 * a date to the same day of the next month, whatever that month's length.
 */
export class DurationValue {
	constructor(
		readonly months: number,
		readonly ms: number,
	) {}
}

export class LinkValue {
	constructor(
		/** The link target as written (`Projects/Alpha`, `https://…`). */
		readonly target: string,
		readonly display: string | undefined,
		/** The dataset file the link resolves to, when it resolves. */
		readonly file: BaseFile | undefined,
		/** The note the link was written in: where it resolves from and renders as. */
		readonly source: ContentPage | undefined,
	) {}
}

export class FileValue {
	constructor(
		readonly file: BaseFile,
		/** `this`: member access reaches the file's note properties (`this.status`). */
		readonly isThis = false,
	) {}
}

export class ObjectValue {
	constructor(readonly entries: Record<string, Value>) {}
}

export class RegexValue {
	constructor(readonly regex: RegExp) {}
}

/** Markup from `html()`, rendered as written. */
export class HtmlValue {
	constructor(readonly html: string) {}
}

/** `image(…)`: a path, a link, a file or a URL to show as a picture. */
export class ImageValue {
	constructor(readonly source: Value) {}
}

export class IconValue {
	constructor(readonly name: string) {}
}

/**
 * A formula that could not be evaluated; shown in the cell instead of a value.
 *
 * `"error"`: the base itself is wrong (a syntax error, an unknown function or
 * formula, a circular reference) whatever the notes hold, so it follows
 * `onPluginError`. `"warning"`: the formula is valid but this note's data does
 * not fit it (a method its value's type lacks, text `number()` cannot read),
 * which Obsidian shows as an empty cell, so it never fails the build.
 */
export class ErrorValue {
	constructor(
		readonly message: string,
		readonly severity: "error" | "warning" = "error",
	) {}
}

export type Value =
	| null
	| boolean
	| number
	| string
	| Value[]
	| DateValue
	| DurationValue
	| LinkValue
	| FileValue
	| ObjectValue
	| RegexValue
	| HtmlValue
	| ImageValue
	| IconValue
	| ErrorValue;

/** How dates show when no `format()` is applied. */
export interface DisplayFormats {
	dateFormat: string;
	dateTimeFormat: string;
}

/** The name `isType` accepts for a value. */
export function typeOf(value: Value): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "list";
	if (typeof value !== "object") return typeof value;
	if (value instanceof DateValue) return "date";
	if (value instanceof DurationValue) return "duration";
	if (value instanceof LinkValue) return "link";
	if (value instanceof FileValue) return "file";
	if (value instanceof ObjectValue) return "object";
	if (value instanceof RegexValue) return "regexp";
	if (value instanceof HtmlValue) return "html";
	if (value instanceof ImageValue) return "image";
	if (value instanceof IconValue) return "icon";
	return "error";
}

/** JavaScript truthiness, with an error value false. */
export function isTruthy(value: Value): boolean {
	if (value === null) return false;
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0 && !Number.isNaN(value);
	if (typeof value === "string") return value !== "";
	return !(value instanceof ErrorValue);
}

/** `isEmpty()`: nothing there, an empty string, list or object. */
export function isEmptyValue(value: Value): boolean {
	if (value === null || value === "") return true;
	if (Array.isArray(value)) return value.length === 0;
	if (value instanceof ObjectValue) return Object.keys(value.entries).length === 0;
	return false;
}

/** The file a link, file or `this` points at. */
export function fileOf(value: Value): BaseFile | undefined {
	if (value instanceof FileValue) return value.file;
	if (value instanceof LinkValue) return value.file;
	return undefined;
}

/** Text of a link target compared with a file's path: no brackets, alias or `.md`, any case. */
function linkKey(target: string): string {
	return target
		.replace(/^\[\[|\]\]$/g, "")
		.replace(/\|.*$/, "")
		.replace(/\.md$/i, "")
		.trim()
		.toLowerCase();
}

/**
 * `==`: same type and value; lists and objects element-wise. A link equals a
 * file or another link when both reach the same file (whatever their display
 * text or subpath), and two links that do not resolve are equal only when
 * their link text is identical, as Obsidian compares them.
 */
export function valuesEqual(left: Value, right: Value): boolean {
	if (left === right) return true;
	if (left === null || right === null) return false;
	const leftFile = fileOf(left);
	const rightFile = fileOf(right);
	if (leftFile || rightFile) {
		if (leftFile && rightFile) return leftFile === rightFile;
		const file = leftFile ?? rightFile;
		const text = typeof left === "string" ? left : typeof right === "string" ? right : undefined;
		if (!file || text === undefined) return false;
		const key = linkKey(text);
		return key === linkKey(file.path) || key === file.basename.toLowerCase();
	}
	if (left instanceof LinkValue && right instanceof LinkValue) {
		return left.target.trim() === right.target.trim();
	}
	if (left instanceof LinkValue || right instanceof LinkValue) {
		const link = (left instanceof LinkValue ? left : right) as LinkValue;
		const other = left instanceof LinkValue ? right : left;
		return typeof other === "string" && linkKey(other) === linkKey(link.target);
	}
	if (typeof left === "number" || typeof right === "number") {
		const number = typeof left === "number" ? left : right;
		const text = typeof left === "string" ? left : typeof right === "string" ? right : undefined;
		return text !== undefined && text.trim() !== "" && Number(text) === number;
	}
	if (left instanceof DateValue || right instanceof DateValue) {
		const a = asDate(left);
		const b = asDate(right);
		return a !== undefined && b !== undefined && a.ms === b.ms;
	}
	if (left instanceof DurationValue && right instanceof DurationValue) {
		return left.months === right.months && left.ms === right.ms;
	}
	if (Array.isArray(left) && Array.isArray(right)) {
		return (
			left.length === right.length && left.every((item, i) => valuesEqual(item, right[i] ?? null))
		);
	}
	if (left instanceof ObjectValue && right instanceof ObjectValue) {
		const keys = Object.keys(left.entries);
		return (
			keys.length === Object.keys(right.entries).length &&
			keys.every((key) => valuesEqual(left.entries[key] ?? null, right.entries[key] ?? null))
		);
	}
	if (left instanceof RegexValue && right instanceof RegexValue) {
		return left.regex.source === right.regex.source && left.regex.flags === right.regex.flags;
	}
	if (left instanceof IconValue && right instanceof IconValue) return left.name === right.name;
	return false;
}

/** A date, or a string that reads as one. */
export function asDate(value: Value): DateValue | undefined {
	if (value instanceof DateValue) return value;
	if (typeof value === "string") return parseDateText(value);
	return undefined;
}

const DATE_TEXT =
	/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * `YYYY-MM-DD`, optionally with ` HH:mm[:ss[.SSS]]` or the ISO `T` form, read
 * as local time unless it carries a zone — the way Obsidian reads a date
 * property.
 */
export function parseDateText(text: string): DateValue | undefined {
	const match = DATE_TEXT.exec(text.trim());
	if (!match) return undefined;
	const [, y, mo, d, h, mi, s, ms, zone] = match;
	const parts = [Number(y), Number(mo) - 1, Number(d), Number(h ?? 0), Number(mi ?? 0)] as const;
	const seconds = Number(s ?? 0);
	const millis = Number((ms ?? "0").padEnd(3, "0"));
	if (parts[1] > 11 || parts[2] < 1 || parts[2] > 31) return undefined;
	if (zone) {
		const utc = Date.UTC(...parts, seconds, millis);
		const offset =
			zone === "Z"
				? 0
				: (zone.startsWith("-") ? -1 : 1) *
					(Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2))) *
					60_000;
		return new DateValue(utc - offset, true);
	}
	const local = new Date(...parts, seconds, millis);
	if (local.getDate() !== parts[2]) return undefined;
	return new DateValue(local.getTime(), h !== undefined);
}

/** A date with its time of day dropped, in local time. */
export function startOfDay(ms: number): DateValue {
	return new DateValue(startOf(new Date(ms), "day").getTime(), false);
}

/** A duration's length in milliseconds, months counted as 30 days. */
export function durationMs(duration: DurationValue): number {
	return duration.months * 30 * DAY_MS + duration.ms;
}

/** `date + duration`: moment's `add` — months by the calendar (clamped to the month's end), the rest exactly. */
export function addDuration(date: DateValue, duration: DurationValue, sign: 1 | -1): DateValue {
	const moved = momentAdd(
		new Date(date.ms),
		{ months: duration.months, days: 0, milliseconds: duration.ms },
		sign,
	);
	return new DateValue(moved.getTime(), date.hasTime || duration.ms % DAY_MS !== 0);
}

const DURATION_UNITS: Record<string, DurationUnit> = {
	y: "years",
	year: "years",
	years: "years",
	M: "months",
	month: "months",
	months: "months",
	w: "weeks",
	week: "weeks",
	weeks: "weeks",
	d: "days",
	day: "days",
	days: "days",
	h: "hours",
	hour: "hours",
	hours: "hours",
	m: "minutes",
	minute: "minutes",
	minutes: "minutes",
	s: "seconds",
	second: "seconds",
	seconds: "seconds",
	ms: "milliseconds",
	millisecond: "milliseconds",
	milliseconds: "milliseconds",
};

const BASES_DURATION: DurationGrammar = {
	part: /([+-]?\d+(?:\.\d+)?)\s*([a-zA-Z]+)/y,
	separator: /[\s,]*/y,
	// One-letter units are case sensitive (`M` is a month, `m` a minute); words are not.
	unit: (spelling) => {
		const key = spelling.length === 1 ? spelling : spelling.toLowerCase();
		if (Object.hasOwn(DURATION_UNITS, key)) return DURATION_UNITS[key];
		return Object.hasOwn(DURATION_UNITS, spelling) ? DURATION_UNITS[spelling] : undefined;
	},
};

/** `"1 day"`, `"2w"`, `"1M 4h"`, `"-3 hours"`, separated by spaces or commas. */
export function parseDuration(text: string): DurationValue | undefined {
	const source = text.trim();
	const start = /^[\s,]*/.exec(source)?.[0].length ?? 0;
	const scanned = scanDuration(source, start, BASES_DURATION);
	if (!scanned || !/^[\s,]*$/.test(source.slice(scanned.end))) return undefined;
	const { years = 0, months = 0 } = scanned.parts;
	let ms = 0;
	for (const unit of ["weeks", "days", "hours", "minutes", "seconds", "milliseconds"] as const) {
		ms += (scanned.parts[unit] ?? 0) * CASUAL_UNIT_MS[unit];
	}
	return new DurationValue(years * 12 + months, ms);
}

/**
 * A span as moment.js's `duration.humanize()` words it, the way Obsidian shows
 * a duration: the largest unit, rounded, with moment's thresholds ("a minute"
 * from 45 seconds, "a day" from 22 hours, "a month" from 26 days, …).
 */
export function humanizeSpan(months: number, ms: number): string {
	return humanizeDuration({ months, days: 0, milliseconds: ms });
}

export function plural(count: number, unit: string): string {
	return `${count} ${unit}${Math.abs(count) === 1 ? "" : "s"}`;
}

/** A date as the view shows it by default. */
export function formatDate(date: DateValue, formats: DisplayFormats): string {
	return formatDailyNoteDate(
		new Date(date.ms),
		date.hasTime ? formats.dateTimeFormat : formats.dateFormat,
	);
}

/** Whether a link points outside the vault (`https://…`, `mailto:…`). */
export function isExternalLink(link: LinkValue): boolean {
	return !link.file && /^[a-z][a-z\d+.-]*:/i.test(link.target);
}

/** What a link shows: its display text, else its file's name, else the last segment of its target. */
export function linkLabel(link: LinkValue): string {
	return link.display ?? link.file?.basename ?? link.target.split("/").pop() ?? link.target;
}

/**
 * `toString()`: the text of any value, in the forms Obsidian's runtime gives
 * (`[[path|display]]` for a link, `![](src)` for an image, "a day" for a
 * duration, the path of a file).
 */
export function valueToString(value: Value, formats: DisplayFormats): string {
	if (value === null) return "";
	if (typeof value === "string") return value;
	if (typeof value !== "object") return String(value);
	if (Array.isArray(value)) return value.map((item) => valueToString(item, formats)).join(", ");
	if (value instanceof DateValue) return formatDate(value, formats);
	if (value instanceof DurationValue) return humanizeSpan(value.months, value.ms);
	if (value instanceof LinkValue) {
		if (isExternalLink(value)) return value.target;
		return value.display === undefined
			? `[[${value.target}]]`
			: `[[${value.target}|${value.display}]]`;
	}
	if (value instanceof FileValue) return value.file.path;
	if (value instanceof ObjectValue) {
		return `{${Object.entries(value.entries)
			.map(([key, entry]) => `${key}: ${valueToString(entry, formats)}`)
			.join(", ")}}`;
	}
	if (value instanceof RegexValue) return String(value.regex);
	if (value instanceof HtmlValue) return value.html;
	if (value instanceof ImageValue) {
		const source = value.source;
		const src =
			source instanceof LinkValue
				? source.target
				: source instanceof FileValue
					? source.file.path
					: valueToString(source, formats);
		return `![](${src})`;
	}
	if (value instanceof IconValue) return value.name;
	return value.message;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Order two values for `<`, sorting, `min`/`max`: numbers, dates, durations,
 * booleans and text each among their own kind; `undefined` when the two
 * cannot be ordered (a list against a number).
 */
export function compareValues(left: Value, right: Value): number | undefined {
	if (typeof left === "number" && typeof right === "number") return left - right;
	if (left instanceof DateValue || right instanceof DateValue) {
		const a = asDate(left);
		const b = asDate(right);
		return a && b ? a.ms - b.ms : undefined;
	}
	const leftSpan = spanMs(left);
	const rightSpan = spanMs(right);
	if (leftSpan !== undefined && rightSpan !== undefined) return leftSpan - rightSpan;
	if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
	if (typeof left === "number" && typeof right === "string" && right.trim() !== "") {
		const parsed = Number(right);
		return Number.isNaN(parsed) ? undefined : left - parsed;
	}
	if (typeof left === "string" && typeof right === "number" && left.trim() !== "") {
		const parsed = Number(left);
		return Number.isNaN(parsed) ? undefined : parsed - right;
	}
	const textual = [left, right].every(
		(value) =>
			typeof value === "string" ||
			value instanceof LinkValue ||
			value instanceof FileValue ||
			Array.isArray(value),
	);
	if (textual) {
		// Links and files order by the name they show, not by `[[…]]` text.
		const sortText = (value: Value): string =>
			value instanceof LinkValue
				? linkLabel(value)
				: value instanceof FileValue
					? value.file.basename
					: valueToString(value, ISO_FORMATS);
		return collator.compare(sortText(left), sortText(right));
	}
	return undefined;
}

/**
 * How a formula turns a value into text (`toString()`, `+`, `join`): dates in
 * ISO form, as Obsidian's runtime writes them. A view's own display of a date
 * uses the site's `dateFormat` options instead.
 */
export const ISO_FORMATS: DisplayFormats = {
	dateFormat: "YYYY-MM-DD",
	dateTimeFormat: "YYYY-MM-DDTHH:mm:ss",
};

/** A number or a duration, as milliseconds for a duration. */
function spanMs(value: Value): number | undefined {
	if (value instanceof DurationValue) return durationMs(value);
	if (typeof value === "number") return value;
	return undefined;
}

/** A key that is equal for equal values, for grouping and `unique`. */
export function valueKey(value: Value): string {
	const file = fileOf(value);
	if (file) return `file:${file.absolutePath}`;
	if (value instanceof LinkValue) return `link:${linkKey(value.target)}`;
	if (value instanceof DateValue) return `date:${value.ms}`;
	if (Array.isArray(value)) return `list:[${value.map(valueKey).join(",")}]`;
	if (value === null) return "null";
	return `${typeOf(value)}:${valueToString(value, ISO_FORMATS)}`;
}
