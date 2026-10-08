/**
 * Reading tasks out of notes — both task formats, statuses, the global
 * filter, list trees, the places tasks never live — and the settings that
 * decide how they are read.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizePluginOptions } from "../../normalize-options.ts";
import type { ContentPage } from "../../types.ts";
import { isoDay, parseIsoDay } from "./dates.ts";
import type { FilenameDates } from "./settings.ts";
import { DEFAULT_STATUSES, readStatus, resolveTasksSettings, type TaskStatus } from "./settings.ts";
import { isBlocked, isBlocking, recurrenceText, type Task, urgencyOf } from "./task.ts";
import { filenameDate, parseNoteTasks } from "./task-index.ts";

const page = { absolutePath: "/vault/Note.md" } as ContentPage;
const defaults = new Map<string, TaskStatus>(
	DEFAULT_STATUSES.map((status) => [status.symbol, status]),
);

function tasksIn(source: string, globalFilter = "", statuses = defaults): Task[] {
	return parseNoteTasks(source, { page, path: "Note.md" }, { globalFilter, statuses });
}

function only(source: string): Task {
	const [task] = tasksIn(source);
	if (!task) throw new Error(`no task in ${source}`);
	return task;
}

describe("the emoji format", () => {
	test("every signifier is read off the end of the line", () => {
		const task = only(
			"- [ ] Ship it #release ⏫ 🔁 every week on Monday 🏁 delete ➕ 2024-05-01 🛫 2024-05-02 ⏳ 2024-05-03 📅 2024-05-04 ❌ 2024-05-06 ✅ 2024-05-05 🆔 ship-1 ⛔ a, b,c ^block-1",
		);
		expect(task.description).toBe("Ship it #release");
		expect(task.priority).toBe(1);
		expect(task.recurrence).toBe("every week on Monday");
		expect(task.onCompletion).toBe("delete");
		expect(
			Object.fromEntries(Object.entries(task.dates).map(([key, date]) => [key, date?.text])),
		).toEqual({
			created: "2024-05-01",
			start: "2024-05-02",
			scheduled: "2024-05-03",
			due: "2024-05-04",
			cancelled: "2024-05-06",
			done: "2024-05-05",
		});
		expect(task.id).toBe("ship-1");
		expect(task.dependsOn).toEqual(["a", "b", "c"]);
		expect(task.blockLink).toBe(" ^block-1");
		expect(task.tags).toEqual(["#release"]);
	});

	test("alternative emoji and trailing tags between signifiers", () => {
		const task = only("- [ ] Pay 📆 2024-05-04 #money ⌛ 2024-05-03 🔺");
		expect(task.description).toBe("Pay #money");
		expect(task.dates.due?.text).toBe("2024-05-04");
		expect(task.dates.scheduled?.text).toBe("2024-05-03");
		expect(task.priority).toBe(0);
		expect(only("- [ ] Low 🔽").priority).toBe(4);
		expect(only("- [ ] Lowest ⏬").priority).toBe(5);
		expect(only("- [ ] Medium 🔼").priority).toBe(2);
		expect(only("- [ ] Plain").priority).toBe(3);
	});

	test("a signifier in the middle of the description stays text", () => {
		const task = only("- [ ] Due 📅 2024-05-04 is not the end");
		expect(task.dates.due).toBeUndefined();
		expect(task.description).toBe("Due 📅 2024-05-04 is not the end");
	});

	test("an impossible date is kept as invalid; a non-rule recurrence is dropped", () => {
		const task = only("- [ ] Leap 📅 2023-02-29 🔁 sometimes");
		expect(task.dates.due?.text).toBe("2023-02-29");
		expect(Number.isNaN(task.dates.due?.day)).toBe(true);
		expect(task.recurrence).toBe("");
	});

	test("recurrence is read by rrule and restated the way Tasks shows it", () => {
		expect(only("- [ ] x 🔁 every Monday").recurrence).toBe("every week on Monday");
		expect(only("- [ ] x 🔁 every 2 days when done").recurrence).toBe("every 2 days when done");
		expect(only("- [ ] x [repeat:: every month on the 31st]").recurrence).toBe(
			"every month on the 31st",
		);
		// rrule cannot read these: the rule is dropped and the task does not recur.
		const banana = only("- [ ] Peel 🔁 every banana");
		expect(banana.recurrence).toBe("");
		expect(banana.description).toBe("Peel");
		expect(recurrenceText("every")).toBe("");
		expect(recurrenceText("")).toBe("");
	});
});

describe("the Dataview format", () => {
	test("bracketed and parenthesised fields", () => {
		const task = only(
			"- [ ] Write [priority:: high] (due:: 2024-05-04) [scheduled:: 2024-05-03] [start:: 2024-05-02] [created:: 2024-05-01] [repeat:: every day] [onCompletion:: keep] [id:: w1] [dependsOn:: x,y] [cancelled:: 2024-05-06] [completion:: 2024-05-05]",
		);
		expect(task.description).toBe("Write");
		expect(task.priority).toBe(1);
		expect(task.dates.due?.text).toBe("2024-05-04");
		expect(task.dates.scheduled?.text).toBe("2024-05-03");
		expect(task.dates.start?.text).toBe("2024-05-02");
		expect(task.dates.created?.text).toBe("2024-05-01");
		expect(task.dates.cancelled?.text).toBe("2024-05-06");
		expect(task.dates.done?.text).toBe("2024-05-05");
		expect(task.recurrence).toBe("every day");
		expect(task.onCompletion).toBe("keep");
		expect(task.id).toBe("w1");
		expect(task.dependsOn).toEqual(["x", "y"]);
		for (const [level, priority] of [
			["highest", 0],
			["medium", 2],
			["low", 4],
			["lowest", 5],
		] as const) {
			expect(only(`- [ ] P [priority:: ${level}]`).priority).toBe(priority);
		}
	});
});

describe("statuses", () => {
	test("known symbols name their status; unknown ones are a TODO named Unknown", () => {
		const [todo, done, progress, cancelled, unknown] = tasksIn(
			"- [ ] a\n- [x] b\n- [/] c\n- [-] d\n- [!] e",
		);
		expect(todo?.status.name).toBe("Todo");
		expect(done?.status.type).toBe("DONE");
		expect(progress?.status.type).toBe("IN_PROGRESS");
		expect(cancelled?.status.type).toBe("CANCELLED");
		expect(unknown?.status).toEqual({
			symbol: "!",
			name: "Unknown",
			nextStatusSymbol: "x",
			type: "TODO",
		});
	});

	test("status settings entries are validated", () => {
		expect(readStatus({ symbol: "?", name: "Question", type: "non_task" })).toEqual({
			symbol: "?",
			name: "Question",
			nextStatusSymbol: "x",
			type: "NON_TASK",
		});
		expect(readStatus({ symbol: "?", name: "Q", nextStatusSymbol: " " })?.type).toBe("TODO");
		expect(readStatus({ symbol: "?", name: "Q", type: "EMPTY" })).toBeUndefined();
		expect(readStatus({ symbol: "?", name: "Q", type: "MAYBE" })).toBeUndefined();
		expect(readStatus({ symbol: 1, name: "Q" })).toBeUndefined();
		expect(readStatus("x")).toBeUndefined();
		expect(readStatus(null)).toBeUndefined();
	});
});

describe("which lines are tasks", () => {
	test("bullets, numbers and blockquotes; code, comments and frontmatter hold none", () => {
		const source = [
			"---",
			"title: x",
			"- [ ] not in frontmatter",
			"---",
			"* [ ] star",
			"+ [x] plus",
			"3) [ ] numbered",
			"> - [ ] quoted",
			"```",
			"- [ ] in code",
			"```",
			"%% - [ ] in a comment %%",
			"- [ ] after %%hidden%% comment",
			"- plain item",
			"-[ ] not a task",
		].join("\r\n");
		expect(tasksIn(source).map((task) => task.description)).toEqual([
			"star",
			"plus",
			"numbered",
			"quoted",
			"after %%hidden%% comment",
		]);
	});

	test("the global filter decides; its tag is not one of the task's tags", () => {
		const tasks = tasksIn("- [ ] #task Ship #release\n- [ ] Not a task\n- [x] #task done", "#task");
		expect(tasks.map((task) => task.description)).toEqual(["#task Ship #release", "#task done"]);
		expect(tasks[0]?.tags).toEqual(["#release"]);
	});

	test("headings and list trees are recorded", () => {
		const tasks = tasksIn(
			[
				"- [ ] before any heading",
				"# One ##",
				"- [ ] parent",
				"\t- [ ] tab child",
				"    - plain child",
				"      continuation line",
				"        - [ ] grandchild",
				"",
				"- [ ] loose sibling",
				"Paragraph ends the list.",
				"  - [ ] indented after paragraph",
				"## Two",
				"- [ ] under two",
			].join("\n"),
		);
		const byName = Object.fromEntries(tasks.map((task) => [task.description, task]));
		expect(byName["before any heading"]?.heading).toBeUndefined();
		expect(byName.parent?.heading).toBe("One");
		expect(byName["tab child"]?.parent).toBe(byName.parent);
		const plain = byName.parent?.children[1];
		expect(plain?.kind).toBe("item");
		expect(plain?.kind === "item" && plain.description).toBe("plain child");
		expect(byName.grandchild?.parent).toBe(plain);
		expect(byName["loose sibling"]?.parent).toBeUndefined();
		expect(byName["indented after paragraph"]?.parent).toBeUndefined();
		expect(byName["under two"]?.heading).toBe("Two");
		expect(byName["under two"]?.line).toBe(12);
	});

	test("a checkbox the global filter excludes stays a plain item under its task", () => {
		const [task] = tasksIn("- [ ] #task parent\n  - [x] just a box", "#task");
		expect(task?.children[0]).toMatchObject({
			kind: "item",
			statusCharacter: "x",
			description: "just a box",
		});
	});
});

describe("urgency and dependencies", () => {
	const today = parseIsoDay("2024-05-15");

	test("urgency follows Tasks' coefficients", () => {
		expect(urgencyOf(only("- [ ] x"), today)).toBeCloseTo(1.95);
		expect(urgencyOf(only("- [ ] x 📅 2024-05-01 🔺"), today)).toBeCloseTo(21);
		expect(urgencyOf(only("- [ ] x 📅 2024-07-01 ⏬"), today)).toBeCloseTo(0.6);
		expect(urgencyOf(only("- [ ] x 📅 2024-05-15"), today)).toBeCloseTo(10.75, 2);
		expect(urgencyOf(only("- [ ] x ⏳ 2024-05-15 🛫 2024-05-16 🔽"), today)).toBeCloseTo(2);
		expect(urgencyOf(only("- [ ] x 📅 2023-02-29"), today)).toBeCloseTo(1.95);
	});

	test("done tasks never block or are blocked", () => {
		const tasks = tasksIn(
			"- [ ] a 🆔 a\n- [ ] b ⛔ a\n- [x] c ⛔ a\n- [x] d 🆔 d\n- [ ] e ⛔ d,zz",
		);
		const [a, b, c, d, e] = tasks as [Task, Task, Task, Task, Task];
		expect(isBlocking(a, tasks)).toBe(true);
		expect(isBlocked(b, tasks)).toBe(true);
		expect(isBlocked(c, tasks)).toBe(false);
		expect(isBlocking(d, tasks)).toBe(false);
		expect(isBlocked(e, tasks)).toBe(false);
		expect(isBlocking(b, tasks)).toBe(false);
	});
});

describe("settings", () => {
	let vault: string | undefined;
	afterEach(() => {
		if (vault) fs.rmSync(vault, { recursive: true, force: true });
		vault = undefined;
	});

	function vaultWith(data: unknown): string {
		vault = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-settings-"));
		const folder = path.join(vault, ".obsidian/plugins/obsidian-tasks-plugin");
		fs.mkdirSync(folder, { recursive: true });
		fs.writeFileSync(path.join(folder, "data.json"), JSON.stringify(data));
		return vault;
	}

	test("Tasks' defaults apply with no vault settings", () => {
		const settings = resolveTasksSettings(
			normalizePluginOptions({ enableTasks: true, tasks: { now: "2024-05-15" } }),
		);
		expect(settings.globalFilter).toBe("");
		expect(settings.removeGlobalFilter).toBe(false);
		expect([...settings.statuses.keys()]).toEqual([" ", "x", "/", "-"]);
		expect(settings.presets.this_file).toBe("path includes {{query.file.path}}");
		expect(settings.taskCountLocation).toBe("bottom");
		expect(isoDay(settings.today)).toBe("2024-05-15");
		expect(settings.problems).toEqual([]);
	});

	test("the vault's data.json is read, and site options win", () => {
		const root = vaultWith({
			globalFilter: "#task",
			removeGlobalFilter: true,
			globalQuery: "not done",
			presets: { mine: "is recurring", broken: 3 },
			searchResults: { taskCountLocation: "top" },
			statusSettings: {
				coreStatuses: [{ symbol: " ", name: "Open", nextStatusSymbol: "x", type: "TODO" }],
				customStatuses: [{ symbol: "?", name: "Question", type: "ON_HOLD" }, { name: "broken" }],
			},
		});
		const fromVault = resolveTasksSettings(
			normalizePluginOptions({ vaultRoot: root, enableTasks: true }),
		);
		expect(fromVault).toMatchObject({
			globalFilter: "#task",
			removeGlobalFilter: true,
			globalQuery: "not done",
			taskCountLocation: "top",
		});
		expect(fromVault.presets.mine).toBe("is recurring");
		expect(fromVault.presets.broken).toBeUndefined();
		expect([...fromVault.statuses.values()].map((status) => status.name)).toEqual([
			"Open",
			"Question",
		]);
		expect(fromVault.problems).toEqual([
			'Ignoring a task status in the vault\'s Tasks settings: {"name":"broken"}',
		]);

		const overridden = resolveTasksSettings(
			normalizePluginOptions({
				vaultRoot: root,
				enableTasks: true,
				tasks: {
					globalFilter: "",
					removeGlobalFilter: false,
					globalQuery: "",
					statuses: [
						{ symbol: "?", name: "Asked", type: "IN_PROGRESS" },
						{ symbol: "", name: "", type: "BOGUS" as "TODO" },
					],
					presets: { mine: "done" },
					now: "nonsense",
				},
			}),
		);
		expect(overridden).toMatchObject({
			globalFilter: "",
			removeGlobalFilter: false,
			globalQuery: "",
		});
		expect(overridden.statuses.get("?")?.name).toBe("Asked");
		expect(overridden.presets.mine).toBe("done");
		expect(overridden.problems).toEqual([
			'Ignoring a task status in the vault\'s Tasks settings: {"name":"broken"}',
			'Ignoring the task status option {"symbol":"","name":"","type":"BOGUS"}',
			'The `tasks.now` option "nonsense" is not a date; using today.',
		]);

		const ignored = resolveTasksSettings(
			normalizePluginOptions({
				vaultRoot: root,
				enableTasks: true,
				tasks: { readVaultSettings: false },
			}),
		);
		expect(ignored.globalFilter).toBe("");
	});

	test("a vault without status settings keeps Tasks' default statuses", () => {
		const root = vaultWith({ statusSettings: "odd" });
		expect(
			resolveTasksSettings(normalizePluginOptions({ vaultRoot: root, enableTasks: true })).statuses
				.size,
		).toBe(4);
	});

	test("filename dates come from the vault and site options win", () => {
		const root = vaultWith({
			useFilenameAsScheduledDate: true,
			filenameAsScheduledDateFormat: "DD-MM-YYYY",
			filenameAsDateFolders: ["Daily", 3],
		});
		expect(
			resolveTasksSettings(normalizePluginOptions({ vaultRoot: root, enableTasks: true }))
				.filenameDates,
		).toEqual({ folders: ["Daily"], format: "DD-MM-YYYY" });
		expect(
			resolveTasksSettings(
				normalizePluginOptions({
					vaultRoot: root,
					enableTasks: true,
					tasks: { filenameAsScheduledDateFormat: "", filenameAsDateFolders: [] },
				}),
			).filenameDates,
		).toEqual({ folders: [], format: "" });
		expect(
			resolveTasksSettings(
				normalizePluginOptions({
					vaultRoot: root,
					enableTasks: true,
					tasks: { useFilenameAsScheduledDate: false },
				}),
			).filenameDates,
		).toBeUndefined();
		expect(
			resolveTasksSettings(
				normalizePluginOptions({ enableTasks: true, tasks: { useFilenameAsScheduledDate: true } }),
			).filenameDates,
		).toEqual({ folders: [], format: "" });
	});
});

describe("filename as scheduled date", () => {
	const everywhere = { folders: [], format: "" };

	function inferred(filePath: string, source: string, filenameDates: FilenameDates | undefined) {
		return parseNoteTasks(
			source,
			{ page, path: filePath },
			{ globalFilter: "", statuses: defaults, filenameDates },
		).map((task) => [task.description, task.dates.scheduled?.text, task.scheduledInferred]);
	}

	test("undated tasks in a dated note take its date as an inferred scheduled date", () => {
		expect(
			inferred(
				"Daily/2024-05-15.md",
				"- [ ] undated\n- [ ] due 📅 2024-05-20\n- [ ] starts 🛫 2024-05-01\n- [ ] own ⏳ 2024-05-02",
				everywhere,
			),
		).toEqual([
			["undated", "2024-05-15", true],
			["due", undefined, false],
			["starts", undefined, false],
			["own", "2024-05-02", false],
		]);
	});

	test("the date may sit anywhere in the name, with or without dashes, or in the configured format", () => {
		expect(filenameDate("Journal 2024-05-15 notes.md", everywhere)).toBe(parseIsoDay("2024-05-15"));
		expect(filenameDate("20240515.md", everywhere)).toBe(parseIsoDay("2024-05-15"));
		expect(filenameDate("15.05.2024.md", { folders: [], format: "DD.MM.YYYY" })).toBe(
			parseIsoDay("2024-05-15"),
		);
		// The format is strict; a name it does not fit falls back to the built-in patterns.
		expect(filenameDate("2024-05-15.md", { folders: [], format: "DD.MM.YYYY" })).toBe(
			parseIsoDay("2024-05-15"),
		);
		expect(filenameDate("2024-02-30.md", everywhere)).toBeUndefined();
		expect(filenameDate("Ideas.md", everywhere)).toBeUndefined();
		expect(filenameDate("2024-05-15.md", undefined)).toBeUndefined();
	});

	test("listed folders limit where it applies", () => {
		const daily = { folders: ["Daily"], format: "" };
		expect(filenameDate("Daily/2024-05-15.md", daily)).toBe(parseIsoDay("2024-05-15"));
		expect(filenameDate("Daily/Sub/2024-05-15.md", daily)).toBe(parseIsoDay("2024-05-15"));
		expect(filenameDate("Other/2024-05-15.md", daily)).toBeUndefined();
		expect(filenameDate("DailyNotes/2024-05-15.md", daily)).toBeUndefined();
		expect(inferred("Other/2024-05-15.md", "- [ ] x", daily)).toEqual([["x", undefined, false]]);
	});
});
