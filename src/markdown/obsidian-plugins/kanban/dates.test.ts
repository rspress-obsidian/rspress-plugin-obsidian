import { describe, expect, test } from "bun:test";
import { dateClass, dateColorMatcher, parseNow, relativeDate } from "./dates.js";

const now = new Date(2024, 4, 2, 9, 0, 0);

describe("parseNow", () => {
	test("reads a day as local midnight, any other date string as Date does, and refuses junk", () => {
		expect(parseNow("2024-05-02")).toEqual(new Date(2024, 4, 2));
		expect(parseNow("2024-05-02T10:30:00")?.getHours()).toBe(10);
		expect(parseNow(now)).toBe(now);
		expect(parseNow("soon")).toBeUndefined();
		expect(parseNow(new Date(Number.NaN))).toBeUndefined();
		expect(parseNow(undefined)).toBeInstanceOf(Date);
	});
});

describe("relativeDate", () => {
	test("a dated card counts whole days from today, with today/yesterday/tomorrow", () => {
		expect(relativeDate(new Date(2024, 4, 2), false, now)).toBe("today");
		expect(relativeDate(new Date(2024, 4, 1), false, now)).toBe("yesterday");
		expect(relativeDate(new Date(2024, 4, 3), false, now)).toBe("tomorrow");
		expect(relativeDate(new Date(2024, 4, 12), false, now)).toBe("in 10 days");
		expect(relativeDate(new Date(2024, 3, 2), false, now)).toBe("a month ago");
		expect(relativeDate(new Date(2024, 8, 2), false, now)).toBe("in 4 months");
		expect(relativeDate(new Date(2025, 2, 2), false, now)).toBe("in 10 months");
		expect(relativeDate(new Date(2025, 4, 2), false, now)).toBe("in a year");
		expect(relativeDate(new Date(2021, 4, 2), false, now)).toBe("3 years ago");
	});

	test("a dated card counts calendar months, then the days left, as moment's `from` does", () => {
		// 1 month and 15 days: "a month"; as 46 plain days it would round to 2 months.
		expect(relativeDate(new Date(2024, 5, 17), false, now)).toBe("in a month");
		expect(relativeDate(new Date(2024, 2, 17), false, now)).toBe("a month ago");
	});

	test("a timed card counts from this moment with Moment's thresholds", () => {
		const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000);
		expect(relativeDate(at(0.5), true, now)).toBe("in a few seconds");
		expect(relativeDate(at(1), true, now)).toBe("in a minute");
		expect(relativeDate(at(-30), true, now)).toBe("30 minutes ago");
		expect(relativeDate(at(50), true, now)).toBe("in an hour");
		expect(relativeDate(at(5 * 60), true, now)).toBe("in 5 hours");
		expect(relativeDate(at(-23 * 60), true, now)).toBe("a day ago");
		expect(relativeDate(at(3 * 24 * 60), true, now)).toBe("in 3 days");
	});
});

describe("dateClass", () => {
	test("compares calendar days, not instants", () => {
		expect(dateClass(new Date(2024, 4, 2, 23, 59), now)).toBe("is-today");
		expect(dateClass(new Date(2024, 4, 1, 23, 59), now)).toBe("is-past");
		expect(dateClass(new Date(2024, 4, 3), now)).toBe("is-future");
	});
});

describe("dateColorMatcher", () => {
	test("today first, then windows by their far edge, then before/after", () => {
		const match = dateColorMatcher(
			[
				{ isAfter: true, color: "after" },
				{ distance: 2, unit: "weeks", direction: "after", color: "fortnight" },
				{ distance: 3, unit: "days", direction: "after", color: "soon" },
				{ distance: 1, unit: "months", direction: "before", color: "last-month" },
				{ isToday: true, color: "today" },
			],
			now,
		);
		expect(match(new Date(2024, 4, 2))?.color).toBe("today");
		expect(match(new Date(2024, 4, 4))?.color).toBe("soon");
		expect(match(new Date(2024, 4, 10))?.color).toBe("fortnight");
		expect(match(new Date(2024, 5, 30))?.color).toBe("after");
		expect(match(new Date(2024, 3, 20))?.color).toBe("last-month");
		expect(match(new Date(2023, 0, 1))).toBeUndefined();
	});

	test("an hours window compares by the hour", () => {
		const match = dateColorMatcher(
			[{ distance: 2, unit: "hours", direction: "after", color: "now" }],
			now,
		);
		expect(match(new Date(2024, 4, 2, 10, 30))?.color).toBe("now");
		expect(match(new Date(2024, 4, 2, 12, 0))).toBeUndefined();
		const before = dateColorMatcher(
			[{ distance: 2, unit: "hours", direction: "before", color: "recent" }],
			now,
		);
		expect(before(new Date(2024, 4, 2, 7, 15))?.color).toBe("recent");
		expect(before(new Date(2024, 4, 2, 6, 0))).toBeUndefined();
	});

	test("before matches the past, a window without a unit counts days", () => {
		const match = dateColorMatcher(
			[
				{ isBefore: true, color: "late" },
				{ distance: 1, direction: "before", color: "recent" },
			],
			now,
		);
		expect(match(new Date(2024, 4, 1))?.color).toBe("recent");
		expect(match(new Date(2024, 3, 1))?.color).toBe("late");
	});

	test("a month window ends on the month's last day, as moment adds a month", () => {
		const endOfJanuary = new Date(2024, 0, 31, 9);
		const match = dateColorMatcher(
			[{ distance: 1, unit: "months", direction: "after", color: "next-month" }],
			endOfJanuary,
		);
		expect(match(new Date(2024, 1, 29))?.color).toBe("next-month");
		expect(match(new Date(2024, 2, 1))).toBeUndefined();
	});
});
