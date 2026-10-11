import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Root } from "mdast";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { VFile } from "vfile";
import { buildContentIndex } from "./content-index";
import { normalizeDailyNoteConfig } from "./daily-notes";
import { processDailyNoteNodes, processDataviewNodes } from "./remark-dataview";
import type { ContentIndex, ContentPage } from "./types";

const FILES: Record<string, string> = {
	"Home.md": "# Home\n\nstatus:: open\n",
	"Target.md": "# Target\n",
	"daily/2026-08-20.md": "",
	"daily/2026-08-21.md": "Written {{date}} by hand.\n",
	"templates/Daily.md":
		"---\ntags: [journal]\n---\n# {{title}}\n\nCreated at {{time}} on {{date:dddd}}. ==Review== [[Target]]\n",
};

let root: string;
let index: ContentIndex;

beforeAll(async () => {
	root = mkdtempSync(path.join(os.tmpdir(), "obsidian-remark-dataview-"));
	for (const [name, content] of Object.entries(FILES)) {
		const target = path.join(root, name);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
	index = await buildContentIndex(root);
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function page(relativePath: string): ContentPage {
	const found = index.pages.find((candidate) => candidate.relativePath === relativePath);
	if (!found) throw new Error(`${relativePath} is not indexed`);
	return found;
}

const dailyNotes = normalizeDailyNoteConfig({ folder: "daily", template: "templates/Daily" });
const options = {
	onDataviewError: "warn" as const,
	dailyNotes,
	enableCaseInsensitiveLookup: true,
	enableFuzzyMatching: false,
};

const parser = unified().use(remarkParse).use(remarkGfm);
const printer = unified()
	.use(remarkRehype, { allowDangerousHtml: true })
	.use(rehypeStringify, { allowDangerousHtml: true });

function html(tree: Root): string {
	return String(printer.stringify(printer.runSync(tree))).trim();
}

/** Run the Dataview pass over `markdown` written on `Home.md`. */
function dataview(markdown: string): { html: string; messages: string[] } {
	const tree = parser.parse(markdown) as Root;
	const file = new VFile({ path: path.join(root, "Home.md"), value: markdown });
	processDataviewNodes(tree, page("Home.md"), index, file, options);
	return { html: html(tree), messages: file.messages.map(String) };
}

describe("inline queries", () => {
	test("`= expr` in inline code is evaluated against this", () => {
		expect(dataview("Name: `= this.file.name`, status `= this.status`.").html).toBe(
			'<p>Name: <span class="dataview-inline">Home</span>, status <span class="dataview-inline">open</span>.</p>',
		);
	});

	test("`$= expr` is inline DataviewJS", () => {
		expect(dataview("Pages: `$= dv.pages().length`").html).toBe(
			`<p>Pages: <span class="dataview-inline">${index.pages.length}</span></p>`,
		);
	});

	test("prose with an equals sign is never evaluated", () => {
		const source = "Set the variable x = name in your config. Today = today, the file = file here.";
		expect(dataview(source).html).toBe(`<p>${source}</p>`);
	});

	test("other inline code is left alone, and a failing query is reported and kept", () => {
		const result = dataview("Code `a = b` and `= bogus(1)`.");
		expect(result.html).toBe("<p>Code <code>a = b</code> and <code>= bogus(1)</code>.</p>");
		expect(
			result.messages.some((message) => message.includes("Unsupported Dataview function: bogus")),
		).toBe(true);
	});

	test("code that only begins with = is code, not a query", () => {
		const result = dataview("Write `==highlight==` or `=SUM(A1:A3)` or `= 1 +`.");
		expect(result.html).toBe(
			"<p>Write <code>==highlight==</code> or <code>=SUM(A1:A3)</code> or <code>= 1 +</code>.</p>",
		);
		expect(result.messages).toEqual([]);
	});
});

describe("inline fields", () => {
	test("[key:: value] shows key and value; (key:: value) only the value", () => {
		expect(dataview("Inline [mood:: happy] and (hidden:: yes) text.").html).toBe(
			'<p>Inline <span class="dataview inline-field"><span class="dataview inline-field-key">mood</span><span class="dataview inline-field-value">happy</span></span> and <span class="dataview inline-field"><span class="dataview inline-field-standalone-value">yes</span></span> text.</p>',
		);
	});

	test("a value may hold a link or emphasis, which stay nodes for later passes", () => {
		const result = dataview("See [related:: [[Target]]] and [note:: **bold** *x*].");
		expect(result.html).toContain(
			'<span class="dataview inline-field-key">related</span><span class="dataview inline-field-value">[[Target]]</span>',
		);
		expect(result.html).toContain(
			'<span class="dataview inline-field-value"><strong>bold</strong> <em>x</em></span>',
		);
	});

	test("full-line fields and code are untouched", () => {
		expect(dataview("status:: open\n\n`[k:: v]`").html).toBe(
			"<p>status:: open</p>\n<p><code>[k:: v]</code></p>",
		);
	});
});

describe("dataview fences", () => {
	test("render in place, and errors are reported with the fence kept", () => {
		const ok = dataview('```dataview\nLIST FROM "daily"\n```');
		expect(ok.html).toContain('<ul class="dataview dataview-list">');
		const broken = dataview("```dataview\nLIST WHERE\n```");
		expect(broken.html).toContain("<pre><code");
		expect(broken.messages.length).toBeGreaterThan(0);
	});
});

describe("daily notes", () => {
	const now = new Date(2030, 0, 1, 9, 41);

	async function daily(
		relativePath: string,
		source: string,
		expandTemplate?: (template: string) => Promise<string>,
	): Promise<string> {
		const tree = parser.parse(source) as Root;
		await processDailyNoteNodes(
			tree,
			page(relativePath),
			index,
			{ dailyNotes, enableMath: false },
			true,
			root,
			source,
			{ now, expandTemplate },
		);
		return html(tree);
	}

	test("an empty daily note is filled from the template with its tokens expanded", async () => {
		const output = await daily("daily/2026-08-20.md", "");
		expect(output).toContain("<h1>2026-08-20</h1>");
		expect(output).toContain("<p>Created at 09:41 on Thursday. <mark>Review</mark>");
		expect(output).toContain('class="obsidian-daily-navigation"');
	});

	test("a template plugin runs over the template after the core tokens", async () => {
		const seen: string[] = [];
		const output = await daily("daily/2026-08-20.md", "", async (template) => {
			seen.push(template);
			return template.replace("Review", "Plan");
		});
		// Core tokens are already expanded when the plugin sees the template.
		expect(seen[0]).toContain("# 2026-08-20");
		expect(output).toContain("<mark>Plan</mark>");
	});

	test("a note's own text keeps its {{tokens}}", async () => {
		expect(await daily("daily/2026-08-21.md", FILES["daily/2026-08-21.md"] ?? "")).toContain(
			"<p>Written {{date}} by hand.</p>",
		);
	});
});
