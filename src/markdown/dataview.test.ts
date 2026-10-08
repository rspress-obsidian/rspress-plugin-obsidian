import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildContentIndex } from "./content-index";
import { extractDataviewMetadata, renderDataviewInline, renderDataviewQuery } from "./dataview";
import { DataviewDuration, DataviewLink } from "./dataview-values";
import type { ContentIndex, ContentPage } from "./types";

interface TestVault {
	root: string;
	index: ContentIndex;
	page: (relativePath: string) => ContentPage;
}

/** Write `files` into a throwaway vault and index it. */
async function makeVault(files: Record<string, string>): Promise<TestVault> {
	const root = mkdtempSync(path.join(os.tmpdir(), "obsidian-dataview-"));
	for (const [name, content] of Object.entries(files)) {
		const target = path.join(root, name);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, content);
		// A fixed modification time, so `file.mtime` renders the same everywhere.
		const mtime = new Date(2026, 9, 7, 8, 0, 0);
		utimesSync(target, mtime, mtime);
	}
	const index = await buildContentIndex(root);
	return {
		root,
		index,
		page: (relativePath) => {
			const found = index.pages.find((candidate) => candidate.relativePath === relativePath);
			if (!found) throw new Error(`${relativePath} is not in the test vault`);
			return found;
		},
	};
}

/** Cell markup of every table row, so assertions read as the rendered table. */
function tableRows(html: string | undefined): string[][] {
	return [...(html ?? "").matchAll(/<tr>(.*?)<\/tr>/g)].map((row) =>
		[...(row[1] ?? "").matchAll(/<t[hd]>(.*?)<\/t[hd]>/g)].map((cell) => cell[1] ?? ""),
	);
}

/** Text of each top-level `<li>` of a LIST result. */
function listItems(html: string | undefined): string[] {
	const body = /^<ul class="dataview dataview-list">(.*)<\/ul>$/.exec(html ?? "")?.[1] ?? "";
	const items: string[] = [];
	let depth = 0;
	let start = 0;
	for (const match of body.matchAll(/<(\/?)li\b[^>]*>/g)) {
		if (match[1]) {
			depth -= 1;
			if (depth === 0) items.push(body.slice(start, match.index));
		} else {
			if (depth === 0) start = match.index + match[0].length;
			depth += 1;
		}
	}
	return items;
}

const FILES: Record<string, string> = {
	"Home.md": [
		"---",
		"title: Home Title",
		'up: "[[Folder/A]]"',
		"---",
		"# Home",
		"",
		"Links to [[Folder/A]].",
		"",
		"- author:: Alice",
		"- year:: 2020",
		"",
		"nums:: 1, 2, 3",
		"when:: 2 hours",
		"owner:: [[Folder/B]]",
		"See [related:: [[Folder/B]]] here. Inline [mood:: happy] and (hidden:: yes) text.",
	].join("\n"),
	"Folder/A.md": ["---", "status: open", "tags: [proj/sub]", "rank: 3", "---", "Links [[B]]."].join(
		"\n",
	),
	"Folder/B.md": ["---", "status: done", "rank: 1", "---", "B body"].join("\n"),
	"Folder/C.md": ["---", "status: open", "rank: 2", "---", "C body, links [[Home]]."].join("\n"),
	"Other/D.md": "status:: OPEN\n",
	"daily/2026-01-05.md": "A day.\n",
	"2026-08-20 Meeting.md": "Minutes.\n",
	"Dated.md": ["---", "date: 2025-12-31", "---", "Has a date field."].join("\n"),
	"Tasks.md": [
		"## Chores",
		"",
		"- [ ] parent task",
		"    - [x] child done",
		"    - [ ] child open 📅 2026-01-05 ⏳ 2026-01-02 🛫 2026-01-01 ➕ 2025-12-30 ⏫ 🔁 every week",
		"- [-] Cancelled task",
		"- [/] In progress [due:: 2026-02-01]",
		"- [x] Shipped ✅ 2026-01-03",
		"- [ ] **Bold** task linking [[Folder/A]]",
	].join("\n"),
};

let vault: TestVault;
let home: ContentPage;

beforeAll(async () => {
	vault = await makeVault(FILES);
	home = vault.page("Home.md");
});

afterAll(() => {
	rmSync(vault.root, { recursive: true, force: true });
});

const run = (query: string, page: ContentPage = home) =>
	renderDataviewQuery(query, page, vault.index, undefined, { now: new Date(2026, 9, 8, 12, 0) });

describe("query parsing: one token stream", () => {
	test("one-line and multi-line queries parse identically", () => {
		const pairs = [
			['LIST FROM "Folder"', 'LIST\nFROM "Folder"'],
			['LIST WHERE status = "open"', 'LIST\nWHERE status = "open"'],
			[
				'TABLE file.name, length(file.outlinks) AS outs FROM "Folder" SORT file.name',
				'TABLE file.name,\n  length(file.outlinks) AS outs\nFROM "Folder"\nSORT file.name',
			],
		];
		for (const [oneLine, multiLine] of pairs) {
			const left = run(oneLine ?? "");
			expect(left.error).toBeUndefined();
			expect(left.html).toBe(run(multiLine ?? "").html);
		}
		expect(listItems(run('LIST FROM "Folder"').html)).toEqual([
			'<a href="/Folder/A">A</a>',
			'<a href="/Folder/B">B</a>',
			'<a href="/Folder/C">C</a>',
		]);
	});

	test("TABLE fields stop at FROM, so the source is applied", () => {
		const rows = tableRows(run('TABLE status FROM "Folder" SORT file.name').html);
		expect(rows[0]).toEqual(["File", "status"]);
		expect(rows.slice(1).map((row) => row[1])).toEqual(["open", "done", "open"]);
	});

	test("TASK honours a FROM written on the same line", () => {
		const html = run('TASK FROM "Folder"').html ?? "";
		expect(html).not.toContain("parent task");
	});

	test("an expression continues on the next line", () => {
		const result = run('LIST\nWHERE status = "open"\n  AND file.name != "A"');
		expect(result.error).toBeUndefined();
		expect(listItems(result.html)).toEqual(['<a href="/Folder/C">C</a>']);
	});

	test("leftover text and unknown characters are errors, not partial results", () => {
		expect(run('LIST\nWHERE status = "open" garbage tokens here').error).toContain(
			"Unsupported Dataview command: garbage tokens here (line 2",
		);
		expect(run('LIST WHERE status = "open" @').error).toContain("Unsupported Dataview command: @");
		expect(run('TABLE status FROM "Folder" garbage').error).toContain(
			"Unsupported Dataview source",
		);
		expect(run("TABLE (status").error).toContain("Expected ')'");
	});

	test("// comments are whitespace", () => {
		const result = run('LIST // every folder page\nFROM "Folder" // here\nWHERE rank > 1');
		expect(listItems(result.html)).toEqual([
			'<a href="/Folder/A">A</a>',
			'<a href="/Folder/C">C</a>',
		]);
	});
});

describe("data commands run in the order written", () => {
	test("SORT, LIMIT, SORT", () => {
		const result = run('LIST FROM "Folder"\nSORT file.name DESC\nLIMIT 2\nSORT file.name ASC');
		expect(listItems(result.html)).toEqual([
			'<a href="/Folder/B">B</a>',
			'<a href="/Folder/C">C</a>',
		]);
	});

	test("WHERE after GROUP BY filters groups", () => {
		const rows = tableRows(
			run('TABLE length(rows) AS n FROM "Folder"\nGROUP BY status\nWHERE length(rows) > 1').html,
		);
		expect(rows).toEqual([
			["status", "n"],
			["open", "2"],
		]);
	});

	test("LIMIT takes an expression evaluated once and must be a number", () => {
		expect(listItems(run('LIST FROM "Folder" SORT file.name LIMIT 1 + 1').html)).toHaveLength(2);
		expect(run('LIST FROM "Folder" LIMIT "two"').error).toContain("LIMIT needs a number");
	});

	test("FLATTEN gives one row per element, named after the expression or its alias", () => {
		const rows = tableRows(run('TABLE WITHOUT ID n FROM "Home" FLATTEN nums AS n').html);
		expect(rows.slice(1)).toEqual([["1"], ["2"], ["3"]]);
		const plain = tableRows(run('TABLE WITHOUT ID nums FROM "Home" FLATTEN nums').html);
		expect(plain.slice(1)).toEqual([["1"], ["2"], ["3"]]);
	});
});

describe("GROUP BY output", () => {
	test("the ID column holds the group key under the group's name", () => {
		const rows = tableRows(run('TABLE rows.file.link FROM "Folder" GROUP BY status').html);
		expect(rows[0]).toEqual(["status", "rows.file.link"]);
		expect(rows[1]?.[0]).toBe("done");
		expect(rows[2]?.[0]).toBe("open");
		expect(rows[2]?.[1]).toContain('<a href="/Folder/A">A</a>');
		expect(rows[2]?.[1]).toContain('<a href="/Folder/C">C</a>');
		expect(
			tableRows(run('TABLE length(rows) FROM "Folder" GROUP BY status AS State').html)[0],
		).toEqual(["State", "length(rows)"]);
	});

	test("LIST shows the keys, and key: rows when given rows", () => {
		expect(listItems(run('LIST FROM "Folder" GROUP BY status').html)).toEqual(["done", "open"]);
		const nested = listItems(run('LIST rows.file.link FROM "Folder" GROUP BY status').html);
		expect(nested[0]).toStartWith("done: <ul");
		expect(nested[1]).toContain('<a href="/Folder/C">C</a>');
	});

	test("rows hold the grouped pages and key the group value", () => {
		const rows = tableRows(
			run('TABLE WITHOUT ID key, sum(rows.rank) FROM "Folder" GROUP BY status SORT key DESC').html,
		);
		expect(rows.slice(1)).toEqual([
			["open", "5"],
			["done", "1"],
		]);
	});
});

describe("LIST <expr>", () => {
	test("renders link: value, and only the value WITHOUT ID", () => {
		expect(listItems(run('LIST status FROM "Folder" SORT file.name').html)[0]).toBe(
			'<a href="/Folder/A">A</a>: open',
		);
		expect(listItems(run('LIST WITHOUT ID status FROM "Folder" SORT file.name').html)[0]).toBe(
			"open",
		);
	});
});

describe("this and the current page", () => {
	test("inline queries read the current page through this", () => {
		expect(renderDataviewInline("this.file.name", home, vault.index).html).toBe(
			'<span class="dataview-inline">Home</span>',
		);
		// As in Dataview, an inline query sees only `this`: a bare field is null.
		expect(renderDataviewInline("file.name", home, vault.index).html).toBe(
			'<span class="dataview-inline">-</span>',
		);
	});

	test("WHERE compares against this", () => {
		const html = run("LIST WHERE contains(file.inlinks, this.file.link)").html;
		expect(listItems(html)).toEqual(['<a href="/Folder/A">A</a>', '<a href="/Folder/B">B</a>']);
	});

	test("FROM [[]] and [[#]] select the pages linking to the current page", () => {
		expect(listItems(run("LIST FROM [[]]").html)).toEqual(['<a href="/Folder/C">C</a>']);
		expect(run("LIST FROM [[#]]").html).toBe(run("LIST FROM [[]]").html);
	});
});

describe("links", () => {
	test("link-valued inline and frontmatter fields render as links", () => {
		const rows = tableRows(run('TABLE WITHOUT ID owner, related, up FROM "Home"').html);
		expect(rows[1]).toEqual([
			'<a href="/Folder/B">B</a>',
			'<a href="/Folder/B">B</a>',
			'<a href="/Folder/A">A</a>',
		]);
	});

	test("a link literal resolves like a wikilink and equals the page's file.link", () => {
		expect(tableRows(run('TABLE WITHOUT ID [[B]] FROM "Home"').html)[1]).toEqual([
			'<a href="/Folder/B">B</a>',
		]);
		expect(listItems(run("LIST WHERE file.link = [[Folder/B]]").html)).toEqual([
			'<a href="/Folder/B">B</a>',
		]);
		expect(listItems(run("LIST WHERE owner = [[B]]").html)).toEqual(['<a href="/Home">Home</a>']);
	});

	test("a field read through a link reaches the linked page", () => {
		expect(tableRows(run('TABLE WITHOUT ID owner.status FROM "Home"').html)[1]).toEqual(["done"]);
	});

	test("file.link is labelled with the file name, not the title", () => {
		expect(tableRows(run('TABLE WITHOUT ID file.link FROM "Home"').html)[1]).toEqual([
			'<a href="/Home">Home</a>',
		]);
	});

	test("an unresolved link is text, and an unsafe external link is not a link", () => {
		const cells = tableRows(
			run(
				'TABLE WITHOUT ID [[Nowhere]], elink("javascript:alert(1)", "x"), elink("https://example.com", "ok") FROM "Home"',
			).html,
		)[1];
		expect(cells?.[0]).toBe('<span class="internal-link is-unresolved">Nowhere</span>');
		expect(cells?.[1]).toBe("x");
		expect(cells?.[2]).toContain('href="https://example.com"');
	});
});

describe("dates and durations", () => {
	test("file.mtime renders with its time, file.mday without", () => {
		const cells = tableRows(run('TABLE WITHOUT ID file.mtime, file.mday FROM "Home"').html)[1];
		expect(cells).toEqual(["8:00 AM - October 07, 2026", "October 07, 2026"]);
	});

	test("dur() and date arithmetic", () => {
		const cells = tableRows(
			run(
				'TABLE WITHOUT ID date(today) - dur(1 day), date(2026-01-31) + dur(1 month), dur(1 day) + dur("2 hours"), date(2026-01-05) - date(2026-01-01), (date(2026-01-05) - date(2026-01-01)).days FROM "Home"',
			).html,
		)[1];
		expect(cells).toEqual([
			"October 07, 2026",
			"February 28, 2026",
			"1 day, 2 hours",
			"4 days",
			"4",
		]);
	});

	test("date shorthands are relative to the build clock", () => {
		const cells = tableRows(
			run(
				'TABLE WITHOUT ID date(yesterday), date(tomorrow), date(sow), date(eom), date(soy), date(now) FROM "Home"',
			).html,
		)[1];
		expect(cells).toEqual([
			"October 07, 2026",
			"October 09, 2026",
			"October 05, 2026",
			"11:59 PM - October 31, 2026",
			"January 01, 2026",
			"12:00 PM - October 08, 2026",
		]);
	});

	test("date properties", () => {
		const cells = tableRows(
			run(
				'TABLE WITHOUT ID date(2026-03-04T05:06:07).year, date(2026-03-04T05:06:07).month, date(2026-03-04T05:06:07).day, date(2026-03-04T05:06:07).hour, date(2026-03-04T05:06:07).minute, date(2026-03-04T05:06:07).second, date(2026-03-04).weekday, file.mtime.year FROM "Home"',
			).html,
		)[1];
		expect(cells).toEqual(["2026", "3", "4", "5", "6", "7", "3", "2026"]);
	});

	test("dateformat honours quoted literals", () => {
		const cells = tableRows(
			run(`TABLE WITHOUT ID dateformat(file.mtime, "MMMM d, yyyy 'at' HH:mm") FROM "Home"`).html,
		)[1];
		expect(cells).toEqual(["October 7, 2026 at 08:00"]);
	});
});

describe("expression semantics", () => {
	const cells = (expressions: string[]) =>
		tableRows(run(`TABLE WITHOUT ID ${expressions.join(", ")} FROM "Home"`).html)[1];

	test("string equality is case-sensitive", () => {
		expect(listItems(run('LIST WHERE status = "open"').html)).toEqual([
			'<a href="/Folder/A">A</a>',
			'<a href="/Folder/C">C</a>',
		]);
	});

	test("contains, icontains, econtains, containsword", () => {
		expect(
			cells([
				'contains(["Smith, J", "Doe"], "Smith")',
				'econtains(["Smith, J", "Doe"], "Smith")',
				'contains("Hello", "hello")',
				'icontains("Hello", "hello")',
				'containsword("a cat sat", "Cat")',
				'contains(file.tags, "#proj")',
			]),
		).toEqual(["true", "false", "false", "true", "true", "false"]);
		expect(listItems(run('LIST WHERE contains(file.tags, "#proj")').html)).toEqual([
			'<a href="/Folder/A">A</a>',
		]);
	});

	test("replace is literal; regexreplace and regextest use patterns", () => {
		expect(
			cells([
				'replace("a.b", ".", "-")',
				'regexreplace("a.b", "[.]", "-")',
				'regextest("b+", "abbc")',
				'regexmatch("b+", "abbc")',
			]),
		).toEqual(["a-b", "a-b", "true", "false"]);
	});

	test("typeof names Dataview's types", () => {
		expect(
			cells([
				"typeof(file.link)",
				"typeof(file.mtime)",
				"typeof(when)",
				"typeof(nums)",
				"typeof(file)",
				"typeof(missing)",
				'typeof("x")',
			]),
		).toEqual(["link", "date", "duration", "array", "object", "null", "string"]);
	});

	test("arithmetic with a missing value is null, rendered as -", () => {
		expect(
			cells(["missing + 1", "missing", "1 + 2 * 3", '"n" + 1', "7 % 4", 'length(object("a", 1))']),
		).toEqual(["-", "-", "7", "n1", "3", "1"]);
	});

	test("file.tags carries parent tags and file.etags the tags as written, both with #", () => {
		const row = tableRows(run('TABLE WITHOUT ID file.tags, file.etags FROM "Folder/A"').html)[1];
		expect(row?.[0]).toContain("#proj/sub");
		expect(row?.[0]).toContain(">#proj<");
		expect(row?.[1]).toBe(
			'<ul class="dataview dataview-ul dataview-result-list-ul"><li class="dataview-result-list-li">#proj/sub</li></ul>',
		);
	});

	test("file.day comes from the daily-notes format, any dated file name, or a date field", () => {
		const rows = tableRows(
			run("TABLE WITHOUT ID file.name, file.day WHERE file.day SORT file.day", home).html,
		);
		expect(rows.slice(1)).toEqual([
			["Dated", "December 31, 2025"],
			["2026-01-05", "January 05, 2026"],
			["2026-08-20 Meeting", "August 20, 2026"],
		]);
	});

	test("truncate appends an ellipsis", () => {
		expect(cells(['truncate("Hello world", 8)', 'truncate("Hi", 8)'])).toEqual(["Hello...", "Hi"]);
	});

	test("the Dataview function library", () => {
		expect(
			cells([
				'link("Folder/A", "Alpha")',
				"list(1, 2)[1]",
				'object("a", 1).a',
				'number("v12.5kg")',
				"string(3)",
				"sort([3, 1, 2])",
				"reverse([1, 2])",
				"filter([1, 2, 3], (x) => x > 1)",
				"map([1, 2], (x) => x * 10)",
				'dur("1 week").days',
				"localtime(date(2026-01-02)) = date(2026-01-02)",
				"product([2, 3, 4])",
				"minby([3, 1, 2], (x) => x)",
				"maxby([3, 1, 2], (x) => x)",
				'extract(object("a", 1, "b", 2), "a")',
				"meta([[Folder/A#Head|A]]).subpath",
				"embed([[Folder/A]])",
				"default(missing, 5)",
				"choice(true, 1, 2)",
				'substring("hello", 1, 3)',
				"unique([1, 1, 2])",
				'join(["a", "b"], "-")',
				'split("a-b-c", "-")[2]',
				"round(2.567, 2)",
				"nonnull([1, null, 2])",
				"firstvalue([null, 4])",
				"any(false, true)",
				"all([true, false])",
				"none([false])",
				"flat([[1], [2]])",
				"slice([1, 2, 3], 1)",
				'reduce([1, 2, 3], "+")',
				'padleft("7", 3, "0")',
				'currencyformat(5, "EUR")',
				'durationformat(dur(90 minutes), "h:mm")',
				'display("**bold** [[x|y]]")',
				'hash("seed", 1) = hash("seed", 1)',
			]),
		).toEqual([
			'<a href="/Folder/A">Alpha</a>',
			"2",
			"1",
			"12.5",
			"3",
			'<ul class="dataview dataview-ul dataview-result-list-ul"><li class="dataview-result-list-li">1</li><li class="dataview-result-list-li">2</li><li class="dataview-result-list-li">3</li></ul>',
			'<ul class="dataview dataview-ul dataview-result-list-ul"><li class="dataview-result-list-li">2</li><li class="dataview-result-list-li">1</li></ul>',
			'<ul class="dataview dataview-ul dataview-result-list-ul"><li class="dataview-result-list-li">2</li><li class="dataview-result-list-li">3</li></ul>',
			'<ul class="dataview dataview-ul dataview-result-list-ul"><li class="dataview-result-list-li">10</li><li class="dataview-result-list-li">20</li></ul>',
			"7",
			"true",
			"24",
			"1",
			"3",
			'<ul class="dataview dataview-ul dataview-result-object-ul"><li class="dataview dataview-li dataview-result-object-li">a: 1</li></ul>',
			"Head",
			'<a href="/Folder/A">A</a>',
			"5",
			"1",
			"el",
			'<ul class="dataview dataview-ul dataview-result-list-ul"><li class="dataview-result-list-li">1</li><li class="dataview-result-list-li">2</li></ul>',
			"a-b",
			"c",
			"2.57",
			'<ul class="dataview dataview-ul dataview-result-list-ul"><li class="dataview-result-list-li">1</li><li class="dataview-result-list-li">2</li></ul>',
			"4",
			"true",
			"false",
			"true",
			'<ul class="dataview dataview-ul dataview-result-list-ul"><li class="dataview-result-list-li">1</li><li class="dataview-result-list-li">2</li></ul>',
			'<ul class="dataview dataview-ul dataview-result-list-ul"><li class="dataview-result-list-li">2</li><li class="dataview-result-list-li">3</li></ul>',
			"6",
			"007",
			"€5.00",
			"1:30",
			"bold y",
			"true",
		]);
	});

	test("objects render as key: value lists, never JSON", () => {
		const cell = tableRows(
			run('TABLE WITHOUT ID object("a", 1, "b", "x") FROM "Home"').html,
		)[1]?.[0];
		expect(cell).not.toContain("{");
		expect(cell).toContain("a: 1");
		expect(renderDataviewInline('object("a", 1)', home, vault.index).html).toBe(
			'<span class="dataview-inline"><span class="dataview dataview-result-object-span">a: 1</span></span>',
		);
	});

	test("strings render as inline Markdown", () => {
		const cell = tableRows(
			run('TABLE WITHOUT ID "**b** and [[Folder/A]] <script>" FROM "Home"').html,
		)[1]?.[0];
		expect(cell).toBe('<strong>b</strong> and <a href="/Folder/A">A</a> &lt;script&gt;');
	});

	test("a function name that is not Dataview's is an error, prototype names included", () => {
		expect(run("TABLE bogus(file.name)").error).toContain("Unsupported Dataview function: bogus");
		expect(run("TABLE constructor(1)").error).toContain(
			"Unsupported Dataview function: constructor",
		);
	});
});

describe("TASK", () => {
	const tasks = () => run('TASK FROM "Tasks"').html ?? "";

	test("nests subtasks under their parent", () => {
		const html = tasks();
		expect(html).toMatch(/parent task<ul class="contains-task-list"><li[^>]*data-task="x"/);
		expect(html.match(/child done/g)).toHaveLength(1);
	});

	test("keeps a parent's children even when they do not match", () => {
		const html = run('TASK FROM "Tasks" WHERE !completed').html ?? "";
		expect(html).toContain("child done");
		expect(html).not.toContain("Shipped");
	});

	test("accepts any one-character status; only x is completed", () => {
		const html = tasks();
		expect(html).toContain('data-task="-"');
		expect(html).toContain('data-task="/"');
		const completed = tableRows(
			run(
				'TABLE WITHOUT ID status, completed, checked FROM "Tasks" FLATTEN file.tasks AS t WHERE t.status = "-"',
			).html,
		);
		expect(completed).toHaveLength(2);
		const statuses = tableRows(
			run('TABLE WITHOUT ID t.status, t.completed, t.checked FROM "Tasks" FLATTEN file.tasks AS t')
				.html,
		).slice(1);
		expect(statuses).toContainEqual(["-", "false", "true"]);
		expect(statuses).toContainEqual(["x", "true", "true"]);
	});

	test("reads emoji shorthands as fields", () => {
		const row = tableRows(
			run(
				'TABLE WITHOUT ID t.due, t.scheduled, t.start, t.created, t.priority, t.recurrence FROM "Tasks" FLATTEN file.tasks AS t WHERE t.due AND t.scheduled',
			).html,
		)[1];
		expect(row).toEqual([
			"January 05, 2026",
			"January 02, 2026",
			"January 01, 2026",
			"December 30, 2025",
			"high",
			"every week",
		]);
		const done = tableRows(
			run('TABLE WITHOUT ID t.completion FROM "Tasks" FLATTEN file.tasks AS t WHERE t.completion')
				.html,
		)[1];
		expect(done).toEqual(["January 03, 2026"]);
	});

	test("filters on a bracketed field, as the guide shows", () => {
		const html = run('TASK FROM "Tasks" WHERE due').html ?? "";
		expect(html).toContain("In progress");
		expect(html).toContain('<span class="dataview inline-field-key">due</span>');
	});

	test("renders task text as inline Markdown", () => {
		expect(tasks()).toContain('<strong>Bold</strong> task linking <a href="/Folder/A">A</a>');
	});

	test("GROUP BY renders a heading per group", () => {
		const html = run('TASK FROM "Tasks" WHERE completed GROUP BY status').html ?? "";
		expect(html).toStartWith('<div class="dataview dataview-container"><h4>x</h4>');
	});
});

describe("CALENDAR", () => {
	test("files pages under the date field and needs one", () => {
		const html = run('CALENDAR file.day FROM "daily"').html ?? "";
		expect(html).toContain("<caption>January 2026</caption>");
		expect(html).toMatch(
			/<span class="dataview-calendar-date">5<\/span><ul><li><a href="\/daily\/2026-01-05">/,
		);
		expect(run('CALENDAR FROM "daily"').error).toContain("needs a date field");
		expect(run('CALENDAR file.name FROM "daily"').error).toContain("must be a date");
	});
});

describe("FROM sources", () => {
	test("tags include subtags; folders match case-insensitively; negation and or", () => {
		expect(listItems(run("LIST FROM #proj").html)).toEqual(['<a href="/Folder/A">A</a>']);
		expect(listItems(run('LIST FROM "folder" AND -"Folder/A"').html)).toEqual([
			'<a href="/Folder/B">B</a>',
			'<a href="/Folder/C">C</a>',
		]);
		expect(listItems(run('LIST FROM "Other" or #proj').html)).toHaveLength(2);
	});

	test("[[note]] selects pages linking to it, outgoing([[note]]) the pages it links to", () => {
		expect(listItems(run("LIST FROM [[Folder/B]]").html)).toEqual([
			'<a href="/Folder/A">A</a>',
			'<a href="/Home">Home</a>',
		]);
		expect(listItems(run("LIST FROM outgoing([[Folder/A]])").html)).toEqual([
			'<a href="/Folder/B">B</a>',
		]);
	});

	test("malformed sources are errors", () => {
		for (const query of [
			"LIST FROM bogus",
			"LIST FROM #",
			"LIST FROM ([[Home]]",
			"LIST FROM inlinks(bogus)",
			"LIST FROM [[ ]]",
			"LIST FROM [[Nowhere]]",
			'LIST FROM csv("data.csv")',
		]) {
			expect(run(query).error).toContain("Unsupported Dataview source");
		}
	});
});

describe("errors", () => {
	test("each malformed query names its problem", () => {
		expect(run("").error).toBe("Dataview query is empty.");
		expect(run("MOON file.name").error).toBe("Unsupported Dataview query type: MOON file.name.");
		expect(run('LIST FROM "Folder" FROM "Other"').error).toContain("only one FROM clause");
		expect(run("LIST GROUP status").error).toContain("Expected BY after GROUP");
	});

	test("vault-authored regexes are bounded", () => {
		expect(run('TABLE regexmatch("(a+)+$", file.name)').error).toContain("nested quantifiers");
		expect(run(`TABLE regexmatch("${"a".repeat(1001)}", file.name)`).error).toContain("too long");
		expect(run(`TABLE regextest("b", "${"b".repeat(10_001)}")`).error).toContain(
			"subject is too long",
		);
		expect(run('TABLE regexmatch("[", file.name)').error).toContain("Invalid Dataview pattern");
	});
});

describe("extractDataviewMetadata", () => {
	test("fields on plain list items are page fields; task fields stay on the task", () => {
		const { fields, tasks } = extractDataviewMetadata(
			"- author:: Alice\n- [ ] Ship [due:: 2026-09-01]\n",
			{},
			"n.md",
		);
		expect(fields.author).toBe("Alice");
		expect(fields.due).toBeUndefined();
		expect(tasks[0]?.fields.due).toEqual(new Date(2026, 8, 1));
	});

	test("bracket fields match by depth and do not create junk keys", () => {
		const { fields } = extractDataviewMetadata(
			"See [related:: [[B]]] here. Inline [mood:: happy] and (hidden:: yes) text.\n",
			{},
			"n.md",
		);
		expect(Object.keys(fields).sort()).toEqual(["hidden", "mood", "related"]);
		expect(fields.related).toEqual(new DataviewLink("B"));
	});

	test("a full-line field is read only when no bracketed field is on the line", () => {
		expect(extractDataviewMetadata("**Status**:: open\n", {}, "n.md").fields.Status).toBe("open");
		expect(extractDataviewMetadata("**Status**:: open\n", {}, "n.md").fields.status).toBe("open");
		const { fields } = extractDataviewMetadata("a:: 1 and [b:: 2]\n", {}, "n.md");
		expect(fields).toEqual({ b: 2 });
	});

	test("values parse as Dataview does: lists, durations, links, dates, quoted text", () => {
		const { fields } = extractDataviewMetadata(
			[
				"nums:: 1, 2, 3",
				"names:: Alice, Bob",
				"spent:: 2 hours",
				"owner:: [[Alice]]",
				"day:: 2026-01-05",
				'quote:: "a, b"',
				"flag:: true",
				"empty::",
			].join("\n"),
			{ up: "[[Home]]", since: "2026-01-02", plain: "Text" },
			"n.md",
		);
		expect(fields.nums).toEqual([1, 2, 3]);
		expect(fields.names).toBe("Alice, Bob");
		expect(fields.spent).toEqual(new DataviewDuration({ hours: 2 }));
		expect(fields.owner).toEqual(new DataviewLink("Alice"));
		expect(fields.day).toEqual(new Date(2026, 0, 5));
		expect(fields.quote).toBe("a, b");
		expect(fields.flag).toBe(true);
		expect(fields.empty).toBeNull();
		expect(fields.up).toEqual(new DataviewLink("Home"));
		expect(fields.since).toEqual(new Date(2026, 0, 2));
		expect(fields.plain).toBe("Text");
	});

	test("a repeated key collects its values; keys are also readable canonically", () => {
		const { fields } = extractDataviewMetadata(
			"Due Date:: 2026-01-01\nDue Date:: 2026-01-02\n",
			{},
			"n.md",
		);
		expect(fields["Due Date"]).toEqual([new Date(2026, 0, 1), new Date(2026, 0, 2)]);
		expect(fields["due-date"]).toEqual(fields["Due Date"]);
	});

	test("YAML timestamps keep their wall-clock fields as local time", () => {
		const { fields } = extractDataviewMetadata(
			"",
			{ created: new Date(Date.UTC(2026, 0, 5)), at: new Date(Date.UTC(2026, 0, 5, 10, 30)) },
			"n.md",
		);
		expect(fields.created).toEqual(new Date(2026, 0, 5));
		expect(fields.at).toEqual(new Date(2026, 0, 5, 10, 30));
	});

	test("list items keep nesting, status, section and line numbers (zero-based)", () => {
		const { lists, tasks } = extractDataviewMetadata(FILES["Tasks.md"] ?? "", {}, "Tasks.md");
		expect(lists.map((item) => [item.line, item.parent, item.status])).toEqual([
			[2, undefined, " "],
			[3, 2, "x"],
			[4, 2, " "],
			[5, undefined, "-"],
			[6, undefined, "/"],
			[7, undefined, "x"],
			[8, undefined, " "],
		]);
		expect(lists[0]?.children).toEqual([3, 4]);
		expect(lists[0]?.section).toBe("Chores");
		expect(tasks.find((task) => task.line === 2)?.fullyCompleted).toBe(false);
		expect(tasks.find((task) => task.line === 5)?.completed).toBe(false);
	});

	test("ignores fenced code; a thematic break opening the note is content", () => {
		const fenced = extractDataviewMetadata(
			"```js\nfenced:: ignored\n```\nreal:: yes\n",
			{},
			"n.md",
		);
		expect(fenced.fields).toEqual({ real: "yes" });
		const opened = extractDataviewMetadata(
			"---\n# Title\n\n- [ ] a task\n\nkey:: value\n",
			{},
			"n.md",
		);
		expect(opened.tasks).toHaveLength(1);
		expect(opened.fields.key).toBe("value");
	});

	test("copies a YAML alias bomb once per distinct value, sharing the copies", () => {
		let bomb: unknown[] = ["x", "x", "x", "x", "x", "x", "x", "x", "x"];
		for (let level = 1; level < 12; level += 1) bomb = Array.from({ length: 9 }, () => bomb);
		const { fields } = extractDataviewMetadata("", { bomb }, "bomb.md");
		const copy = fields.bomb;
		if (!Array.isArray(copy) || !Array.isArray(bomb))
			throw new Error("bomb did not copy as a list");
		// Every reference to one anchor is the same copy: the walk visited each
		// distinct array once (12 copies), not each of its 9^12 paths.
		expect(copy[0]).toBe(copy[8]);
		expect(copy[0]).not.toBe(bomb[0]);
		let level: unknown = copy;
		for (let hops = 1; hops < 12; hops += 1) level = Array.isArray(level) ? level[0] : undefined;
		expect(level).toEqual(["x", "x", "x", "x", "x", "x", "x", "x", "x"]);
	});

	test("degrades a cyclic anchor to null", () => {
		const loop: unknown[] = ["a"];
		loop.push(loop);
		expect(extractDataviewMetadata("", { loop }, "loop.md").fields.loop).toEqual(["a", null]);
	});
});

test("further queries over the same index reuse page values instead of rebuilding them", () => {
	const first = vault.index.pages[0];
	if (!first) throw new Error("test vault has no pages");
	let reads = 0;
	const ctime = first.fileCtimeMs;
	Object.defineProperty(first, "fileCtimeMs", {
		get: () => {
			reads += 1;
			return ctime;
		},
		configurable: true,
	});
	try {
		run("LIST", first);
		const afterFirstQuery = reads;
		for (const query of ["LIST", "TABLE file.name", "LIST FROM #proj", "TASK"]) run(query, first);
		expect(reads).toBe(afterFirstQuery);
	} finally {
		Object.defineProperty(first, "fileCtimeMs", {
			value: ctime,
			writable: true,
			configurable: true,
		});
	}
});

// Pre-fix this never returned (9^12 copies, then out of memory). No clock is
// read: finishing at all, inside the runner's timeout, is the assertion.
test("indexes a note whose frontmatter is a twelve-level YAML alias bomb", async () => {
	const lines = ["---", "level0: &level0 [x, x, x, x, x, x, x, x, x]"];
	for (let level = 1; level < 12; level += 1) {
		const refs = Array.from({ length: 9 }, () => `*level${level - 1}`).join(", ");
		lines.push(`level${level}: &level${level} [${refs}]`);
	}
	lines.push("---", "", "# Body");
	const local = await makeVault({ "bomb.md": lines.join("\n") });
	try {
		const top = local.page("bomb.md").dataviewFields.level11;
		expect(Array.isArray(top) ? top.length : 0).toBe(9);
	} finally {
		rmSync(local.root, { recursive: true, force: true });
	}
});

test("file.outlinks omits an attachment embed", async () => {
	const local = await makeVault({
		"a.md": "# A\n\nEmbed ![[pic.png]] and page [[b]].\n",
		"b.md": "# B\n",
		"pic.png": "x",
	});
	try {
		const html =
			renderDataviewQuery("LIST file.outlinks", local.page("a.md"), local.index).html ?? "";
		expect(html).not.toContain("pic.png");
		expect(html).toContain('href="/b"');
	} finally {
		rmSync(local.root, { recursive: true, force: true });
	}
});

// Last in the file: it switches the process time zone. Changing `TZ` cannot be
// undone by deleting it, so the zone in effect before is set back by name.
test("one local time model: the same note renders the same in any zone", async () => {
	const original = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
	const outputs: string[] = [];
	try {
		for (const zone of ["Asia/Tokyo", "UTC", "America/New_York"]) {
			process.env.TZ = zone;
			const local = await makeVault({ "N.md": "when:: 2026-01-01T00:30\n" });
			const page = local.page("N.md");
			const result = renderDataviewQuery(
				'TABLE WITHOUT ID when, when.year, when.hour, dateformat(when, "yyyy-MM-dd HH:mm"), file.mday = striptime(file.mtime)',
				page,
				local.index,
			);
			outputs.push(result.html ?? String(result.error));
			rmSync(local.root, { recursive: true, force: true });
		}
	} finally {
		process.env.TZ = original;
	}
	expect(tableRows(outputs[0])[1]).toEqual([
		"12:30 AM - January 01, 2026",
		"2026",
		"0",
		"2026-01-01 00:30",
		"true",
	]);
	expect(outputs[1]).toBe(outputs[0]);
	expect(outputs[2]).toBe(outputs[0]);
});
