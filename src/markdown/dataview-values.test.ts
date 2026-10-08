import { describe, expect, test } from "bun:test";
import {
	addDuration,
	DataviewDuration,
	dateShorthand,
	diffDates,
	formatLuxonDate,
	matchDurationPrefix,
	parseDateLiteral,
	parseDatePlus,
	parseDuration,
} from "./dataview-values";

describe("date literals", () => {
	test("an IANA zone suffix reads the wall time in that zone, across DST", () => {
		expect(parseDateLiteral("2021-07-01T12:00:00[America/New_York]")?.toISOString()).toBe(
			"2021-07-01T16:00:00.000Z",
		);
		expect(parseDateLiteral("2021-01-01T12:00:00[America/New_York]")?.toISOString()).toBe(
			"2021-01-01T17:00:00.000Z",
		);
		expect(parseDateLiteral("2021-01-01T12:00:00[Nowhere/Atlantis]")).toBeNull();
	});

	test("offsets and Z are honoured", () => {
		expect(parseDateLiteral("2021-01-01T12:00:00Z")?.toISOString()).toBe(
			"2021-01-01T12:00:00.000Z",
		);
		expect(parseDateLiteral("2021-01-01T12:00:00-05:00")?.toISOString()).toBe(
			"2021-01-01T17:00:00.000Z",
		);
	});

	test("parseDatePlus accepts shorthands and literals, trimming whitespace", () => {
		expect(parseDatePlus("  2021-03-04 ")?.getDate()).toBe(4);
		expect(parseDatePlus("today")?.getHours()).toBe(0);
		expect(parseDatePlus("nonsense")).toBeNull();
	});
});

describe("Luxon date tokens", () => {
	test("ISO week, week-year and ordinal day match Luxon", () => {
		// 2021-01-03 is a Sunday in ISO week 53 of 2020.
		const date = new Date(2021, 0, 3);
		expect(formatLuxonDate(date, "W WW kk kkkk")).toBe("53 53 20 2020");
		expect(formatLuxonDate(new Date(2021, 1, 1), "o ooo")).toBe("32 032");
	});

	test("offset tokens Z, ZZ, ZZZ share one offset in their three styles", () => {
		const date = new Date(2021, 5, 1);
		const short = formatLuxonDate(date, "ZZ");
		expect(short).toMatch(/^[+-]\d{2}:\d{2}$/);
		expect(formatLuxonDate(date, "ZZZ")).toBe(short.replace(":", ""));
		const narrow = formatLuxonDate(date, "Z");
		const [, sign, hours, minutes] = /^([+-])(\d{2}):(\d{2})$/.exec(short) ?? [];
		expect(narrow).toBe(`${sign}${Number(hours)}${minutes === "00" ? "" : `:${minutes}`}`);
	});
});

describe("date differences", () => {
	test("an earlier minus a later date is a negative duration", () => {
		const forward = diffDates(new Date(2021, 2, 1), new Date(2021, 0, 1));
		const backward = diffDates(new Date(2021, 0, 1), new Date(2021, 2, 1));
		expect(forward).toBeInstanceOf(DataviewDuration);
		expect(forward.months).toBe(2);
		expect(backward.months).toBe(-2);
		expect(backward.toMillis()).toBe(-forward.toMillis());
	});

	test("month ends: Jan 31 to Mar 1 is one month (to Feb 29) and a day", () => {
		const span = diffDates(new Date(2024, 2, 1), new Date(2024, 0, 31));
		expect([span.months, span.days]).toEqual([1, 1]);
	});
});

describe("date + duration (Luxon's plus)", () => {
	const show = (date: Date | null) => (date ? formatLuxonDate(date, "yyyy-MM-dd HH:mm") : null);
	const plus = (text: string, sign = 1) => {
		const duration = parseDuration(text);
		if (!duration) throw new Error(`not a duration: ${text}`);
		return show(addDuration(new Date(2024, 0, 31), duration, sign));
	};

	test("months clamp to the month's end; a leap day plus a year is February 28", () => {
		expect(plus("1 month")).toBe("2024-02-29 00:00");
		expect(plus("1 month, 1 day")).toBe("2024-03-01 00:00");
		expect(plus("2 months", -1)).toBe("2023-11-30 00:00");
		const leap = addDuration(new Date(2024, 1, 29), new DataviewDuration({ years: 1 }));
		expect(show(leap)).toBe("2025-02-28 00:00");
	});

	test("a fractional unit adds its whole part by the calendar and the rest as exact time", () => {
		// Luxon: 1 year, then half a 365-day year.
		expect(plus("1.5 years")).toBe("2025-08-01 12:00");
		// 1 month, then half a 30-day month.
		expect(plus("1.5 months")).toBe("2024-03-15 00:00");
		expect(plus("1.5 weeks")).toBe("2024-02-10 12:00");
		expect(plus("2h30m")).toBe("2024-01-31 02:30");
	});

	test("duration text: parts by comma or space, the whole text or the longest prefix", () => {
		expect(parseDuration("1 year, 2 months")).toEqual(
			new DataviewDuration({ years: 1, months: 2 }),
		);
		expect(parseDuration("2h30m")).toEqual(new DataviewDuration({ hours: 2, minutes: 30 }));
		expect(parseDuration("1 day,")).toBeNull();
		expect(parseDuration("")).toBeNull();
		expect(matchDurationPrefix("x = 3 days + 1", 4)).toEqual({
			duration: new DataviewDuration({ days: 3 }),
			end: 10,
		});
		expect(matchDurationPrefix("x = soon", 4)).toBeUndefined();
	});

	test("week shorthands use Luxon's Monday week", () => {
		const wednesday = new Date(2024, 4, 15, 14);
		expect(show(dateShorthand("sow", wednesday))).toBe("2024-05-13 00:00");
		expect(show(dateShorthand("eow", wednesday))).toBe("2024-05-19 23:59");
		expect(show(dateShorthand("yesterday", wednesday))).toBe("2024-05-14 00:00");
		expect(show(dateShorthand("eoy", wednesday))).toBe("2024-12-31 23:59");
	});
});
