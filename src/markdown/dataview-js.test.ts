import { describe, expect, test } from "bun:test";
import { renderDataviewJs } from "./dataview-js";
import type { BacklinkRef, ContentIndex, ContentPage, DataviewTask } from "./types";

interface TaskSpec {
	text: string;
	completed?: boolean;
	fields?: Record<string, unknown>;
}

interface PageSpec {
	relativePath: string;
	title?: string;
	tags?: string[];
	fields?: Record<string, unknown>;
	tasks?: TaskSpec[];
	links?: string[];
}

function makePage(spec: PageSpec): ContentPage {
	const filePathKey = spec.relativePath.replace(/\.(md|mdx)$/i, "");
	const baseName = filePathKey.split("/").pop() ?? filePathKey;
	const collapsed = filePathKey.replace(/(^|\/)index$/, "");
	const tasks: DataviewTask[] = (spec.tasks ?? []).map((task, index) => ({
		text: task.text,
		completed: task.completed ?? false,
		line: index + 1,
		path: spec.relativePath,
		fields: task.fields ?? {},
	}));
	return {
		absolutePath: `/vault/${spec.relativePath}`,
		relativePath: spec.relativePath,
		routePath: collapsed ? `/${collapsed}` : "/",
		pathKey: collapsed,
		filePathKey,
		baseName,
		title: spec.title,
		aliases: [],
		tags: spec.tags ?? [],
		cssclasses: [],
		publish: true,
		fileCtimeMs: 0,
		fileMtimeMs: 0,
		fileSizeBytes: 100,
		headings: [],
		wikilinkTargets: spec.links ?? [],
		headingBySlug: new Map(),
		headingByText: new Map(),
		blocks: [],
		dataviewFields: spec.fields ?? {},
		dataviewTasks: tasks,
		dataviewLists: tasks.map(({ text, line, path: taskPath, fields }) => ({
			text,
			line,
			path: taskPath,
			fields,
		})),
	};
}

function makeIndex(
	pages: ContentPage[],
	backlinks: Array<[string, BacklinkRef[]]> = [],
): ContentIndex {
	const byFilePathKeyCI = new Map<string, ContentPage[]>();
	const byBaseNameCI = new Map<string, ContentPage[]>();
	const byPathKeyCI = new Map<string, ContentPage[]>();
	for (const page of pages) {
		const lookups: Array<[Map<string, ContentPage[]>, string]> = [
			[byFilePathKeyCI, page.filePathKey.toLowerCase()],
			[byBaseNameCI, page.baseName.toLowerCase()],
			[byPathKeyCI, page.pathKey.toLowerCase()],
		];
		for (const [lookup, key] of lookups) lookup.set(key, [...(lookup.get(key) ?? []), page]);
	}
	return {
		rootDir: "/vault",
		pages,
		assets: [],
		byAbsolutePath: new Map(),
		byPathKey: new Map(),
		byFilePathKey: new Map(),
		byBaseName: byBaseNameCI,
		byTitle: new Map(),
		byAlias: new Map(),
		byTag: new Map(),
		byAssetPath: new Map(),
		byAssetBaseName: new Map(),
		byPathKeyCI,
		byFilePathKeyCI,
		byBaseNameCI,
		byAssetPathCI: new Map(),
		byAssetBaseNameCI: new Map(),
		backlinks: new Map(backlinks),
	};
}

const alpha = makePage({
	relativePath: "notes/alpha.md",
	title: "Alpha",
	tags: ["project/demo"],
	fields: { status: "open", priority: 2 },
	tasks: [{ text: "Ship alpha" }, { text: "Write notes", completed: true }],
	links: ["notes/beta"],
});
const beta = makePage({
	relativePath: "notes/beta.md",
	title: "Beta",
	tags: ["project/demo", "archive"],
	fields: { status: "closed", priority: 1 },
	tasks: [{ text: "Review beta" }],
});
const home = makePage({ relativePath: "index.md", title: "Home" });
const daily = makePage({ relativePath: "daily/2026-09-01.md", title: "Daily" });

const pages = [alpha, beta, home, daily];
const index = makeIndex(pages);
const dailyConfig = {
	folder: "daily",
	dateFormat: "YYYY-MM-DD",
	navigation: true,
	template: "",
	calendar: "",
};

describe("renderDataviewJs supported statements", () => {
	test("renders a table from a filtered page collection", () => {
		const result = renderDataviewJs(
			[
				'const open = dv.pages("#project/demo").where(p => p.status === "open");',
				'dv.table(["File"], open.map(p => [p.file.link]));',
			].join("\n"),
			home,
			index,
		);

		expect(result.error).toBeUndefined();
		expect(result.html).toBe(
			'<table class="dataviewjs-table"><thead><tr><th>File</th></tr></thead>' +
				'<tbody><tr><td><a href="/notes/alpha">Alpha</a></td></tr></tbody></table>',
		);
	});

	test("renders a list from a member chain over dv.pages", () => {
		const result = renderDataviewJs('dv.list(dv.pages("#project/demo").file.link);', home, index);

		expect(result.html).toBe(
			'<ul class="dataviewjs-list">' +
				'<li><a href="/notes/alpha">Alpha</a></li>' +
				'<li><a href="/notes/beta">Beta</a></li>' +
				"</ul>",
		);
	});

	test("renders paragraphs, headers, and lists from literal values", () => {
		const result = renderDataviewJs(
			[
				'dv.header(3, "Title");',
				'dv.header(9, "Clamped");',
				'dv.header(0, "Low");',
				"dv.list([1, 2, 3]);",
				"dv.list(null);",
				'dv.paragraph("plain");',
			].join("\n"),
			home,
			index,
		);

		expect(result.html).toBe(
			[
				"<h3>Title</h3>",
				"<h6>Clamped</h6>",
				"<h1>Low</h1>",
				'<ul class="dataviewjs-list"><li>1</li><li>2</li><li>3</li></ul>',
				'<ul class="dataviewjs-list"></ul>',
				'<p class="dataviewjs-paragraph">plain</p>',
			].join("\n"),
		);
	});

	test("renders a task list from page tasks, marking completed items", () => {
		const result = renderDataviewJs(
			'dv.taskList(dv.pages("#project/demo").file.tasks);',
			home,
			index,
		);

		expect(result.html).toBe(
			'<ul class="dataviewjs-task-list">' +
				'<li><input type="checkbox" disabled /> Ship alpha</li>' +
				'<li><input type="checkbox" disabled checked /> Write notes</li>' +
				'<li><input type="checkbox" disabled /> Review beta</li>' +
				"</ul>",
		);
	});

	test("renders non-task values in a task list without a checkbox state", () => {
		const result = renderDataviewJs('dv.taskList(["plain", null]);', home, index);

		expect(result.html).toBe('<ul class="dataviewjs-task-list"><li>plain</li><li></li></ul>');
	});

	test("wraps non-array table rows and escapes header markup", () => {
		const result = renderDataviewJs(
			['dv.table(["<b>"], [[1, 2], [3]]);', 'dv.table(["A"], [1, 2]);'].join("\n"),
			home,
			index,
		);

		expect(result.html).toBe(
			[
				'<table class="dataviewjs-table"><thead><tr><th>&lt;b&gt;</th></tr></thead>' +
					"<tbody><tr><td>1</td><td>2</td></tr><tr><td>3</td></tr></tbody></table>",
				'<table class="dataviewjs-table"><thead><tr><th>A</th></tr></thead>' +
					"<tbody><tr><td>1</td></tr><tr><td>2</td></tr></tbody></table>",
			].join("\n"),
		);
	});

	test("renders an empty table when no columns or rows are given", () => {
		const result = renderDataviewJs("dv.table();", home, index);

		expect(result.html).toBe(
			'<table class="dataviewjs-table"><thead><tr></tr></thead><tbody></tbody></table>',
		);
	});

	test("declares values with const, let, and var, then reads them back", () => {
		const result = renderDataviewJs(
			[
				"const a = 1;",
				'let b = "two";',
				"var c = true;",
				"dv.paragraph(a);",
				"dv.paragraph(b);",
				"dv.paragraph(c);",
			].join("\n"),
			home,
			index,
		);

		expect(result.html).toBe(
			[
				'<p class="dataviewjs-paragraph">1</p>',
				'<p class="dataviewjs-paragraph">two</p>',
				'<p class="dataviewjs-paragraph">true</p>',
			].join("\n"),
		);
	});

	test("reads object literal fields through a member chain", () => {
		const result = renderDataviewJs(
			[
				'const config = { label: "Count", value: 3 };',
				"dv.paragraph(config.label);",
				"dv.paragraph(config.value);",
			].join("\n"),
			home,
			index,
		);

		expect(result.html).toBe(
			['<p class="dataviewjs-paragraph">Count</p>', '<p class="dataviewjs-paragraph">3</p>'].join(
				"\n",
			),
		);
	});

	test("reads a page field, the current page, and a named page", () => {
		const result = renderDataviewJs(
			[
				"dv.paragraph(status);",
				"dv.paragraph(dv.current().name);",
				'dv.paragraph(dv.page("notes/beta").status);',
				'dv.paragraph(dv.page("missing"));',
			].join("\n"),
			alpha,
			index,
		);

		expect(result.html).toBe(
			[
				'<p class="dataviewjs-paragraph">open</p>',
				'<p class="dataviewjs-paragraph">Alpha</p>',
				'<p class="dataviewjs-paragraph">closed</p>',
				'<p class="dataviewjs-paragraph"></p>',
			].join("\n"),
		);
	});

	test("selects pages by tag and by quoted folder", () => {
		const result = renderDataviewJs(
			[
				'dv.paragraph(dv.pages("#project/demo").length);',
				"dv.paragraph(dv.pages('\"notes\"').length);",
				"dv.paragraph(dv.pages().length);",
				'dv.paragraph(dv.pages("notes").length);',
			].join("\n"),
			home,
			index,
		);

		expect(result.html).toBe(
			[
				'<p class="dataviewjs-paragraph">2</p>',
				'<p class="dataviewjs-paragraph">2</p>',
				'<p class="dataviewjs-paragraph">4</p>',
				// An unquoted string is not a folder filter, so it matches every page.
				'<p class="dataviewjs-paragraph">4</p>',
			].join("\n"),
		);
	});

	test("maps a property across a page collection", () => {
		const result = renderDataviewJs(
			'dv.paragraph(dv.pages("#project/demo").file.name);',
			home,
			index,
		);

		expect(result.html).toBe('<p class="dataviewjs-paragraph">alpha, beta</p>');
	});

	test("renders dates, arrays, objects, and nulls as paragraph values", () => {
		const result = renderDataviewJs(
			[
				'dv.paragraph(dv.date("2026-01-05"));',
				'dv.paragraph(dv.date("not a date"));',
				"dv.paragraph([1, 2]);",
				"dv.paragraph({a: 1});",
				"dv.paragraph(null);",
			].join("\n"),
			home,
			index,
		);

		expect(result.html).toBe(
			[
				'<p class="dataviewjs-paragraph">2026-01-05</p>',
				'<p class="dataviewjs-paragraph"></p>',
				'<p class="dataviewjs-paragraph">1, 2</p>',
				'<p class="dataviewjs-paragraph">{"a":1}</p>',
				'<p class="dataviewjs-paragraph"></p>',
			].join("\n"),
		);
	});

	test("wraps a single value in an array with dv.array", () => {
		const result = renderDataviewJs(
			["dv.paragraph(dv.array(7));", "dv.paragraph(dv.array([1, 2]));"].join("\n"),
			home,
			index,
		);

		expect(result.html).toBe(
			['<p class="dataviewjs-paragraph">7</p>', '<p class="dataviewjs-paragraph">1, 2</p>'].join(
				"\n",
			),
		);
	});

	test("exposes file.day for a daily note page", () => {
		const result = renderDataviewJs(
			"dv.paragraph(dv.current().file.day);",
			daily,
			index,
			dailyConfig,
		);

		expect(result.html).toBe('<p class="dataviewjs-paragraph">2026-09-01</p>');
	});

	test("falls back to the raw target for an outlink with no page", () => {
		const stray = makePage({
			relativePath: "notes/stray.md",
			title: "Stray",
			links: ["notes/missing"],
		});
		const result = renderDataviewJs(
			"dv.paragraph(dv.current().file.outlinks);",
			stray,
			makeIndex([stray]),
		);

		expect(result.html).toBe(
			'<p class="dataviewjs-paragraph"><a href="/notes/missing">notes/missing</a></p>',
		);
	});

	test("ignores comments and an empty source", () => {
		expect(renderDataviewJs("// nothing to do", home, index)).toEqual({ html: "" });
		expect(renderDataviewJs('// note\ndv.paragraph("after");', home, index)).toEqual({
			html: '<p class="dataviewjs-paragraph">after</p>',
		});
	});
});

describe("renderDataviewJs collection methods", () => {
	const names = (source: string) => {
		const result = renderDataviewJs(source, home, index);
		expect(result.error).toBeUndefined();
		return [...(result.html ?? "").matchAll(/<li>(.*?)<\/li>/g)].map((match) => match[1]);
	};

	test("filters with where and filter, including a parenthesised parameter", () => {
		expect(
			names('dv.list(dv.pages("#project/demo").where((p) => p.status === "open").file.name);'),
		).toEqual(["alpha"]);
		expect(
			names('dv.list(dv.pages("#project/demo").filter(p => p.status === "closed").file.name);'),
		).toEqual(["beta"]);
	});

	test("maps, sorts in both directions, limits, and slices", () => {
		expect(names('dv.list(dv.pages("#project/demo").map(p => p.file.name));')).toEqual([
			"alpha",
			"beta",
		]);
		expect(names('dv.list(dv.pages("#project/demo").sort(p => p.file.name).file.name);')).toEqual([
			"alpha",
			"beta",
		]);
		expect(
			names('dv.list(dv.pages("#project/demo").sort(p => p.file.name, "desc").file.name);'),
		).toEqual(["beta", "alpha"]);
		expect(names('dv.list(dv.pages("#project/demo").limit(1).file.name);')).toEqual(["alpha"]);
		expect(names('dv.list(dv.pages("#project/demo").slice(1).file.name);')).toEqual(["beta"]);
	});

	test("applies a collection method that is referenced without parentheses", () => {
		const result = renderDataviewJs(
			'dv.list(dv.pages("#project/demo").where.map(p => p.file.name));',
			home,
			index,
		);

		expect(result.html).toBe('<ul class="dataviewjs-list"><li>alpha</li><li>beta</li></ul>');
	});

	test("joins and flattens plain arrays", () => {
		const result = renderDataviewJs(
			['dv.paragraph([1, 2, 3].join("-"));', "dv.paragraph([[1, [2]], 3].flat());"].join("\n"),
			home,
			index,
		);

		expect(result.html).toBe(
			[
				'<p class="dataviewjs-paragraph">1-2-3</p>',
				'<p class="dataviewjs-paragraph">1, 2, 3</p>',
			].join("\n"),
		);
	});
});

describe("renderDataviewJs expressions", () => {
	const value = (expression: string) => {
		const result = renderDataviewJs(`dv.paragraph(${expression});`, home, index);
		expect(result.error).toBeUndefined();
		return (result.html ?? "")
			.replace(/^<p class="dataviewjs-paragraph">/, "")
			.replace(/<\/p>$/, "");
	};

	test("evaluates equality, comparison, and boolean operators", () => {
		expect(value("1 === 1")).toBe("true");
		expect(value("1 !== 2")).toBe("true");
		expect(value("1 == 1")).toBe("true");
		expect(value("1 != 2")).toBe("true");
		expect(value("2 > 1")).toBe("true");
		expect(value("1 < 2")).toBe("true");
		expect(value("2 >= 2")).toBe("true");
		expect(value("1 <= 2")).toBe("true");
		expect(value("1 > 2")).toBe("false");
		expect(value("true || false")).toBe("true");
		expect(value("false && true")).toBe("false");
		expect(value("!false")).toBe("true");
	});

	test("compares dates by timestamp and links by href", () => {
		expect(value('dv.date("2026-01-05") == dv.date("2026-01-05")')).toBe("true");
		expect(value('dv.date("2026-01-05") == dv.date("2026-01-06")')).toBe("false");
		expect(value('dv.page("notes/alpha").file.link == dv.page("notes/alpha").file.link')).toBe(
			"true",
		);
		expect(value('dv.page("notes/alpha").file.link != dv.page("notes/beta").file.link')).toBe(
			"true",
		);
	});
});

describe("renderDataviewJs rejections", () => {
	test("refuses source that mentions a host or runtime API", () => {
		const hostile = [
			"dv.paragraph(process.version);",
			'dv.paragraph(require("fs"));',
			'dv.paragraph(fetch("/x"));',
			'dv.paragraph(eval("1"));',
			'dv.paragraph(Function("return 1")());',
			"dv.paragraph(globalThis.x);",
			"dv.paragraph(global.x);",
			"dv.paragraph(window.location);",
			"dv.paragraph(document.title);",
			"dv.paragraph(setTimeout(() => 1, 0));",
			"dv.paragraph(setInterval(() => 1, 0));",
			'dv.paragraph(import("node:fs"));',
			"dv.paragraph(Bun.file);",
			"dv.paragraph(Deno.env);",
			"dv.paragraph({}.constructor);",
			"dv.paragraph({}.__proto__);",
			"dv.paragraph(Object.prototype);",
			"export const x = 1;",
		];

		for (const source of hostile) {
			const result = renderDataviewJs(source, home, index);

			expect(result.html).toBeUndefined();
			expect(result.error).toBe("DataviewJS source references a forbidden host or runtime API.");
		}
	});

	test("rejects an unsupported statement instead of ignoring it", () => {
		const result = renderDataviewJs('console.log("hi");', home, index);

		expect(result.html).toBeUndefined();
		expect(result.error).toBe('Unsupported DataviewJS statement: console.log("hi")');
	});

	test("rejects an assignment that is not a declaration", () => {
		const result = renderDataviewJs("x = 5;", home, index);

		expect(result.html).toBeUndefined();
		expect(result.error).toBe("Unsupported DataviewJS statement: x = 5");
	});

	test("rejects an unsupported function", () => {
		const result = renderDataviewJs("dv.paragraph(bogus(1));", home, index);

		expect(result.html).toBeUndefined();
		expect(result.error).toBe("Unsupported DataviewJS function: bogus.");
	});

	test("rejects an unsupported collection method", () => {
		const result = renderDataviewJs("dv.paragraph(dv.pages().bogus());", home, index);

		expect(result.html).toBeUndefined();
		expect(result.error).toBe("Unsupported DataviewJS collection method: bogus.");
	});

	test("requires a restricted arrow callback for collection methods", () => {
		const result = renderDataviewJs("dv.list(dv.pages().where());", home, index);

		expect(result.html).toBeUndefined();
		expect(result.error).toBe(".where() requires a restricted arrow callback.");
	});

	test("rejects a collection method on a non-collection", () => {
		const result = renderDataviewJs("dv.paragraph(dv.current().name.where(p => p));", home, index);

		expect(result.html).toBeUndefined();
		expect(result.error).toBe(".where() is only supported on Dataview collections.");
	});

	test("does not treat an unbalanced call expression as a call", () => {
		const result = renderDataviewJs("dv.paragraph(a((b))", home, index);

		expect(result.error).toBeUndefined();
		expect(result.html).toBe('<p class="dataviewjs-paragraph"></p>');
	});

	test("rejects an object literal field without a value", () => {
		const result = renderDataviewJs("dv.paragraph({a});", home, index);

		expect(result.html).toBeUndefined();
		expect(result.error).toBe("Invalid object field: a.");
	});
});
