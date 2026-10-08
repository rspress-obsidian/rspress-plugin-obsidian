/**
 * Kanban boards through the real remark pipeline: a vault on disk, the
 * plugin's remark pass, remark-rehype — what a reader of the published page
 * gets.
 */
import {
	afterAll,
	afterEach,
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
import { VFile } from "vfile";
import { stripFrontmatter } from "../../../shared/frontmatter.js";
import { getCachedContentIndex } from "../../content-index.js";
import { markdown } from "../../index.js";
import { normalizePluginOptions } from "../../normalize-options.js";
import { remarkWikilink } from "../../remark-wikilink.js";
import type { RspressPluginMarkdownOptions } from "../../types.js";

const vaults: string[] = [];

function makeVault(files: Record<string, string>): string {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kanban-vault-")));
	vaults.push(root);
	for (const [file, content] of Object.entries(files)) {
		const target = path.join(root, file);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content);
	}
	return root;
}

afterAll(() => {
	for (const root of vaults) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Compile `page` of the vault at `root` to HTML. `value` stands in for what
 * the compiler hands the plugin when it differs from the file on disk.
 */
async function render(
	root: string,
	page: string,
	options: RspressPluginMarkdownOptions = {},
	value?: string,
): Promise<{ html: string; file: VFile; doc: Document }> {
	const normalized = normalizePluginOptions({
		vaultRoot: root,
		onBrokenLink: "warn",
		onPluginError: "warn",
		enableKanban: true,
		enableTransclusion: true,
		enableTagLinking: true,
		...options,
		kanban: { now: "2024-05-02", ...options.kanban },
	});
	const processor = unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkWikilink, { getDocsRoot: () => root, options: normalized })
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(rehypeStringify, { allowDangerousHtml: true });
	const absolute = path.resolve(root, page);
	const file = await processor.process(
		new VFile({ value: value ?? fs.readFileSync(absolute, "utf8"), path: absolute }),
	);
	const html = String(file);
	return { html, file, doc: new DOMParser().parseFromString(html, "text/html") };
}

function texts(doc: Document | Element, selector: string): string[] {
	return [...doc.querySelectorAll(selector)].map((element) => element.textContent?.trim() ?? "");
}

function laneByTitle(doc: Document | Element, title: string): Element {
	const lane = [...doc.querySelectorAll(".kanban-plugin__lane")].find(
		(candidate) =>
			candidate.querySelector(".kanban-plugin__lane-title-text")?.textContent?.trim() === title,
	);
	if (!lane) throw new Error(`no lane "${title}"`);
	return lane;
}

function cardByText(doc: Document | Element, text: string): Element {
	const card = [...doc.querySelectorAll(".kanban-plugin__item")].find((candidate) =>
		candidate.querySelector(".kanban-plugin__item-markdown")?.textContent?.includes(text),
	);
	if (!card) throw new Error(`no card "${text}"`);
	return card;
}

let warn: Mock<typeof console.warn>;
beforeEach(() => {
	warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

/** A board exactly as the Kanban plugin saves it. */
const BOARD = `---

kanban-plugin: board

---

## Todo

- [ ] Write the [[Spec]] #design @{2024-05-03}
- [ ] Multi-line card
	second line of the card
	- sub item one
	- sub item two
- [ ] Meeting @{2024-05-01} @@{10:30}
- [ ] Standup @{2024-05-02}


## Doing (1)

- [ ] Draft #urgent
- [ ] Review the plan


## Done

**Complete**
- [x] Shipped ^shipped


***

## Archive

- [x] Old card one
- [x] Old card two

%% kanban:settings
\`\`\`
{"kanban-plugin":"board"}
\`\`\`
%%
`;

function board(lanes: string, settings?: Record<string, unknown>, view = "board"): string {
	const footer = settings
		? `\n%% kanban:settings\n\`\`\`\n${JSON.stringify(settings)}\n\`\`\`\n%%\n`
		: "";
	return `---\n\nkanban-plugin: ${view}\n\n---\n\n${lanes}\n${footer}`;
}

const SPEC = `---
status: drafting
due: 2024-05-10
owner: "[[Alice]]"
reviewers:
  - Bob
  - Carol
tags:
  - spec
---
# Spec
`;

const mainVault = makeVault({
	"Board.md": BOARD,
	"Spec.md": SPEC,
	"Alice.md": "# Alice\n",
	"Home.md": "Intro\n\n![[Board]]\n\nThe lane alone:\n\n![[Board#Doing (1)]]\n",
	"Plain.md": "# Plain\n\n- [ ] not a card #design\n",
	".obsidian/plugins/obsidian-kanban/data.json": JSON.stringify({ "date-display-format": "MMM D" }),
});

describe("a board note renders as a board", () => {
	test("each heading is a lane, in order, holding the cards of its list", async () => {
		const { doc } = await render(mainVault, "Board.md");
		expect(
			doc.querySelectorAll(".kanban-plugin > .kanban-plugin__board.kanban-plugin__horizontal"),
		).toHaveLength(1);
		expect(texts(doc, ".kanban-plugin__lane-title-text")).toEqual(["Todo", "Doing", "Done"]);
		expect(
			texts(laneByTitle(doc, "Todo"), ".kanban-plugin__item-markdown > p:first-child"),
		).toEqual([
			"Write the Spec #design May 3",
			"Multi-line card\nsecond line of the card",
			"Meeting May 1 10:30",
			"Standup May 2",
		]);
		expect(laneByTitle(doc, "Todo").getAttribute("data-count")).toBe("4");
		// The page's heading ids stay on the lanes, so `[[Board#Doing (1)]]` lands there.
		expect([...doc.querySelectorAll(".kanban-plugin__lane")].map((lane) => lane.id)).toEqual([
			"todo",
			"doing-1",
			"done",
		]);
		expect(doc.querySelector("h2")).toBeNull();
	});

	test("a card keeps its continuation lines and nested list", async () => {
		const { doc } = await render(mainVault, "Board.md");
		const card = cardByText(doc, "Multi-line card");
		expect(card.querySelector(".kanban-plugin__item-markdown p")?.innerHTML).toBe(
			"Multi-line card<br>\nsecond line of the card",
		);
		expect(texts(card, ".kanban-plugin__item-markdown ul > li")).toEqual([
			"sub item one",
			"sub item two",
		]);
	});

	test("a WIP limit is stripped from the title and shown, flagged once exceeded", async () => {
		const { doc } = await render(mainVault, "Board.md");
		const doing = laneByTitle(doc, "Doing");
		const count = doing.querySelector(".kanban-plugin__lane-title-count");
		expect(count?.textContent).toBe("2/1");
		expect(count?.classList.contains("wip-exceeded")).toBe(true);
		expect(count?.getAttribute("aria-label")).toBe("2 of 1 cards, over the limit");
		expect(doing.getAttribute("data-max-items")).toBe("1");
		const todoCount = laneByTitle(doc, "Todo").querySelector(".kanban-plugin__lane-title-count");
		expect(todoCount?.classList.contains("wip-exceeded")).toBe(false);
	});

	test("the **Complete** marker marks its lane; a checked card renders completed", async () => {
		const { doc } = await render(mainVault, "Board.md");
		expect(laneByTitle(doc, "Done").getAttribute("data-complete")).toBe("true");
		expect(laneByTitle(doc, "Todo").hasAttribute("data-complete")).toBe(false);
		const shipped = cardByText(doc, "Shipped");
		expect(shipped.classList.contains("is-complete")).toBe(true);
		expect(cardByText(doc, "Draft").classList.contains("is-complete")).toBe(false);
		// The block id leaves the text and becomes the anchor `[[Board#^shipped]]` targets.
		expect(shipped.querySelector(".kanban-plugin__item-markdown")?.textContent).toBe("Shipped");
		expect(shipped.querySelector('[id="^shipped"]')).not.toBeNull();
	});

	test("cards resolve links and tags through the page pipeline", async () => {
		const { doc } = await render(mainVault, "Board.md");
		const card = cardByText(doc, "Write the");
		expect(card.querySelector('a[href="/Spec"]')?.textContent).toBe("Spec");
		expect(card.querySelector('a[href="/tags/design"]')?.textContent).toBe("#design");
		expect(card.classList.contains("has-tag-design")).toBe(true);
	});

	test("the archive is hidden unless `showArchive`, which keeps the newest `maxArchiveSize` cards", async () => {
		const hidden = await render(mainVault, "Board.md");
		expect(hidden.html).not.toContain("Old card");
		expect(hidden.doc.querySelector(".kanban-plugin__archive")).toBeNull();

		const shown = await render(mainVault, "Board.md", { kanban: { showArchive: true } });
		const archive = shown.doc.querySelector(".kanban-plugin__archive");
		expect(archive?.querySelector(".kanban-plugin__lane-title-text")?.textContent).toBe("Archive");
		expect(texts(archive ?? shown.doc, ".kanban-plugin__item-markdown")).toEqual([
			"Old card one",
			"Old card two",
		]);

		const capped = await render(mainVault, "Board.md", {
			kanban: { showArchive: true, maxArchiveSize: 1 },
		});
		expect(texts(capped.doc, ".kanban-plugin__archive .kanban-plugin__item-markdown")).toEqual([
			"Old card two",
		]);
		const none = await render(mainVault, "Board.md", {
			kanban: { showArchive: true, maxArchiveSize: 0 },
		});
		expect(none.doc.querySelectorAll(".kanban-plugin__archive .kanban-plugin__item")).toHaveLength(
			0,
		);
	});

	test("dates show in the display format and class the card against the pinned now", async () => {
		const { doc } = await render(mainVault, "Board.md");
		const written = cardByText(doc, "Write the");
		expect(written.classList.contains("is-future")).toBe(true);
		const date = written.querySelector(".kanban-plugin__preview-date-wrapper");
		expect(date?.getAttribute("data-date")).toBe("2024-05-03T00:00:00");
		expect(date?.classList.contains("kanban-plugin__date")).toBe(true);
		expect(cardByText(doc, "Standup").classList.contains("is-today")).toBe(true);
		const meeting = cardByText(doc, "Meeting");
		expect(meeting.classList.contains("is-past")).toBe(true);
		expect(
			meeting.querySelector(".kanban-plugin__preview-time-wrapper")?.getAttribute("data-date"),
		).toBe("2024-05-01T10:30:00");
		expect(texts(meeting, ".kanban-plugin__item-metadata-time")).toEqual(["10:30"]);

		const later = await render(mainVault, "Board.md", { kanban: { now: "2024-06-01" } });
		expect(cardByText(later.doc, "Standup").classList.contains("is-past")).toBe(true);
	});

	test("a page compiled without its frontmatter, as Rspress compiles it, is still a board", async () => {
		const { doc } = await render(mainVault, "Board.md", {}, stripFrontmatter(BOARD));
		expect(texts(doc, ".kanban-plugin__lane-title-text")).toEqual(["Todo", "Doing", "Done"]);
		expect(laneByTitle(doc, "Doing").id).toBe("doing-1");
	});

	test("a page with no file of its own, or with broken frontmatter, is not a board", async () => {
		const outside = makeVault({});
		const generated = await render(
			mainVault,
			path.join(outside, "generated.md"),
			{},
			"## Lane\n\n- card\n",
		);
		expect(generated.html).not.toContain("kanban-plugin");
		const broken = makeVault({
			"Bad.md": "---\nkanban-plugin: [board\n---\n\n## Lane\n\n- card\n",
		});
		const { html } = await render(broken, "Bad.md", {}, "## Lane\n\n- card\n");
		expect(html).not.toContain("kanban-plugin__board");
	});

	test("a non-board note is left alone", async () => {
		const { doc, html } = await render(mainVault, "Plain.md");
		expect(html).not.toContain("kanban-plugin");
		expect(doc.querySelector("h1")?.textContent).toBe("Plain");
		expect(doc.querySelector("li input[type=checkbox]")).not.toBeNull();
	});

	test("with `enableKanban` off the board stays a note", async () => {
		const { html, doc } = await render(mainVault, "Board.md", { enableKanban: false });
		expect(html).not.toContain("kanban-plugin__board");
		expect(texts(doc, "h2")).toContain("Doing (1)");
	});
});

describe("embeds", () => {
	test("`![[Board]]` embeds the board; `![[Board#Doing (1)]]` is a plain section", async () => {
		const { doc } = await render(mainVault, "Home.md");
		const [whole, section] = [...doc.querySelectorAll(".obsidian-transclusion")];
		expect(whole?.querySelector(".kanban-plugin__board")).not.toBeNull();
		expect(texts(whole ?? doc, ".kanban-plugin__lane-title-text")).toEqual([
			"Todo",
			"Doing",
			"Done",
		]);
		// The board's ids are namespaced like an embedded note's heading ids.
		expect(
			[...(whole?.querySelectorAll(".kanban-plugin__lane[id]") ?? [])].map((lane) => lane.id),
		).toEqual(["embed-1-todo", "embed-1-doing-1", "embed-1-done"]);
		expect(whole?.querySelector('[id="embed-1-^shipped"]')).not.toBeNull();

		expect(section?.querySelector(".kanban-plugin")).toBeNull();
		expect(section?.querySelector("h2")?.textContent).toContain("Doing (1)");
		expect(texts(section ?? doc, "li")).toEqual(["Draft #urgent", "Review the plan"]);
	});

	test("a board embedded twice on one page repeats no id, and none clashes with the page's", async () => {
		const twice = makeVault({
			"Board.md": BOARD,
			"Spec.md": SPEC,
			"Twice.md":
				"## Todo\n\n![[Board]]\n\n![[Board]]\n\nSee [[Twice#^shipped]].\n\nOwn line ^shipped\n",
		});
		const { doc } = await render(twice, "Twice.md");
		const ids = [...doc.querySelectorAll("[id]")].map((element) => element.id);
		expect(doc.querySelectorAll(".obsidian-transclusion .kanban-plugin__board")).toHaveLength(2);
		expect(ids.filter((id) => id.endsWith("todo"))).toEqual([
			"todo",
			"embed-1-todo",
			"embed-2-todo",
		]);
		expect(ids.filter((id) => id.endsWith("^shipped"))).toEqual([
			"embed-1-^shipped",
			"embed-2-^shipped",
			"^shipped",
		]);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("settings", () => {
	const vault = makeVault({
		"Defaults.md": board("## Lane\n\n- [ ] Card @{2024-05-03}\n"),
		"Own.md": board("## Lane\n\n- [ ] Card @{2024-05-03}\n", { "date-display-format": "D MMMM" }),
		"Front.md":
			'---\nkanban-plugin: board\ndate-display-format: \'[Due] DD.MM\'\n---\n\n## Lane\n\n- [ ] Card @{2024-05-03}\n\n%% kanban:settings\n```\n{"date-display-format":"D MMMM"}\n```\n%%\n',
		".obsidian/plugins/obsidian-kanban/data.json": JSON.stringify({
			"date-display-format": "MMM D",
		}),
	});
	const displayed = async (page: string, options: RspressPluginMarkdownOptions = {}) =>
		texts((await render(vault, page, options)).doc, ".kanban-plugin__preview-date");

	test("board settings win over the site options, which win over the vault, which wins over defaults", async () => {
		expect(await displayed("Defaults.md")).toEqual(["May 3"]);
		expect(await displayed("Defaults.md", { kanban: { dateDisplayFormat: "YYYY/MM/DD" } })).toEqual(
			["2024/05/03"],
		);
		expect(await displayed("Own.md", { kanban: { dateDisplayFormat: "YYYY/MM/DD" } })).toEqual([
			"3 May",
		]);
		expect(await displayed("Defaults.md", { kanban: { readVaultSettings: false } })).toEqual([
			"2024-05-03",
		]);
	});

	test("a setting in the board's frontmatter wins over its settings block", async () => {
		expect(await displayed("Front.md")).toEqual(["Due 03.05"]);
	});

	test("the date format defaults to the daily-notes format", async () => {
		const daily = makeVault({ "B.md": board("## L\n\n- [ ] Card @{03-05-2024}\n") });
		const { doc } = await render(daily, "B.md", {
			enableDailyNotes: true,
			dailyNotes: { dateFormat: "DD-MM-YYYY" },
		});
		expect(texts(doc, ".kanban-plugin__preview-date")).toEqual(["03-05-2024"]);
	});

	test("malformed settings JSON shows an error in place, reports it, and renders with the global settings", async () => {
		const broken = makeVault({
			"Broken.md": board("## Lane\n\n- [ ] Card @{2024-05-03}\n").replace(
				/\n$/,
				'\n%% kanban:settings\n```\n{"date-display-format": "D MMMM",}\n```\n%%\n',
			),
			"NoFence.md": `${board("## Lane\n\n- [ ] Card\n")}\n%% kanban:settings\n{"a":1}\n%%\n`,
			"Array.md": board("## Lane\n\n- [ ] Card\n").replace(
				/\n$/,
				"\n%% kanban:settings\n```\n[1]\n```\n%%\n",
			),
		});
		const { doc, file } = await render(broken, "Broken.md");
		const error = doc.querySelector(".kanban-plugin > .kanban-plugin__error");
		expect(error?.getAttribute("role")).toBe("alert");
		expect(error?.textContent).toContain(
			'The Kanban settings of "Broken.md" cannot be read: the block is not valid JSON',
		);
		expect(texts(doc, ".kanban-plugin__preview-date")).toEqual(["2024-05-03"]);
		expect(
			file.messages
				.map(String)
				.some((message) => message.includes("[rspress-plugin-obsidian:markdown:kanban]")),
		).toBe(true);

		expect(
			(await render(broken, "NoFence.md")).doc.querySelector(".kanban-plugin__error")?.textContent,
		).toContain("the block has no ``` fence holding its JSON");
		expect(
			(await render(broken, "Array.md")).doc.querySelector(".kanban-plugin__error")?.textContent,
		).toContain("the block's JSON is not an object");

		await expect(render(broken, "Broken.md", { onPluginError: "error" })).rejects.toThrow();
	});

	test("an unparseable `now` is reported and the build's clock is used", async () => {
		const { file, doc } = await render(vault, "Defaults.md", { kanban: { now: "not a date" } });
		expect(
			file.messages
				.map(String)
				.some((message) => message.includes("`kanban.now` (not a date) is not a date")),
		).toBe(true);
		expect(doc.querySelector(".kanban-plugin__board")).not.toBeNull();
	});
});

describe("card metadata", () => {
	const vault = makeVault({
		"Moved.md": board(
			"## Lane\n\n- [ ] Plan #urgent @{2024-05-03}\n- [ ] Retro #team @{2024-05-09} @@{16:00}\n- [ ] Old @{2024-04-01}\n- [ ] Nothing dated\n",
			{
				"move-dates": true,
				"move-tags": true,
				"show-relative-date": true,
				"link-date-to-daily-note": true,
			},
		),
		"Triggers.md": board(
			"## Lane\n\n- [ ] Call due:{03/05/2024} at:{2:30 PM}\n- [ ] Untouched @{2024-05-03}\n- [ ] Bad due:{31/02/2024}\n",
			{
				"date-trigger": "due:",
				"time-trigger": "at:",
				"date-format": "DD/MM/YYYY",
				"time-format": "h:mm A",
				"date-display-format": "dddd",
			},
		),
		"Linked.md": board(
			"## Lane\n\n- [ ] See @[[2024-05-03]] for notes\n- [ ] `code @{2024-05-03}` stays\n",
		),
		"Legacy.md": board("## Lane\n\n- [ ] Plan #urgent @{2024-05-03}\n", {
			"hide-tags-in-title": true,
			"hide-tags-display": true,
			"hide-date-in-title": true,
		}),
		"Loose.md": board(
			"## Lane\n\n- [ ] Short @{5/3/2024}\n- [ ] Dashed @{05-03-2024}\n- [ ] Yearless @{5/9}\n- [ ] Timed @{5/3/2024} @@{9:5}\n- [ ] Vague @{soon}\n- [ ] Impossible @{2/30/2024}\n",
			{
				"date-format": "MM/DD/YYYY",
				"date-display-format": "YYYY-MM-DD",
				"show-relative-date": true,
			},
		),
		"Meta.md": board(
			"## Lane\n\n- [ ] Work on [[Spec]] today\n- [ ] Mention [[Missing]]\n- [ ] See [the spec](Spec.md)\n",
		),
		"Spec.md": SPEC,
		"Alice.md": "# Alice\n",
		"2024-05-03.md": "# Friday\n",
	});

	test("move-dates and move-tags take dates and tags under the card", async () => {
		const { doc } = await render(vault, "Moved.md");
		const plan = cardByText(doc, "Plan");
		expect(plan.querySelector(".kanban-plugin__item-markdown")?.textContent).toBe("Plan");
		expect(texts(plan, ".kanban-plugin__item-metadata-date-relative")).toEqual(["tomorrow"]);
		expect(plan.querySelector(".kanban-plugin__item-metadata-date a")?.getAttribute("href")).toBe(
			"/2024-05-03",
		);
		expect(texts(plan, ".kanban-plugin__item-tags .kanban-plugin__item-tag")).toEqual(["#urgent"]);
		expect(plan.querySelector(".kanban-plugin__item-tag")?.getAttribute("href")).toBe(
			"/tags/urgent",
		);

		const retro = cardByText(doc, "Retro");
		// A timed card counts from now: 7 days 16 hours rounds up, as Moment does.
		expect(texts(retro, ".kanban-plugin__item-metadata-date-relative")).toEqual(["in 8 days"]);
		// No daily note for that day: the date says so instead of linking nowhere.
		expect(
			retro.querySelector(".kanban-plugin__item-metadata-date .is-unresolved")?.textContent,
		).toBe("2024-05-09");
		expect(texts(retro, ".kanban-plugin__item-metadata-time")).toEqual(["16:00"]);
		expect(texts(cardByText(doc, "Old"), ".kanban-plugin__item-metadata-date-relative")).toEqual([
			"a month ago",
		]);
		expect(
			cardByText(doc, "Nothing dated").querySelector(".kanban-plugin__item-metadata"),
		).toBeNull();
	});

	test("triggers and formats come from the settings", async () => {
		const { doc } = await render(vault, "Triggers.md");
		const call = cardByText(doc, "Call");
		expect(texts(call, ".kanban-plugin__preview-date")).toEqual(["Friday"]);
		expect(texts(call, ".kanban-plugin__preview-time")).toEqual(["2:30 PM"]);
		expect(call.classList.contains("is-future")).toBe(true);
		expect(texts(cardByText(doc, "Untouched"), ".kanban-plugin__item-markdown")).toEqual([
			"Untouched @{2024-05-03}",
		]);
		// A date that does not exist stays as written, as Kanban leaves an invalid one.
		expect(texts(cardByText(doc, "Bad"), ".kanban-plugin__item-markdown")).toEqual([
			"Bad due:{31/02/2024}",
		]);
	});

	test("card dates read forgivingly, as Kanban's `moment(text, format)` reads them", async () => {
		const { doc } = await render(vault, "Loose.md");
		const relatives: Record<string, string> = {
			Short: "tomorrow",
			Dashed: "tomorrow",
			// A timed card counts from the pinned now (midnight): 33 hours is "a day".
			Timed: "in a day",
		};
		for (const [text, relative] of Object.entries(relatives)) {
			const card = cardByText(doc, text);
			expect([text, texts(card, ".kanban-plugin__preview-date")]).toEqual([text, ["2024-05-03"]]);
			expect(texts(card, ".kanban-plugin__item-metadata-date-relative")).toEqual([relative]);
		}
		// The missing year is the pinned now's.
		expect(texts(cardByText(doc, "Yearless"), ".kanban-plugin__preview-date")).toEqual([
			"2024-05-09",
		]);
		expect(texts(cardByText(doc, "Timed"), ".kanban-plugin__preview-time")).toEqual(["09:05"]);
		// Text with no date in it, or a day that does not exist, stays as written.
		expect(texts(cardByText(doc, "Vague"), ".kanban-plugin__item-markdown")).toEqual([
			"Vague @{soon}",
		]);
		expect(texts(cardByText(doc, "Impossible"), ".kanban-plugin__item-markdown")).toEqual([
			"Impossible @{2/30/2024}",
		]);
	});

	test("`@[[date]]` stays a link in the card; dates in code are code", async () => {
		const { doc } = await render(vault, "Linked.md");
		const linked = cardByText(doc, "See");
		const wrapper = linked.querySelector(".kanban-plugin__preview-date-link");
		expect(wrapper?.querySelector("a")?.getAttribute("href")).toBe("/2024-05-03");
		expect(wrapper?.textContent).toBe("2024-05-03");
		expect(cardByText(doc, "stays").querySelector("code")?.textContent).toBe("code @{2024-05-03}");
	});

	test("Kanban 1.x hide-* settings still hide tags and dates", async () => {
		const { doc } = await render(vault, "Legacy.md");
		const plan = cardByText(doc, "Plan");
		expect(plan.querySelector(".kanban-plugin__item-markdown")?.textContent).toBe("Plan");
		expect(plan.querySelector(".kanban-plugin__item-tags")).toBeNull();
	});

	test("metadata keys show the linked note's properties under the card", async () => {
		const { doc } = await render(vault, "Meta.md", {
			kanban: {
				metadataKeys: [
					{ metadataKey: "status", label: "Status" },
					{ metadataKey: "due" },
					{ metadataKey: "owner", shouldHideLabel: true },
					{ metadataKey: "reviewers", label: "Reviewers" },
					{ metadataKey: "tags" },
					{ metadataKey: "absent" },
				],
				dateDisplayFormat: "MMM D",
			},
		});
		const card = cardByText(doc, "Work on");
		const rows = [...card.querySelectorAll(".kanban-plugin__meta-table tr")];
		expect(
			rows.map((row) => row.querySelector(".kanban-plugin__meta-key")?.textContent ?? ""),
		).toEqual(["Status", "due", "", "Reviewers", "tags"]);
		expect(rows[0]?.querySelector(".kanban-plugin__meta-value")?.textContent).toBe("drafting");
		expect(rows[1]?.querySelector(".kanban-plugin__item-metadata-date")?.textContent).toBe(
			"May 10",
		);
		expect(rows[2]?.querySelector("td")?.getAttribute("colspan")).toBe("2");
		expect(rows[2]?.querySelector('a[href="/Alice"]')?.textContent).toBe("Alice");
		expect(rows[3]?.textContent).toContain("Bob, Carol");
		expect(texts(rows[4] ?? doc, ".kanban-plugin__item-tag")).toEqual(["#spec"]);
		expect(cardByText(doc, "Mention").querySelector(".kanban-plugin__meta-table")).toBeNull();
		// A markdown link to a note counts as the card's link too.
		expect(cardByText(doc, "the spec").querySelector(".kanban-plugin__meta-table")).not.toBeNull();
	});

	test("tag colours colour the tags under the card and in its text", async () => {
		const tagColors = [{ tagKey: "#urgent", color: "red", backgroundColor: "rgb(255, 0, 0, 0.1)" }];
		const moved = await render(vault, "Moved.md", { kanban: { tagColors } });
		expect(moved.doc.querySelector(".kanban-plugin__item-tag")?.getAttribute("style")).toBe(
			"--tag-color: red; --tag-background: rgb(255, 0, 0, 0.1);",
		);
		const inline = await render(vault, "Legacy.md", {
			kanban: { tagColors: [...tagColors, { tagKey: "#x", color: "url(javascript:1)" }] },
		});
		const style = inline.doc.querySelector(".kanban-plugin > style")?.textContent ?? "";
		expect(style).toContain(
			'.kanban-plugin__item-markdown a[href$="/tags/urgent"] { color: red; background-color: rgb(255, 0, 0, 0.1); }',
		);
		// In dark mode the colour is lightened, so it stays readable on the dark card.
		const board = inline.doc.querySelector(".kanban-plugin")?.getAttribute("data-kanban-board");
		expect(style).toContain(
			`.dark [data-kanban-board="${board}"] .kanban-plugin__item-markdown a[href$="/tags/urgent"] { color: color-mix(in srgb, red 45%, #fff); }`,
		);
		// Not a plain colour: dropped rather than written into the page's CSS.
		expect(style).not.toContain("javascript");
		const backgroundOnly = await render(vault, "Legacy.md", {
			kanban: { tagColors: [{ tagKey: "#urgent", backgroundColor: "yellow" }] },
		});
		const plain = backgroundOnly.doc.querySelector(".kanban-plugin > style")?.textContent ?? "";
		expect(plain).toContain("{ background-color: yellow; }");
		expect(plain).not.toContain(".dark");
	});

	test("date colours follow the pinned now", async () => {
		const { doc } = await render(vault, "Moved.md", {
			kanban: {
				dateColors: [
					{ isToday: true, color: "orange" },
					{ isBefore: true, color: "red", backgroundColor: "pink" },
					{ distance: 1, unit: "days", direction: "after", color: "blue" },
					{ isAfter: true, color: "gray" },
				],
			},
		});
		const style = (text: string) =>
			cardByText(doc, text).querySelector(".kanban-plugin__item-metadata-date-wrapper");
		expect(style("Plan")?.getAttribute("style")).toBe("--date-color: blue;");
		expect(style("Retro")?.getAttribute("style")).toBe("--date-color: gray;");
		expect(style("Old")?.getAttribute("style")).toBe(
			"--date-color: red; --date-background-color: pink;",
		);
		expect(style("Old")?.classList.contains("has-background")).toBe(true);
	});
});

describe("inline metadata", () => {
	const vault = makeVault({
		"Fields.md": board(
			"## Lane\n\n- [ ] Ship [owner:: Bob] [priority:: high] 📅 2024-05-05 ⏫\n- [ ] Plain card\n",
			{ "inline-metadata-position": "footer", "move-task-metadata": true },
		),
		"Table.md": board("## Lane\n\n- [ ] Ship [owner:: [[Bob]]] [size:: 3]\n", {
			"inline-metadata-position": "metadata-table",
			"metadata-keys": [
				{ metadataKey: "size", label: "Size", shouldHideLabel: false, containsMarkdown: false },
			],
		}),
		"Body.md": board("## Lane\n\n- [ ] Ship [owner:: Bob]\n"),
		"Bob.md": "# Bob\n",
	});

	test("footer fields and moved task fields leave the text for the card's footer", async () => {
		const { doc } = await render(vault, "Fields.md", { enableDataview: true, enableTasks: true });
		const card = cardByText(doc, "Ship");
		expect(card.querySelector(".kanban-plugin__item-markdown")?.textContent).toBe("Ship");
		const items = [...card.querySelectorAll(".kanban-plugin__item-task-inline-metadata-item")];
		expect(items.map((item) => item.textContent)).toEqual([
			"owner: Bob",
			"Priority: high",
			"📅2024-05-05",
			"⏫",
		]);
		expect(items[0]?.classList.contains("kanban-plugin__inline-metadata__owner")).toBe(true);
		expect(items[2]?.classList.contains("is-emoji")).toBe(true);
		expect(items[2]?.classList.contains("is-date")).toBe(true);
		expect(items[1]?.classList.contains("is-task-metadata")).toBe(true);
	});

	test("without Dataview or Tasks the fields are card text", async () => {
		const { doc } = await render(vault, "Fields.md");
		expect(cardByText(doc, "Ship").querySelector(".kanban-plugin__item-task-metadata")).toBeNull();
		const onlyTasks = await render(vault, "Fields.md", { enableTasks: true });
		expect(
			texts(cardByText(onlyTasks.doc, "Ship"), ".kanban-plugin__item-task-inline-metadata-item"),
		).toEqual(["📅2024-05-05", "⏫"]);
	});

	test("fields merge into the metadata table when asked", async () => {
		const { doc } = await render(vault, "Table.md", { enableDataview: true });
		const rows = [...cardByText(doc, "Ship").querySelectorAll(".kanban-plugin__meta-table tr")];
		expect(rows.map((row) => row.querySelector(".kanban-plugin__meta-key")?.textContent)).toEqual([
			"owner",
			"Size",
		]);
		expect(rows[0]?.querySelector('a[href="/Bob"]')).not.toBeNull();
	});

	test("body fields stay in the card text", async () => {
		const { doc } = await render(vault, "Body.md", { enableDataview: true });
		expect(cardByText(doc, "Ship").querySelector(".kanban-plugin__item-task-metadata")).toBeNull();
	});
});

describe("views and layout settings", () => {
	const lanes =
		"## To do\n\n- [ ] One #a @{2024-05-03}\n- [x] Two\n\n## Done\n\n**Complete**\n- [x] Three\n";
	const vault = makeVault({
		"List.md": board(lanes, { "full-list-lane-width": true }, "list"),
		"Table.md": board(
			lanes,
			{ "move-dates": true, "move-tags": true, "show-relative-date": true },
			"table",
		),
		"Layout.md": board(lanes, {
			"lane-width": 320,
			"hide-card-count": true,
			"show-checkboxes": true,
			"list-collapse": [false, true],
		}),
		"Styled.md": "---\nkanban-plugin: basic\ncssclasses: [wide]\n---\n\n## Empty lane\n\n## (3)\n",
	});

	test("the list view stacks the lanes", async () => {
		const { doc } = await render(vault, "List.md");
		expect(doc.querySelector(".kanban-plugin")?.getAttribute("data-kanban-view")).toBe("list");
		expect(doc.querySelector(".kanban-plugin__board.kanban-plugin__vertical")).not.toBeNull();
		expect(doc.querySelector(".kanban-plugin__lane-wrapper")?.getAttribute("style")).toBe(
			"width: 100%",
		);
	});

	test("the table view is one row per card", async () => {
		const { doc } = await render(vault, "Table.md", { kanban: { showArchive: true } });
		const table = doc.querySelector(".kanban-plugin__table-wrapper table");
		expect(texts(table ?? doc, "thead th")).toEqual(["Card", "List", "Date", "Tags"]);
		const rows = [...(table?.querySelectorAll("tbody tr") ?? [])].map((row) =>
			[...row.querySelectorAll("td")].map((cell) => cell.textContent?.trim()),
		);
		expect(rows).toEqual([
			["One", "To do", "tomorrow2024-05-03", "#a"],
			["Two", "To do", "", ""],
			["Three", "Done", "", ""],
		]);
		expect(doc.querySelector(".kanban-plugin__table-wrapper")?.getAttribute("tabindex")).toBe("0");
	});

	test("lane width, card count, checkboxes and collapsed lanes follow the settings", async () => {
		const { doc } = await render(vault, "Layout.md");
		expect(doc.querySelector(".kanban-plugin")?.getAttribute("style")).toBe("--lane-width: 320px");
		expect(doc.querySelector(".kanban-plugin__lane-wrapper")?.getAttribute("style")).toBe(
			"width: 320px",
		);
		expect(doc.querySelector(".kanban-plugin__lane-title-count")).toBeNull();
		const boxes = [...doc.querySelectorAll(".kanban-plugin__item input.task-list-item-checkbox")];
		expect(
			boxes.map((box) => [box.hasAttribute("checked"), box.getAttribute("data-task")]),
		).toEqual([
			[false, " "],
			[true, "x"],
			[true, "x"],
		]);
		expect(boxes.every((box) => box.hasAttribute("disabled"))).toBe(true);
		const collapsed = doc.querySelectorAll(".kanban-plugin__lane-wrapper")[1];
		expect(collapsed?.classList.contains("collapse-horizontal")).toBe(true);
		expect(collapsed?.querySelector("details > summary")?.textContent).toBe("1 card");
	});

	test("`basic` is a board; frontmatter classes reach the board; empty lanes stay", async () => {
		const { doc } = await render(vault, "Styled.md");
		expect(doc.querySelector(".kanban-plugin.wide")?.getAttribute("data-kanban-view")).toBe(
			"board",
		);
		expect(texts(doc, ".kanban-plugin__lane-title-text")).toEqual(["Empty lane", ""]);
		expect(texts(doc, ".kanban-plugin__lane-title-count")).toEqual(["0", "0/3"]);
	});

	test("the board scrolls on its own and takes keyboard focus", async () => {
		const { doc } = await render(vault, "Layout.md");
		const scroller = doc.querySelector(".kanban-plugin__board");
		expect(scroller?.getAttribute("tabindex")).toBe("0");
		expect(scroller?.getAttribute("role")).toBe("region");
		expect(scroller?.getAttribute("aria-label")).toBe("Kanban board: Layout");
	});
});

describe("the index sees the board's markdown", () => {
	test("a link in a card is a backlink; a tag in a card is the board's tag", async () => {
		const { doc } = await render(mainVault, "Spec.md", { enableBacklinks: true });
		expect(
			[...doc.querySelectorAll("a")].some((link) => link.getAttribute("href") === "/Board"),
		).toBe(true);
		const index = await getCachedContentIndex(mainVault);
		const page = index.byFilePathKey.get("Board");
		expect(page?.tags).toEqual(expect.arrayContaining(["design", "urgent"]));
		expect(index.backlinks.get("/Spec")?.map((ref) => ref.routePath)).toContain("/Board");
	});
});

describe("end to end through `markdown()`", () => {
	test("the plugin's own remark tuple renders a vault board", async () => {
		const plugin = markdown({
			vaultRoot: mainVault,
			enableKanban: true,
			onBrokenLink: "warn",
			kanban: { now: "2024-05-02" },
		});
		const plugins: unknown[] = plugin.markdown?.remarkPlugins ?? [];
		const tuple = plugins[0];
		if (!Array.isArray(tuple)) throw new Error("expected a remark plugin tuple");
		const absolute = path.join(mainVault, "Board.md");
		const file = await unified()
			.use(remarkParse)
			.use(remarkGfm)
			.use(tuple[0], tuple[1])
			.use(remarkRehype, { allowDangerousHtml: true })
			.use(rehypeStringify, { allowDangerousHtml: true })
			.process(new VFile({ value: fs.readFileSync(absolute, "utf8"), path: absolute }));
		const doc = new DOMParser().parseFromString(String(file), "text/html");
		expect(texts(doc, ".kanban-plugin__lane-title-text")).toEqual(["Todo", "Doing", "Done"]);
		expect(cardByText(doc, "Write the").querySelector('a[href="/vault/Spec"]')).not.toBeNull();
	});
});
