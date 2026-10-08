/**
 * The Bases formula language over a real vault: parse a formula, evaluate it
 * for a note of the dataset, check the value (Functions.md, Bases syntax.md).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildContentIndex } from "../../content-index.js";
import { normalizePluginOptions } from "../../normalize-options.js";
import type { ContentIndex } from "../../types.js";
import { type Dataset, datasetFor } from "./dataset.js";
import {
	compileExpression,
	type EvalEnv,
	evaluate,
	parsePropertyId,
	propertyValue,
	RowScope,
} from "./evaluate.js";
import { ExpressionSyntaxError, parseExpression } from "./expression.js";
import {
	type BaseFile,
	DateValue,
	DurationValue,
	ErrorValue,
	FileValue,
	HtmlValue,
	IconValue,
	ImageValue,
	LinkValue,
	RegexValue,
	type Value,
	valueToString,
} from "./values.js";

const FILES: Record<string, string> = {
	"Projects/Alpha.md": [
		"---",
		"status: Done",
		"price: 10",
		"age: 2",
		"due: 2024-05-01",
		"started: 2024-05-01 10:30:00",
		"tags: [project, work/client]",
		'owner: "[[People/Ann]]"',
		"authors:",
		'  - "[[People/Ann]]"',
		'  - "[[People/Bob]]"',
		"my prop: 5",
		"meta: {a: 1, b: two}",
		"scores: [3, 1, 2]",
		"---",
		"# Alpha",
		"",
		"See [[Beta]] and ![[pic.png]].",
	].join("\n"),
	"Projects/Beta.md":
		"---\nstatus: Planned\nprice: 4.5\ndone: true\n---\n# Beta\n\n#project/sub [[Alpha]] [[Alpha|Again]] [[Alpha#No such heading]]\n[[Missing Note]] [Gone](Gone.md)\n",
	"People/Ann.md": "---\nrole: lead\n---\n# Ann\n\n[[Alpha]]\n",
	"Typed.md":
		'---\nrating: "4"\nflag: "true"\nlabel: 2024-01-01\nsplit: "2024-02-03T04:05"\n---\n# Typed\n',
	"pic.png": "PNG",
	".obsidian/types.json": JSON.stringify({
		types: { rating: "number", flag: "checkbox", label: "text", aliases: "aliases" },
	}),
};

let root: string;
let index: ContentIndex;
let dataset: Dataset;

beforeAll(async () => {
	root = mkdtempSync(path.join(os.tmpdir(), "bases-evaluate-"));
	for (const [name, content] of Object.entries(FILES)) {
		const target = path.join(root, name);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	index = await buildContentIndex(root);
	dataset = await datasetFor(
		[index],
		normalizePluginOptions({ vaultRoot: root, enableBases: true }),
	);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function file(relativePath: string): BaseFile {
	const found = dataset.files.find((candidate) => candidate.path === relativePath);
	if (!found) throw new Error(`${relativePath} is not in the dataset`);
	return found;
}

const NOW = new Date(2024, 4, 10, 12, 0, 0);

function env(formulas: Record<string, string> = {}, thisPath = "People/Ann.md"): EvalEnv {
	const compiled: EvalEnv["formulas"] = {};
	for (const [name, source] of Object.entries(formulas)) compiled[name] = compileExpression(source);
	const thisFile = file(thisPath);
	if (!thisFile.page) throw new Error(`${thisPath} is not a note`);
	return {
		dataset,
		now: NOW,
		formats: { dateFormat: "YYYY-MM-DD", dateTimeFormat: "YYYY-MM-DD HH:mm:ss" },
		thisFile,
		formulas: compiled,
		contextPage: thisFile.page,
		seed: "test",
	};
}

function run(source: string, row = "Projects/Alpha.md", environment = env()): Value {
	const expr = compileExpression(source);
	if (expr instanceof ErrorValue) return expr;
	return evaluate(expr, environment, new RowScope(row ? file(row) : undefined));
}

/** The value as text, the way `toString()` gives it. */
function show(source: string, row?: string, environment?: EvalEnv): string {
	return valueToString(run(source, row, environment), env().formats);
}

function errorOf(value: Value): string {
	if (!(value instanceof ErrorValue)) throw new Error(`expected an error, got ${String(value)}`);
	return value.message;
}

describe("parsing", () => {
	test("operators bind by precedence, parentheses override", () => {
		expect(run("1 + 2 * 3")).toBe(7);
		expect(run("(1 + 2) * 3")).toBe(9);
		expect(run("10 - 4 - 3")).toBe(3);
		expect(run("10 % 4 * 2")).toBe(4);
		expect(run("-2 * 3 + 1")).toBe(-5);
		expect(run("1 + 2 > 2 && 2 < 1 || true")).toBe(true);
		expect(run("!false && 1 == 1.0")).toBe(true);
		expect(run("2 >= 2 && 2 <= 1")).toBe(false);
		expect(run("1 === 1 && 1 !== 2")).toBe(true);
	});

	test("literals: numbers, strings with escapes, booleans, null, lists, regular expressions", () => {
		expect(run("1.5e2")).toBe(150);
		expect(run('\'it\\\'s\' + "\\t\\"x\\""')).toBe('it\'s\t"x"');
		expect(run("null")).toBeNull();
		expect(run("[1, 'a', [true]]")).toEqual([1, "a", [true]]);
		expect(run("/a[/]b/gi")).toBeInstanceOf(RegexValue);
		// After an operand `/` divides.
		expect(run("price / age")).toBe(5);
	});

	test("a malformed formula is a syntax error naming the position", () => {
		expect(() => parseExpression("1 +")).toThrow(ExpressionSyntaxError);
		expect(errorOf(run("1 +"))).toContain("Expected a value at end of formula");
		expect(errorOf(run('"open'))).toContain("Unterminated string");
		expect(errorOf(run("price @ 2"))).toContain('Unexpected "@" at position 7');
		expect(errorOf(run("max(1, 2"))).toContain('Expected ")"');
		expect(errorOf(run("(1 2)"))).toContain('Expected ")"');
		expect(errorOf(run("1 2"))).toContain('Unexpected "2"');
		expect(errorOf(run("/unterminated"))).toContain("Unterminated regular expression");
		expect(errorOf(run("/(/"))).toContain("Invalid regular expression");
		expect(errorOf(run("file.")).toString()).toContain("Expected a property or function name");
		expect(errorOf(run(")"))).toContain('Unexpected ")"');
	});

	test("Obsidian's parser rejects object literals, unary plus and a method on a bare number", () => {
		expect(errorOf(run('{"a": 1}.keys()'))).toContain('Unexpected "{" at position 1');
		expect(errorOf(run("+price"))).toContain('Unexpected "+" at position 1');
		expect(errorOf(run("1.isTruthy()"))).toContain('A number cannot be followed by "."');
		expect(errorOf(run("5.isEmpty()"))).toContain("write (5).name");
		expect(run("(1).isTruthy()")).toBe(true);
		expect(run("(5).isEmpty()")).toBe(false);
		expect(run("1.5 + .5")).toBe(2);
	});
});

describe("properties", () => {
	test("note properties, bare or scoped, and bracket access", () => {
		expect(run("status")).toBe("Done");
		expect(run("note.status")).toBe("Done");
		expect(run('note["my prop"] + 1')).toBe(6);
		expect(run("meta.a")).toBe(1);
		expect(run('meta["b"]')).toBe("two");
		expect(run("scores[0]")).toBe(3);
		expect(run("missing")).toBeNull();
		expect(run("missing.deeper")).toBeNull();
		// Prototype members are never properties.
		expect(run("constructor")).toBeNull();
		expect(run("note.toString")).toBeNull();
	});

	test("file properties", () => {
		// A note's name has no `.md` in Obsidian's runtime; any other file keeps its extension.
		expect(run("file.name")).toBe("Alpha");
		expect(run("file.name", "pic.png")).toBe("pic.png");
		expect(run("file.basename")).toBe("Alpha");
		expect(run("file.path")).toBe("Projects/Alpha.md");
		expect(run("file.folder")).toBe("Projects");
		expect(run("file.folder", "Typed.md")).toBe("/");
		expect(run("file.ext")).toBe("md");
		expect(run("file.size")).toBeGreaterThan(100);
		expect(run("file.ctime")).toBeInstanceOf(DateValue);
		expect(run("file.mtime > date('2000-01-01')")).toBe(true);
		expect(run("file.tags")).toEqual(["project", "work/client"]);
		// Frontmatter links, then the body's links, then its embeds; repeats kept.
		expect(run("file.links.map(value.toString())")).toEqual([
			"[[People/Ann|People/Ann]]",
			"[[People/Ann|People/Ann]]",
			"[[People/Bob|People/Bob]]",
			"[[Beta|Beta]]",
			"[[pic.png|pic.png]]",
		]);
		expect(run("file.embeds.map(value.toString())")).toEqual(["[[pic.png|pic.png]]"]);
		expect(run("file.backlinks.map(value.toString())")).toEqual([
			"[[People/Ann.md|Ann]]",
			"[[Projects/Beta.md|Beta]]",
		]);
		expect(show("file.properties.status")).toBe("Done");
		expect(run("file.file")).toBeInstanceOf(FileValue);
		expect(run("file.ext", "pic.png")).toBe("png");
		expect(run("file.size", "pic.png")).toBe(3);
		expect(run("file.properties.isEmpty()", "pic.png")).toBe(true);
		expect(run("file.name", "")).toBeNull();
		expect(run("note", "")).toBeNull();
	});

	test("frontmatter values become dates, links and lists; types.json decides the rest", () => {
		expect(run("due")).toBeInstanceOf(DateValue);
		expect(show("due")).toBe("2024-05-01");
		expect(show("started")).toBe("2024-05-01 10:30:00");
		expect(run("owner")).toBeInstanceOf(LinkValue);
		expect(run("owner.asFile().name")).toBe("Ann");
		expect(run("rating + 1", "Typed.md")).toBe(5);
		expect(run("flag", "Typed.md")).toBe(true);
		expect(run("label", "Typed.md")).toBe("2024-01-01");
		expect(show("split", "Typed.md")).toBe("2024-02-03 04:05:00");
	});

	test("formula properties reference other formulas; cycles and unknown names are errors", () => {
		const environment = env({
			ppu: "price / age",
			taxed: "formula.ppu * 1.1",
			broken: "1 +",
			a: "formula.b + 1",
			b: "formula.a + 1",
			self: 'formula["self"]',
		});
		expect(run("formula.taxed.round(2)", undefined, environment)).toBe(5.5);
		expect(run('formula["ppu"]', undefined, environment)).toBe(5);
		expect(errorOf(run("formula.a", undefined, environment))).toBe(
			"Circular formula reference: a → b → a",
		);
		expect(errorOf(run("formula.self", undefined, environment))).toBe(
			"Circular formula reference: self → self",
		);
		expect(errorOf(run("formula.broken", undefined, environment))).toContain("Syntax error");
		expect(errorOf(run("formula.nope", undefined, environment))).toBe('Unknown formula "nope"');
		expect(errorOf(run("formula", undefined, environment))).toContain("formula name");
		expect(
			propertyValue(
				parsePropertyId("formula.ppu"),
				environment,
				new RowScope(file("Projects/Alpha.md")),
			),
		).toBe(5);
	});

	test("`this` is the base's own file: its fields, its properties, links to it", () => {
		expect(run("this.file.name")).toBe("Ann");
		expect(run("this.role")).toBe("lead");
		expect(run("this.note.role")).toBe("lead");
		expect(run("this.file.folder")).toBe("People");
		expect(run("file.hasLink(this.file)", "Projects/Beta.md")).toBe(false);
		expect(run("file.hasLink(this)", "Projects/Alpha.md")).toBe(true);
		expect(run("owner == this")).toBe(true);
		expect(run("authors.contains(this)")).toBe(true);
		expect(run("authors.contains(this)", "Projects/Alpha.md", env({}, "Projects/Beta.md"))).toBe(
			false,
		);
		const nothis = { ...env(), thisFile: undefined };
		expect(run("this", undefined, nothis)).toBeNull();
	});

	test("property ids parse into their scope", () => {
		expect(parsePropertyId("note.my prop")).toEqual({
			id: "note.my prop",
			kind: "note",
			name: "my prop",
		});
		expect(parsePropertyId("file.ext")).toMatchObject({ kind: "file", name: "ext" });
		expect(parsePropertyId("status")).toMatchObject({ kind: "note", name: "status" });
		expect(
			propertyValue(parsePropertyId("file.bogus"), env(), new RowScope(file("Typed.md"))),
		).toBeNull();
		expect(propertyValue(parsePropertyId("status"), env(), new RowScope(undefined))).toBeNull();
	});
});

describe("dates and durations", () => {
	test("durations add by the calendar for months, exactly for the rest", () => {
		expect(show('date("2024-12-01") + "1M" + "4h" + "3m"')).toBe("2025-01-01 04:03:00");
		expect(show('date("2024-01-31") + "1 month"')).toBe("2024-02-29");
		expect(show('date("2024-03-10") - "2w"')).toBe("2024-02-25");
		expect(show('date("2024-03-10") + "1y"')).toBe("2025-03-10");
		expect(show('"1d" + date("2024-03-10")')).toBe("2024-03-11");
		expect(show('now() + "1 day"')).toBe("2024-05-11 12:00:00");
		expect(show("today()")).toBe("2024-05-10");
		// date − date is a Duration in Obsidian's runtime; divided by a number it is milliseconds.
		expect(run('(now() + "1d") - now()')).toEqual(new DurationValue(0, 86_400_000));
		expect(run('((now() + "1d") - now()).toString()')).toBe("a day");
		expect(errorOf(run('number((now() + "1d") - now())'))).toBe(
			"Cannot convert Duration to a number",
		);
		expect(run('(date("2024-05-11") - today()) / 86400000')).toBe(1);
		expect(run('((date("2024-05-11") - today()) / 86400000).round() + 1')).toBe(2);
		expect(run('date("2024-05-02") - date("2024-05-01") > 0')).toBe(true);
		expect(show('date("2024-05-02") - "2024-05-01"')).toBe("a day");
		expect(errorOf(run('(date("2024-05-11") - today()).days'))).toBe(
			'Cannot find "days" on type Duration',
		);
		expect(show("now() + (duration('1d') * 2)")).toBe("2024-05-12 12:00:00");
		expect(run("duration('1d') * 2")).toEqual(new DurationValue(0, 2 * 86_400_000));
		expect(show("duration('5h') / 2")).toBe("9000000");
		// Durations read as moment.js humanizes them.
		expect(show("duration('1M 2d') + duration('3h')")).toBe("a month");
		expect(show("-duration('1 year 1s')")).toBe("a year");
		expect(show("duration(60000)")).toBe("a minute");
		expect(run('(duration("1h") * 2).toString()')).toBe("2 hours");
		expect(errorOf(run('2 * duration("1h")'))).toBe("Invalid operator between Number and Duration");
		expect(errorOf(run('duration("1h") - 1'))).toBe("Invalid operator between Duration and Number");
		expect(errorOf(run("duration('soon')"))).toContain("duration() cannot read");
		expect(errorOf(run("duration('3 parsecs')"))).toContain("duration() cannot read");
	});

	test("comparisons and fields", () => {
		expect(run("file.mtime > now() - '100y'")).toBe(true);
		expect(run('due < date("2024-06-01")')).toBe(true);
		expect(run('due == "2024-05-01"')).toBe(true);
		expect(run('due > "not a date"')).toBe(false);
		expect(run("started.year")).toBe(2024);
		expect(run("started.month")).toBe(5);
		expect(run("started.day")).toBe(1);
		expect(run("started.hour")).toBe(10);
		expect(run("started.minute")).toBe(30);
		expect(run("started.second")).toBe(0);
		expect(run("started.millisecond")).toBe(0);
		expect(errorOf(run("started.week"))).toBe('Cannot find "week" on type Date');
	});

	test("date functions", () => {
		expect(show("started.date()")).toBe("2024-05-01");
		expect(run('started.format("dddd, MMMM Do YYYY [at] HH:mm")')).toBe(
			"Wednesday, May 1st 2024 at 10:30",
		);
		expect(run("started.format()")).toBe("2024-05-01");
		expect(run("started.time()")).toBe("10:30:00");
		expect(run("due.isEmpty()")).toBe(false);
		expect(run('date("2024-05-07").relative()')).toBe("4 days ago");
		expect(run('date("2024-05-10 13:00").relative()')).toBe("in an hour");
		expect(run('(now() - "10s").relative()')).toBe("a few seconds ago");
		expect(run('(now() + "1m").relative()')).toBe("in a minute");
		expect(run('(now() - "20m").relative()')).toBe("20 minutes ago");
		expect(run('(now() - "5h").relative()')).toBe("5 hours ago");
		expect(run('(now() - "30h").relative()')).toBe("a day ago");
		expect(run('(now() - "40d").relative()')).toBe("a month ago");
		expect(run('(now() - "100d").relative()')).toBe("3 months ago");
		expect(run('(now() - "400d").relative()')).toBe("a year ago");
		expect(run('(now() + "3y").relative()')).toBe("in 3 years");
		expect(run('date("2024-05-01T10:00:00.5Z")')).toEqual(
			new DateValue(Date.UTC(2024, 4, 1, 10, 0, 0, 500), true),
		);
		expect(run('date("2024-05-01T10:00:00+02:00")')).toEqual(
			new DateValue(Date.UTC(2024, 4, 1, 8), true),
		);
		expect(errorOf(run('date("someday")'))).toContain('date() cannot read "someday"');
		expect(errorOf(run('date("2024-02-30")'))).toContain("cannot read");
		expect(errorOf(run("date(true)"))).toContain("date() needs a string");
		expect(run("date(0)")).toEqual(new DateValue(0, true));
		expect(run("date(due) == due")).toBe(true);
	});
});

describe("global functions", () => {
	test("if, list, number, max, min, escapeHTML, html, icon, image", () => {
		expect(run('if(price > 5, "high", "low")')).toBe("high");
		expect(run('if(missing, "yes")')).toBeNull();
		expect(errorOf(run("if(true)"))).toContain("if() needs");
		expect(errorOf(run("if(nope(), 1, 2)"))).toBe('Cannot find function "nope"');
		expect(run('list("value")')).toEqual(["value"]);
		expect(run("list([1])")).toEqual([1]);
		expect(run("list(missing)")).toEqual([]);
		expect(run('number("3.4")')).toBe(3.4);
		expect(run("number(true)")).toBe(1);
		expect(run("number(due)")).toBe(new Date(2024, 4, 1).getTime());
		expect(run("number(missing)")).toBeNull();
		expect(errorOf(run('number("abc")'))).toBe('Unable to parse "abc" as a number.');
		expect(run("max(1, 5, 3)")).toBe(5);
		expect(run("min(4, 2, 8)")).toBe(2);
		expect(run("max()")).toBeNull();
		expect(run('escapeHTML("<b>\\"x\\"</b>")')).toBe("&lt;b&gt;&quot;x&quot;&lt;/b&gt;");
		expect(run('html("<b>x</b>")')).toEqual(new HtmlValue("<b>x</b>"));
		expect(run('icon("arrow-right")')).toEqual(new IconValue("arrow-right"));
		expect(run('image("https://example.com/a.png")')).toBeInstanceOf(ImageValue);
		expect(run("image(missing)")).toBeNull();
		const first = run("random()");
		expect(typeof first).toBe("number");
		expect(first).toBe(run("random()"));
		expect(run("random() == random()")).toBe(false);
	});

	test("link and file resolve like a wikilink in the base", () => {
		const link = run('link("Alpha", "the alpha")');
		expect(link).toBeInstanceOf(LinkValue);
		expect((link as LinkValue).file?.path).toBe("Projects/Alpha.md");
		expect((link as LinkValue).display).toBe("the alpha");
		expect(show('link("[[Beta|B]]")')).toBe("[[Beta|B]]");
		expect(run('link("Some Note").toString()')).toBe("[[Some Note]]");
		expect(run('link("Some Note", "Shown").toString()')).toBe("[[Some Note|Shown]]");
		expect(show('link("https://obsidian.md")')).toBe("https://obsidian.md");
		expect(show("link(file)")).toBe("[[Projects/Alpha.md]]");
		expect(show('link(owner, icon("user"))')).toBe("[[People/Ann|user]]");
		expect(errorOf(run("link(3)"))).toContain("link() needs a path");
		expect(run('file("Beta").name')).toBe("Beta");
		expect(run('file(link("[[Alpha]]")).basename')).toBe("Alpha");
		expect(run("file(file).path")).toBe("Projects/Alpha.md");
		expect(run('file("Nowhere")')).toBeNull();
		expect(errorOf(run("unknownFn()"))).toBe('Cannot find function "unknownFn"');
		expect(errorOf(run("(1)(2)"))).toBe("Only functions can be called");
	});
});

describe("methods by type", () => {
	test("any: isTruthy, isType, toString", () => {
		expect(run("(1).isTruthy()")).toBe(true);
		expect(run("''.isTruthy()")).toBe(false);
		expect(run('"example".isType("string") && true.isType("boolean")')).toBe(true);
		expect(run('[1].isType("list") && due.isType("date") && owner.isType("link")')).toBe(true);
		expect(run('file.isType("file") && meta.isType("object") && /x/.isType("regexp")')).toBe(true);
		expect(run('missing.isType("null")')).toBe(true);
		expect(run("(123).toString()")).toBe("123");
		expect(run('date("2026-06-10 12:34:56").toString()')).toBe("2026-06-10T12:34:56");
		expect(run('date("2026-06-10").toString()')).toBe("2026-06-10");
		expect(run('image("https://obsidian.md/logo.png").toString()')).toBe(
			"![](https://obsidian.md/logo.png)",
		);
		expect(run("image(owner).toString() + image(file).toString()")).toBe(
			"![](People/Ann)![](Projects/Alpha.md)",
		);
		expect(run("file.toString()")).toBe("Projects/Alpha.md");
		expect(run("[1, [2, 3]].toString()")).toBe("1, 2, 3");
		expect(run("meta.toString()")).toBe("{a: 1, b: two}");
		expect(run("missing.toString()")).toBe("");
		expect(run("missing.isEmpty()")).toBe(true);
		expect(run("missing.lower()")).toBeNull();
		expect(errorOf(run("true.lower()"))).toBe('Cannot find function "lower" on type Boolean');
		expect(errorOf(run('"x".contains(nope())'))).toContain("Cannot find function");
		expect(errorOf(run("nope().lower()"))).toContain("Cannot find function");
	});

	test("string", () => {
		expect(run('"hello".contains("ell")')).toBe(true);
		expect(run('"hello".containsAll("h", "e")')).toBe(true);
		expect(run('"hello".containsAny("x", "y", "e")')).toBe(true);
		expect(run('"hello".startsWith("he") && "hello".endsWith("lo")')).toBe(true);
		expect(run('"".isEmpty() && !"a".isEmpty()')).toBe(true);
		expect(run('"MiXed".lower() + "MiXed".upper()')).toBe("mixedMIXED");
		expect(run('"hello wide-world".title()')).toBe("Hello Wide-World");
		expect(run('"  hi  ".trim()')).toBe("hi");
		expect(run('"a:b:c:d".replace(/:/, "-")')).toBe("a-b:c:d");
		expect(run('"a:b:c:d".replace(/:/g, "-")')).toBe("a-b-c-d");
		expect(run('"a:b:c".replace(":", "$&")')).toBe("a$&b$&c");
		expect(run('"John Smith".replace(/(\\w+) (\\w+)/, "$2, $1")')).toBe("Smith, John");
		expect(run('"123".repeat(2)')).toBe("123123");
		expect(run('"hello".reverse()')).toBe("olleh");
		expect(run('"hello".slice(1, 4) + "hello".slice(3)')).toBe("elllo");
		expect(run('"a,b,c,d".split(",", 3)')).toEqual(["a", "b", "c"]);
		expect(run('"a1b2c".split(/\\d/)')).toEqual(["a", "b", "c"]);
		expect(run('"hello".length')).toBe(5);
		expect(run('"hello"[1]')).toBe("e");
	});

	test("number", () => {
		expect(run("(-5).abs()")).toBe(5);
		expect(run("(2.1).ceil() + (2.9).floor()")).toBe(5);
		expect(run("(2.5).round()")).toBe(3);
		expect(run("(2.3333).round(2)")).toBe(2.33);
		expect(run("(1.005).round(2)")).toBe(1.01);
		expect(run("(3.14159).toFixed(2)")).toBe("3.14");
		expect(run("(5).isEmpty()")).toBe(false);
	});

	test("list", () => {
		expect(run("[1,2,3].contains(2) && [1,2,3].containsAll(2,3) && [1,2,3].containsAny(3,4)")).toBe(
			true,
		);
		expect(run("tags.contains('project')")).toBe(true);
		expect(run("[1,2,3,4].filter(value > 2)")).toEqual([3, 4]);
		expect(run("[1,2,3,4].filter(index == 0)")).toEqual([1]);
		expect(run("[1,2,3,4].map(value + 1)")).toEqual([2, 3, 4, 5]);
		expect(run("[1,2,3].map(value * index)")).toEqual([0, 2, 6]);
		expect(run("[1,2,3].reduce(acc + value, 0)")).toBe(6);
		expect(
			run(
				'[3, "x", 9, 4].filter(value.isType("number")).reduce(if(acc == null || value > acc, value, acc), null)',
			),
		).toBe(9);
		expect(run("[[1,[2]],[3]].map(value.flat().map(value * 10)).flat()")).toEqual([10, 20, 30]);
		expect(run("[1,[2,[3]]].flat()")).toEqual([1, 2, 3]);
		expect(run('[1,2,3].join(", ") + [1,2].join()')).toBe("1, 2, 31,2");
		expect(run("scores.reverse()")).toEqual([2, 1, 3]);
		expect(run("scores")).toEqual([3, 1, 2]);
		expect(run("[1,2,3,4].slice(1,3)")).toEqual([2, 3]);
		expect(run("[1,2,3,4].slice(2)")).toEqual([3, 4]);
		expect(run("[3, null, 1, 2].sort()")).toEqual([1, 2, 3, null]);
		expect(run('["c", "a", "b"].sort()')).toEqual(["a", "b", "c"]);
		// Mixed kinds keep a stable order: by kind, then value.
		expect(run("[1, 'a', true].sort()")).toEqual([true, 1, "a"]);
		expect(run("[1,2,2,3].unique()")).toEqual([1, 2, 3]);
		expect(run("[].isEmpty() && ![1].isEmpty()")).toBe(true);
		expect(run("scores.length + scores.sum()")).toBe(9);
		expect(run("[1,2,3,4].mean()")).toBe(2.5);
		expect(run("[].mean()")).toBeNull();
		expect(run("[5,1,3].median() + [4,1,3,2].median()")).toBe(5.5);
		expect(run("[].median()")).toBeNull();
		expect(run("scores.min() + scores.max()")).toBe(4);
		expect(run("scores[5]")).toBeNull();
		expect(errorOf(run("[1].filter()"))).toContain("filter() needs");
		expect(errorOf(run("[1].map()"))).toContain("map() needs");
		expect(errorOf(run("[1].reduce()"))).toContain("reduce() needs");
		expect(errorOf(run("[1].filter(nope())"))).toContain("Cannot find function");
		expect(errorOf(run("[1].map(nope())"))).toContain("Cannot find function");
		expect(errorOf(run("[1, 2].reduce(nope(), 0)"))).toContain("Cannot find function");
		expect(errorOf(run("[nope()]"))).toContain("Cannot find function");
		expect(errorOf(run("[1][nope()]"))).toContain("Cannot find function");
		expect(errorOf(run("[1][true]"))).toBe('Cannot find "true" on type List');
	});

	test("link", () => {
		expect(run("owner.asFile().basename")).toBe("Ann");
		expect(run('link("Nowhere").asFile()')).toBeNull();
		expect(run('owner.linksTo(file("Alpha"))')).toBe(true);
		expect(run('owner.linksTo("Beta")')).toBe(false);
		expect(run('link("Nowhere").linksTo(file)')).toBe(false);
		// Links that resolve to nothing are equal only when their text is.
		expect(run('link("Nowhere") == link("Nowhere")')).toBe(true);
		expect(run('link("Nowhere") == link("nowhere.md")')).toBe(false);
		expect(run('link("Nowhere") == "Nowhere"')).toBe(true);
		expect(run('owner == "People/Ann"')).toBe(true);
		expect(errorOf(run("owner.display"))).toBe('Cannot find "display" on type Link');
	});

	test("file", () => {
		expect(show('file.asLink("Go")')).toBe("[[Projects/Alpha.md|Go]]");
		expect(run("file.asLink().asFile() == file")).toBe(true);
		expect(run('file.hasLink("Beta") && file.hasLink(file("pic.png"))')).toBe(true);
		expect(run('file.hasLink("Nowhere")')).toBe(false);
		expect(run('file.hasLink("Beta")', "Projects/Beta.md")).toBe(false);
		expect(run('file.hasProperty("status") && !file.hasProperty("nope")')).toBe(true);
		expect(run('file.hasTag("work")')).toBe(true);
		expect(run('file.hasTag("#project", "x")')).toBe(true);
		expect(run('file.hasTag("work/cli")')).toBe(false);
		expect(run('file.hasTag("project")', "Projects/Beta.md")).toBe(true);
		expect(
			run('file.inFolder("Projects") && file.inFolder("/Projects/") && file.inFolder("")'),
		).toBe(true);
		expect(run('file.inFolder("Proj")')).toBe(false);
	});

	test("object and regular expression", () => {
		expect(run("meta.keys()")).toEqual(["a", "b"]);
		expect(run("meta.values()")).toEqual([1, "two"]);
		expect(run("!meta.isEmpty()")).toBe(true);
		expect(run("meta.nope")).toBeNull();
		expect(run('/abc/.matches("abcde") && !/^b/.matches("abc")')).toBe(true);
		expect(run('/a/g.matches("a") && /a/g.matches("a")')).toBe(true);
	});
});

describe("missing fields and errors, as Obsidian treats them", () => {
	test("a field a value's type lacks is Obsidian's error value, a warning", () => {
		const cases: Record<string, string> = {
			"(1).nope": 'Cannot find "nope" on type Number',
			'"text".nope': 'Cannot find "nope" on type String',
			"due.nope": 'Cannot find "nope" on type Date',
			"duration('1d').days": 'Cannot find "days" on type Duration',
			"[1, 2].nope": 'Cannot find "nope" on type List',
			"owner.nope": 'Cannot find "nope" on type Link',
			"file.nope": 'Cannot find "nope" on type File',
			"true.nope": 'Cannot find "nope" on type Boolean',
			"/x/.source": 'Cannot find "source" on type RegExp',
			"file.__proto__": 'Cannot find "__proto__" on type File',
			'[1]["x"]': 'Cannot find "x" on type List',
		};
		for (const [source, message] of Object.entries(cases)) {
			const value = run(source);
			expect(value).toEqual(new ErrorValue(message, "warning"));
		}
		// The error flows through `if()`: the cell is empty, the build carries on.
		expect(errorOf(run('if((due - today()).days, "soon", "later")'))).toContain("Duration");
	});

	test("a missing property, or a key an object lacks, is simply nothing", () => {
		for (const source of [
			"missing",
			"note.missing",
			"meta.nope",
			'meta["constructor"]',
			"this.nope",
			"file.properties.nope",
		]) {
			expect(run(source)).toBeNull();
		}
	});

	test("data that does not fit a valid formula is a warning; a broken base is an error", () => {
		const severity = (source: string) => {
			const value = run(source);
			return value instanceof ErrorValue ? value.severity : "no error";
		};
		// About this note's data: the same formula works for other notes.
		expect(severity("status.round()")).toBe("warning");
		expect(severity('number("abc")')).toBe("warning");
		expect(severity('date("someday")')).toBe("warning");
		expect(severity("date(missing)")).toBe("warning");
		expect(severity('duration("soon")')).toBe("warning");
		expect(severity("link(3)")).toBe("warning");
		expect(severity("[1] * 2")).toBe("warning");
		expect(severity("-[1]")).toBe("warning");
		// About the base itself, whatever the notes hold.
		expect(severity("1 +")).toBe("error");
		expect(severity("doesNotExist()")).toBe("error");
		expect(severity("formula.nope")).toBe("error");
		expect(severity("(1)(2)")).toBe("error");
		expect(severity("[1].map()")).toBe("error");
	});
});

describe("matches Obsidian's runtime where it differs from the docs", () => {
	test("hasLink: a target that resolves matches by file, from any case or subpath", () => {
		const beta = "Projects/Beta.md";
		expect(run('file.hasLink("alpha.md")', beta)).toBe(true);
		expect(run('file.hasLink("Projects/Alpha")', beta)).toBe(true);
		expect(run('file.hasLink("Alpha#Elsewhere")', beta)).toBe(true);
		expect(run('link("alpha").asFile().path', beta)).toBe("Projects/Alpha.md");
		expect(run('link("Alpha#No such heading").asFile().path', beta)).toBe("Projects/Alpha.md");
	});

	test("hasLink: a target that resolves to nothing matches only a link written exactly so", () => {
		const beta = "Projects/Beta.md";
		expect(run('file.hasLink("Missing Note")', beta)).toBe(true);
		expect(run('file.hasLink("Missing Note.md")', beta)).toBe(false);
		expect(run('file.hasLink("Gone.md")', beta)).toBe(true);
		expect(run('file.hasLink("Gone")', beta)).toBe(false);
		expect(run('file.hasLink(link("Missing Note"))', beta)).toBe(true);
		expect(run('file.links.contains(link("Missing Note"))', beta)).toBe(true);
	});

	test("file.links equality is by file; unique() is by how the link reads", () => {
		const beta = "Projects/Beta.md";
		expect(run("file.links.length", beta)).toBe(5);
		expect(run('file.links.filter(value == link("Alpha")).length', beta)).toBe(3);
		expect(run("file.links.unique().length", beta)).toBe(5);
		expect(run("[link('Alpha'), link('Alpha'), link('Alpha', 'A')].unique().length")).toBe(2);
		expect(run("file.links.map(value.toString())", beta)).toEqual([
			"[[Alpha|Alpha]]",
			"[[Alpha|Again]]",
			"[[Alpha#No such heading|Alpha > No such heading]]",
			"[[Missing Note|Missing Note]]",
			"[[Gone.md|Gone]]",
		]);
	});

	test("Obsidian's error messages", () => {
		expect(errorOf(run('link("Some Note").path'))).toBe('Cannot find "path" on type Link');
		expect(errorOf(run('"asdf".asdfasdf'))).toBe('Cannot find "asdfasdf" on type String');
		expect(errorOf(run('"asdf".asdfasdf()'))).toBe(
			'Cannot find function "asdfasdf" on type String',
		);
		expect(errorOf(run("doesNotExist()"))).toBe('Cannot find function "doesNotExist"');
		expect(errorOf(run('number("nope")'))).toBe('Unable to parse "nope" as a number.');
	});
});

describe("operators on values", () => {
	test("+ joins text and lists; arithmetic with a missing value is missing", () => {
		expect(run('file.basename + " - " + status')).toBe("Alpha - Done");
		expect(run('"due " + due')).toBe("due 2024-05-01");
		expect(run('"x" + missing')).toBe("x");
		expect(run("[1] + [2]")).toEqual([1, 2]);
		expect(run("price + missing")).toBeNull();
		expect(run("missing * 2")).toBeNull();
		expect(run('"6" / 2 - "1"')).toBe(2);
		expect(run("-missing")).toBeNull();
		expect(run("-'3'")).toBe(-3);
		expect(run("!missing")).toBe(true);
		expect(errorOf(run("[1] * 2"))).toBe("Invalid operator between List and Number");
		expect(errorOf(run("-[1]"))).toBe('Invalid operator "-" for List');
		expect(errorOf(run('duration("1d") * "x"'))).toBe(
			"Invalid operator between Duration and String",
		);
		expect(errorOf(run('duration("1d") / "x"'))).toBe(
			"Invalid operator between Duration and String",
		);
		expect(errorOf(run("-nope()"))).toContain("Cannot find function");
		expect(errorOf(run("nope() + 1"))).toContain("Cannot find function");
		expect(errorOf(run("1 + nope()"))).toContain("Cannot find function");
	});

	test("&& and || return an operand, as in JavaScript", () => {
		expect(run('missing || "fallback"')).toBe("fallback");
		expect(run('status && "has status"')).toBe("has status");
		expect(run("0 && 1")).toBe(0);
	});

	test("equality and ordering across types", () => {
		expect(run('5 == "5" && "5" == 5 && !(5 == "")')).toBe(true);
		expect(run("[1, [2]] == [1, [2]] && [1] != [1, 2]")).toBe(true);
		expect(run("meta == file.properties.meta && meta != file.properties")).toBe(true);
		expect(run("/a/g == /a/g && /a/ != /a/g")).toBe(true);
		expect(run('icon("x") == icon("x")')).toBe(true);
		expect(run("duration('1d') == duration('24h')")).toBe(true);
		expect(run("missing == null && missing != 0")).toBe(true);
		expect(run("true == 1")).toBe(false);
		expect(run('"b" > "a" && "item 10" > "item 9"')).toBe(true);
		expect(run("true > false")).toBe(true);
		expect(run('3 > "2" && "4" > 3 && !(3 > "x") && !("x" < 3)')).toBe(true);
		expect(run("duration('2h') > 3600000 && 1 < duration('1s')")).toBe(true);
		expect(run("[1] < 2")).toBe(false);
		expect(run("file == file && file != this")).toBe(true);
		expect(run("owner == file('Ann')")).toBe(true);
		expect(run('file == "Projects/Alpha" && file == "alpha"')).toBe(true);
		expect(run("file == 3")).toBe(false);
		expect(run("file.asLink() > link('Aardvark')")).toBe(true);
	});
});

/** The value's error, with its severity: data-dependent problems are warnings. */
function failure(value: Value): { message: string; severity: string } {
	if (!(value instanceof ErrorValue)) throw new Error(`expected an error, got ${String(value)}`);
	return { message: value.message, severity: value.severity };
}

describe("escape vectors", () => {
	test("prototype members are unreachable however the name is written", () => {
		expect(errorOf(run('"a".constructor'))).toBe('Cannot find "constructor" on type String');
		expect(errorOf(run('"a"["con" + "structor"]'))).toBe(
			'Cannot find "constructor" on type String',
		);
		expect(errorOf(run('"a".toString.constructor'))).toBe('Cannot find "toString" on type String');
		expect(errorOf(run("[1].map.call"))).toBe('Cannot find "map" on type List');
		expect(errorOf(run('constructor("return 1")'))).toBe('Cannot find function "constructor"');
		expect(errorOf(run('"a".valueOf()'))).toBe('Cannot find function "valueOf" on type String');
		expect(errorOf(run('"a".__defineGetter__("x")'))).toContain("Cannot find function");
		expect(run('note["__proto__"]')).toBeNull();
		expect(run("file.properties.constructor")).toBeNull();
		expect(run("meta.hasOwnProperty")).toBeNull();
		expect(errorOf(run('formula["__proto__"]'))).toBe('Unknown formula "__proto__"');
	});
});

describe("denial of service", () => {
	test("huge text and lists are warnings, refused before they allocate", () => {
		const cases: Record<string, string> = {
			'"x".repeat(1000000000)':
				"A text value would be 1000000000 characters long, over the limit of 10000000",
			'"x".repeat(6000000) + "x".repeat(6000000)': "A text value would be 12000000",
			'["x".repeat(4000000), "x".repeat(4000000), "x".repeat(4000000)].join("")':
				"A text value would be",
			'"a".repeat(100000).replace(/a/g, "b".repeat(1000))': "A text value would be",
			'"a".repeat(100000).replace("a", "b".repeat(1000))': "A text value would be",
			'"x".repeat(2000000).split("")': "A list would have 2000000 items",
			'"x".repeat(600000).split("") + "x".repeat(600000).split("")':
				"A list would have 1200000 items",
		};
		for (const [source, message] of Object.entries(cases)) {
			const { message: actual, severity } = failure(run(source));
			expect(actual, source).toContain(message);
			expect(severity, source).toBe("warning");
		}
		const square = `[${Array(1001).fill('"x".repeat(1001).split("")').join(", ")}]`;
		for (const method of ["flat()", "sum()", "max()"]) {
			expect(failure(run(`${square}.${method}`)).message, method).toContain("A list would have");
		}
		// Below the limits the values are whole.
		expect(run('"x".repeat(200000).length')).toBe(200_000);
		expect(run('"a-b".replace("-", "$&$&")')).toBe("a$&$&b");
	});

	test("list functions over long lists stop at the render's work budget", () => {
		const { message, severity } = failure(
			run('"x".repeat(5000).split("").map("x".repeat(5000).split(""))'),
		);
		expect(message).toBe(
			"The base's formulas ran more than 20000000 steps and was stopped; Obsidian has no such limit, but a site build must finish.",
		);
		expect(severity).toBe("warning");
		// The budget belongs to one render: a fresh environment starts again.
		const environment = env();
		expect(
			run('"x".repeat(100).split("").map(value).length', "Projects/Alpha.md", environment),
		).toBe(100);
	});

	test("an unsafe regex literal is a syntax error, found before it runs", () => {
		for (const source of [
			'/(a+)+$/.matches("aaaa")',
			'"aaaa".replace(/(a*)*b/, "x")',
			'"aaaa".split(/(?:a|aa+)+/)',
		]) {
			const { message, severity } = failure(run(source));
			expect(message, source).toStartWith("Syntax error: Regular expression /");
			expect(message, source).toContain(
				"uses nested quantifiers (possible catastrophic backtracking detected); Obsidian would run it",
			);
			expect(severity, source).toBe("error");
		}
		expect(run('/(ab)+$/.matches("abab")')).toBe(true);
	});

	test("a stack overflow is an error value, and leaves the row usable", () => {
		const message =
			"The expression is nested too deeply or recurses too far to evaluate (the interpreter ran out of stack).";
		expect(failure(run(`${"(".repeat(50000)}1${")".repeat(50000)}`))).toEqual({
			message: `Syntax error: ${message}`,
			severity: "error",
		});
		const chain: Record<string, string> = { ok: "1 + 1" };
		for (let index = 0; index < 50_000; index += 1)
			chain[`f${index}`] = `formula.f${index + 1} + 1`;
		chain.f50000 = "0";
		const environment = env(chain);
		const row = new RowScope(file("Projects/Alpha.md"));
		expect(failure(propertyValue(parsePropertyId("formula.f0"), environment, row))).toEqual({
			message,
			severity: "error",
		});
		expect(row.evaluating).toEqual([]);
		expect(propertyValue(parsePropertyId("formula.ok"), environment, row)).toBe(2);
	});
});
