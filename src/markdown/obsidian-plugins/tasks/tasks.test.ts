/**
 * ` ```tasks ` blocks and a note's own tasks, compiled through the real remark
 * pass over a docs root and a vault published together, with the vault's own
 * Tasks settings and "today" pinned to Wednesday 15 May 2024.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	type Mock,
	spyOn,
	test,
} from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { buildContentIndex } from "../../content-index.ts";
import { normalizePluginOptions } from "../../normalize-options.ts";
import { remarkWikilink } from "../../remark-wikilink.ts";
import type { ContentIndex, RspressPluginMarkdownOptions } from "../../types.ts";
import type { TasksOptions } from "./options.ts";

const FILES: Record<string, string> = {
	"vault/.obsidian/plugins/obsidian-tasks-plugin/data.json": JSON.stringify({
		globalFilter: "#task",
		removeGlobalFilter: true,
		globalQuery: "path does not include Archive",
		statusSettings: {
			coreStatuses: [
				{ symbol: " ", name: "Todo", nextStatusSymbol: "x", type: "TODO" },
				{ symbol: "x", name: "Done", nextStatusSymbol: " ", type: "DONE" },
			],
			customStatuses: [{ symbol: "?", name: "Question", nextStatusSymbol: " ", type: "ON_HOLD" }],
		},
	}),
	"vault/Projects/Plan.md": `# Plan
- [ ] #task Write the [[Spec]] report 📅 2024-05-14 ⏫
  - [ ] #task Outline it 🆔 out1
  - a note under the outline
- [?] #task Ask about budget
- [ ] Not a task without the filter

## Done section
- [x] #task Shipped ✅ 2024-05-01 ^shipped
`,
	"vault/Projects/Spec.md": "# Spec\n\n- [ ] #task Review _spec_ 📅 2024-05-20 ⛔ out1\n",
	"vault/Archive/Routine.md":
		"- [x] #task Water plants 🔁 every Monday ✅ 2024-05-13\n- [x] #task Peel 🔁 every banana ✅ 2024-05-13\n",
	"vault/Archive/Old.md": "- [ ] #task Archived thing\n",
	"vault/Home.md": "# Home\n",
	"vault/Defaults.md":
		'---\nTQ_short_mode: true\nTQ_extra_instructions: "path includes Spec"\n---\n',
	"vault/Ignoring.md": '---\nTQ_extra_instructions: "ignore global query"\n---\n',
	"vault/Archive/Daily/2024-05-14.md":
		"- [ ] #task Stand-up notes\n- [ ] #task Pay invoice 📅 2024-05-31\n",
	"docs/index.md": "# Docs\n",
	"docs/Plan.md": "# Same name\n",
};

let root: string;
let docs: string;
let vault: string;
let docsIndex: ContentIndex;
let vaultIndex: ContentIndex;
let warn: Mock<typeof console.warn>;

beforeAll(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "tasks-e2e-"));
	for (const [file, content] of Object.entries(FILES)) {
		fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
		fs.writeFileSync(path.join(root, file), content);
	}
	docs = path.join(root, "docs");
	vault = path.join(root, "vault");
	docsIndex = await buildContentIndex(docs);
	vaultIndex = await buildContentIndex(vault, { routePrefix: "/vault" });
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
	warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

interface CompileOptions extends RspressPluginMarkdownOptions {
	page?: string;
}

async function compile(
	value: string,
	{ page = "docs/index.md", tasks, ...options }: CompileOptions & { tasks?: TasksOptions } = {},
) {
	const filePath = path.join(root, page);
	const inVault = filePath.startsWith(vault);
	const file = await unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkWikilink, {
			getDocsRoot: (target?: string) => (target?.startsWith(vault) ? vault : docs),
			getContentIndex: async (target: string) =>
				target.startsWith(vault) ? vaultIndex : docsIndex,
			getPublishedIndexes: async () => [docsIndex, vaultIndex],
			options: normalizePluginOptions({
				vaultRoot: vault,
				enableTasks: true,
				enableTagLinking: true,
				onBrokenLink: "warn",
				onPluginError: "warn",
				...options,
				tasks: { now: "2024-05-15", ...tasks },
			}),
		})
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(rehypeStringify, { allowDangerousHtml: true })
		.process({ value, path: inVault ? filePath : filePath });
	return { html: String(file), messages: file.messages.map(String) };
}

async function html(value: string, options: CompileOptions & { tasks?: TasksOptions } = {}) {
	return (await compile(value, options)).html;
}

/** The visible text of each task in a result, in order. */
function descriptions(output: string): string[] {
	return [...output.matchAll(/<span class="task-description"><span>(.*?)<\/span><\/span>/g)].map(
		(match) => (match[1] ?? "").replace(/<[^>]+>/g, ""),
	);
}

describe("a tasks block on a docs page", () => {
	test("lists the vault's tasks, with the global filter and global query applied", async () => {
		const output = await html("```tasks\nnot done\n```");
		expect(descriptions(output)).toEqual([
			"Write the Spec report",
			"Review spec",
			"Outline it",
			"Ask about budget",
		]);
		// Excluded from Rspress's outline: group headings are output, not the note's.
		expect(output).toContain('<div class="block-language-tasks rp-toc-exclude">');
		expect(output).toContain(
			'<ul class="contains-task-list plugin-tasks-query-result tasks-layout-hide-urgency">',
		);
		expect(output).toContain('<div class="task-count">4 tasks</div>');
		expect(output).not.toContain("Archived thing");
		expect(output).not.toContain("Not a task");
	});

	test("descriptions render as markdown of their own note, and backlinks lead to it", async () => {
		const output = await html("```tasks\ndescription includes report\n```");
		expect(output).toContain('Write the <a href="/vault/Projects/Spec">Spec</a> report');
		// A docs page shares the name "Plan", so the backlink names the path.
		expect(output).toContain(
			'<span class="tasks-backlink"> (<a class="internal-link" href="/vault/Projects/Plan#plan">/Projects/Plan.md &gt; Plan</a>)</span>',
		);
		const review = await html("```tasks\ndescription includes review\n```");
		expect(review).toContain("Review <em>spec</em>");
		expect(review).toContain('href="/vault/Projects/Spec#spec">Spec</a>)');
	});

	test("each task carries Tasks' markup and data attributes", async () => {
		const output = await html("```tasks\ndescription includes report\n```");
		expect(output).toContain(
			'<li class="task-list-item plugin-tasks-list-item" data-task-priority="high" data-task-due="past-1d" data-task="" data-line="0" data-task-status-name="Todo" data-task-status-type="TODO"><input class="task-list-item-checkbox" type="checkbox" disabled data-line="0">',
		);
		expect(output).toContain(
			'<span class="task-priority" data-task-priority="high"><span> ⏫</span></span><span class="task-due" data-task-due="past-1d"><span> 📅 2024-05-14</span></span>',
		);
		const done = await html("```tasks\ndone\n```");
		expect(done).toContain('class="task-list-item plugin-tasks-list-item is-checked"');
		expect(done).toContain('data-task-done="past-far"');
		expect(done).toContain(
			'<span class="task-done" data-task-done="past-far"><span> ✅ 2024-05-01</span></span>',
		);
		expect(done).toContain('<span class="task-block-link"><span> ^shipped</span></span>');
		expect(done).toContain("/Projects/Plan.md &gt; Done section</a>");
		const question = await html("```tasks\nstatus.name includes question\n```");
		expect(question).toContain('data-task="?"');
		expect(question).toContain('data-task-status-type="ON_HOLD"');
		expect(question).toContain("checked");
	});

	test("ignore global query reaches the archive", async () => {
		expect(await html("```tasks\nignore global query\npath includes Archive\n```")).toContain(
			"Archived thing",
		);
	});

	test("the vault's settings can be overridden or ignored", async () => {
		const unfiltered = await html("```tasks\npath includes Plan\n```", {
			tasks: { globalFilter: "", globalQuery: "", removeGlobalFilter: false },
		});
		expect(descriptions(unfiltered)).toContain("Not a task without the filter");
		expect(descriptions(unfiltered)).toContain("#task Write the Spec report");
		const ignored = await html("```tasks\nhas id\n```", { tasks: { readVaultSettings: false } });
		expect(descriptions(ignored)).toEqual(["#task Outline it"]);
	});
});

describe("layout", () => {
	test("groups print headings, and show tree nests sub-items under their task", async () => {
		const output = await html(
			"```tasks\nnot done\npath includes Plan\ngroup by heading\nshow tree\nshow group count\n```",
		);
		expect(output).toContain(
			'<h4 class="tasks-group-heading">Plan <span class="tasks-group-count">(3 tasks)</span></h4>',
		);
		expect(output).toContain('data-task-group-by="heading"');
		expect(output).toMatch(
			/Write the .*?<span class="task-extras">.*?<\/span><ul class="contains-task-list plugin-tasks-query-result tasks-layout-hide-urgency" data-task-group-by="heading"><li class="task-list-item plugin-tasks-list-item".*?Outline it.*?<\/li><li><span>a note under the outline<\/span><\/li><\/ul><\/li>/,
		);
		// Outline it is shown under its parent, not repeated at the top level.
		expect(output.match(/Outline it/g)).toHaveLength(1);
	});

	test("nested group levels use h5 and h6, and group headings render as markdown", async () => {
		// Headings render in the query's note: from the vault, `[[Plan]]` is the vault's note.
		const output = await html(
			"```tasks\nnot done\ngroup by root\ngroup by filename\ngroup by priority\n```",
			{
				page: "vault/Home.md",
			},
		);
		expect(output).toContain('<h4 class="tasks-group-heading">Projects/</h4>');
		expect(output).toContain(
			'<h5 class="tasks-group-heading"><a href="/vault/Projects/Plan">Plan</a></h5>',
		);
		expect(output).toContain('<h6 class="tasks-group-heading">High priority</h6>');
		expect(output).not.toContain("%%");
	});

	test("hide and show change fields, extras and classes", async () => {
		const output = await html(
			"```tasks\ndescription includes report\nhide due date\nhide priority\nhide backlinks\nshow urgency\nhide task count\nhide tags\nhide edit button\nhide postpone button\n```",
		);
		expect(output).not.toContain('class="task-due"');
		expect(output).not.toContain('class="task-priority"');
		// Hidden fields still mark the item, as in Tasks.
		expect(output).toContain('data-task-due="past-1d"');
		expect(output).not.toContain("tasks-backlink");
		expect(output).toContain('<span class="tasks-urgency">15.257</span>');
		expect(output).not.toContain("task-count");
		expect(output).toContain(
			'class="contains-task-list plugin-tasks-query-result tasks-layout-hide-priority tasks-layout-hide-dueDate tasks-layout-hide-tags tasks-layout-hide-backlinks tasks-layout-hide-edit-button tasks-layout-hide-postpone-button"',
		);
	});

	test("short mode shows emoji with their values as titles, and a link icon", async () => {
		const output = await html("```tasks\ndescription includes report\nshort mode\n```");
		expect(output).toContain(
			'<span class="task-due" data-task-due="past-1d" title="📅 2024-05-14"><span> 📅</span></span>',
		);
		expect(output).toContain(
			'<a class="internal-link internal-link-short-mode" href="/vault/Projects/Plan#plan"> 🔗</a>',
		);
		expect(output).toContain("tasks-layout-short-mode");
	});

	test("recurrence rules show, group and filter as rrule restates them", async () => {
		const output = await html(
			"```tasks\nignore global query\npath includes Routine\ngroup by recurrence\n```",
		);
		expect(output).toContain('<h4 class="tasks-group-heading">every week on Monday</h4>');
		expect(output).toContain(
			'<span class="task-recurring"><span> 🔁 every week on Monday</span></span>',
		);
		// rrule cannot read `every banana`: no rule, not recurring.
		expect(output).toContain('<h4 class="tasks-group-heading">None</h4>');
		expect(output).not.toContain("banana");
		const recurring = await html(
			"```tasks\nignore global query\nis recurring\nrecurrence includes week on monday\n```",
		);
		expect(descriptions(recurring)).toEqual(["Water plants"]);
	});

	test("ids, dependencies and nested backlinks", async () => {
		const output = await html("```tasks\nhas depends on\n```");
		expect(output).toContain('<span class="task-dependsOn"><span> ⛔ out1</span></span>');
		const outline = await html("```tasks\nhas id\n```");
		expect(outline).toContain('<span class="task-id"><span> 🆔 out1</span></span>');
		const nested = await html(
			"```tasks\npath includes Plan\nnot done\nshow tree\nhide nested backlinks\n```",
		);
		expect(nested.match(/tasks-backlink/g)).toHaveLength(2);
	});

	test("view columns puts each top-level group in a column of cards", async () => {
		const output = await html(
			"```tasks\nnot done\nview columns by status.name\ngroup by filename\nshow tree\n```",
			{ page: "vault/Home.md" },
		);
		expect(output).toContain(
			'<div class="tasks-columns"><div class="tasks-columns-column"><h4 class="tasks-group-heading">Question</h4><h5 class="tasks-group-heading"><a href="/vault/Projects/Plan">Plan</a></h5>',
		);
		expect(output).toContain(
			'</ul></div><div class="tasks-columns-column"><h4 class="tasks-group-heading">Todo</h4>',
		);
		expect(output.match(/tasks-columns-column-card/g)).toHaveLength(3);
		expect(output).toContain('</ul></div></div><div class="task-count">4 tasks</div>');
	});

	test("limits report how many tasks matched", async () => {
		expect(await html("```tasks\nnot done\nlimit 1\n```")).toContain(
			'<div class="task-count">1 of 4 tasks</div>',
		);
	});

	test("the vault's setting can put the task count above the list", async () => {
		const settingsOnly = path.join(root, "vault-top");
		const folder = path.join(settingsOnly, ".obsidian/plugins/obsidian-tasks-plugin");
		fs.mkdirSync(folder, { recursive: true });
		fs.writeFileSync(
			path.join(folder, "data.json"),
			JSON.stringify({ globalFilter: "#task", searchResults: { taskCountLocation: "top" } }),
		);
		const top = await html("```tasks\nnot done\n```", { vaultRoot: settingsOnly });
		expect(top).toContain(
			'<div class="block-language-tasks rp-toc-exclude"><div class="task-count">7 tasks</div><ul',
		);
		const bottom = await html("```tasks\nnot done\n```");
		expect(bottom).toContain('</ul><div class="task-count">4 tasks</div></div>');
	});
});

describe("explain", () => {
	test("lists the global filter, the global query and the block's query", async () => {
		const output = await html("```tasks\nnot done\nexplain\n```");
		expect(
			output,
		).toContain(`<pre class="plugin-tasks-query-explanation">Only tasks containing the global filter '#task'.

Explanation of the global query:

  path does not include Archive

Explanation of this Tasks code block query:

  not done =&gt;
    status type is TODO or IN_PROGRESS or ON_HOLD
</pre>`);
		const ignoring = await html("```tasks\nignore global query\nexplain\n```");
		expect(ignoring).not.toContain("Explanation of the global query");
	});

	test("a note's TQ_ properties shape its queries and are explained", async () => {
		const output = await html("```tasks\nnot done\nexplain\n```", { page: "vault/Defaults.md" });
		expect(output).toContain(
			"Explanation of the Query File Defaults (from properties/frontmatter in the query's file):\n\n  path includes Spec\n\n  short mode\n\nExplanation of this Tasks code block query:",
		);
		expect(descriptions(output)).toEqual(["Review spec"]);
		expect(output).toContain("tasks-layout-short-mode");
		const ignoring = await html("```tasks\nnot done\nexplain\n```", { page: "vault/Ignoring.md" });
		expect(ignoring).not.toContain("Explanation of the global query");
		expect(ignoring).toContain("Archived thing");
	});
});

describe("filename as scheduled date", () => {
	test("a daily note's undated tasks are scheduled on its date, without a ⏳ shown", async () => {
		const options = {
			tasks: { useFilenameAsScheduledDate: true, filenameAsDateFolders: ["Archive/Daily"] },
		};
		const output = await html(
			"```tasks\nignore global query\nscheduled on 2024-05-14\n```",
			options,
		);
		expect(descriptions(output)).toEqual(["Stand-up notes"]);
		expect(output).not.toContain("task-scheduled");
		expect(output).not.toContain("data-task-scheduled");
		const grouped = await html(
			"```tasks\nignore global query\npath includes Daily\ngroup by scheduled\n```",
			options,
		);
		expect(grouped).toContain('<h4 class="tasks-group-heading">2024-05-14 Tuesday</h4>');
		expect(grouped).toContain('<h4 class="tasks-group-heading">No scheduled date</h4>');
		expect(
			descriptions(await html("```tasks\nignore global query\nscheduled on 2024-05-14\n```")),
		).toEqual([]);
	});
});

describe("problems", () => {
	test("an instruction a static site cannot run is shown in place and reported", async () => {
		const { html: output, messages } = await compile(
			"```tasks\nfilter by function task.urgency > 10\n```",
		);
		expect(output).toContain(
			'<div class="block-language-tasks rp-toc-exclude"><div class="plugin-tasks-query-error"><pre>Tasks query: JavaScript in queries is not run',
		);
		expect(
			messages.some((message) =>
				message.includes("[rspress-plugin-obsidian:markdown:tasks] Tasks query: JavaScript"),
			),
		).toBe(true);
	});

	test("with onPluginError: error, a broken query fails the build", async () => {
		await expect(
			compile("```tasks\nfrobnicate\n```", { onPluginError: "error" }),
		).rejects.toThrow();
	});

	test("unusable settings are warned about", async () => {
		const { messages } = await compile("```tasks\ndone\n```", { tasks: { now: "never" } });
		expect(messages.some((message) => message.includes("is not a date"))).toBe(true);
	});

	test("with the feature off, the block stays code", async () => {
		const output = await html("```tasks\nnot done\n```", { enableTasks: false });
		expect(output).toContain('<code class="language-tasks">');
	});
});

describe("a note's own tasks", () => {
	test("carry Tasks' attributes, and the global filter is hidden", async () => {
		const source = fs.readFileSync(path.join(vault, "Projects/Plan.md"), "utf8");
		const output = await html(source, { page: "vault/Projects/Plan.md" });
		expect(output).toContain(
			'<li class="task-list-item plugin-tasks-list-item" data-task-status-name="Todo" data-task-status-type="TODO" data-task-priority="high" data-task-due="past-1d" data-task=""><input type="checkbox" disabled> Write the <a href="/vault/Projects/Spec">Spec</a> report 📅 2024-05-14 ⏫',
		);
		expect(output).toContain(
			'data-task-status-name="Question" data-task-status-type="ON_HOLD" data-task-priority="normal" data-task="?"',
		);
		expect(output).toContain('class="task-list-item plugin-tasks-list-item is-checked"');
		// Without the global filter it is an ordinary checkbox.
		expect(output).toContain(
			'<li class="task-list-item" data-task=""><input type="checkbox" disabled> Not a task without the filter</li>',
		);
		expect(output).not.toContain("#task");
	});

	test("a tasks block in the vault queries both trees, relative to its own note", async () => {
		const output = await html("```tasks\npath includes {{query.file.folder}}\nnot done\n```", {
			page: "vault/Projects/Spec.md",
		});
		expect(descriptions(output)).toEqual([
			"Write the Spec report",
			"Review spec",
			"Outline it",
			"Ask about budget",
		]);
	});
});
