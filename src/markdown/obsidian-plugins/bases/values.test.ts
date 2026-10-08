import { describe, expect, test } from "bun:test";
import { formatDailyNoteDate } from "../../daily-notes.js";
import {
	addDuration,
	type DateValue,
	DurationValue,
	humanizeSpan,
	ISO_FORMATS,
	parseDateText,
	parseDuration,
	startOfDay,
	valueToString,
} from "./values.js";

const DAY = 86_400_000;

function date(text: string): DateValue {
	const parsed = parseDateText(text);
	if (!parsed) throw new Error(`not a date: ${text}`);
	return parsed;
}

function show(value: DateValue): string {
	return formatDailyNoteDate(new Date(value.ms), value.hasTime ? "YYYY-MM-DD HH:mm" : "YYYY-MM-DD");
}

describe("date + duration", () => {
	test("months clamp to the month's last day, in either direction", () => {
		expect(show(addDuration(date("2024-01-31"), new DurationValue(1, 0), 1))).toBe("2024-02-29");
		expect(show(addDuration(date("2024-03-31"), new DurationValue(1, 0), -1))).toBe("2024-02-29");
		expect(show(addDuration(date("2024-02-29"), new DurationValue(12, 0), 1))).toBe("2025-02-28");
	});

	test("a fractional month rounds as moment rounds it, and time makes a datetime", () => {
		const duration = parseDuration("1.5M");
		if (!duration) throw new Error("1.5M is a duration");
		expect(show(addDuration(date("2024-01-31"), duration, 1))).toBe("2024-03-31");
		expect(show(addDuration(date("2024-01-31"), new DurationValue(0, 2 * DAY), 1))).toBe(
			"2024-02-02",
		);
		expect(show(addDuration(date("2024-01-31"), new DurationValue(1, 3_600_000), 1))).toBe(
			"2024-02-29 01:00",
		);
	});

	test("today() drops the time of day", () => {
		expect(show(startOfDay(date("2024-05-15 14:30").ms))).toBe("2024-05-15");
	});
});

describe("parseDuration", () => {
	test("reads parts separated by spaces or commas; one-letter units are case sensitive", () => {
		expect(parseDuration("1M 4h")).toEqual(new DurationValue(1, 4 * 3_600_000));
		expect(parseDuration("1m")).toEqual(new DurationValue(0, 60_000));
		expect(parseDuration(" 2 weeks, 1 Day ,")).toEqual(new DurationValue(0, 15 * DAY));
		expect(parseDuration("-3 hours")).toEqual(new DurationValue(0, -3 * 3_600_000));
		expect(parseDuration("1y 2ms")).toEqual(new DurationValue(12, 2));
	});

	test("refuses text that is not all duration, and names that are no unit", () => {
		expect(parseDuration("")).toBeUndefined();
		expect(parseDuration(",")).toBeUndefined();
		expect(parseDuration("1d soon")).toBeUndefined();
		expect(parseDuration("1 fortnight")).toBeUndefined();
		expect(parseDuration("1 constructor")).toBeUndefined();
	});
});

describe("duration text", () => {
	test("humanized with moment's thresholds", () => {
		expect(humanizeSpan(0, 44_000)).toBe("a few seconds");
		expect(humanizeSpan(0, 45_000)).toBe("a minute");
		expect(humanizeSpan(0, 22 * 3_600_000)).toBe("a day");
		expect(humanizeSpan(0, 26 * DAY)).toBe("a month");
		expect(humanizeSpan(11, 0)).toBe("a year");
		expect(valueToString(new DurationValue(0, -3 * DAY), ISO_FORMATS)).toBe("3 days");
	});

	test("months and time count by size each, so opposite signs do not cancel", () => {
		expect(humanizeSpan(1, -10 * DAY)).toBe("a month");
	});
});
