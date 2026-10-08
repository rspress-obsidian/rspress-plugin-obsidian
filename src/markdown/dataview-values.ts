/**
 * Dataview's value model: links, durations, dates and the type, ordering,
 * truthiness and string rules every query, inline expression and DataviewJS
 * script shares. Mirrors `data-model/value.ts`, `expression/binaryop.ts` and
 * `util/normalize.ts` of blacksmithgu/obsidian-dataview.
 *
 * Time model: one zone for everything — the local zone of the build. Parsing a
 * date literal, reading `.hour`, deriving `file.cday`, `sow`/`eom` shorthands
 * and rendering all use the local wall clock, exactly as Dataview (Luxon
 * `DateTime.local()`) does inside Obsidian. Set `TZ` for the build to pick it.
 */
import {
	CASUAL_UNIT_MS,
	DURATION_UNITS,
	type DurationGrammar,
	type DurationParts,
	type DurationUnit,
	dayOfYear,
	daysInMonth,
	endOf,
	isoWeek,
	localDate,
	luxonDiff,
	luxonPlus,
	scanDuration,
	startOf,
} from "./date-math.js";

/** An Obsidian link to a file, heading or block (`Link` in Dataview). */
export class DataviewLink {
	constructor(
		/** The target as written (or a file path for links built from pages). */
		readonly path: string,
		readonly type: "file" | "header" | "block" = "file",
		readonly subpath?: string,
		readonly display?: string,
		readonly embed = false,
	) {}

	/** Parse the inside of `[[…]]`: `path#heading|display`, `path#^block`. */
	static parseInner(inner: string, embed = false): DataviewLink {
		const pipe = findUnescapedPipe(inner);
		const target = (pipe >= 0 ? inner.slice(0, pipe) : inner).replace(/\\\|/g, "|");
		const display = pipe >= 0 ? inner.slice(pipe + 1) : undefined;
		const blockAt = target.indexOf("#^");
		if (blockAt >= 0) {
			return new DataviewLink(
				target.slice(0, blockAt),
				"block",
				target.slice(blockAt + 2),
				display,
				embed,
			);
		}
		const headerAt = target.indexOf("#");
		if (headerAt >= 0) {
			return new DataviewLink(
				target.slice(0, headerAt),
				"header",
				target.slice(headerAt + 1),
				display,
				embed,
			);
		}
		return new DataviewLink(target, "file", undefined, display, embed);
	}

	withDisplay(display?: string): DataviewLink {
		return new DataviewLink(this.path, this.type, this.subpath, display, this.embed);
	}

	withEmbed(embed: boolean): DataviewLink {
		return embed === this.embed
			? this
			: new DataviewLink(this.path, this.type, this.subpath, this.display, embed);
	}

	/** `[[path#sub|display]]`, the form Dataview concatenates and joins. */
	markdown(): string {
		const target =
			this.type === "header"
				? `${this.path}#${this.subpath ?? ""}`
				: this.type === "block"
					? `${this.path}#^${this.subpath ?? ""}`
					: this.path;
		return `${this.embed ? "!" : ""}[[${target.replace(/\|/g, "\\|")}|${this.label()}]]`;
	}

	/** What Obsidian shows for the link: the display text, else the file title (› subpath). */
	label(): string {
		if (this.display) return this.display;
		const title = fileTitle(this.path);
		return this.subpath && this.type !== "file" ? `${title} > ${this.subpath}` : title;
	}
}

function findUnescapedPipe(value: string): number {
	for (let index = 0; index < value.length; index += 1) {
		if (value[index] === "|" && value[index - 1] !== "\\") return index;
	}
	return -1;
}

/** `notes/Alpha.md` → `Alpha`, the name Dataview labels file links with. */
export function fileTitle(filePath: string): string {
	const name = filePath.includes("/") ? filePath.slice(filePath.lastIndexOf("/") + 1) : filePath;
	return name.replace(/\.(md|mdx)$/i, "");
}

/** A Luxon-style duration: calendar units kept apart from clock units. */
export class DataviewDuration {
	readonly years: number;
	readonly months: number;
	readonly weeks: number;
	readonly days: number;
	readonly hours: number;
	readonly minutes: number;
	readonly seconds: number;
	readonly milliseconds: number;

	constructor(parts: DurationParts) {
		this.years = parts.years ?? 0;
		this.months = parts.months ?? 0;
		this.weeks = parts.weeks ?? 0;
		this.days = parts.days ?? 0;
		this.hours = parts.hours ?? 0;
		this.minutes = parts.minutes ?? 0;
		this.seconds = parts.seconds ?? 0;
		this.milliseconds = parts.milliseconds ?? 0;
	}

	toMillis(): number {
		let total = 0;
		for (const unit of DURATION_UNITS) total += this[unit] * CASUAL_UNIT_MS[unit];
		return total;
	}

	/** The whole duration in one unit (`shiftTo(unit)` in Luxon). */
	as(unit: DurationUnit): number {
		return this.toMillis() / CASUAL_UNIT_MS[unit];
	}

	map(transform: (value: number) => number): DataviewDuration {
		const parts: DurationParts = {};
		for (const unit of DURATION_UNITS) parts[unit] = transform(this[unit]);
		return new DataviewDuration(parts);
	}

	plus(other: DataviewDuration, sign = 1): DataviewDuration {
		const parts: DurationParts = {};
		for (const unit of DURATION_UNITS) parts[unit] = this[unit] + sign * other[unit];
		return new DataviewDuration(parts);
	}

	/**
	 * Roll clock units up (ms → s → min → h → days → weeks) and months into
	 * years. Days are never folded into months: a month has no fixed length,
	 * so `dur(45 days)` stays "6 weeks, 3 days" instead of guessing.
	 */
	normalize(): DataviewDuration {
		const sign = this.toMillis() < 0 ? -1 : 1;
		let clock =
			sign *
			(this.weeks * CASUAL_UNIT_MS.weeks +
				this.days * CASUAL_UNIT_MS.days +
				this.hours * CASUAL_UNIT_MS.hours +
				this.minutes * CASUAL_UNIT_MS.minutes +
				this.seconds * CASUAL_UNIT_MS.seconds +
				this.milliseconds);
		const parts: DurationParts = {};
		for (const unit of ["weeks", "days", "hours", "minutes", "seconds"] as const) {
			const whole = Math.floor(clock / CASUAL_UNIT_MS[unit] + 1e-9);
			parts[unit] = sign * whole;
			clock -= whole * CASUAL_UNIT_MS[unit];
		}
		parts.milliseconds = sign * Math.round(clock);
		const totalMonths = sign * (this.years * 12 + this.months);
		parts.years = sign * Math.floor(totalMonths / 12 + 1e-9);
		parts.months = sign * (totalMonths - Math.floor(totalMonths / 12 + 1e-9) * 12);
		return new DataviewDuration(parts);
	}

	/** Luxon's `toHuman()` over the non-zero units: "1 day, 2 hours". */
	toHuman(): string {
		const normalized = this.normalize();
		const parts: string[] = [];
		for (const unit of DURATION_UNITS) {
			const value = normalized[unit];
			if (value === 0) continue;
			const singular = unit.slice(0, -1);
			parts.push(`${value} ${Math.abs(value) === 1 ? singular : unit}`);
		}
		return parts.length > 0 ? parts.join(", ") : "0 milliseconds";
	}
}

/** Rows of `LIST <expr>`: `key: value`. */
export class DataviewListPair {
	constructor(
		readonly key: unknown,
		readonly value: unknown,
	) {}
}

/** `elink(url, display)`: an external link. */
export class DataviewExternalLink {
	constructor(
		readonly url: string,
		readonly display?: string,
	) {}
}

/** A DQL lambda `(x) => expr`, or a DataviewJS arrow function. */
export class DataviewFunction {
	constructor(readonly invoke: (args: unknown[]) => unknown) {}
}

export type DataviewType =
	| "null"
	| "number"
	| "string"
	| "boolean"
	| "date"
	| "duration"
	| "link"
	| "array"
	| "object"
	| "function"
	| "widget";

export function typeOf(value: unknown): DataviewType {
	if (value === null || value === undefined) return "null";
	if (typeof value === "number") return "number";
	if (typeof value === "string") return "string";
	if (typeof value === "boolean") return "boolean";
	if (value instanceof Date) return "date";
	if (value instanceof DataviewDuration) return "duration";
	if (value instanceof DataviewLink) return "link";
	if (Array.isArray(value)) return "array";
	if (value instanceof DataviewFunction || typeof value === "function") return "function";
	if (value instanceof DataviewListPair || value instanceof DataviewExternalLink) return "widget";
	return "object";
}

/** Dataview truthiness: non-zero numbers, non-empty strings/lists/objects, real links. */
export function isTruthy(value: unknown): boolean {
	switch (typeOf(value)) {
		case "null":
			return false;
		case "number":
			return value !== 0 && !Number.isNaN(value);
		case "string":
			return (value as string).length > 0;
		case "boolean":
			return value as boolean;
		case "date":
			return (value as Date).getTime() !== 0;
		case "duration":
			return (value as DataviewDuration).toMillis() !== 0;
		case "link":
			return Boolean((value as DataviewLink).path);
		case "array":
			return (value as unknown[]).length > 0;
		case "object":
			return Object.keys(value as object).length > 0;
		default:
			return true;
	}
}

/**
 * Dataview's total order over values. Values of different types order by type
 * name, so `"2" = 2` is false and strings compare case-sensitively — exactly
 * what `WHERE` and `SORT` do in Obsidian. Links compare by their resolved file
 * path (`normalizeLink`), then link type, then subpath.
 */
export function compareValues(
	left: unknown,
	right: unknown,
	normalizeLink: (link: DataviewLink) => string = (link) => link.path,
): number {
	const leftType = typeOf(left);
	const rightType = typeOf(right);
	if (leftType === "null" && rightType === "null") return 0;
	if (leftType === "null") return -1;
	if (rightType === "null") return 1;
	if (leftType !== rightType) return leftType.localeCompare(rightType);
	if (left === right) return 0;
	switch (leftType) {
		case "string":
			return (left as string).localeCompare(right as string);
		case "number":
			return (left as number) < (right as number) ? -1 : left === right ? 0 : 1;
		case "boolean":
			return left === right ? 0 : left ? 1 : -1;
		case "date":
			return Math.sign((left as Date).getTime() - (right as Date).getTime());
		case "duration":
			return Math.sign(
				(left as DataviewDuration).toMillis() - (right as DataviewDuration).toMillis(),
			);
		case "link": {
			const a = left as DataviewLink;
			const b = right as DataviewLink;
			const byPath = normalizeLink(a).localeCompare(normalizeLink(b));
			if (byPath !== 0) return byPath;
			const byType = a.type.localeCompare(b.type);
			if (byType !== 0) return byType;
			if (a.subpath && !b.subpath) return 1;
			if (!a.subpath && b.subpath) return -1;
			return (a.subpath ?? "").localeCompare(b.subpath ?? "");
		}
		case "array": {
			const a = left as unknown[];
			const b = right as unknown[];
			for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
				const comparison = compareValues(a[index], b[index], normalizeLink);
				if (comparison !== 0) return comparison;
			}
			return a.length - b.length;
		}
		case "object": {
			const a = left as Record<string, unknown>;
			const b = right as Record<string, unknown>;
			const leftKeys = Object.keys(a).sort();
			const rightKeys = Object.keys(b).sort();
			const byKeys = compareValues(leftKeys, rightKeys);
			if (byKeys !== 0) return byKeys;
			for (const key of leftKeys) {
				const comparison = compareValues(a[key], b[key], normalizeLink);
				if (comparison !== 0) return comparison;
			}
			return 0;
		}
		default:
			return 0;
	}
}

/** Formats used to render dates (Dataview's `defaultDateFormat` and `defaultDateTimeFormat`). */
export interface DataviewDateFormats {
	date: string;
	dateTime: string;
}

export const DEFAULT_DATE_FORMATS: DataviewDateFormats = {
	date: "MMMM dd, yyyy",
	dateTime: "h:mm a - MMMM dd, yyyy",
};

/** What a null value renders as (Dataview's `renderNullAs`). */
export const NULL_DISPLAY = "-";

/** Dataview's "minimal" date: date-only at local midnight, else date and time. */
export function renderDate(date: Date, formats: DataviewDateFormats): string {
	const midnight =
		date.getHours() === 0 &&
		date.getMinutes() === 0 &&
		date.getSeconds() === 0 &&
		date.getMilliseconds() === 0;
	return formatLuxonDate(date, midnight ? formats.date : formats.dateTime);
}

/** `Values.toString`: the text a value contributes to `+`, `join` and `string()`. */
export function valueToString(
	value: unknown,
	formats: DataviewDateFormats = DEFAULT_DATE_FORMATS,
	nested = false,
): string {
	switch (typeOf(value)) {
		case "null":
			return NULL_DISPLAY;
		case "string":
			return value as string;
		case "number":
			return String(value);
		case "boolean":
			return String(value);
		case "date":
			return renderDate(value as Date, formats);
		case "duration":
			return (value as DataviewDuration).toHuman();
		case "link":
			return (value as DataviewLink).markdown();
		case "function":
			return "<function>";
		case "widget":
			if (value instanceof DataviewListPair) {
				return `${valueToString(value.key, formats)}: ${valueToString(value.value, formats)}`;
			}
			if (value instanceof DataviewExternalLink) {
				return `[${value.display ?? value.url}](${value.url})`;
			}
			return "";
		case "array": {
			const inner = (value as unknown[]).map((item) => valueToString(item, formats, true));
			return nested ? `[${inner.join(", ")}]` : inner.join(", ");
		}
		default:
			return `{ ${Object.entries(value as Record<string, unknown>)
				.map(([key, item]) => `${key}: ${valueToString(item, formats, true)}`)
				.join(", ")} }`;
	}
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const DATE_PATTERN =
	/^(\d{4})-(\d{2})(?:-(\d{2})(?:T(\d{2})(?::(\d{2})(?::(\d{2})(?:\.(\d{3}))?(Z|[+-]\d{1,2}(?::\d{2})?|\[[0-9A-Za-z+\-/_]+\])?)?)?)?)?$/;

/**
 * Dataview's date literal: `YYYY-MM[-DD[THH[:mm[:ss[.SSS][zone]]]]]`, read in
 * the local zone unless a `Z`, `±HH:mm` or `[Area/City]` zone is written.
 */
export function parseDateLiteral(text: string): Date | null {
	const match = DATE_PATTERN.exec(text);
	if (!match) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = match[3] ? Number(match[3]) : 1;
	const hour = match[4] ? Number(match[4]) : 0;
	const minute = match[5] ? Number(match[5]) : 0;
	const second = match[6] ? Number(match[6]) : 0;
	const millisecond = match[7] ? Number(match[7]) : 0;
	if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month - 1)) return null;
	if (hour > 23 || minute > 59 || second > 59) return null;
	const zone = match[8];
	if (!zone) return localDate(year, month - 1, day, hour, minute, second, millisecond);
	const wall = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
	const utcWall = new Date(wall);
	utcWall.setUTCFullYear(year);
	if (zone === "Z") return utcWall;
	if (zone.startsWith("[")) {
		const offset = zoneOffsetMillis(zone.slice(1, -1), utcWall.getTime());
		if (offset === undefined) return null;
		const first = utcWall.getTime() - offset;
		const corrected = zoneOffsetMillis(zone.slice(1, -1), first) ?? offset;
		return new Date(utcWall.getTime() - corrected);
	}
	const [hours, minutes] = zone.slice(1).split(":");
	const offset = (Number(hours) * 60 + Number(minutes ?? 0)) * 60_000;
	return new Date(utcWall.getTime() - (zone.startsWith("-") ? -offset : offset));
}

/** Offset of an IANA zone from UTC at an instant, or `undefined` for an unknown zone. */
function zoneOffsetMillis(zone: string, instant: number): number | undefined {
	try {
		const parts = new Intl.DateTimeFormat("en-US", {
			timeZone: zone,
			hourCycle: "h23",
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "numeric",
			minute: "numeric",
			second: "numeric",
		}).formatToParts(new Date(instant));
		const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
		const asUtc = Date.UTC(
			read("year"),
			read("month") - 1,
			read("day"),
			read("hour"),
			read("minute"),
			read("second"),
		);
		return asUtc - (instant - (instant % 1000));
	} catch {
		return undefined;
	}
}

// `dataview.ts` and the DQL/DataviewJS evaluators read these through this module.
export { daysInMonth, isoWeek };

/** The date at local midnight. */
export function startOfDay(date: Date): Date {
	return startOf(date, "day");
}

/** `date(today)`, `date(sow)`, … — relative to the build's clock. */
export function dateShorthand(name: string, now: Date = new Date()): Date | null {
	switch (name) {
		case "now":
			return now;
		case "today":
			return startOfDay(now);
		case "yesterday":
			return addDuration(startOfDay(now), new DataviewDuration({ days: 1 }), -1);
		case "tomorrow":
			return addDuration(startOfDay(now), new DataviewDuration({ days: 1 }), 1);
		case "sow":
		case "start-of-week":
			return startOf(now, "isoWeek");
		case "eow":
		case "end-of-week":
			return endOf(now, "isoWeek");
		case "som":
		case "start-of-month":
			return startOf(now, "month");
		case "eom":
		case "end-of-month":
			return endOf(now, "month");
		case "soy":
		case "start-of-year":
			return startOf(now, "year");
		case "eoy":
		case "end-of-year":
			return endOf(now, "year");
		default:
			return null;
	}
}

export const DATE_SHORTHAND_NAMES = [
	"start-of-month",
	"start-of-week",
	"start-of-year",
	"end-of-month",
	"end-of-week",
	"end-of-year",
	"yesterday",
	"tomorrow",
	"today",
	"now",
	"sow",
	"eow",
	"som",
	"eom",
	"soy",
	"eoy",
];

/** `date(...)` string argument: a date literal or a shorthand. */
export function parseDatePlus(text: string): Date | null {
	const trimmed = text.trim();
	return dateShorthand(trimmed) ?? parseDateLiteral(trimmed);
}

/**
 * Luxon's `plus`: calendar units (years, months) clamp the day of month,
 * weeks and days move by calendar days in the local zone (so a DST change
 * keeps the wall time), clock units and every fraction move by exact time.
 */
export function addDuration(date: Date, duration: DataviewDuration, sign = 1): Date {
	return luxonPlus(date, duration, sign);
}

/** `date - date`: a calendar-aware duration, like Luxon's `diff` over all units. */
export function diffDates(left: Date, right: Date): DataviewDuration {
	if (left.getTime() < right.getTime()) return diffDates(right, left).map((value) => -value);
	const { months, days, milliseconds } = luxonDiff(left, right);
	return new DataviewDuration({
		years: Math.floor(months / 12),
		months: months % 12,
		days,
		milliseconds,
	}).normalize();
}

/** Luxon's weekday: 1 (Monday) through 7 (Sunday). */
export function luxonWeekday(date: Date): number {
	const day = date.getDay();
	return day === 0 ? 7 : day;
}

export const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];
export const WEEKDAY_NAMES = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
];

function offsetString(date: Date, style: "narrow" | "short" | "techie"): string {
	const offset = -date.getTimezoneOffset();
	const sign = offset < 0 ? "-" : "+";
	const hours = Math.floor(Math.abs(offset) / 60);
	const minutes = Math.abs(offset) % 60;
	if (style === "narrow") return minutes ? `${sign}${hours}:${pad(minutes)}` : `${sign}${hours}`;
	if (style === "short") return `${sign}${pad(hours)}:${pad(minutes)}`;
	return `${sign}${pad(hours)}${pad(minutes)}`;
}

function pad(value: number, length = 2): string {
	const text = String(Math.abs(value)).padStart(length, "0");
	return value < 0 ? `-${text}` : text;
}

/** Split a Luxon format into runs of one character and `'quoted'` literals. */
function luxonTokens(format: string): Array<{ literal: boolean; value: string }> {
	const tokens: Array<{ literal: boolean; value: string }> = [];
	let current = "";
	let currentChar: string | undefined;
	let quoted = false;
	const flush = () => {
		if (current.length > 0)
			tokens.push({ literal: quoted || /^\s+$/.test(current), value: current });
		current = "";
	};
	for (const char of format) {
		if (char === "'") {
			flush();
			currentChar = undefined;
			quoted = !quoted;
			continue;
		}
		if (quoted) {
			current += char;
		} else if (char === currentChar) {
			current += char;
		} else {
			flush();
			current = char;
			currentChar = char;
		}
	}
	flush();
	return tokens;
}

/**
 * Luxon's `toFormat` (en-US) in the local zone. `'quoted'` text is copied
 * verbatim and an unknown run of letters is written as itself, as Luxon does.
 */
export function formatLuxonDate(date: Date, format: string): string {
	let output = "";
	for (const token of luxonTokens(format)) {
		output += token.literal ? token.value : luxonToken(date, token.value);
	}
	return output;
}

function luxonToken(date: Date, token: string): string {
	const hour = date.getHours();
	const month = date.getMonth();
	const weekday = date.getDay();
	switch (token) {
		case "S":
			return String(date.getMilliseconds());
		case "SSS":
			return pad(date.getMilliseconds(), 3);
		case "s":
			return String(date.getSeconds());
		case "ss":
			return pad(date.getSeconds());
		case "m":
			return String(date.getMinutes());
		case "mm":
			return pad(date.getMinutes());
		case "h":
			return String(hour % 12 || 12);
		case "hh":
			return pad(hour % 12 || 12);
		case "H":
			return String(hour);
		case "HH":
			return pad(hour);
		case "Z":
			return offsetString(date, "narrow");
		case "ZZ":
			return offsetString(date, "short");
		case "ZZZ":
			return offsetString(date, "techie");
		case "z":
			return Intl.DateTimeFormat().resolvedOptions().timeZone;
		case "a":
			return hour < 12 ? "AM" : "PM";
		case "d":
			return String(date.getDate());
		case "dd":
			return pad(date.getDate());
		case "c":
		case "E":
			return String(luxonWeekday(date));
		case "ccc":
		case "EEE":
			return (WEEKDAY_NAMES[weekday] ?? "").slice(0, 3);
		case "cccc":
		case "EEEE":
			return WEEKDAY_NAMES[weekday] ?? "";
		case "ccccc":
		case "EEEEE":
			return (WEEKDAY_NAMES[weekday] ?? "").slice(0, 1);
		case "L":
		case "M":
			return String(month + 1);
		case "LL":
		case "MM":
			return pad(month + 1);
		case "LLL":
		case "MMM":
			return (MONTH_NAMES[month] ?? "").slice(0, 3);
		case "LLLL":
		case "MMMM":
			return MONTH_NAMES[month] ?? "";
		case "LLLLL":
		case "MMMMM":
			return (MONTH_NAMES[month] ?? "").slice(0, 1);
		case "y":
			return String(date.getFullYear());
		case "yy":
			return pad(date.getFullYear() % 100);
		case "yyyy":
			return pad(date.getFullYear(), 4);
		case "yyyyyy":
			return pad(date.getFullYear(), 6);
		case "G":
			return date.getFullYear() > 0 ? "AD" : "BC";
		case "GG":
			return date.getFullYear() > 0 ? "Anno Domini" : "Before Christ";
		case "kk":
			return pad(isoWeek(date).year % 100);
		case "kkkk":
			return pad(isoWeek(date).year, 4);
		case "W":
			return String(isoWeek(date).week);
		case "WW":
			return pad(isoWeek(date).week);
		case "o":
			return String(dayOfYear(date));
		case "ooo":
			return pad(dayOfYear(date), 3);
		case "q":
			return String(Math.floor(month / 3) + 1);
		case "qq":
			return pad(Math.floor(month / 3) + 1);
		case "X":
			return String(Math.floor(date.getTime() / 1000));
		case "x":
			return String(date.getTime());
		case "D":
			return `${month + 1}/${date.getDate()}/${date.getFullYear()}`;
		case "DD":
			return `${(MONTH_NAMES[month] ?? "").slice(0, 3)} ${date.getDate()}, ${date.getFullYear()}`;
		case "DDD":
			return `${MONTH_NAMES[month]} ${date.getDate()}, ${date.getFullYear()}`;
		case "DDDD":
			return `${WEEKDAY_NAMES[weekday]}, ${MONTH_NAMES[month]} ${date.getDate()}, ${date.getFullYear()}`;
		case "t":
			return `${hour % 12 || 12}:${pad(date.getMinutes())} ${hour < 12 ? "AM" : "PM"}`;
		case "tt":
			return `${hour % 12 || 12}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${hour < 12 ? "AM" : "PM"}`;
		case "T":
			return `${pad(hour)}:${pad(date.getMinutes())}`;
		case "TT":
			return `${pad(hour)}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
		case "f":
			return `${luxonToken(date, "D")}, ${luxonToken(date, "t")}`;
		case "ff":
			return `${luxonToken(date, "DD")}, ${luxonToken(date, "t")}`;
		case "fff":
			return `${luxonToken(date, "DDD")} at ${luxonToken(date, "t")}`;
		default:
			return token;
	}
}

/**
 * Luxon's `DateTime.fromFormat` for the numeric and name tokens people write in
 * `date(text, format)`. Returns `null` when the text does not match.
 */
export function parseWithLuxonFormat(text: string, format: string): Date | null {
	let pattern = "";
	const fields: string[] = [];
	for (const token of luxonTokens(format)) {
		if (token.literal) {
			pattern += escapeRegExp(token.value);
			continue;
		}
		const capture = luxonParseCapture(token.value);
		if (capture) {
			pattern += `(${capture})`;
			fields.push(token.value);
		} else {
			pattern += escapeRegExp(token.value);
		}
	}
	const match = new RegExp(`^${pattern}$`, "i").exec(text.trim());
	if (!match) return null;
	let year = new Date().getFullYear();
	let month = 1;
	let day = 1;
	let hour = 0;
	let minute = 0;
	let second = 0;
	let millisecond = 0;
	let meridiem: string | undefined;
	fields.forEach((field, position) => {
		const value = match[position + 1] ?? "";
		const number = Number(value);
		if (/^y+$/.test(field)) year = field === "yy" ? 2000 + number : number;
		else if (/^[LM]{1,2}$/.test(field)) month = number;
		else if (/^[LM]{3,4}$/.test(field)) {
			month =
				MONTH_NAMES.findIndex((name) => name.toLowerCase().startsWith(value.toLowerCase())) + 1;
		} else if (field === "d" || field === "dd") day = number;
		else if (/^[Hh]{1,2}$/.test(field)) hour = number;
		else if (field === "m" || field === "mm") minute = number;
		else if (field === "s" || field === "ss") second = number;
		else if (field === "S" || field === "SSS") millisecond = number;
		else if (field === "a") meridiem = value.toUpperCase();
	});
	if (meridiem === "PM" && hour < 12) hour += 12;
	if (meridiem === "AM" && hour === 12) hour = 0;
	if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month - 1)) return null;
	return new Date(year, month - 1, day, hour, minute, second, millisecond);
}

function luxonParseCapture(token: string): string | undefined {
	if (token === "yyyy" || token === "y") return "\\d{4}";
	if (token === "yy") return "\\d{2}";
	if (token === "MM" || token === "LL" || token === "dd" || token === "HH" || token === "hh")
		return "\\d{2}";
	if (token === "mm" || token === "ss") return "\\d{2}";
	if (["M", "L", "d", "H", "h", "m", "s"].includes(token)) return "\\d{1,2}";
	if (token === "SSS") return "\\d{3}";
	if (token === "S") return "\\d{1,3}";
	if (token === "MMMM" || token === "LLLL") return MONTH_NAMES.join("|");
	if (token === "MMM" || token === "LLL")
		return MONTH_NAMES.map((name) => name.slice(0, 3)).join("|");
	if (token === "EEEE" || token === "cccc") return WEEKDAY_NAMES.join("|");
	if (token === "EEE" || token === "ccc")
		return WEEKDAY_NAMES.map((name) => name.slice(0, 3)).join("|");
	if (token === "a") return "AM|PM";
	return undefined;
}

export function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

const DURATION_UNIT_NAMES: Record<string, DurationUnit> = {
	year: "years",
	years: "years",
	yr: "years",
	yrs: "years",
	month: "months",
	months: "months",
	mo: "months",
	mos: "months",
	week: "weeks",
	weeks: "weeks",
	wk: "weeks",
	wks: "weeks",
	w: "weeks",
	day: "days",
	days: "days",
	d: "days",
	hour: "hours",
	hours: "hours",
	hr: "hours",
	hrs: "hours",
	h: "hours",
	minute: "minutes",
	minutes: "minutes",
	min: "minutes",
	mins: "minutes",
	m: "minutes",
	second: "seconds",
	seconds: "seconds",
	sec: "seconds",
	secs: "seconds",
	s: "seconds",
};

const DURATION_UNIT_ALTERNATION = Object.keys(DURATION_UNIT_NAMES)
	.sort((left, right) => right.length - left.length)
	.join("|");
const DATAVIEW_DURATION: DurationGrammar = {
	part: new RegExp(`(-?\\d+(?:\\.\\d+)?)\\s*(${DURATION_UNIT_ALTERNATION})`, "y"),
	separator: /\s*,\s*|\s*/y,
	unit: (spelling) => DURATION_UNIT_NAMES[spelling.toLowerCase()],
};

/**
 * Dataview's duration syntax: one or more `<number> <unit>` parts separated by
 * commas or whitespace (`1 day`, `2h30m`, `1 year, 2 months`). The whole text
 * must be a duration, else `null`.
 */
export function parseDuration(text: string): DataviewDuration | null {
	const source = text.trim();
	const scanned = scanDuration(source, 0, DATAVIEW_DURATION);
	return scanned?.end === source.length ? new DataviewDuration(scanned.parts) : null;
}

/** The longest prefix of `source` (from `start`) that is a duration, for the DQL parser. */
export function matchDurationPrefix(
	source: string,
	start: number,
): { duration: DataviewDuration; end: number } | undefined {
	const scanned = scanDuration(source, start, DATAVIEW_DURATION);
	return scanned && { duration: new DataviewDuration(scanned.parts), end: scanned.end };
}

/** Luxon's `Duration.toFormat`: `y M w d h m s S` tokens over the shifted duration. */
export function formatDuration(duration: DataviewDuration, format: string): string {
	const tokens = luxonTokens(format);
	const units = new Set(
		tokens
			.filter((token) => !token.literal)
			.map((token) => token.value[0])
			.filter((char): char is string => Boolean(char && "yMwdhmsS".includes(char))),
	);
	let remaining = duration.toMillis();
	const amounts: Record<string, number> = {};
	const order: Array<[string, number]> = [
		["y", CASUAL_UNIT_MS.years],
		["M", CASUAL_UNIT_MS.months],
		["w", CASUAL_UNIT_MS.weeks],
		["d", CASUAL_UNIT_MS.days],
		["h", CASUAL_UNIT_MS.hours],
		["m", CASUAL_UNIT_MS.minutes],
		["s", CASUAL_UNIT_MS.seconds],
		["S", 1],
	];
	for (const [unit, millis] of order) {
		if (!units.has(unit)) continue;
		const whole = Math.trunc(remaining / millis);
		amounts[unit] = whole;
		remaining -= whole * millis;
	}
	return tokens
		.map((token) => {
			if (token.literal) return token.value;
			const unit = token.value[0] ?? "";
			const amount = amounts[unit];
			return amount === undefined ? token.value : pad(amount, token.value.length);
		})
		.join("");
}
