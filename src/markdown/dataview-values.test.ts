import { describe, expect, test } from "bun:test";
import {
	addDuration,
	compareValues,
	DataviewDuration,
	DataviewExternalLink,
	DataviewFunction,
	DataviewLink,
	DataviewListPair,
	dateShorthand,
	diffDates,
	formatLuxonDate,
	isTruthy,
	matchDurationPrefix,
	parseDateLiteral,
	parseDatePlus,
	parseDuration,
	parseWithLuxonFormat,
	valueToString,
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

	// Wednesday, 2026-08-05 14:03:09.007 local time.
	const afternoon = new Date(2026, 7, 5, 14, 3, 9, 7);

	test("time, weekday and month tokens", () => {
		expect(formatLuxonDate(afternoon, "S SSS s ss m mm h hh H HH a d dd")).toBe(
			"7 007 9 09 3 03 2 02 14 14 PM 5 05",
		);
		expect(formatLuxonDate(afternoon, "c E ccc EEE cccc EEEE ccccc EEEEE")).toBe(
			"3 3 Wed Wed Wednesday Wednesday W W",
		);
		expect(formatLuxonDate(afternoon, "L M LL MM LLL MMM LLLL MMMM LLLLL MMMMM")).toBe(
			"8 8 08 08 Aug Aug August August A A",
		);
		expect(formatLuxonDate(new Date(2026, 0, 1), "h hh a")).toBe("12 12 AM");
	});

	test("year, era, quarter and epoch tokens", () => {
		expect(formatLuxonDate(afternoon, "y yy yyyy yyyyyy G q qq")).toBe(
			"2026 26 2026 002026 AD 3 03",
		);
		expect(formatLuxonDate(afternoon, "GG")).toBe("Anno Domini");
		expect(formatLuxonDate(afternoon, "X")).toBe(String(Math.floor(afternoon.getTime() / 1000)));
		expect(formatLuxonDate(afternoon, "x")).toBe(String(afternoon.getTime()));
		expect(formatLuxonDate(afternoon, "z")).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
	});

	test("localized macro tokens", () => {
		expect(formatLuxonDate(afternoon, "D")).toBe("8/5/2026");
		expect(formatLuxonDate(afternoon, "DD")).toBe("Aug 5, 2026");
		expect(formatLuxonDate(afternoon, "DDD")).toBe("August 5, 2026");
		expect(formatLuxonDate(afternoon, "DDDD")).toBe("Wednesday, August 5, 2026");
		expect(formatLuxonDate(afternoon, "t|tt|T|TT")).toBe("2:03 PM|2:03:09 PM|14:03|14:03:09");
		expect(formatLuxonDate(afternoon, "f")).toBe("8/5/2026, 2:03 PM");
		expect(formatLuxonDate(afternoon, "ff")).toBe("Aug 5, 2026, 2:03 PM");
		expect(formatLuxonDate(afternoon, "fff")).toBe("August 5, 2026 at 2:03 PM");
	});
});

describe("parsing with a Luxon format", () => {
	test("month names, 12-hour clock and milliseconds", () => {
		expect(
			parseWithLuxonFormat("August 5, 2026 2:03:09.007 PM", "MMMM d, yyyy h:mm:ss.SSS a"),
		).toEqual(new Date(2026, 7, 5, 14, 3, 9, 7));
		expect(parseWithLuxonFormat("aug 05 26", "MMM dd yy")).toEqual(new Date(2026, 7, 5));
		expect(parseWithLuxonFormat("5 8 2026 7", "d M y S")).toEqual(new Date(2026, 7, 5, 0, 0, 0, 7));
	});

	test("12 AM is midnight and a missing year is the current one", () => {
		expect(parseWithLuxonFormat("12:30 AM", "hh:mm a")).toEqual(
			new Date(new Date().getFullYear(), 0, 1, 0, 30),
		);
	});

	test("weekday names must match but do not move the date", () => {
		expect(parseWithLuxonFormat("Wed 2026-08-05", "EEE yyyy-MM-dd")).toEqual(new Date(2026, 7, 5));
		expect(parseWithLuxonFormat("Monday 2026-08-05", "EEEE yyyy-MM-dd")).toEqual(
			new Date(2026, 7, 5),
		);
		expect(parseWithLuxonFormat("Someday 2026-08-05", "EEEE yyyy-MM-dd")).toBeNull();
	});

	test("an impossible day is rejected", () => {
		expect(parseWithLuxonFormat("2026-02-30", "yyyy-MM-dd")).toBeNull();
	});
});

describe("truthiness", () => {
	test("empty and zero values are false; everything else is true", () => {
		const falsy = [null, undefined, 0, Number.NaN, "", false, new Date(0)];
		const emptyish = [new DataviewDuration({}), new DataviewLink(""), [], {}];
		for (const value of [...falsy, ...emptyish]) expect(isTruthy(value)).toBe(false);
		const truthy = [
			1,
			"a",
			true,
			new Date(1),
			new DataviewDuration({ days: 1 }),
			new DataviewLink("A"),
			[0],
			{ a: 0 },
			new DataviewFunction(() => 0),
			new DataviewListPair("k", "v"),
		];
		for (const value of truthy) expect(isTruthy(value)).toBe(true);
	});
});

describe("value order", () => {
	test("null sorts first and different types order by type name", () => {
		expect(compareValues(null, undefined)).toBe(0);
		expect(compareValues(null, 1)).toBe(-1);
		expect(compareValues(1, null)).toBe(1);
		expect(compareValues(1, "a")).toBeLessThan(0);
	});

	test("booleans, dates and durations", () => {
		expect(compareValues(true, false)).toBe(1);
		expect(compareValues(false, true)).toBe(-1);
		expect(compareValues(new Date(2), new Date(1))).toBe(1);
		expect(
			compareValues(new DataviewDuration({ hours: 1 }), new DataviewDuration({ minutes: 61 })),
		).toBe(-1);
	});

	test("links by resolved path, then type, then subpath", () => {
		const normalize = (link: DataviewLink) => link.path.toLowerCase();
		expect(compareValues(new DataviewLink("a"), new DataviewLink("A"), normalize)).toBe(0);
		expect(compareValues(new DataviewLink("a"), new DataviewLink("b"))).toBeLessThan(0);
		expect(compareValues(new DataviewLink("a"), new DataviewLink("a", "header", "x"))).toBeLessThan(
			0,
		);
		const header = (subpath?: string) => new DataviewLink("a", "header", subpath);
		expect(compareValues(header("x"), header())).toBe(1);
		expect(compareValues(header(), header("x"))).toBe(-1);
		expect(compareValues(header("x"), header("y"))).toBeLessThan(0);
	});

	test("lists element-wise then by length; objects by keys then values", () => {
		expect(compareValues([1, 2], [1, 3])).toBeLessThan(0);
		expect(compareValues([1, 2], [1])).toBeGreaterThan(0);
		expect(compareValues({ a: 1 }, { b: 1 })).toBeLessThan(0);
		expect(compareValues({ a: 2 }, { a: 1 })).toBeGreaterThan(0);
		expect(compareValues({ a: 1, b: [1] }, { b: [1], a: 1 })).toBe(0);
	});

	test("functions have no order", () => {
		expect(compareValues(new DataviewFunction(() => 1), new DataviewFunction(() => 2))).toBe(0);
	});
});

describe("value text", () => {
	test("scalars, null and functions", () => {
		expect(valueToString(null)).toBe("-");
		expect(valueToString(true)).toBe("true");
		expect(valueToString(new DataviewFunction(() => 1))).toBe("<function>");
		expect(valueToString(new DataviewDuration({ days: 1 }))).toBe("1 day");
	});

	test("dates are minimal: date only at midnight, else date and time", () => {
		expect(valueToString(new Date(2026, 7, 5))).toBe("August 05, 2026");
		expect(valueToString(new Date(2026, 7, 5, 14, 3))).toBe("2:03 PM - August 05, 2026");
	});

	test("list pairs and external links", () => {
		expect(valueToString(new DataviewListPair("k", 1))).toBe("k: 1");
		expect(valueToString(new DataviewExternalLink("https://x.test", "X"))).toBe(
			"[X](https://x.test)",
		);
		expect(valueToString(new DataviewExternalLink("https://x.test"))).toBe(
			"[https://x.test](https://x.test)",
		);
	});

	test("nested lists are bracketed; objects list their entries", () => {
		expect(valueToString([1, [2, 3]])).toBe("1, [2, 3]");
		expect(valueToString({ a: 1, b: [1, 2] })).toBe("{ a: 1, b: [1, 2] }");
	});
});

describe("month shorthands", () => {
	test("som and start-of-month are the first of the month at midnight", () => {
		const now = new Date(2026, 7, 20, 10, 30);
		expect(dateShorthand("som", now)).toEqual(new Date(2026, 7, 1));
		expect(dateShorthand("start-of-month", now)).toEqual(new Date(2026, 7, 1));
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
		// As Luxon does, the fraction is added as elapsed milliseconds after the
		// calendar step, so across a DST change the wall clock moves by the offset
		// difference (New York: 1.5 years from Jan 31 lands at 13:00, not 12:00).
		const day = 86_400_000;
		const exactly = (date: Date, ms: number) => new Date(date.getTime() + ms);
		const start = new Date(2024, 0, 31);
		const add = (text: string) => addDuration(start, parseDuration(text) as DataviewDuration);
		// 1 year, then half a 365-day year.
		expect(add("1.5 years")).toEqual(exactly(new Date(2025, 0, 31), 182.5 * day));
		// 1 month (clamped to Feb 29), then half a 30-day month.
		expect(add("1.5 months")).toEqual(exactly(new Date(2024, 1, 29), 15 * day));
		expect(add("1.5 weeks")).toEqual(exactly(new Date(2024, 1, 7), 3.5 * day));
		expect(add("2h30m")).toEqual(exactly(start, 2.5 * 3_600_000));
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
