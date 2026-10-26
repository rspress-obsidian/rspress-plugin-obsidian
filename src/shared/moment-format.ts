/**
 * Moment.js date formats, as Obsidian and the plugins built on it use them:
 * formatting with moment's tokens and reading a date back, strictly (as the
 * daily-notes core matches a file name) or forgivingly (as `moment(text,
 * format)` does). Daily notes, Tasks, Kanban, Templater and Bases all format
 * and read dates through this one implementation. Node-free.
 */
import {
	DAY_MS,
	dayOfYear,
	isoWeek,
	isoWeekOneMonday,
	localDate,
	MONTH_NAMES,
	startOf,
	WEEKDAY_NAMES,
	zeroPad,
} from "./date-math.js";
import { escapeRegExp } from "./escape.js";
import { assertSafeRegex, UnsafeRegexError } from "./safe-regex.js";

/**
 * Moment.js format tokens (Obsidian's daily notes format with Moment), longest
 * first so `YYYY` is never read as two `YY`s. `[…]` is an escaped literal.
 * Dates are local wall-clock dates, the same time model Dataview uses, so a
 * note named `2026-01-05` is January 5 whatever the build machine's zone.
 */
const MOMENT_TOKEN =
	/\[[^\]]*\]|YYYYYY|YYYY|YY|Y|Qo|Q|MMMM|MMM|Mo|MM|M|DDDD|DDDo|DDD|Do|DD|D|dddd|ddd|dd|do|d|E|e|gggg|gg|GGGG|GG|wo|ww|w|Wo|WW|W|HH|H|hh|h|kk|k|mm|m|ss|s|SSS|SS|S|A|a|X|x|ZZ|Z/g;

const SHORT_WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
/** Each strict format's matcher, or `null` for one the regex guard refuses. */
const dateFormatMatchers = new Map<string, { regex: RegExp; tokens: string[] } | null>();

function ordinal(value: number): string {
	const tens = value % 100;
	if (tens >= 11 && tens <= 13) return `${value}th`;
	const suffix = ["th", "st", "nd", "rd"][value % 10] ?? "th";
	return `${value}${value % 10 > 3 ? "th" : suffix}`;
}

/**
 * Moment's default (en) locale week: weeks start on Sunday and week 1 is the
 * one containing January 1. Returns the week number and its week-year.
 */
function localeWeek(date: Date): { week: number; year: number } {
	const sunday = startOf(date, "week");
	const year = localDate(
		sunday.getFullYear(),
		sunday.getMonth(),
		sunday.getDate() + 6,
	).getFullYear();
	const week =
		Math.round((sunday.getTime() - localeWeekOneStart(year).getTime()) / (7 * DAY_MS)) + 1;
	return { week, year };
}

function localeWeekOneStart(year: number): Date {
	return startOf(localDate(year, 0, 1), "week");
}

function offset(date: Date, separator: string): string {
	const minutes = -date.getTimezoneOffset();
	const sign = minutes < 0 ? "-" : "+";
	return `${sign}${zeroPad(Math.floor(Math.abs(minutes) / 60))}${separator}${zeroPad(Math.abs(minutes) % 60)}`;
}

/** `zone`, when set, is the offset text a parsed name carried; `Z`/`ZZ` echo it. */
function momentToken(date: Date, token: string, zone?: string): string {
	const year = date.getFullYear();
	const month = date.getMonth();
	const day = date.getDate();
	const weekday = date.getDay();
	const hour = date.getHours();
	switch (token) {
		case "YYYYYY":
			return `${year < 0 ? "-" : "+"}${zeroPad(Math.abs(year), 6)}`;
		case "YYYY":
			return zeroPad(year, 4);
		case "YY":
			return zeroPad(year % 100);
		case "Y":
			// Moment: four digits up to 9999, then a forced sign.
			return year <= 9999 ? `${year < 0 ? "-" : ""}${zeroPad(Math.abs(year), 4)}` : `+${year}`;
		case "Q":
			return String(Math.floor(month / 3) + 1);
		case "Qo":
			return ordinal(Math.floor(month / 3) + 1);
		case "M":
			return String(month + 1);
		case "Mo":
			return ordinal(month + 1);
		case "MM":
			return zeroPad(month + 1);
		case "MMM":
			return (MONTH_NAMES[month] ?? "").slice(0, 3);
		case "MMMM":
			return MONTH_NAMES[month] ?? "";
		case "D":
			return String(day);
		case "Do":
			return ordinal(day);
		case "DD":
			return zeroPad(day);
		case "DDD":
			return String(dayOfYear(date));
		case "DDDo":
			return ordinal(dayOfYear(date));
		case "DDDD":
			return zeroPad(dayOfYear(date), 3);
		case "d":
		case "e":
			return String(weekday);
		case "do":
			return ordinal(weekday);
		case "dd":
			return SHORT_WEEKDAYS[weekday] ?? "";
		case "ddd":
			return (WEEKDAY_NAMES[weekday] ?? "").slice(0, 3);
		case "dddd":
			return WEEKDAY_NAMES[weekday] ?? "";
		case "E":
			return String(weekday === 0 ? 7 : weekday);
		case "w":
			return String(localeWeek(date).week);
		case "wo":
			return ordinal(localeWeek(date).week);
		case "ww":
			return zeroPad(localeWeek(date).week);
		case "gg":
			return zeroPad(localeWeek(date).year % 100);
		case "gggg":
			return zeroPad(localeWeek(date).year, 4);
		case "W":
			return String(isoWeek(date).week);
		case "Wo":
			return ordinal(isoWeek(date).week);
		case "WW":
			return zeroPad(isoWeek(date).week);
		case "GG":
			return zeroPad(isoWeek(date).year % 100);
		case "GGGG":
			return zeroPad(isoWeek(date).year, 4);
		case "H":
			return String(hour);
		case "HH":
			return zeroPad(hour);
		case "h":
			return String(hour % 12 || 12);
		case "hh":
			return zeroPad(hour % 12 || 12);
		case "k":
			return String(hour || 24);
		case "kk":
			return zeroPad(hour || 24);
		case "m":
			return String(date.getMinutes());
		case "mm":
			return zeroPad(date.getMinutes());
		case "s":
			return String(date.getSeconds());
		case "ss":
			return zeroPad(date.getSeconds());
		case "S":
			return String(Math.floor(date.getMilliseconds() / 100));
		case "SS":
			return zeroPad(Math.floor(date.getMilliseconds() / 10));
		case "SSS":
			return zeroPad(date.getMilliseconds(), 3);
		case "A":
			return hour < 12 ? "AM" : "PM";
		case "a":
			return hour < 12 ? "am" : "pm";
		case "X":
			return String(Math.floor(date.getTime() / 1000));
		case "x":
			return String(date.getTime());
		case "Z":
			return zone ?? offset(date, ":");
		case "ZZ":
			return zone ?? offset(date, "");
		default:
			return token;
	}
}

/** Format a local date with Moment.js tokens, as Obsidian's daily notes do. */
export function formatMomentDate(date: Date, format: string): string {
	return formatMoment(date, format);
}

function formatMoment(date: Date, format: string, zone?: string): string {
	return format.replace(MOMENT_TOKEN, (token) =>
		token.startsWith("[") ? token.slice(1, -1) : momentToken(date, token, zone),
	);
}

const ORDINAL = "(?:st|nd|rd|th)";

function tokenRegex(token: string): string {
	switch (token) {
		case "YYYYYY":
			return "([+-]\\d{6})";
		case "YYYY":
		case "gggg":
		case "GGGG":
			return "(\\d{4})";
		case "Y":
			return "([+-]?\\d+)";
		case "Q":
			return "([1-4])";
		case "Qo":
			return `([1-4]${ORDINAL})`;
		case "MMMM":
			return `(${MONTH_NAMES.join("|")})`;
		case "MMM":
			return `(${MONTH_NAMES.map((name) => name.slice(0, 3)).join("|")})`;
		case "dddd":
			return `(${WEEKDAY_NAMES.join("|")})`;
		case "ddd":
			return `(${WEEKDAY_NAMES.map((name) => name.slice(0, 3)).join("|")})`;
		case "dd":
			return `(${SHORT_WEEKDAYS.join("|")})`;
		case "d":
		case "e":
			return "([0-6])";
		case "do":
			return `([0-6]${ORDINAL})`;
		case "E":
			// Moment's `match1to2` even in strict mode: `05` is Friday, `9` no weekday.
			return "(\\d\\d?)";
		case "Mo":
		case "Do":
		case "wo":
		case "Wo":
			return `(\\d{1,2}${ORDINAL})`;
		case "DDDo":
			return `(\\d{1,3}${ORDINAL})`;
		case "DDD":
			return "(\\d{1,3})";
		case "DDDD":
		case "SSS":
			return "(\\d{3})";
		case "YY":
		case "gg":
		case "GG":
		case "MM":
		case "DD":
		case "ww":
		case "WW":
		case "HH":
		case "hh":
		case "kk":
		case "mm":
		case "ss":
		case "SS":
			return "(\\d{2})";
		case "S":
			return "(\\d)";
		case "A":
		case "a":
			return "(AM|PM|am|pm)";
		case "X":
			// Moment's `matchTimestamp` and `matchSigned`, which allow leading zeros.
			return "([+-]?\\d+(?:\\.\\d{1,3})?)";
		case "x":
			return "([+-]?\\d+)";
		case "Z":
		case "ZZ":
			// Moment's `matchShortOffset`, for both tokens.
			return "(Z|[+-]\\d{2}(?::?\\d{2})?)";
		default:
			// M, D, w, W, H, h, k, m, s: one or two digits.
			return "(\\d{1,2})";
	}
}

/**
 * The strict matcher for `format`, or `null` when it could backtrack
 * catastrophically: the format is the vault's, and tokens in a row over the
 * same digits (`xxxxxx`, twenty-one `D`s) split a text in exponentially many
 * ways. Such a format reads no text, as one that matches nothing would.
 */
function compileDateFormat(format: string): { regex: RegExp; tokens: string[] } | null {
	let pattern = "";
	const tokens: string[] = [];
	let cursor = 0;
	for (const match of format.matchAll(MOMENT_TOKEN)) {
		const token = match[0];
		pattern += escapeRegExp(format.slice(cursor, match.index));
		if (token.startsWith("[")) {
			pattern += escapeRegExp(token.slice(1, -1));
		} else {
			pattern += tokenRegex(token);
			tokens.push(token);
		}
		cursor = match.index + token.length;
	}
	pattern += escapeRegExp(format.slice(cursor));
	const source = `^${pattern}$`;
	try {
		assertSafeRegex(source, "i");
	} catch (error) {
		if (error instanceof UnsafeRegexError) return null;
		throw error;
	}
	return { regex: new RegExp(source, "i"), tokens };
}

/** What a date text says, field by field, before it becomes a date. */
interface DateFields {
	year?: number;
	/** 1-based. */
	month?: number;
	day?: number;
	dayOfYear?: number;
	weekYear?: number;
	isoWeekYear?: number;
	week?: number;
	isoWeek?: number;
	/** 0 = Sunday. */
	weekday?: number;
	/** 1 = Monday … 7 = Sunday. */
	isoWeekday?: number;
	hour?: number;
	minute?: number;
	second?: number;
	millisecond?: number;
	epoch?: number;
	pm?: boolean;
	/** The offset text read (`Z`, `+02:00`); the wall clock is in that offset. */
	zone?: string;
}

/** Moment's `parseTwoDigitYear`: `68` is 2068, `69` is 1969. */
function twoDigitYear(value: number): number {
	return value + (value > 68 ? 1900 : 2000);
}

/**
 * Store what `value` says for `token`. `false` when it names nothing (a word
 * that is no month or weekday), which makes the whole date invalid.
 */
function readField(fields: DateFields, token: string, value: string): boolean {
	const number = Number.parseInt(value, 10);
	const word = value.toLowerCase();
	switch (token) {
		case "YYYYYY":
		case "Y":
			fields.year = number;
			break;
		case "YYYY":
			// A forgiving parse reads `24` for `YYYY` as moment does: as a two-digit year.
			fields.year = value.length === 2 ? twoDigitYear(number) : number;
			break;
		case "YY":
			fields.year = twoDigitYear(number);
			break;
		case "Q":
		case "Qo":
			// Moment: a quarter sets the month to its first.
			fields.month = (number - 1) * 3 + 1;
			break;
		case "M":
		case "MM":
		case "Mo":
			fields.month = number;
			break;
		case "MMM":
		case "MMMM":
			// Moment's `monthsParse`: any word starting with a month's short name.
			fields.month =
				MONTH_NAMES.findIndex((name) => word.startsWith(name.slice(0, 3).toLowerCase())) + 1;
			return fields.month > 0;
		case "D":
		case "DD":
		case "Do":
			fields.day = number;
			break;
		case "DDD":
		case "DDDD":
		case "DDDo":
			fields.dayOfYear = number;
			break;
		case "gggg":
			fields.weekYear = number;
			break;
		case "gg":
			fields.weekYear = twoDigitYear(number);
			break;
		case "GGGG":
			fields.isoWeekYear = number;
			break;
		case "GG":
			fields.isoWeekYear = twoDigitYear(number);
			break;
		case "w":
		case "ww":
		case "wo":
			fields.week = number;
			break;
		case "W":
		case "WW":
		case "Wo":
			fields.isoWeek = number;
			break;
		case "d":
		case "e":
		case "do":
			fields.weekday = number;
			break;
		case "dd":
		case "ddd":
		case "dddd":
			// Moment's `weekdaysParse`: any word starting with a weekday's two-letter name.
			fields.weekday = SHORT_WEEKDAYS.findIndex((name) => word.startsWith(name.toLowerCase()));
			return fields.weekday >= 0;
		case "E":
			fields.isoWeekday = number;
			break;
		case "H":
		case "HH":
		case "h":
		case "hh":
			fields.hour = number;
			break;
		case "k":
		case "kk":
			// Moment: `k` 24 is midnight; any other hour stays as written (and 25 is invalid).
			fields.hour = number === 24 ? 0 : number;
			break;
		case "m":
		case "mm":
			fields.minute = number;
			break;
		case "s":
		case "ss":
			fields.second = number;
			break;
		case "S":
		case "SS":
		case "SSS":
			// Moment reads fractional-second digits as a fraction: `5` is 500 ms, `05` 50 ms.
			fields.millisecond = Math.trunc(Number(`0.${value}`) * 1000);
			break;
		case "A":
		case "a":
			fields.pm = word.startsWith("p");
			break;
		case "X":
			fields.epoch = Number.parseFloat(value) * 1000;
			break;
		case "x":
			fields.epoch = number;
			break;
		case "Z":
		case "ZZ":
			fields.zone = value;
			break;
	}
	return true;
}

/** What a text says for a format: its fields, and how well it fits (moment's score, 0 for a perfect fit). */
interface TextReading {
	fields: DateFields;
	/** `false` when no token found anything, or a name named no month or weekday. */
	readable: boolean;
	/** Moment's format score: characters no token or literal took, plus 10 per token that found nothing. */
	score: number;
	/** Strict mode: each token and the text it matched, to check they format back the same. */
	matched?: Array<{ token: string; value: string }>;
}

/** The fields of `text` when it matches `format` exactly. */
function readStrict(text: string, format: string): TextReading | undefined {
	let compiled = dateFormatMatchers.get(format);
	if (compiled === undefined) {
		compiled = compileDateFormat(format);
		dateFormatMatchers.set(format, compiled);
	}
	const match = compiled?.regex.exec(text);
	if (!compiled || !match) return undefined;
	const fields: DateFields = {};
	const matched = compiled.tokens.map((token, position) => ({
		token,
		value: match[position + 1] ?? "",
	}));
	const readable = matched.every(({ token, value }) => readField(fields, token, value));
	return { fields, readable, score: 0, matched };
}

/**
 * Moment's strict check, token by token: each value formats back to the text
 * it was read from (so `2026-02-30` or a Monday that is a Friday fails).
 * Epochs and `E` compare as numbers, since moment accepts leading zeros there.
 */
function formatsBack(
	matched: ReadonlyArray<{ token: string; value: string }>,
	date: Date,
	zone: string | undefined,
): boolean {
	return matched.every(({ token, value }) => {
		if (token === "X") return Number(value) === date.getTime() / 1000;
		if (token === "x") return Number(value) === date.getTime();
		if (token === "E") return Number(value) === (date.getDay() || 7);
		return momentToken(date, token, zone).toLowerCase() === value.toLowerCase();
	});
}

const ONE_OR_TWO_DIGITS = "\\d\\d?";
/** Any word, as moment's `matchWord` reads a month or weekday name. */
const WORD =
	"\\d*['a-z\\u00A0-\\u05FF\\u0700-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFF07\\uFF10-\\uFFEF]+";

/** Moment's non-strict regexes, where they are looser than the strict ones. */
const FORGIVING_TOKEN_PATTERNS: Record<string, string> = {
	YYYYYY: "[+-]?\\d{1,6}",
	YYYY: "\\d{1,4}",
	YY: ONE_OR_TWO_DIGITS,
	Q: "\\d",
	M: ONE_OR_TWO_DIGITS,
	MM: ONE_OR_TWO_DIGITS,
	MMM: WORD,
	MMMM: WORD,
	D: ONE_OR_TWO_DIGITS,
	DD: ONE_OR_TWO_DIGITS,
	Do: "\\d{1,2}(?:st|nd|rd|th)?",
	DDD: "\\d{1,3}",
	d: ONE_OR_TWO_DIGITS,
	e: ONE_OR_TWO_DIGITS,
	E: ONE_OR_TWO_DIGITS,
	dd: WORD,
	ddd: WORD,
	dddd: WORD,
	w: ONE_OR_TWO_DIGITS,
	ww: ONE_OR_TWO_DIGITS,
	W: ONE_OR_TWO_DIGITS,
	WW: ONE_OR_TWO_DIGITS,
	gg: ONE_OR_TWO_DIGITS,
	gggg: "\\d{1,4}",
	GG: ONE_OR_TWO_DIGITS,
	GGGG: "\\d{1,4}",
	H: ONE_OR_TWO_DIGITS,
	HH: ONE_OR_TWO_DIGITS,
	h: ONE_OR_TWO_DIGITS,
	hh: ONE_OR_TWO_DIGITS,
	k: ONE_OR_TWO_DIGITS,
	kk: ONE_OR_TWO_DIGITS,
	m: ONE_OR_TWO_DIGITS,
	mm: ONE_OR_TWO_DIGITS,
	s: ONE_OR_TWO_DIGITS,
	ss: ONE_OR_TWO_DIGITS,
	S: "\\d{1,3}",
	SS: "\\d{1,3}",
	SSS: "\\d{1,3}",
	A: "[ap]\\.?m?\\.?",
	a: "[ap]\\.?m?\\.?",
	X: "[+-]?\\d+(?:\\.\\d{1,3})?",
	x: "[+-]?\\d+",
};

/** A format as moment walks it: each token's pattern, and literal text one character (or `[…]` run) at a time. */
type ForgivingStep = { token: string; pattern: RegExp } | { literal: string };
const forgivingFormats = new Map<string, ForgivingStep[]>();

function compileForgivingFormat(format: string): ForgivingStep[] {
	const steps: ForgivingStep[] = [];
	let cursor = 0;
	for (const match of format.matchAll(MOMENT_TOKEN)) {
		const token = match[0];
		for (const literal of format.slice(cursor, match.index)) steps.push({ literal });
		if (token.startsWith("[")) {
			steps.push({ literal: token.slice(1, -1) });
		} else {
			const pattern = FORGIVING_TOKEN_PATTERNS[token] ?? tokenRegex(token);
			steps.push({ token, pattern: new RegExp(pattern, "i") });
		}
		cursor = match.index + token.length;
	}
	for (const literal of format.slice(cursor)) steps.push({ literal });
	return steps;
}

/**
 * The fields of `text` read the way `moment(text, format)` reads them without
 * strict mode: each token takes the first run further on that fits it, so
 * separators need not match (`5/3/2024` for `M-D-YYYY`), two-digit tokens take
 * one digit, and text around or after the date is skipped. Unreadable when no
 * token matched, or a name matched no month or weekday.
 */
function readForgiving(text: string, format: string): TextReading {
	let steps = forgivingFormats.get(format);
	if (!steps) {
		steps = compileForgivingFormat(format);
		forgivingFormats.set(format, steps);
	}
	const fields: DateFields = {};
	let rest = text;
	let consumed = 0;
	let usedTokens = 0;
	let unusedTokens = 0;
	let names = true;
	for (const step of steps) {
		if ("literal" in step) {
			const at = rest.indexOf(step.literal);
			if (at < 0) continue;
			rest = rest.slice(at + step.literal.length);
			consumed += step.literal.length;
			continue;
		}
		const match = step.pattern.exec(rest);
		if (!match) {
			unusedTokens += 1;
			continue;
		}
		rest = rest.slice(match.index + match[0].length);
		consumed += match[0].length;
		usedTokens += 1;
		// Moment reads on after a bad name, so the score still counts the rest.
		names = readField(fields, step.token, match[0]) && names;
	}
	return {
		fields,
		readable: names && usedTokens > 0,
		score: text.length - consumed + unusedTokens * 10,
	};
}

/** The local date and wall-clock time `fields` name, missing parts filled as moment fills them. */
function dateFromFields(fields: DateFields, now: Date): Date {
	if (fields.epoch !== undefined) return new Date(fields.epoch);
	let hour = fields.hour ?? 0;
	if (fields.pm === true && hour < 12) hour += 12;
	if (fields.pm === false && hour === 12) hour = 0;
	const noCalendarDate = fields.month === undefined && fields.day === undefined;
	let date: Date;
	if (noCalendarDate && fields.dayOfYear !== undefined) {
		date = localDate(fields.year ?? now.getFullYear(), 0, fields.dayOfYear);
	} else if (
		noCalendarDate &&
		(fields.isoWeek ?? fields.isoWeekYear ?? fields.isoWeekday) !== undefined
	) {
		// Moment's ISO defaults: week 1, Monday, this ISO year.
		const monday = isoWeekOneMonday(fields.isoWeekYear ?? fields.year ?? isoWeek(now).year);
		date = localDate(
			monday.getFullYear(),
			monday.getMonth(),
			monday.getDate() + ((fields.isoWeek ?? 1) - 1) * 7 + ((fields.isoWeekday ?? 1) - 1),
		);
	} else if (noCalendarDate && (fields.week ?? fields.weekYear ?? fields.weekday) !== undefined) {
		// Moment's locale-week defaults: this week, Sunday.
		const current = localeWeek(now);
		const start = localeWeekOneStart(fields.weekYear ?? fields.year ?? current.year);
		date = localDate(
			start.getFullYear(),
			start.getMonth(),
			start.getDate() + ((fields.week ?? current.week) - 1) * 7 + (fields.weekday ?? 0),
		);
	} else if (fields.year !== undefined) {
		date = localDate(fields.year, (fields.month ?? 1) - 1, fields.day ?? 1);
	} else if (fields.month !== undefined) {
		// Moment fills the leading missing parts from today and the rest with their first.
		date = localDate(now.getFullYear(), fields.month - 1, fields.day ?? 1);
	} else {
		date = localDate(now.getFullYear(), now.getMonth(), fields.day ?? now.getDate());
	}
	date.setHours(hour, fields.minute ?? 0, fields.second ?? 0, fields.millisecond ?? 0);
	return date;
}

/**
 * Moment's overflow checks, for a forgiving parse: every field read is a real
 * part of `date` (no 31 February, no hour 25, no Monday that is a Friday);
 * 24:00 is allowed and is the next day's midnight.
 */
function fieldsFit(fields: DateFields, date: Date): boolean {
	if (fields.epoch !== undefined) return true;
	const { minute = 0, second = 0, millisecond = 0 } = fields;
	const hour = fields.hour ?? 0;
	if (minute > 59 || second > 59) return false;
	if (hour > 24 || (hour === 24 && minute + second + millisecond > 0)) return false;
	// The calendar day before an hour of 24 rolled it over.
	const day =
		hour === 24 ? localDate(date.getFullYear(), date.getMonth(), date.getDate() - 1) : date;
	const calendar = fields.month !== undefined || fields.day !== undefined;
	if (fields.month !== undefined && day.getMonth() + 1 !== fields.month) return false;
	if (fields.day !== undefined && day.getDate() !== fields.day) return false;
	if (fields.weekday !== undefined && day.getDay() !== fields.weekday) return false;
	if (calendar) return true;
	if (fields.dayOfYear !== undefined) return dayOfYear(day) === fields.dayOfYear;
	if (fields.isoWeek !== undefined && isoWeek(day).week !== fields.isoWeek) return false;
	if (fields.isoWeekday !== undefined && (day.getDay() || 7) !== fields.isoWeekday) return false;
	return fields.week === undefined || localeWeek(day).week === fields.week;
}

/** How `parseMomentDate` reads a text. */
export interface MomentParseOptions {
	/**
	 * `true` (the default): moment's strict mode — the text must match the
	 * format and format back to itself. `false`: moment's forgiving mode, as
	 * `moment(text, format)` reads it.
	 */
	strict?: boolean;
	/** The clock the parts a text leaves out (its year, its day) come from. Default: now. */
	now?: Date;
}

/** The local date a reading names, or `undefined` when moment would call it invalid. */
function readingDate(reading: TextReading, now: Date): Date | undefined {
	const { fields } = reading;
	if (!reading.readable) return undefined;
	// Moment rejects a meridiem with no date or time part to apply it to.
	const parts = Object.keys(fields).filter((key) => key !== "pm" && key !== "zone");
	if (fields.pm !== undefined && parts.length === 0) return undefined;

	const { zone } = fields;
	let zoneMinutes = 0;
	if (zone && zone.toUpperCase() !== "Z") {
		const [, sign, hours = "0", minutes = "0"] = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone) ?? [];
		zoneMinutes = (Number(hours) * 60 + Number(minutes)) * (sign === "-" ? -1 : 1);
		// Moment's `offsetFromString` bounds: minutes ≤ 59, -12:00…+14:00.
		if (Number(minutes) > 59 || zoneMinutes > 14 * 60 || zoneMinutes < -12 * 60) return undefined;
	}

	const date = dateFromFields(fields, now);
	if (Number.isNaN(date.getTime())) return undefined;
	const valid = reading.matched
		? formatsBack(reading.matched, date, zone)
		: fieldsFit(fields, date);
	if (!valid) return undefined;
	if (zone === undefined || fields.epoch !== undefined) return date;
	// The text's wall clock is in its own offset; Moment converts it to local time.
	const utc = new Date(0);
	utc.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate());
	utc.setUTCHours(date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
	return new Date(utc.getTime() - zoneMinutes * 60_000);
}

/**
 * Read a date out of `text` written in Moment format `format`. By default
 * strictly, the way Obsidian's daily notes match a filename (`moment(name,
 * format, true)`): the text must match the format and the date found must
 * format back to the same text. With `strict: false`, forgivingly, as
 * `moment(text, format)` does. Returns a local date.
 *
 * Given a list of formats, moment's (2.29) choice: the first format that
 * reads a date, unless a later format fits the text better (a lower score) —
 * even one that reads no valid date, which makes the result invalid.
 */
export function parseMomentDate(
	text: string,
	format: string | readonly string[],
	options: MomentParseOptions = {},
): Date | undefined {
	const strict = options.strict ?? true;
	const now = options.now ?? new Date();
	let best: { date: Date | undefined; score: number } | undefined;
	let foundValid = false;
	for (const candidate of typeof format === "string" ? [format] : format) {
		const reading = strict ? readStrict(text, candidate) : readForgiving(text, candidate);
		// A strict text that does not match never fits better than one that does.
		const parsed = reading
			? { date: readingDate(reading, now), score: reading.score }
			: { date: undefined, score: Number.POSITIVE_INFINITY };
		const valid = parsed.date !== undefined;
		const better = best === undefined || parsed.score < best.score;
		if (foundValid ? better : better || valid) {
			best = parsed;
			foundValid ||= valid;
		}
	}
	return best?.date;
}
