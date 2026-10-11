import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	expandWithTp,
	INCLUDE_DEPTH_LIMIT,
	RUN_MODE,
	sliceSubpath,
	type TemplaterHost,
	VaultFile,
} from "./tp.js";

const NOW = new Date(2024, 4, 15, 14, 5, 0); // Wednesday 15 May 2024, 14:05
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function vaultWith(files: Record<string, string>): string {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "templater-tp-")));
	roots.push(root);
	for (const [relative, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
		fs.writeFileSync(path.join(root, relative), content);
	}
	return root;
}

function fileAt(root: string, relative: string): VaultFile {
	return new VaultFile(relative, path.join(root, relative), {
		ctime: new Date(2023, 0, 2, 8, 0).getTime(),
		mtime: new Date(2024, 3, 30, 22, 15).getTime(),
		size: 10,
	});
}

interface Harness {
	run(source: string, keepDynamic?: boolean): Promise<string>;
	warnings: string[];
	errors: string[];
}

/** A host over a real folder: the vault the template reads, with the target note in it. */
function harness(
	files: Record<string, string>,
	{
		target = "Projects/Alpha.md",
		overrides = {},
	}: { target?: string; overrides?: Partial<TemplaterHost> } = {},
): Harness {
	const root = vaultWith({ [target]: "", ...files });
	const warnings: string[] = [];
	const errors: string[] = [];
	const host: TemplaterHost = {
		now: NOW,
		target: fileAt(root, target),
		templateFile: fileAt(root, "Templates/Note.md"),
		runMode: RUN_MODE.CreateNewFromTemplate,
		root,
		tags: ["#project", "#work/alpha"],
		frontmatter: { status: "active", "due date": "2024-06-01", list: [1, 2] },
		content: "---\nstatus: active\n---\nBody text",
		systemCommands: ["shell"],
		findFile: async (linkpath) => {
			for (const candidate of [linkpath, `${linkpath}.md`, `Templates/${linkpath}.md`]) {
				if (fs.existsSync(path.join(root, candidate))) return fileAt(root, candidate);
			}
			return undefined;
		},
		report: (message) => {
			warnings.push(message);
		},
		errorMarker: (message, command) => {
			errors.push(command ? `${message} @ ${command}` : message);
			return `[!${message}]`;
		},
		...overrides,
	};
	return {
		run: (source, keepDynamic = true) => expandWithTp(source, host, keepDynamic),
		warnings,
		errors,
	};
}

describe("tp.date", () => {
	test("now, with a format, an offset in days or as an ISO 8601 duration, and a reference", async () => {
		const { run, errors } = harness({});
		expect(
			await run(
				[
					"<% tp.date.now() %>",
					'<% tp.date.now("Do MMMM YYYY") %>',
					'<% tp.date.now("YYYY-MM-DD", -7) %>',
					'<% tp.date.now("YYYY-MM-DD", 7) %>',
					'<% tp.date.now("YYYY-MM-DD", "P-1M") %>',
					'<% tp.date.now("YYYY-MM-DD", "P1Y") %>',
					'<% tp.date.now("HH:mm", "PT2H30M") %>',
					'<% tp.date.now("YYYY-MM-DD", "P1W") %>',
					'<% tp.date.now("YYYY-MM-DD", "nonsense") %>',
					'<% tp.date.now("YYYY-MM-DD", 1, "2024-02-28", "YYYY-MM-DD") %>',
					'<% tp.date.now("dddd", 0, "2024-02-29") %>',
					'<% tp.date.now("YYYY-MM-DD", -1, "31/12/2023", ["DD/MM/YYYY"]) %>',
				].join("\n"),
			),
		).toBe(
			[
				"2024-05-15",
				"15th May 2024",
				"2024-05-08",
				"2024-05-22",
				"2024-04-15",
				"2025-05-15",
				"16:35",
				"2024-05-22",
				"2024-05-15",
				"2024-02-29",
				"Thursday",
				"2023-12-30",
			].join("\n"),
		);
		expect(errors).toEqual([]);
	});

	test("an unparseable reference is an error", async () => {
		const { run, errors } = harness({});
		await run('<% tp.date.now("YYYY", 0, "not a date", "YYYY-MM-DD") %>');
		expect(errors[0]).toContain("Invalid reference date format");
	});

	test("a reference without a year takes it from the pinned clock, not the build machine's", async () => {
		const { run, errors } = harness({}, { overrides: { now: new Date(2001, 4, 15, 9, 0) } });
		expect(await run('<% tp.date.now("YYYY-MM-DD", 1, "03-14", "MM-DD") %>')).toBe("2001-03-15");
		expect(errors).toEqual([]);
	});

	test("a reference is read as moment reads it: a daily note's title, or looser text", async () => {
		const { run, errors } = harness({}, { target: "Daily/2024-02-28.md" });
		expect(
			await run(
				[
					'<% tp.date.now("dddd D MMMM", 0, tp.file.title, "YYYY-MM-DD") %>',
					'<% tp.date.now("YYYY-MM-DD", 1, tp.file.title, "YYYY-MM-DD") %>',
					'<% tp.date.now("YYYY-MM-DD", 0, "2024-2-9", "YYYY-MM-DD") %>',
					'<% tp.date.now("YYYY-MM-DD", 0, "due 9.2.2024", "DD/MM/YYYY") %>',
				].join("\n"),
			),
		).toBe(["Wednesday 28 February", "2024-02-29", "2024-02-09", "2024-02-09"].join("\n"));
		expect(errors).toEqual([]);
	});

	test("tomorrow, yesterday and weekday", async () => {
		const { run } = harness({});
		expect(
			await run(
				[
					"<% tp.date.tomorrow() %>",
					'<% tp.date.yesterday("ddd D") %>',
					'<% tp.date.weekday("YYYY-MM-DD", 0) %>',
					'<% tp.date.weekday("YYYY-MM-DD", 7) %>',
					'<% tp.date.weekday("YYYY-MM-DD", 1, "2024-05-01", "YYYY-MM-DD") %>',
					'<% tp.date.weekday("YYYY-MM-DD", -7, "2024-05-01", "YYYY-MM-DD") %>',
					"<% tp.date.weekday() %>",
				].join("\n"),
			),
		).toBe(
			[
				"2024-05-16",
				"Tue 14",
				"2024-05-12",
				"2024-05-19",
				"2024-04-29",
				"2024-04-21",
				"2024-05-12",
			].join("\n"),
		);
	});
});

describe("tp.file", () => {
	test("the target note's title, content, tags, dates, folder and path", async () => {
		const { run } = harness({});
		const output = await run(
			[
				"<% tp.file.title %>",
				"<% tp.file.content %>",
				"<% tp.file.tags %>",
				"<% tp.file.tags.contains('#project') %>",
				"<% tp.file.creation_date() %>",
				'<% tp.file.creation_date("dddd Do MMMM YYYY HH:mm") %>',
				"<% tp.file.last_modified_date() %>",
				"<% tp.file.folder() %>|<% tp.file.folder(true) %>",
				"<% tp.file.path(true) %>",
				"[<% tp.file.selection() %>][<% tp.file.cursor() %>][<% tp.file.cursor(1) %>]",
			].join("\n"),
		);
		const lines = output.split("\n");
		expect(lines.slice(0, 4)).toEqual(["Alpha", "---", "status: active", "---"]);
		expect(lines.slice(4)).toEqual([
			"Body text",
			"#project,#work/alpha",
			"true",
			"2023-01-02 08:00",
			"Monday 2nd January 2023 08:00",
			"2024-04-30 22:15",
			"Projects|Projects",
			"Projects/Alpha.md",
			"[][][]",
		]);
	});

	test("the absolute path and a note at the vault root", async () => {
		const nested = harness({});
		expect(await nested.run("<% tp.file.path() %>")).toMatch(/\/Projects\/Alpha\.md$/);
		const top = harness({}, { target: "Top.md" });
		expect(await top.run("[<% tp.file.folder() %>][<% tp.file.folder(true) %>]")).toBe("[][/]");
	});

	test("exists and find_tfile look in the vault, never outside it", async () => {
		const { run } = harness({ "Notes/Other.md": "other", "Templates/Header.md": "header" });
		expect(
			await run(
				[
					'<% await tp.file.exists("Notes/Other.md") %>',
					'<% await tp.file.exists("/Notes/Other.md") %>',
					'<% await tp.file.exists("Notes/Missing.md") %>',
					'<% await tp.file.exists("../outside.md") %>',
					'<% await tp.file.exists(tp.file.folder(true) + "/" + tp.file.title + ".md") %>',
					'<% tp.file.find_tfile("Notes/Other").basename %>',
					'<% tp.file.find_tfile("Header").path %>',
					'<% tp.file.find_tfile("Nope") %>',
					'<% tp.file.find_tfile("Notes/Other").extension %>/<% tp.file.find_tfile("Notes/Other").name %>/<% tp.file.find_tfile("Notes/Other").stat.size %>',
					'<% tp.file.find_tfile("Notes/Other").parent.path %>/<% tp.file.find_tfile("Notes/Other").parent.name %>',
				].join("\n"),
			),
		).toBe(
			[
				"true",
				"true",
				"false",
				"false",
				"true",
				"Other",
				"Templates/Header.md",
				"null",
				"md/Other.md/10",
				"Notes/Notes",
			].join("\n"),
		);
	});

	test("include expands the included note's own commands", async () => {
		const { run } = harness({
			"Templates/Header.md":
				"---\nkind: partial\n---\n# <% tp.file.title %>\n<% tp.file.include('[[Footer]]') %>",
			"Templates/Footer.md": "Footer <% 1 + 1 %> <%+ tp.file.title %>",
			"Notes/Sections.md":
				"intro\n# One\nfirst\n## One A\nnested\n# Two\nsecond ^block-2\n\n- item ^item\n- other\n\nlast para\nline two\n^para",
		});
		expect(await run("<% tp.file.include('[[Header]]') %>")).toBe(
			"# Alpha\nFooter 2 <%+ tp.file.title %>",
		);
		expect(await run('<% await tp.file.include(tp.file.find_tfile("Footer")) %>')).toBe(
			"Footer 2 <%+ tp.file.title %>",
		);
		expect(await run("<% tp.file.include('[[Notes/Sections#One]]') %>")).toBe(
			"# One\nfirst\n## One A\nnested",
		);
		expect(await run("<% tp.file.include('[[Notes/Sections#One#One A]]') %>")).toBe(
			"## One A\nnested",
		);
		expect(await run("<% tp.file.include('[[Notes/Sections#^block-2]]') %>")).toBe(
			"second ^block-2",
		);
		expect(await run("<% tp.file.include('[[Notes/Sections#^item|alias]]') %>")).toBe(
			"- item ^item",
		);
		expect(await run("<% tp.file.include('[[Notes/Sections#^para]]') %>")).toBe(
			"last para\nline two\n^para",
		);
		// A subpath that is not there includes the whole note, as Templater does.
		expect(await run("<% tp.file.include('[[Footer#Missing]]') %>")).toBe(
			"Footer 2 <%+ tp.file.title %>",
		);
	});

	test("include reports a bad link, a missing note and runaway recursion", async () => {
		const { run, errors } = harness({ "Templates/Loop.md": "x<% tp.file.include('[[Loop]]') %>" });
		expect(await run("<% tp.file.include('Loop') %>")).toBe(
			"[!Invalid file format, provide an obsidian link between quotes.]",
		);
		expect(await run("<% tp.file.include('[[Nowhere]]') %>")).toBe(
			"[!File [[Nowhere]] doesn't exist]",
		);
		const looped = await run("<% tp.file.include('[[Loop]]') %>");
		expect(looped).toBe(
			`${"x".repeat(INCLUDE_DEPTH_LIMIT)}[!Reached inclusion depth limit (max = ${INCLUDE_DEPTH_LIMIT})]`,
		);
		expect(errors.at(-1)).toBe(
			`Reached inclusion depth limit (max = ${INCLUDE_DEPTH_LIMIT}) @ <% tp.file.include('[[Loop]]') %>`,
		);
	});

	test("a template and the notes it includes share one step budget", async () => {
		const { run, errors } = harness({
			"Templates/Heavy.md": "<%* for (const c of 'x'.repeat(300000).split('')) {} %>done",
		});
		// Alone, one include fits the budget; a second must not get a fresh one.
		expect(await run("<% tp.file.include('[[Heavy]]') %>")).toBe("done");
		const twice = await run(
			"<% tp.file.include('[[Heavy]]') %>|<% tp.file.include('[[Heavy]]') %>|<% 'after' %>",
		);
		expect(twice).toStartWith("done|");
		expect(twice).toContain("The template ran more than 1000000 steps and was stopped.");
		expect(twice).not.toContain("after");
		expect(errors.at(-1)).toBe("The template ran more than 1000000 steps and was stopped.");
	});

	test("changes to the vault are skipped and reported", async () => {
		const { run, warnings } = harness({});
		expect(
			await run(
				[
					'<%* await tp.file.create_new("x", "New") %>',
					'<%* await tp.file.move("/A/" + tp.file.title) %>',
					'<%* await tp.file.rename("Other") %>',
					"<%* await tp.file.delete() %>",
					'<% tp.file.cursor_append("text") %>',
				].join(""),
			),
		).toBe("");
		expect(warnings).toEqual([
			"`tp.file.create_new` cannot change the vault from a static site; it was skipped.",
			"`tp.file.move` cannot change the vault from a static site; it was skipped.",
			"`tp.file.rename` cannot change the vault from a static site; it was skipped.",
			"`tp.file.delete` cannot change the vault from a static site; it was skipped.",
			"`tp.file.cursor_append` writes at the editor's cursor, which a static site does not have; nothing was inserted.",
		]);
	});

	test("create_new hands back the file Obsidian would have created, so links to it read right", async () => {
		const { run, warnings } = harness({});
		expect(
			await run(
				'[[<% (await tp.file.create_new("x", "MyFilename")).basename %>]] <% (await tp.file.create_new("x", "N", false, "Inbox/")).path %> <% (await tp.file.create_new("x")).name %>',
			),
		).toBe("[[MyFilename]] Inbox/N.md Untitled.md");
		expect(warnings).toEqual([
			"`tp.file.create_new` cannot change the vault from a static site; it was skipped.",
		]);
	});
});

describe("tp.frontmatter and tp.config", () => {
	test("frontmatter keys, including keys with spaces", async () => {
		const { run } = harness({});
		expect(
			await run(
				'<% tp.frontmatter.status %>|<% tp.frontmatter["due date"] %>|<% tp.frontmatter.list %>|<% tp.frontmatter.missing %>',
			),
		).toBe("active|2024-06-01|1,2|undefined");
	});

	test("the running configuration", async () => {
		const { run } = harness({});
		expect(
			await run(
				"<% tp.config.target_file.basename %>|<% tp.config.template_file.path %>|<% tp.config.run_mode %>|<% tp.config.active_file.name %>",
			),
		).toBe("Alpha|Templates/Note.md|0|Alpha.md");
	});
});

describe("tp.system, tp.web, tp.hooks and what a static site lacks", () => {
	test("prompts answer with their default, suggesters with their first item", async () => {
		const { run, warnings } = harness({});
		expect(
			await run(
				[
					'<% await tp.system.prompt("Mood?", "happy") %>',
					'[<% await tp.system.prompt("Name?") %>]',
					'<% await tp.system.suggester(["Happy", "Sad"], ["h", "s"]) %>',
					'<% await tp.system.suggester((item) => item.toUpperCase(), ["a", "b"], false, "Pick") %>',
					'<% await tp.system.suggester(["A", "B"], ["a", "b"], false, "", 5, "b") %>',
					'<% await tp.system.multi_suggester(["A"], ["a"], false, "", 5, ["a"]) %>|<% (await tp.system.multi_suggester(["A"], ["a"])).length %>',
					"[<% await tp.system.clipboard() %>]",
				].join("\n"),
			),
		).toBe(["happy", "[]", "h", "a", "b", "a|0", "[]"].join("\n"));
		expect(warnings).toEqual([
			'`tp.system.prompt("Name?")` has no default value and nobody to answer it on a static site; it was left empty.',
			'`tp.system.suggester(…)` cannot ask on a static site; it chose "Happy".',
			'`tp.system.suggester("Pick")` cannot ask on a static site; it chose "A".',
			'`tp.system.suggester(…)` cannot ask on a static site; it chose "B".',
			"`tp.system.multi_suggester` cannot ask on a static site; it chose its default values.",
			"`tp.system.clipboard` reads a clipboard a static build does not have; it was left empty.",
		]);
	});

	test("a call inside a loop is reported once", async () => {
		const { run, warnings } = harness({});
		await run('<%* for (const x of [1, 2, 3]) { tR += await tp.system.prompt("Again?") } %>');
		expect(warnings).toHaveLength(1);
	});

	test("network calls stay off", async () => {
		const { run, warnings } = harness({});
		expect(
			await run(
				'[<% await tp.web.daily_quote() %>][<% await tp.web.random_picture("200x200") %>][<% await tp.web.request("https://example.com") %>]',
			),
		).toBe("[][][]");
		expect(warnings.every((warning) => warning.includes("makes a network request"))).toBe(true);
		expect(warnings).toHaveLength(3);
	});

	test("on_all_templates_executed callbacks run after the expansion", async () => {
		const order: string[] = [];
		const { run } = harness(
			{},
			{
				overrides: {
					report: (message) => {
						order.push(message.startsWith("`tp.web") ? "hook" : message);
					},
				},
			},
		);
		const output = await run(
			'<%* tp.hooks.on_all_templates_executed(async () => { await tp.web.request("u") }) %>body <% tp.system.prompt("now?") %>',
		);
		expect(output).toBe("body ");
		expect(order).toEqual([
			'`tp.system.prompt("now?")` has no default value and nobody to answer it on a static site; it was left empty.',
			"hook",
		]);
	});

	test("a failing hook and a hook that is not a function are reported", async () => {
		const { run, errors } = harness({});
		await run("<%* tp.hooks.on_all_templates_executed(() => tp.obsidian.Notice) %>");
		await run("<%* tp.hooks.on_all_templates_executed(5) %>");
		expect(errors).toEqual([
			"`tp.obsidian` is Obsidian's live API, which a static site does not have. @ tp.hooks.on_all_templates_executed",
			"on_all_templates_executed() needs a function. @ <%* tp.hooks.on_all_templates_executed(5) %>",
		]);
	});

	test("tp.app and tp.obsidian are errors in place", async () => {
		const { run, errors } = harness({});
		expect(await run("<% tp.app.vault.getName() %> <% tp.obsidian.moment %>")).toBe(
			"[!`tp.app` is Obsidian's live API, which a static site does not have.] [!`tp.obsidian` is Obsidian's live API, which a static site does not have.]",
		);
		expect(errors).toHaveLength(2);
	});

	test("user scripts and system commands never run", async () => {
		const { run, warnings } = harness({});
		expect(await run("[<% tp.user.my_script('x') %>][<% await tp.user.shell() %>]")).toBe("[][]");
		expect(warnings).toEqual([
			"`tp.user.my_script` is a user script; arbitrary JavaScript does not run during a site build, so it was left empty.",
			"`tp.user.shell` is a user system command; shell commands never run during a site build, so it was left empty.",
		]);
	});

	test("moment and new Date read the pinned clock", async () => {
		const { run } = harness({});
		expect(
			await run(
				'<% moment().format("YYYY-MM-DD HH:mm") %>|<% moment(tp.file.title, "YYYY").isValid() %>|<% new Date().getHours() %>',
			),
		).toBe("2024-05-15 14:05|false|14");
	});

	test("an empty template and plain text are copied as they are", async () => {
		const { run } = harness({});
		expect(await run("")).toBe("");
		expect(await run("no commands {{date}}")).toBe("no commands {{date}}");
	});
});

describe("sliceSubpath", () => {
	const note = "```\n# Not a heading\n```\n# Real\ntext\n### Deep\nmore\n# Next\n";
	test("headings inside code are not sections", () => {
		expect(sliceSubpath(note, "Not a heading")).toBeUndefined();
		expect(sliceSubpath(note, "Real")).toBe("# Real\ntext\n### Deep\nmore");
		expect(sliceSubpath(note, "real#deep")).toBe("### Deep\nmore");
		expect(sliceSubpath(note, "Next")).toBe("# Next\n");
		expect(sliceSubpath(note, "^missing")).toBeUndefined();
		expect(sliceSubpath(note, "^bad id!")).toBeUndefined();
		expect(sliceSubpath(note, "")).toBeUndefined();
	});
});
