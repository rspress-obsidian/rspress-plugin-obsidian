import { describe, expect, test } from "bun:test";
import { buildMentionsIndex, stripMentionText } from "./mentions.ts";
import type { ContentPage } from "./types.ts";

function makePage(overrides: Partial<ContentPage> & { filePathKey: string }): ContentPage {
	const { filePathKey } = overrides;
	const baseName = overrides.baseName ?? filePathKey.split("/").pop() ?? filePathKey;
	return {
		absolutePath: `/vault/${filePathKey}.md`,
		relativePath: `${filePathKey}.md`,
		routePath: `/${filePathKey}`,
		pathKey: filePathKey,
		baseName,
		aliases: [],
		tags: [],
		cssclasses: [],
		publish: true,
		fileCtimeMs: 0,
		fileMtimeMs: 0,
		fileSizeBytes: 0,
		headings: [],
		wikilinkTargets: [],
		headingBySlug: new Map(),
		headingByText: new Map(),
		blocks: [],
		dataviewFields: {},
		dataviewTasks: [],
		dataviewLists: [],
		...overrides,
		filePathKey,
	};
}

describe("stripMentionText", () => {
	test("keeps prose and drops frontmatter, code and comments", () => {
		const source = [
			"---",
			"title: Hidden",
			"---",
			"Backlink target appears here.",
			"",
			"```ts",
			"Backlink target in a fence.",
			"```",
			"`Backlink target in code`",
			"%% Backlink target in a comment %%",
		].join("\n");

		const text = stripMentionText(source);
		expect(text).toContain("Backlink target appears here.");
		expect(text).not.toContain("Hidden");
		expect(text.match(/Backlink target/g)).toHaveLength(1);
	});

	test("keeps a markdown link's label but not its destination", () => {
		expect(stripMentionText("See [Widget Notes](./widget-notes.md) for more.")).toBe(
			"See Widget Notes for more.",
		);
	});

	test("drops wikilinks entirely and keeps a wikilink's display text", () => {
		expect(stripMentionText("Link [[Widget Notes]] here.")).toBe("Link here.");
		expect(stripMentionText("Link [[Other|Widget Notes]] here.")).toBe("Link Widget Notes here.");
	});
});

describe("buildMentionsIndex", () => {
	test("finds a page named without a link", () => {
		const target = makePage({ filePathKey: "widget", title: "Widget Notes" });
		const source = makePage({ filePathKey: "notes/source", title: "Source" });

		const mentions = buildMentionsIndex([
			{ page: target, text: "Widget Notes is my page." },
			{ page: source, text: "I read Widget Notes yesterday and liked it." },
		]);

		expect(mentions.get("/widget")).toEqual([
			{
				routePath: "/notes/source",
				relativePath: "notes/source.md",
				title: "Source",
				snippet: "I read Widget Notes yesterday and liked it.",
			},
		]);
	});

	test("matches an alias and a file basename, case-insensitively", () => {
		const target = makePage({ filePathKey: "notes/widget", aliases: ["Gizmo"] });
		const source = makePage({ filePathKey: "source" });

		const mentions = buildMentionsIndex([
			{ page: target, text: "" },
			{ page: source, text: "the gizmo and GIZMO both count, and widget too" },
		]);

		expect(mentions.get("/notes/widget")?.map((entry) => entry.routePath)).toEqual(["/source"]);
	});

	test("matches a mention across a Unicode normalization difference", () => {
		// macOS hands back a decomposed (NFD) basename while the prose that names
		// it is composed (NFC) — and vice versa for a note typed on macOS.
		const decomposedTarget = makePage({ filePathKey: "cafe\u0301" });
		const composedTarget = makePage({ filePathKey: "caf\u00e9" });
		const source = makePage({ filePathKey: "source" });

		expect(
			buildMentionsIndex([
				{ page: decomposedTarget, text: "" },
				{ page: source, text: "See caf\u00e9 for details." },
			])
				.get(decomposedTarget.routePath)
				?.map((entry) => entry.routePath),
		).toEqual(["/source"]);

		expect(
			buildMentionsIndex([
				{ page: composedTarget, text: "" },
				{ page: source, text: "See cafe\u0301 for details." },
			])
				.get(composedTarget.routePath)
				?.map((entry) => entry.routePath),
		).toEqual(["/source"]);
	});

	test("does not report a page mentioning itself", () => {
		const page = makePage({ filePathKey: "widget", title: "Widget Notes" });
		expect(buildMentionsIndex([{ page, text: "Widget Notes again." }]).size).toBe(0);
	});

	test("skips a name several pages claim rather than guessing", () => {
		const first = makePage({ filePathKey: "a/note", title: "Shared Name" });
		const second = makePage({ filePathKey: "b/note", title: "Shared Name" });
		const source = makePage({ filePathKey: "source" });

		const mentions = buildMentionsIndex([
			{ page: first, text: "" },
			{ page: second, text: "" },
			{ page: source, text: "Shared Name is ambiguous." },
		]);

		expect(mentions.size).toBe(0);
	});

	test("ignores names shorter than three characters", () => {
		const target = makePage({ filePathKey: "ab", title: "Ab" });
		const source = makePage({ filePathKey: "source" });
		expect(
			buildMentionsIndex([
				{ page: target, text: "" },
				{ page: source, text: "Ab is here." },
			]).size,
		).toBe(0);
	});

	test("does not match inside a longer word", () => {
		const target = makePage({ filePathKey: "widget", title: "Widget" });
		const source = makePage({ filePathKey: "source" });

		const mentions = buildMentionsIndex([
			{ page: target, text: "" },
			{ page: source, text: "Widgets and widgetry are not the page." },
		]);

		// "Widgets"/"widgetry" must not count; only the standalone name would.
		expect(mentions.size).toBe(0);
	});

	test("records one entry per mentioning page and caps the list", () => {
		const target = makePage({ filePathKey: "widget", title: "Widget Notes" });
		const sources = Array.from({ length: 30 }, (_, index) =>
			makePage({ filePathKey: `source-${index}` }),
		);

		const mentions = buildMentionsIndex([
			{ page: target, text: "" },
			...sources.map((page) => ({
				page,
				text: "Widget Notes is mentioned repeatedly here. Widget Notes again.",
			})),
		]);

		const entries = mentions.get("/widget") ?? [];
		expect(entries.length).toBeLessThanOrEqual(20);
		expect(new Set(entries.map((entry) => entry.routePath)).size).toBe(entries.length);
	});
});
