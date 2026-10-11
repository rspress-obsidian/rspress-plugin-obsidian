/**
 * Calendar arithmetic for Tasks: task dates are plain days (`2024-05-01`),
 * compared and grouped without a time of day, and every relative date in a
 * query (`due before tomorrow`, `scheduled this week`) is resolved against one
 * injectable "today" so a build is reproducible.
 */
import * as chrono from "chrono-node";
import { formatDailyNoteDate } from "../../daily-notes.js";
import {
	DAY_MS,
	endOf,
	isoWeekOneMonday,
	localDate,
	momentAdd,
	momentUnitSpan,
	startOf,
} from "../../date-math.js";

/** Days since 1970-01-01; `NaN` for a date that does not exist (`2024-02-30`). */
export type Day = number;

/** An inclusive range of days. */
export interface DayRange {
	start: Day;
	end: Day;
}

/** A date written on a task: its text, and the day it names (`NaN` when invalid). */
export interface TaskDate {
	text: string;
	day: Day;
}

/** The day `year-month-date` names, or `NaN` when no such day exists. */
export function dayFromParts(year: number, month: number, date: number): Day {
	const ms = Date.UTC(year, month - 1, date);
	const check = new Date(ms);
	if (
		check.getUTCFullYear() !== year ||
		check.getUTCMonth() !== month - 1 ||
		check.getUTCDate() !== date
	) {
		return Number.NaN;
	}
	return ms / DAY_MS;
}

/** The day an ISO `YYYY-MM-DD` string names, or `NaN`. */
export function parseIsoDay(text: string): Day {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
	return match ? dayFromParts(Number(match[1]), Number(match[2]), Number(match[3])) : Number.NaN;
}

/** The local calendar day of a `Date`. */
export function dayOfLocalDate(date: Date): Day {
	return dayFromParts(date.getFullYear(), date.getMonth() + 1, date.getDate());
}

/** Midday of `day` in local time: what chrono and the moment formatter read. */
function localDateOf(day: Day): Date {
	const utc = new Date(day * DAY_MS);
	return localDate(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate(), 12);
}

/** Format a day with Moment.js tokens. */
export function formatDay(day: Day, format: string): string {
	return formatDailyNoteDate(localDateOf(day), format);
}

/** `YYYY-MM-DD`. */
export function isoDay(day: Day): string {
	return formatDay(day, "YYYY-MM-DD");
}

/**
 * "Today" for a build: the `now` option when set (a `Date`, an ISO day, or any
 * string `Date` parses), else the machine's date. `undefined` when `now` is
 * set but is not a date.
 */
export function resolveToday(now: Date | string | undefined): Day | undefined {
	if (now === undefined) return dayOfLocalDate(new Date());
	if (typeof now === "string") {
		const iso = parseIsoDay(now.trim());
		if (!Number.isNaN(iso)) return iso;
	}
	const date = now instanceof Date ? now : new Date(now);
	return Number.isNaN(date.getTime()) ? undefined : dayOfLocalDate(date);
}

type RangeUnit = "week" | "month" | "quarter" | "year";

/** The ISO week (Monday–Sunday), month, quarter or year holding `day`, shifted by `offset` units. */
function unitRange(day: Day, unit: RangeUnit, offset: number): DayRange {
	// Tasks reads these with moment: `add(offset, unit)`, then `startOf`/`endOf` the ISO week or unit.
	const momentUnit = unit === "week" ? "isoWeek" : unit;
	const shifted = momentAdd(localDateOf(day), momentUnitSpan(momentUnit, offset));
	return {
		start: dayOfLocalDate(startOf(shifted, momentUnit)),
		end: dayOfLocalDate(endOf(shifted, momentUnit)),
	};
}

const RELATIVE_OFFSET: Record<string, number> = { last: -1, this: 0, next: 1 };

function relativeRange(input: string, today: Day): DayRange | undefined {
	const match = /(last|this|next) (week|month|quarter|year)/.exec(input);
	if (!match) return undefined;
	return unitRange(today, match[2] as RangeUnit, RELATIVE_OFFSET[match[1] as string] ?? 0);
}

function numberedRange(input: string): DayRange | undefined {
	const text = input.trim();
	let match = /^(\d{4})$/.exec(text);
	if (match) return unitRange(dayFromParts(Number(match[1]), 1, 1), "year", 0);
	match = /^(\d{4})-Q([1-4])$/.exec(text);
	if (match)
		return unitRange(dayFromParts(Number(match[1]), Number(match[2]) * 3, 1), "quarter", 0);
	match = /^(\d{4})-(\d{2})$/.exec(text);
	if (match && Number(match[2]) >= 1 && Number(match[2]) <= 12) {
		return unitRange(dayFromParts(Number(match[1]), Number(match[2]), 1), "month", 0);
	}
	match = /^(\d{4})-W(\d{2})$/.exec(text);
	if (match) {
		// ISO week N starts N - 1 weeks after the Monday of the week holding 4 January.
		const start = dayOfLocalDate(isoWeekOneMonday(Number(match[1]))) + (Number(match[2]) - 1) * 7;
		return { start, end: start + 6 };
	}
	return undefined;
}

function absoluteRange(input: string, today: Day, forwardDate: boolean): DayRange | undefined {
	const results = chrono.parse(input, localDateOf(today), { forwardDate });
	const first = results[0];
	if (!first) return undefined;
	const start = dayOfLocalDate(first.start.date());
	const end = results[1] ? dayOfLocalDate(results[1].start.date()) : start;
	return start <= end ? { start, end } : { start: end, end: start };
}

/**
 * The days a query's date text names, the way Tasks reads it: a relative range
 * (`last week`, `this quarter`), a numbered one (`2024`, `2024-Q2`, `2024-05`,
 * `2024-W18`), or one or two dates in natural language (`tomorrow`,
 * `2024-01-01 2024-01-31`), all relative to `today`.
 */
export function parseDateRange(
	input: string,
	today: Day,
	forwardDate = false,
): DayRange | undefined {
	return (
		relativeRange(input, today) ?? numberedRange(input) ?? absoluteRange(input, today, forwardDate)
	);
}

/** One natural-language date, relative to `today`. */
export function parseNaturalDate(input: string, today: Day, forwardDate = false): Day | undefined {
	const date = chrono.parseDate(input, localDateOf(today), { forwardDate });
	return date ? dayOfLocalDate(date) : undefined;
}

/** Tasks' date order: dated before undated, and an invalid date before any valid one. */
export function compareTaskDates(a: TaskDate | undefined, b: TaskDate | undefined): number {
	if (a && !b) return -1;
	if (!a && b) return 1;
	if (!a || !b) return 0;
	const aValid = !Number.isNaN(a.day);
	const bValid = !Number.isNaN(b.day);
	if (aValid !== bValid) return aValid ? 1 : -1;
	if (!aValid) return 0;
	return Math.sign(a.day - b.day);
}
