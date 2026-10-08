/**
 * Calendar arithmetic for every date language the plugin reproduces: moment.js
 * (Templater, Kanban, the daily-notes core, and Bases, which Obsidian builds
 * on moment) and Luxon (Dataview).
 *
 * Both libraries add a duration in the same order: whole months first, with
 * the day clamped to the target month's last day (Jan 31 + 1 month = Feb 29),
 * then whole calendar days (a DST change keeps the wall-clock time), then
 * exact milliseconds. They differ only in how they round a fractional unit, so
 * each library has its own entry point (`momentAdd`, `luxonPlus`) over one
 * `shiftDate`. Dates are local wall-clock dates throughout. Node-free.
 */

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** A span in the three buckets moment keeps a duration in, which is also the order both libraries add them. */
export interface CalendarSpan {
	months: number;
	days: number;
	milliseconds: number;
}

export const DURATION_UNITS = [
	"years",
	"months",
	"weeks",
	"days",
	"hours",
	"minutes",
	"seconds",
	"milliseconds",
] as const;
export type DurationUnit = (typeof DURATION_UNITS)[number];
/** A duration as written: an amount per unit, any of them fractional or negative. */
export type DurationParts = Partial<Record<DurationUnit, number>>;

/** Luxon's "casual" unit lengths: a 365-day year and a 30-day month. */
export const CASUAL_UNIT_MS: Record<DurationUnit, number> = {
	years: 365 * DAY_MS,
	months: 30 * DAY_MS,
	weeks: 7 * DAY_MS,
	days: DAY_MS,
	hours: HOUR_MS,
	minutes: MINUTE_MS,
	seconds: 1000,
	milliseconds: 1,
};

/** Days in month `monthIndex` (0-based, may overflow into other years) of `year`. */
export function daysInMonth(year: number, monthIndex: number): number {
	const month = ((monthIndex % 12) + 12) % 12;
	if (month !== 1) return 31 - ((month % 7) % 2);
	const actualYear = year + (monthIndex - month) / 12;
	return (actualYear % 4 === 0 && actualYear % 100 !== 0) || actualYear % 400 === 0 ? 29 : 28;
}

/**
 * `new Date(year, month, day, …)` for every year: `Date` reads a year below
 * 100 as 19xx, so such a date is built 400 years later (the same calendar)
 * and moved back, as moment does.
 */
export function localDate(
	year: number,
	monthIndex: number,
	day = 1,
	hours = 0,
	minutes = 0,
	seconds = 0,
	milliseconds = 0,
): Date {
	if (year < 0 || year >= 100) {
		return new Date(year, monthIndex, day, hours, minutes, seconds, milliseconds);
	}
	const date = new Date(year + 400, monthIndex, day, hours, minutes, seconds, milliseconds);
	date.setFullYear(date.getFullYear() - 400);
	return date;
}

/** Day of the year, 1 for January 1. */
export function dayOfYear(date: Date): number {
	const midnight = localDate(date.getFullYear(), date.getMonth(), date.getDate());
	// Rounded: a DST change makes one of the days before 23 or 25 hours long.
	return (
		Math.round((midnight.getTime() - localDate(date.getFullYear(), 0, 1).getTime()) / DAY_MS) + 1
	);
}

/** Monday of ISO week 1 of `isoYear`: the week holding January 4. */
export function isoWeekOneMonday(isoYear: number): Date {
	const january4 = localDate(isoYear, 0, 4);
	return localDate(isoYear, 0, 4 - ((january4.getDay() + 6) % 7));
}

/** ISO week number and its week-numbering year. */
export function isoWeek(date: Date): { week: number; year: number } {
	const thursday = localDate(
		date.getFullYear(),
		date.getMonth(),
		date.getDate() - ((date.getDay() + 6) % 7) + 3,
	);
	const year = thursday.getFullYear();
	// Rounded: a DST change makes one of the days between 23 or 25 hours long.
	const days = Math.round((thursday.getTime() - isoWeekOneMonday(year).getTime()) / DAY_MS);
	return { week: Math.floor(days / 7) + 1, year };
}

/**
 * `date` moved by whole `months` (the day clamped to the month's last), then
 * whole calendar `days`, then exact `milliseconds`. A new date.
 */
export function shiftDate(date: Date, span: CalendarSpan): Date {
	const result = new Date(date.getTime());
	if (span.months) {
		const month = result.getMonth() + span.months;
		result.setMonth(month, Math.min(result.getDate(), daysInMonth(result.getFullYear(), month)));
	}
	if (span.days) result.setDate(result.getDate() + span.days);
	if (span.milliseconds) result.setTime(result.getTime() + span.milliseconds);
	return result;
}

/** moment's `absRound`: halves round away from zero. */
function absRound(value: number): number {
	return value < 0 ? -Math.round(-value) : Math.round(value);
}

/**
 * moment's `add(duration)` (`subtract` with `sign` -1): fractional months and
 * days round half away from zero (`add(1.5, "days")` is two days), the clock
 * part is exact.
 */
export function momentAdd(date: Date, span: CalendarSpan, sign = 1): Date {
	return shiftDate(date, {
		months: sign * absRound(span.months),
		days: sign * absRound(span.days),
		milliseconds: sign * span.milliseconds,
	});
}

/** The wall-clock fields of a local time, as a UTC timestamp (any year, overflowing fields carried). */
function wallClock(
	year: number,
	monthIndex: number,
	day: number,
	hours: number,
	minutes: number,
	seconds: number,
	milliseconds: number,
): number {
	const wall = new Date(0);
	wall.setUTCFullYear(year, monthIndex, day);
	wall.setUTCHours(hours, minutes, seconds, milliseconds);
	return wall.getTime();
}

/**
 * Luxon's `fixOffset`: the instant a wall-clock time names in the local zone,
 * keeping `offset` (minutes east of UTC, the date's offset before it moved)
 * when the time is ambiguous.
 */
function luxonInstant(wall: number, offset: number): number {
	let guess = wall - offset * MINUTE_MS;
	const second = -new Date(guess).getTimezoneOffset();
	if (second === offset) return guess;
	guess -= (second - offset) * MINUTE_MS;
	const third = -new Date(guess).getTimezoneOffset();
	if (second === third) return guess;
	return wall - Math.min(second, third) * MINUTE_MS;
}

/**
 * Luxon's `plus` (`minus` with `sign` -1): years and months move the
 * wall-clock date with the day clamped, weeks and days move it on, in one
 * step; then every fraction (`1.5 years`, `0.5 days`) and the clock units
 * are added as exact time at the units' casual lengths.
 */
export function luxonPlus(date: Date, parts: DurationParts, sign = 1): Date {
	let exact = 0;
	const whole = (unit: DurationUnit): number => {
		const amount = sign * (parts[unit] ?? 0);
		const truncated = Math.trunc(amount);
		exact += (amount - truncated) * CASUAL_UNIT_MS[unit];
		return truncated;
	};
	const year = date.getFullYear();
	const month = date.getMonth() + whole("years") * 12 + whole("months");
	const day =
		Math.min(date.getDate(), daysInMonth(year, month)) + whole("weeks") * 7 + whole("days");
	for (const unit of ["hours", "minutes", "seconds", "milliseconds"] as const) {
		exact += sign * (parts[unit] ?? 0) * CASUAL_UNIT_MS[unit];
	}
	const wall = wallClock(
		year,
		month,
		day,
		date.getHours(),
		date.getMinutes(),
		date.getSeconds(),
		date.getMilliseconds(),
	);
	return new Date(luxonInstant(wall, -date.getTimezoneOffset()) + exact);
}

// ---------------------------------------------------------------------------
// moment units
// ---------------------------------------------------------------------------

/** The units moment's `add`, `startOf`, `endOf` and `diff` take. */
export type MomentUnit =
	| "year"
	| "quarter"
	| "month"
	| "week"
	| "isoWeek"
	| "day"
	| "date"
	| "hour"
	| "minute"
	| "second"
	| "millisecond";

/** moment's unit aliases: the lowercase name, its plural, and the shorthand. */
const MOMENT_UNIT_ALIASES: Record<string, MomentUnit> = {
	year: "year",
	years: "year",
	y: "year",
	quarter: "quarter",
	quarters: "quarter",
	Q: "quarter",
	month: "month",
	months: "month",
	M: "month",
	week: "week",
	weeks: "week",
	w: "week",
	isoweek: "isoWeek",
	isoweeks: "isoWeek",
	W: "isoWeek",
	day: "day",
	days: "day",
	d: "day",
	date: "date",
	dates: "date",
	D: "date",
	hour: "hour",
	hours: "hour",
	h: "hour",
	minute: "minute",
	minutes: "minute",
	m: "minute",
	second: "second",
	seconds: "second",
	s: "second",
	millisecond: "millisecond",
	milliseconds: "millisecond",
	ms: "millisecond",
};

/** moment's `normalizeUnits`: the name as written, else lowercased (`"Days"`, `"W"`, `"isoWeek"`). */
export function normalizeMomentUnit(name: string): MomentUnit | undefined {
	if (Object.hasOwn(MOMENT_UNIT_ALIASES, name)) return MOMENT_UNIT_ALIASES[name];
	const lower = name.toLowerCase();
	return Object.hasOwn(MOMENT_UNIT_ALIASES, lower) ? MOMENT_UNIT_ALIASES[lower] : undefined;
}

const MOMENT_UNIT_SPANS: Record<MomentUnit, CalendarSpan> = {
	year: { months: 12, days: 0, milliseconds: 0 },
	quarter: { months: 3, days: 0, milliseconds: 0 },
	month: { months: 1, days: 0, milliseconds: 0 },
	week: { months: 0, days: 7, milliseconds: 0 },
	isoWeek: { months: 0, days: 7, milliseconds: 0 },
	day: { months: 0, days: 1, milliseconds: 0 },
	// A duration has no `date` field, so `add(1, "D")` adds nothing.
	date: { months: 0, days: 0, milliseconds: 0 },
	hour: { months: 0, days: 0, milliseconds: HOUR_MS },
	minute: { months: 0, days: 0, milliseconds: MINUTE_MS },
	second: { months: 0, days: 0, milliseconds: 1000 },
	millisecond: { months: 0, days: 0, milliseconds: 1 },
};

/** The duration `moment.duration(amount, unit)` builds. */
export function momentUnitSpan(unit: MomentUnit, amount: number): CalendarSpan {
	const size = MOMENT_UNIT_SPANS[unit];
	return {
		months: size.months * amount,
		days: size.days * amount,
		milliseconds: size.milliseconds * amount,
	};
}

/** The start of the unit holding `date`, or (`next`) of the unit after it, as moment computes both. */
function unitStart(date: Date, unit: MomentUnit, next: 0 | 1): number {
	const year = date.getFullYear();
	const month = date.getMonth();
	const day = date.getDate();
	const time = date.getTime();
	// moment moves the clock units by exact time, so an ambiguous hour keeps its offset.
	const clockStart = (size: number, offset: number) =>
		time - ((((time + offset) % size) + size) % size) + next * size;
	switch (unit) {
		case "year":
			return localDate(year + next, 0, 1).getTime();
		case "quarter":
			return localDate(year, month - (month % 3) + next * 3, 1).getTime();
		case "month":
			return localDate(year, month + next, 1).getTime();
		case "week":
			return localDate(year, month, day - date.getDay() + next * 7).getTime();
		case "isoWeek":
			return localDate(year, month, day - ((date.getDay() + 6) % 7) + next * 7).getTime();
		case "day":
		case "date":
			return localDate(year, month, day + next).getTime();
		case "hour":
			return clockStart(HOUR_MS, -date.getTimezoneOffset() * MINUTE_MS);
		case "minute":
			return clockStart(MINUTE_MS, 0);
		case "second":
			return clockStart(1000, 0);
		case "millisecond":
			return time + next;
	}
}

/**
 * moment's `startOf`: the first instant of the unit holding `date`. `week`
 * starts on Sunday (the `en` locale), `isoWeek` on Monday; `millisecond`
 * changes nothing.
 */
export function startOf(date: Date, unit: MomentUnit): Date {
	return new Date(unitStart(date, unit, 0));
}

/** moment's `endOf`: the last millisecond of the unit holding `date`. */
export function endOf(date: Date, unit: MomentUnit): Date {
	return new Date(unitStart(date, unit, 1) - 1);
}

/** moment's `monthDiff`: months from `a` to `b`, fractional, linear across the last month. */
function monthDiff(a: Date, b: Date): number {
	// Anchored on the later day of month, so month ends compare as moment's do.
	if (a.getDate() < b.getDate()) return -monthDiff(b, a);
	const whole = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
	const anchor = momentAdd(a, momentUnitSpan("month", whole)).getTime();
	const offset = b.getTime() - anchor;
	const other = momentAdd(a, momentUnitSpan("month", whole + (offset < 0 ? -1 : 1))).getTime();
	const adjust = offset / Math.abs(other - anchor);
	return -(whole + adjust) || 0;
}

/**
 * moment's `a.diff(b, unit, asFloat)`: calendar months for months, quarters
 * and years, local days for days and weeks (a DST day still counts as one),
 * exact time otherwise; truncated toward zero unless `asFloat`.
 */
export function momentDiff(a: Date, b: Date, unit?: MomentUnit, asFloat = false): number {
	const millis = a.getTime() - b.getTime();
	const zoneDelta = (a.getTimezoneOffset() - b.getTimezoneOffset()) * MINUTE_MS;
	let output: number;
	switch (unit) {
		case "year":
			output = monthDiff(a, b) / 12;
			break;
		case "quarter":
			output = monthDiff(a, b) / 3;
			break;
		case "month":
			output = monthDiff(a, b);
			break;
		case "week":
			output = (millis - zoneDelta) / (7 * DAY_MS);
			break;
		case "day":
			output = (millis - zoneDelta) / DAY_MS;
			break;
		case "hour":
			output = millis / HOUR_MS;
			break;
		case "minute":
			output = millis / MINUTE_MS;
			break;
		case "second":
			output = millis / 1000;
			break;
		default:
			// moment's `diff` has no case for `date` or `isoWeek`: they count milliseconds.
			output = millis;
	}
	return asFloat ? output : Math.trunc(output) || 0;
}

/**
 * Luxon's `later.diff(earlier)` over months, days and the rest: whole months
 * and then whole days (both added to `earlier` the way `plus` adds them),
 * then exact milliseconds. `later` must not be before `earlier`.
 */
export function luxonDiff(later: Date, earlier: Date): CalendarSpan {
	let months =
		(later.getFullYear() - earlier.getFullYear()) * 12 + (later.getMonth() - earlier.getMonth());
	let anchor = luxonPlus(earlier, { months });
	if (anchor.getTime() > later.getTime()) {
		months -= 1;
		anchor = luxonPlus(earlier, { months });
	}
	let days = Math.round(
		(startOf(later, "day").getTime() - startOf(anchor, "day").getTime()) / DAY_MS,
	);
	let dayAnchor = luxonPlus(earlier, { months, days });
	while (days > 0 && dayAnchor.getTime() > later.getTime()) {
		days -= 1;
		dayAnchor = luxonPlus(earlier, { months, days });
	}
	return { months, days, milliseconds: later.getTime() - dayAnchor.getTime() };
}

// ---------------------------------------------------------------------------
// moment's humanize
// ---------------------------------------------------------------------------

/** moment's `daysToMonths`: 400 years have 146097 days and 4800 months. */
const DAYS_PER_MONTH = 146097 / 4800;

/**
 * moment's `duration.humanize()` in the `en` locale: the duration's size in
 * its largest unit, with moment's thresholds — "a few seconds" up to 44 s,
 * "a minute" to 89 s, minutes below 45, hours below 22, days below 26, months
 * below 11, then years.
 */
export function humanizeDuration(span: CalendarSpan): string {
	const months = Math.abs(span.months);
	const milliseconds = Math.abs(span.milliseconds);
	// moment's `duration.as(unit)` over the unbubbled buckets: below a month,
	// months count as their (rounded) average days; from a month up, days and
	// time count as average months.
	const wholeDays = Math.abs(span.days) + Math.round(months * DAYS_PER_MONTH);
	const seconds = Math.round(wholeDays * 86_400 + milliseconds / 1000);
	const minutes = Math.round(wholeDays * 1440 + milliseconds / MINUTE_MS);
	const hours = Math.round(wholeDays * 24 + milliseconds / HOUR_MS);
	const days = Math.round(wholeDays + milliseconds / DAY_MS);
	const exactMonths = months + (Math.abs(span.days) + milliseconds / DAY_MS) / DAYS_PER_MONTH;
	const roundMonths = Math.round(exactMonths);
	const years = Math.round(exactMonths / 12);
	if (seconds <= 44) return "a few seconds";
	if (minutes <= 1) return "a minute";
	if (minutes < 45) return `${minutes} minutes`;
	if (hours <= 1) return "an hour";
	if (hours < 22) return `${hours} hours`;
	if (days <= 1) return "a day";
	if (days < 26) return `${days} days`;
	if (roundMonths <= 1) return "a month";
	if (roundMonths < 11) return `${roundMonths} months`;
	if (years <= 1) return "a year";
	return `${years} years`;
}

/**
 * moment's `date.from(base)`: the calendar distance (whole months, then
 * exact time) humanized, as "in 3 days" or "2 months ago". No distance at all
 * reads as past, "a few seconds ago", as in moment.
 */
export function momentFrom(date: Date, base: Date): string {
	const later = date.getTime() > base.getTime();
	const [from, to] = later ? [base, date] : [date, base];
	let months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
	if (momentAdd(from, momentUnitSpan("month", months)).getTime() > to.getTime()) months -= 1;
	const milliseconds = to.getTime() - momentAdd(from, momentUnitSpan("month", months)).getTime();
	const text = humanizeDuration({ months, days: 0, milliseconds });
	return later ? `in ${text}` : `${text} ago`;
}

// ---------------------------------------------------------------------------
// Duration text
// ---------------------------------------------------------------------------

/** How one language writes a duration: `<amount><unit>` parts and what separates them. */
export interface DurationGrammar {
	/** One part, sticky (`y` flag): the amount in group 1, the unit as written in group 2. */
	part: RegExp;
	/** What may stand between two parts, sticky; it may match nothing. */
	separator: RegExp;
	/** The unit a spelling names, in this language. */
	unit: (spelling: string) => DurationUnit | undefined;
}

/**
 * The longest duration written in `source` from `start`: the amounts it adds
 * up per unit (`1h 30m 15m` is 1 hour and 45 minutes), and the index after
 * its last part. `undefined` when no part starts at `start`.
 */
export function scanDuration(
	source: string,
	start: number,
	grammar: DurationGrammar,
): { parts: DurationParts; end: number } | undefined {
	const parts: DurationParts = {};
	let end = -1;
	for (;;) {
		let next = end < 0 ? start : end;
		if (end >= 0) {
			grammar.separator.lastIndex = end;
			next += grammar.separator.exec(source)?.[0].length ?? 0;
		}
		grammar.part.lastIndex = next;
		const match = grammar.part.exec(source);
		const unit = match ? grammar.unit(match[2] ?? "") : undefined;
		if (!match || !unit) break;
		parts[unit] = (parts[unit] ?? 0) + Number(match[1]);
		end = next + match[0].length;
	}
	return end >= 0 ? { parts, end } : undefined;
}
