import { describe, expect, test } from "bun:test";
import {
	callDataviewFunction,
	type EvalContext,
	evaluate,
	parseExpression,
} from "./dataview-expression";
import {
	DataviewDuration,
	DataviewExternalLink,
	DataviewLink,
	valueToString,
} from "./dataview-values";

const ctx: EvalContext = {
	globals: {},
	now: new Date(2026, 9, 8, 12, 30, 0),
	resolveLink: (link) =>
		link.path === "Journal/2026-10-01.md" ? { file: { day: new Date(2026, 9, 1) } } : null,
	normalizeLink: (link) => link.path,
	normalizePath: (path) => path,
};

const ev = (source: string, data: Record<string, unknown> = {}) =>
	evaluate(parseExpression(source), ctx, data);

/** Dataview's documented function examples (reference/functions). */
const CASES: [string, unknown][] = [
	// Constructors
	['object("a", 6, "b", "x")', { a: 6, b: "x" }],
	["list(1, 2, 3)", [1, 2, 3]],
	["array(1, 2)", [1, 2]],
	['number("18 years")', 18],
	["number(34)", 34],
	['number("hmm")', null],
	["number(null)", null],
	["string(18)", "18"],
	["typeof(8)", "number"],
	['typeof("text")', "string"],
	["typeof(list(1, 2))", "array"],
	['typeof(object("a", 1))', "object"],
	["typeof(date(2020-01-01))", "date"],
	["typeof(dur(8 minutes))", "duration"],
	["typeof(null)", "null"],
	['dur("nope")', null],
	["dur(null)", null],
	['date("12/31/2022", "MM/dd/yyyy") = date(2022-12-31)', true],
	['date("1667691000000", "x") = date("1667691000", "X")', true],
	['date(null, "yyyy")', null],
	["date(null)", null],
	['date(list("2020-01-01", null))[1]', null],
	["date(date(2020-01-01)) = date(2020-01-01)", true],
	['date("today") = date(today)', true],
	["date([[2021-03-04]]) = date(2021-03-04)", true],
	['date(link("x", "2021-03-04")) = date(2021-03-04)', true],
	['date(link("Journal/2026-10-01.md")) = date(2026-10-01)', true],
	['date(link("nowhere"))', null],
	// Numbers
	["round(16.555555)", 17],
	["round(16.555555, 2)", 16.56],
	["round(16.5, 0)", 17],
	["round(16.5, null)", 17],
	["round(null)", null],
	["round(null, 2)", null],
	["round(list(1.4, 2.6))", [1, 3]],
	["trunc(-12.937)", -12],
	["floor(-12.937)", -13],
	["ceil(-12.937)", -12],
	["ceil(null)", null],
	["min(1, 2, 3)", 1],
	["min(list(1, 2, 3))", 1],
	["min(5, null)", 5],
	["min(null, 5)", 5],
	["min()", null],
	["max(1, 2, 3)", 3],
	["max(list(1, 2, 3))", 3],
	["max(5, null)", 5],
	["max(null, 5)", 5],
	["max()", null],
	["sum(list(1, 2, 3))", 6],
	["sum(7)", 7],
	["product(list(1, 2, 3))", 6],
	["product(4)", 4],
	["average(list(1, 2, 3))", 2],
	["average(list())", null],
	["average(5)", 5],
	["minby(list(1, 2, 3), (k) => k)", 1],
	['maxby(list("a", "ccc", "bb"), (k) => length(k))', "ccc"],
	["minby(list(), (k) => k)", null],
	["minby(list(1, 2), (k) => null)", 1],
	["maxby(null, (k) => k)", null],
	["minby(null, (k) => k)", null],
	// Objects, arrays, strings
	['contains("Hello", "Lo")', false],
	['contains(list("Hello"), "Hello")', true],
	['contains(object("a", 1), "a")', true],
	["contains(3, 3)", true],
	['contains("abc", list("a", "z"))', [true, false]],
	['icontains("Hello", "Lo")', true],
	['icontains(list("Hello"), "lo")', true],
	['icontains(object("A", 1), "A")', true],
	["icontains(1, 2)", false],
	['econtains(list("words", "in", "list"), "word")', false],
	['econtains(list("words", "in", "list"), "words")', true],
	['econtains("words", "word")', true],
	['econtains(object("a", 1), "a")', true],
	["econtains(1, 1)", true],
	['containsword("word wordy", "word")', true],
	['containsword("Hello there", "hello")', true],
	['containsword(list("word", "wordy"), "wordy")', [false, true]],
	['containsword(null, "x")', null],
	['containsword("x", null)', null],
	['extract(object("a", 1, "b", 2), "a")', { a: 1 }],
	['extract(list(object("a", 1), object("a", 2)), "a")', [{ a: 1 }, { a: 2 }]],
	["sort(list(3, 2, 1))", [1, 2, 3]],
	["sort(list(3, 1, 2), (x) => -x)", [3, 2, 1]],
	["sort(5)", 5],
	["reverse(list(1, 2, 3))", [3, 2, 1]],
	['reverse("abc")', "cba"],
	["reverse(5)", 5],
	["length(list(1, 2, 3))", 3],
	['length(object("a", 1, "b", 2))', 2],
	['length("hello")', 5],
	["length(null)", 0],
	["nonnull(list(null, 1, 2))", [1, 2]],
	["nonnull(null, 1, null, 2)", [1, 2]],
	["firstvalue(list(null, 1, 2))", 1],
	["firstvalue(list(null))", null],
	["firstvalue(null)", null],
	["all(list(1, 2, 3), (x) => x > 0)", true],
	["all(true, false)", false],
	["all(list(true, false))", false],
	["any(list(1, 2, 3), (x) => x > 2)", true],
	["any(true, false)", true],
	["any(list(false, 0))", false],
	["none(list(1, 2, 3), (x) => x > 3)", true],
	["none(true, false)", false],
	["none(list(false))", true],
	["join(list(1, 2, 3))", "1, 2, 3"],
	['join(list(1, 2, 3), " ")', "1 2 3"],
	["join(list(1, 2), null)", "1, 2"],
	['join(5, "-")', "5"],
	["join(5)", "5"],
	["filter(list(1, 2, 3), (x) => x >= 2)", [2, 3]],
	["filter(null, (x) => x)", null],
	["map(list(1, 2, 3), (x) => x + 2)", [3, 4, 5]],
	["map(null, (x) => x)", null],
	["flat(list(1, 2, 3, list(4, 5), 6))", [1, 2, 3, 4, 5, 6]],
	["flat(list(1, list(21, 22), list(list(311, 312))), 4)", [1, 21, 22, 311, 312]],
	["flat(null)", null],
	["slice(list(1, 2, 3, 4, 5), 3)", [4, 5]],
	["slice(list(1, 2, 3, 4, 5), 0, 2)", [1, 2]],
	["slice(list(1, 2, 3, 4, 5), -2)", [4, 5]],
	["slice(list(1, 2))", [1, 2]],
	["slice(null)", null],
	["unique(list(1, 3, 7, 3, 1))", [1, 3, 7]],
	["unique(null)", null],
	['reduce(list(100, 20, 3), "-")', 77],
	["reduce(list(2, null, 3, 4), (a, b) => a * b)", 24],
	["reduce(list(), (a, b) => a)", null],
	['reduce(list(), "+")', null],
	['reduce(null, "+")', null],
	["reduce(list(1), null)", null],
	// Strings
	['regextest("\\w+", "hello")', true],
	['regextest("el", "hello")', true],
	['regextest(null, "x")', false],
	['regextest("x", null)', false],
	['regexmatch("\\w+", "hello")', true],
	['regexmatch("\\w", "hello")', false],
	['regexmatch(null, "x")', false],
	['regexmatch("x", null)', false],
	['regexreplace("yes", "[ys]", "a")', "aea"],
	['regexreplace("Suite 1000", "\\d+", "-")', "Suite -"],
	['regexreplace(null, "a", "b")', null],
	['regexreplace("a", null, "b")', null],
	['regexreplace("a", "a", null)', null],
	['replace("what", "wh", "h")', "hat"],
	[
		'replace("The big dog chased the big cat.", "big", "small")',
		"The small dog chased the small cat.",
	],
	['replace(null, "a", "b")', null],
	['replace("a", null, "b")', null],
	['replace("a", "a", null)', null],
	['lower("Test")', "test"],
	['upper("Test")', "TEST"],
	["upper(null)", null],
	['split("hello world", " ")', ["hello", "world"]],
	['split("hello  world", "\\s")', ["hello", "", "world"]],
	['split("hello there world", " ", 2)', ["hello", "there"]],
	['split("hello world", "(o)")', ["hell", "o", " w", "o", "rld"]],
	['split(null, " ")', null],
	['split("a", null)', null],
	['split("a", " ", null)', null],
	['split("a", null, 1)', null],
	['split(null, " ", 1)', null],
	['startswith("yes", "ye")', true],
	['startswith("yes", "es")', false],
	['endswith("yes", "es")', true],
	['endswith(null, "x")', null],
	['padleft("hello", 7)', "  hello"],
	['padleft("yes", 5, "!")', "!!yes"],
	['padright("hello", 7)', "hello  "],
	['padright("yes", 5, "!")', "yes!!"],
	["padleft(null, 5)", null],
	['padleft("a", null)', null],
	['padleft(null, 5, "!")', null],
	['padleft("a", null, "!")', null],
	['padleft("a", 5, null)', null],
	['substring("hello", 0, 2)', "he"],
	['substring("hello", 2)', "llo"],
	["substring(null, 2)", null],
	['substring("a", null)', null],
	["substring(null, 1, 2)", null],
	['substring("a", null, 2)', null],
	['substring("a", 1, null)', null],
	['truncate("Hello there!", 8)', "Hello..."],
	['truncate("Hello there!", 8, "/")', "Hello t/"],
	['truncate("Hello", 10)', "Hello"],
	["truncate(null, 8)", null],
	['truncate("a", null)', null],
	['truncate(null, 8, "/")', null],
	['truncate("a", null, "/")', null],
	['truncate("a", 8, null)', null],
	// Utilities
	["default(null, 1)", 1],
	["default(2, 1)", 2],
	["default(list(1, 2, null), 3)", [1, 2, 3]],
	["ldefault(null, 1)", 1],
	["ldefault(list(1, null), 3)", [1, null]],
	['display("**test**")', "test"],
	['display("[[Page|Alias]] and [x](https://x.org) ==hi==")', "Alias and x hi"],
	[
		'display(list("a", link("Folder/Page.md"), link("p", "Shown"), null, 3))',
		"a, Page, Shown, , 3",
	],
	['choice(true, "yes", "no")', "yes"],
	['choice(false, "yes", "no")', "no"],
	['choice(list(true, false), "yes", "no")', ["yes", "no"]],
	['dateformat(date(2021-08-08), "yyyy-MM-dd")', "2021-08-08"],
	['dateformat(null, "yyyy")', null],
	["striptime(date(2021-08-08T13:15)) = date(2021-08-08)", true],
	["striptime(null)", null],
	["durationformat(dur(\"3 days 7 hours 43 seconds\"), \"ddd'd' hh'h' ss's'\")", "003d 07h 43s"],
	['durationformat(null, "s")', null],
	['currencyformat(123456.789, "EUR")', "€123,456.79"],
	["currencyformat(5)", "$5.00"],
	['currencyformat(null, "EUR")', null],
	["currencyformat(null)", null],
	["localtime(null)", null],
	["localtime(date(2021-08-08)) = date(2021-08-08)", true],
	['hash("dv", 4) = hash("dv", 4)', true],
	['hash("dv", 4) = hash("dv", 5)', false],
	['hash("dv", "text") = hash("dvtext", 0)', true],
	['hash("dv", "text", 2) = hash("dvtext", 2)', true],
	[
		'meta(link("Folder/Page.md", "Shown"))',
		{ display: "Shown", embed: false, path: "Folder/Page.md", subpath: null, type: "file" },
	],
];

describe("Dataview function library", () => {
	test.each(CASES)("%s", (source, expected) => {
		expect(ev(source)).toEqual(expected);
	});

	test("link constructors build file and external links", () => {
		expect(ev('link("Folder/Page.md")')).toEqual(new DataviewLink("Folder/Page.md", "file"));
		const display = ev('link("Page.md", "Shown")') as DataviewLink;
		expect([display.path, display.display, display.embed]).toEqual(["Page.md", "Shown", false]);
		expect((ev('link("Page.md", "Shown", true)') as DataviewLink).embed).toBe(true);
		expect((ev('link(link("Page.md"), "Again")') as DataviewLink).display).toBe("Again");
		expect(ev('link(link("Page.md"))')).toEqual(new DataviewLink("Page.md", "file"));
		expect((ev('link("Page.md", null)') as DataviewLink).path).toBe("Page.md");
		expect(ev("link(null)")).toBeNull();
		expect(ev('link(null, "x")')).toBeNull();
		expect((ev('embed(link("a.png"))') as DataviewLink).embed).toBe(true);
		expect((ev('embed(link("a.png"), false)') as DataviewLink).embed).toBe(false);
		expect(ev("embed(null)")).toBeNull();
		expect(ev("embed(null, true)")).toBeNull();
		expect(ev('embed(link("a"), null)')).toBeNull();
		expect(ev('elink("https://x.org", "X")')).toEqual(
			new DataviewExternalLink("https://x.org", "X"),
		);
		expect(ev('elink("https://x.org")')).toEqual(new DataviewExternalLink("https://x.org"));
		expect(ev('elink("https://x.org", null)')).toEqual(new DataviewExternalLink("https://x.org"));
		expect(ev("elink(null)")).toBeNull();
		expect(ev('elink(null, "X")')).toBeNull();
	});

	test("dur() normalizes a duration string", () => {
		const duration = ev('dur("90 minutes")') as DataviewDuration;
		expect(duration).toBeInstanceOf(DataviewDuration);
		expect(valueToString(duration)).toBe("1 hour, 30 minutes");
		expect(ev("dur(dur(1 day))")).toBeInstanceOf(DataviewDuration);
	});

	test("links stringify as Obsidian markdown with their label", () => {
		expect(ev('string(link("Folder/Page.md"))')).toBe("[[Folder/Page.md|Page]]");
		expect(ev('join(list(embed(link("a|b.md", "Shown"))))')).toBe("![[a\\|b.md|Shown]]");
		expect(ev("string([[Page#Heading]])")).toBe("[[Page#Heading|Page > Heading]]");
		expect(ev("string([[Page#^block]])")).toStartWith("[[Page#^block|");
	});

	test("date() reports formats it can't apply", () => {
		expect(() => ev('date("nonsense", "x")')).toThrow("Not a number for format (x): nonsense.");
		expect(() => ev('date("nonsense", "yyyy-MM-dd")')).toThrow(
			"Can't handle format (yyyy-MM-dd) on date string (nonsense).",
		);
	});

	test("argument errors surface Dataview's messages", () => {
		expect(() => ev('object("a")')).toThrow("object() requires an even number of arguments.");
		expect(() => ev("object(1, 2)")).toThrow("Keys should be of type string");
		expect(() => ev('extract(object("a", 1), 1)')).toThrow("must be called with string keys");
		expect(() => ev('reduce(list(1, 2), "%")')).toThrow("reduce(array, op) supports");
		expect(() => ev("map(list(1), 3)")).toThrow();
		expect(() => ev('regextest("(", "x")')).toThrow('Invalid Dataview pattern "("');
		expect(() => ev('regextest("(a+)+", "x")')).toThrow("nested quantifiers");
		expect(() => callDataviewFunction("constructor", ctx, [])).toThrow(
			"Unsupported Dataview function: constructor.",
		);
	});

	test("function names are case-insensitive", () => {
		expect(callDataviewFunction("UPPER", ctx, ["a"])).toBe("A");
	});
});

/** A fresh context: each query's work budget belongs to its context. */
const run = (source: string, data: Record<string, unknown> = {}) =>
	evaluate(parseExpression(source), { ...ctx }, data);

describe("escape vectors", () => {
	test("object() and extract() keep `__proto__` as a key, never a prototype", () => {
		expect(run('object("__proto__", list(1, 2))["__proto__"]')).toEqual([1, 2]);
		expect(run('typeof(object("__proto__", date(2020-01-01)))')).toBe("object");
		expect(run('length(extract(object("a", 1), "a", "__proto__"))')).toBe(2);
	});

	test("a lambda parameter named __proto__ is an ordinary name", () => {
		expect(run("map(list(1, 2), (__proto__) => __proto__ * 10)")).toEqual([10, 20]);
	});

	test("inherited members stay out of reach", () => {
		expect(run('object("a", 1)["constructor"]')).toBeNull();
		expect(run('object("a", 1)["toString"]')).toBeNull();
		expect(run('list(1)["__proto__"]')).toEqual([null]);
		expect(run("row.constructor", { x: 1 })).toBeNull();
		expect(() => run('toString("x")')).toThrow("Unsupported Dataview function: toString.");
		expect(() => run('hasOwnProperty("x")')).toThrow("Unsupported Dataview function");
	});
});

describe("denial of service", () => {
	test("text and list blow-ups are refused before they allocate", () => {
		expect(() => run('"x" * 1000000000')).toThrow(
			"A text value would be 1000000000 characters long, over the limit of 10000000",
		);
		expect(() => run('1000000000 * "x"')).toThrow("A text value would be");
		expect(() => run('padleft("x", 1000000000)')).toThrow("A text value would be");
		expect(() => run('padright("x", 1000000000, "ab")')).toThrow("A text value would be");
		const big = 'padleft("", 4000000, "x")';
		expect(() => run(`join(list(${big}, ${big}, ${big}), "")`)).toThrow("A text value would be");
		expect(() => run(`${big} + ${big} + ${big}`)).toThrow("A text value would be");
		expect(() => run('replace(padleft("", 100000, "a"), "a", padleft("", 1000, "b"))')).toThrow(
			"A text value would be",
		);
		expect(() => run('regexreplace(padleft("", 10000, "a"), "a", padleft("", 2000, "b"))')).toThrow(
			"A text value would be",
		);
		const square =
			'map(split(padleft("", 1001, "x"), ""), (a) => split(padleft("", 1001, "x"), ""))';
		expect(() => run(`flat(${square})`)).toThrow("A list would have");
		expect(() => run(`flat(${square}, 3)`)).toThrow("A list would have");
		const long =
			'flat(map(split(padleft("", 600, "x"), ""), (a) => split(padleft("", 1000, "x"), "")))';
		expect(run(`length(${long})`)).toBe(600_000);
		expect(() => run(`${long} + ${long}`)).toThrow("A list would have 1200000 items");
	});

	test("nested lambdas over long lists and quadratic unique() are stopped by the budget", () => {
		const xs = 'split(padleft("", 9000, "x"), "")';
		expect(() => run(`map(${xs}, (a) => map(${xs}, (b) => b))`)).toThrow(
			"The Dataview query ran more than 50000000 steps and was stopped; Obsidian has no such limit",
		);
		expect(() => run(`map(${xs}, (a) => ${xs})`)).toThrow("ran more than 50000000 steps");
		const distinct = Array.from({ length: 20_000 }, (_, index) => index);
		expect(() => run("unique(items)", { items: distinct })).toThrow("ran more than");
		expect(run("length(unique(items))", { items: distinct.slice(0, 1000) })).toBe(1000);
	});

	test("an unsafe pattern is refused at every regex function", () => {
		for (const source of [
			'regextest("(a+)+$", "aaa")',
			'regexmatch("(a+)+$", "aaa")',
			'regexreplace("aaa", "(a+)+$", "b")',
			'split("aaa", "(a+)+")',
		]) {
			expect(() => run(source)).toThrow(
				"uses nested quantifiers (possible catastrophic backtracking detected); Obsidian would run it",
			);
		}
	});
});
