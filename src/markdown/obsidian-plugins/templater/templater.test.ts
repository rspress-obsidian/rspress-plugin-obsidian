import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { stripFrontmatter } from "../../../shared/frontmatter.js";
import { getCachedContentIndex } from "../../content-index.js";
import { markdown } from "../../index.js";
import { normalizePluginOptions } from "../../normalize-options.js";
import type { RspressPluginMarkdownOptions } from "../../types.js";
import { templaterFeature } from "./index.js";
import { resolveTemplaterSettings } from "./settings.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function vaultWith(files: Record<string, string>): string {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "templater-site-")));
	roots.push(root);
	for (const [relative, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
		fs.writeFileSync(path.join(root, relative), content);
	}
	return root;
}

const SETTINGS = ".obsidian/plugins/templater-obsidian/data.json";

/** A published vault, compiled note by note through the plugin's own remark pass. */
function site(files: Record<string, string>, options: RspressPluginMarkdownOptions = {}) {
	const root = vaultWith(files);
	const plugin = markdown({
		vaultRoot: root,
		vaultRoutePrefix: "/vault",
		enableTemplater: true,
		onPluginError: "warn",
		...options,
		templater: { now: "2024-05-03T10:00", ...options.templater },
	});
	const tuple = (plugin.markdown?.remarkPlugins as unknown[] | undefined)?.[0];
	if (!Array.isArray(tuple)) throw new Error("expected a remark plugin tuple");
	return {
		root,
		async render(relative: string): Promise<{ html: string; messages: string[] }> {
			const file = await unified()
				.use(remarkParse)
				.use(remarkGfm)
				.use(tuple[0], tuple[1])
				.use(remarkRehype, { allowDangerousHtml: true })
				.use(rehypeStringify, { allowDangerousHtml: true })
				.process({
					// As Rspress compiles a note: the body, without its frontmatter.
					value: stripFrontmatter(fs.readFileSync(path.join(root, relative), "utf8")),
					path: path.join(root, relative),
				});
			return { html: String(file), messages: file.messages.map((message) => message.reason) };
		},
	};
}

const DAILY = {
	enableDailyNotes: true,
	dailyNotes: { folder: "Daily", template: "Templates/Daily", dateFormat: "YYYY-MM-DD" },
} satisfies RspressPluginMarkdownOptions;

describe("daily notes", () => {
	test("an empty daily note gets its template, core tokens first and then Templater", async () => {
		const vault = site(
			{
				"Templates/Daily.md": [
					"# <% tp.date.now('dddd D MMMM YYYY', 0, tp.file.title, 'YYYY-MM-DD') %>",
					"",
					"Core {{title}}; previous [[<% tp.date.now('YYYY-MM-DD', -1, tp.file.title, 'YYYY-MM-DD') %>]]",
					"",
					"<%* if (tp.file.folder() === 'Daily') { -%>",
					"In the daily folder, run mode <% tp.config.run_mode %>.",
					"<%* } -%>",
					"<% tp.file.include('[[Header]]') %>",
					"",
					"Seen <%+ tp.file.title %>",
				].join("\n"),
				"Templates/Header.md": "**Header for <% tp.file.title %>**",
				"Daily/2024-05-02.md": "",
				"Daily/2024-05-01.md": "Yesterday's notes.",
				[SETTINGS]: JSON.stringify({ templates_folder: "Templates" }),
			},
			DAILY,
		);
		const { html, messages } = await vault.render("Daily/2024-05-02.md");
		expect(html).toContain('<h1 id="thursday-2-may-2024">Thursday 2 May 2024</h1>');
		expect(html).toContain('Core 2024-05-02; previous <a href="/vault/Daily/2024-05-01"');
		expect(html).toContain("In the daily folder, run mode 2.");
		expect(html).toContain("<strong>Header for 2024-05-02</strong>");
		expect(html).toContain("Seen 2024-05-02");
		expect(html).not.toContain("&#x3C;%");
		expect(messages).toEqual([]);
	});

	test("with trigger_on_file_creation off the template's commands stay as written", async () => {
		const vault = site(
			{
				"Templates/Daily.md": "Date <% tp.date.now() %>",
				"Daily/2024-05-02.md": "",
				[SETTINGS]: JSON.stringify({
					templates_folder: "Templates",
					trigger_on_file_creation: false,
				}),
			},
			DAILY,
		);
		const { html, messages } = await vault.render("Daily/2024-05-02.md");
		expect(html).toContain("Date &#x3C;% tp.date.now() %>");
		expect(messages).toEqual([
			expect.stringContaining("Templater command `<% tp.date.now() %>` is shown as written"),
		]);
	});

	test("a daily note with its own text keeps it", async () => {
		const vault = site(
			{
				"Templates/Daily.md": "From the template",
				"Daily/2024-05-02.md": "Written by hand <%+ tp.date.now('YYYY') %>",
				[SETTINGS]: JSON.stringify({
					templates_folder: "Templates",
					enable_folder_templates: true,
					folder_templates: [{ folder: "/", template: "Templates/Daily.md" }],
				}),
			},
			DAILY,
		);
		const { html } = await vault.render("Daily/2024-05-02.md");
		expect(html).toContain("Written by hand 2024");
		expect(html).not.toContain("From the template");
	});
});

describe("folder and file regex templates", () => {
	const templates = {
		"Templates/Meeting.md":
			"---\ntype: meeting\n---\n## Meeting <% tp.file.title %>\n\nStatus: <% tp.frontmatter.status %>, template <% tp.config.template_file.basename %>\n",
		"Templates/Any.md": "Catch-all for <% tp.file.path(true) %>",
		"Templates/Deep.md": "Deep <% tp.file.folder(true) %>",
		"Templates/Book.md": "> [!quote] <% tp.file.title %>\n> Read <% tp.date.now('YYYY') %>",
	};

	test("the deepest folder rule fills an empty note, and `/` catches the rest", async () => {
		const vault = site(
			{
				...templates,
				"Meetings/Standup.md": "---\nstatus: draft\n---\n",
				"Meetings/Deep/Retro.md": "",
				"Elsewhere/Note.md": "   \n",
				"Meetings/Written.md": "Already written.",
				[SETTINGS]: JSON.stringify({
					templates_folder: "Templates",
					trigger_on_file_creation_mode: "folder",
					data_version: 2,
					folder_templates: [
						{ folder: "/", template: "Templates/Any.md" },
						{ folder: "Meetings", template: "Templates/Meeting.md" },
						{ folder: "Meetings/Deep", template: "Templates/Deep" },
					],
				}),
			},
			{ enableCallouts: true },
		);
		const standup = await vault.render("Meetings/Standup.md");
		expect(standup.html).toContain('<h2 id="meeting-standup">Meeting Standup</h2>');
		expect(standup.html).toContain("Status: draft, template Meeting");
		// The template's own properties are not rendered into the note.
		expect(standup.html).not.toContain("type: meeting");
		expect((await vault.render("Meetings/Deep/Retro.md")).html).toContain("Deep Meetings/Deep");
		expect((await vault.render("Elsewhere/Note.md")).html).toContain(
			"Catch-all for Elsewhere/Note.md",
		);
		expect((await vault.render("Meetings/Written.md")).html).toContain("Already written.");
	});

	test("file regex rules are tried top to bottom; a template's callout renders", async () => {
		const vault = site(
			{
				...templates,
				"Books/Dune.md": "",
				"Other/Plain.md": "",
				[SETTINGS]: JSON.stringify({
					templates_folder: "Templates",
					enable_file_templates: true,
					file_templates: [
						{ regex: "[", template: "Templates/Any.md" },
						// Would hang the build on a long path: refused, and the next rule applies.
						{ regex: "^(a+)+$", template: "Templates/Any.md" },
						{ regex: "^Books/", template: "Templates/Book.md" },
						{ regex: ".*", template: "Templates/Any.md" },
					],
				}),
			},
			{ enableCallouts: true },
		);
		const book = await vault.render("Books/Dune.md");
		expect(book.html).toContain('<div class="callout callout-quote" data-callout="quote">');
		expect(book.html).toContain("Dune");
		expect(book.html).toContain("Read 2024");
		expect(book.messages).toEqual([
			expect.stringContaining('File regex template "[" cannot be used: Invalid regular expression'),
			expect.stringContaining("catastrophic backtracking"),
		]);
		expect((await vault.render("Other/Plain.md")).html).toContain("Catch-all for Other/Plain.md");
	});

	test("ignored folders and the trigger switch leave empty notes empty", async () => {
		const files = {
			...templates,
			"Archive/Old.md": "",
			"Fresh.md": "",
		};
		const ignoring = site({
			...files,
			[SETTINGS]: JSON.stringify({
				templates_folder: "Templates",
				trigger_on_file_creation_mode: "folder",
				ignore_folders_on_creation: [{ folder: "Archive" }],
				folder_templates: [{ folder: "/", template: "Templates/Any.md" }],
			}),
		});
		expect((await ignoring.render("Archive/Old.md")).html).toBe("");
		expect((await ignoring.render("Fresh.md")).html).toContain("Catch-all for Fresh.md");
		const off = site(files, {
			templater: {
				triggerOnFileCreation: false,
				folderTemplates: [{ folder: "/", template: "Templates/Any.md" }],
			},
		});
		expect((await off.render("Fresh.md")).html).toBe("");
	});

	test("a rule naming a missing template is an error in place", async () => {
		const files = { "Empty.md": "" };
		const options = {
			templater: { folderTemplates: [{ folder: "/", template: "Templates/Gone.md" }] },
		};
		const { html, messages } = await site(files, options).render("Empty.md");
		expect(html).toContain('<span class="templater-error"');
		expect(html).toContain("Couldn't find template Templates/Gone.md");
		expect(messages).toEqual([expect.stringContaining("Couldn't find template Templates/Gone.md")]);
		await expect(
			site(files, { ...options, onPluginError: "error" }).render("Empty.md"),
		).rejects.toThrow();
	});
});

describe("commands in published notes", () => {
	test("dynamic commands render as text; code, inline code and links are never read", async () => {
		const vault = site({
			"Note.md": [
				"Title <%+ tp.file.title %>, tags <%+ tp.file.tags %>, **bold <%+ 6 * 7 %>**",
				"",
				"Section: <%+ tp.file.include('[[Other#Sec]]') %>",
				"",
				"`<%+ tp.file.title %>` and [<%+ tp.file.title %>](https://example.com)",
				"",
				"```",
				"<%+ tp.file.title %>",
				"```",
				"",
				"Broken: <%+ tp.nothing() %>, then <%+ '1 <' + ' 2' %>",
				"",
				"Dynamic exec <%*+ tR += 'x'.repeat(3) %> #tagged",
			].join("\n"),
			"Other.md": "# Sec\nsection body\n# Next\nnot this",
		});
		const { html, messages } = await vault.render("Note.md");
		expect(html).toContain("Title Note, tags #tagged, <strong>bold 42</strong>");
		expect(html).toContain("Section: # Sec<br>\nsection body");
		expect(html).toContain("<code>&#x3C;%+ tp.file.title %></code>");
		expect(html).toContain('<a href="https://example.com">&#x3C;%+ tp.file.title %></a>');
		expect(html).toContain("<pre><code>&#x3C;%+ tp.file.title %>\n</code></pre>");
		expect(html).toContain(
			'Broken: <span class="templater-error" title="tp.nothing is not a function.">Templater: tp.nothing is not a function.</span>, then 1 &#x3C; 2',
		);
		expect(html).toContain("Dynamic exec xxx");
		expect(messages).toEqual([
			expect.stringContaining("tp.nothing is not a function. (in `<%+ tp.nothing() %>`)"),
		]);
	});

	test("other commands stay as Obsidian's reading view shows them, each reported", async () => {
		const vault = site({
			"Note.md": "Made <% tp.date.now() %> and <%* tR += 'x' %>.\n\nUnfinished <% tp.file.title",
		});
		const { html, messages } = await vault.render("Note.md");
		expect(html).toContain("Made &#x3C;% tp.date.now() %> and &#x3C;%* tR += 'x' %>.");
		expect(messages).toEqual([
			expect.stringContaining("Templater command `<% tp.date.now() %>` is shown as written"),
			expect.stringContaining("Templater command `<%* tR += 'x' %>` is shown as written"),
			expect.stringContaining('A Templater command starting "<% tp.file.title" is split'),
		]);
	});

	test('renderCommands "all" runs every command, across blocks, as "Replace templates" would', async () => {
		const vault = site(
			{
				"Note.md": [
					"Made <% tp.date.now('YYYY-MM-DD') %> by <% tp.frontmatter.author ?? 'me' %>",
					"",
					"<%* if (tp.file.title === 'Note') { -%>",
					"Conditional paragraph.",
					"",
					"- and a list",
					"<%* } -%>",
					"",
					"Kept <%+ tp.file.title %>",
				].join("\n"),
				"Board.md": "---\nkanban-plugin: basic\n---\n\n## Lane <% 1 + 1 %>\n",
			},
			{ templater: { renderCommands: "all" } },
		);
		const { html, messages } = await vault.render("Note.md");
		expect(html).toContain("<p>Made 2024-05-03 by me</p>");
		expect(html).toContain("<p>Conditional paragraph.</p>");
		expect(html).toContain("<li>and a list</li>");
		expect(html).toContain("Kept Note");
		expect(messages).toEqual([]);
		// A note another plugin renders whole is evaluated command by command.
		expect((await vault.render("Board.md")).html).toContain("Lane 2");
	});
});

describe("finding templates", () => {
	test("an include names a template by path or by name anywhere in the templates folder", async () => {
		const vault = site(
			{
				"Templates/Partials/Signature.md": "-- <% tp.file.title %>",
				"Templates/Top.md": "top",
				"Notes/Letter.md": "",
				"Notes/Peer.md": "peer note",
				[SETTINGS]: JSON.stringify({ templates_folder: "Templates" }),
			},
			{
				templater: {
					folderTemplates: [{ folder: "Notes", template: "Templates/Letter" }],
				},
			},
		);
		fs.writeFileSync(
			path.join(vault.root, "Templates/Letter.md"),
			"<% tp.file.include('[[Signature]]') %> <% tp.file.include('[[Templates/Top]]') %> <% tp.file.include('[[Peer]]') %> <% tp.file.include('[[Absent]]') %> <% tp.file.include('[[../outside]]') %>",
		);
		const { html, messages } = await vault.render("Notes/Letter.md");
		expect(html).toContain("-- Letter top peer note");
		expect(html).toContain("File [[Absent]] doesn");
		expect(messages).toHaveLength(2);
	});

	test("an error inside a template's code block is shown as text there", async () => {
		const vault = site(
			{
				"Templates/Code.md": "```\n<% missing %>\n```\n\n`<% alsoMissing %>`",
				"New.md": "",
			},
			{ templater: { folderTemplates: [{ folder: "/", template: "Templates/Code.md" }] } },
		);
		const { html } = await vault.render("New.md");
		expect(html).toContain('<pre><code>Templater: "missing" is not defined.\n</code></pre>');
		expect(html).toContain('<code>Templater: "alsoMissing" is not defined.</code>');
	});

	test("a failed command that was to write a link's target becomes its error marker, not a link", async () => {
		const vault = site(
			{
				"Templates/Links.md":
					"[[<% missing.basename %>]] [label](<% alsoMissing %>) <span><% third %></span>",
				"New.md": "",
			},
			{ templater: { folderTemplates: [{ folder: "/", template: "Templates/Links.md" }] } },
		);
		const { html } = await vault.render("New.md");
		expect(html).toContain('"missing" is not defined.');
		expect(html).toContain('"alsoMissing" is not defined.');
		expect(html).toContain('"third" is not defined.');
		// The placeholder the engine parks a failure under never reaches the page.
		expect(html).not.toMatch(/[\uE000\uE001]/);
		expect(html).not.toContain("<a ");
	});

	test("a block id the template brings in is hidden and anchored, as Obsidian shows the filled note", async () => {
		const vault = site(
			{
				"Templates/Block.md": 'Intro.\n\n<% await tp.file.include("[[Source#^block1]]") %>',
				"Source.md": "# Source\n\nA block of text. ^block1\n",
				"New.md": "",
			},
			{ templater: { folderTemplates: [{ folder: "/", template: "Templates/Block.md" }] } },
		);
		const { html } = await vault.render("New.md");
		expect(html).toContain("A block of text.");
		expect(html).not.toContain("^block1</");
		expect(html).toContain('id="^block1"');
	});

	test("a note with unreadable frontmatter is still evaluated whole", async () => {
		const vault = site(
			{ "Odd.md": "---\n: [unclosed\n---\nA <% 1 + 1 %>\n" },
			{ templater: { renderCommands: "all" } },
		);
		expect((await vault.render("Odd.md")).html).toContain("A 2");
	});
});

describe("the templates folder", () => {
	test("is excluded from the index, relative to the vault", async () => {
		const root = vaultWith({
			"Templates/Daily.md": "template",
			"Templates/Sub/Partial.md": "partial",
			"Scripts/helper.md": "not a script, but in the scripts folder",
			"Note.md": "note",
			[SETTINGS]: JSON.stringify({
				templates_folder: "/Templates/",
				user_scripts_folder: "Scripts",
			}),
		});
		const options = normalizePluginOptions({ vaultRoot: root, enableTemplater: true });
		const excluded = templaterFeature.excludedFolders?.(options) ?? [];
		expect(excluded).toEqual(["Templates", "Scripts"]);
		const index = await getCachedContentIndex(root, { excludeFolders: excluded });
		expect(index.pages.map((page) => page.relativePath)).toEqual(["Note.md"]);
		expect(
			templaterFeature.excludedFolders?.(normalizePluginOptions({ enableTemplater: true })),
		).toEqual([]);
	});
});

describe("settings", () => {
	test("site options win over the vault's data.json", () => {
		const root = vaultWith({
			[SETTINGS]: JSON.stringify({
				templates_folder: "Templates",
				user_scripts_folder: "Scripts",
				trigger_on_file_creation: false,
				enable_folder_templates: true,
				folder_templates: [{ folder: "A", template: "T.md" }, { folder: "B" }, "junk"],
				file_templates: [{ regex: ".*", template: "R.md" }],
				ignore_folders_on_creation: [{ folder: "/Archive/" }, { nope: 1 }],
				enable_system_commands: true,
				templates_pairs: [["shell", "echo"], ["", "x"], "junk"],
			}),
		});
		const vault = resolveTemplaterSettings(normalizePluginOptions({ vaultRoot: root }));
		expect(vault).toMatchObject({
			templatesFolder: "Templates",
			userScriptsFolder: "Scripts",
			triggerOnFileCreation: false,
			folderTemplates: [{ folder: "A", template: "T.md" }],
			fileTemplates: [],
			ignoreFolders: ["Archive"],
			systemCommands: ["shell"],
			renderCommands: "dynamic",
			now: undefined,
		});

		const overridden = resolveTemplaterSettings(
			normalizePluginOptions({
				vaultRoot: root,
				templater: {
					templatesFolder: "Other",
					userScriptsFolder: "",
					triggerOnFileCreation: true,
					fileTemplates: [{ regex: "x", template: "X.md" }],
					folderTemplates: [],
					ignoreFolders: [],
					renderCommands: "all",
					now: new Date(2020, 0, 1),
				},
			}),
		);
		expect(overridden).toMatchObject({
			templatesFolder: "Other",
			userScriptsFolder: "",
			triggerOnFileCreation: true,
			folderTemplates: [],
			fileTemplates: [{ regex: "x", template: "X.md" }],
			ignoreFolders: [],
			renderCommands: "all",
			now: new Date(2020, 0, 1),
		});

		const ignored = resolveTemplaterSettings(
			normalizePluginOptions({ vaultRoot: root, templater: { readVaultSettings: false } }),
		);
		expect(ignored).toMatchObject({
			templatesFolder: "",
			triggerOnFileCreation: true,
			folderTemplates: [],
		});
	});

	test("the second settings layout and a vault without settings", () => {
		const root = vaultWith({
			[SETTINGS]: JSON.stringify({
				data_version: 2,
				trigger_on_file_creation_mode: "regex",
				file_templates: [{ regex: "^Books/", template: "Book.md" }],
				folder_templates: [{ folder: "A", template: "T.md" }],
			}),
		});
		expect(resolveTemplaterSettings(normalizePluginOptions({ vaultRoot: root }))).toMatchObject({
			triggerOnFileCreation: true,
			folderTemplates: [],
			fileTemplates: [{ regex: "^Books/", template: "Book.md" }],
			systemCommands: [],
		});
		expect(resolveTemplaterSettings(normalizePluginOptions({}))).toMatchObject({
			templatesFolder: "",
			triggerOnFileCreation: true,
			folderTemplates: [],
			fileTemplates: [],
		});
	});

	test("the pinned clock accepts a date or date-time string, and reports anything else once", async () => {
		const at = (now: string) =>
			resolveTemplaterSettings(normalizePluginOptions({ templater: { now } })).now;
		expect(at("2024-05-03")).toEqual(new Date(2024, 4, 3));
		expect(at("2024-05-03T10:20")).toEqual(new Date(2024, 4, 3, 10, 20));
		expect(at("2024-05-03 10:20")).toEqual(new Date(2024, 4, 3, 10, 20));
		expect(
			resolveTemplaterSettings(normalizePluginOptions({ templater: { now: new Date(Number.NaN) } }))
				.now,
		).toBe(undefined);

		const vault = site({ "A.md": "<%+ 1 %>", "B.md": "<%+ 2 %>" }, { templater: { now: "soon" } });
		const first = await vault.render("A.md");
		const second = await vault.render("B.md");
		expect(first.messages).toEqual([
			expect.stringContaining(
				'The `templater.now` option "soon" is not a date; using the build time.',
			),
		]);
		expect(second.messages).toEqual([]);
	});
});
