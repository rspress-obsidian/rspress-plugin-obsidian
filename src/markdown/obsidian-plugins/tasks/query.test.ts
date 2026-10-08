/**
 * The query language, run over a small vault: every filter family, Boolean
 * combinations, sorting, grouping, limits, layout instructions, placeholders,
 * presets and `explain`, with "today" pinned to Wednesday 15 May 2024.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildContentIndex } from "../../content-index.ts";
import { parseIsoDay } from "./dates.ts";
import {
	continueLines,
	explainQuery,
	parseQuery,
	queryFileDefaults,
	runQuery,
	taskCountText,
} from "./query.ts";
import type { SearchInfo } from "./query-model.ts";
import { DEFAULT_STATUSES, type TaskStatus } from "./settings.ts";
import type { Task } from "./task.ts";
import { collectTasks } from "./task-index.ts";

const today = parseIsoDay("2024-05-15");

const NOTES: Record<string, string> = {
	"Inbox.md": `# Inbox
- [ ] Call Alice 📅 2024-05-14 ⏫ #call
- [ ] Email Bob 📅 2024-05-15 🔼 #email
- [ ] Plan trip ⏳ 2024-05-20 🛫 2024-05-18 ➕ 2024-05-01
- [x] Paid rent ✅ 2024-05-01 📅 2024-05-01
- [-] Old idea ❌ 2024-04-01
- [/] Writing report 🔽 📅 2024-06-30
- [ ] Bad date 📅 2024-02-30

## Errands
- [ ] Buy milk #shopping #home 🔁 every week 📅 2024-05-17
- [ ] Lowest thing ⏬
  - [ ] Child task 🆔 child1
- [ ] Blocked thing ⛔ child1 🔺
`,
	"Projects/Alpha.md": `# Alpha
1. [ ] Numbered task [due:: 2024-05-16] [priority:: highest]
* [ ] Dataview fields (scheduled:: 2024-05-10) [start:: 2024-05-09] [created:: 2024-05-01]
- [x] Done dataview [completion:: 2024-05-02] [id:: dv1]
> - [ ] Quoted task
`,
	"Projects/Beta/Deep_note.md": "- [?] Deep one 🏁 delete\n",
};

let root: string;
let allTasks: Task[];
const statuses = new Map<string, TaskStatus>(
	[
		...DEFAULT_STATUSES,
		{ symbol: "?", name: "Question", nextStatusSymbol: " ", type: "ON_HOLD" as const },
	].map((status) => [status.symbol, status]),
);

beforeAll(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-query-"));
	for (const [file, content] of Object.entries(NOTES)) {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		fs.writeFileSync(path.join(root, file), content);
	}
	allTasks = await collectTasks([await buildContentIndex(root)], { globalFilter: "", statuses });
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const info = (): SearchInfo => ({ allTasks, today, globalFilter: "" });
const context = {
	file: {
		path: "Projects/Alpha.md",
		properties: { Project: "Alpha", Tags: ["work", null], urgent: true, empty: null },
	},
	today,
	presets: {
		mine: "path includes Inbox\nnot done",
		this_folder_only: "filter by function task.file.folder === query.file.folder",
	},
};

function query(source: string) {
	const parsed = parseQuery(source, context);
	if (parsed.error) throw new Error(parsed.error);
	return parsed;
}

/** Task descriptions a query lists, in order. */
function run(source: string): string[] {
	return runQuery(query(source), info()).groups.flatMap((group) =>
		group.tasks.map((task) => task.description.replace(/ #.*$/, "")),
	);
}

function errorOf(source: string): string | undefined {
	return parseQuery(source, context).error;
}

function explain(source: string): string {
	return explainQuery(parseQuery(source, context), "  ");
}

describe("status filters", () => {
	test("done and not done follow the status type", () => {
		expect(run("done").sort()).toEqual(["Done dataview", "Old idea", "Paid rent"]);
		expect(run("not done")).toContain("Deep one");
		expect(run("not done")).not.toContain("Old idea");
	});

	test("status.type and status.name", () => {
		expect(run("status.type is IN_PROGRESS")).toEqual(["Writing report"]);
		expect(run("status.type is not todo")).toHaveLength(5);
		expect(run("status.name includes question")).toEqual(["Deep one"]);
		expect(errorOf("status.type is SOMETIMES")).toContain("Invalid status.type instruction");
	});
});

describe("date filters", () => {
	test("before, after, on, on or before and on or after", () => {
		expect(run("due before 2024-05-15")).toEqual(["Call Alice", "Paid rent"]);
		expect(run("due after 2024-06-01")).toEqual(["Writing report"]);
		expect(run("due on 2024-05-15")).toEqual(["Email Bob"]);
		expect(run("due 2024-05-15")).toEqual(["Email Bob"]);
		expect(run("due on or before 2024-05-14")).toEqual(["Call Alice", "Paid rent"]);
		expect(run("due on or after 2024-05-17")).toEqual(["Writing report", "Buy milk"]);
		expect(run("due in or before 2024-05")).toHaveLength(5);
		expect(run("due in or after 2024-05")).toHaveLength(6);
	});

	test("relative dates and ranges resolve against the pinned today", () => {
		expect(run("due today")).toEqual(["Email Bob"]);
		expect(run("due before tomorrow")).toEqual(["Call Alice", "Email Bob", "Paid rent"]);
		expect(run("due this week")).toEqual(["Numbered task", "Call Alice", "Email Bob", "Buy milk"]);
		expect(run("due in 2024-05-16 2024-05-17")).toEqual(["Numbered task", "Buy milk"]);
		expect(run("happens next week")).toEqual(["Plan trip"]);
		expect(run("scheduled last week")).toEqual(["Dataview fields"]);
		expect(run("created on 2024-05-01")).toEqual(["Dataview fields", "Plan trip"]);
		expect(run("done in 2024-05")).toEqual(["Paid rent", "Done dataview"]);
		expect(run("cancelled before this month")).toEqual(["Old idea"]);
	});

	test("starts filters also match tasks with no start date", () => {
		expect(run("starts after 2024-05-17")).not.toContain("Dataview fields");
		expect(run("starts after 2024-05-17")).toContain("Call Alice");
		expect(run("starts before 2024-05-10")).toContain("Dataview fields");
	});

	test("has, no and invalid dates", () => {
		expect(run("has start date")).toEqual(["Dataview fields", "Plan trip"]);
		expect(run("no due date")).toHaveLength(9);
		expect(run("due date is invalid")).toEqual(["Bad date"]);
		expect(run("has happens date")).toHaveLength(9);
		expect(run("no happens date")).toHaveLength(7);
	});

	test("an unreadable date is an error", () => {
		expect(errorOf("due before someday soon")).toContain("do not understand due date");
	});
});

describe("text filters", () => {
	test("includes and does not include are case-insensitive", () => {
		expect(run("description includes EMAIL")).toEqual(["Email Bob"]);
		expect(run("path includes projects/beta")).toEqual(["Deep one"]);
		expect(run("path does not include Projects")).toHaveLength(11);
		expect(run("folder includes Projects/Beta/")).toEqual(["Deep one"]);
		expect(run("root includes Projects/")).toHaveLength(5);
		expect(run("filename includes deep_note.md")).toEqual(["Deep one"]);
		expect(run("heading includes errands")).toEqual([
			"Buy milk",
			"Blocked thing",
			"Child task",
			"Lowest thing",
		]);
	});

	test("regular expressions, with and without flags", () => {
		expect(run("description regex matches /^[CE]/")).toEqual([
			"Call Alice",
			"Email Bob",
			"Child task",
		]);
		expect(run("description regex does not match /a/i")).toEqual([
			"Writing report",
			"Buy milk",
			"Blocked thing",
			"Lowest thing",
			"Deep one",
		]);
		expect(errorOf("description regex matches nope")).toContain(
			"Regular expressions must look like this",
		);
		expect(errorOf("description regex matches /(/")).toContain("Parsing regular expression");
		expect(errorOf("description regex matches /(a+)+$/")).toContain("catastrophic backtracking");
	});

	test("tags, recurrence and ids", () => {
		expect(run("tags include #home")).toEqual(["Buy milk"]);
		expect(run("tag includes #c")).toEqual(["Call Alice"]);
		expect(run("tags do not include #call")).toHaveLength(15);
		expect(run("has tags")).toHaveLength(3);
		expect(run("no tag")).toHaveLength(13);
		expect(run("recurrence includes week")).toEqual(["Buy milk"]);
		expect(run("id includes child")).toEqual(["Child task"]);
		expect(run("has id")).toEqual(["Child task", "Done dataview"]);
		expect(run("no id")).toHaveLength(14);
	});
});

describe("other filters", () => {
	test("priority levels", () => {
		expect(run("priority is highest")).toEqual(["Numbered task", "Blocked thing"]);
		expect(run("priority is above medium")).toEqual([
			"Numbered task",
			"Call Alice",
			"Blocked thing",
		]);
		expect(run("priority below none")).toEqual(["Writing report", "Lowest thing"]);
		expect(run("priority is not none")).toHaveLength(6);
		expect(run("priority is none")).toHaveLength(10);
	});

	test("recurring, sub-items and dependencies", () => {
		expect(run("is recurring")).toEqual(["Buy milk"]);
		expect(run("is not recurring")).toHaveLength(15);
		expect(run("exclude sub-items")).not.toContain("Child task");
		expect(run("exclude sub-items")).toContain("Quoted task");
		expect(run("is blocked")).toEqual(["Blocked thing"]);
		expect(run("is blocking")).toEqual(["Child task"]);
		expect(run("is not blocked")).toHaveLength(15);
		expect(run("is not blocking")).toHaveLength(15);
		expect(run("has depends on")).toEqual(["Blocked thing"]);
		expect(run("no depends on")).toHaveLength(15);
	});

	test("JavaScript instructions are refused, never run", () => {
		expect(errorOf("filter by function task.urgency > 1")).toContain(
			"JavaScript in queries is not run",
		);
		expect(errorOf("sort by function task.description.length")).toContain(
			"JavaScript in queries is not run",
		);
		expect(errorOf("group by function task.file.folder")).toContain(
			"JavaScript in queries is not run",
		);
		expect(errorOf("preset this_folder_only")).toContain("JavaScript in queries is not run");
	});

	test("an unknown instruction names the problem line", () => {
		expect(errorOf("not done\nfrobnicate")).toBe(
			'do not understand query\nProblem line: "frobnicate"',
		);
		expect(errorOf("hide everything")).toContain("do not understand hide/show option");
	});
});

describe("Boolean combinations", () => {
	test("AND, OR, NOT, XOR with Tasks' precedence", () => {
		expect(run("(tag includes #call) OR (tag includes #email)")).toEqual([
			"Call Alice",
			"Email Bob",
		]);
		expect(run("(has due date) AND NOT (due before 2024-06-01)")).toEqual([
			"Writing report",
			"Bad date",
		]);
		expect(run("NOT (has due date)")).toHaveLength(9);
		expect(run("(is recurring) XOR (tag includes #home)")).toEqual([]);
		expect(run("(is recurring) XOR (tag includes #call)")).toEqual(["Call Alice", "Buy milk"]);
		expect(run("(due today) OR (is recurring) AND (tag includes #nope)")).toEqual(["Email Bob"]);
	});

	test("every delimiter pair works, and filters nest", () => {
		expect(run('"tag includes #call" OR "tag includes #email"')).toEqual([
			"Call Alice",
			"Email Bob",
		]);
		expect(run("[tag includes #call] OR [tag includes #email]")).toEqual([
			"Call Alice",
			"Email Bob",
		]);
		expect(run("{tag includes #call} OR {tag includes #email}")).toEqual([
			"Call Alice",
			"Email Bob",
		]);
		expect(run("( (done) OR (is recurring) ) AND (path includes Inbox)")).toEqual([
			"Buy milk",
			"Paid rent",
			"Old idea",
		]);
	});

	test("malformed combinations explain themselves", () => {
		expect(errorOf("(done) AND [not done]")).toContain("must be inside one of these pairs");
		const bad = errorOf("(done) AND (frobnicate)");
		expect(bad).toContain("couldn't parse sub-expression 'frobnicate'");
		expect(bad).toContain(
			"'f2': 'frobnicate'\n        => ERROR:\n           do not understand query",
		);
		expect(errorOf("(due before someday soon) OR (done)")).toContain(
			"=> ERROR:\n           do not understand due date",
		);
		expect(errorOf("(done) AND ((not done)")).toContain(
			"malformed boolean query -- missing closing delimiter",
		);
		expect(errorOf("(done) OR (not done")).toContain("must be inside one of these pairs");
	});
});

describe("sorting", () => {
	test("by date, priority, description and path, with reverse", () => {
		expect(run("has due date\nsort by due reverse")).toEqual([
			"Writing report",
			"Buy milk",
			"Numbered task",
			"Email Bob",
			"Call Alice",
			"Paid rent",
			"Bad date",
		]);
		expect(run("path includes Alpha\nsort by priority")).toEqual([
			"Numbered task",
			"Dataview fields",
			"Quoted task",
			"Done dataview",
		]);
		expect(run("heading includes Errands\nsort by description")).toEqual([
			"Blocked thing",
			"Buy milk",
			"Child task",
			"Lowest thing",
		]);
		expect(run("not done\nsort by path reverse\nlimit 1")).toEqual(["Deep one"]);
	});

	test("by status, recurrence, tags, ids, headings, filename and urgency", () => {
		expect(run("path includes Alpha\nsort by status")).toEqual([
			"Numbered task",
			"Dataview fields",
			"Quoted task",
			"Done dataview",
		]);
		expect(run("heading includes Errands\nsort by recurring\nlimit 1")).toEqual(["Buy milk"]);
		expect(run("has tags\nsort by tag reverse")).toEqual(["Buy milk", "Email Bob", "Call Alice"]);
		expect(run("has tags\nsort by tag 2")).toEqual(["Buy milk", "Call Alice", "Email Bob"]);
		expect(run("has id\nsort by id reverse")).toEqual(["Done dataview", "Child task"]);
		expect(run("not done\nsort by heading\nlimit 2")).toEqual(["Deep one", "Numbered task"]);
		expect(run("not done\nsort by filename reverse\nlimit 1")).toEqual(["Writing report"]);
		expect(run("not done\nsort by urgency\nlimit 3")).toEqual([
			"Numbered task",
			"Call Alice",
			"Email Bob",
		]);
		expect(run("not done\nsort by status.type\nsort by status.name\nlimit 2")).toEqual([
			"Writing report",
			"Numbered task",
		]);
		expect(run("has start date\nsort by start reverse")).toEqual(["Plan trip", "Dataview fields"]);
	});
});

describe("grouping", () => {
	function groups(source: string): string[][] {
		return runQuery(query(source), info()).groups.map((group) => [
			...group.headings.map((heading) => `${"#".repeat(heading.level + 1)} ${heading.name}`),
			...group.tasks.map((task) => task.description.replace(/ #.*$/, "")),
		]);
	}

	test("by status, priority and date, with Tasks' hidden sort prefixes", () => {
		expect(groups("path includes Alpha\ngroup by status")).toEqual([
			["# Done", "Done dataview"],
			["# Todo", "Numbered task", "Dataview fields", "Quoted task"],
		]);
		expect(groups("path includes Alpha\ngroup by priority")[0]).toEqual([
			"# %%0%%Highest priority",
			"Numbered task",
		]);
		expect(groups("path includes Inbox\nhas due date\ngroup by due reverse")[0]).toEqual([
			"# 2024-06-30 Sunday",
			"Writing report",
		]);
		expect(groups("description includes bad\ngroup by due")).toEqual([
			["# %%0%% Invalid due date", "Bad date"],
		]);
		expect(groups("description includes deep\ngroup by status.type\ngroup by status.name")).toEqual(
			[["# %%3%%ON_HOLD", "## Question", "Deep one"]],
		);
		expect(groups("description includes deep\ngroup by scheduled")).toEqual([
			["# No scheduled date", "Deep one"],
		]);
	});

	test("nested groups print only the headings that change", () => {
		expect(groups("path includes Alpha\nnot done\ngroup by folder\ngroup by filename")).toEqual([
			["# Projects/", "## [[Alpha]]", "Numbered task", "Dataview fields", "Quoted task"],
		]);
		expect(groups("not done\ngroup by root\ngroup by path\nlimit groups 1")).toEqual([
			["# /", "## Inbox", "Writing report"],
			["# Projects/", "## Projects/Alpha", "Numbered task"],
			["## Projects/Beta/Deep\\_note", "Deep one"],
		]);
	});

	test("a task with several tags joins each tag's group", () => {
		expect(groups("has tags\ngroup by tags")).toEqual([
			["# #call", "Call Alice"],
			["# #email", "Email Bob"],
			["# #home", "Buy milk"],
			["# #shopping", "Buy milk"],
		]);
		expect(groups("description includes deep\ngroup by tags")).toEqual([
			["# (No tags)", "Deep one"],
		]);
	});

	test("backlinks, headings, recurrence, ids and urgency", () => {
		expect(groups("description includes milk\ngroup by backlink")).toEqual([
			["# [[Inbox#Errands|Inbox > Errands]]", "Buy milk"],
		]);
		expect(groups("description includes deep\ngroup by backlink\ngroup by heading")).toEqual([
			["# [[Deep_note]]", "## (No heading)", "Deep one"],
		]);
		expect(groups("heading includes errands\ngroup by recurring\ngroup by recurrence")[0]).toEqual([
			"# Not Recurring",
			"## None",
			"Blocked thing",
			"Child task",
			"Lowest thing",
		]);
		expect(groups("has id\ngroup by id")).toEqual([
			["# child1", "Child task"],
			["# dv1", "Done dataview"],
		]);
		expect(groups("description includes blocked\ngroup by urgency")).toEqual([
			["# 9.00", "Blocked thing"],
		]);
		expect(groups("tag includes #c\ngroup by happens")).toEqual([
			["# 2024-05-14 Tuesday", "Call Alice"],
		]);
	});
});

describe("limits and counts", () => {
	test("limit cuts the list; limit groups cuts each group", () => {
		const limited = runQuery(query("not done\nlimit to 2 tasks"), info());
		expect(limited.count).toBe(2);
		expect(taskCountText(limited.count, limited.countBeforeLimit)).toBe("2 of 13 tasks");
		const grouped = runQuery(query("not done\ngroup by root\nlimit groups to 1 task"), info());
		expect(taskCountText(grouped.count, grouped.countBeforeLimit)).toBe("2 of 13 tasks");
		expect(taskCountText(1, 1)).toBe("1 task");
		// Without grouping, `limit groups` changes nothing.
		expect(runQuery(query("not done\nlimit groups 1"), info()).count).toBe(13);
	});
});

describe("layout instructions", () => {
	test("hide and show toggle fields and query elements", () => {
		const { layout } = query(
			"hide due date\nhide priority\nshow urgency\nhide backlinks\nhide task count\nshow tree\nhide tags\nshow group count\nhide edit button\nshort mode",
		);
		expect(layout.hidden).toEqual({ dueDate: true, priority: true });
		expect(layout.hideUrgency).toBe(false);
		expect(layout.hideBacklinks).toBe(true);
		expect(layout.hideTaskCount).toBe(true);
		expect(layout.hideTree).toBe(false);
		expect(layout.hideTags).toBe(true);
		expect(layout.hideGroupCount).toBe(false);
		expect(layout.shortMode).toBe(true);
		expect(query("hide due date\nshow due date\nshort mode\nfull mode").layout).toMatchObject({
			hidden: {},
			shortMode: false,
		});
	});

	test("view columns groups first by its field; view list undoes it", () => {
		const columns = query(
			"not done\nview columns by priority reverse\ngroup by heading\nlimit groups 1",
		);
		expect(columns.columns?.property).toBe("priority");
		const result = runQuery(columns, info());
		expect(result.groups[0]?.headings.map((heading) => heading.name)).toEqual([
			"%%5%%Lowest priority",
			"Errands",
		]);
		expect(result.groups.every((group) => group.tasks.length === 1)).toBe(true);
		expect(query("view columns by due\nview list").columns).toBeUndefined();
		expect(explain("view columns by due")).toContain("  view columns by due\n");
		expect(errorOf("view columns")).toContain("columns view requires a grouping expression");
		expect(errorOf("view columns by nothing")).toContain(
			'do not understand columns grouping "by nothing"',
		);
		expect(errorOf("view columns by function task.due")).toContain(
			"do not understand columns grouping",
		);
		expect(errorOf("view board")).toContain('do not understand view mode "board"');
		expect(errorOf("view list please")).toContain('do not understand view mode "list please"');
	});

	test("comments are ignored and `\\` continues a line", () => {
		expect(run("# only the errands\nheading includes \\\n   errands\nis recurring")).toEqual([
			"Buy milk",
		]);
		expect(continueLines("a \\\n  b\nc\\\\\n\n  \nd")).toEqual([
			{ raw: "a \\\n  b", continued: "a b", expanded: "a b" },
			{ raw: "c\\\\", continued: "c\\", expanded: "c\\" },
			{ raw: "d", continued: "d", expanded: "d" },
		]);
	});
});

describe("placeholders and presets", () => {
	test("query.file placeholders name the note holding the query", () => {
		expect(run("path includes {{query.file.path}}\nnot done")).toEqual([
			"Numbered task",
			"Dataview fields",
			"Quoted task",
		]);
		expect(run("filename includes {{ query.file.filename }}")).toHaveLength(4);
		expect(
			run("folder includes {{query.file.folder}}\nroot includes {{query.file.root}}"),
		).toHaveLength(5);
		expect(run("description includes {{query.file.filenameWithoutExtension}}")).toEqual([]);
		expect(run("path includes {{query.file.pathWithoutExtension}}")).toHaveLength(4);
		expect(errorOf("path includes {{query.file.nonsense}}")).toContain(
			"Unknown property: query.file.nonsense",
		);
		// A comment is never expanded, so an unknown placeholder there is harmless.
		expect(errorOf("# {{query.file.nonsense}}")).toBeUndefined();
	});

	test("a Mustache comment inside an instruction is dropped, as Tasks' docs show", () => {
		expect(run("not done\nshort mode {{! This comment will be ignored }}")).toEqual(
			run("not done"),
		);
		expect(query("short mode {{! This comment will be ignored }}").layout.shortMode).toBe(true);
	});

	test("root-level notes have / as their folder and root", () => {
		const atRoot = { ...context, file: { path: "Inbox.md", properties: {} } };
		const parsed = parseQuery(
			"folder includes {{query.file.folder}}\nroot includes {{query.file.root}}",
			atRoot,
		);
		expect(runQuery(parsed, info()).count).toBe(16);
	});

	test("query.file.property and hasProperty read the note's frontmatter, ignoring case", () => {
		expect(run("path includes {{query.file.property('project')}}")).toHaveLength(4);
		expect(
			parseQuery('description includes {{query.file.property("tags")}}', context).filters[0]
				?.statement.expanded,
		).toBe('description includes ["work"]');
		expect(
			parseQuery("description includes {{query.file.property('urgent')}}", context).filters[0]
				?.statement.expanded,
		).toBe("description includes true");
		expect(
			parseQuery("description includes {{query.file.hasProperty('empty')}}", context).filters[0]
				?.statement.expanded,
		).toBe("description includes false");
		expect(errorOf("path includes {{query.file.property('missing')}}")).toContain(
			"Invalid placeholder result 'null'",
		);
		expect(errorOf("path includes {{query.file.property(missing)}}")).toContain("Unknown property");
	});

	test("TQ_ properties become instructions before the block's own", () => {
		const file = {
			path: "Note.md",
			properties: {
				TQ_explain: true,
				tq_short_mode: false,
				TQ_show_tree: true,
				TQ_show_due_date: false,
				TQ_show_backlink: true,
				TQ_extra_instructions: "not done\nlimit 3",
				TQ_show_toolbar: null,
				TQ_show_urgency: "",
			},
		};
		expect(queryFileDefaults(file)).toBe(
			"explain\nfull mode\nshow tree\nhide due date\nhide urgency\nshow backlink\nnot done\nlimit 3",
		);
		expect(queryFileDefaults({ path: "Note.md", properties: { TQ_extra_instructions: 5 } })).toBe(
			"",
		);
		expect(queryFileDefaults({ path: "Note.md", properties: {} })).toBe("");
	});

	test("presets expand to their instructions; unknown ones list what exists", () => {
		expect(run("preset mine\nsort by description\nlimit 2")).toEqual(["Bad date", "Blocked thing"]);
		const unknown = errorOf("preset nope");
		expect(unknown).toContain('Cannot find preset "nope" in the Tasks settings');
		expect(unknown).toContain("mine            : path includes Inbox...");
	});
});

describe("random order", () => {
	test("is stable for a day and changes with it", () => {
		const first = run("not done\nsort by random");
		expect(run("not done\nsort by random")).toEqual(first);
		expect([...first].sort()).toEqual([...run("not done")].sort());
		const nextDay = runQuery(query("not done\nsort by random"), {
			...info(),
			today: today + 1,
		}).groups.flatMap((group) => group.tasks.map((task) => task.description.replace(/ #.*$/, "")));
		expect(nextDay).not.toEqual(first);
	});
});

describe("explain", () => {
	test("dates are spelled out and missing-date behaviour is stated", () => {
		expect(
			explain("starts after 2 years ago\nscheduled after 1 week ago\ndue before tomorrow"),
		).toBe(
			`  starts after 2 years ago =>
    start date is after 2022-05-15 (Sunday 15th May 2022) OR no start date

  scheduled after 1 week ago =>
    scheduled date is after 2024-05-08 (Wednesday 8th May 2024)

  due before tomorrow =>
    due date is before 2024-05-16 (Thursday 16th May 2024)
`,
		);
		expect(explain("due next week")).toBe(`  due next week =>
    due date is between:
      2024-05-20 (Monday 20th May 2024) and
      2024-05-26 (Sunday 26th May 2024) inclusive
`);
		expect(explain("starts this week")).toContain("OR no start date\n");
		expect(explain("due in or before 2024-05")).toContain("due date is on or before 2024-05-31");
		expect(explain("due in or after 2024-05")).toContain("due date is on or after 2024-05-01");
		expect(explain("done on or after 2024-05-01")).toContain("done date is on or after 2024-05-01");
		expect(explain("due on or before 2024-05-01")).toContain("due date is on or before 2024-05-01");
		expect(explain("happens after 2024-05-01")).toContain("due, start or scheduled date is after");
	});

	test("Boolean logic, regexes, status filters and layout are listed", () => {
		expect(explain("not done\n(due before tomorrow) AND (is recurring)")).toBe(`  not done =>
    status type is TODO or IN_PROGRESS or ON_HOLD

  (due before tomorrow) AND (is recurring) =>
    AND (All of):
      due before tomorrow =>
        due date is before 2024-05-16 (Thursday 16th May 2024)
      is recurring
`);
		expect(explain("(done) OR (is recurring) OR (has id)")).toContain(
			"OR (At least one of):\n      done =>",
		);
		expect(explain("NOT (done)")).toContain("NOT:\n      done =>");
		expect(explain("(done) XOR (has id)")).toContain("XOR (Exactly one of):");
		expect(explain("path regex matches /^Root/Sub-Folder/Sample File\\.md/i")).toBe(
			"  path regex matches /^Root/Sub-Folder/Sample File\\.md/i =>\n    using regex:     '^Root\\/Sub-Folder\\/Sample File\\.md' with flag 'i'\n",
		);
		expect(explain("description regex matches /x/gi")).toContain("with flags 'gi'");
		expect(explain("description regex matches /x/")).toContain("with no flags");
		expect(explain("priority is high")).toBe("  priority is high\n");
		expect(
			explain(
				"ignore global query\ngroup by due\nsort by urgency\nhide due date\nlimit 5\nlimit groups 1",
			),
		).toBe(
			`  ignore global query

  No filters supplied. All tasks will match the query.

  group by due

  sort by urgency

  hide due date

  At most 5 tasks.

  At most 1 task per group (if any "group by" options are supplied).
`,
		);
		expect(explain("frobnicate")).toBe(
			'Query has an error:\ndo not understand query\nProblem line: "frobnicate"\n',
		);
	});

	test("continuations and placeholders show each step", () => {
		expect(explain("path includes \\\n  {{query.file.path}}")).toBe(
			"  path includes \\\n    {{query.file.path}}\n   =>\n  path includes {{query.file.path}} =>\n  path includes Projects/Alpha.md\n",
		);
		expect(errorOf("path includes \\\n  {{query.file.path}}\nnope")).toBe(
			'do not understand query\nProblem line: "nope"',
		);
		expect(errorOf("description includes \\\n x\nhas due date\ndue before \\\n whenever")).toBe(
			"do not understand due date\nProblem statement:\n    due before \\\n     whenever\n     =>\n    due before whenever\n",
		);
	});
});

describe("escape vectors", () => {
	test("placeholders reach only the query file's own values, never Object's prototype", () => {
		for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
			expect(errorOf(`description includes {{query.file.${name}}}`), name).toContain(
				`Unknown property: query.file.${name}`,
			);
		}
		expect(query("path includes {{query.file.filename}}").filters[0]?.statement.expanded).toBe(
			"path includes Alpha.md",
		);
	});

	test("a preset name reaches only defined presets", () => {
		for (const name of ["constructor", "toString", "__proto__", "valueOf"]) {
			expect(errorOf(`preset ${name}`), name).toContain(`Cannot find preset "${name}"`);
		}
	});

	test("a failing placeholder inside a preset is the query's error, not a thrown one", () => {
		const presets = { broken: "path includes {{query.file.property('missing')}}" };
		expect(parseQuery("preset broken", { ...context, presets }).error).toContain(
			"Invalid placeholder result 'null'",
		);
	});
});

describe("denial of service", () => {
	test("presets that fan out into millions of lines stop with an error", () => {
		const presets: Record<string, string> = { p0: "not done" };
		for (let level = 1; level <= 10; level += 1) {
			presets[`p${level}`] = Array(8)
				.fill(`preset p${level - 1}`)
				.join("\n");
		}
		expect(parseQuery("preset p10", { ...context, presets }).error).toContain(
			"The presets expand to more than 10000 instructions. Obsidian would keep expanding them, but a site build must finish.",
		);
		expect(parseQuery("preset p3", { ...context, presets }).filters).toHaveLength(512);
	});

	test("Boolean combinations nested or chained past the stack bound are errors", () => {
		const nested = `${"NOT (".repeat(150)}done${")".repeat(150)}`;
		expect(errorOf(nested)).toContain(
			"the combination nests more than 100 levels deep, which Obsidian would evaluate but a site build does not",
		);
		const nestedOk = `${"NOT (".repeat(50)}done${")".repeat(50)}`;
		expect(errorOf(nestedOk)).toBeUndefined();
		const chained = Array(1001).fill("(done)").join(" OR ");
		expect(errorOf(chained)).toContain(
			"The combination has 1001 filters, more than the 1000 a site build evaluates; Obsidian would evaluate it.",
		);
		expect(run(Array(200).fill("(done)").join(" OR ")).sort()).toEqual(run("done").sort());
	});

	test("an unsafe regex is refused with Tasks' regex error, saying Obsidian would run it", () => {
		for (const field of ["description", "path", "heading", "tags"]) {
			const error = errorOf(`${field} regex matches /(\\w+\\s?)+$/`);
			expect(error, field).toContain("Error: Parsing regular expression.");
			expect(error, field).toContain(
				"uses nested quantifiers (possible catastrophic backtracking detected); Obsidian would run it",
			);
		}
		expect(errorOf(`description regex matches /${"a".repeat(1001)}/`)).toContain(
			"pattern is too long (1001 characters, limit 1000)",
		);
	});
});
