import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildContentIndex } from "./content-index";
import { extractDataviewMetadata, renderDataviewInline, renderDataviewQuery } from "./dataview";
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
	aliases?: string[];
	fields?: Record<string, unknown>;
	tasks?: TaskSpec[];
	links?: string[];
	fileSizeBytes?: number;
}

const CTIME = Date.UTC(2026, 0, 2, 3, 4, 5);
const MTIME = Date.UTC(2026, 5, 7, 8, 9, 10);

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
		aliases: spec.aliases ?? [],
		tags: spec.tags ?? [],
		cssclasses: [],
		publish: true,
		fileCtimeMs: CTIME,
		fileMtimeMs: MTIME,
		fileSizeBytes: spec.fileSizeBytes ?? 100,
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
	fields: {
		status: "open",
		priority: 2,
		owner: "Alice",
		score: 7.5,
		launched: new Date(Date.UTC(2026, 0, 5)),
		scores: [1, 2, 3],
		big: "x".repeat(10_001),
	},
	tasks: [
		{ text: "Ship alpha", fields: { due: new Date(Date.UTC(2026, 8, 1)) } },
		{ text: "Write notes", completed: true },
	],
	links: ["notes/beta"],
	fileSizeBytes: 139,
});
const beta = makePage({
	relativePath: "notes/beta.md",
	title: "Beta",
	tags: ["project/demo", "archive"],
	fields: { status: "closed", priority: 1, owner: "Bob" },
	tasks: [{ text: "Review beta" }],
	fileSizeBytes: 71,
});
const gamma = makePage({
	relativePath: "notes/gamma.md",
	title: "Gamma",
	tags: ["other"],
	fields: { status: "open", priority: 5, owner: "Cara" },
});
const home = makePage({ relativePath: "index.md", title: "Home" });
const daily = makePage({ relativePath: "daily/2026-09-01.md", title: "Daily" });

const pages = [alpha, beta, gamma, home, daily];
const index = makeIndex(pages);
const dailyConfig = {
	folder: "daily",
	dateFormat: "YYYY-MM-DD",
	navigation: true,
	template: "",
	calendar: "",
};

/** Cell markup of every table row, so assertions read as the rendered table. */
function tableRows(html: string | undefined): string[][] {
	return [...(html ?? "").matchAll(/<tr>(.*?)<\/tr>/g)].map((row) =>
		[...(row[1] ?? "").matchAll(/<t[hd]>.*?<\/t[hd]>/g)].map((cell) => cell[0]),
	);
}

describe("renderDataviewQuery table pipeline", () => {
	test("renders aliased columns, filters with WHERE, sorts, and limits", () => {
		const result = renderDataviewQuery(
			[
				"TABLE status, priority, file.name AS note",
				'FROM "notes"',
				'WHERE status = "open"',
				"SORT priority DESC",
				"LIMIT 1",
			].join("\n"),
			home,
			index,
		);

		expect(result.error).toBeUndefined();
		expect(tableRows(result.html)).toEqual([
			["<th>File</th>", "<th>status</th>", "<th>priority</th>", "<th>note</th>"],
			[
				'<td><a href="/notes/gamma">Gamma</a></td>',
				"<td>open</td>",
				"<td>5</td>",
				"<td>gamma</td>",
			],
		]);
	});

	test("TABLE WITHOUT ID drops the implicit File column", () => {
		const result = renderDataviewQuery(
			["TABLE WITHOUT ID status, priority", 'FROM "notes"'].join("\n"),
			home,
			index,
		);

		expect(tableRows(result.html)).toEqual([
			["<th>status</th>", "<th>priority</th>"],
			["<td>open</td>", "<td>2</td>"],
			["<td>closed</td>", "<td>1</td>"],
			["<td>open</td>", "<td>5</td>"],
		]);
	});

	test("TABLE with no fields still lists the selected pages as links", () => {
		const result = renderDataviewQuery(["TABLE", 'FROM "notes"'].join("\n"), home, index);
		const rows = tableRows(result.html);

		expect(rows).toHaveLength(4);
		expect(rows.slice(1).map((row) => row[0])).toEqual([
			'<td><a href="/notes/alpha">Alpha</a></td>',
			'<td><a href="/notes/beta">Beta</a></td>',
			'<td><a href="/notes/gamma">Gamma</a></td>',
		]);
	});

	test("quoted and bare AS aliases both become column headers", () => {
		const result = renderDataviewQuery(
			['TABLE status AS "State", priority AS Rank', 'FROM "index"'].join("\n"),
			home,
			index,
		);

		expect(tableRows(result.html)[0]).toEqual(["<th>File</th>", "<th>State</th>", "<th>Rank</th>"]);
	});

	test("exposes file metadata columns", () => {
		const result = renderDataviewQuery(
			["TABLE file.folder, file.ext, file.size, file.name", 'FROM "notes"'].join("\n"),
			home,
			index,
		);

		expect(tableRows(result.html)).toEqual([
			[
				"<th>File</th>",
				"<th>file.folder</th>",
				"<th>file.ext</th>",
				"<th>file.size</th>",
				"<th>file.name</th>",
			],
			[
				'<td><a href="/notes/alpha">Alpha</a></td>',
				"<td>notes</td>",
				"<td>md</td>",
				"<td>139</td>",
				"<td>alpha</td>",
			],
			[
				'<td><a href="/notes/beta">Beta</a></td>',
				"<td>notes</td>",
				"<td>md</td>",
				"<td>71</td>",
				"<td>beta</td>",
			],
			[
				'<td><a href="/notes/gamma">Gamma</a></td>',
				"<td>notes</td>",
				"<td>md</td>",
				"<td>100</td>",
				"<td>gamma</td>",
			],
		]);
	});

	test("a root-level page reports an empty folder", () => {
		const result = renderDataviewQuery(
			["TABLE file.folder, file.name", 'FROM "index"'].join("\n"),
			home,
			index,
		);

		expect(tableRows(result.html)).toEqual([
			["<th>File</th>", "<th>file.folder</th>", "<th>file.name</th>"],
			['<td><a href="/">Home</a></td>', "<td></td>", "<td>index</td>"],
		]);
	});

	test("renders created and modified dates, plus their day keys", () => {
		const result = renderDataviewQuery(
			["TABLE file.ctime, file.cday, file.mday", 'FROM "index"'].join("\n"),
			home,
			index,
		);

		expect(tableRows(result.html)[1]).toEqual([
			'<td><a href="/">Home</a></td>',
			"<td>2026-01-02</td>",
			"<td>2026-01-02</td>",
			"<td>2026-06-07</td>",
		]);
	});

	test("exposes file.day only for pages matching the daily-note format", () => {
		const result = renderDataviewQuery(
			["TABLE file.day", 'FROM "daily"'].join("\n"),
			daily,
			index,
			dailyConfig,
		);

		expect(tableRows(result.html)).toEqual([
			["<th>File</th>", "<th>file.day</th>"],
			['<td><a href="/daily/2026-09-01">Daily</a></td>', "<td>2026-09-01</td>"],
		]);
	});

	test("tags render with and without the leading hash, and aliases as a list", () => {
		const result = renderDataviewQuery(
			["TABLE file.tags, file.etags, aliases", 'FROM "notes"'].join("\n"),
			home,
			index,
		);

		expect(tableRows(result.html)).toEqual([
			["<th>File</th>", "<th>file.tags</th>", "<th>file.etags</th>", "<th>aliases</th>"],
			[
				'<td><a href="/notes/alpha">Alpha</a></td>',
				"<td>#project/demo</td>",
				"<td>project/demo</td>",
				"<td></td>",
			],
			[
				'<td><a href="/notes/beta">Beta</a></td>',
				"<td>#project/demo, #archive</td>",
				"<td>project/demo, archive</td>",
				"<td></td>",
			],
			[
				'<td><a href="/notes/gamma">Gamma</a></td>',
				"<td>#other</td>",
				"<td>other</td>",
				"<td></td>",
			],
		]);
	});

	test("resolves outlinks to real pages and inlinks from the backlinks map", () => {
		const withBacklinks = makeIndex(pages, [
			["/notes/beta", [{ routePath: "/notes/alpha", title: "Alpha" }]],
		]);

		const result = renderDataviewQuery(
			["TABLE file.outlinks, file.inlinks", 'FROM "notes"'].join("\n"),
			home,
			withBacklinks,
		);

		expect(tableRows(result.html)).toEqual([
			["<th>File</th>", "<th>file.outlinks</th>", "<th>file.inlinks</th>"],
			[
				'<td><a href="/notes/alpha">Alpha</a></td>',
				'<td><a href="/notes/beta">Beta</a></td>',
				"<td></td>",
			],
			[
				'<td><a href="/notes/beta">Beta</a></td>',
				"<td></td>",
				'<td><a href="/notes/alpha">Alpha</a></td>',
			],
			['<td><a href="/notes/gamma">Gamma</a></td>', "<td></td>", "<td></td>"],
		]);
	});

	test("keeps the raw target for an outlink that resolves to no page", () => {
		const stray = makePage({
			relativePath: "notes/stray.md",
			title: "Stray",
			links: ['we"ird/target'],
		});
		const strayIndex = makeIndex([stray]);

		const result = renderDataviewQuery("TABLE file.outlinks", stray, strayIndex);

		expect(result.html).toContain('<a href="/we&quot;ird/target">we"ird/target</a>');
	});

	test("falls back to the basename when a page has no title", () => {
		const untitled = makePage({ relativePath: "notes/untitled.md" });
		const untitledIndex = makeIndex([untitled]);

		const result = renderDataviewQuery("TABLE name", untitled, untitledIndex);

		expect(tableRows(result.html)[1]).toEqual([
			'<td><a href="/notes/untitled">untitled</a></td>',
			"<td>untitled</td>",
		]);
	});

	test("counts tasks and lists through the length function", () => {
		const result = renderDataviewQuery(
			["TABLE length(file.tasks), length(file.lists)", 'FROM "notes"'].join("\n"),
			home,
			index,
		);

		expect(tableRows(result.html)).toEqual([
			["<th>File</th>", "<th>length(file.tasks)</th>", "<th>length(file.lists)</th>"],
			['<td><a href="/notes/alpha">Alpha</a></td>', "<td>2</td>", "<td>2</td>"],
			['<td><a href="/notes/beta">Beta</a></td>', "<td>1</td>", "<td>1</td>"],
			['<td><a href="/notes/gamma">Gamma</a></td>', "<td>0</td>", "<td>0</td>"],
		]);
	});

	test("maps a property across the task objects in file.tasks", () => {
		const result = renderDataviewQuery(
			["TABLE file.tasks.text", 'FROM "index"'].join("\n"),
			home,
			index,
		);

		expect(tableRows(result.html)).toEqual([
			["<th>File</th>", "<th>file.tasks.text</th>"],
			['<td><a href="/">Home</a></td>', "<td></td>"],
		]);
	});

	test("escapes HTML in page titles and leaves missing values blank", () => {
		const hostile = makePage({ relativePath: "notes/hostile.md", title: "A & B <b>" });
		const hostileIndex = makeIndex([hostile]);

		const result = renderDataviewQuery("TABLE missing", hostile, hostileIndex);

		expect(tableRows(result.html)).toEqual([
			["<th>File</th>", "<th>missing</th>"],
			['<td><a href="/notes/hostile">A &amp; B &lt;b&gt;</a></td>', "<td></td>"],
		]);
	});

	test("drops a link whose href is not an allowed scheme, keeping the label", () => {
		const forged = makePage({
			relativePath: "notes/forged.md",
			fields: { evil: { kind: "link", label: "Click me", href: "javascript:alert(1)" } },
		});
		const forgedIndex = makeIndex([forged]);

		const result = renderDataviewQuery("LIST evil", forged, forgedIndex);

		expect(result.html).not.toContain("javascript:");
		expect(result.html).toContain("Click me");
	});

	test("keeps a link whose href passes the scheme allowlist", () => {
		const good = makePage({
			relativePath: "notes/good.md",
			fields: { link: { kind: "link", label: "Docs", href: "https://example.com" } },
		});
		const goodIndex = makeIndex([good]);

		const result = renderDataviewQuery("LIST link", good, goodIndex);

		expect(result.html).toContain('<a href="https://example.com">Docs</a>');
	});

	test("renders an object field as JSON", () => {
		const result = renderDataviewQuery(["TABLE file", 'FROM "index"'].join("\n"), home, index);

		expect(result.html).toContain('"path":"index.md"');
	});
});

describe("renderDataviewQuery LIST, TASK, and CALENDAR", () => {
	test("LIST renders the page link when no expression is given", () => {
		const result = renderDataviewQuery(["LIST", 'FROM "notes"'].join("\n"), home, index);

		expect(result.html).toBe(
			'<ul class="dataview dataview-list">' +
				'<li><a href="/notes/alpha">Alpha</a></li>' +
				'<li><a href="/notes/beta">Beta</a></li>' +
				'<li><a href="/notes/gamma">Gamma</a></li>' +
				"</ul>",
		);
	});

	test("LIST evaluates its expression per row, including string concatenation", () => {
		const result = renderDataviewQuery(
			['LIST file.name + " (" + status + ")"', 'FROM "notes"'].join("\n"),
			home,
			index,
		);

		expect(result.html).toBe(
			'<ul class="dataview dataview-list">' +
				"<li>alpha (open)</li><li>beta (closed)</li><li>gamma (open)</li>" +
				"</ul>",
		);
	});

	test("TASK renders checkbox items and honours a completed filter", () => {
		const result = renderDataviewQuery(
			["TASK", 'FROM "notes"', "WHERE !completed"].join("\n"),
			home,
			index,
		);

		expect(result.html).toBe(
			'<ul class="dataview dataview-task-list">' +
				'<li><input type="checkbox" disabled /> Ship alpha</li>' +
				'<li><input type="checkbox" disabled /> Review beta</li>' +
				"</ul>",
		);
	});

	test("TASK marks completed items as checked", () => {
		const result = renderDataviewQuery(["TASK", 'FROM "notes"'].join("\n"), home, index);

		expect(result.html).toContain(
			'<li><input type="checkbox" disabled checked /> Write notes</li>',
		);
		expect(result.html).toContain('<li><input type="checkbox" disabled /> Ship alpha</li>');
	});

	test("CALENDAR files a non-daily note under the day it was created", () => {
		const result = renderDataviewQuery(
			["CALENDAR launched", 'FROM "notes"'].join("\n"),
			home,
			index,
		);

		// No daily note is in scope, so the notes fall back to `file.cday` and
		// share the month they were created in.
		expect(result.html).toContain('<table class="dataview-calendar-month">');
		expect(result.html).toContain("<caption>January 2026</caption>");
		expect(result.html).toMatch(/<li>2026-01-05 — <a href="\/notes\/alpha">Alpha<\/a><\/li>/);
	});

	test("CALENDAR grids a month of dated notes", () => {
		// The daily-note config is what gives a note its `file.day`, which is the
		// date a calendar files it under.
		const result = renderDataviewQuery(
			["CALENDAR", 'FROM "daily"'].join("\n"),
			home,
			index,
			dailyConfig,
		);

		expect(result.html).toContain('<table class="dataview-calendar-month">');
		// The caption names the month the notes fall in.
		expect(result.html).toContain("<caption>September 2026</caption>");
		// Weekday headers run Sunday-first, matching the leading empty cells.
		expect(result.html).toContain("<tr><th>Su</th><th>Mo</th>");
		// The note is listed in the cell of its own day, linked.
		expect(result.html).toMatch(
			/dataview-calendar-date">1<\/span><ul><li>[\s\S]*\/daily\/2026-09-01/,
		);
		// Leading empty cells carry no date, so the grid starts on the right day.
		expect(result.html).toContain('<td class="dataview-calendar-day is-empty"></td>');
	});

	test("CALENDAR draws one grid per month, newest first", () => {
		const result = renderDataviewQuery(["CALENDAR"].join("\n"), home, index, dailyConfig);

		// The daily note is dated 2026-09-01; the rest were created in January.
		const september = result.html?.indexOf("<caption>September 2026</caption>") ?? -1;
		const january = result.html?.indexOf("<caption>January 2026</caption>") ?? -1;
		expect(september).toBeGreaterThan(-1);
		expect(january).toBeGreaterThan(-1);
		expect(september).toBeLessThan(january);
	});
});

describe("renderDataviewQuery FROM sources", () => {
	test("selects a tag, including pages carrying a sub-tag", () => {
		const result = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", "FROM #project"].join("\n"),
			home,
			index,
		);

		expect(tableRows(result.html)).toEqual([
			["<th>file.name</th>"],
			["<td>alpha</td>"],
			["<td>beta</td>"],
		]);
	});

	test("selects a folder, a single file, and excludes with a negated source", () => {
		const folder = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", 'FROM "notes"'].join("\n"),
			home,
			index,
		);
		const single = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", 'FROM "notes/beta"'].join("\n"),
			home,
			index,
		);
		const negated = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", 'FROM "notes" AND -#archive'].join("\n"),
			home,
			index,
		);

		expect(tableRows(folder.html).map((row) => row[0])).toEqual([
			"<th>file.name</th>",
			"<td>alpha</td>",
			"<td>beta</td>",
			"<td>gamma</td>",
		]);
		expect(tableRows(single.html).map((row) => row[0])).toEqual([
			"<th>file.name</th>",
			"<td>beta</td>",
		]);
		expect(tableRows(negated.html).map((row) => row[0])).toEqual([
			"<th>file.name</th>",
			"<td>alpha</td>",
			"<td>gamma</td>",
		]);
	});

	test("combines sources with AND, OR, and parentheses", () => {
		const and = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", "FROM #project AND #archive"].join("\n"),
			home,
			index,
		);
		const or = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", "FROM #archive OR #other"].join("\n"),
			home,
			index,
		);
		const grouped = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", 'FROM ("notes" OR "index") AND -"notes/beta"'].join("\n"),
			home,
			index,
		);

		expect(tableRows(and.html).map((row) => row[0])).toEqual([
			"<th>file.name</th>",
			"<td>beta</td>",
		]);
		expect(tableRows(or.html).map((row) => row[0])).toEqual([
			"<th>file.name</th>",
			"<td>beta</td>",
			"<td>gamma</td>",
		]);
		expect(tableRows(grouped.html).map((row) => row[0])).toEqual([
			"<th>file.name</th>",
			"<td>alpha</td>",
			"<td>gamma</td>",
			"<td>index</td>",
		]);
	});

	test("selects inlinks for a bare and an explicit inlinks() source", () => {
		const bare = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", "FROM [[notes/beta]]"].join("\n"),
			home,
			index,
		);
		const explicit = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", "FROM inlinks([[notes/beta]])"].join("\n"),
			home,
			index,
		);

		expect(tableRows(bare.html).map((row) => row[0])).toEqual([
			"<th>file.name</th>",
			"<td>alpha</td>",
		]);
		expect(tableRows(explicit.html).map((row) => row[0])).toEqual([
			"<th>file.name</th>",
			"<td>alpha</td>",
		]);
	});

	test("selects the pages a note links to for an outlinks() source", () => {
		const result = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", "FROM outlinks([[notes/alpha]])"].join("\n"),
			home,
			index,
		);

		expect(tableRows(result.html).map((row) => row[0])).toEqual([
			"<th>file.name</th>",
			"<td>beta</td>",
		]);
	});

	test("ignores an alias and an anchor fragment in a link source", () => {
		const result = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", "FROM [[notes/beta|Beta alias#heading]]"].join("\n"),
			home,
			index,
		);

		expect(tableRows(result.html).map((row) => row[0])).toEqual([
			"<th>file.name</th>",
			"<td>alpha</td>",
		]);
	});

	test("treats a single-quoted source as a folder path", () => {
		const result = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", "FROM 'notes'"].join("\n"),
			home,
			index,
		);

		expect(tableRows(result.html).map((row) => row[0])).toEqual([
			"<th>file.name</th>",
			"<td>alpha</td>",
			"<td>beta</td>",
			"<td>gamma</td>",
		]);
	});
});

describe("renderDataviewQuery row shaping", () => {
	test("FLATTEN explodes an array field into one row per element", () => {
		const result = renderDataviewQuery(
			["TABLE WITHOUT ID tag, file.name", 'FROM "notes"', "FLATTEN file.tags AS tag"].join("\n"),
			home,
			index,
		);

		expect(tableRows(result.html)).toEqual([
			["<th>tag</th>", "<th>file.name</th>"],
			["<td>#project/demo</td>", "<td>alpha</td>"],
			["<td>#project/demo</td>", "<td>beta</td>"],
			["<td>#archive</td>", "<td>beta</td>"],
			["<td>#other</td>", "<td>gamma</td>"],
		]);
	});

	test("FLATTEN without an alias overwrites the field it flattens", () => {
		const result = renderDataviewQuery(
			["TABLE WITHOUT ID tags", 'FROM "notes"', "FLATTEN file.tags"].join("\n"),
			home,
			index,
		);

		expect(tableRows(result.html)).toEqual([
			["<th>tags</th>"],
			["<td>#project/demo</td>"],
			["<td>#project/demo</td>"],
			["<td>#archive</td>"],
			["<td>#other</td>"],
		]);
	});

	test("FLATTEN keeps a non-array value as a single row", () => {
		const result = renderDataviewQuery(
			["TABLE WITHOUT ID status", 'FROM "notes"', "FLATTEN status"].join("\n"),
			home,
			index,
		);

		expect(tableRows(result.html)).toEqual([
			["<th>status</th>"],
			["<td>open</td>"],
			["<td>closed</td>"],
			["<td>open</td>"],
		]);
	});

	test("SORT applies several keys with independent directions", () => {
		const result = renderDataviewQuery(
			[
				"TABLE WITHOUT ID file.name, status, priority",
				'FROM "notes"',
				"SORT status ASC, priority DESC",
			].join("\n"),
			home,
			index,
		);

		expect(tableRows(result.html)).toEqual([
			["<th>file.name</th>", "<th>status</th>", "<th>priority</th>"],
			["<td>beta</td>", "<td>closed</td>", "<td>1</td>"],
			["<td>gamma</td>", "<td>open</td>", "<td>5</td>"],
			["<td>alpha</td>", "<td>open</td>", "<td>2</td>"],
		]);
	});

	test("SORT orders dates and links", () => {
		const byDate = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", 'FROM "notes"', "SORT launched DESC"].join("\n"),
			home,
			index,
		);
		const byLink = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", 'FROM "notes"', "SORT file.link DESC"].join("\n"),
			home,
			index,
		);

		expect(tableRows(byDate.html).map((row) => row[0])).toEqual([
			"<th>file.name</th>",
			"<td>alpha</td>",
			"<td>beta</td>",
			"<td>gamma</td>",
		]);
		expect(tableRows(byLink.html).map((row) => row[0])).toEqual([
			"<th>file.name</th>",
			"<td>gamma</td>",
			"<td>beta</td>",
			"<td>alpha</td>",
		]);
	});

	test("GROUP BY replaces rows with groups that expose key and rows", () => {
		const result = renderDataviewQuery(
			["TABLE WITHOUT ID key, length(rows), rows.name", 'FROM "notes"', "GROUP BY status"].join(
				"\n",
			),
			home,
			index,
		);

		expect(tableRows(result.html)).toEqual([
			["<th>key</th>", "<th>length(rows)</th>", "<th>rows.name</th>"],
			["<td>open</td>", "<td>2</td>", "<td>Alpha, Gamma</td>"],
			["<td>closed</td>", "<td>1</td>", "<td>Beta</td>"],
		]);
	});

	test("GROUP BY keys dates and whole objects without collapsing distinct rows", () => {
		const byDate = renderDataviewQuery(
			["TABLE WITHOUT ID key, length(rows)", 'FROM "notes"', "GROUP BY launched"].join("\n"),
			home,
			index,
		);
		const byObject = renderDataviewQuery(
			["TABLE WITHOUT ID length(rows)", 'FROM "notes"', "GROUP BY file.link"].join("\n"),
			home,
			index,
		);

		expect(tableRows(byDate.html)).toEqual([
			["<th>key</th>", "<th>length(rows)</th>"],
			["<td>2026-01-05</td>", "<td>1</td>"],
			["<td></td>", "<td>2</td>"],
		]);
		expect(tableRows(byObject.html).length).toBe(4);
	});

	test("GROUP BY renders a task list grouped by the group key", () => {
		const result = renderDataviewQuery(
			["TASK", 'FROM "notes"', "GROUP BY file.name"].join("\n"),
			home,
			index,
		);

		expect(result.html).toBe(
			'<ul class="dataview dataview-task-list">' +
				"<li><strong>alpha</strong><ul>" +
				'<li><input type="checkbox" disabled /> Ship alpha</li>' +
				'<li><input type="checkbox" disabled checked /> Write notes</li>' +
				"</ul></li>" +
				"<li><strong>beta</strong><ul>" +
				'<li><input type="checkbox" disabled /> Review beta</li>' +
				"</ul></li>" +
				"</ul>",
		);
	});

	test("WHERE keeps only rows satisfying the predicate", () => {
		const greater = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", 'FROM "notes"', "WHERE priority > 1"].join("\n"),
			home,
			index,
		);
		const notEqual = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", 'FROM "notes"', "WHERE priority != 2"].join("\n"),
			home,
			index,
		);
		const atMost = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", 'FROM "notes"', "WHERE priority <= 1"].join("\n"),
			home,
			index,
		);
		const atLeast = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", 'FROM "notes"', "WHERE priority >= 5"].join("\n"),
			home,
			index,
		);
		const less = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", 'FROM "notes"', "WHERE priority < 2"].join("\n"),
			home,
			index,
		);
		const names = (html: string | undefined) =>
			tableRows(html)
				.slice(1)
				.map((row) => row[0]);

		expect(names(greater.html)).toEqual(["<td>alpha</td>", "<td>gamma</td>"]);
		expect(names(notEqual.html)).toEqual(["<td>beta</td>", "<td>gamma</td>"]);
		expect(names(atMost.html)).toEqual(["<td>beta</td>"]);
		expect(names(atLeast.html)).toEqual(["<td>gamma</td>"]);
		expect(names(less.html)).toEqual(["<td>beta</td>"]);
	});

	test("WHERE combines predicates with AND, OR, and negation", () => {
		const and = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", 'FROM "notes"', 'WHERE status = "open" AND priority > 3'].join(
				"\n",
			),
			home,
			index,
		);
		const or = renderDataviewQuery(
			[
				"TABLE WITHOUT ID file.name",
				'FROM "notes"',
				'WHERE status = "closed" OR priority > 3',
			].join("\n"),
			home,
			index,
		);
		const negated = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", 'FROM "notes"', 'WHERE !(status = "open")'].join("\n"),
			home,
			index,
		);
		const names = (html: string | undefined) =>
			tableRows(html)
				.slice(1)
				.map((row) => row[0]);

		expect(names(and.html)).toEqual(["<td>gamma</td>"]);
		expect(names(or.html)).toEqual(["<td>beta</td>", "<td>gamma</td>"]);
		expect(names(negated.html)).toEqual(["<td>beta</td>"]);
	});

	test("WHERE treats null and missing fields as ordering below every value", () => {
		const result = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", 'FROM "notes"', 'WHERE launched > date("2025-01-01")'].join(
				"\n",
			),
			home,
			index,
		);

		expect(tableRows(result.html)).toEqual([["<th>file.name</th>"], ["<td>alpha</td>"]]);
	});

	test("LIMIT truncates the sorted result set", () => {
		const result = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", 'FROM "notes"', "SORT file.name", "LIMIT 2"].join("\n"),
			home,
			index,
		);

		expect(tableRows(result.html)).toEqual([
			["<th>file.name</th>"],
			["<td>alpha</td>"],
			["<td>beta</td>"],
		]);
	});

	test("ignores # comment lines inside a query", () => {
		const result = renderDataviewQuery(
			["# a comment", "TABLE WITHOUT ID file.name", "# another", 'FROM "notes/beta"'].join("\n"),
			home,
			index,
		);

		expect(tableRows(result.html)).toEqual([["<th>file.name</th>"], ["<td>beta</td>"]]);
	});
});

describe("renderDataviewQuery expression evaluator", () => {
	const evaluate = (expression: string, source = 'FROM "notes"') =>
		renderDataviewQuery(
			[`TABLE WITHOUT ID file.name, ${expression}`, source].join("\n"),
			home,
			index,
		);

	test("evaluates arithmetic, unary minus, division by zero, and grouping", () => {
		expect(tableRows(evaluate("10 / 4, 10 / 0, 7 - 2, 3 * 4, -priority").html)[1]).toEqual([
			"<td>alpha</td>",
			"<td>2.5</td>",
			"<td></td>",
			"<td>5</td>",
			"<td>12</td>",
			"<td>-2</td>",
		]);
		expect(tableRows(evaluate("(1 + 2) * 3").html)[1]?.[1]).toBe("<td>9</td>");
	});

	test("evaluates comparisons to booleans", () => {
		expect(
			tableRows(evaluate("priority > 1, priority >= 1, priority < 1, priority <= 1").html)[1],
		).toEqual([
			"<td>alpha</td>",
			"<td>true</td>",
			"<td>true</td>",
			"<td>false</td>",
			"<td>false</td>",
		]);
	});

	test("compares a page link against a string label", () => {
		const forward = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", 'FROM "notes"', 'WHERE file.link = "Alpha"'].join("\n"),
			home,
			index,
		);
		const reversed = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", 'FROM "notes"', 'WHERE "Alpha" = file.link'].join("\n"),
			home,
			index,
		);

		expect(tableRows(forward.html)).toEqual([["<th>file.name</th>"], ["<td>alpha</td>"]]);
		expect(tableRows(reversed.html)).toEqual([["<th>file.name</th>"], ["<td>alpha</td>"]]);
	});

	test("evaluates literals: numbers, strings, booleans, null, and today", () => {
		const row = tableRows(evaluate('"quoted", 42, 1.5, true, false, null, today()').html)[1];

		expect(row?.slice(1, 7)).toEqual([
			"<td>quoted</td>",
			"<td>42</td>",
			"<td>1.5</td>",
			"<td>true</td>",
			"<td>false</td>",
			"<td></td>",
		]);
		expect(row?.[7]).toMatch(/^<td>\d{4}-\d{2}-\d{2}<\/td>$/);
	});

	test("evaluates a bare [[link]] literal as a link", () => {
		const result = renderDataviewQuery(
			["TABLE WITHOUT ID [[notes/beta]]", 'FROM "index"'].join("\n"),
			home,
			index,
		);

		expect(result.html).toContain('<a href="#">notes/beta</a>');
	});

	test("coerces a string field and a number field through the same comparison", () => {
		const result = renderDataviewQuery(
			["TABLE WITHOUT ID file.name, priority", 'FROM "notes"', 'WHERE status = "open"'].join("\n"),
			home,
			index,
		);

		expect(tableRows(result.html)).toEqual([
			["<th>file.name</th>", "<th>priority</th>"],
			["<td>alpha</td>", "<td>2</td>"],
			["<td>gamma</td>", "<td>5</td>"],
		]);
	});
});

describe("renderDataviewQuery function library", () => {
	const evaluate = (expression: string, source = 'FROM "notes"') =>
		renderDataviewQuery([`TABLE WITHOUT ID ${expression}`, source].join("\n"), home, index);

	test("string predicates: contains, startswith, endswith, and regexmatch", () => {
		const cells = (expression: string) =>
			tableRows(evaluate(expression).html)
				.slice(1)
				.map((row) => row[0]);

		expect(cells('contains(file.name, "mm")')).toEqual([
			"<td>false</td>",
			"<td>false</td>",
			"<td>true</td>",
		]);
		expect(cells('startswith(file.name, "al")')).toEqual([
			"<td>true</td>",
			"<td>false</td>",
			"<td>false</td>",
		]);
		expect(cells('endswith(file.name, "ta")')).toEqual([
			"<td>false</td>",
			"<td>true</td>",
			"<td>false</td>",
		]);
		expect(cells('regexmatch("^g", file.name)')).toEqual([
			"<td>false</td>",
			"<td>false</td>",
			"<td>true</td>",
		]);
		expect(cells('contains(file.tags, "#archive")')).toEqual([
			"<td>false</td>",
			"<td>true</td>",
			"<td>false</td>",
		]);
	});

	test("case and numeric helpers: lower, upper, round, floor, ceil", () => {
		const single = (expression: string) =>
			tableRows(evaluate(expression).html)
				.slice(1)
				.map((row) => row[0]);

		expect(single('lower(file.name) = "alpha"')).toEqual([
			"<td>true</td>",
			"<td>false</td>",
			"<td>false</td>",
		]);
		expect(single('upper(file.name) = "BETA"')).toEqual([
			"<td>false</td>",
			"<td>true</td>",
			"<td>false</td>",
		]);
		expect(single("round(score) = 8")).toEqual([
			"<td>true</td>",
			"<td>false</td>",
			"<td>false</td>",
		]);
		expect(single("floor(score) = 7")).toEqual([
			"<td>true</td>",
			"<td>false</td>",
			"<td>false</td>",
		]);
		expect(single("ceil(score) = 8")).toEqual([
			"<td>true</td>",
			"<td>false</td>",
			"<td>false</td>",
		]);
	});

	test("replace, split, and join transform strings", () => {
		expect(
			tableRows(evaluate('replace(file.name, "a", "A")').html)
				.slice(1)
				.map((row) => row[0]),
		).toEqual(["<td>AlphA</td>", "<td>betA</td>", "<td>gAmmA</td>"]);
		expect(
			tableRows(evaluate('split(file.name, "a"), join(split(file.name, "a"), "|")').html).slice(
				1,
				2,
			),
		).toEqual([["<td>, lph, </td>", "<td>|lph|</td>"]]);
	});

	test("numeric aggregates over an array field", () => {
		expect(
			tableRows(evaluate("sum(scores), average(scores), min(scores), max(scores)").html).slice(
				1,
				2,
			),
		).toEqual([["<td>6</td>", "<td>2</td>", "<td>1</td>", "<td>3</td>"]]);
	});

	test("typeof, default, choice, length, and date", () => {
		const row = tableRows(
			evaluate(
				'typeof(file.tags), typeof(missing), typeof(null), default(missing, "fallback"), choice(status = "open", "yes", "no"), length(file.tasks), date("2026-01-05")',
			).html,
		)[1];

		expect(row).toEqual([
			"<td>array</td>",
			"<td>undefined</td>",
			"<td>null</td>",
			"<td>fallback</td>",
			"<td>yes</td>",
			"<td>2</td>",
			"<td>2026-01-05</td>",
		]);
	});

	test("length of a string counts characters", () => {
		expect(tableRows(evaluate('length("abcd")').html)[1]?.[0]).toBe("<td>4</td>");
	});

	test("date() returns null for an unparsable value or a non-string argument", () => {
		expect(tableRows(evaluate('date("not a date"), date(5)').html)[1]).toEqual([
			"<td></td>",
			"<td></td>",
		]);
	});
});

describe("renderDataviewQuery grouping and summaries", () => {
	const rows = (html: string | undefined) => tableRows(html);

	test("GROUP BY nests two keys, the second inside the first", () => {
		const result = renderDataviewQuery(
			["TABLE status, owner", 'FROM "notes"', "GROUP BY status, owner"].join("\n"),
			home,
			index,
		);

		// One row per (status, owner) pair, each carrying both key values.
		const body = rows(result.html)
			.slice(1)
			.map((row) => row[0]);
		expect(body).toHaveLength(3);
		expect(result.html).toContain("<td>open</td>");
		expect(result.html).toContain("<td>Alice</td>");
		expect(result.html).toContain("<td>closed</td>");
		expect(result.html).toContain("<td>Bob</td>");
	});

	test("THEN appends a summary value per group", () => {
		const result = renderDataviewQuery(
			[
				"TABLE WITHOUT ID sum(rows.priority) AS total",
				'FROM "notes"',
				"GROUP BY status",
				"THEN sum(rows.priority)",
			].join("\n"),
			home,
			index,
		);

		// The summary replaces the group key, so the totals read as the key.
		expect(result.html).toContain("<td>7</td>"); // open: 2 + 5
		expect(result.html).toContain("<td>1</td>"); // closed: 1
	});

	test("LIMIT accepts an expression, not just a count", () => {
		const literal = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", 'FROM "notes"', "LIMIT 1"].join("\n"),
			home,
			index,
		);
		const expression = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", 'FROM "notes"', "LIMIT 1 + 1"].join("\n"),
			home,
			index,
		);

		expect(rows(literal.html).slice(1)).toHaveLength(1);
		expect(rows(expression.html).slice(1)).toHaveLength(2);
	});

	test("LIMIT ignores an operand that is not a number", () => {
		const result = renderDataviewQuery(
			["TABLE WITHOUT ID file.name", 'FROM "notes"', "LIMIT file.name"].join("\n"),
			home,
			index,
		);

		expect(rows(result.html).slice(1)).toHaveLength(3);
	});
});

describe("renderDataviewQuery date and collection functions", () => {
	const cell = (expression: string) =>
		tableRows(
			renderDataviewQuery(
				[`TABLE WITHOUT ID ${expression}`, 'FROM "notes"', 'WHERE file.name = "alpha"'].join("\n"),
				home,
				index,
			).html,
		)[1]?.[0];

	test("date parts follow Dataview's numbering", () => {
		expect(cell('dateformat(launched, "MMMM d, yyyy")')).toBe("<td>January 5, 2026</td>");
		// `LLLL` is Luxon's stand-alone month-and-year.
		expect(cell('dateformat(launched, "LLLL")')).toBe("<td>January 2026</td>");
		expect(cell('dateformat(launched, "dd")')).toBe("<td>05</td>");
		expect(cell("year(launched)")).toBe("<td>2026</td>");
		expect(cell("month(launched)")).toBe("<td>1</td>");
		expect(cell("weekday(launched)")).toBe("<td>1</td>"); // Monday, 1-based
		expect(cell("weeknumber(launched)")).toBe("<td>2</td>");
	});

	test("date arithmetic moves by the named units", () => {
		expect(cell('dateformat(dateplus(launched, "2 weeks"), "yyyy-MM-dd")')).toBe(
			"<td>2026-01-19</td>",
		);
		expect(cell('dateformat(dateminus(launched, "1 month"), "yyyy-MM-dd")')).toBe(
			"<td>2025-12-05</td>",
		);
	});

	test("string helpers cover trimming, padding and casing", () => {
		expect(cell('trim("  padded  ")')).toBe("<td>padded</td>");
		expect(cell('padleft("7", 3, "0")')).toBe("<td>007</td>");
		expect(cell('padright("7", 3, "0")')).toBe("<td>700</td>");
		expect(cell('truncate("abcdef", 3)')).toBe("<td>abc</td>");
		expect(cell('titlecase("hello world")')).toBe("<td>Hello World</td>");
		expect(cell('reversestring("abc")')).toBe("<td>cba</td>");
	});

	test("collection helpers aggregate arrays", () => {
		expect(cell("sum(scores)")).toBe("<td>6</td>");
		expect(cell("max(scores)")).toBe("<td>3</td>");
		expect(cell("distinct(tags)")).toBe("<td>#project/demo</td>");
		expect(cell("firstvalueof(scores)")).toBe("<td>1</td>");
		expect(cell("lastvalueof(scores)")).toBe("<td>3</td>");
		expect(cell("any(scores)")).toBe("<td>true</td>");
		expect(cell("all(scores)")).toBe("<td>true</td>");
		expect(cell("nonnull(scores)")).toBe("<td>1, 2, 3</td>");
	});
});

describe("renderDataviewQuery time and collection edge cases", () => {
	const cell = (expression: string) =>
		tableRows(
			renderDataviewQuery(
				[`TABLE WITHOUT ID ${expression}`, 'FROM "notes"', 'WHERE file.name = "alpha"'].join("\n"),
				home,
				index,
			).html,
		)[1]?.[0];

	test("striptime drops the time of day", () => {
		expect(cell('dateformat(striptime(launched), "yyyy-MM-dd HH:mm")')).toBe(
			"<td>2026-01-05 00:00</td>",
		);
	});

	test("clock parts read as zero for a midnight date", () => {
		expect(cell("hour(striptime(launched))")).toBe("<td>0</td>");
		expect(cell("minute(striptime(launched))")).toBe("<td>0</td>");
		expect(cell("second(striptime(launched))")).toBe("<td>0</td>");
	});

	test("a date that cannot be parsed reads as empty, not an error", () => {
		expect(cell('year("not a date")')).toBe("<td></td>");
		expect(cell('dateformat("not a date", "yyyy")')).toBe("<td></td>");
		expect(cell('dateplus("not a date", "1 day")')).toBe("<td></td>");
		expect(cell('dateplus(launched, "nonsense")')).toBe("<td></td>");
	});

	test("now is a usable date", () => {
		const result = renderDataviewQuery(
			["TABLE WITHOUT ID year(now)", 'FROM "notes"'].join("\n"),
			home,
			index,
		);
		expect(result.html).toMatch(/<td>\d{4}<\/td>/);
	});

	test("weeks cross the year boundary the way ISO does", () => {
		// 2026-01-01 is a Thursday, so it belongs to week 1 of 2026; a late
		// December day belongs to the first week of the next year.
		const first = renderDataviewQuery(
			["TABLE WITHOUT ID weeknumber(launched), weekyear(launched)", 'FROM "notes"'].join("\n"),
			home,
			index,
		);
		expect(tableRows(first.html)[1]).toEqual(["<td>2</td>", "<td>2026</td>"]);

		const newYearsEve = renderDataviewQuery(
			[
				'TABLE WITHOUT ID weekyear(date("2027-01-01"))',
				'FROM "notes"',
				'WHERE file.name = "alpha"',
			].join("\n"),
			home,
			index,
		);
		expect(tableRows(newYearsEve.html)[1]?.[0]).toBe("<td>2026</td>");
	});

	test("flatten and strictsort normalize collections", () => {
		expect(cell("flatten(tags, 1)")).toBe("<td>#project/demo</td>");
		expect(cell("strictsort(scores)")).toBe("<td>1, 2, 3</td>");
		expect(cell("defaultblank(scores)")).toBe("<td>1</td>");
	});
});

describe("renderDataviewQuery bracket indexing", () => {
	const cell = (expression: string) =>
		tableRows(
			renderDataviewQuery(
				[`TABLE WITHOUT ID ${expression}`, 'FROM "notes"', 'WHERE file.name = "alpha"'].join("\n"),
				home,
				index,
			).html,
		)[1]?.[0];

	test("indexes a list by position, including from the end", () => {
		expect(cell("scores[0]")).toBe("<td>1</td>");
		expect(cell("scores[2]")).toBe("<td>3</td>");
		expect(cell("scores[-1]")).toBe("<td>3</td>");
	});

	test("an index past the end reads as empty, not an error", () => {
		expect(cell("scores[9]")).toBe("<td></td>");
		expect(cell("scores[0][1]")).toBe("<td></td>");
	});

	test("indexes an object field by key", () => {
		expect(cell('file["name"]')).toBe("<td>alpha</td>");
	});
});

describe("renderDataviewQuery errors", () => {
	const expectError = (query: string, fragment: string) => {
		const result = renderDataviewQuery(query, home, index);

		expect(result.html).toBeUndefined();
		expect(result.error).toContain(fragment);
	};

	test("reports an empty query", () => {
		expectError("", "Dataview query is empty");
	});

	test("reports an unsupported query type instead of an empty table", () => {
		expectError("MOON file.name", "Unsupported Dataview query type: MOON file.name");
	});

	test("reports an unsupported command line", () => {
		expectError("TABLE file.name\nFOO bar", "Unsupported Dataview command: FOO bar");
	});

	test("reports a second FROM clause", () => {
		expectError('TABLE file.name\nFROM "notes"\nFROM "daily"', "only one FROM clause");
	});

	test("reports an unrecognized FROM source in every malformed shape", () => {
		expectError("TABLE file.name\nFROM bogus", "Unsupported Dataview source: bogus");
		expectError("TABLE file.name\nFROM #", "Unsupported Dataview source: #");
		expectError("TABLE file.name\nFROM [[notes/beta]] extra", "Unsupported Dataview source");
		expectError("TABLE file.name\nFROM ([[notes/beta]]", "Unsupported Dataview source");
		expectError("TABLE file.name\nFROM inlinks(bogus)", "Unsupported Dataview source");
		expectError("TABLE file.name\nFROM inlinks([[notes/beta]]", "Unsupported Dataview source");
		expectError("TABLE file.name\nFROM [[ ]]", "Unsupported Dataview source");
	});

	test("reports an unsupported function instead of a blank cell", () => {
		expectError("TABLE bogus(file.name)", "Unsupported Dataview function: bogus");
	});

	test("surfaces an invalid regular expression pattern as an error", () => {
		const result = renderDataviewQuery('TABLE regexmatch("[", file.name)', home, index);

		expect(result.html).toBeUndefined();
		expect(result.error).toBeDefined();
	});

	test("rejects a nested-quantifier pattern before running it", () => {
		expectError('TABLE regexmatch("(a+)+$", file.name)', "uses nested quantifiers");
		expectError('TABLE regexmatch("a{2,}+", file.name)', "uses nested quantifiers");
	});

	test("rejects an oversized pattern", () => {
		expectError(`TABLE regexmatch("${"a".repeat(1001)}", file.name)`, "too long");
	});

	test("rejects an oversized regex subject", () => {
		expectError('TABLE regexmatch("bb", big)', "subject is too long");
	});
});

describe("renderDataviewInline", () => {
	test("renders an inline expression for the current page", () => {
		expect(renderDataviewInline("file.name", alpha, index)).toEqual({
			html: '<span class="dataview-inline">alpha</span>',
		});
		expect(renderDataviewInline("length(file.tasks)", alpha, index)).toEqual({
			html: '<span class="dataview-inline">2</span>',
		});
	});

	test("renders an inline function call and an inline link", () => {
		expect(renderDataviewInline('file.name + "!"', alpha, index).html).toBe(
			'<span class="dataview-inline">alpha!</span>',
		);
		expect(renderDataviewInline("file.link", alpha, index).html).toBe(
			'<span class="dataview-inline"><a href="/notes/alpha">Alpha</a></span>',
		);
	});

	test("reports an error for an unsupported inline function", () => {
		const result = renderDataviewInline("bogus(file.name)", alpha, index);

		expect(result.html).toBeUndefined();
		expect(result.error).toBe("Unsupported Dataview function: bogus.");
	});
});

/** Run `body` against a throwaway vault built from `files`. */
async function withVault(
	files: Record<string, string>,
	body: (root: string) => Promise<void>,
): Promise<void> {
	const root = mkdtempSync(path.join(os.tmpdir(), "obsidian-dataview-"));
	try {
		for (const [name, content] of Object.entries(files)) {
			writeFileSync(path.join(root, name), content);
		}
		await body(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** A YAML alias bomb as js-yaml hands it back: `depth` levels of nine
 *  references to the level below, so the value is `depth` distinct arrays but
 *  `9^depth` paths through them. */
function aliasBomb(depth: number): unknown[] {
	let node: unknown[] = ["x", "x", "x", "x", "x", "x", "x", "x", "x"];
	for (let level = 1; level < depth; level += 1) node = Array.from({ length: 9 }, () => node);
	return node;
}

/** The same bomb written as vault frontmatter, one anchor per level. */
function aliasBombFrontmatter(depth: number): string {
	const lines = ["---", "level0: &level0 [x, x, x, x, x, x, x, x, x]"];
	for (let level = 1; level < depth; level += 1) {
		const refs = Array.from({ length: 9 }, () => `*level${level - 1}`).join(", ");
		lines.push(`level${level}: &level${level} [${refs}]`);
	}
	lines.push("---", "", "# Body");
	return lines.join("\n");
}

describe("extractDataviewMetadata", () => {
	const markdown = [
		"---",
		"title: Sample",
		"---",
		"",
		"```js",
		"fenced:: ignored",
		"```",
		"",
		"owner:: Alice",
		"scores:: [1, 2, 3]",
		"Body text with an inline (rating:: 5) field.",
		"",
		"- [ ] Ship it [due:: 2026-09-01]",
		"- [x] Done already",
		"- plain item",
	].join("\n");

	test("collects frontmatter, inline, and standalone fields under raw and sanitized keys", () => {
		const { fields } = extractDataviewMetadata(
			markdown,
			{
				title: "Sample",
				"My Field": "Value",
				priority: 2,
				meta: { author: "Alice", nested: { deep: 1 } },
			},
			"n.md",
		);

		expect(fields.title).toBe("Sample");
		expect(fields.priority).toBe(2);
		expect(fields["My Field"]).toBe("Value");
		expect(fields["my-field"]).toBe("Value");
		expect(fields.owner).toBe("Alice");
		expect(fields.rating).toBe(5);
		expect(fields.scores).toEqual([1, 2, 3]);
		expect(fields.meta).toEqual({ author: "Alice", nested: { deep: 1 } });
		expect(fields.fenced).toBeUndefined();
	});

	test("collects tasks with their fields, completion state, and line numbers", () => {
		const { tasks } = extractDataviewMetadata(markdown, {}, "notes/sample.md");

		expect(tasks).toHaveLength(2);
		expect(tasks[0]?.text).toBe("Ship it");
		expect(tasks[0]?.completed).toBe(false);
		expect(tasks[0]?.line).toBe(13);
		expect(tasks[0]?.path).toBe("notes/sample.md");
		expect(tasks[0]?.fields.due).toEqual(new Date(Date.UTC(2026, 8, 1)));
		expect(tasks[1]?.completed).toBe(true);
		expect(tasks[1]?.text).toBe("Done already");
	});

	test("collects list items, including the tasks themselves", () => {
		const { lists } = extractDataviewMetadata(markdown, {}, "n.md");

		expect(lists.map((item) => item.text)).toEqual(["Ship it", "Done already", "plain item"]);
		expect(lists[2]?.line).toBe(15);
	});

	test("treats a document with no frontmatter fence as plain content", () => {
		const { fields, tasks } = extractDataviewMetadata("status:: open\n\n- [ ] One", {}, "n.md");

		expect(fields.status).toBe("open");
		expect(tasks).toHaveLength(1);
	});

	test("bounds a twelve-level alias bomb instead of copying 9^12 nodes", () => {
		const bomb = aliasBomb(12);
		const started = performance.now();
		const { fields } = extractDataviewMetadata("---\n---\n", { bomb }, "bomb.md");
		const elapsed = performance.now() - started;

		// ponytail: ceiling, not a measured value — the copy is linear in the
		// number of distinct values (~3 ms here); 200 ms leaves room for a loaded
		// machine and still fails the pre-fix exponential walk.
		expect(elapsed).toBeLessThan(200);
		// The value normalizes all the way down: twelve `[0]` hops reach the leaf.
		let level: unknown = fields.bomb;
		for (let hops = 1; hops < 12; hops += 1) level = (level as unknown[])[0];
		expect(level).toEqual(["x", "x", "x", "x", "x", "x", "x", "x", "x"]);
	});

	test("copies a bombed value without touching the caller's object", () => {
		const bomb = aliasBomb(12);
		const { fields } = extractDataviewMetadata("", { bomb }, "bomb.md");

		const copy = fields.bomb as unknown[];
		(copy[0] as unknown[]).push("noise");

		expect(copy[0]).not.toBe((bomb as unknown[])[0]);
		expect((bomb[0] as unknown[]).length).toBe(9);
		// The anchors js-yaml shared stay shared in the input.
		expect(bomb[0]).toBe(bomb[1]);
	});

	test("normalizes a list of maps with scalar fields to exactly its values", () => {
		const people = [
			{ name: "Alice", age: 30, active: true, joined: new Date(Date.UTC(2026, 8, 1)) },
			{ name: "Bob", age: 25, active: false, tags: ["x", "y"] },
		];
		const { fields } = extractDataviewMetadata(
			"",
			{ people, capacity: { min: 1, max: 10 } },
			"n.md",
		);

		expect(fields.people).toEqual(people);
		expect(fields.capacity).toEqual({ min: 1, max: 10 });
	});

	test("degrades a cyclic anchor to null instead of blowing the stack", () => {
		// `loop: &loop [a, *loop]` parses to a genuinely self-referencing array.
		const loop: unknown[] = ["a"];
		loop.push(loop);

		const { fields } = extractDataviewMetadata("", { loop }, "loop.md");

		expect(fields.loop).toEqual(["a", null]);
	});

	test("keeps every reference to a shared YAML anchor readable", () => {
		const defaults = { theme: "dark", accent: "blue" };
		const { fields } = extractDataviewMetadata(
			"",
			{ defaults, palette: [defaults, defaults] },
			"n.md",
		);

		expect(fields.defaults).toEqual({ theme: "dark", accent: "blue" });
		expect(fields.palette).toEqual([
			{ theme: "dark", accent: "blue" },
			{ theme: "dark", accent: "blue" },
		]);
	});
});

describe("buildContentIndex with bombed frontmatter", () => {
	test("publishes a note carrying a twelve-level alias bomb without hanging", async () => {
		await withVault({ "bomb.md": aliasBombFrontmatter(12) }, async (root) => {
			const started = performance.now();
			const index = await buildContentIndex(root);
			const elapsed = performance.now() - started;

			// ponytail: 2 s ceiling covers temp-dir stat/read; pre-fix this never
			// returns (9^12 copies, then OOM).
			expect(elapsed).toBeLessThan(2000);
			const page = index.byFilePathKey.get("bomb");
			if (!page) throw new Error("bombed page missing from the index");
			expect(page.dataviewFields.level11).toBeInstanceOf(Array);
			expect((page.dataviewFields.level11 as unknown[]).length).toBe(9);
		});
	});
});

describe("renderDataviewQuery against the fixture vault", () => {
	const fixtureRoot = path.resolve(process.cwd(), "test/markdown/fixtures/dataview");

	test("runs the indexed fixture through TABLE and TASK queries", async () => {
		const fixtureIndex = await buildContentIndex(fixtureRoot);
		const page = fixtureIndex.byFilePathKey.get("index");
		expect(page).toBeDefined();
		if (!page) return;

		const table = renderDataviewQuery(
			[
				"TABLE status, priority, file.name AS note",
				'FROM "notes"',
				'WHERE status = "open"',
				"SORT priority DESC",
				"LIMIT 2",
			].join("\n"),
			page,
			fixtureIndex,
		);
		expect(tableRows(table.html)).toEqual([
			["<th>File</th>", "<th>status</th>", "<th>priority</th>", "<th>note</th>"],
			[
				'<td><a href="/notes/alpha">Alpha</a></td>',
				"<td>open</td>",
				"<td>2</td>",
				"<td>alpha</td>",
			],
		]);

		const tasks = renderDataviewQuery(
			["TASK", 'FROM "notes"', "WHERE !completed"].join("\n"),
			page,
			fixtureIndex,
		);
		expect(tasks.html).toBe(
			'<ul class="dataview dataview-task-list">' +
				'<li><input type="checkbox" disabled /> Ship alpha</li>' +
				'<li><input type="checkbox" disabled /> Review beta</li>' +
				"</ul>",
		);

		const inline = renderDataviewInline("length(file.tasks)", page, fixtureIndex);
		expect(inline.html).toBe('<span class="dataview-inline">0</span>');
	});
});

// An `![[image.png]]` embed used to land in `wikilinkTargets`, and Dataview
// rendered it as `<a href="/pic.png">` — a link to a route the site never
// publishes. Attachments are not page links, so they must not reach outlinks.
test("file.outlinks omits an attachment embed", async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "obsidian-outlinks-"));
	try {
		writeFileSync(path.join(root, "a.md"), "# A\n\nEmbed ![[pic.png]] and page [[b]].\n");
		writeFileSync(path.join(root, "b.md"), "# B\n");
		writeFileSync(path.join(root, "pic.png"), "x");
		const index = await buildContentIndex(root);
		const a = index.pages.find((p) => p.filePathKey === "a");
		if (!a) throw new Error("page a missing from index");

		const html = renderDataviewQuery("LIST file.outlinks", a, index).html ?? "";

		expect(html).not.toContain("pic.png");
		expect(html).toContain('href="/b"');
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// A query rebuilt every page's values from scratch, so a vault with a fence
// on each of its N notes paid that work N times over: O(N²) `new Date`,
// `toISOString` and outlink resolutions, redone on every rebuild. Values are
// cached per page now, so further queries over the same index must not
// re-read a single page property. `fileCtimeMs` is read exactly once per
// construction, so it is the cheapest witness that the rebuild is gone.
test("further queries over the same index reuse page values instead of rebuilding them", () => {
	const indexed = makeIndex(pages);
	const first = indexed.pages[0];
	if (!first) throw new Error("fixture index has no pages");

	let reads = 0;
	const ctime = first.fileCtimeMs;
	Object.defineProperty(first, "fileCtimeMs", {
		get: () => {
			reads += 1;
			return ctime;
		},
		configurable: true,
	});

	renderDataviewQuery("LIST", first, indexed);
	const afterFirstQuery = reads;
	expect(afterFirstQuery).toBeGreaterThan(0);

	for (const query of ["LIST", "TABLE file.name", "LIST FROM #project/demo", "TASK"]) {
		renderDataviewQuery(query, first, indexed);
	}

	expect(reads).toBe(afterFirstQuery);
});
