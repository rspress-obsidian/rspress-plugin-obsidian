/**
 * ISO calendar-day grammar and integer-day arithmetic, shared by every feature
 * that reads a `YYYY-MM-DD` day out of notes or file names. Kept here rather
 * than in one feature: Tasks and Kanban read the same notation, and a day
 * parsed differently by the two is the same note behaving two ways.
 */
import { DAY_MS } from "./date-math.js";

/** Days since 1970-01-01; `NaN` for a date that does not exist (`2024-02-30`). */
export type Day = number;

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

const ISO_YEAR = "[0-9]{4}";
const ISO_MONTH = "[0-9]{2}";
const ISO_DAY_OF_MONTH = "[0-9]{2}";

/** A `YYYY-MM-DD` day as a regex source whose three groups are its year, month and day. */
export const ISO_DAY = `(${ISO_YEAR})-(${ISO_MONTH})-(${ISO_DAY_OF_MONTH})`;

/** The same day, as a regex source that captures nothing. */
export const ISO_DAY_SHAPE = `${ISO_YEAR}-${ISO_MONTH}-${ISO_DAY_OF_MONTH}`;

/** The same day written without separators (`20240515`), its three groups year, month and day. */
export const COMPACT_DAY = `(${ISO_YEAR})(${ISO_MONTH})(${ISO_DAY_OF_MONTH})`;

/** The year, month and date a matched ISO day names. */
export function parseIsoDayParts(match: RegExpExecArray): {
	year: number;
	month: number;
	date: number;
} {
	return { year: Number(match[1]), month: Number(match[2]), date: Number(match[3]) };
}
