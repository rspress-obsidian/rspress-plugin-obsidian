/**
 * The slice of moment.js Templater exposes: `tp.date.*` is built on it, and
 * execution commands call the `moment` global directly
 * (`moment(tp.file.title, "YYYY-MM-DD").startOf("month").format(…)`).
 *
 * Formatting and strict parsing reuse the daily-notes Moment implementation,
 * and arithmetic is moment's own from `date-math.ts` — months clamped to the
 * month's last day, then days, then time — in local time, with moment's
 * default (`en`) locale, whose week starts on Sunday.
 */
import {
	formatDailyNoteDate,
	type MomentParseOptions,
	parseMomentDate,
} from "../../daily-notes.js";
import {
	endOf,
	type MomentUnit,
	momentAdd,
	momentDiff,
	momentUnitSpan,
	normalizeMomentUnit,
	startOf,
} from "../../date-math.js";
import { HostFunction, HostValue, TemplaterError, toTemplateString } from "./interpreter.js";

/** A moment duration, in the buckets moment adds it by. */
export interface MomentDuration {
	months: number;
	days: number;
	milliseconds: number;
}

/** moment's unit for `name` (`"d"`, `"days"`, `"day"` → `"day"`). */
function unitOf(name: unknown): MomentUnit | undefined {
	return normalizeMomentUnit(String(name ?? ""));
}

const ISO_DURATION =
	/^([+-])?P(?:(-?\d+(?:[.,]\d+)?)Y)?(?:(-?\d+(?:[.,]\d+)?)M)?(?:(-?\d+(?:[.,]\d+)?)W)?(?:(-?\d+(?:[.,]\d+)?)D)?(?:T(?:(-?\d+(?:[.,]\d+)?)H)?(?:(-?\d+(?:[.,]\d+)?)M)?(?:(-?\d+(?:[.,]\d+)?)S)?)?$/;
const CLOCK_DURATION = /^([+-])?(?:(\d+)\.)?(\d+):(\d+)(?::(\d+)(?:\.(\d+))?)?$/;

/**
 * `moment.duration(text)`: an ISO 8601 duration (`P1Y`, `P-1M`, `PT2H`) or a
 * clock span (`1.02:30:00`). Anything else is moment's zero duration.
 */
export function parseMomentDuration(text: string): MomentDuration {
	const iso = ISO_DURATION.exec(text.trim());
	if (iso && text.trim() !== "P") {
		const sign = iso[1] === "-" ? -1 : 1;
		const part = (index: number) => sign * Number((iso[index] ?? "0").replace(",", "."));
		return {
			months: part(2) * 12 + part(3),
			days: part(4) * 7 + part(5),
			milliseconds: part(6) * 3_600_000 + part(7) * 60_000 + Math.round(part(8) * 1000),
		};
	}
	const clock = CLOCK_DURATION.exec(text.trim());
	if (clock) {
		const sign = clock[1] === "-" ? -1 : 1;
		return {
			months: 0,
			days: sign * Number(clock[2] ?? 0),
			milliseconds:
				sign *
				(Number(clock[3]) * 3_600_000 +
					Number(clock[4]) * 60_000 +
					Number(clock[5] ?? 0) * 1000 +
					Number((clock[6] ?? "0").padEnd(3, "0").slice(0, 3))),
		};
	}
	return { months: 0, days: 0, milliseconds: 0 };
}

/** `date` moved by `duration` × `sign`, as moment's `add` does. A new date. */
export function addDuration(date: Date, duration: MomentDuration, sign = 1): Date {
	return momentAdd(date, duration, sign);
}

const ISO_DATE =
	/^(\d{4})-?(\d{2})(?:-?(\d{2}))?(?:[T ](\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d+))?)?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

/**
 * `moment(text)` without a format: ISO 8601, local unless it names a zone,
 * falling back to the platform's date parser as moment does.
 */
function parseIsoDate(text: string): Date | undefined {
	const match = ISO_DATE.exec(text.trim());
	if (match) {
		const [, year, month, day, hour, minute, second, fraction, zone] = match;
		const parts = [
			Number(year),
			Number(month) - 1,
			Number(day ?? 1),
			Number(hour ?? 0),
			Number(minute ?? 0),
			Number(second ?? 0),
			Number((fraction ?? "0").padEnd(3, "0").slice(0, 3)),
		] as const;
		if (!zone) return new Date(...parts);
		const offset =
			zone.toUpperCase() === "Z"
				? 0
				: (zone.startsWith("-") ? -1 : 1) *
					(Number(zone.slice(1, 3)) * 60 + Number(zone.replace(":", "").slice(3, 5) || 0));
		return new Date(Date.UTC(...parts) - offset * 60_000);
	}
	const parsed = new Date(text);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * `moment(text, format)`: forgiving, as moment reads it, unless `strict` (the
 * `moment(text, format, true)` form). `format` may be one format or a list,
 * of which moment takes the best fit. Parts the text leaves out come from
 * `options.now`.
 */
export function parseDateText(
	text: string,
	format?: unknown,
	options: MomentParseOptions = {},
): Date | undefined {
	if (format === undefined || format === null || format === "") return parseIsoDate(text);
	const formats = (Array.isArray(format) ? format : [format]).map(toTemplateString);
	return parseMomentDate(text, formats, { strict: options.strict ?? false, now: options.now });
}

const DEFAULT_MOMENT_FORMAT = "YYYY-MM-DDTHH:mm:ssZ";

/** A moment: mutable, like moment's own (`m.add(1, "d")` changes `m`). */
export class MomentValue extends HostValue {
	readonly label = "moment";

	constructor(
		private date: Date | undefined,
		/** The template clock: what `isBefore()` and `diff()` without an argument compare with. */
		private readonly now: Date,
	) {
		super();
	}

	/** The instant, or `undefined` for an invalid moment. */
	get value(): Date | undefined {
		return this.date;
	}

	override property(name: string): unknown {
		return Object.hasOwn(MOMENT_METHODS, name)
			? new HostFunction(`moment.${name}`, (args) => this.method(name, args))
			: undefined;
	}

	override primitive(): number | undefined {
		return this.date ? this.date.getTime() : Number.NaN;
	}

	override toTemplateString(): string {
		return this.date
			? formatDailyNoteDate(this.date, "ddd MMM DD YYYY HH:mm:ss [GMT]ZZ")
			: "Invalid date";
	}

	format(format?: unknown): string {
		if (!this.date) return "Invalid date";
		return formatDailyNoteDate(
			this.date,
			format === undefined || format === null ? DEFAULT_MOMENT_FORMAT : toTemplateString(format),
		);
	}

	private shift(args: unknown[], sign: number): MomentValue {
		if (!this.date) return this;
		const [amount, unitName] = args;
		const legacyUnit = typeof amount === "string" ? unitOf(amount) : undefined;
		let duration: MomentDuration;
		if (typeof amount === "string" && unitName === undefined) {
			duration = parseMomentDuration(amount);
		} else if (legacyUnit && typeof unitName === "number") {
			// moment accepts `add("days", 3)`, the old argument order.
			duration = momentUnitSpan(legacyUnit, unitName);
		} else {
			const unit = unitOf(unitName ?? "millisecond");
			if (!unit) throw new TemplaterError(`Unknown moment unit "${String(unitName)}".`);
			duration = momentUnitSpan(unit, Number(amount));
		}
		this.date = addDuration(this.date, duration, sign);
		return this;
	}

	/** A getter without an argument, a setter (returning the moment) with one. */
	private access(
		args: unknown[],
		read: (date: Date) => number,
		write: (date: Date, value: number) => void,
	): unknown {
		if (!this.date) return args.length === 0 ? Number.NaN : this;
		if (args.length === 0) return read(this.date);
		const next = new Date(this.date.getTime());
		write(next, Number(args[0]));
		this.date = next;
		return this;
	}

	private compare(args: unknown[]): { self: number; other: number } | undefined {
		const other = toDate(args[0], this.now);
		if (!this.date || !other) return undefined;
		const unit = unitOf(args[1]);
		return unit
			? { self: startOf(this.date, unit).getTime(), other: startOf(other, unit).getTime() }
			: { self: this.date.getTime(), other: other.getTime() };
	}

	override method(name: string, args: unknown[]): unknown {
		switch (name) {
			case "format":
				return this.format(args[0]);
			case "add":
				return this.shift(args, 1);
			case "subtract":
				return this.shift(args, -1);
			case "startOf":
			case "endOf": {
				const unit = unitOf(args[0]);
				if (!unit) throw new TemplaterError(`Unknown moment unit "${String(args[0])}".`);
				if (!this.date) return this;
				this.date = name === "startOf" ? startOf(this.date, unit) : endOf(this.date, unit);
				return this;
			}
			case "weekday":
			case "day":
				return this.access(
					args,
					(date) => date.getDay(),
					(date, value) => date.setDate(date.getDate() + value - date.getDay()),
				);
			case "isoWeekday":
				return this.access(
					args,
					(date) => date.getDay() || 7,
					(date, value) => date.setDate(date.getDate() + value - (date.getDay() || 7)),
				);
			case "date":
				return this.access(
					args,
					(date) => date.getDate(),
					(date, value) => date.setDate(value),
				);
			case "month":
				return this.access(
					args,
					(date) => date.getMonth(),
					(date, value) => date.setMonth(value),
				);
			case "year":
				return this.access(
					args,
					(date) => date.getFullYear(),
					(date, value) => date.setFullYear(value),
				);
			case "hour":
				return this.access(
					args,
					(date) => date.getHours(),
					(date, value) => date.setHours(value),
				);
			case "minute":
				return this.access(
					args,
					(date) => date.getMinutes(),
					(date, value) => date.setMinutes(value),
				);
			case "second":
				return this.access(
					args,
					(date) => date.getSeconds(),
					(date, value) => date.setSeconds(value),
				);
			case "isValid":
				return this.date !== undefined;
			case "isBefore": {
				const pair = this.compare(args);
				return pair ? pair.self < pair.other : false;
			}
			case "isAfter": {
				const pair = this.compare(args);
				return pair ? pair.self > pair.other : false;
			}
			case "isSame": {
				const pair = this.compare(args);
				return pair ? pair.self === pair.other : false;
			}
			case "isSameOrBefore": {
				const pair = this.compare(args);
				return pair ? pair.self <= pair.other : false;
			}
			case "isSameOrAfter": {
				const pair = this.compare(args);
				return pair ? pair.self >= pair.other : false;
			}
			case "diff": {
				const other = toDate(args[0], this.now);
				if (!this.date || !other) return Number.NaN;
				return momentDiff(this.date, other, unitOf(args[1]), Boolean(args[2]));
			}
			case "clone":
				return new MomentValue(this.date && new Date(this.date.getTime()), this.now);
			case "toDate":
				return this.date ? new Date(this.date.getTime()) : new Date(Number.NaN);
			case "valueOf":
				return this.primitive();
			case "unix":
				return this.date ? Math.floor(this.date.getTime() / 1000) : Number.NaN;
			case "toISOString":
				return this.date ? this.date.toISOString() : null;
			case "toString":
				return this.toTemplateString();
		}
		throw new TemplaterError(`Unsupported method: ${name}() on a moment.`);
	}
}

/** Names `MomentValue.method` answers, so `m.format` reads as a function. */
const MOMENT_METHODS: Record<string, true> = Object.fromEntries(
	[
		"format",
		"add",
		"subtract",
		"startOf",
		"endOf",
		"weekday",
		"day",
		"isoWeekday",
		"date",
		"month",
		"year",
		"hour",
		"minute",
		"second",
		"isValid",
		"isBefore",
		"isAfter",
		"isSame",
		"isSameOrBefore",
		"isSameOrAfter",
		"diff",
		"clone",
		"toDate",
		"valueOf",
		"unix",
		"toISOString",
		"toString",
	].map((name) => [name, true]),
);

/** The instant a moment argument names (a moment, a date, a timestamp or ISO text). */
function toDate(value: unknown, now: Date): Date | undefined {
	if (value === undefined || value === null) return now;
	if (value instanceof MomentValue) return value.value;
	if (value instanceof Date) return value;
	if (typeof value === "number") return new Date(value);
	if (typeof value === "string") return parseIsoDate(value);
	return undefined;
}

/**
 * The `moment` global: `moment()` is the template clock `now`, `moment(text,
 * format)` parses forgivingly with the Moment format (or the best of a list),
 * strictly with a `true` after the format (or after a locale), and
 * `moment(text)` reads ISO 8601.
 */
export function momentFunction(now: Date): HostFunction {
	return new HostFunction("moment", ([value, format, localeOrStrict, strict]) => {
		if (value === undefined || value === null) return new MomentValue(new Date(now.getTime()), now);
		if (value instanceof MomentValue) {
			return new MomentValue(value.value && new Date(value.value.getTime()), now);
		}
		if (value instanceof Date) return new MomentValue(new Date(value.getTime()), now);
		if (typeof value === "number") return new MomentValue(new Date(value), now);
		const options = { strict: localeOrStrict === true || strict === true, now };
		return new MomentValue(parseDateText(toTemplateString(value), format, options), now);
	});
}
