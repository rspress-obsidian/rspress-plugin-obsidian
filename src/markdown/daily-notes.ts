import { escapeHtmlText } from "../shared/escape.js";
import { escapeRegExp, MONTH_NAMES, WEEKDAY_NAMES } from "./dataview-values.js";
import {
	DAY_MS,
	dayOfYear,
	isoWeek,
	isoWeekOneMonday,
	localDate,
	momentAdd,
	momentUnitSpan,
	normalizeMomentUnit,
	startOf,
} from "./date-math.js";
import type { AdditionalPage } from "./tag-pages.js";
import type { ContentIndex, ContentPage } from "./types.js";
import { routeHref } from "./utils.js";

export interface DailyNoteConfig {
	folder: string;
	dateFormat: string;
	navigation: boolean;
	/** Vault-relative path of a note used as the body of an empty daily note. */
	template: string;
	/** Route of the generated calendar page; empty when no calendar is wanted. */
	calendar: string;
}

/**
 * Moment.js format tokens (Obsidian's daily notes format with Moment), longest
 * first so `YYYY` is never read as two `YY`s. `[…]` is an escaped literal.
 * Dates are local wall-clock dates, the same time model Dataview uses, so a
 * note named `2026-01-05` is January 5 whatever the build machine's zone.
 */
const MOMENT_TOKEN =
	/\[[^\]]*\]|YYYYYY|YYYY|YY|Y|Qo|Q|MMMM|MMM|Mo|MM|M|DDDD|DDDo|DDD|Do|DD|D|dddd|ddd|dd|do|d|E|e|gggg|gg|GGGG|GG|wo|ww|w|Wo|WW|W|HH|H|hh|h|kk|k|mm|m|ss|s|SSS|SS|S|A|a|X|x|ZZ|Z/g;

const SHORT_WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const dateFormatMatchers = new Map<string, { regex: RegExp; tokens: string[] }>();

export function normalizeDailyNoteConfig(config?: Partial<DailyNoteConfig>): DailyNoteConfig {
	return {
		folder: config?.folder?.replace(/^\/|\/$/g, "") ?? "",
		dateFormat: config?.dateFormat ?? "YYYY-MM-DD",
		navigation: config?.navigation ?? true,
		template: config?.template?.replace(/^\/|\/$/g, "") ?? "",
		calendar: normalizeCalendarRoute(config?.calendar),
	};
}

function pad(value: number, length = 2): string {
	return String(value).padStart(length, "0");
}

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
	return `${sign}${pad(Math.floor(Math.abs(minutes) / 60))}${separator}${pad(Math.abs(minutes) % 60)}`;
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
			return `${year < 0 ? "-" : "+"}${pad(Math.abs(year), 6)}`;
		case "YYYY":
			return pad(year, 4);
		case "YY":
			return pad(year % 100);
		case "Y":
			// Moment: four digits up to 9999, then a forced sign.
			return year <= 9999 ? `${year < 0 ? "-" : ""}${pad(Math.abs(year), 4)}` : `+${year}`;
		case "Q":
			return String(Math.floor(month / 3) + 1);
		case "Qo":
			return ordinal(Math.floor(month / 3) + 1);
		case "M":
			return String(month + 1);
		case "Mo":
			return ordinal(month + 1);
		case "MM":
			return pad(month + 1);
		case "MMM":
			return (MONTH_NAMES[month] ?? "").slice(0, 3);
		case "MMMM":
			return MONTH_NAMES[month] ?? "";
		case "D":
			return String(day);
		case "Do":
			return ordinal(day);
		case "DD":
			return pad(day);
		case "DDD":
			return String(dayOfYear(date));
		case "DDDo":
			return ordinal(dayOfYear(date));
		case "DDDD":
			return pad(dayOfYear(date), 3);
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
			return pad(localeWeek(date).week);
		case "gg":
			return pad(localeWeek(date).year % 100);
		case "gggg":
			return pad(localeWeek(date).year, 4);
		case "W":
			return String(isoWeek(date).week);
		case "Wo":
			return ordinal(isoWeek(date).week);
		case "WW":
			return pad(isoWeek(date).week);
		case "GG":
			return pad(isoWeek(date).year % 100);
		case "GGGG":
			return pad(isoWeek(date).year, 4);
		case "H":
			return String(hour);
		case "HH":
			return pad(hour);
		case "h":
			return String(hour % 12 || 12);
		case "hh":
			return pad(hour % 12 || 12);
		case "k":
			return String(hour || 24);
		case "kk":
			return pad(hour || 24);
		case "m":
			return String(date.getMinutes());
		case "mm":
			return pad(date.getMinutes());
		case "s":
			return String(date.getSeconds());
		case "ss":
			return pad(date.getSeconds());
		case "S":
			return String(Math.floor(date.getMilliseconds() / 100));
		case "SS":
			return pad(Math.floor(date.getMilliseconds() / 10));
		case "SSS":
			return pad(date.getMilliseconds(), 3);
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
export function formatDailyNoteDate(date: Date, format: string): string {
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

function compileDateFormat(format: string): { regex: RegExp; tokens: string[] } {
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
	return { regex: new RegExp(`^${pattern}$`, "i"), tokens };
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
	if (!compiled) {
		compiled = compileDateFormat(format);
		dateFormatMatchers.set(format, compiled);
	}
	const match = compiled.regex.exec(text);
	if (!match) return undefined;
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

/** The date a daily note's path names, when it sits in the folder and matches the format. */
export function parseDailyNoteDate(
	relativePath: string,
	config: DailyNoteConfig,
): Date | undefined {
	const withoutExtension = relativePath.replace(/\.(md|mdx)$/i, "");
	const folderPrefix = config.folder ? `${config.folder}/` : "";
	if (folderPrefix && !withoutExtension.startsWith(folderPrefix)) return undefined;
	return parseMomentDate(withoutExtension.slice(folderPrefix.length), config.dateFormat);
}

/** `/daily` for `/daily`, `daily` and `/daily/` alike; empty stays empty. */
function normalizeCalendarRoute(route: string | undefined): string {
	const trimmed = (route ?? "").trim();
	if (!trimmed) return "";
	return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

/** Whether a daily note has nothing but (optional) frontmatter in its body. */
export function isEmptyDailyNoteBody(body: string): boolean {
	// Frontmatter has already been stripped by the time the remark pass sees the
	// body, so anything left is content the author wrote.
	return body.trim().length === 0;
}

/** Inputs of template expansion that are not the note's own date. */
export interface DailyTemplateOptions {
	/** The daily-note filename format: what `{{date}}` and `{{date+1d}}` render with. Default `YYYY-MM-DD`. */
	format?: string;
	/** The clock `{{time}}` reads, and whose time of day `{{date:HH:mm}}` uses. Default: now. */
	now?: Date;
}

/**
 * Apply a template note to a daily note.
 *
 * Obsidian inserts the template at the cursor, which a static build has no
 * equivalent for; the rule here is the useful one instead — a daily note whose
 * body is still empty is filled with the template, and a note the author has
 * started writing is never touched.
 */
export function applyDailyNoteTemplate(
	body: string,
	templateBody: string,
	date: Date,
	title: string,
	options: DailyTemplateOptions = {},
): string {
	if (!isEmptyDailyNoteBody(body) || templateBody.trim().length === 0) return body;
	return expandDailyTemplateTokens(templateBody, date, title, options);
}

/**
 * Every token Obsidian's daily-notes core expands when it creates a note from
 * a template: `{{title}}`, `{{date}}`, `{{time}}`, `{{yesterday}}`,
 * `{{tomorrow}}`, and `{{date|time[±N unit][:FORMAT]}}`.
 */
export function expandDailyTemplateTokens(
	value: string,
	date: Date,
	title: string,
	options: DailyTemplateOptions = {},
): string {
	const format = options.format ?? "YYYY-MM-DD";
	const shift = (days: number) =>
		formatDailyNoteDate(momentAdd(startOf(date, "day"), momentUnitSpan("day", days)), format);
	return expandDailyTemplateText(
		value.replace(/\{\{\s*date\s*\}\}/gi, title).replace(/\{\{\s*title\s*\}\}/gi, title),
		date,
		format,
		options.now,
	)
		.replace(/\{\{\s*yesterday\s*\}\}/gi, shift(-1))
		.replace(/\{\{\s*tomorrow\s*\}\}/gi, shift(1));
}

/**
 * `{{date}}`, `{{time}}` and `{{date|time[±N unit][:FORMAT]}}`. The value is the
 * note's date at the current time of day, moved by the offset (Moment units:
 * `y`, `Q`, `M` months, `w`, `d`, `h`, `m` minutes, `s`; `q` and `D` add nothing) and formatted with
 * FORMAT, else with the daily-note format; a bare `{{time}}` is the current
 * `HH:mm`.
 */
export function expandDailyTemplateText(
	value: string,
	date: Date,
	format = "YYYY-MM-DD",
	now: Date = new Date(),
): string {
	return value
		.replace(/\{\{\s*date\s*\}\}/gi, formatDailyNoteDate(date, format))
		.replace(/\{\{\s*time\s*\}\}/gi, formatDailyNoteDate(now, "HH:mm"))
		.replace(
			/\{\{\s*(?:date|time)\s*(?:([+-]\d+)([yqmwdhs]))?\s*(:.+?)?\}\}/gi,
			(_match, delta: string | undefined, unit: string | undefined, momentFormat?: string) => {
				const current = new Date(date.getTime());
				current.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), 0);
				// Obsidian calls `moment.add(amount, unit)`: `q` is no moment unit, and `D`
				// (`date`) is one a duration has no field for, so both add nothing.
				const momentUnit = unit === undefined ? undefined : normalizeMomentUnit(unit);
				const moved =
					delta && momentUnit
						? momentAdd(current, momentUnitSpan(momentUnit, Number(delta)))
						: current;
				return formatDailyNoteDate(moved, momentFormat ? momentFormat.slice(1).trim() : format);
			},
		);
}

/**
 * The dated notes in date order, plus each note's position in that order.
 * Keyed on the `pages` array identity, which is the index's own `pages` for
 * the whole build, so it is computed once per config and dropped with it.
 */
const dailyLadders = new WeakMap<
	ContentPage[],
	Map<
		string,
		{
			dated: Array<{ page: ContentPage; date: Date }>;
			positions: Map<string, { index: number; date: Date }>;
		}
	>
>();

function dailyNoteLadder(pages: ContentPage[], config: DailyNoteConfig) {
	let byFormat = dailyLadders.get(pages);
	if (!byFormat) {
		byFormat = new Map();
		dailyLadders.set(pages, byFormat);
	}
	const key = `${config.folder}\n${config.dateFormat}`;
	const cached = byFormat.get(key);
	if (cached) return cached;
	const dated = pages
		.map((page) => ({ page, date: parseDailyNoteDate(page.relativePath, config) }))
		.filter((entry): entry is { page: ContentPage; date: Date } => Boolean(entry.date))
		.sort((left, right) => left.date.getTime() - right.date.getTime());
	const positions = new Map(
		dated.map((entry, index) => [entry.page.absolutePath, { index, date: entry.date }]),
	);
	const ladder = { dated, positions };
	byFormat.set(key, ladder);
	return ladder;
}

export function renderDailyNavigation(
	currentPage: ContentPage,
	pages: ContentPage[],
	config: DailyNoteConfig,
): string {
	if (!config.navigation) return "";
	// Every daily note asks for the same thing — the vault's dated notes, in
	// date order — so this list is built once per `(pages, config)` rather
	// than once per note, and the position is a Map hit instead of a scan.
	// Together these turned an O(notes x pages) pass linear: 3578ms at 2000
	// notes before, 16ms after.
	const { dated, positions } = dailyNoteLadder(pages, config);
	const position = positions.get(currentPage.absolutePath);
	if (position === undefined) return "";
	const previous = dated[position.index - 1];
	const next = dated[position.index + 1];
	const link = (entry: { page: ContentPage; date: Date } | undefined) =>
		entry
			? `<a href="${routeHref(entry.page.routePath, entry.page.relativePath)}">${escapeHtmlText(formatDailyNoteDate(entry.date, config.dateFormat))}</a>`
			: `<span class="daily-notes-placeholder"></span>`;
	return `<nav class="obsidian-daily-navigation" aria-label="Daily notes navigation"><span class="daily-notes-previous">${link(previous)}</span><span class="daily-notes-current">${escapeHtmlText(formatDailyNoteDate(position.date, config.dateFormat))}</span><span class="daily-notes-next">${link(next)}</span></nav>`;
}

/**
 * Generate the daily-notes calendar page.
 *
 * Obsidian's daily-notes core offers a calendar that opens a note by clicking a
 * day; a published site can offer the same reachability as an index of every
 * daily note, grouped by month and newest first. The route comes from
 * `dailyNotes.calendar`, and nothing is generated when it is empty.
 */
export function generateDailyNoteCalendar(
	index: ContentIndex,
	config: DailyNoteConfig,
): AdditionalPage[] {
	if (!config.calendar) return [];

	const dated = [...dailyNoteLadder(index.pages, config).dated].reverse();
	if (dated.length === 0) return [];

	const months = new Map<string, typeof dated>();
	for (const entry of dated) {
		const key = formatDailyNoteDate(entry.date, "MMMM YYYY");
		const bucket = months.get(key);
		if (bucket) bucket.push(entry);
		else months.set(key, [entry]);
	}

	const lines: string[] = [
		"---",
		`title: "Daily notes"`,
		"---",
		"",
		"# Daily notes",
		"",
		`${dated.length} daily note${dated.length === 1 ? "" : "s"}, newest first.`,
		"",
	];
	for (const [month, entries] of months) {
		lines.push(`## ${month}`, "");
		for (const { page, date } of entries) {
			const day = formatDailyNoteDate(date, "dddd");
			const title = page.title ?? page.baseName;
			const label2 =
				title === formatDailyNoteDate(date, config.dateFormat)
					? day
					: `${day} — ${escapeMarkdownLabel(title)}`;
			lines.push(
				`- [${label2}](${escapeMarkdownDestination(routeHref(page.routePath, page.relativePath))})`,
			);
		}
		lines.push("");
	}

	return [{ routePath: config.calendar, content: lines.join("\n") }];
}

function escapeMarkdownLabel(value: string): string {
	return value.replace(/([\\[\]])/g, "\\$1");
}

function escapeMarkdownDestination(value: string): string {
	return value.replace(/[()\s<>"']/g, encodeURIComponent);
}
