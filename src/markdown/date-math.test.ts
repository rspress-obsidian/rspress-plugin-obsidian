import { describe, expect, test } from "bun:test";
import {
	type DurationGrammar,
	type DurationUnit,
	dayOfYear,
	daysInMonth,
	endOf,
	humanizeDuration,
	isoWeek,
	localDate,
	luxonDiff,
	luxonPlus,
	momentAdd,
	momentDiff,
	momentFrom,
	momentUnitSpan,
	normalizeMomentUnit,
	scanDuration,
	shiftDate,
	startOf,
} from "./date-math.js";

/** Run `body` with the process in time zone `zone`, then restore the zone the tests run in. */
function inZone(zone: string, body: () => void): void {
	const previous = process.env.TZ;
	process.env.TZ = zone;
	try {
		body();
	} finally {
		if (previous === undefined) delete process.env.TZ;
		else process.env.TZ = previous;
	}
}

/** `YYYY-MM-DD HH:mm:ss.SSS` in local time, so failures read as calendar dates. */
function show(date: Date): string {
	const pad = (value: number, length = 2) => String(value).padStart(length, "0");
	return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

const months = (count: number) => ({ months: count, days: 0, milliseconds: 0 });
const days = (count: number) => ({ months: 0, days: count, milliseconds: 0 });
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("calendar", () => {
	test("month lengths follow the Gregorian leap rule, and a month index may overflow into other years", () => {
		expect(daysInMonth(2024, 1)).toBe(29);
		expect(daysInMonth(2023, 1)).toBe(28);
		expect(daysInMonth(2000, 1)).toBe(29);
		expect(daysInMonth(1900, 1)).toBe(28);
		expect(daysInMonth(2023, 13)).toBe(29); // February 2024
		expect(daysInMonth(2024, -1)).toBe(31); // December 2023
		expect(daysInMonth(2024, 3)).toBe(30);
		expect(daysInMonth(2024, 6)).toBe(31);
	});

	test("a year below 100 stays that year instead of turning into 19xx", () => {
		expect(localDate(5, 0, 1).getFullYear()).toBe(5);
		expect(localDate(24, 1, 29).getDate()).toBe(29);
		expect(localDate(2024, 0, 32).getMonth()).toBe(1);
		expect(dayOfYear(localDate(4, 11, 31))).toBe(366);
	});

	test("day of year and ISO week, across year boundaries", () => {
		expect(dayOfYear(new Date(2024, 11, 31, 23, 0))).toBe(366);
		expect(dayOfYear(new Date(2023, 0, 1))).toBe(1);
		expect(isoWeek(new Date(2021, 0, 3))).toEqual({ week: 53, year: 2020 });
		expect(isoWeek(new Date(2024, 11, 30))).toEqual({ week: 1, year: 2025 });
		expect(isoWeek(new Date(2024, 4, 15))).toEqual({ week: 20, year: 2024 });
	});
});

describe("momentAdd", () => {
	test("months clamp to the last day of the target month", () => {
		expect(show(momentAdd(new Date(2024, 0, 31), months(1)))).toBe("2024-02-29 00:00:00.000");
		expect(show(momentAdd(new Date(2023, 0, 31), months(1)))).toBe("2023-02-28 00:00:00.000");
		expect(show(momentAdd(new Date(2024, 2, 31), months(1), -1))).toBe("2024-02-29 00:00:00.000");
		expect(show(momentAdd(new Date(2024, 4, 31, 9, 30), months(-3)))).toBe(
			"2024-02-29 09:30:00.000",
		);
	});

	test("a leap day plus a year is February 28; plus four years it is a leap day again", () => {
		expect(show(momentAdd(new Date(2024, 1, 29), momentUnitSpan("year", 1)))).toBe(
			"2025-02-28 00:00:00.000",
		);
		expect(show(momentAdd(new Date(2024, 1, 29), momentUnitSpan("year", 4)))).toBe(
			"2028-02-29 00:00:00.000",
		);
		expect(show(momentAdd(new Date(2024, 1, 29), momentUnitSpan("year", 1), -1))).toBe(
			"2023-02-28 00:00:00.000",
		);
	});

	test("months move first, then days, then time — moment's order", () => {
		// Jan 30 + 1 month is Feb 29, + 1 day is Mar 1 (days first would clamp Jan 31 to Feb 29).
		expect(show(momentAdd(new Date(2024, 0, 30), { months: 1, days: 1, milliseconds: 0 }))).toBe(
			"2024-03-01 00:00:00.000",
		);
		expect(
			show(momentAdd(new Date(2024, 0, 31, 23), { months: 1, days: 0, milliseconds: 2 * HOUR })),
		).toBe("2024-03-01 01:00:00.000");
	});

	test("fractional months and days round half away from zero; time stays exact", () => {
		expect(show(momentAdd(new Date(2024, 0, 31), days(1.5)))).toBe("2024-02-02 00:00:00.000");
		expect(show(momentAdd(new Date(2024, 0, 31), days(1.5), -1))).toBe("2024-01-29 00:00:00.000");
		expect(show(momentAdd(new Date(2024, 0, 31), days(-0.5)))).toBe("2024-01-30 00:00:00.000");
		expect(show(momentAdd(new Date(2024, 0, 31), months(1.5)))).toBe("2024-03-31 00:00:00.000");
		expect(
			show(momentAdd(new Date(2024, 0, 31), { months: 0, days: 0, milliseconds: 1.5 * HOUR })),
		).toBe("2024-01-31 01:30:00.000");
	});

	test("units: a quarter is three months, a week seven days, and `date` adds nothing", () => {
		const start = new Date(2024, 0, 31);
		expect(show(momentAdd(start, momentUnitSpan("quarter", 1)))).toBe("2024-04-30 00:00:00.000");
		expect(show(momentAdd(start, momentUnitSpan("isoWeek", 1)))).toBe("2024-02-07 00:00:00.000");
		expect(show(momentAdd(start, momentUnitSpan("date", 5)))).toBe("2024-01-31 00:00:00.000");
		expect(show(momentAdd(start, momentUnitSpan("minute", 90)))).toBe("2024-01-31 01:30:00.000");
		expect(shiftDate(start, { months: 0, days: 0, milliseconds: 0 })).not.toBe(start);
	});
});

describe("normalizeMomentUnit", () => {
	test("reads moment's aliases: shorthand as written, names and plurals in any case", () => {
		expect(normalizeMomentUnit("M")).toBe("month");
		expect(normalizeMomentUnit("m")).toBe("minute");
		expect(normalizeMomentUnit("Days")).toBe("day");
		expect(normalizeMomentUnit("W")).toBe("isoWeek");
		expect(normalizeMomentUnit("isoWeek")).toBe("isoWeek");
		expect(normalizeMomentUnit("D")).toBe("date");
		expect(normalizeMomentUnit("Y")).toBe("year");
		expect(normalizeMomentUnit("q")).toBeUndefined();
		expect(normalizeMomentUnit("constructor")).toBeUndefined();
		expect(normalizeMomentUnit("fortnight")).toBeUndefined();
	});
});

describe("luxonPlus", () => {
	test("months clamp, then days move on, both on the wall clock", () => {
		expect(show(luxonPlus(new Date(2024, 0, 31, 8), { months: 1 }))).toBe(
			"2024-02-29 08:00:00.000",
		);
		expect(show(luxonPlus(new Date(2024, 0, 30), { months: 1, days: 1 }))).toBe(
			"2024-03-01 00:00:00.000",
		);
		expect(show(luxonPlus(new Date(2024, 1, 29), { years: 1 }))).toBe("2025-02-28 00:00:00.000");
		expect(show(luxonPlus(new Date(2024, 2, 31), { months: 1 }, -1))).toBe(
			"2024-02-29 00:00:00.000",
		);
	});

	test("fractions are exact time at casual lengths (365-day year, 30-day month)", () => {
		expect(show(luxonPlus(new Date(2024, 0, 31), { years: 1.5 }))).toBe("2025-08-01 12:00:00.000");
		expect(show(luxonPlus(new Date(2024, 0, 31), { months: 1.5 }))).toBe("2024-03-15 00:00:00.000");
		expect(show(luxonPlus(new Date(2024, 0, 31), { weeks: 1.5 }))).toBe("2024-02-10 12:00:00.000");
		expect(show(luxonPlus(new Date(2024, 0, 31), { days: 1.5 }, -1))).toBe(
			"2024-01-29 12:00:00.000",
		);
		expect(show(luxonPlus(new Date(2024, 0, 31), { hours: 25, minutes: 1, seconds: 1 }))).toBe(
			"2024-02-01 01:01:01.000",
		);
	});
});

describe("startOf / endOf", () => {
	const wednesday = new Date(2024, 4, 15, 14, 5, 30, 250);

	test("a week starts on Sunday, an ISO week on Monday", () => {
		expect(show(startOf(wednesday, "week"))).toBe("2024-05-12 00:00:00.000");
		expect(show(endOf(wednesday, "week"))).toBe("2024-05-18 23:59:59.999");
		expect(show(startOf(wednesday, "isoWeek"))).toBe("2024-05-13 00:00:00.000");
		expect(show(endOf(wednesday, "isoWeek"))).toBe("2024-05-19 23:59:59.999");
	});

	test("calendar units end on their last millisecond, February by the leap rule", () => {
		expect(show(endOf(new Date(2024, 1, 10), "month"))).toBe("2024-02-29 23:59:59.999");
		expect(show(endOf(new Date(2023, 1, 10), "month"))).toBe("2023-02-28 23:59:59.999");
		expect(show(startOf(wednesday, "quarter"))).toBe("2024-04-01 00:00:00.000");
		expect(show(endOf(wednesday, "quarter"))).toBe("2024-06-30 23:59:59.999");
		expect(show(startOf(wednesday, "year"))).toBe("2024-01-01 00:00:00.000");
		expect(show(endOf(wednesday, "year"))).toBe("2024-12-31 23:59:59.999");
		expect(show(endOf(wednesday, "date"))).toBe("2024-05-15 23:59:59.999");
	});

	test("clock units cut the time; a millisecond changes nothing", () => {
		expect(show(startOf(wednesday, "hour"))).toBe("2024-05-15 14:00:00.000");
		expect(show(endOf(wednesday, "minute"))).toBe("2024-05-15 14:05:59.999");
		expect(show(startOf(wednesday, "second"))).toBe("2024-05-15 14:05:30.000");
		expect(show(startOf(wednesday, "millisecond"))).toBe(show(wednesday));
		expect(show(endOf(wednesday, "millisecond"))).toBe(show(wednesday));
	});
});

describe("momentDiff", () => {
	test("months anchor on the later day of month, as moment's month ends compare", () => {
		const january31 = new Date(2024, 0, 31);
		const february29 = new Date(2024, 1, 29);
		expect(momentDiff(january31, february29, "month")).toBe(-1);
		expect(momentDiff(february29, january31, "month")).toBe(1);
		expect(momentDiff(new Date(2025, 2, 1), new Date(2024, 4, 1), "month")).toBe(10);
		expect(momentDiff(new Date(2024, 4, 15), new Date(2023, 4, 16), "year")).toBe(0);
		expect(momentDiff(new Date(2024, 4, 15), new Date(2024, 0, 15), "quarter")).toBe(1);
	});

	test("truncates toward zero, or gives the fraction", () => {
		const start = new Date(2024, 4, 1);
		expect(momentDiff(new Date(2024, 4, 2, 18), start, "day")).toBe(1);
		expect(momentDiff(start, new Date(2024, 4, 2, 18), "day")).toBe(-1);
		expect(momentDiff(new Date(2024, 4, 2, 18), start, "day", true)).toBe(1.75);
		expect(momentDiff(new Date(2024, 4, 16, 12), new Date(2024, 4, 1), "month", true)).toBeCloseTo(
			// Linear across the month before the anchor: 15.5 days of April's 30.
			15.5 / 30,
		);
		expect(momentDiff(new Date(2024, 4, 15), start, "week")).toBe(2);
		expect(momentDiff(new Date(2024, 4, 1, 2, 30), start, "hour")).toBe(2);
		expect(momentDiff(new Date(2024, 4, 1, 0, 2, 30), start, "minute")).toBe(2);
		expect(momentDiff(new Date(2024, 4, 1, 0, 0, 2, 500), start, "second")).toBe(2);
	});

	test("no unit, `date` and `isoWeek` count milliseconds, as moment's diff has no case for them", () => {
		const start = new Date(2024, 4, 1);
		const later = new Date(2024, 4, 3);
		expect(momentDiff(later, start)).toBe(2 * DAY);
		expect(momentDiff(later, start, "date")).toBe(2 * DAY);
		expect(momentDiff(later, start, "isoWeek")).toBe(2 * DAY);
	});
});

describe("luxonDiff", () => {
	test("whole months, then whole days, then the time left", () => {
		expect(luxonDiff(new Date(2024, 2, 1), new Date(2024, 0, 31))).toEqual({
			months: 1,
			days: 1,
			milliseconds: 0,
		});
		expect(luxonDiff(new Date(2024, 4, 15, 12), new Date(2023, 4, 15, 18))).toEqual({
			months: 11,
			days: 29,
			milliseconds: 18 * HOUR,
		});
		expect(luxonDiff(new Date(2024, 4, 15), new Date(2024, 4, 15))).toEqual({
			months: 0,
			days: 0,
			milliseconds: 0,
		});
	});
});

describe("humanizeDuration", () => {
	const time = (milliseconds: number) => humanizeDuration({ months: 0, days: 0, milliseconds });

	test("seconds and minutes switch at moment's 45-second and 45-minute thresholds", () => {
		expect(time(44 * SECOND)).toBe("a few seconds");
		expect(time(44.4 * SECOND)).toBe("a few seconds");
		expect(time(44.5 * SECOND)).toBe("a minute");
		expect(time(89 * SECOND)).toBe("a minute");
		expect(time(90 * SECOND)).toBe("2 minutes");
		expect(time(44 * MINUTE)).toBe("44 minutes");
		expect(time(45 * MINUTE)).toBe("an hour");
	});

	test("hours switch to a day at 22 hours, days to a month at 26 days", () => {
		expect(time(89 * MINUTE)).toBe("an hour");
		expect(time(90 * MINUTE)).toBe("2 hours");
		expect(time(21 * HOUR)).toBe("21 hours");
		expect(time(22 * HOUR)).toBe("a day");
		expect(time(35 * HOUR)).toBe("a day");
		expect(time(36 * HOUR)).toBe("2 days");
		expect(time(25 * DAY)).toBe("25 days");
		expect(time(26 * DAY)).toBe("a month");
		expect(time(45 * DAY)).toBe("a month");
		expect(time(46 * DAY)).toBe("2 months");
	});

	test("months switch to a year at 11 months; years round", () => {
		expect(humanizeDuration(months(10))).toBe("10 months");
		expect(humanizeDuration(months(11))).toBe("a year");
		expect(humanizeDuration(months(17))).toBe("a year");
		expect(humanizeDuration(months(18))).toBe("2 years");
		expect(humanizeDuration(months(-30))).toBe("3 years");
	});

	test("each bucket counts by its size, so mixed signs do not cancel", () => {
		expect(humanizeDuration({ months: 1, days: -10, milliseconds: 0 })).toBe("a month");
		expect(humanizeDuration({ months: 0, days: -3, milliseconds: -2 * HOUR })).toBe("3 days");
		expect(humanizeDuration({ months: 0, days: 0, milliseconds: 0 })).toBe("a few seconds");
	});
});

describe("momentFrom", () => {
	test("counts calendar months, then the time left", () => {
		// 1 month and 15 days: "a month"; as 46 plain days it would be "2 months".
		expect(momentFrom(new Date(2024, 1, 16), new Date(2024, 0, 1))).toBe("in a month");
		expect(momentFrom(new Date(2024, 0, 1), new Date(2024, 1, 16))).toBe("a month ago");
		expect(momentFrom(new Date(2025, 2, 2), new Date(2024, 4, 2))).toBe("in 10 months");
		expect(momentFrom(new Date(2021, 4, 2), new Date(2024, 4, 2))).toBe("3 years ago");
	});

	test("the same instant reads as past, as in moment", () => {
		const now = new Date(2024, 4, 2, 9);
		expect(momentFrom(now, now)).toBe("a few seconds ago");
		expect(momentFrom(new Date(now.getTime() + 30 * SECOND), now)).toBe("in a few seconds");
		expect(momentFrom(new Date(now.getTime() - 3 * HOUR), now)).toBe("3 hours ago");
	});
});

describe("scanDuration", () => {
	const units: Record<string, DurationUnit> = { d: "days", h: "hours", m: "minutes" };
	const grammar: DurationGrammar = {
		part: /(-?\d+(?:\.\d+)?)\s*([a-z]+)/y,
		separator: /\s*,?\s*/y,
		unit: (spelling) => (Object.hasOwn(units, spelling) ? units[spelling] : undefined),
	};

	test("adds up repeated units and reports where the duration ends", () => {
		expect(scanDuration("1h 30m, 15m left", 0, grammar)).toEqual({
			parts: { hours: 1, minutes: 45 },
			end: 11,
		});
		expect(scanDuration("in 2d", 3, grammar)).toEqual({ parts: { days: 2 }, end: 5 });
		expect(scanDuration("-1.5h", 0, grammar)).toEqual({ parts: { hours: -1.5 }, end: 5 });
	});

	test("stops at a unit the language does not know, and finds nothing when no part starts", () => {
		expect(scanDuration("2d 3x", 0, grammar)).toEqual({ parts: { days: 2 }, end: 2 });
		expect(scanDuration("3x", 0, grammar)).toBeUndefined();
		expect(scanDuration("soon", 0, grammar)).toBeUndefined();
	});
});

describe("across a DST change (America/New_York)", () => {
	test("calendar days keep the wall clock; hours are exact time", () => {
		inZone("America/New_York", () => {
			// 10 March 2024: clocks jump from 02:00 to 03:00.
			const noon = new Date(2024, 2, 9, 12);
			expect(show(momentAdd(noon, days(1)))).toBe("2024-03-10 12:00:00.000");
			expect(show(momentAdd(noon, momentUnitSpan("hour", 24)))).toBe("2024-03-10 13:00:00.000");
			expect(show(luxonPlus(noon, { days: 1 }))).toBe("2024-03-10 12:00:00.000");
			expect(show(luxonPlus(noon, { hours: 24 }))).toBe("2024-03-10 13:00:00.000");
		});
	});

	test("a 23-hour day still counts as one day", () => {
		inZone("America/New_York", () => {
			const before = new Date(2024, 2, 10);
			const after = new Date(2024, 2, 11);
			expect(after.getTime() - before.getTime()).toBe(23 * HOUR);
			expect(momentDiff(after, before, "day")).toBe(1);
			expect(momentDiff(before, after, "day")).toBe(-1);
			expect(momentDiff(new Date(2024, 2, 17), before, "week")).toBe(1);
			expect(luxonDiff(after, before)).toEqual({ months: 0, days: 1, milliseconds: 0 });
			expect(dayOfYear(after)).toBe(71);
		});
	});

	test("Luxon lands a skipped time after the gap and keeps the offset of an ambiguous one", () => {
		inZone("America/New_York", () => {
			// 02:30 on 10 March 2024 does not exist: it reads as 03:30.
			expect(show(luxonPlus(new Date(2024, 1, 10, 2, 30), { months: 1 }))).toBe(
				"2024-03-10 03:30:00.000",
			);
			// 01:30 on 3 November 2024 happens twice; each side keeps its own offset.
			const fromSummer = luxonPlus(new Date(2024, 9, 3, 1, 30), { months: 1 });
			const fromWinter = luxonPlus(new Date(2024, 11, 3, 1, 30), { months: 1 }, -1);
			expect(fromSummer.toISOString()).toBe("2024-11-03T05:30:00.000Z");
			expect(fromWinter.toISOString()).toBe("2024-11-03T06:30:00.000Z");
		});
	});

	test("moment's start of an hour stays in the hour's own offset", () => {
		inZone("America/New_York", () => {
			// The second 01:30 on 3 November 2024 (EST, UTC-5).
			const repeated = new Date(Date.UTC(2024, 10, 3, 6, 30));
			expect(startOf(repeated, "hour").toISOString()).toBe("2024-11-03T06:00:00.000Z");
			expect(endOf(repeated, "hour").toISOString()).toBe("2024-11-03T06:59:59.999Z");
			expect(show(endOf(new Date(2024, 2, 10, 12), "day"))).toBe("2024-03-10 23:59:59.999");
		});
	});
});
