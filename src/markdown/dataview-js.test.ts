import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildContentIndex } from "./content-index";
import { renderDataviewJs, renderDataviewJsInline } from "./dataview-js";
import type { ContentIndex, ContentPage } from "./types";

const FILES: Record<string, string> = {
	"Home.md": "# Home\n\nLinks [[N/Alpha]].\n\n- [ ] Home task\n    - [x] Sub task\n",
	"N/Alpha.md": [
		"---",
		"status: open",
		"due: 2026-01-09",
		"tags: [proj/sub]",
		"---",
		"Alpha.",
	].join("\n"),
	"N/Beta.md": [
		"---",
		"status: closed",
		"due: 2026-01-05",
		"tags: [proj]",
		"---",
		"Links [[Home]].",
	].join("\n"),
	"N/Gamma.md": ["---", "status: open", "due: 2026-01-10", "---", "Gamma."].join("\n"),
};

let root: string;
let index: ContentIndex;
let home: ContentPage;

beforeAll(async () => {
	root = mkdtempSync(path.join(os.tmpdir(), "obsidian-dataviewjs-"));
	for (const [name, content] of Object.entries(FILES)) {
		const target = path.join(root, name);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, content);
		const mtime = new Date(2026, 9, 7, 8, 0, 0);
		utimesSync(target, mtime, mtime);
	}
	index = await buildContentIndex(root);
	const found = index.pages.find((page) => page.relativePath === "Home.md");
	if (!found) throw new Error("Home.md is not indexed");
	home = found;
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

const js = (source: string) => renderDataviewJs(source, home, index);

describe("statements", () => {
	test("newlines separate statements without semicolons", () => {
		expect(js('const p = dv.current()\ndv.paragraph(p.file.name + "!")').html).toBe(
			'<p class="dataviewjs-paragraph">Home!</p>',
		);
	});

	test("// inside a string is text, and comments are skipped", () => {
		expect(
			js('// a comment\ndv.paragraph("see https://example.com") /* block */\n// trailing').html,
		).toBe(
			'<p class="dataviewjs-paragraph">see <a href="https://example.com">https://example.com</a></p>',
		);
	});

	test("let, reassignment, if/else, for…of and template literals", () => {
		const html = js(
			[
				"let open = 0",
				"for (const p of dv.pages('\"N\"')) {",
				'  if (p.status === "open") open += 1',
				// biome-ignore lint/suspicious/noTemplateCurlyInString: DataviewJS source holding a template literal
				"  else dv.paragraph(`closed: ${p.file.name}`)",
				"}",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: DataviewJS source holding a template literal
				"dv.paragraph(`${open} open`)",
			].join("\n"),
		).html;
		expect(html).toBe(
			'<p class="dataviewjs-paragraph">closed: Beta</p>\n<p class="dataviewjs-paragraph">2 open</p>',
		);
	});

	test("arrow functions with block bodies, ternaries and ??", () => {
		const html = js(
			'const label = (p) => { return p.status === "open" ? "o" : "c" }\ndv.paragraph(dv.pages(\'"N"\').sort(p => p.file.name).map(label).join(""))\ndv.paragraph(dv.current().missing ?? "none")',
		).html;
		expect(html).toBe(
			'<p class="dataviewjs-paragraph">oco</p>\n<p class="dataviewjs-paragraph">none</p>',
		);
	});

	test("assigning to a constant or an undeclared name is an error", () => {
		expect(js("const a = 1\na = 2").error).toContain('cannot assign to the constant "a"');
		expect(js("b = 2").error).toContain('"b" is not declared');
	});
});

describe("dv API", () => {
	test("dv.pages reads DQL sources: subtags, links, negation, case-insensitive folders", () => {
		const names = (source: string) =>
			js(`dv.paragraph(dv.pages(${JSON.stringify(source)}).file.name.sort().join(","))`).html;
		expect(names("#proj")).toBe('<p class="dataviewjs-paragraph">Alpha,Beta</p>');
		expect(names("[[Home]]")).toBe('<p class="dataviewjs-paragraph">Beta</p>');
		expect(names('"n" and -"N/Beta"')).toBe('<p class="dataviewjs-paragraph">Alpha,Gamma</p>');
		expect(js('dv.pages("bogus source")').error).toContain("Unsupported Dataview source");
	});

	test("sort orders dates by time, both directions", () => {
		const order = (direction: string) =>
			js(`dv.paragraph(dv.pages('"N"').sort(p => p.due, "${direction}").file.name.join(","))`).html;
		expect(order("asc")).toBe('<p class="dataviewjs-paragraph">Beta,Alpha,Gamma</p>');
		expect(order("desc")).toBe('<p class="dataviewjs-paragraph">Gamma,Alpha,Beta</p>');
	});

	test("dv.current() carries file.mtime and the rest of file.*", () => {
		expect(js("dv.paragraph(dv.current().file.mtime)").html).toBe(
			'<p class="dataviewjs-paragraph">8:00 AM - October 07, 2026</p>',
		);
		expect(js("dv.paragraph(dv.current().file.mtime.toFormat('yyyy-MM-dd'))").html).toBe(
			'<p class="dataviewjs-paragraph">2026-10-07</p>',
		);
		expect(js("dv.paragraph(dv.current().file.inlinks.length)").html).toBe(
			'<p class="dataviewjs-paragraph">1</p>',
		);
	});

	test("dv.header clamps its level and defaults a non-number to 2", () => {
		expect(js('dv.header(9, "x")').html).toBe("<h6>x</h6>");
		expect(js('dv.header("abc", "x")').html).toBe("<h2>x</h2>");
		expect(js('dv.header(0, "x")').html).toBe("<h1>x</h1>");
	});

	test("tables, lists, groupBy and links", () => {
		const html = js(
			[
				"for (const group of dv.pages('\"N\"').groupBy(p => p.status)) {",
				"  dv.header(3, group.key)",
				'  dv.table(["Note", "Due"], group.rows.map(p => [p.file.link, p.due]))',
				"}",
			].join("\n"),
		).html;
		expect(html).toContain("<h3>closed</h3>");
		expect(html).toContain('<td><a href="/N/Beta">Beta</a></td><td>January 05, 2026</td>');
		expect(js("dv.list([1, [2, 3]])").html).toBe(
			'<ul class="dataviewjs-list"><li>1</li><li><ul class="dataview dataview-ul dataview-result-list-ul"><li class="dataview-result-list-li">2</li><li class="dataview-result-list-li">3</li></ul></li></ul>',
		);
	});

	test("taskList nests subtasks and groups by file unless told not to", () => {
		const grouped = js("dv.taskList(dv.current().file.tasks)").html ?? "";
		expect(grouped).toContain('<h4><a href="/Home">Home</a></h4>');
		expect(grouped.match(/Sub task/g)).toHaveLength(1);
		expect(js("dv.taskList(dv.current().file.tasks, false)").html).not.toContain("<h4>");
	});

	test("dv.func, dv.tryEvaluate, dv.execute and dv.span reuse the DQL engine", () => {
		expect(js('dv.span(dv.func.upper("x"))').html).toBe('<span class="dataviewjs-span">X</span>');
		expect(js('dv.paragraph(dv.tryEvaluate("1 + 2"))').html).toBe(
			'<p class="dataviewjs-paragraph">3</p>',
		);
		expect(js('dv.execute(\'LIST FROM "N" WHERE status = "open"\')').html).toContain(
			'<a href="/N/Alpha">Alpha</a>',
		);
	});

	test("dv.el builds only plain text elements", () => {
		expect(js('dv.el("b", "bold", { cls: "x" })').html).toBe('<b class="x">bold</b>');
		expect(js('dv.el("script", "x")').error).toContain("does not create <script>");
	});
});

describe("values and methods", () => {
	const text = (source: string) => {
		const result = js(`dv.paragraph(${source})`);
		if (result.error) throw new Error(result.error);
		return (result.html ?? "").replace(/^<p class="dataviewjs-paragraph">|<\/p>$/g, "");
	};

	test("string methods behave like JavaScript's", () => {
		expect(
			text(
				'["  Hi ".trim(), "ab".toUpperCase(), "AB".toLowerCase(), "abc".includes("b"), "abc".startsWith("a"), "abc".endsWith("x"), "abc".indexOf("c")].join("|")',
			),
		).toBe("Hi|AB|ab|true|true|false|2");
		expect(
			text(
				'["abcdef".slice(1, 3), "abcdef".slice(-2), "abcdef".substring(4), "a,b,c".split(",").length, "a-b-a".replace("a", "x"), "a-b-a".replaceAll("a", "x")].join("|")',
			),
		).toBe("bc|ef|ef|3|x-b-a|x-b-x");
		expect(
			text(
				'["7".padStart(3, "0"), "7".padStart(3), "7".padEnd(2, "!"), "7".padEnd(2), "ab".repeat(3), "abc".charAt(1), "x".toString(), "a".localeCompare("b")].join("|")',
			),
		).toBe("007|  7|7!|7 |ababab|b|x|-1");
		// `replaceAll` with an empty pattern inserts between every character, as in JavaScript.
		expect(text('"ab".replaceAll("", "-")')).toBe("-a-b-");
		expect(js('dv.paragraph("x".at(0))').error).toContain(
			"Unsupported DataviewJS method: at() on a string",
		);
	});

	test("String, Number and Boolean convert like the JavaScript functions", () => {
		expect(text('[String(12), Number("3.5") + 1, Boolean(""), Boolean("x")].join("|")')).toBe(
			"12|4.5|false|true",
		);
		expect(js("dv.paragraph(Symbol(1))").error).toContain('"Symbol" is not defined');
	});

	test("dates expose Luxon's DateTime fields", () => {
		expect(
			text(
				'["year", "month", "day", "hour", "minute", "second", "millisecond", "weekday", "weekNumber", "weekYear"].map(k => dv.date("2026-08-20T14:05:09.250")[k]).join(",")',
			),
		).toBe("2026,8,20,14,5,9,250,4,34,2026");
		// ISO week-year differs from the calendar year on 2027-01-01 (2026-W53); Sunday is 7.
		expect(
			text(
				'[dv.date("2027-01-01").weekNumber, dv.date("2027-01-01").weekYear, dv.date("2026-08-23").weekday].join(",")',
			),
		).toBe("53,2026,7");
		expect(text('dv.date("2026-08-20").ts === dv.date("2026-08-20").toMillis()')).toBe("true");
		expect(text('dv.date("2026-08-20").quaternion ?? "none"')).toBe("none");
	});

	test("flatMap flattens one level and forEach runs for every element", () => {
		expect(text('[1, 2].flatMap(n => [n, n * 10]).join(",")')).toBe("1,10,2,20");
		expect(text('[1, [2]].flatMap(n => n).join(",")')).toBe("1,2");
		expect(
			js("let sum = 0;\n[1, 2, 3].forEach((n, i) => { sum += n * i })\ndv.paragraph(sum)").html,
		).toBe('<p class="dataviewjs-paragraph">8</p>');
		// As in JavaScript, a newline before `[` does not end the statement.
		expect(
			js("let sum = 0\n[1, 2, 3].forEach((n, i) => { sum += n * i })\ndv.paragraph(sum)").error,
		).toBeDefined();
	});

	test("var declares a reassignable binding; ; and newlines both end statements", () => {
		expect(js("var x = 1\nx += 1; x += 2\ndv.paragraph(x)").html).toBe(
			'<p class="dataviewjs-paragraph">4</p>',
		);
	});

	test("dv.page resolves a path, a [[link]] string or a link; anything else is nothing", () => {
		expect(text('dv.page("N/Alpha").status')).toBe("open");
		expect(text('dv.page("[[N/Beta]]").file.name')).toBe("Beta");
		expect(text('dv.page(dv.fileLink("N/Gamma")).status')).toBe("open");
		expect(text('dv.page("Nowhere") === undefined')).toBe("true");
		expect(text("dv.page(5) === undefined")).toBe("true");
	});
});

describe("sandbox", () => {
	test("host names are refused as identifiers, never inside strings", () => {
		for (const source of [
			"dv.paragraph(process.version)",
			"const f = globalThis",
			"dv.current().constructor",
			"dv.current().__proto__",
			"eval('1')",
		]) {
			expect(js(source).error).toContain("forbidden host or runtime API");
		}
		expect(js('dv.paragraph("Export the document from a window")').html).toBe(
			'<p class="dataviewjs-paragraph">Export the document from a window</p>',
		);
		expect(js("dv.list(dv.pages('\"N/Alpha\"').map(p => p.file.link))").error).toBeUndefined();
	});

	test("only a value's own fields are readable", () => {
		expect(js('dv.paragraph(dv.current()["constructor"])').html).toBe(
			'<p class="dataviewjs-paragraph">-</p>',
		);
		expect(js('dv.paragraph(dv.current()["toString"])').html).toBe(
			'<p class="dataviewjs-paragraph">-</p>',
		);
		expect(js("dv.paragraph(Object.keys({}))").error).toContain('"Object" is not defined');
		expect(js("dv.current().toString()").error).toContain("Unsupported DataviewJS method");
	});

	test("an object key named __proto__ is data, not a prototype", () => {
		expect(js('const o = { "__proto__": 1 }\ndv.paragraph(o["__proto__"])').html).toBe(
			'<p class="dataviewjs-paragraph">1</p>',
		);
	});

	test("unsupported syntax and operators are errors, not skipped statements", () => {
		expect(js("dv.paragraph(2 ** 3)").error).toContain("** operator is not supported");
		expect(js("dv.paragraph(1 & 2)").error).toContain("& operator is not supported");
		expect(js("while (true) {}").error).toContain('"while" is not supported');
		expect(js("dv.paragraph(1) dv.paragraph(2)").error).toContain(
			"expected the end of the statement",
		);
		expect(js('dv.paragraph(dv.current().file.name - "x")').error).toContain(
			"the - operator does not apply",
		);
		expect(js("dv.view('x')").error).toContain("dv.view()");
		expect(js("dv.bogus()").error).toContain("Unsupported DataviewJS function: dv.bogus");
		expect(js("[1].bogus()").error).toContain("Unsupported DataviewJS collection method: bogus");
	});

	test("runaway recursion stops with an error", () => {
		expect(js("const f = (x) => f(x)\nf(1)").error).toContain("too much recursion");
	});
});

describe("escape vectors", () => {
	test("prototype members are unreachable through computed keys and method references", () => {
		// `'a'.toString.constructor`, spelled so the identifier check cannot see it.
		expect(js('dv.paragraph("a"["toString"]["con" + "structor"])').error).toContain(
			'cannot read "constructor" of undefined',
		);
		expect(js('dv.func["con" + "structor"]("return process")()').error).toContain(
			"expected a function",
		);
		expect(js('dv.paragraph(typeof String["con" + "structor"])').html).toBe(
			'<p class="dataviewjs-paragraph">undefined</p>',
		);
		expect(js('dv.paragraph(typeof [1]["con" + "structor"][0])').html).toBe(
			'<p class="dataviewjs-paragraph">undefined</p>',
		);
		expect(js('dv.paragraph(typeof Math["__pro" + "to__"])').html).toBe(
			'<p class="dataviewjs-paragraph">undefined</p>',
		);
	});

	test("Symbol, Reflect, Proxy and JSON do not exist", () => {
		for (const name of ["Symbol", "Reflect", "Proxy", "JSON", "Object"]) {
			expect(js(`dv.paragraph(typeof ${name}.x)`).error).toContain(`"${name}" is not defined`);
		}
	});

	test("coercing an object never calls its toString or valueOf", () => {
		expect(js('dv.paragraph("" + { toString: () => "called" })').html).not.toContain("called");
		expect(js("dv.paragraph(Number({ valueOf: () => 7 }))").html).toBe(
			'<p class="dataviewjs-paragraph">NaN</p>',
		);
		expect(js('dv.paragraph(String({ toString: () => "called" }))').html).not.toContain("called");
	});

	test("an object literal cannot pollute the shared prototype, nor a script mutate page values", () => {
		expect(
			js('const o = { "__proto__": { "polluted": 1 } }\nconst p = {}\ndv.paragraph(p.polluted)')
				.html,
		).toBe('<p class="dataviewjs-paragraph">-</p>');
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect(js('dv.current().file.name = "x"').error).toContain("Unsupported DataviewJS syntax");
		expect(js("dv.current().file.tasks.push(1)").error).toContain(
			"Unsupported DataviewJS collection method: push",
		);
	});
});

describe("denial of service", () => {
	test("a script that never finishes is stopped by the step budget", () => {
		const exponential = js("const f = (n) => n > 0 ? f(n - 1) + f(n - 1) : 1\ndv.paragraph(f(40))");
		expect(exponential.error).toBe(
			"DataviewJS: the script ran more than 50000000 steps and was stopped; Obsidian has no such limit, but a site build must finish.",
		);
		// Lists of the same long list are paid for as the square they render into.
		expect(
			js(
				'const x = "abc".repeat(1000).split("")\nconst y = x.map(() => x)\nconst z = y.map(() => y)',
			).error,
		).toContain("ran more than 50000000 steps");
		// `distinct` compares every value with every kept one.
		expect(
			js(
				'const x = "x".repeat(20000).split("").map((c, i) => i)\ndv.paragraph(x.distinct().length)',
			).error,
		).toContain("ran more than 50000000 steps");
		// So does rendering a huge value again and again.
		expect(
			js(
				'const s = "x".repeat(9000000)\nfor (const i of "x".repeat(100).split("")) dv.paragraph(s)',
			).error,
		).toContain("ran more than 50000000 steps");
	});

	test("huge strings and lists are refused with a clear error", () => {
		expect(js('dv.paragraph("x".repeat(1e9))').error).toContain(
			"A text value would be 1000000000 characters long, over the limit of 10000000",
		);
		expect(js('dv.paragraph("x".padStart(1e9))').error).toContain("A text value would be");
		expect(js('dv.paragraph("x".padEnd(1e9, "ab"))').error).toContain("A text value would be");
		expect(js('const s = "x".repeat(6000000)\ndv.paragraph(s + s)').error).toContain(
			"A text value would be 12000000 characters long",
		);
		// biome-ignore lint/suspicious/noTemplateCurlyInString: DataviewJS source holding a template literal
		expect(js('const s = "x".repeat(6000000)\ndv.paragraph(`${s}${s}`)').error).toContain(
			"A text value would be",
		);
		expect(js('const s = "x".repeat(4000000)\ndv.paragraph([s, s, s].join())').error).toContain(
			"A text value would be",
		);
		expect(
			js('dv.paragraph("a".repeat(100000).replaceAll("a", "b".repeat(1000)))').error,
		).toContain("A text value would be");
		expect(js('dv.paragraph("x".repeat(2000000).split("").length)').error).toContain(
			"A list would have 2000000 items, over the limit of 1000000",
		);
		const square = 'const x = "x".repeat(1001).split("")\nconst y = x.map(() => x)\n';
		expect(js(`${square}dv.paragraph(y.flat().length)`).error).toContain("A list would have");
		expect(js(`${square}dv.paragraph(x.flatMap(() => x).length)`).error).toContain(
			"A list would have",
		);
		expect(js(`${square}dv.paragraph(y.missing.length)`).error).toContain("A list would have");
		expect(js(`${square}dv.paragraph(y.concat(x, x).length)`).html).toBe(
			'<p class="dataviewjs-paragraph">3003</p>',
		);
	});

	test("regular expressions built through dv.func are checked before they run", () => {
		expect(js('dv.paragraph(dv.func.regextest("(a+)+$", "aaaa"))').error).toContain(
			"uses nested quantifiers (possible catastrophic backtracking detected); Obsidian would run it",
		);
		expect(js('dv.paragraph(dv.func.regextest("a+$", "aaaa"))').html).toBe(
			'<p class="dataviewjs-paragraph">true</p>',
		);
	});

	test("a stack overflow is reported, not thrown", () => {
		const deep = `dv.paragraph(${"(".repeat(20000)}1${")".repeat(20000)})`;
		expect(js(deep).error).toBe(
			"DataviewJS: The expression is nested too deeply or recurses too far to evaluate (the interpreter ran out of stack).",
		);
		expect(
			renderDataviewJsInline(`${"[".repeat(20000)}${"]".repeat(20000)}`, home, index).error,
		).toContain("nested too deeply");
	});
});

describe("inline DataviewJS", () => {
	test("renders the value of the expression", () => {
		expect(renderDataviewJsInline("dv.current().file.name", home, index).html).toBe(
			'<span class="dataview-inline">Home</span>',
		);
		expect(renderDataviewJsInline("dv.pages('\"N\"').length", home, index).html).toBe(
			'<span class="dataview-inline">3</span>',
		);
		expect(renderDataviewJsInline("process.exit()", home, index).error).toContain("forbidden");
	});
});
