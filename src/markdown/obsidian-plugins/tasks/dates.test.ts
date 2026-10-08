import { describe, expect, test } from "bun:test";
import {
	compareTaskDates,
	dayFromParts,
	formatDay,
	isoDay,
	parseDateRange,
	parseIsoDay,
	parseNaturalDate,
	resolveToday,
} from "./dates.ts";

/** Wednesday 15 May 2024. */
const today = parseIsoDay("2024-05-15");

function range(text: string): [string, string] | undefined {
	const parsed = parseDateRange(text, today);
	return parsed && [isoDay(parsed.start), isoDay(parsed.end)];
}

describe("calendar days", () => {
	test("a day that does not exist is invalid", () => {
		expect(Number.isNaN(parseIsoDay("2024-02-30"))).toBe(true);
		expect(Number.isNaN(parseIsoDay("someday"))).toBe(true);
		expect(isoDay(dayFromParts(2024, 2, 29))).toBe("2024-02-29");
	});

	test("days format with Moment tokens, as explanations print them", () => {
		expect(formatDay(today, "YYYY-MM-DD (dddd Do MMMM YYYY)")).toBe(
			"2024-05-15 (Wednesday 15th May 2024)",
		);
	});

	test("today comes from the `now` option, as an ISO day or anything Date reads", () => {
		expect(resolveToday("2024-05-15")).toBe(today);
		expect(resolveToday(new Date(2024, 4, 15, 23, 30))).toBe(today);
		expect(resolveToday("May 15, 2024 10:00")).toBe(today);
		expect(resolveToday("not a date")).toBeUndefined();
		expect(resolveToday(undefined)).toBe(
			dayFromParts(new Date().getFullYear(), new Date().getMonth() + 1, new Date().getDate()),
		);
	});
});

describe("date ranges in queries", () => {
	test("last, this and next week are ISO weeks, Monday to Sunday", () => {
		expect(range("this week")).toEqual(["2024-05-13", "2024-05-19"]);
		expect(range("last week")).toEqual(["2024-05-06", "2024-05-12"]);
		expect(range("next week")).toEqual(["2024-05-20", "2024-05-26"]);
	});

	test("months, quarters and years end on their last day", () => {
		expect(range("last month")).toEqual(["2024-04-01", "2024-04-30"]);
		expect(range("next month")).toEqual(["2024-06-01", "2024-06-30"]);
		expect(range("this quarter")).toEqual(["2024-04-01", "2024-06-30"]);
		expect(range("next quarter")).toEqual(["2024-07-01", "2024-09-30"]);
		expect(range("last year")).toEqual(["2023-01-01", "2023-12-31"]);
	});

	test("numbered ranges name a year, quarter, month or ISO week", () => {
		expect(range("2023")).toEqual(["2023-01-01", "2023-12-31"]);
		expect(range("2024-Q1")).toEqual(["2024-01-01", "2024-03-31"]);
		expect(range("2024-02")).toEqual(["2024-02-01", "2024-02-29"]);
		expect(range("2024-W01")).toEqual(["2024-01-01", "2024-01-07"]);
		expect(range("2021-W01")).toEqual(["2021-01-04", "2021-01-10"]);
	});

	test("one or two natural-language dates, in either order", () => {
		expect(range("tomorrow")).toEqual(["2024-05-16", "2024-05-16"]);
		expect(range("2024-01-01 2024-01-31")).toEqual(["2024-01-01", "2024-01-31"]);
		expect(range("2024-01-31 2024-01-01")).toEqual(["2024-01-01", "2024-01-31"]);
		expect(range("gibberish")).toBeUndefined();
	});

	test("single natural dates resolve against today", () => {
		const day = parseNaturalDate("in two weeks", today);
		expect(day === undefined ? undefined : isoDay(day)).toBe("2024-05-29");
		expect(parseNaturalDate("never ever", today)).toBeUndefined();
	});
});

test("dated tasks sort before undated ones, invalid dates first", () => {
	const valid = { text: "2024-05-15", day: today };
	const later = { text: "2024-05-16", day: today + 1 };
	const invalid = { text: "2024-02-30", day: Number.NaN };
	expect(compareTaskDates(valid, undefined)).toBe(-1);
	expect(compareTaskDates(undefined, valid)).toBe(1);
	expect(compareTaskDates(undefined, undefined)).toBe(0);
	expect(compareTaskDates(invalid, valid)).toBe(-1);
	expect(compareTaskDates(valid, invalid)).toBe(1);
	expect(compareTaskDates(invalid, invalid)).toBe(0);
	expect(compareTaskDates(later, valid)).toBe(1);
});
