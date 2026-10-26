import { describe, expect, test } from "bun:test";
import { evaluate, parseExpression } from "./dataview-expression";
import type { EvalContext } from "./dataview-operators";
import { valueToString } from "./dataview-values";

const ctx: EvalContext = {
	globals: {},
	now: new Date(2026, 9, 8, 12, 30, 0),
	resolveLink: (link) => (link.path === "Page.md" ? { rating: 4 } : null),
	normalizeLink: (link) => link.path,
	normalizePath: (path) => path,
};

const ev = (source: string, data: Record<string, unknown> = {}) =>
	evaluate(parseExpression(source), ctx, data);

describe("date properties", () => {
	// Thursday 8 October 2026, 12:30:00.250: ISO week 41.
	const when = { d: new Date(2026, 9, 8, 12, 30, 0, 250) };

	test.each([
		["d.weekyear", 41],
		["d.week", 2],
		["d.millisecond", 250],
		["d.fortnight", null],
	])("%s", (source, expected) => {
		expect(ev(source, when)).toBe(expected);
	});

	test("a date is indexed by unit name only", () => {
		expect(() => ev("d[0]", when)).toThrow("Date indexing requires a unit name.");
	});
});

describe("indexing", () => {
	test("objects and links take string keys only", () => {
		expect(() => ev("o[0]", { o: { a: 1 } })).toThrow("Can only index into objects with strings");
		expect(() => ev('link("Page.md")[0]')).toThrow("Can only index into links with strings");
		expect(ev('link("Page.md").rating')).toBe(4);
	});

	test("strings take numeric indexes, out of range is null", () => {
		expect(ev('"abc"[1]')).toBe("b");
		expect(ev('"abc"[5]')).toBeNull();
		expect(() => ev('"abc"["x"]')).toThrow("String indexing requires a numeric index.");
	});

	test("a string index over a list drops elements that cannot be indexed", () => {
		expect(ev('list(object("a", 1), "text", object("a", 2)).a')).toEqual([1, 2]);
	});

	test("a duration answers only to known unit names", () => {
		expect(ev("dur(2 hours).minutes")).toBe(120);
		expect(ev("dur(2 hours).toString")).toBeNull();
	});
});

describe("binary operators", () => {
	test("| is a logical or", () => {
		expect(ev("false | 0")).toBe(false);
		expect(ev('false | "x"')).toBe(true);
	});

	test("a duration plus a date is the later date", () => {
		const result = ev('dur(1 day) + date("2026-10-08")') as Date;
		expect(result.getDate()).toBe(9);
	});

	test("durations scale by numbers on either side", () => {
		expect(valueToString(ev("dur(90 minutes) * 2"))).toBe("3 hours");
		expect(valueToString(ev("dur(3 hours) / 2"))).toBe("1 hour, 30 minutes");
		expect(valueToString(ev("2 * dur(45 minutes)"))).toBe("1 hour, 30 minutes");
	});

	test("objects merge, the right side winning", () => {
		expect(ev('object("a", 1, "b", 2) + object("b", 3)')).toEqual({ a: 1, b: 3 });
	});

	test("an unsupported pair of types is an error", () => {
		expect(() => ev("list(1) - list(1)")).toThrow("No implementation found for 'array - array'.");
	});
});
