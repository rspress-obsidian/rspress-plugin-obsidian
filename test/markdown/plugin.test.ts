import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { PageIndexInfo } from "@rspress/shared";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { buildContentIndex, getCachedContentIndex } from "../../src/markdown/content-index";
import { formatDailyNoteDate, parseDailyNoteDate } from "../../src/markdown/daily-notes";
import { findWikilinkMatches, parseWikiLink } from "../../src/markdown/parse-wikilink";
import { remarkWikilink } from "../../src/markdown/remark-wikilink";
import { resolveWikiLink } from "../../src/markdown/resolve-wikilink";
import type { NormalizedPluginOptions } from "../../src/markdown/types";
import { AUDIO_EXTS, IMAGE_EXTS, PDF_EXT, VIDEO_EXTS } from "../../src/shared/media-exts.js";

const fixtureRoot = path.resolve(process.cwd(), "test/markdown/fixtures/basic");
const assetsFixtureRoot = path.resolve(process.cwd(), "test/markdown/fixtures/assets");
const strictFixtureRoot = path.resolve(process.cwd(), "test/markdown/fixtures/strict");
const headingFixtureRoot = path.resolve(process.cwd(), "test/markdown/fixtures/headings");
const aliasFixtureRoot = path.resolve(process.cwd(), "test/markdown/fixtures/aliases");
const aliasAmbiguousFixtureRoot = path.resolve(
	process.cwd(),
	"test/markdown/fixtures/alias-ambiguous",
);
const inlineBlocksFixtureRoot = path.resolve(process.cwd(), "test/markdown/fixtures/inline-blocks");
const tagsFixtureRoot = path.resolve(process.cwd(), "test/markdown/fixtures/tags");
const setextFixtureRoot = path.resolve(process.cwd(), "test/markdown/fixtures/setext");
const cssclassesFixtureRoot = path.resolve(process.cwd(), "test/markdown/fixtures/cssclasses");
const nestedTagsFixtureRoot = path.resolve(process.cwd(), "test/markdown/fixtures/nested-tags");
const publishFixtureRoot = path.resolve(process.cwd(), "test/markdown/fixtures/publish");
const complexYamlFixtureRoot = path.resolve(process.cwd(), "test/markdown/fixtures/complex-yaml");
const recursiveTransclusionFixtureRoot = path.resolve(
	process.cwd(),
	"test/markdown/fixtures/recursive-transclusion",
);
const circularTransclusionFixtureRoot = path.resolve(
	process.cwd(),
	"test/markdown/fixtures/circular-transclusion",
);
const deepTransclusionFixtureRoot = path.resolve(
	process.cwd(),
	"test/markdown/fixtures/deep-transclusion",
);
const transclusionFeaturesFixtureRoot = path.resolve(
	process.cwd(),
	"test/markdown/fixtures/transclusion-features",
);

const compatibilityFixtureRoot = path.resolve(
	process.cwd(),
	"test/markdown/fixtures/compatibility",
);

const wikilinkCompatibilityFixtureRoot = path.resolve(
	process.cwd(),
	"test/markdown/fixtures/wikilink-compat",
);
const pathCollisionFixtureRoot = path.resolve(
	process.cwd(),
	"test/markdown/fixtures/path-collisions",
);
const dataviewFixtureRoot = path.resolve(process.cwd(), "test/markdown/fixtures/dataview");
const dailyNotesFixtureRoot = path.resolve(process.cwd(), "test/markdown/fixtures/daily-notes");
const vaultSearchFixtureRoot = path.resolve(process.cwd(), "test/markdown/fixtures/vault-search");

const DEFAULT_OPTIONS: NormalizedPluginOptions = {
	vaultRoot: undefined,
	vaultRoutePrefix: "/vault",
	onBrokenLink: "error",
	onAmbiguousLink: "error",
	enableFuzzyMatching: false,
	enableCaseInsensitiveLookup: false,
	enableMarkdownLinks: true,
	onDataviewError: "error",
	onUnsupportedBlock: "warn",
	enableDataview: false,
	enableDailyNotes: false,
	dailyNotes: {
		folder: "",
		dateFormat: "YYYY-MM-DD",
		navigation: true,
		template: "",
		calendar: "",
	},
	enableTagLinking: false,
	enableCallouts: false,
	enableBacklinks: false,
	enableUnlinkedMentions: false,
	enableTransclusion: false,
	enableMediaEmbeds: false,
	enableTagPages: false,
	enableMath: false,
	mathEngine: "katex",
	enableMermaid: false,
	mermaidSecurityLevel: "strict",
	enableDefaultStyles: false,
};

function makeProcessor(docsRoot: string, optionOverrides: Partial<NormalizedPluginOptions> = {}) {
	return unified()
		.use(remarkParse)
		.use(remarkWikilink, {
			getDocsRoot: () => docsRoot,
			options: { ...DEFAULT_OPTIONS, ...optionOverrides },
		})
		.use(remarkStringify);
}

/**
 * Run the plugin's own remark tuple: the exact plugin-and-options pair
 * `markdown()` wires, including the content-index closure it built with its
 * normalized options. `makeProcessor` above hand-builds options instead.
 */
function makeProcessorFor(tuple: [unknown, unknown]) {
	return unified()
		.use(remarkParse)
		.use(tuple[0] as typeof remarkWikilink, tuple[1] as never)
		.use(remarkStringify);
}

describe("parseWikiLink", () => {
	test("parses alias and anchor", () => {
		const parsed = parseWikiLink(
			"guide/getting-started#Install|Install guide",
			"[[guide/getting-started#Install|Install guide]]",
		);

		expect(parsed).toEqual({
			raw: "[[guide/getting-started#Install|Install guide]]",
			target: "guide/getting-started",
			alias: "Install guide",
			isEmbed: false,
			subpath: {
				kind: "heading",
				value: "Install",
			},
			isCurrentPageReference: false,
		});
	});

	test("parses note-relative page links", () => {
		expect(parseWikiLink("../shared/Concept", "[[../shared/Concept]]")).toEqual({
			raw: "[[../shared/Concept]]",
			target: "../shared/Concept",
			isEmbed: false,
			isCurrentPageReference: false,
		});
	});

	test("parses embeds and block references", () => {
		const parsed = parseWikiLink(
			"guide/getting-started#^install-block|Install block",
			"![[guide/getting-started#^install-block|Install block]]",
		);

		expect(parsed).toEqual({
			raw: "![[guide/getting-started#^install-block|Install block]]",
			target: "guide/getting-started",
			alias: "Install block",
			isEmbed: true,
			subpath: {
				kind: "block",
				value: "install-block",
			},
			isCurrentPageReference: false,
		});
	});

	test("preserves nested heading fragments", () => {
		expect(parseWikiLink("Page#Parent#Child|Child", "[[Page#Parent#Child|Child]]")).toEqual({
			raw: "[[Page#Parent#Child|Child]]",
			target: "Page",
			alias: "Child",
			isEmbed: false,
			subpath: { kind: "heading", value: "Parent#Child" },
			isCurrentPageReference: false,
		});
	});

	test("parses vault-wide heading and block searches", () => {
		expect(parseWikiLink("## Install", "[[## Install]]")).toMatchObject({
			target: "",
			search: "heading",
			subpath: { kind: "heading", value: "Install" },
		});
		expect(parseWikiLink("^^install-block", "[[^^install-block]]")).toMatchObject({
			target: "",
			search: "block",
			subpath: { kind: "block", value: "install-block" },
		});
	});

	test("finds standard and embed wikilinks", () => {
		const matches = findWikilinkMatches("See [[Page]] and ![[Embed]]");

		expect(matches).toHaveLength(2);
		expect(matches[0]?.fullMatch).toBe("[[Page]]");
		expect(matches[1]?.fullMatch).toBe("![[Embed]]");
	});
	test("finds wikilinks with escaped square brackets", () => {
		const matches = findWikilinkMatches(
			"See [[Note with \\[brackets\\]]] and ![[Image \\] copy.png]]",
		);

		expect(matches.map((match) => match.fullMatch)).toEqual([
			"[[Note with \\[brackets\\]]]",
			"![[Image \\] copy.png]]",
		]);
		expect(matches.map((match) => parseWikiLink(match.inner, match.fullMatch))).toMatchObject([
			{ target: "Note with [brackets]" },
			{ target: "Image ] copy.png", isEmbed: true },
		]);
	});
});

describe("buildContentIndex", () => {
	test("indexes pages and headings", async () => {
		const index = await buildContentIndex(fixtureRoot);
		const page = index.byPathKey.get("guide/getting-started");

		expect(page?.routePath).toBe("/guide/getting-started");
		expect(page?.headings.map((heading) => heading.slug)).toContain("install");
		expect(page?.blocks).toEqual([{ id: "install-block" }]);
	});

	test("caches repeated content-index reads when files are unchanged", async () => {
		const first = await getCachedContentIndex(fixtureRoot);
		const second = await getCachedContentIndex(fixtureRoot);

		expect(second).toBe(first);
	});

	test("extracts setext, spaced atx, and explicit heading ids", async () => {
		const index = await buildContentIndex(headingFixtureRoot);
		const page = index.byPathKey.get("guide/variants");

		expect(page?.headings.map(({ preview: _, ...rest }) => rest)).toEqual([
			{ rawText: "Variants", slug: "variants" },
			{
				rawText: "Named Setext",
				slug: "named-setext",
				explicitId: "custom-setext",
			},
			{ rawText: "Spaced ATX Heading", slug: "spaced-atx-heading" },
			{
				rawText: "Custom Anchor",
				slug: "custom-anchor",
				explicitId: "custom-anchor",
			},
		]);
	});

	test("matches Obsidian-compatible heading anchor corpus", async () => {
		const index = await buildContentIndex(compatibilityFixtureRoot);
		const page = index.byPathKey.get("shared/Concept");

		expect(page?.headings.map(({ preview: _, ...heading }) => heading)).toEqual([
			{ rawText: "Concept", slug: "concept" },
			{ rawText: "Café Déjà Vu", slug: "café-déjà-vu" },
			{ rawText: "Punctuation: A/B & C", slug: "punctuation-ab--c" },
			{ rawText: "😀 Emoji Heading", slug: "-emoji-heading" },
			{ rawText: "重复 标题", slug: "重复-标题" },
			{ rawText: "Duplicate", slug: "duplicate" },
			{ rawText: "Duplicate", slug: "duplicate-1" },
			{
				rawText: "Explicit Anchor",
				slug: "explicit-anchor",
				explicitId: "explicit-anchor",
			},
		]);
	});

	test("extracts frontmatter titles and aliases", async () => {
		const index = await buildContentIndex(aliasFixtureRoot);
		const page = index.byPathKey.get("guide/getting-started");

		expect(page?.title).toBe("Onboarding Guide");
		expect(page?.aliases).toEqual(["Start Here", "Kickoff"]);
		expect(index.byTitle.get("onboarding guide")?.[0]?.pathKey).toBe("guide/getting-started");
		expect(index.byAlias.get("start here")?.[0]?.pathKey).toBe("guide/getting-started");
	});
	test("indexes attachment files and inline tags", async () => {
		const index = await buildContentIndex(assetsFixtureRoot);

		expect(index.assets.map((asset) => asset.pathKey)).toContain("image.png");
		expect(index.byTag.get("asset-test")?.[0]?.pathKey).toBe("");
		expect(index.byAssetPath.get("image.png")?.urlPath).toBe("/image.png");
		expect(index.byAssetBaseNameCI.get("image.png")?.[0]?.pathKey).toBe("image.png");
	});
	test("indexes spaced paths and duplicate heading slugs", async () => {
		const index = await buildContentIndex(wikilinkCompatibilityFixtureRoot);
		const page = index.byPathKey.get("Folder/Space Note");

		expect(page?.routePath).toBe("/Folder/Space Note");
		expect(page?.headings.map((heading) => heading.slug)).toEqual([
			"space-note",
			"duplicate",
			"duplicate-1",
		]);
	});
	test("keeps folder index pages distinct from flat pages", async () => {
		const index = await buildContentIndex(pathCollisionFixtureRoot);

		expect(index.byFilePathKey.get("foo")?.relativePath).toBe("foo.md");
		expect(index.byFilePathKey.get("foo/index")?.relativePath).toBe("foo/index.md");
		expect(index.byFilePathKeyCI.get("foo/index")?.[0]?.relativePath).toBe("foo/index.md");
	});
});

describe("static Dataview", () => {
	test("indexes frontmatter, inline fields, tasks, and lists", async () => {
		const index = await buildContentIndex(dataviewFixtureRoot);
		const page = index.byFilePathKey.get("notes/alpha");

		expect(page?.dataviewFields.status).toBe("open");
		expect(page?.dataviewFields.owner).toBe("Alice");
		expect(page?.dataviewTasks).toHaveLength(2);
		expect(page?.dataviewTasks[0]?.completed).toBe(false);
		expect(page?.dataviewTasks[0]?.fields.due).toBeInstanceOf(Date);
		expect(page?.dataviewLists).toHaveLength(2);
	});

	test("renders static DQL tables, filters, sorting, and limits", async () => {
		const processor = makeProcessor(dataviewFixtureRoot, {
			enableDataview: true,
		});
		const file = await processor.process({
			value: [
				"```dataview",
				"TABLE status, priority",
				'FROM "notes"',
				'WHERE status = "open"',
				"SORT priority DESC",
				"LIMIT 1",
				"```",
			].join("\n"),
			path: path.resolve(dataviewFixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain('class="dataview dataview-table"');
		expect(output).toContain("Alpha");
		expect(output).not.toContain("Beta");
	});

	test("renders static TASK queries and inline expressions", async () => {
		const processor = makeProcessor(dataviewFixtureRoot, {
			enableDataview: true,
		});
		const file = await processor.process({
			value: [
				"Open task count: = length(file.tasks)",
				"",
				"```dataview",
				"TASK",
				'FROM "notes"',
				"WHERE !completed",
				"```",
			].join("\n"),
			path: path.resolve(dataviewFixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain('class="dataview-inline"');
		expect(output).toContain("Ship alpha");
		expect(output).toContain("Review beta");
		expect(output).toContain('type="checkbox"');
	});
	test("supports FLATTEN, GROUP BY, arithmetic, and inline field rendering", async () => {
		const processor = makeProcessor(dataviewFixtureRoot, {
			enableDataview: true,
		});
		const file = await processor.process({
			value: [
				"Value [rating:: 9].",
				"",
				"```dataview",
				"TABLE WITHOUT ID tag",
				'FROM "notes"',
				"FLATTEN file.tags AS tag",
				'WHERE tag = "#project/demo" AND priority + 1 > 2',
				"```",
				"",
				"```dataview",
				"TABLE WITHOUT ID key, length(rows)",
				'FROM "notes"',
				'GROUP BY "all"',
				"```",
			].join("\n"),
			path: path.resolve(dataviewFixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain("Value 9.");
		expect(output).toContain("#project/demo");
		expect(output).toContain("2");
	});

	test("renders sandboxed DataviewJS table queries", async () => {
		const processor = makeProcessor(dataviewFixtureRoot, {
			enableDataview: true,
			onDataviewError: "error",
		});
		const file = await processor.process({
			value: [
				"```dataviewjs",
				'const pages = dv.pages("#project/demo").where(p => p.status === "open");',
				'dv.table(["File"], pages.map(p => [p.file.link]));',
				"```",
			].join("\n"),
			path: path.resolve(dataviewFixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain('class="dataviewjs-table"');
		expect(output).toContain('href="/notes/alpha"');
		expect(output).not.toContain("Beta");
	});

	test("rejects DataviewJS host access", async () => {
		const processor = makeProcessor(dataviewFixtureRoot, {
			enableDataview: true,
			onDataviewError: "error",
		});

		await expect(
			processor.process({
				value: "```dataviewjs\ndv.paragraph(process.version);\n```",
				path: path.resolve(dataviewFixtureRoot, "index.md"),
			}),
		).rejects.toThrow("forbidden host");
	});
});

describe("Dataview FROM sources", () => {
	const dataviewSourcesFixtureRoot = path.resolve(
		process.cwd(),
		"test/markdown/fixtures/dataview-sources",
	);

	test("selects inlinks for [[note]] and inlinks([[note]]), not outlinks", async () => {
		const processor = makeProcessor(dataviewSourcesFixtureRoot, { enableDataview: true });
		const file = await processor.process({
			value: [
				"```dataview",
				"TABLE file.name",
				"FROM [[notes/beta]]",
				"```",
				"",
				"```dataview",
				"TABLE file.name",
				"FROM inlinks([[notes/beta]])",
				"```",
				"",
				"```dataview",
				"TABLE file.name",
				"FROM outlinks([[notes/beta]])",
				"```",
			].join("\n"),
			path: path.resolve(dataviewSourcesFixtureRoot, "index.md"),
		});

		// alpha links to beta and beta links nowhere, so the two link forms
		// select alpha while outlinks selects nothing.
		const output = String(file);
		expect(output.match(/>alpha</g)).toHaveLength(2);
		expect(output).not.toContain(">beta<");
		expect(output).not.toContain(">orphan<");
	});

	test("selects the pages a note links to for outlinks([[note]])", async () => {
		const processor = makeProcessor(dataviewSourcesFixtureRoot, { enableDataview: true });
		const file = await processor.process({
			value: ["```dataview", "TABLE file.name", "FROM outlinks([[notes/alpha]])", "```"].join("\n"),
			path: path.resolve(dataviewSourcesFixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain(">beta<");
		expect(output).not.toContain(">alpha<");
		expect(output).not.toContain(">orphan<");
	});

	test("ignores an alias in a link source", async () => {
		const processor = makeProcessor(dataviewSourcesFixtureRoot, { enableDataview: true });
		const file = await processor.process({
			value: ["```dataview", "TABLE file.name", "FROM [[notes/beta|Beta alias]]", "```"].join("\n"),
			path: path.resolve(dataviewSourcesFixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain(">alpha<");
		expect(output).not.toContain(">orphan<");
	});

	test("reports an unrecognized source instead of returning no rows", async () => {
		const processor = makeProcessor(dataviewSourcesFixtureRoot, {
			enableDataview: true,
			onDataviewError: "warn",
		});
		const file = await processor.process({
			value: ["```dataview", "TABLE file.name", "FROM nothing/../else", "```"].join("\n"),
			path: path.resolve(dataviewSourcesFixtureRoot, "index.md"),
		});

		expect(file.messages.some((m) => String(m).includes("Unsupported Dataview source"))).toBe(true);
	});

	test("fails the build for an unrecognized source in error mode", async () => {
		const processor = makeProcessor(dataviewSourcesFixtureRoot, {
			enableDataview: true,
			onDataviewError: "error",
		});

		await expect(
			processor.process({
				value: ["```dataview", "TABLE file.name", "FROM bogus(), #tag", "```"].join("\n"),
				path: path.resolve(dataviewSourcesFixtureRoot, "index.md"),
			}),
		).rejects.toThrow("Unsupported Dataview source");
	});
});

describe("Dataview regex bounds", () => {
	const dataviewSourcesFixtureRoot = path.resolve(
		process.cwd(),
		"test/markdown/fixtures/dataview-sources",
	);

	test("rejects nested quantifiers in a regexmatch pattern", async () => {
		const processor = makeProcessor(dataviewSourcesFixtureRoot, {
			enableDataview: true,
			onDataviewError: "warn",
		});
		const file = await processor.process({
			value: ["```dataview", 'TABLE regexmatch("(a+)+$", file.name)', 'FROM "notes"', "```"].join(
				"\n",
			),
			path: path.resolve(dataviewSourcesFixtureRoot, "index.md"),
		});

		expect(file.messages.some((m) => String(m).includes("nested quantifiers"))).toBe(true);
	});

	test("rejects an oversized pattern and an oversized subject", async () => {
		const processor = makeProcessor(dataviewSourcesFixtureRoot, {
			enableDataview: true,
			onDataviewError: "warn",
		});
		const longPattern = "a".repeat(1001);
		const longSubject = Array.from({ length: 11 }, () => `"${"b".repeat(1000)}"`).join(" + ");
		const file = await processor.process({
			value: [
				"```dataview",
				`TABLE regexmatch("${longPattern}", file.name)`,
				'FROM "notes"',
				"```",
				"",
				"```dataview",
				`TABLE regexmatch("bb", ${longSubject})`,
				'FROM "notes"',
				"```",
			].join("\n"),
			path: path.resolve(dataviewSourcesFixtureRoot, "index.md"),
		});

		const messages = file.messages.map((m) => String(m));
		expect(messages.some((m) => m.includes("pattern is too long"))).toBe(true);
		expect(messages.some((m) => m.includes("subject is too long"))).toBe(true);
	});
});

describe("static Daily Notes", () => {
	test("parses configured Daily Notes dates", () => {
		const config = {
			folder: "",
			dateFormat: "YYYY-MM-DD",
			navigation: true,
			template: "",
			calendar: "",
		};
		const date = parseDailyNoteDate("2026-08-20.md", config);

		expect(date?.toISOString()).toBe("2026-08-20T00:00:00.000Z");
		expect(formatDailyNoteDate(date!, "dddd, MMMM D, YYYY")).toBe("Thursday, August 20, 2026");
	});

	test("fills an empty daily note from the configured template", async () => {
		const processor = makeProcessor(dailyNotesFixtureRoot, {
			enableDailyNotes: true,
			dailyNotes: {
				folder: "",
				dateFormat: "YYYY-MM-DD",
				navigation: true,
				template: "templates/Daily template",
				calendar: "",
			},
		});
		const file = await processor.process({
			value: "---\ntags: [journal]\n---\n",
			path: path.join(dailyNotesFixtureRoot, "2026-08-20.md"),
		});
		const output = String(file);

		// The template body lands with its date tokens expanded, and the
		// template's own frontmatter is not copied into the page.
		expect(output).toContain("2026-08-20");
		expect(output).toContain("First task");
		expect(output).not.toContain("{{");
	});

	test("leaves a daily note the author started alone", async () => {
		const processor = makeProcessor(dailyNotesFixtureRoot, {
			enableDailyNotes: true,
			dailyNotes: {
				folder: "",
				dateFormat: "YYYY-MM-DD",
				navigation: true,
				template: "templates/Daily template",
				calendar: "",
			},
		});
		const file = await processor.process({
			value: "Already written.",
			path: path.join(dailyNotesFixtureRoot, "2026-08-20.md"),
		});
		const output = String(file);

		expect(output).toContain("Already written.");
		expect(output).not.toContain("First task");
	});

	test("expands {{title}} in daily note content", async () => {
		const processor = makeProcessor(dailyNotesFixtureRoot, {
			enableDailyNotes: true,
			dailyNotes: {
				folder: "",
				dateFormat: "YYYY-MM-DD",
				navigation: true,
				template: "",
				calendar: "",
			},
		});
		const file = await processor.process({
			value: "Notes for {{title}}.",
			path: path.join(dailyNotesFixtureRoot, "2026-08-20.md"),
		});

		expect(String(file)).toContain("Notes for 2026-08-20.");
	});

	test("expands templates and renders previous/current/next navigation", async () => {
		const processor = makeProcessor(dailyNotesFixtureRoot, {
			enableDailyNotes: true,
			enableDataview: true,
			dailyNotes: {
				folder: "",
				dateFormat: "YYYY-MM-DD",
				navigation: true,
				template: "",
				calendar: "",
			},
		});
		const file = await processor.process({
			value: await Bun.file(path.join(dailyNotesFixtureRoot, "2026-08-20.md")).text(),
			path: path.join(dailyNotesFixtureRoot, "2026-08-20.md"),
		});

		const output = String(file);
		expect(output).toContain("Thursday, August 20, 2026");
		expect(output).toContain('class="obsidian-daily-navigation"');
		expect(output).toContain('href="/2026-08-19"');
		expect(output).toContain('href="/2026-08-21"');
		expect(output).toContain("2026-08-20");
	});
});

describe("resolveWikiLink", () => {
	test("resolves exact path links", async () => {
		const index = await buildContentIndex(fixtureRoot);
		const currentPage = index.byPathKey.get("")!;

		const result = resolveWikiLink(
			parseWikiLink("guide/getting-started", "[[guide/getting-started]]"),
			{
				currentPage,
				index,
			},
		);

		expect(result).toMatchObject({
			status: "ok",
			href: "/guide/getting-started",
			label: "getting started",
		});
	});
	test("resolves folder index paths independently from flat pages", async () => {
		const index = await buildContentIndex(pathCollisionFixtureRoot);
		const currentPage = index.byFilePathKey.get("index")!;

		const flat = resolveWikiLink(parseWikiLink("foo", "[[foo]]"), {
			currentPage,
			index,
		});
		const folder = resolveWikiLink(parseWikiLink("foo/index", "[[foo/index]]"), {
			currentPage,
			index,
		});

		expect(flat.targetPage?.relativePath).toBe("foo.md");
		expect(folder.targetPage?.relativePath).toBe("foo/index.md");
	});

	test("encodes spaced page routes while preserving heading fragments", async () => {
		const index = await buildContentIndex(wikilinkCompatibilityFixtureRoot);
		const currentPage = index.byPathKey.get("")!;

		const result = resolveWikiLink(
			parseWikiLink("Folder/Space Note#duplicate-1", "[[Folder/Space Note#duplicate-1]]"),
			{ currentPage, index },
		);

		expect(result).toMatchObject({
			status: "ok",
			href: "/Folder/Space%20Note#duplicate-1",
		});
	});
	test("resolves raw duplicate heading text to the first heading", async () => {
		const index = await buildContentIndex(wikilinkCompatibilityFixtureRoot);
		const currentPage = index.byFilePathKey.get("index")!;

		const result = resolveWikiLink(
			parseWikiLink("Folder/Space Note#Duplicate", "[[Folder/Space Note#Duplicate]]"),
			{ currentPage, index },
		);

		expect(result).toMatchObject({
			status: "ok",
			href: "/Folder/Space%20Note#duplicate",
		});
	});

	test("resolves relative wikilinks from the current note", async () => {
		const index = await buildContentIndex(compatibilityFixtureRoot);
		const currentPage = index.byPathKey.get("notes/current");

		expect(currentPage).toBeDefined();

		const pageResult = resolveWikiLink(
			parseWikiLink("../shared/Concept", "[[../shared/Concept]]"),
			{ currentPage: currentPage!, index },
		);
		const headingResult = resolveWikiLink(
			parseWikiLink("../shared/Concept#Café Déjà Vu", "[[../shared/Concept#Café Déjà Vu]]"),
			{ currentPage: currentPage!, index },
		);
		const explicitIdResult = resolveWikiLink(
			parseWikiLink("../shared/Concept#EXPLICIT-ANCHOR", "[[../shared/Concept#EXPLICIT-ANCHOR]]"),
			{ currentPage: currentPage!, index },
		);

		expect(pageResult).toMatchObject({
			status: "ok",
			href: "/shared/Concept",
		});
		expect(headingResult).toMatchObject({
			status: "ok",
			href: "/shared/Concept#café-déjà-vu",
		});
		expect(explicitIdResult).toMatchObject({
			status: "ok",
			href: "/shared/Concept#explicit-anchor",
		});
		expect(index.backlinks.get("/shared/Concept")).toEqual([
			{ routePath: "/notes/current", relativePath: "notes/current.md", title: "Current Note" },
		]);
	});
	test("resolves case-insensitive relative page and asset paths when enabled", async () => {
		const pageIndex = await buildContentIndex(fixtureRoot);
		const pageCurrent = pageIndex.byFilePathKey.get("index")!;
		const pageResult = resolveWikiLink(
			parseWikiLink("./GUIDE/GETTING-STARTED", "[[./GUIDE/GETTING-STARTED]]"),
			{
				currentPage: pageCurrent,
				index: pageIndex,
				options: { enableCaseInsensitiveLookup: true },
			},
		);
		const strictPageResult = resolveWikiLink(
			parseWikiLink("./GUIDE/GETTING-STARTED", "[[./GUIDE/GETTING-STARTED]]"),
			{
				currentPage: pageCurrent,
				index: pageIndex,
				options: { enableCaseInsensitiveLookup: false },
			},
		);

		const assetIndex = await buildContentIndex(assetsFixtureRoot);
		const assetCurrent = assetIndex.byFilePathKey.get("index")!;
		const assetResult = resolveWikiLink(parseWikiLink("./IMAGE.PNG", "[[./IMAGE.PNG]]"), {
			currentPage: assetCurrent,
			index: assetIndex,
			options: { enableCaseInsensitiveLookup: true },
		});
		const strictAssetResult = resolveWikiLink(parseWikiLink("./IMAGE.PNG", "[[./IMAGE.PNG]]"), {
			currentPage: assetCurrent,
			index: assetIndex,
			options: { enableCaseInsensitiveLookup: false },
		});

		expect(pageResult).toMatchObject({
			status: "ok",
			href: "/guide/getting-started",
		});
		expect(strictPageResult.status).toBe("broken-page");
		expect(assetResult).toMatchObject({
			status: "ok",
			href: "/image.png",
		});
		expect(strictAssetResult.status).toBe("broken-page");
	});

	test("does not fall back from an unresolved relative wikilink", async () => {
		const index = await buildContentIndex(compatibilityFixtureRoot);
		const currentPage = index.byPathKey.get("notes/current")!;

		const result = resolveWikiLink(parseWikiLink("../missing/Concept", "[[../missing/Concept]]"), {
			currentPage,
			index,
		});

		expect(result.status).toBe("broken-page");
	});

	test("resolves basename links when unique", async () => {
		const index = await buildContentIndex(fixtureRoot);
		const currentPage = index.byPathKey.get("")!;

		const result = resolveWikiLink(
			parseWikiLink("advanced#Advanced Usage", "[[advanced#Advanced Usage]]"),
			{
				currentPage,
				index,
			},
		);

		expect(result).toMatchObject({
			status: "ok",
			href: "/guide/advanced#advanced-usage",
			label: "Advanced Usage",
		});
	});
	test("resolves unique vault-wide heading and block searches", async () => {
		const index = await buildContentIndex(fixtureRoot);
		const currentPage = index.byPathKey.get("")!;

		const headingResult = resolveWikiLink(
			parseWikiLink("## Advanced Usage", "[[## Advanced Usage]]"),
			{ currentPage, index },
		);
		const blockResult = resolveWikiLink(parseWikiLink("^^install-block", "[[^^install-block]]"), {
			currentPage,
			index,
		});

		expect(headingResult).toMatchObject({
			status: "ok",
			href: "/guide/advanced#advanced-usage",
		});
		expect(blockResult).toMatchObject({
			status: "ok",
			href: "/guide/getting-started#^install-block",
		});
	});

	test("resolves title and alias lookups when unique", async () => {
		const index = await buildContentIndex(aliasFixtureRoot);
		const currentPage = index.byPathKey.get("")!;

		const aliasResult = resolveWikiLink(parseWikiLink("Start Here", "[[Start Here]]"), {
			currentPage,
			index,
		});
		const titleResult = resolveWikiLink(parseWikiLink("Onboarding Guide", "[[Onboarding Guide]]"), {
			currentPage,
			index,
		});

		expect(aliasResult).toMatchObject({
			status: "ok",
			href: "/guide/getting-started",
		});
		expect(titleResult).toMatchObject({
			status: "ok",
			href: "/guide/getting-started",
		});
	});

	test("reports ambiguous basename links", async () => {
		const index = await buildContentIndex(
			path.resolve(process.cwd(), "test/markdown/fixtures/ambiguous"),
		);
		const currentPage = index.byPathKey.get("")!;

		const result = resolveWikiLink(parseWikiLink("getting-started", "[[getting-started]]"), {
			currentPage,
			index,
		});

		expect(result.status).toBe("ambiguous-page");
	});

	test("reports ambiguous alias links", async () => {
		const index = await buildContentIndex(aliasAmbiguousFixtureRoot);
		const currentPage = index.byPathKey.get("")!;

		const result = resolveWikiLink(parseWikiLink("Shared Alias", "[[Shared Alias]]"), {
			currentPage,
			index,
		});

		expect(result.status).toBe("ambiguous-page");
	});

	test("reports broken anchors", async () => {
		const index = await buildContentIndex(fixtureRoot);
		const currentPage = index.byPathKey.get("")!;

		const result = resolveWikiLink(
			parseWikiLink("guide/getting-started#Missing", "[[guide/getting-started#Missing]]"),
			{
				currentPage,
				index,
			},
		);

		expect(result.status).toBe("broken-anchor");
	});

	test("resolves block references", async () => {
		const index = await buildContentIndex(fixtureRoot);
		const currentPage = index.byPathKey.get("")!;

		const result = resolveWikiLink(
			parseWikiLink(
				"guide/getting-started#^install-block",
				"[[guide/getting-started#^install-block]]",
			),
			{
				currentPage,
				index,
			},
		);

		expect(result).toMatchObject({
			status: "ok",
			href: "/guide/getting-started#^install-block",
			label: "install-block",
		});
	});

	test("keeps exact path matching strict by case", async () => {
		const index = await buildContentIndex(strictFixtureRoot);
		const currentPage = index.byPathKey.get("")!;

		const result = resolveWikiLink(
			parseWikiLink("guide/casesensitive", "[[guide/casesensitive]]"),
			{
				currentPage,
				index,
			},
		);

		expect(result.status).toBe("broken-page");
	});

	test("supports optional fuzzy path matching", async () => {
		const index = await buildContentIndex(strictFixtureRoot);
		const currentPage = index.byPathKey.get("")!;

		const result = resolveWikiLink(
			parseWikiLink("guide/casesensitive", "[[guide/casesensitive]]"),
			{
				currentPage,
				index,
				options: {
					enableFuzzyMatching: true,
				},
			},
		);

		expect(result).toMatchObject({
			status: "ok",
			href: "/guide/CaseSensitive",
		});
	});

	test("rejects malformed empty targets", async () => {
		const index = await buildContentIndex(fixtureRoot);
		const currentPage = index.byPathKey.get("")!;

		const result = resolveWikiLink(parseWikiLink(" |Alias", "[[ |Alias]]"), {
			currentPage,
			index,
		});

		expect(result.status).toBe("broken-page");
	});

	test("resolves richer heading syntax", async () => {
		const index = await buildContentIndex(headingFixtureRoot);
		const currentPage = index.byPathKey.get("")!;

		const setextResult = resolveWikiLink(
			parseWikiLink("guide/variants#Named Setext", "[[guide/variants#Named Setext]]"),
			{
				currentPage,
				index,
			},
		);
		const spacedAtxResult = resolveWikiLink(
			parseWikiLink("guide/variants#Spaced ATX Heading", "[[guide/variants#Spaced ATX Heading]]"),
			{
				currentPage,
				index,
			},
		);
		const explicitIdResult = resolveWikiLink(
			parseWikiLink("guide/variants#custom-anchor", "[[guide/variants#custom-anchor]]"),
			{
				currentPage,
				index,
			},
		);

		expect(setextResult).toMatchObject({
			status: "ok",
			href: "/guide/variants#custom-setext",
		});
		expect(spacedAtxResult).toMatchObject({
			status: "ok",
			href: "/guide/variants#spaced-atx-heading",
		});
		expect(explicitIdResult).toMatchObject({
			status: "ok",
			href: "/guide/variants#custom-anchor",
		});
	});
});

describe("remarkWikilink", () => {
	test("rewrites wikilinks into markdown links", async () => {
		const processor = makeProcessor(fixtureRoot);

		const file = await processor.process({
			value: "Go to [[guide/getting-started#Install|Install guide]].",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output1 = String(file);
		expect(output1).toContain('[Install guide](/guide/getting-started#install "Install steps.');
		expect(output1).toEndWith("\n");
	});

	test("rewrites note-relative links end to end", async () => {
		const processor = makeProcessor(compatibilityFixtureRoot);

		const file = await processor.process({
			value: "See [[../shared/Concept#Café Déjà Vu]] and [[../shared/Concept]].",
			path: path.resolve(compatibilityFixtureRoot, "notes/current.md"),
		});

		expect(String(file)).toContain("[Café Déjà Vu](/shared/Concept#café-déjà-vu)");
		expect(String(file)).toContain("[Concept](/shared/Concept)");
	});

	test("rewrites unique vault-wide searches end to end", async () => {
		const processor = makeProcessor(fixtureRoot);

		const file = await processor.process({
			value: "See [[## Advanced Usage]] and [[^^install-block]].",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toContain("[Advanced Usage](/guide/advanced#advanced-usage");
		expect(String(file)).toContain("[install-block](/guide/getting-started#^install-block)");
	});

	test("renders an ambiguous vault search as a picker component", async () => {
		// Two pages carry a "Setup Guide" heading, so the search is ambiguous and
		// Obsidian would open a list of matches. The component only exists in an
		// MDX-compiled tree, so the assertion is on the AST: `remarkStringify` has
		// no handler for a JSX node.
		const { VFile } = await import("vfile");
		const processor = makeProcessor(vaultSearchFixtureRoot);
		const file = path.resolve(vaultSearchFixtureRoot, "index.md");
		const tree = await processor.run(
			processor.parse("See [[## Setup Guide]]."),
			new VFile({ path: file }),
		);
		const serialized = JSON.stringify(tree);

		expect(serialized).toContain('"type":"mdxJsxTextElement"');
		expect(serialized).toContain('"name":"WikiPicker"');
		expect(serialized).toContain('"name":"query","value":"Setup Guide"');
		// Candidates are resolved at build time and travel in the attribute, so
		// the picker needs no runtime data module.
		expect(serialized).toContain("/one/setup#setup-guide");
		expect(serialized).toContain("/two/setup#setup-guide");
		expect(serialized).not.toContain("obsidian-unresolved");
	});

	test("still resolves a vault search that matches exactly one heading", async () => {
		const processor = makeProcessor(fixtureRoot);
		const file = await processor.process({
			value: "See [[## Install]] for details.",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		const output = String(file);

		expect(output).not.toContain("WikiPicker");
		expect(output).toMatch(/\[Install\]\(\/guide\/getting-started#install/);
	});

	test("rewrites frontmatter title and alias links end to end", async () => {
		const processor = makeProcessor(aliasFixtureRoot);

		const file = await processor.process({
			value: "See [[Onboarding Guide]] and [[Start Here]].",
			path: path.resolve(aliasFixtureRoot, "index.md"),
		});

		expect(String(file)).toContain("[Onboarding Guide](/guide/getting-started)");
		expect(String(file)).toContain("[Start Here](/guide/getting-started)");
	});

	test("appends backlinks HTML end to end", async () => {
		const processor = makeProcessor(fixtureRoot, {
			enableBacklinks: true,
		});

		const file = await processor.process({
			value: "Getting started content.",
			path: path.resolve(fixtureRoot, "guide/getting-started.md"),
		});

		expect(String(file)).toContain('<div class="obsidian-backlinks">');
		expect(String(file)).toContain('<a href="/">');
	});

	test("supports current-page anchors", async () => {
		const processor = makeProcessor(fixtureRoot);

		const file = await processor.process({
			value: "Jump to [[#Overview]].",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output2 = String(file);
		expect(output2).toContain('[Overview](#overview "Read');
		expect(output2).toEndWith("\n");
	});

	test("rewrites block references into markdown links", async () => {
		const processor = makeProcessor(fixtureRoot);

		const file = await processor.process({
			value: "Jump to [[guide/getting-started#^install-block]].",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toBe("Jump to [install-block](/guide/getting-started#^install-block).\n");
	});

	test("emits anchors for block IDs on the page", async () => {
		const processor = makeProcessor(inlineBlocksFixtureRoot);

		const file = await processor.process({
			value: [
				"# Inline Blocks",
				"",
				"^standalone-block",
				"",
				"A paragraph with an inline block ID. ^inline-block",
				"",
				"^standalone_block",
				"",
				"A paragraph with an underscore inline block ID. ^inline_block",
			].join("\n"),
			path: path.resolve(inlineBlocksFixtureRoot, "guide/inline-target.md"),
		});

		const output = String(file);
		expect(output).toContain('id="^standalone-block"');
		expect(output).toContain('id="^inline-block"');
		expect(output).toContain('id="^standalone_block"');
		expect(output).toContain('id="^inline_block"');
	});

	test("rewrites embeds into embed html anchors", async () => {
		const processor = makeProcessor(fixtureRoot);

		const file = await processor.process({
			value: "![[guide/getting-started#Install|Install guide]]",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toBe(
			'<a class="obsidian-embed" data-obsidian-embed="true" href="/guide/getting-started#install">Install guide</a>\n',
		);
	});
});

describe("transclusion", () => {
	test("transclubes full page content", async () => {
		const processor = makeProcessor(fixtureRoot, {
			enableTransclusion: true,
		});
		const file = await processor.process({
			value: "![[guide/getting-started]]",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		const output = String(file);
		expect(output).toContain('class="obsidian-transclusion"');
		expect(output).toContain("Getting Started");
	});

	test("transclubes heading section only", async () => {
		const processor = makeProcessor(fixtureRoot, {
			enableTransclusion: true,
		});
		const file = await processor.process({
			value: "![[guide/getting-started#Install]]",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		const output = String(file);
		expect(output).toContain('class="obsidian-transclusion"');
		expect(output).toContain("Install");
		expect(output).not.toContain("Getting Started\n");
	});
	test("renders GFM tables inside transcluded content", async () => {
		const processor = makeProcessor(transclusionFeaturesFixtureRoot, {
			enableTransclusion: true,
		});
		const file = await processor.process({
			value: "![[source]]",
			path: path.resolve(transclusionFeaturesFixtureRoot, "index.md"),
		});
		const output = String(file);
		expect(output).toContain("<table>");
		expect(output).toContain("<th>Syntax</th>");
		expect(output).toContain("Transclude full page content");
	});

	test("transclubes block reference only", async () => {
		const processor = makeProcessor(fixtureRoot, {
			enableTransclusion: true,
		});
		const file = await processor.process({
			value: "![[guide/getting-started#^install-block]]",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		const output = String(file);
		expect(output).toContain('class="obsidian-transclusion"');
		expect(output).toContain("Install steps");
	});

	test("transcludes an underscore inline block ID", async () => {
		const processor = makeProcessor(inlineBlocksFixtureRoot, {
			enableTransclusion: true,
		});
		const file = await processor.process({
			value: "![[guide/inline-target#^inline_block]]",
			path: path.resolve(inlineBlocksFixtureRoot, "index.md"),
		});
		const output = String(file);
		expect(output).toContain('class="obsidian-transclusion"');
		expect(output).toContain("A paragraph with an inline block ID containing an underscore.");
	});

	test("transcludes full block content including nested list items", async () => {
		const processor = makeProcessor(inlineBlocksFixtureRoot, {
			enableTransclusion: true,
		});
		const file = await processor.process({
			value: "![[guide/list-block#^parent-block]]",
			path: path.resolve(inlineBlocksFixtureRoot, "index.md"),
		});
		const output = String(file);
		expect(output).toContain('class="obsidian-transclusion"');
		expect(output).toContain("Parent item one");
		expect(output).toContain("Child item A");
		expect(output).toContain("Child item B");
		expect(output).not.toContain("Sibling item after the block");
	});
	test("recursively transcludes nested embeds", async () => {
		const processor = makeProcessor(recursiveTransclusionFixtureRoot, {
			enableTransclusion: true,
		});
		const file = await processor.process({
			value: "![[guide/middle]]",
			path: path.resolve(recursiveTransclusionFixtureRoot, "index.md"),
		});
		const output = String(file);
		expect(output).toContain('class="obsidian-transclusion"');
		expect(output).toContain("Middle content");
		expect(output).toContain("Deep content here");
	});

	test("detects circular transclusion and preserves original syntax", async () => {
		const processor = makeProcessor(circularTransclusionFixtureRoot, {
			enableTransclusion: true,
		});
		const file = await processor.process({
			value: "![[guide/a]]",
			path: path.resolve(circularTransclusionFixtureRoot, "index.md"),
		});
		const output = String(file);
		expect(output).toContain("Content A");
		expect(output).toContain("Content B");
		expect(file.messages.some((m) => String(m).includes("Circular transclusion"))).toBe(true);
	});

	test("respects max transclusion depth", async () => {
		const processor = makeProcessor(deepTransclusionFixtureRoot, {
			enableTransclusion: true,
		});
		const file = await processor.process({
			value: "![[guide/level1]]",
			path: path.resolve(deepTransclusionFixtureRoot, "index.md"),
		});
		const output = String(file);
		expect(output).toContain("Level 1");
		expect(output).toContain("Level 5");
		expect(output).not.toContain("Level 6");
		expect(file.messages.some((m) => String(m).includes("Max transclusion depth"))).toBe(true);
	});
	test("applies Obsidian transforms inside transcluded content", async () => {
		const processor = makeProcessor(transclusionFeaturesFixtureRoot, {
			enableCallouts: true,
			enableTransclusion: true,
		});
		const file = await processor.process({
			value: "![[source]]",
			path: path.resolve(transclusionFeaturesFixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain('data-callout="tip"');
		expect(output).toContain("<mark>Important</mark>");
		expect(output).toContain("First line. Second line.");
		expect(output).not.toContain("[!tip]");
	});
});

describe("transclusion memoization", () => {
	test("renders a repeated embed once instead of once per occurrence", async () => {
		const os = await import("node:os");
		const fsp = await import("node:fs/promises");
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rspress-transclusion-"));
		try {
			await fsp.writeFile(
				path.join(root, "target.md"),
				"# Target\n\nSee [[missing-page]] for details.\n",
			);
			await fsp.writeFile(path.join(root, "index.md"), "# Index\n");
			const file = await makeProcessor(root, {
				enableTransclusion: true,
				onBrokenLink: "warn",
			}).process({
				value: "![[target]]\n\n![[target]]",
				path: path.resolve(root, "index.md"),
			});

			// Both embeds render, but the transcluded page is parsed once, so the
			// broken link inside it is reported once — a per-embed parse reports
			// it twice.
			expect(String(file).match(/obsidian-transclusion/g)).toHaveLength(2);
			const reports = file.messages.filter((message) =>
				String(message).includes("[[missing-page]]"),
			);
			expect(reports).toHaveLength(1);
		} finally {
			await fsp.rm(root, { recursive: true, force: true });
		}
	});
});

describe("transclusion section boundaries", () => {
	const fencedSectionsFixtureRoot = path.resolve(
		process.cwd(),
		"test/markdown/fixtures/fenced-sections",
	);

	test("ignores a fenced heading that precedes the real one", async () => {
		const processor = makeProcessor(fencedSectionsFixtureRoot, {
			enableTransclusion: true,
		});
		const file = await processor.process({
			value: "![[guide/heading-fence#Install]]",
			path: path.resolve(fencedSectionsFixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain('class="obsidian-transclusion"');
		expect(output).toContain("Real install steps.");
		expect(output).not.toContain("Decoy install steps.");
	});

	test("keeps a fenced block that starts with a hash comment inside the section", async () => {
		const processor = makeProcessor(fencedSectionsFixtureRoot, {
			enableTransclusion: true,
		});
		const file = await processor.process({
			value: "![[guide/comment-fence#Install]]",
			path: path.resolve(fencedSectionsFixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain("Real install steps.");
		expect(output).toContain("bun add rspress-plugin-obsidian");
		expect(output).not.toContain("Trailing content.");
	});
});

describe("vault route prefix", () => {
	const vaultRoutePrefixFixtureRoot = path.resolve(
		process.cwd(),
		"test/markdown/fixtures/vault-route-prefix",
	);

	test("resolves links inside transcluded vault pages under the prefix", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const plugin = markdown({
			vaultRoot: vaultRoutePrefixFixtureRoot,
			vaultRoutePrefix: "/vault",
			enableTransclusion: true,
		});
		const [remarkPlugin, pluginOptions] = (plugin.markdown?.remarkPlugins?.[0] ?? []) as [
			typeof remarkWikilink,
			Parameters<typeof remarkWikilink>[0],
		];

		const file = await unified()
			.use(remarkParse)
			.use(remarkPlugin, pluginOptions)
			.use(remarkStringify)
			.process({
				value: "![[notes/Child]]\n\nDirect [[notes/Sibling]] link.",
				path: path.resolve(vaultRoutePrefixFixtureRoot, "Home.md"),
			});

		const output = String(file);
		// Direct wikilink on the host page, and the wikilink inside the
		// transcluded page: both resolve against the vault index and must carry
		// the vault route prefix.
		expect(output).toContain("(/vault/notes/Sibling)");
		expect(output).toContain('<a href="/vault/notes/Sibling">Sibling</a>');
		expect(output).not.toContain('href="/notes/Sibling"');
		expect(output).not.toContain("](/notes/Sibling)");
	});
});

describe("tag linking", () => {
	test("rewrites tags into markdown links", async () => {
		const processor = makeProcessor(fixtureRoot, {
			enableTagLinking: true,
		});

		const file = await processor.process({
			value: "See #tag and #other_tag.",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toBe("See [#tag](/tags/tag) and [#other\\_tag](/tags/other_tag).\n");
	});
});

describe("callouts", () => {
	test("rewrites obsidian callouts into callout html", async () => {
		const processor = makeProcessor(fixtureRoot, {
			enableCallouts: true,
		});

		const file = await processor.process({
			value: "> [!tip] Pro Tip\n> Body text",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain('<div class="callout callout-tip" data-callout="tip">');
		expect(output).toContain('<div class="callout-title">Pro Tip</div>');
		expect(output).toContain('<div class="callout-content">');
		expect(output).toContain("Body text");
		expect(output).toContain("</div></div>");
	});
});

describe("case-insensitive lookup", () => {
	test("forwards case-insensitive lookup option through remark resolution", async () => {
		const processor = makeProcessor(strictFixtureRoot, {
			enableCaseInsensitiveLookup: true,
		});

		const file = await processor.process({
			value: "Go to [[guide/casesensitive]].",
			path: path.resolve(strictFixtureRoot, "index.md"),
		});

		expect(String(file)).toBe("Go to [CaseSensitive](/guide/CaseSensitive).\n");
	});
});

describe("inline block ID indexing", () => {
	test("indexes standalone block IDs", async () => {
		const index = await buildContentIndex(inlineBlocksFixtureRoot);
		const page = index.byPathKey.get("guide/inline-target");

		expect(page?.blocks.map((b) => b.id)).toContain("standalone-block");
	});

	test("indexes inline block IDs appended to paragraph text", async () => {
		const index = await buildContentIndex(inlineBlocksFixtureRoot);
		const page = index.byPathKey.get("guide/inline-target");

		expect(page?.blocks.map((b) => b.id)).toContain("inline-block");
	});

	test("indexes underscore block IDs in standalone and inline forms", async () => {
		const index = await buildContentIndex(inlineBlocksFixtureRoot);
		const page = index.byPathKey.get("guide/inline-target");
		const ids = page?.blocks.map((block) => block.id) ?? [];

		expect(ids).toEqual(expect.arrayContaining(["standalone_block", "inline_block"]));
	});

	test("resolves a wikilink to an underscore block ID", async () => {
		const index = await buildContentIndex(inlineBlocksFixtureRoot);
		const currentPage = index.byPathKey.get("")!;

		const result = resolveWikiLink(
			parseWikiLink("guide/inline-target#^inline_block", "[[guide/inline-target#^inline_block]]"),
			{ currentPage, index },
		);

		expect(result).toMatchObject({
			status: "ok",
			href: "/guide/inline-target#^inline_block",
		});
	});

	test("resolves wikilink to an inline block ID", async () => {
		const index = await buildContentIndex(inlineBlocksFixtureRoot);
		const currentPage = index.byPathKey.get("")!;

		const result = resolveWikiLink(
			parseWikiLink("guide/inline-target#^inline-block", "[[guide/inline-target#^inline-block]]"),
			{ currentPage, index },
		);

		expect(result).toMatchObject({
			status: "ok",
			href: "/guide/inline-target#^inline-block",
		});
	});
});

describe("frontmatter tags", () => {
	test("indexes tags from frontmatter", async () => {
		const index = await buildContentIndex(tagsFixtureRoot);
		const page = index.byPathKey.get("guide/tagged-page");

		expect(page?.tags).toEqual(["tutorial", "obsidian"]);
	});

	test("builds byTag lookup map", async () => {
		const index = await buildContentIndex(tagsFixtureRoot);

		expect(index.byTag.get("tutorial")?.[0]?.pathKey).toBe("guide/tagged-page");
		expect(index.byTag.get("obsidian")?.[0]?.pathKey).toBe("guide/tagged-page");
	});
});

describe("backlinks caching", () => {
	test("returns the same map object on repeated calls with same index", async () => {
		const { getCachedBacklinksIndex } = await import("../../src/markdown/backlinks");
		const index = await buildContentIndex(fixtureRoot);

		const first = await getCachedBacklinksIndex(index);
		const second = await getCachedBacklinksIndex(index);

		expect(second).toBe(first);
	});

	test("records backlinks for alias and title wikilinks", async () => {
		const index = await buildContentIndex(aliasFixtureRoot);
		const backlinks = index.backlinks.get("/guide/getting-started");

		expect(backlinks).toEqual([{ routePath: "/", relativePath: "index.md", title: "Alias Home" }]);
	});
});

describe("tag regex", () => {
	test("rewrites word tags", async () => {
		const processor = makeProcessor(fixtureRoot, { enableTagLinking: true });
		const file = await processor.process({
			value: "See #tutorial and #my-tag.",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		expect(String(file)).toContain("[#tutorial](/tags/tutorial)");
		expect(String(file)).toContain("[#my-tag](/tags/my-tag)");
	});

	test("does not rewrite purely numeric tags (e.g. issue numbers)", async () => {
		const processor = makeProcessor(fixtureRoot, { enableTagLinking: true });
		const file = await processor.process({
			value: "See issue #123 and PR #456.",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		const output = String(file);
		// Pure-numeric strings after # are not valid Obsidian tags
		expect(output).not.toContain("/tags/123");
		expect(output).not.toContain("/tags/456");
	});

	test("does not rewrite tags inside URL fragments", async () => {
		const processor = makeProcessor(fixtureRoot, { enableTagLinking: true });
		const file = await processor.process({
			value: "See https://example.com/page#section for details.",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		const output = String(file);
		// URL fragment preceded by a word char — should not be rewritten
		expect(output).not.toContain("/tags/section");
	});
});
describe("unicode tag regex", () => {
	test("rewrites Unicode letter and emoji tags", async () => {
		const processor = makeProcessor(fixtureRoot, {
			enableTagLinking: true,
		});
		const file = await processor.process({
			value: "#δοκιμή #🚀",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toContain("[#δοκιμή](/tags/δοκιμή)");
		expect(String(file)).toContain("[#🚀](/tags/🚀)");
	});
});

describe("callout foldable state", () => {
	test("renders static callout as div", async () => {
		const processor = makeProcessor(fixtureRoot, { enableCallouts: true });
		const file = await processor.process({
			value: "> [!note] Title\n> Body",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		const output = String(file);
		expect(output).toContain('<div class="callout callout-note" data-callout="note">');
		expect(output).not.toContain("<details");
	});

	test("renders collapsed callout (-) as closed details element", async () => {
		const processor = makeProcessor(fixtureRoot, { enableCallouts: true });
		const file = await processor.process({
			value: "> [!note]- Collapsed\n> Body",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		const output = String(file);
		expect(output).toContain('<details class="callout callout-note" data-callout="note">');
		expect(output).toContain("<summary");
		expect(output).not.toContain("open");
	});

	test("renders expanded callout (+) as open details element", async () => {
		const processor = makeProcessor(fixtureRoot, { enableCallouts: true });
		const file = await processor.process({
			value: "> [!tip]+ Expanded\n> Body",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		const output = String(file);
		expect(output).toContain('<details class="callout callout-tip" data-callout="tip" open>');
		expect(output).toContain("<summary");
	});
});

describe("Obsidian comment stripping", () => {
	test("strips inline %% comments %% from text", async () => {
		const processor = makeProcessor(fixtureRoot);
		const file = await processor.process({
			value: "Before %% hidden comment %% after.",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		const output = String(file);
		expect(output).not.toContain("hidden comment");
		expect(output).toContain("Before");
		expect(output).toContain("after.");
	});

	test("strips multi-line block %% comments %%", async () => {
		const processor = makeProcessor(fixtureRoot);
		const file = await processor.process({
			value: "%%\nprivate draft content\n%%",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		const output = String(file);
		expect(output).not.toContain("private draft content");
	});

	test("leaves non-comment text untouched", async () => {
		const processor = makeProcessor(fixtureRoot);
		const file = await processor.process({
			value: "Normal text with no comments.",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		expect(String(file)).toContain("Normal text with no comments.");
	});
});

describe("callout type aliases", () => {
	test("maps 'summary' alias to abstract icon", async () => {
		const processor = makeProcessor(fixtureRoot, { enableCallouts: true });
		const file = await processor.process({
			value: "> [!summary] Title\n> Body",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		const output = String(file);
		expect(output).toContain("callout-abstract");
	});

	test("maps 'done' alias to success icon", async () => {
		const processor = makeProcessor(fixtureRoot, { enableCallouts: true });
		const file = await processor.process({
			value: "> [!done] Title\n> Body",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		expect(String(file)).toContain("callout-success");
	});

	test("maps 'fail' alias to failure type", async () => {
		const processor = makeProcessor(fixtureRoot, { enableCallouts: true });
		const file = await processor.process({
			value: "> [!fail] Title\n> Body",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		expect(String(file)).toContain("callout-failure");
	});

	test("maps 'attention' alias to caution type", async () => {
		const processor = makeProcessor(fixtureRoot, { enableCallouts: true });
		const file = await processor.process({
			value: "> [!attention] Title\n> Body",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		expect(String(file)).toContain("callout-caution");
	});
});

describe("setext heading transclusion", () => {
	test("transclubes a setext H1 section", async () => {
		const processor = makeProcessor(setextFixtureRoot, {
			enableTransclusion: true,
		});
		const file = await processor.process({
			value: "![[guide/setext-page#Install]]",
			path: path.resolve(setextFixtureRoot, "index.md"),
		});
		const output = String(file);
		expect(output).toContain('class="obsidian-transclusion"');
		expect(output).toContain("Install steps here");
		expect(output).not.toContain("Introduction content");
	});

	test("transclubes a setext H2 section", async () => {
		const processor = makeProcessor(setextFixtureRoot, {
			enableTransclusion: true,
		});
		const file = await processor.process({
			value: "![[guide/setext-page#Advanced]]",
			path: path.resolve(setextFixtureRoot, "index.md"),
		});
		const output = String(file);
		expect(output).toContain("Advanced content here");
		expect(output).not.toContain("Install steps here");
	});
});

describe("daily note calendar generation", () => {
	const calendarConfig = {
		folder: "",
		dateFormat: "YYYY-MM-DD",
		navigation: true,
		template: "",
		calendar: "/daily",
	};

	test("generates one calendar page listing the daily notes", async () => {
		const { generateDailyNoteCalendar } = await import("../../src/markdown/daily-notes");
		const index = await buildContentIndex(dailyNotesFixtureRoot);
		const pages = generateDailyNoteCalendar(index, calendarConfig);

		expect(pages).toHaveLength(1);
		expect(pages[0]?.routePath).toBe("/daily");
		const content = pages[0]?.content ?? "";
		expect(content).toContain("# Daily notes");
		expect(content).toContain("## August 2026");
		expect(content).toContain("/2026-08-20");
	});

	test("newest month first, and nothing is generated without a route", async () => {
		const { generateDailyNoteCalendar } = await import("../../src/markdown/daily-notes");
		const index = await buildContentIndex(dailyNotesFixtureRoot);

		expect(generateDailyNoteCalendar(index, { ...calendarConfig, calendar: "" })).toEqual([]);

		const content = generateDailyNoteCalendar(index, calendarConfig)[0]?.content ?? "";
		const august = content.indexOf("August 2026");
		expect(august).toBeGreaterThan(-1);
		// The link order inside the month is newest first.
		expect(content.indexOf("/2026-08-21")).toBeLessThan(content.indexOf("/2026-08-19"));
	});

	test("the calendar route reaches addPages when configured", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const plugin = markdown({
			enableDailyNotes: true,
			dailyNotes: { calendar: "daily" },
		});
		const addPages = plugin.addPages as unknown as (config: {
			root?: string;
		}) => Promise<{ routePath: string; content?: string }[]>;

		const pages = await addPages({ root: dailyNotesFixtureRoot });
		const calendar = pages.find((page) => page.routePath === "/daily");

		expect(calendar).toBeDefined();
		expect(calendar?.content).toContain("Daily notes");
	});
});

describe("tag page generation", () => {
	test("generateTagPages produces one page per unique tag", async () => {
		const { generateTagPages } = await import("../../src/markdown/tag-pages");
		const index = await buildContentIndex(tagsFixtureRoot);
		const pages = generateTagPages(index);

		const routes = pages.map((p) => p.routePath);
		expect(routes).toContain("/tags/tutorial");
		expect(routes).toContain("/tags/obsidian");
	});

	test("generated tag page lists pages with that tag", async () => {
		const { generateTagPages } = await import("../../src/markdown/tag-pages");
		const index = await buildContentIndex(tagsFixtureRoot);
		const pages = generateTagPages(index);

		const tutorialPage = pages.find((p) => p.routePath === "/tags/tutorial");
		expect(tutorialPage?.content).toContain("Tagged Guide");
		expect(tutorialPage?.content).toContain("/guide/tagged-page");
	});

	test("escapes title brackets in generated tag page links", async () => {
		const { generateTagPages } = await import("../../src/markdown/tag-pages");
		const index = await buildContentIndex(tagsFixtureRoot);
		// Simulate a page whose title would break out of a markdown link.
		const hostile = index.pages[0];
		if (hostile) {
			hostile.title = "evil](https://evil.example) [x";
		}
		const pages = generateTagPages(index);
		const tutorialPage = pages.find((p) => p.routePath === "/tags/tutorial");

		// The label's brackets are escaped, so no raw `[...](...)` break-out
		// remains and the real link destination is preserved.
		expect(tutorialPage?.content).not.toContain("[evil](");
		expect(tutorialPage?.content).toContain("evil\\]");
		expect(tutorialPage?.content).toContain("](/guide/tagged-page)");
	});

	test("escapes newlines and HTML in tag display names", async () => {
		const { generateTagPages } = await import("../../src/markdown/tag-pages");
		const index = await buildContentIndex(tagsFixtureRoot);
		// Simulate a frontmatter tag containing a newline + HTML.
		const page = index.pages[0];
		if (page) {
			page.tags = ['evil"<script>\nalert(1)</script>'];
		}
		const pages = generateTagPages(index);
		const hostile = pages.find((p) => p.routePath.includes("evil%22%3Cscript%3E"));

		// The heading must be entity-escaped, never raw HTML. The quote is
		// harmless in text-node context and correctly left literal.
		expect(hostile?.content).toContain('# #evil"&lt;script&gt;');
		expect(hostile?.content).toContain("&lt;/script&gt;");
		expect(hostile?.content).not.toContain("# <script>");
		// The YAML scalar must not contain a literal line break (escaped \n).
		expect(hostile?.content).toContain("\\nalert(1)");
	});
});

describe("footnote fixes", () => {
	test("definition lines are stripped from rendered output", async () => {
		const processor = makeProcessor(fixtureRoot);
		const file = await processor.process({
			value: "Reference[^1] here.\n\n[^1]: The definition text.",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		const output = String(file);
		// Raw definition syntax must not appear as literal text
		expect(output).not.toContain("[^1]:");
		// The footnote reference superscript must be present
		expect(output).toContain('id="fnref-1"');
		// The definition must be rendered in the footnotes list
		expect(output).toContain("The definition text.");
		expect(output).toContain('<ol class="footnotes">');
	});

	test("superscript title is populated even when definition appears after reference", async () => {
		const processor = makeProcessor(fixtureRoot);
		const file = await processor.process({
			value: "Reference[^note] here.\n\n[^note]: Def text.",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		const output = String(file);
		expect(output).toContain('title="Def text."');
	});

	test("supports indented multi-line definitions", async () => {
		const processor = makeProcessor(fixtureRoot);
		const file = await processor.process({
			value: "Reference[^long].\n\n[^long]: First line.\n  Second line.",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain("First line. Second line.");
		expect(output).not.toContain("Second line.</p>");
	});

	test("multiple definitions all stripped and all rendered in list", async () => {
		// Use multi-word definitions — single-word definitions (e.g. "[^a]: Alpha.")
		// are indistinguishable from link definitions in remark-parse and stay as
		// linkReference nodes our text visitor won't see. That is a remark-parse
		// limitation, not a plugin bug; real Obsidian notes always use prose.
		const processor = makeProcessor(fixtureRoot);
		const file = await processor.process({
			value: "A[^a] and B[^b].\n\n[^a]: Alpha definition text.\n\n[^b]: Beta definition text.",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		const output = String(file);
		expect(output).not.toContain("[^a]:");
		expect(output).not.toContain("[^b]:");
		expect(output).toContain('id="fn-a"');
		expect(output).toContain('id="fn-b"');
		expect(output).toContain("Alpha definition text.");
		expect(output).toContain("Beta definition text.");
	});

	test("inline footnote ^[text] renders as numbered superscript", async () => {
		const processor = makeProcessor(fixtureRoot);
		const file = await processor.process({
			value: "Inline footnote^[This is inline content] here.",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		const output = String(file);
		expect(output).toContain('id="fnref-inline-1"');
		expect(output).toContain('title="This is inline content"');
		expect(output).toContain('id="fn-inline-1"');
		expect(output).toContain('<ol class="footnotes">');
		expect(output).toContain("This is inline content");
	});

	test("inline footnote content with markdown renders as markup", async () => {
		// The closing bracket lands in a different node than the opener here, so a
		// per-text-node scan would miss the footnote entirely.
		const processor = makeProcessor(fixtureRoot);
		const file = await processor.process({
			value: "Inline^[with **bold**, `code` and [docs](https://example.com) here] ends.",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		const output = String(file);

		expect(output).toContain('id="fnref-inline-1"');
		expect(output).toContain('id="fn-inline-1"');
		expect(output).toContain("<strong>bold</strong>");
		expect(output).toContain("<code>code</code>");
		expect(output).toContain('href="https://example.com"');
		// The body keeps its own text; only the construct is replaced.
		expect(output).toContain("ends.");
	});

	test("inline footnote content keeps a wikilink and its brackets", async () => {
		const processor = makeProcessor(fixtureRoot);
		const file = await processor.process({
			value: "See this^[the [[getting-started]] page] for more.",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		const output = String(file);

		expect(output).toContain('id="fn-inline-1"');
		// The nested link resolves to a real anchor in the rendered definition,
		// and the brackets that once truncated the construct are consumed.
		expect(output).toMatch(/<li id="fn-inline-1">the <a href="\/[^"]*">getting started<\/a> page/);
		// Nothing dangling is left in the body — only the hover title keeps the
		// source, brackets and all.
		expect(output.split("footnotes\n")[1] ?? "").not.toContain("]]");
	});

	test("an unclosed inline footnote stays literal text", async () => {
		const processor = makeProcessor(fixtureRoot);
		const file = await processor.process({
			value: "A ^[dangling note without a closer.",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		const output = String(file);

		expect(output).not.toContain("footnote-ref");
		// Serialized with the caret escaped, exactly as the reader wrote it.
		expect(output).toContain("^\\[dangling");
	});

	test("inline and label footnotes coexist in same document", async () => {
		const processor = makeProcessor(fixtureRoot);
		const file = await processor.process({
			value: "Label[^lbl] and inline^[Inline text] together.\n\n[^lbl]: Label def.",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		const output = String(file);
		expect(output).toContain('id="fnref-lbl"');
		expect(output).toContain('id="fnref-inline-1"');
		expect(output).toContain('id="fn-lbl"');
		expect(output).toContain('id="fn-inline-1"');
	});

	test("definition content renders inline markdown and resolved wikilinks", async () => {
		const processor = makeProcessor(fixtureRoot);
		const file = await processor.process({
			value:
				"Reference[^md] here.\n\n[^md]: A **bold** word, `code`, and [[getting-started|the guide]].",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		const output = String(file);

		// The footnotes list carries rendered HTML, not literal markdown.
		expect(output).toContain("<strong>bold</strong>");
		expect(output).toContain("<code>code</code>");
		expect(output).toMatch(/<a href="\/[^"]*">the guide<\/a>/);
		// The definition paragraph is fully stripped: the raw markdown remains
		// only in the hover title, never as a leaked body paragraph.
		expect(output.split("**bold** word")).toHaveLength(2);
		expect(output.split('id="fn-md"')).toHaveLength(2);
		// The hover title keeps the plain-text source.
		expect(output).toContain('title="A **bold** word, `code`, and [[getting-started|the guide]]."');
		expect(output).not.toContain("[^md]:");
	});
});

describe("nested tag linking", () => {
	test("rewrites nested #parent/child tag into a link", async () => {
		const processor = makeProcessor(fixtureRoot, { enableTagLinking: true });
		const file = await processor.process({
			value: "See #parent/child here.",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		expect(String(file)).toContain("[#parent/child](/tags/parent/child)");
	});

	test("rewrites deeply nested #a/b/c tag", async () => {
		const processor = makeProcessor(fixtureRoot, { enableTagLinking: true });
		const file = await processor.process({
			value: "Topic #a/b/c nested.",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		expect(String(file)).toContain("[#a/b/c](/tags/a/b/c)");
	});

	test("does not match URL fragments as nested tags", async () => {
		const processor = makeProcessor(fixtureRoot, { enableTagLinking: true });
		const file = await processor.process({
			value: "See https://example.com/page#section/sub for details.",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		expect(String(file)).not.toContain("/tags/section");
	});
});

describe("unicode tag linking", () => {
	test("rewrites Latin extended tags (accented chars)", async () => {
		const processor = makeProcessor(fixtureRoot, { enableTagLinking: true });
		const file = await processor.process({
			value: "Tag #résumé here.",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		expect(String(file)).toContain("/tags/r");
		expect(String(file)).toContain("sum");
	});

	test("rewrites CJK unicode tags", async () => {
		const processor = makeProcessor(fixtureRoot, { enableTagLinking: true });
		const file = await processor.process({
			value: "Tag #中文 here.",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		expect(String(file)).toContain("/tags/中文");
	});
});

describe("cssclasses wrapper", () => {
	test("wraps page content in classed div when cssclasses are set", async () => {
		const processor = makeProcessor(cssclassesFixtureRoot);
		const file = await processor.process({
			value: "Content here.",
			path: path.resolve(cssclassesFixtureRoot, "guide/styled.md"),
		});
		const output = String(file);
		expect(output).toContain('<div class="custom-layout dark-theme">');
		expect(output).toContain("Content here.");
		expect(output).toContain("</div>");
	});

	test("does not inject wrapper when cssclasses is empty", async () => {
		const processor = makeProcessor(cssclassesFixtureRoot);
		const file = await processor.process({
			value: "Plain content.",
			path: path.resolve(cssclassesFixtureRoot, "index.md"),
		});
		const output = String(file);
		expect(output).not.toContain('<div class="');
		expect(output).toContain("Plain content.");
	});
});

describe("callout type coverage", () => {
	test("renders todo callout type", async () => {
		const processor = makeProcessor(fixtureRoot, { enableCallouts: true });
		const file = await processor.process({
			value: "> [!todo] My Task\n> Do the thing",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		expect(String(file)).toContain("callout-todo");
	});

	test("maps hint alias to tip", async () => {
		const processor = makeProcessor(fixtureRoot, { enableCallouts: true });
		const file = await processor.process({
			value: "> [!hint] A Hint\n> Body",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		expect(String(file)).toContain("callout-tip");
	});

	test("maps important alias to tip", async () => {
		const processor = makeProcessor(fixtureRoot, { enableCallouts: true });
		const file = await processor.process({
			value: "> [!important] Important\n> Body",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		expect(String(file)).toContain("callout-tip");
	});

	test("maps error alias to danger", async () => {
		const processor = makeProcessor(fixtureRoot, { enableCallouts: true });
		const file = await processor.process({
			value: "> [!error] An Error\n> Body",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		expect(String(file)).toContain("callout-danger");
	});

	test("maps cite alias to quote", async () => {
		const processor = makeProcessor(fixtureRoot, { enableCallouts: true });
		const file = await processor.process({
			value: "> [!cite] Citation\n> Body",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		expect(String(file)).toContain("callout-quote");
	});
});

describe("nested callouts", () => {
	test("processes nested callout (post-order)", async () => {
		const processor = makeProcessor(fixtureRoot, { enableCallouts: true });
		const file = await processor.process({
			value: "> [!note] Outer\n> > [!tip] Inner\n> > Content",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		const output = String(file);
		expect(output).toContain('class="callout callout-note"');
		expect(output).toContain('class="callout callout-tip"');
		expect(output).toContain('<div class="callout-title">Outer</div>');
		expect(output).toContain('<div class="callout-title">Inner</div>');
		expect(output).toContain("Content");
		// Inner callout must be nested inside outer (appear after outer's opening tag)
		const outerIdx = output.indexOf("callout-note");
		const innerIdx = output.indexOf("callout-tip");
		expect(innerIdx).toBeGreaterThan(outerIdx);
	});

	test("processes triple-nested callouts", async () => {
		const processor = makeProcessor(fixtureRoot, { enableCallouts: true });
		const file = await processor.process({
			value: "> [!note] Level 1\n> > [!tip] Level 2\n> > > [!warning] Level 3\n> > > Deep",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		const output = String(file);
		expect(output).toContain("callout-note");
		expect(output).toContain("callout-tip");
		expect(output).toContain("callout-warning");
		// Verify inner-to-outer ordering
		const idx1 = output.indexOf("callout-note");
		const idx2 = output.indexOf("callout-tip");
		const idx3 = output.indexOf("callout-warning");
		expect(idx3).toBeGreaterThan(idx2);
		expect(idx2).toBeGreaterThan(idx1);
	});

	test("processes nested callout with foldable state", async () => {
		const processor = makeProcessor(fixtureRoot, { enableCallouts: true });
		const file = await processor.process({
			value: "> [!note]- Collapsed outer\n> > [!tip]+ Expanded inner\n> > Body",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		const output = String(file);
		expect(output).toContain('<details class="callout callout-note"');
		expect(output).toContain('<details class="callout callout-tip" data-callout="tip" open');
		expect(output).toContain("Collapsed outer");
		expect(output).toContain("Expanded inner");
	});
});

describe("nested tag indexing", () => {
	test("indexes the full nested tag path in page.tags", async () => {
		const index = await buildContentIndex(nestedTagsFixtureRoot);
		const page = index.byPathKey.get("guide/nested");
		expect(page?.tags).toContain("frontend/react");
		expect(page?.tags).toContain("tools/bun");
	});

	test("aggregates pages into parent tag segment in byTag", async () => {
		const index = await buildContentIndex(nestedTagsFixtureRoot);
		const frontendPages = index.byTag.get("frontend");
		expect(frontendPages?.some((p) => p.pathKey === "guide/nested")).toBe(true);
	});

	test("aggregates pages into tools parent segment", async () => {
		const index = await buildContentIndex(nestedTagsFixtureRoot);
		const toolsPages = index.byTag.get("tools");
		expect(toolsPages?.some((p) => p.pathKey === "guide/nested")).toBe(true);
	});
});

describe("nested tag pages", () => {
	test("generates page for full nested tag path", async () => {
		const { generateTagPages } = await import("../../src/markdown/tag-pages");
		const index = await buildContentIndex(nestedTagsFixtureRoot);
		const pages = generateTagPages(index);
		const routes = pages.map((p) => p.routePath);
		expect(routes).toContain("/tags/frontend/react");
		expect(routes).toContain("/tags/tools/bun");
	});

	test("generates parent tag page that aggregates child-tagged pages", async () => {
		const { generateTagPages } = await import("../../src/markdown/tag-pages");
		const index = await buildContentIndex(nestedTagsFixtureRoot);
		const pages = generateTagPages(index);
		const frontendPage = pages.find((p) => p.routePath === "/tags/frontend");
		expect(frontendPage).toBeDefined();
		expect(frontendPage?.content).toContain("Nested Tags");
	});
});

describe("tag path URL encoding", () => {
	test("encodes whitespace in tag names", async () => {
		const { encodeTagPathSegment } = await import("../../src/markdown/tag-pages");
		expect(encodeTagPathSegment("hello world")).toBe("hello%20world");
	});

	test("encodes HTML-reserved characters", async () => {
		const { encodeTagPathSegment } = await import("../../src/markdown/tag-pages");
		expect(encodeTagPathSegment("a&b")).toBe("a%26b");
		expect(encodeTagPathSegment('a"b')).toBe("a%22b");
		expect(encodeTagPathSegment("a<b>c")).toBe("a%3Cb%3Ec");
	});

	test("encodes URL-reserved characters", async () => {
		const { encodeTagPathSegment } = await import("../../src/markdown/tag-pages");
		expect(encodeTagPathSegment("a#b")).toBe("a%23b");
		expect(encodeTagPathSegment("a?b")).toBe("a%3Fb");
		expect(encodeTagPathSegment("a%b")).toBe("a%25b");
	});

	test("preserves Unicode letters unencoded", async () => {
		const { encodeTagPathSegment } = await import("../../src/markdown/tag-pages");
		expect(encodeTagPathSegment("中文")).toBe("中文");
		expect(encodeTagPathSegment("café")).toBe("café");
		expect(encodeTagPathSegment("日本語")).toBe("日本語");
	});

	test("preserves nested tag separators", async () => {
		const { encodeTagPathSegment } = await import("../../src/markdown/tag-pages");
		expect(encodeTagPathSegment("parent/child")).toBe("parent/child");
		expect(encodeTagPathSegment("a/b/c")).toBe("a/b/c");
	});

	test("preserves hyphens, underscores, and digits", async () => {
		const { encodeTagPathSegment } = await import("../../src/markdown/tag-pages");
		expect(encodeTagPathSegment("my-tag_v2")).toBe("my-tag_v2");
	});
});

describe("highlight syntax", () => {
	test("converts highlighted text to mark tags", async () => {
		const processor = makeProcessor(fixtureRoot);
		const file = await processor.process({
			value: "This is ==highlighted text==.",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toContain("<mark>highlighted text</mark>");
	});

	test("converts multiple highlights in one line", async () => {
		const processor = makeProcessor(fixtureRoot);
		const file = await processor.process({
			value: "==one== and ==two==",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toContain("<mark>one</mark>");
		expect(String(file)).toContain("<mark>two</mark>");
	});

	test("does not convert highlights inside inline code", async () => {
		const processor = makeProcessor(fixtureRoot);
		const file = await processor.process({
			value: "`==not highlighted==`",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).not.toContain("<mark>not highlighted</mark>");
		expect(String(file)).toContain("`==not highlighted==`");
	});

	test("allows a single equals sign inside a highlight", async () => {
		const processor = makeProcessor(fixtureRoot);
		const file = await processor.process({
			value: "Set ==key=value== here.",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toContain("<mark>key=value</mark>");
	});

	test("leaves a bare run of four equals signs alone", async () => {
		const processor = makeProcessor(fixtureRoot);
		const file = await processor.process({
			value: "a ==== b",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).not.toContain("<mark>");
		expect(output).toContain("====");
	});
});

describe("media embeds", () => {
	test("renders image embeds as lazy-loaded img tags", async () => {
		const processor = makeProcessor(fixtureRoot, { enableMediaEmbeds: true });
		const file = await processor.process({
			value: "![[image.png]]",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain('<img src="/image.png" alt="image.png"');
		expect(output).toContain('loading="lazy"');
	});

	test("renders audio embeds as audio tags", async () => {
		const processor = makeProcessor(fixtureRoot, { enableMediaEmbeds: true });
		const file = await processor.process({
			value: "![[audio.mp3]]",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain('audio controls src="/audio.mp3"');
		expect(output).toContain("</audio>");
	});

	test("renders video embeds as video tags", async () => {
		const processor = makeProcessor(fixtureRoot, { enableMediaEmbeds: true });
		const file = await processor.process({
			value: "![[video.mp4]]",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain('video controls src="/video.mp4"');
		expect(output).toContain("</video>");
	});

	test("renders pdf embeds as iframes", async () => {
		const processor = makeProcessor(fixtureRoot, { enableMediaEmbeds: true });
		const file = await processor.process({
			value: "![[doc.pdf]]",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		// A bare frame told a reader nothing: not which document, and no way out
		// on a browser that cannot display one. The figure names the file and
		// links to it.
		expect(output).toContain('<figure class="obsidian-pdf">');
		expect(output).toContain('<span class="obsidian-pdf-name">doc');
		expect(output).toContain('<span class="obsidian-pdf-ext">.pdf</span>');
		expect(output).toContain(
			'<a class="obsidian-pdf-open" href="/doc.pdf" target="_blank" rel="noopener noreferrer"',
		);
		expect(output).toContain('aria-label="Open doc.pdf in a new tab"');
		expect(output).toContain('<iframe class="obsidian-pdf-frame" src="/doc.pdf" title="doc.pdf"');
		expect(output).toContain('width="100%" height="600px" frameborder="0"');
		expect(output).toContain('loading="lazy"');
		// Deliberate: Chromium's PDF viewer needs scripts, so a sandbox here would
		// break the embed rather than harden it (verified in a browser).
		expect(output).not.toContain("sandbox=");
		expect(output).toContain("</iframe>");
		expect(output).toContain("</figure>");
	});

	test("names a PDF embed after the file, not the path that reached it", async () => {
		const processor = makeProcessor(assetsFixtureRoot, { enableMediaEmbeds: true });
		const file = await processor.process({
			// The subpath is a viewer location, so it belongs in the `src` and in
			// the link out — but not in the name a reader is shown.
			value: "![[media/../Document.pdf#page=3]]",
			path: path.resolve(assetsFixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain('<span class="obsidian-pdf-name">Document');
		expect(output).toContain('title="Document.pdf"');
		expect(output).not.toContain("media/../");
	});

	test("passes width and height attributes for sized image embeds", async () => {
		const processor = makeProcessor(fixtureRoot, { enableMediaEmbeds: true });
		const file = await processor.process({
			value: "![[image.png|300x200]]",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toContain(
			'<img src="/image.png" alt="image.png" width="300" height="200" loading="lazy" />',
		);
	});

	test("passes only width attribute when only width is provided", async () => {
		const processor = makeProcessor(fixtureRoot, { enableMediaEmbeds: true });
		const file = await processor.process({
			value: "![[image.png|300]]",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toContain(
			'<img src="/image.png" alt="image.png" width="300" loading="lazy" />',
		);
	});

	test("emits a warning for missing media files while still rendering HTML", async () => {
		const processor = makeProcessor(fixtureRoot, { enableMediaEmbeds: true });
		const file = await processor.process({
			value: "![[image.png]]",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toContain('<img src="/image.png" alt="image.png"');
		expect(file.messages).toHaveLength(1);
		expect(String(file.messages[0])).toContain('Image "image.png" not found');
	});
	test("resolves attachment wikilinks", async () => {
		const processor = makeProcessor(assetsFixtureRoot);
		const file = await processor.process({
			value: "[[image.png]]",
			path: path.resolve(assetsFixtureRoot, "index.md"),
		});

		expect(String(file)).toContain("[image.png](/image.png)");
	});
	test("resolves attachment basenames case-insensitively", async () => {
		const processor = makeProcessor(assetsFixtureRoot, {
			enableCaseInsensitiveLookup: true,
		});
		const file = await processor.process({
			value: "[[IMAGE.PNG]]",
			path: path.resolve(assetsFixtureRoot, "index.md"),
		});

		expect(String(file)).toContain("[image.png](/image.png)");
	});

	test("embeds every format the shared table lists, for images", async () => {
		// The tables in media-exts.ts are the source of truth, so this test
		// cannot fall behind them: adding a format there fails here until a
		// renderer knows what to emit for it.
		const processor = makeProcessor(fixtureRoot, { enableMediaEmbeds: true });
		for (const ext of IMAGE_EXTS) {
			const file = await processor.process({
				value: `![[file.${ext}]]`,
				path: path.resolve(fixtureRoot, "index.md"),
			});
			expect(String(file)).toContain(`<img src="/file.${ext}"`);
		}
	});

	test("embeds every format the shared table lists, for audio, video and PDF", async () => {
		const processor = makeProcessor(fixtureRoot, { enableMediaEmbeds: true });
		for (const ext of AUDIO_EXTS) {
			const file = await processor.process({
				value: `![[file.${ext}]]`,
				path: path.resolve(fixtureRoot, "index.md"),
			});
			expect(String(file)).toContain(`<audio controls src="/file.${ext}"`);
		}
		for (const ext of VIDEO_EXTS) {
			const file = await processor.process({
				value: `![[file.${ext}]]`,
				path: path.resolve(fixtureRoot, "index.md"),
			});
			expect(String(file)).toContain(`<video controls src="/file.${ext}"`);
		}
		const pdf = await processor.process({
			value: `![[file.${PDF_EXT}]]`,
			path: path.resolve(fixtureRoot, "index.md"),
		});
		expect(String(pdf)).toContain(
			`<iframe class="obsidian-pdf-frame" src="/file.${PDF_EXT}" title="file.${PDF_EXT}"`,
		);
	});

	test("keeps a capitalized extension embedding as that format", async () => {
		// Obsidian matches a file's extension without caring about case, and a
		// vault written on Windows is full of `.PNG` and `.MP4`.
		const processor = makeProcessor(assetsFixtureRoot, { enableMediaEmbeds: true });
		const file = await processor.process({
			value: "![[photo.BMP]] ![[tone.3GP]] ![[clip.OGV]]",
			path: path.resolve(assetsFixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain('<img src="/photo.BMP"');
		expect(output).toContain('<audio controls src="/tone.3GP"');
		expect(output).toContain('<video controls src="/clip.OGV"');
	});

	test("sizes a markdown image the way a wikilink embed is sized", async () => {
		// Obsidian documents "the same syntax as a wikilink" for markdown images.
		const processor = makeProcessor(assetsFixtureRoot, { enableMediaEmbeds: true });
		const file = await processor.process({
			value: "![250](image.png) ![250x145](image.png) ![A picture|80](image.png)",
			path: path.resolve(assetsFixtureRoot, "index.md"),
		});

		const output = String(file);
		// A size in the alt leaves no caption behind, so the file's own name
		// becomes the alt text.
		expect(output).toContain('<img src="image.png" alt="image" width="250"');
		expect(output).toContain('width="250" height="145"');
		expect(output).toContain('alt="A picture" width="80"');
	});

	test("sizes a markdown image with markdown links turned off", async () => {
		// A size on a markdown image is media, not note transclusion. It used to
		// ride in behind `enableMarkdownLinks`, so this combination silently did
		// nothing, and `![alt](Note.md)` must still stay a plain image here.
		const processor = makeProcessor(assetsFixtureRoot, {
			enableMediaEmbeds: true,
			enableMarkdownLinks: false,
		});
		const file = await processor.process({
			value: "![300](image.png) ![A caption|300](image.png)",
			path: path.resolve(assetsFixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain('alt="image" width="300"');
		expect(output).toContain('alt="A caption" width="300"');
	});

	test("keeps a markdown note image plain when markdown links are off", async () => {
		const processor = makeProcessor(fixtureRoot, {
			enableMediaEmbeds: true,
			enableMarkdownLinks: false,
			enableTransclusion: true,
		});
		const file = await processor.process({
			value: "![Setup](setup.md)",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		// No transclusion, and no size invented from a caption either.
		expect(String(file)).toContain("Setup");
		expect(String(file)).not.toContain("<iframe");
	});

	test("leaves a markdown image without a size pipe exactly as it was", async () => {
		const processor = makeProcessor(assetsFixtureRoot, { enableMediaEmbeds: true });
		const file = await processor.process({
			// A caption, not a dimension: no size may be claimed from it.
			value: "![A picture|wide](image.png)",
			path: path.resolve(assetsFixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain("A picture|wide");
		expect(output).not.toContain("width=");
	});

	test("supports PDF page and height fragments", async () => {
		const processor = makeProcessor(assetsFixtureRoot, {
			enableMediaEmbeds: true,
		});
		const file = await processor.process({
			value: "![[Document.pdf#page=3]]\n\n![[Document.pdf#height=400]]",
			path: path.resolve(assetsFixtureRoot, "index.md"),
		});

		const output = String(file);
		// `#page=3` is a viewer location, so it travels to the file, to the frame
		// and to the link out…
		expect(output).toContain(
			'<iframe class="obsidian-pdf-frame" src="/Document.pdf#page=3" title="Document.pdf" width="100%" height="600px"',
		);
		expect(output).toContain('href="/Document.pdf#page=3"');
		// …while `#height=400` is a property of this embed: an attribute only,
		// never a fragment the browser would hand to the PDF itself.
		expect(output).toContain(
			'<iframe class="obsidian-pdf-frame" src="/Document.pdf" title="Document.pdf" width="100%" height="400px"',
		);
		expect(output).not.toContain("#height=");
	});
	test("preserves order and sibling nodes for multiple inline media embeds", async () => {
		const processor = makeProcessor(assetsFixtureRoot, {
			enableMediaEmbeds: true,
		});
		const file = await processor.process({
			value: "Before ![[image.png]] **middle** ![[Document.pdf]] after",
			path: path.resolve(assetsFixtureRoot, "index.md"),
		});

		const output = String(file);
		const imagePosition = output.indexOf('<img src="/image.png"');
		const middlePosition = output.indexOf("middle");
		const pdfPosition = output.indexOf('<iframe class="obsidian-pdf-frame" src="/Document.pdf"');

		expect(imagePosition).toBeGreaterThanOrEqual(0);
		expect(middlePosition).toBeGreaterThan(imagePosition);
		expect(pdfPosition).toBeGreaterThan(middlePosition);
		expect(output).toContain("Before");
		expect(output).toContain("after");
		expect(output).not.toContain("![[image.png]]");
		expect(output).not.toContain("![[Document.pdf]]");
	});

	test("preserves image fragments", async () => {
		const processor = makeProcessor(assetsFixtureRoot, {
			enableMediaEmbeds: true,
		});
		const file = await processor.process({
			value: "![[image.png#outline|100]]",
			path: path.resolve(assetsFixtureRoot, "index.md"),
		});

		expect(String(file)).toContain('<img src="/image.png#outline" alt="image.png" width="100"');
	});

	test("does not emit path traversal in media embed URLs", async () => {
		const processor = makeProcessor(fixtureRoot, { enableMediaEmbeds: true });
		const file = await processor.process({
			value: "![[../../secret.png]]",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		// The URL must be traversal-free; only the alt attribute may echo the
		// original (unescaped) target text.
		expect(output).not.toContain('src="../');
		expect(output).toContain('src="/secret.png"');
	});
	test("uses the shared parser for escaped image aliases", async () => {
		const processor = makeProcessor(assetsFixtureRoot, {
			enableMediaEmbeds: true,
		});
		const file = await processor.process({
			value: "![[image.png|A \\| B]]",
			path: path.resolve(assetsFixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain('alt="A | B"');
		expect(output).not.toContain("A \\| B");
	});
});

describe("backlinks HTML", () => {
	test("returns empty string when there are no backlinks", async () => {
		const { renderBacklinksHtml } = await import("../../src/markdown/backlinks");

		expect(renderBacklinksHtml([])).toBe("");
	});

	test("renders backlinks panel HTML for backlink refs", async () => {
		const { renderBacklinksHtml } = await import("../../src/markdown/backlinks");

		const html = renderBacklinksHtml([
			{ routePath: "/", title: "Home" },
			{ routePath: "/guide/advanced", title: "Advanced" },
		]);

		expect(html).toContain('<div class="obsidian-backlinks">');
		expect(html).toContain("<h2>Backlinks</h2>");
		expect(html).toContain('<li><a href="/">Home</a></li>');
		expect(html).toContain('<li><a href="/guide/advanced">Advanced</a></li>');
	});
	test("encodes spaces in backlink hrefs", async () => {
		const { renderBacklinksHtml } = await import("../../src/markdown/backlinks");

		const html = renderBacklinksHtml([
			{ routePath: "/vault/create a link", title: "Create a Link" },
		]);

		expect(html).toContain('href="/vault/create%20a%20link"');
	});

	test("builds backlinks for linked pages", async () => {
		const { buildBacklinksIndex } = await import("../../src/markdown/backlinks");
		const index = await buildContentIndex(fixtureRoot);
		const backlinks = await buildBacklinksIndex(index);

		expect(backlinks.get("/guide/getting-started")).toEqual([
			{ routePath: "/", relativePath: "index.md", title: "Home" },
		]);
	});
	test("builds backlinks for note-relative wikilinks", async () => {
		const { buildBacklinksIndex } = await import("../../src/markdown/backlinks");
		const index = await buildContentIndex(compatibilityFixtureRoot);
		const backlinks = await buildBacklinksIndex(index);

		expect(backlinks.get("/shared/Concept")).toEqual([
			{ routePath: "/notes/current", relativePath: "notes/current.md", title: "Current Note" },
		]);
	});
});

describe("error boundary", () => {
	test("does not crash when processing a file outside the content index", async () => {
		const processor = makeProcessor(fixtureRoot);
		const file = await processor.process({
			value: "[[guide/getting-started]]",
			path: path.resolve(fixtureRoot, "missing.md"),
		});

		expect(String(file)).toContain("guide/getting-started");
		expect(file.messages).toHaveLength(1);
		expect(String(file.messages[0])).toContain("not found in content index");
	});

	test("emits a warning for self-transclusion", async () => {
		const processor = makeProcessor(fixtureRoot, { enableTransclusion: true });
		const file = await processor.process({
			value: "![[index]]",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toContain('data-obsidian-embed="true"');
		expect(file.messages).toHaveLength(1);
		expect(String(file.messages[0])).toContain("Circular transclusion detected");
	});
});

describe("diagnostic modes", () => {
	test("emits a warning instead of throwing when onBrokenLink is warn", async () => {
		const processor = makeProcessor(fixtureRoot, { onBrokenLink: "warn" });
		const file = await processor.process({
			value: "[[nonexistent]]",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toContain("nonexistent");
		expect(file.messages).toHaveLength(1);
		expect(String(file.messages[0])).toContain("[[nonexistent]]");
	});

	test("resolves valid links after a broken link when onBrokenLink is warn", async () => {
		const processor = makeProcessor(fixtureRoot, { onBrokenLink: "warn" });
		const file = await processor.process({
			value: "Broken [[nonexistent]] then valid [[guide/getting-started]].",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toContain("/guide/getting-started");
	});

	test("throws a fatal error when onBrokenLink is error", async () => {
		const processor = makeProcessor(fixtureRoot, { onBrokenLink: "error" });

		await expect(
			processor.process({
				value: "[[nonexistent]]",
				path: path.resolve(fixtureRoot, "index.md"),
			}),
		).rejects.toThrow();
	});
});

describe("plugin diagnostics on the console", () => {
	const basicRoot = path.resolve(process.cwd(), "test/markdown/fixtures/basic");
	const circularRoot = path.resolve(process.cwd(), "test/markdown/fixtures/circular-transclusion");
	const dataviewRoot = path.resolve(process.cwd(), "test/markdown/fixtures/dataview-sources");

	/** Warnings printed while `value` is processed. Rspress ignores `file.messages`. */
	async function warningsFor(
		root: string,
		value: string,
		overrides: Partial<NormalizedPluginOptions>,
	): Promise<string[]> {
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
		try {
			await makeProcessor(root, overrides).process({
				value,
				path: path.resolve(root, "index.md"),
			});
		} finally {
			console.warn = original;
		}
		return warnings;
	}

	test("a warn-level Dataview diagnostic reaches the console", async () => {
		const warnings = await warningsFor(
			dataviewRoot,
			["```dataview", "TABLE file.name", "FROM nothing/../else", "```"].join("\n"),
			{ enableDataview: true, onDataviewError: "warn" },
		);

		expect(warnings.some((line) => line.includes("dataview"))).toBe(true);
	});

	test("a transclusion diagnostic reaches the console", async () => {
		const warnings = await warningsFor(circularRoot, "![[guide/a]]", { enableTransclusion: true });

		expect(warnings.some((line) => line.includes("Circular transclusion"))).toBe(true);
	});

	test("a media miss reaches the console", async () => {
		const warnings = await warningsFor(basicRoot, "![[nope.png]]", { enableMediaEmbeds: true });

		expect(warnings.some((line) => line.includes("nope.png"))).toBe(true);
	});
});

describe("content index resilience", () => {
	test("reuses unchanged page objects across incremental rebuilds", async () => {
		const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
		const tmp = await import("node:os");
		const pathMod = await import("node:path");
		const root = mkdtempSync(pathMod.join(tmp.tmpdir(), "vault-"));
		mkdirSync(pathMod.join(root, "sub"), { recursive: true });
		writeFileSync(pathMod.join(root, "a.md"), "# A\n\nHeading A");
		writeFileSync(pathMod.join(root, "sub", "b.md"), "# B\n\nHeading B");

		const first = await getCachedContentIndex(root);
		const a1 = first.byPathKey.get("a");
		const b1 = first.byPathKey.get("sub/b");

		writeFileSync(pathMod.join(root, "sub", "b.md"), "# B\n\n## New Heading");
		const second = await getCachedContentIndex(root);
		const a2 = second.byPathKey.get("a");
		const b2 = second.byPathKey.get("sub/b");

		expect(a2).toBe(a1);
		expect(b2).not.toBe(b1);
		expect(b2?.headings.map((h) => h.rawText)).toEqual(["B", "New Heading"]);

		rmSync(root, { recursive: true, force: true });
	});
});

describe("publish: false route exclusion", () => {
	const publishFalseRoot = path.resolve(process.cwd(), "test/markdown/fixtures/publish-false");

	/** The slice of rspress's route service this hook touches. */
	function fakeRouteService(files: string[]) {
		const routeData = new Map(
			files.map((file, index) => [
				`/page-${index}`,
				{ routeMeta: { absolutePath: path.join(publishFalseRoot, file) } },
			]),
		);
		return { routeData };
	}

	async function excludedFiles(): Promise<string[]> {
		const { markdown } = await import("../../src/markdown/index");
		const plugin = markdown();
		const configFn = plugin.config as unknown as (config: Record<string, unknown>) => unknown;
		configFn({ root: publishFalseRoot });
		const service = fakeRouteService(["draft.md", "live.md"]);
		await plugin.routeServiceGenerated?.(service as never, false);
		return [...service.routeData.values()].map((page) =>
			path.basename(page.routeMeta?.absolutePath ?? ""),
		);
	}

	test("removes the route of a page marked publish: false", async () => {
		expect(await excludedFiles()).toEqual(["live.md"]);
	});

	test("leaves a page without the marker routed", async () => {
		const routes = await excludedFiles();

		expect(routes).not.toContain("draft.md");
		expect(routes).toContain("live.md");
	});

	test("keeps a file whose frontmatter cannot be parsed", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const plugin = markdown();
		const configFn = plugin.config as unknown as (config: Record<string, unknown>) => unknown;
		configFn({ root: publishFalseRoot });
		const service = fakeRouteService(["missing.md"]);
		await plugin.routeServiceGenerated?.(service as never, false);

		// An unreadable file is not evidence of `publish: false`, and the
		// frontmatter pass already reports it.
		expect(service.routeData.size).toBe(1);
	});
});

describe("wikilink API", () => {
	test("returns the expected base plugin shape", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const plugin = markdown();

		expect(plugin.name).toBe("rspress-plugin-obsidian:markdown");
		expect(plugin.markdown?.remarkPlugins).toBeArray();
		expect(plugin.markdown?.remarkPlugins).toHaveLength(1);
		expect(plugin.config).toBeFunction();
	});

	test("adds globalStyles when default styles are enabled", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const plugin = markdown({ enableDefaultStyles: true });

		expect(plugin.name).toBe("rspress-plugin-obsidian:markdown");
		expect(plugin.globalStyles).toBeDefined();
		expect(typeof plugin.globalStyles).toBe("string");
	});

	test("does not add globalStyles by default", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const pluginDefault = markdown();

		expect("globalStyles" in pluginDefault).toBe(false);
	});

	test("adds addPages when tag pages are enabled", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const plugin = markdown({ enableTagPages: true });

		expect(plugin.addPages).toBeDefined();
		expect(typeof plugin.addPages).toBe("function");
	});

	test("does not add addPages by default", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const pluginDefault = markdown();

		expect("addPages" in pluginDefault).toBe(false);
	});

	test("defaults to case-insensitive lookup, matching Obsidian", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const plugin = markdown();
		const tuple = plugin.markdown?.remarkPlugins?.[0] as [
			unknown,
			{ options: NormalizedPluginOptions },
		];

		expect(tuple[1].options.enableCaseInsensitiveLookup).toBe(true);
	});

	test("allows opting out of case-insensitive lookup", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const plugin = markdown({
			enableCaseInsensitiveLookup: false,
		});
		const tuple = plugin.markdown?.remarkPlugins?.[0] as [
			unknown,
			{ options: NormalizedPluginOptions },
		];

		expect(tuple[1].options.enableCaseInsensitiveLookup).toBe(false);
	});

	test("defaults to markdown link resolution, matching Obsidian", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const plugin = markdown();
		const tuple = plugin.markdown?.remarkPlugins?.[0] as [
			unknown,
			{ options: NormalizedPluginOptions },
		];

		expect(tuple[1].options.enableMarkdownLinks).toBe(true);
	});

	test("allows opting out of markdown link resolution", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const plugin = markdown({
			enableMarkdownLinks: false,
		});
		const tuple = plugin.markdown?.remarkPlugins?.[0] as [
			unknown,
			{ options: NormalizedPluginOptions },
		];

		expect(tuple[1].options.enableMarkdownLinks).toBe(false);
	});

	/** The remark plugin tuple's second element — options plus the hooks the plugin wires. */
	function remarkPluginConfig(plugin: { markdown?: { remarkPlugins?: unknown } }): {
		options: NormalizedPluginOptions;
		getContentIndex: (filePath: string) => Promise<unknown>;
	} {
		const tuple = Array.isArray(plugin.markdown?.remarkPlugins)
			? plugin.markdown.remarkPlugins[0]
			: undefined;
		if (!Array.isArray(tuple)) throw new Error("expected a remark plugin tuple");
		const config: unknown = tuple[1];
		if (
			typeof config !== "object" ||
			config === null ||
			!("options" in config) ||
			!("getContentIndex" in config)
		) {
			throw new Error("expected remark plugin options and getContentIndex");
		}
		// The tuple is built by `markdown()`; this is the seam that reads it back.
		return config as {
			options: NormalizedPluginOptions;
			getContentIndex: (filePath: string) => Promise<unknown>;
		};
	}

	test("normalizes options and resolves the vault root", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const plugin = markdown({ vaultRoot: "test/markdown/fixtures/vault-publish" });
		const { options } = remarkPluginConfig(plugin);

		expect(options.vaultRoot).toBe(
			path.resolve(process.cwd(), "test/markdown/fixtures/vault-publish"),
		);
		expect(options.vaultRoutePrefix).toBe("/vault");
		expect(options.onBrokenLink).toBe("error");
		expect(options.onAmbiguousLink).toBe("error");
		expect(options.enableTransclusion).toBe(false);
		expect(options.dailyNotes).toEqual({
			folder: "",
			dateFormat: "YYYY-MM-DD",
			navigation: true,
			template: "",
			calendar: "",
		});
	});

	test("normalizes a vault route prefix that lacks a leading slash", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const { options } = remarkPluginConfig(markdown({ vaultRoutePrefix: "notes/" }));

		expect(options.vaultRoutePrefix).toBe("/notes");
	});

	test("drops the per-file index memo in afterBuild", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const plugin = markdown();
		const configFn = plugin.config as unknown as (config: Record<string, unknown>) => unknown;
		configFn({ root: fixtureRoot });
		const { getContentIndex } = remarkPluginConfig(plugin);
		const filePath = path.resolve(fixtureRoot, "index.md");

		const first = getContentIndex(filePath);
		expect(getContentIndex(filePath)).toBe(first);

		plugin.afterBuild?.({}, false);
		expect(getContentIndex(filePath)).not.toBe(first);
	});

	test("blanks comments in the search index without shifting offsets", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const plugin = markdown();
		const content = "Visible %%hidden%% text.";
		const page: PageIndexInfo = {
			routePath: "/index",
			title: "Index",
			toc: [
				{ id: "visible", text: "Visible", depth: 2, charIndex: 0 },
				// Inside the comment — must not survive into the index.
				{ id: "hidden", text: "hidden", depth: 2, charIndex: 10 },
				{ id: "text", text: "text.", depth: 2, charIndex: 19 },
			],
			content,
			frontmatter: {},
			lang: "en",
			version: "v1",
			_filepath: "index.md",
			_relativePath: "index.md",
		};

		await plugin.modifySearchIndexData?.([page], false);

		// Blanked, not removed: Rspress maps `toc[].charIndex` into this string.
		expect(page.content).toHaveLength(content.length);
		expect(page.content).not.toContain("hidden");
		expect(page.toc.map((entry) => entry.id)).toEqual(["visible", "text"]);
	});

	test("drops a commented heading from the outline the theme renders", async () => {
		// Rspress extracts the outline before the remark pass strips comments, so
		// the page data hook removes what the search index already cleaned.
		const { markdown } = await import("../../src/markdown/index");
		const plugin = markdown();
		const content = "Intro.\n\n## Visible\n\n%%\n## Secret\n%%\n\nTail text.\n";
		const page: PageIndexInfo = {
			routePath: "/index",
			title: "Index",
			toc: [
				{ id: "visible", text: "Visible", depth: 2, charIndex: 9 },
				{ id: "secret", text: "Secret", depth: 2, charIndex: 30 },
			],
			content,
			frontmatter: { excerpt: "An excerpt" },
			lang: "en",
			version: "v1",
			_filepath: "index.md",
			_relativePath: "index.md",
		};

		plugin.extendPageData?.(page, false);

		expect(page.toc.map((entry) => entry.id)).toEqual(["visible"]);
		// The excerpt still lands: filtering the outline must not skip the hook's
		// other work.
		expect(page.description).toBe("An excerpt");
	});

	test("falls back to the flattened source when the search index is disabled", async () => {
		// With search off, Rspress leaves `content` empty and records no toc
		// offsets, so the flattened markdown is what the filter can read.
		const { markdown } = await import("../../src/markdown/index");
		const plugin = markdown();
		const page: PageIndexInfo = {
			routePath: "/index",
			title: "Index",
			toc: [
				{ id: "visible", text: "Visible", depth: 2, charIndex: -1 },
				{ id: "secret", text: "Secret", depth: 2, charIndex: -1 },
			],
			content: "",
			frontmatter: {},
			lang: "en",
			version: "v1",
			_filepath: "index.md",
			_relativePath: "index.md",
			_flattenContent: "## Visible\n\n%%\n## Secret\n%%\n",
		};

		plugin.extendPageData?.(page, false);

		expect(page.toc.map((entry) => entry.id)).toEqual(["visible"]);
	});

	test("excerpt becomes the page description when no explicit description is set", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const plugin = markdown();
		const page: PageIndexInfo = {
			routePath: "/index",
			title: "Index",
			toc: [],
			content: "",
			description: "auto-extracted first paragraph",
			frontmatter: { excerpt: "  A brief\n  description  " },
			lang: "en",
			version: "v1",
			_filepath: "index.md",
			_relativePath: "index.md",
		};

		plugin.extendPageData?.(page, false);

		expect(page.description).toBe("A brief description");
	});

	test("an explicit description wins over excerpt, and absent excerpt is untouched", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const plugin = markdown();
		const makePage = (
			frontmatter: PageIndexInfo["frontmatter"],
			description?: string,
		): PageIndexInfo => ({
			routePath: "/index",
			title: "Index",
			toc: [],
			content: "",
			description,
			frontmatter,
			lang: "en",
			version: "v1",
			_filepath: "index.md",
			_relativePath: "index.md",
		});

		const explicit = makePage(
			{ description: "Native description", excerpt: "Obsidian excerpt" },
			"Native description",
		);
		plugin.extendPageData?.(explicit, false);
		expect(explicit.description).toBe("Native description");

		const noExcerpt = makePage({}, "auto-extracted first paragraph");
		plugin.extendPageData?.(noExcerpt, false);
		expect(noExcerpt.description).toBe("auto-extracted first paragraph");

		const emptyExcerpt = makePage({ excerpt: "   " }, "auto-extracted first paragraph");
		plugin.extendPageData?.(emptyExcerpt, false);
		expect(emptyExcerpt.description).toBe("auto-extracted first paragraph");
	});

	test("lists unlinked mentions from a vault page, and only when asked", async () => {
		const os = await import("node:os");
		const fsp = await import("node:fs/promises");
		const { markdown } = await import("../../src/markdown/index");
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rspress-mentions-"));

		const run = async (sourceBody: string, enableUnlinkedMentions: boolean) => {
			// A page's names are its frontmatter title, its aliases and its file
			// basename — a heading is not a name.
			await fsp.writeFile(
				path.join(root, "target.md"),
				"---\ntitle: Widget Notes\n---\n\n# Widget Notes\n",
			);
			await fsp.writeFile(path.join(root, "source.md"), sourceBody);

			const plugin = markdown({
				vaultRoot: root,
				vaultRoutePrefix: "/vault",
				enableUnlinkedMentions,
			});
			const tuple = (plugin.markdown?.remarkPlugins as unknown[] | undefined)?.[0] as
				| [unknown, unknown]
				| undefined;
			if (!Array.isArray(tuple)) throw new Error("expected a remark plugin tuple");

			const processor = makeProcessorFor(tuple);
			return String(
				await processor.process({
					value: "# Widget Notes\n",
					path: path.join(root, "target.md"),
				}),
			);
		};

		try {
			const withMentions = await run("I read Widget Notes yesterday without linking it.\n", true);
			expect(withMentions).toContain("Unlinked mentions");
			expect(withMentions).toContain("/vault/source");
			expect(withMentions).toContain("I read Widget Notes yesterday without linking it.");

			// A page that links is a backlink, not a mention: the two lists must not
			// overlap. The link pass rewrites the wikilink, so the mention matcher must
			// not see its text either.
			const linked = await run("I read [[target|Widget Notes]] yesterday.\n", true);
			expect(linked).not.toContain("Unlinked mentions");

			// Off by default, and then nothing is retained or rendered.
			const off = await run("I read Widget Notes yesterday without linking it.\n", false);
			expect(off).not.toContain("Unlinked mentions");
		} finally {
			await fsp.rm(root, { recursive: true, force: true });
		}
	});

	test("asks for the backlinks panel when mentions are enabled", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const { options } = remarkPluginConfig(markdown({ enableUnlinkedMentions: true }));

		// Mentions render inside that panel, so enabling them must enable it.
		expect(options.enableBacklinks).toBe(true);
		expect(options.enableUnlinkedMentions).toBe(true);
		expect(remarkPluginConfig(markdown()).options.enableUnlinkedMentions).toBe(false);
	});

	test("addPages generates tag pages for the docs root", async () => {
		const os = await import("node:os");
		const fsp = await import("node:fs/promises");
		const { markdown } = await import("../../src/markdown/index");
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rspress-tags-"));
		try {
			await fsp.writeFile(path.join(root, "a.md"), "# A\n\n#alpha\n");
			const plugin = markdown({ enableTagPages: true });

			const pages = await plugin.addPages?.({ root }, false);

			expect(pages?.map((page) => page.routePath)).toContain("/tags/alpha");
		} finally {
			await fsp.rm(root, { recursive: true, force: true });
		}
	});
});

describe("external vault publishing", () => {
	// A throwaway docs root: `addPages` copies vault assets into `<root>/public`,
	// and using the real `docs/` here would rewrite `docs/public/**` on every
	// test run — bumping mtimes so playwright's staleness guard (doc_build vs
	// sources) refuses to run after the suite.
	async function makeTmpDocsRoot(): Promise<{ root: string; cleanup: () => Promise<void> }> {
		const os = await import("node:os");
		const fsp = await import("node:fs/promises");
		const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rspress-docs-"));
		return {
			root,
			cleanup: async () => {
				await fsp.rm(root, { recursive: true, force: true });
			},
		};
	}

	test("publishes vault pages under the configured route prefix", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const { root, cleanup } = await makeTmpDocsRoot();
		try {
			const plugin = markdown({
				vaultRoot: path.resolve(process.cwd(), "test/markdown/fixtures/vault-publish"),
				vaultRoutePrefix: "/vault",
			});
			const pages = await plugin.addPages?.({ root }, false);
			expect(pages?.map((page) => page.routePath)).toContain("/vault/Home");
			expect(pages?.map((page) => page.routePath)).toContain("/vault/guide/Setup Guide");
		} finally {
			await cleanup();
		}
	});
	test("routes match the resolver index and exclude drafts", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const vaultRoot = path.resolve(process.cwd(), "test/markdown/fixtures/vault-publish");
		const { root, cleanup } = await makeTmpDocsRoot();
		try {
			const plugin = markdown({ vaultRoot, vaultRoutePrefix: "/vault" });
			const pages = await plugin.addPages?.({ root }, false);
			const index = await buildContentIndex(vaultRoot, { routePrefix: "/vault" });

			expect(pages?.map((page) => page.routePath).sort()).toEqual(
				index.pages.map((page) => page.routePath).sort(),
			);
			// pic.png is an indexed asset; drafts (publish: false) never appear.
			expect(index.assets.map((asset) => asset.relativePath)).toContain("pic.png");
			expect(index.assets[0]?.urlPath.startsWith("/vault/")).toBe(true);
		} finally {
			await cleanup();
		}
	});

	test("copies vault assets into the docs public dir", async () => {
		const os = await import("node:os");
		const fsp = await import("node:fs/promises");
		const { markdown } = await import("../../src/markdown/index");
		const docsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "rspress-docs-"));
		try {
			const plugin = markdown({
				vaultRoot: path.resolve(process.cwd(), "test/markdown/fixtures/vault-publish"),
				vaultRoutePrefix: "/vault",
			});
			await plugin.addPages?.({ root: docsRoot }, false);
			const copied = await fsp.readFile(path.join(docsRoot, "public", "vault", "pic.png"), "utf8");
			expect(copied.length).toBeGreaterThan(0);
		} finally {
			await fsp.rm(docsRoot, { recursive: true, force: true });
		}
	});
});

describe("duplicate footnote labels", () => {
	test("records a warning when the same footnote label is defined twice", async () => {
		const processor = makeProcessor(fixtureRoot);
		const file = await processor.process({
			value: "Text[^1]\n\n[^1]: First definition text.\n[^1]: Second definition text.",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(file.messages.length).toBeGreaterThan(0);
		expect(
			file.messages.some((message) => String(message).includes("Duplicate footnote label")),
		).toBe(true);
	});
});

describe("edge cases", () => {
	test("processes a file with only frontmatter without error", async () => {
		const processor = makeProcessor(fixtureRoot);

		await expect(
			processor.process({
				value: "---\ntitle: Empty\n---",
				path: path.resolve(fixtureRoot, "index.md"),
			}),
		).resolves.toBeDefined();
	});

	test("converts highlights at the start and end of a line", async () => {
		const processor = makeProcessor(fixtureRoot);
		const file = await processor.process({
			value: "==start== middle ==end==",
			path: path.resolve(fixtureRoot, "index.md"),
		});
		const output = String(file);

		expect(output).toContain("<mark>start</mark>");
		expect(output).toContain("<mark>end</mark>");
		expect(output.match(/<mark>/g)?.length).toBe(2);
	});

	test("resolves uppercase basename wikilinks in strict fixtures", async () => {
		const processor = makeProcessor(strictFixtureRoot);
		const file = await processor.process({
			value: "[[CaseSensitive]]",
			path: path.resolve(strictFixtureRoot, "index.md"),
		});

		expect(String(file)).toContain("/guide/CaseSensitive");
		expect(String(file)).toContain("[CaseSensitive]");
	});
});

describe("bundled stylesheet", () => {
	test("ships non-empty source stylesheet with expected classes", async () => {
		const fs = await import("node:fs/promises");
		const sourceStyles = await fs.readFile(
			path.resolve(process.cwd(), "src/markdown/styles.css"),
			"utf8",
		);

		expect(sourceStyles.length).toBeGreaterThan(0);
		expect(sourceStyles).toContain(".callout");
		expect(sourceStyles).toContain(".obsidian-backlinks");
		// Rule-level assertions, not byte-pins: a reformat must not fail the test.
		const backlinksItemRule = /\.obsidian-backlinks li\s*\{[^}]*margin:\s*0;/;
		const backlinksSpacingRule =
			/\.obsidian-backlinks li:not\(:first-child\)\s*\{[^}]*margin-top:\s*0;/;
		expect(sourceStyles).toMatch(backlinksItemRule);
		expect(sourceStyles).toMatch(backlinksSpacingRule);
		expect(sourceStyles).toContain(".obsidian-transclusion");
		expect(sourceStyles).toContain(".obsidian-embed");
		expect(sourceStyles).toContain("html.dark");
		expect(sourceStyles).toContain("callout-note");
		expect(sourceStyles).toContain("callout-tip");
		expect(sourceStyles).toContain("callout-warning");
		expect(sourceStyles).toContain("callout-danger");
		expect(sourceStyles).toContain("callout-quote");
	});

	test("styles todo callouts and custom-type fallbacks", async () => {
		const fs = await import("node:fs/promises");
		const sourceStyles = await fs.readFile(
			path.resolve(process.cwd(), "src/markdown/styles.css"),
			"utf8",
		);

		// `todo` gets Obsidian's blue card and its own title glyph.
		expect(sourceStyles).toMatch(/\.callout-todo\s*\{[^}]*--callout-color:\s*#086ddd/);
		expect(sourceStyles).toMatch(
			/\.callout-todo \.callout-title::before[^{]*\{[^}]*content:\s*"☑"/,
		);
		// Custom (unrecognised) types fall back to the note glyph and blue card.
		expect(sourceStyles).toMatch(/\.callout \.callout-title::before[^{]*\{[^}]*content:\s*"✎"/);
		expect(sourceStyles).toMatch(/\.callout,\s*\.rp-callout\s*\{[^}]*--callout-color:\s*#448aff/);
		// The generic fallback rule must precede the per-type rules: they tie on
		// specificity, so document order decides which glyph wins.
		expect(sourceStyles.indexOf(".callout .callout-title::before")).toBeLessThan(
			sourceStyles.indexOf(".callout-note .callout-title::before"),
		);
	});

	const distPath = path.resolve(process.cwd(), "dist/markdown.css");
	// A missing dist/ is a legitimate state (`bun test` runs before
	// `bun run build` in CI), so skip loudly instead of passing silently.
	test.skipIf(!fs.existsSync(distPath))("ships minified dist stylesheet when built", async () => {
		const distStyles = fs.readFileSync(distPath, "utf8");

		expect(distStyles.length).toBeGreaterThan(0);
		expect(distStyles).toContain(".obsidian-backlinks li{margin:0}");
		expect(distStyles).toContain(".obsidian-backlinks li:not(:first-child){margin-top:0}");
		expect(distStyles).toContain(".callout");
		expect(distStyles).toContain("html.dark");
	});
});

describe("publish frontmatter", () => {
	test("excludes pages with publish: false from index", async () => {
		const index = await buildContentIndex(publishFixtureRoot);
		expect(index.pages.length).toBe(1);
		expect(index.byPathKey.has("published")).toBe(true);
		expect(index.byPathKey.has("draft")).toBe(false);
	});

	test("includes pages without publish field (defaults to true)", async () => {
		const index = await buildContentIndex(fixtureRoot);
		expect(index.pages.length).toBeGreaterThan(0);
	});
});

describe("complex yaml frontmatter", () => {
	test("parses multi-line arrays and inline arrays correctly", async () => {
		const index = await buildContentIndex(complexYamlFixtureRoot);
		const page = index.byPathKey.get("complex");

		expect(page?.title).toBe("Complex YAML Test");
		expect(page?.aliases).toEqual(["Complex Alias One", "Complex Alias Two"]);
		expect(page?.tags).toEqual(["obsidian", "tutorial", "advanced"]);
		expect(page?.cssclasses).toEqual(["custom-layout", "dark-theme"]);
		expect(page?.publish).toBe(true);
	});

	test("parses inline yaml arrays", async () => {
		const index = await buildContentIndex(complexYamlFixtureRoot);
		const page = index.byPathKey.get("inline");

		expect(page?.title).toBe("Inline YAML Test");
		expect(page?.aliases).toEqual(["Inline Alias", "Another Alias"]);
		expect(page?.tags).toEqual(["inline"]);
		expect(page?.cssclasses).toEqual(["class-one", "class-two"]);
		expect(page?.publish).toBe(true);
	});

	test("parses publish: yes string as true", async () => {
		const index = await buildContentIndex(complexYamlFixtureRoot);
		const page = index.byPathKey.get("inline");
		expect(page?.publish).toBe(true);
	});
});

describe("wikilink escape handling", () => {
	test("does not split on an escaped hash in the target", () => {
		const parsed = parseWikiLink("Page\\#Name", "[[Page\\#Name]]");

		expect(parsed.target).toBe("Page#Name");
		expect(parsed.subpath).toBeUndefined();
	});

	test("resolves escaped special characters in aliases", () => {
		const parsed = parseWikiLink(
			"guide/getting-started#Install|A \\| B",
			"[[guide/getting-started#Install|A \\| B]]",
		);

		expect(parsed.alias).toBe("A | B");
		expect(parsed.subpath).toEqual({ kind: "heading", value: "Install" });
	});
});

describe("heading transclusion with explicit ids and slugs", () => {
	test("transcludes a section by explicit id and emits a heading anchor", async () => {
		const processor = makeProcessor(headingFixtureRoot, {
			enableTransclusion: true,
		});
		const file = await processor.process({
			value: "![[guide/variants#custom-anchor]]",
			path: path.resolve(headingFixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain('class="obsidian-transclusion"');
		expect(output).toContain('id="custom-anchor"');
		expect(output).toContain("Custom Anchor");
		expect(output).not.toContain("{#custom-anchor}");
	});

	test("transcludes a section by slugified heading", async () => {
		const processor = makeProcessor(headingFixtureRoot, {
			enableTransclusion: true,
		});
		const file = await processor.process({
			value: "![[guide/variants#spaced-atx-heading]]",
			path: path.resolve(headingFixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain('class="obsidian-transclusion"');
		expect(output).toContain('id="spaced-atx-heading"');
		expect(output).toContain("Spaced ATX Heading");
	});
});

describe("media URL encoding", () => {
	test("percent-encodes spaces in media embed URLs", async () => {
		const processor = makeProcessor(fixtureRoot, { enableMediaEmbeds: true });
		const file = await processor.process({
			value: "![[my image.png]]",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toContain('src="/my%20image.png"');
	});
});

describe("backlink exclusions", () => {
	const backlinksCodeRoot = path.resolve(process.cwd(), "test/markdown/fixtures/backlinks-code");

	test("indexes backlinks from real wikilinks and Markdown links", async () => {
		const index = await buildContentIndex(backlinksCodeRoot);

		// Code blocks, inline code, and comments must not create backlinks;
		// both real link syntaxes should deduplicate to one source page.
		expect(index.backlinks.get("/target")).toEqual([
			{ routePath: "/codes", relativePath: "codes.md", title: "Code Mentions" },
		]);
	});

	test("renders wikilinks inside code blocks as plain text", async () => {
		const processor = makeProcessor(backlinksCodeRoot);
		const file = await processor.process({
			value: "```md\n[[target]]\n```\n\nInline `[[target]]` too.",
			path: path.resolve(backlinksCodeRoot, "codes.md"),
		});

		const output = String(file);
		expect(output).toContain("[[target]]");
		expect(output).not.toContain("](/target)");
	});
});

describe("callout title markdown", () => {
	test("renders inline markdown in callout titles", async () => {
		const processor = makeProcessor(fixtureRoot, {
			enableCallouts: true,
		});

		const file = await processor.process({
			value: "> [!success] A **bold** and *italic* title with `code`\n> Body",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain(
			'<div class="callout-title">A <strong>bold</strong> and <em>italic</em> title with <code>code</code></div>',
		);
	});

	test("resolves wikilinks inside callout titles", async () => {
		const processor = makeProcessor(fixtureRoot, {
			enableCallouts: true,
		});

		const file = await processor.process({
			value: "> [!example] See [[guide/getting-started|Getting Started]] now\n> Body",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain(
			'<div class="callout-title">See <a href="/guide/getting-started">Getting Started</a> now</div>',
		);
	});

	test("drops raw HTML in callout titles instead of rendering it", async () => {
		const processor = makeProcessor(fixtureRoot, {
			enableCallouts: true,
		});

		const file = await processor.process({
			value: "> [!bug] Title with <script>alert(1)</script>\n> Body",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).not.toContain("<script>");
		expect(output).toContain("alert(1)");
	});

	test("leaves unresolvable wikilinks in callout titles verbatim", async () => {
		const processor = makeProcessor(fixtureRoot, {
			enableCallouts: true,
		});

		const file = await processor.process({
			value: "> [!question] See [[missing-page]] here\n> Body",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toContain('<div class="callout-title">See [[missing-page]] here</div>');
	});
});

describe("image alt text", () => {
	test("uses a non-numeric pipe alias as image alt text", async () => {
		const processor = makeProcessor(fixtureRoot, {
			enableMediaEmbeds: true,
		});

		const file = await processor.process({
			value: "![[image.png|Screenshot of the UI]]",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toContain(
			'<img src="/image.png" alt="Screenshot of the UI" loading="lazy" />',
		);
	});

	test("still treats a numeric pipe as a size, not alt text", async () => {
		const processor = makeProcessor(fixtureRoot, {
			enableMediaEmbeds: true,
		});

		const file = await processor.process({
			value: "![[image.png|300]]",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toContain(
			'<img src="/image.png" alt="image.png" width="300" loading="lazy" />',
		);
	});
});

describe("wikilink and tag interaction", () => {
	test("does not rewrite current-page anchors inside wikilinks as tags", async () => {
		const processor = makeProcessor(fixtureRoot, {
			enableTagLinking: true,
		});

		const file = await processor.process({
			value: "Jump to [[#Overview]] now.",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		// The resolver appends a tooltip title (heading preview); only assert
		// the link itself here.
		expect(output).toContain("[Overview](#overview");
		expect(output).not.toContain("/tags/");
	});

	test("does not rewrite heading anchors inside wikilinks as tags", async () => {
		const processor = makeProcessor(fixtureRoot, {
			enableTagLinking: true,
		});

		const file = await processor.process({
			value: "See [[guide/getting-started#Install]] for details.",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain("[Install](/guide/getting-started#install");
		expect(output).not.toContain("/tags/");
		expect(output).not.toContain("[[");
	});

	test("does not highlight ==text== inside wikilink aliases", async () => {
		const processor = makeProcessor(fixtureRoot);

		const file = await processor.process({
			value: "See [[guide/getting-started#Install|==Important==]] here.",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain("[==Important==](");
		expect(output).not.toContain("<mark>");
	});
});

describe("markdown link resolution", () => {
	test("resolves vault-relative .md links by path", async () => {
		const processor = makeProcessor(fixtureRoot);

		const file = await processor.process({
			value: "See [the guide](guide/getting-started.md) for details.",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toBe("See [the guide](/guide/getting-started) for details.\n");
	});

	test("resolves .md links by basename across folders", async () => {
		const processor = makeProcessor(fixtureRoot);

		const file = await processor.process({
			value: "See [the guide](getting-started.md).",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toBe("See [the guide](/guide/getting-started).\n");
	});

	test("resolves heading anchors in .md links", async () => {
		const processor = makeProcessor(fixtureRoot);

		const file = await processor.process({
			value: "See [install steps](guide/getting-started.md#Install).",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain("[install steps](/guide/getting-started#install");
		expect(output).not.toContain(".md");
	});

	test("resolves root-absolute .md links", async () => {
		const processor = makeProcessor(fixtureRoot);

		const file = await processor.process({
			value: "See [the guide](/guide/getting-started.md).",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toBe("See [the guide](/guide/getting-started).\n");
	});

	test("resolves .md links case-insensitively when enabled", async () => {
		const processor = makeProcessor(fixtureRoot, {
			enableCaseInsensitiveLookup: true,
		});

		const file = await processor.process({
			value: "See [the guide](GUIDE/Getting-Started.md).",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toBe("See [the guide](/guide/getting-started).\n");
	});

	test("leaves external, hash-only, and extensionless links untouched", async () => {
		const processor = makeProcessor(fixtureRoot);

		const file = await processor.process({
			value:
				"[docs](https://example.com/a.md), [section](#anchor), [route](/guide/getting-started), [mail](mailto:x@y.md).",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain("(https://example.com/a.md)");
		expect(output).toContain("(#anchor)");
		expect(output).toContain("(/guide/getting-started)");
		expect(output).toContain("(mailto:x@y.md)");
	});

	test("leaves unresolvable .md links untouched in warn mode", async () => {
		const processor = makeProcessor(fixtureRoot, { onBrokenLink: "warn" });

		const file = await processor.process({
			value: "See [missing](no-such-page.md).",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toBe("See [missing](no-such-page.md).\n");
		expect(file.messages.some((m) => String(m).includes("no-such-page.md"))).toBe(true);
	});

	test("fails the build for unresolvable .md links in error mode", async () => {
		const processor = makeProcessor(fixtureRoot);

		await expect(
			processor.process({
				value: "See [missing](no-such-page.md).",
				path: path.resolve(fixtureRoot, "index.md"),
			}),
		).rejects.toThrow();
	});

	test("resolves relative .md links from the current folder", async () => {
		const processor = makeProcessor(fixtureRoot);

		const file = await processor.process({
			value: "See [advanced](./advanced.md).",
			path: path.resolve(fixtureRoot, "guide/getting-started.md"),
		});

		expect(String(file)).toBe("See [advanced](/guide/advanced).\n");
	});

	test("resolves a reference definition's .md destination", async () => {
		const processor = makeProcessor(fixtureRoot);

		const file = await processor.process({
			value: "See [the guide][g] for details.\n\n[g]: guide/getting-started.md\n",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		// `[label][ref]` renders through the definition, so resolving the definition
		// is what stops the page from shipping a dead `.md` href.
		expect(output).toContain("[g]: /guide/getting-started");
		expect(output).not.toContain(".md");
	});

	test("resolves a reference definition by basename and keeps its anchor", async () => {
		const processor = makeProcessor(fixtureRoot);

		const file = await processor.process({
			value: "See [install][g].\n\n[g]: getting-started.md#Install\n",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain("[g]: /guide/getting-started#install");
		expect(output).not.toContain(".md");
	});

	test("reports an unresolvable reference definition through onBrokenLink", async () => {
		const processor = makeProcessor(fixtureRoot, { onBrokenLink: "warn" });

		const file = await processor.process({
			value: "See [gone][g].\n\n[g]: no-such-page.md\n",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		// Unresolved, so the raw destination stays — but it is reported rather than
		// sailing through Rspress's gate, which this plugin has told to stand down.
		expect(String(file)).toContain("[g]: no-such-page.md");
		expect(file.messages.some((m) => String(m).includes("no-such-page.md"))).toBe(true);
	});

	test("fails the build for an unresolvable reference definition in error mode", async () => {
		const processor = makeProcessor(fixtureRoot);

		await expect(
			processor.process({
				value: "See [gone][g].\n\n[g]: no-such-page.md\n",
				path: path.resolve(fixtureRoot, "index.md"),
			}),
		).rejects.toThrow();
	});

	test("can be disabled", async () => {
		const processor = makeProcessor(fixtureRoot, {
			enableMarkdownLinks: false,
		});

		const file = await processor.process({
			value: "See [the guide](guide/getting-started.md).",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toBe("See [the guide](guide/getting-started.md).\n");
	});
});

describe("obsidian:// links", () => {
	test("resolves obsidian://open with vault and file", async () => {
		const processor = makeProcessor(fixtureRoot);

		const file = await processor.process({
			value: "See [guide](obsidian://open?vault=basic&file=guide/getting-started).",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toBe("See [guide](/guide/getting-started).\n");
	});

	test("resolves obsidian://open with only file through the basename lookup", async () => {
		const processor = makeProcessor(fixtureRoot);

		const file = await processor.process({
			value: "See [guide](obsidian://open?file=getting-started).",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toBe("See [guide](/guide/getting-started).\n");
	});

	test("resolves a file with a heading fragment", async () => {
		const processor = makeProcessor(fixtureRoot);

		const file = await processor.process({
			value: "See [install](obsidian://open?vault=basic&file=guide/getting-started#Install).",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain("[install](/guide/getting-started#install");
		expect(output).not.toContain("obsidian://");
	});

	test("resolves a URL-encoded file parameter", async () => {
		const processor = makeProcessor(fixtureRoot);

		const file = await processor.process({
			value: "See [guide](obsidian://open?vault=basic&file=guide%2Fgetting-started).",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toBe("See [guide](/guide/getting-started).\n");
	});

	test("leaves an unresolvable obsidian:// link untouched in warn mode", async () => {
		const processor = makeProcessor(fixtureRoot, { onBrokenLink: "warn" });

		const file = await processor.process({
			value: "See [gone](obsidian://open?file=no-such-page).",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toBe("See [gone](obsidian://open?file=no-such-page).\n");
		expect(file.messages.some((m) => String(m).includes("no-such-page"))).toBe(true);
	});

	test("fails the build for an unresolvable obsidian:// link in error mode", async () => {
		const processor = makeProcessor(fixtureRoot);

		await expect(
			processor.process({
				value: "See [gone](obsidian://open?file=no-such-page).",
				path: path.resolve(fixtureRoot, "index.md"),
			}),
		).rejects.toThrow();
	});

	test("leaves an unsupported obsidian:// action untouched but reported once", async () => {
		const processor = makeProcessor(fixtureRoot, { onBrokenLink: "warn" });

		const file = await processor.process({
			value: "See [search](obsidian://search?vault=basic&query=note).",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		// A published site cannot run an Obsidian action, so the link stays as
		// written — but never silently, or the reader meets a dead link unannotated.
		// (remark-stringify escapes the `&` in the destination.)
		expect(String(file)).toBe("See [search](obsidian://search?vault=basic\\&query=note).\n");
		const reports = file.messages.filter((message) =>
			String(message).includes("obsidian://search"),
		);
		expect(reports).toHaveLength(1);
		expect(String(reports[0])).toContain("cannot be served by a published site");
	});

	test("reports an obsidian:// URI that names no note", async () => {
		const processor = makeProcessor(fixtureRoot, { onBrokenLink: "warn" });

		const file = await processor.process({
			value: "See [vault](obsidian://open?vault=basic).",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toBe("See [vault](obsidian://open?vault=basic).\n");
		expect(file.messages.some((message) => String(message).includes("does not name a note"))).toBe(
			true,
		);
	});

	test("resolves an obsidian:// destination in a reference definition", async () => {
		const processor = makeProcessor(fixtureRoot);

		const file = await processor.process({
			value: "See [guide][g].\n\n[g]: obsidian://open?vault=basic&file=getting-started\n",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain("[g]: /guide/getting-started");
		expect(output).not.toContain("obsidian://");
	});

	test("is left alone when markdown link resolution is disabled", async () => {
		const processor = makeProcessor(fixtureRoot, { enableMarkdownLinks: false });

		const file = await processor.process({
			value: "See [guide](obsidian://open?vault=basic&file=get-started).",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		expect(String(file)).toBe("See [guide](obsidian://open?vault=basic\\&file=get-started).\n");
	});
});

describe("markdown embeds", () => {
	test("transcludes ![alt](Page.md) embeds", async () => {
		const processor = makeProcessor(fixtureRoot, {
			enableTransclusion: true,
		});

		const file = await processor.process({
			value: "![intro](guide/getting-started.md)",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain('class="obsidian-transclusion"');
		expect(output).toContain("Getting Started");
	});

	test("transcludes a section from ![alt](Page.md#Heading) embeds", async () => {
		const processor = makeProcessor(fixtureRoot, {
			enableTransclusion: true,
		});

		const file = await processor.process({
			value: "![install](guide/getting-started.md#Install)",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain('class="obsidian-transclusion"');
		expect(output).toContain("Install");
	});

	test("renders an embed link when transclusion is disabled", async () => {
		const processor = makeProcessor(fixtureRoot);

		const file = await processor.process({
			value: "![intro](guide/getting-started.md)",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain('class="obsidian-embed"');
		expect(output).toContain('href="/guide/getting-started"');
		expect(output).toContain("intro");
	});
});

describe("missing section embeds", () => {
	test("reports broken anchors on embeds through onBrokenLink", async () => {
		const processor = makeProcessor(fixtureRoot, {
			enableTransclusion: true,
			onBrokenLink: "warn",
		});

		const file = await processor.process({
			value: "![[guide/getting-started#Missing]]",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		// The raw embed is left in place (remark-stringify escapes the
		// brackets) rather than falling back to the full page content.
		expect(output).toContain("guide/getting-started#Missing");
		expect(output).not.toContain('class="obsidian-transclusion"');
		expect(output).not.toContain("Install steps");
		expect(file.messages.some((m) => String(m).includes("broken-anchor"))).toBe(true);
	});
});

describe("callout title highlights", () => {
	test("renders ==highlights== inside callout titles", async () => {
		const processor = makeProcessor(fixtureRoot, {
			enableCallouts: true,
		});

		const file = await processor.process({
			value: "> [!warning] A ==critical== warning\n> Body",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain('<div class="callout-title">A <mark>critical</mark> warning</div>');
	});

	test("renders highlights combined with markdown and wikilinks", async () => {
		const processor = makeProcessor(fixtureRoot, {
			enableCallouts: true,
		});

		const file = await processor.process({
			value: "> [!example] **See** [[guide/getting-started|the guide]] ==now==\n> Body",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain("<strong>See</strong>");
		expect(output).toContain('<a href="/guide/getting-started">the guide</a>');
		expect(output).toContain("<mark>now</mark>");
	});

	test("renders a highlight containing an equals sign in a title", async () => {
		const processor = makeProcessor(fixtureRoot, {
			enableCallouts: true,
		});

		const file = await processor.process({
			value: "> [!info] pass ==key=value== along\n> Body",
			path: path.resolve(fixtureRoot, "index.md"),
		});

		const output = String(file);
		expect(output).toContain('<div class="callout-title">pass <mark>key=value</mark> along</div>');
	});
});

describe("markdown link config hook", () => {
	type ConfigFn = (config: Record<string, unknown>) => {
		markdown?: { link?: { checkDeadLinks?: unknown } };
	};

	test("excludes plugin-owned markdown destinations from the dead-link gate", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const configFn = markdown().config as unknown as ConfigFn;

		const checkDeadLinks = configFn({ root: "docs" }).markdown?.link?.checkDeadLinks;
		expect(typeof checkDeadLinks).toBe("object");
		if (
			typeof checkDeadLinks !== "object" ||
			checkDeadLinks === null ||
			!("excludes" in checkDeadLinks)
		) {
			throw new Error("expected checkDeadLinks to be an excludes object");
		}

		const excludes = checkDeadLinks.excludes;
		expect(typeof excludes).toBe("function");
		if (typeof excludes !== "function") {
			throw new Error("expected excludes to be a predicate");
		}
		// Rspress types `excludes` as a union; the runtime check above pinned it
		// to the function branch.
		const isExcluded = excludes as (url: string) => boolean;

		// Destinations this plugin resolves itself (and reports through
		// `onBrokenLink`) are the only ones Rspress must not judge.
		expect(isExcluded("Page.md")).toBe(true);
		expect(isExcluded("./relative.mdx#Heading")).toBe(true);
		expect(isExcluded("My%20Page.md")).toBe(true);
		// Everything else stays checked.
		expect(isExcluded("/guide/getting-started")).toBe(false);
		expect(isExcluded("#anchor")).toBe(false);
		expect(isExcluded("https://example.com/page")).toBe(false);
	});

	test("does not override an explicit checkDeadLinks setting", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const configFn = markdown().config as unknown as ConfigFn;

		const config = configFn({
			root: "docs",
			markdown: { link: { checkDeadLinks: true } },
		});

		expect(config.markdown?.link?.checkDeadLinks).toBe(true);
	});

	test("leaves the dead-link gate alone when markdown links are disabled", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const configFn = markdown({ enableMarkdownLinks: false }).config as unknown as ConfigFn;

		expect(configFn({ root: "docs" }).markdown).toBeUndefined();
	});
});

describe("backlink labels", () => {
	const backlinkLabelsRoot = path.resolve(process.cwd(), "test/markdown/fixtures/backlink-labels");

	test("prefers frontmatter title, then first heading, then humanized basename", async () => {
		const index = await buildContentIndex(backlinkLabelsRoot);

		expect(index.backlinks.get("/target")).toEqual([
			{ routePath: "/linker-heading", relativePath: "linker-heading.md", title: "My Heading" },
			{ routePath: "/linker-plain", relativePath: "linker-plain.md", title: "linker plain" },
			{ routePath: "/linker-title", relativePath: "linker-title.md", title: "Custom Title" },
		]);
	});
});

describe("rspress callout restoration", () => {
	// Faithful replica of the GitHub-style alert branch of Rspress's internal
	// remarkContainerSyntax: rewrites `> [!type]` blockquotes into
	// $$$callout$$$ containerDirective nodes, leaking the fold suffix into
	// content and dropping the first paragraph of multi-paragraph alerts.
	interface TestNode {
		type?: string;
		name?: string;
		attributes?: Record<string, string | undefined>;
		value?: string;
		children?: TestNode[];
	}

	const RSPRESS_TYPES = new Set(["tip", "note", "warning", "caution", "danger", "info", "details"]);
	const REGEX_GH_BEGIN = /^\s*\s*\[!(\w+)\]\s*(.*)/;

	function hijackAlertsLikeRspress(parent: { children: TestNode[] }): void {
		for (let i = 0; i < parent.children.length; i++) {
			const node = parent.children[i];
			if (node?.children) hijackAlertsLikeRspress({ children: node.children });
			const firstChild = node?.children?.[0];
			const firstText = firstChild?.children?.[0];
			if (
				node?.type === "blockquote" &&
				firstChild?.type === "paragraph" &&
				firstText &&
				"value" in firstText
			) {
				const match = String(firstText.value).match(REGEX_GH_BEGIN);
				if (!match) continue;
				const type = String(match[1]).toLowerCase();
				if (!RSPRESS_TYPES.has(type)) continue;
				const kids = node.children ?? [];
				if (kids.length === 1) {
					firstText.value = match[2] ?? "";
				}
				const container: TestNode = {
					type: "containerDirective",
					name: "$$$callout$$$",
					attributes: { type, title: type.toUpperCase() },
					children: kids.length === 1 ? kids.slice(0) : kids.slice(1),
				};
				parent.children.splice(i, 1, container);
			}
		}
	}

	type WikilinkTransformer = (tree: unknown, file: unknown) => Promise<void>;

	function makeTransformer(options: Partial<NormalizedPluginOptions>): WikilinkTransformer {
		const factory = remarkWikilink as unknown as (pluginOptions: unknown) => WikilinkTransformer;
		return factory({
			getDocsRoot: () => fixtureRoot,
			options: { ...DEFAULT_OPTIONS, ...options },
		});
	}

	function toTestTree(tree: unknown): { children: TestNode[] } {
		return tree as { children: TestNode[] };
	}

	async function processHijacked(
		source: string,
		options: Partial<NormalizedPluginOptions> = {},
	): Promise<string> {
		const tree = unified().use(remarkParse).use(remarkGfm).parse(source);
		hijackAlertsLikeRspress(toTestTree(tree));
		const { VFile } = await import("vfile");
		const file = new VFile({
			value: source,
			path: path.resolve(fixtureRoot, "index.md"),
		});
		await makeTransformer({ enableCallouts: true, ...options })(tree, file);
		return unified().use(remarkStringify).stringify(tree);
	}

	test("restores foldable hijacked callouts with title and fold state", async () => {
		const output = await processHijacked(
			"> [!note]- Collapsed by Default\n> Hidden until expanded.\n",
		);

		expect(output).toContain("<details");
		expect(output).toContain('<summary class="callout-title">');
		expect(output).toContain("Collapsed by Default</summary>");
		expect(output).toContain("Hidden until expanded.");
		expect(output).not.toContain("- Collapsed");
		expect(output).not.toContain("$$$callout$$$");
	});

	test("restores the first paragraph that Rspress drops", async () => {
		const output = await processHijacked(
			"> [!warning] Watch Out\n> This paragraph is dropped by Rspress's transform.\n>\n> Second paragraph.\n",
		);

		expect(output).toContain('class="callout callout-warning"');
		expect(output).toContain('<div class="callout-title">Watch Out</div>');
		expect(output).toContain("This paragraph is dropped by Rspress's transform.");
		expect(output).toContain("Second paragraph.");
	});

	test("restores nested hijacked callouts", async () => {
		const output = await processHijacked(
			"> [!note] Outer\n> Outer intro.\n>\n> > [!tip] Inner\n> > Inner content.\n>\n> Outer outro.\n",
		);

		expect(output).toContain('class="callout callout-note"');
		expect(output).toContain('class="callout callout-tip"');
		expect(output).toContain("Outer intro.");
		expect(output).toContain("Inner content.");
		expect(output).toContain("Outer outro.");
	});

	test("leaves ::: directive containers untouched", async () => {
		const source = ":::note Native Directive\nNative content\n:::\n";
		const tree = unified().use(remarkParse).use(remarkGfm).parse(source);
		// Simulate a ::: directive container the way Rspress converts it:
		// children keep positions pointing at non-blockquote source lines.
		const root = toTestTree(tree);
		const paragraph = root.children.find((n) => n.type === "paragraph");
		const container: TestNode = {
			type: "containerDirective",
			name: "$$$callout$$$",
			attributes: { type: "note", title: "Note" },
			children: [paragraph ?? { type: "paragraph" }],
		};
		root.children = [container];

		const { VFile } = await import("vfile");
		const file = new VFile({
			value: source,
			path: path.resolve(fixtureRoot, "index.md"),
		});
		await makeTransformer({ enableCallouts: true })(tree, file);

		// remarkStringify cannot serialize containerDirective nodes, so assert
		// on the tree: the directive must survive untouched.
		const json = JSON.stringify(tree);
		expect(json).toContain('"containerDirective"');
		expect(json).toContain("$$$callout$$$");
		expect(json).toContain("Native content");
		expect(json).not.toContain('"html"');
	});

	test("does not restore when callouts are disabled", async () => {
		const source = "> [!note] Plain\n> Body\n";
		const tree = unified().use(remarkParse).use(remarkGfm).parse(source);
		hijackAlertsLikeRspress(toTestTree(tree));
		const { VFile } = await import("vfile");
		const file = new VFile({
			value: source,
			path: path.resolve(fixtureRoot, "index.md"),
		});
		await makeTransformer({})(tree, file);

		const json = JSON.stringify(tree);
		expect(json).toContain('"containerDirective"');
		expect(json).toContain("$$$callout$$$");
		expect(json).not.toContain('"html"');
	});
});

describe("math rendering", () => {
	const fixtureRoot = path.resolve(process.cwd(), "test/markdown/fixtures/basic");

	async function render(value: string, enableMath = true): Promise<string> {
		const processor = makeProcessor(fixtureRoot, { enableMath });
		const file = await processor.process({
			value,
			path: path.resolve(fixtureRoot, "index.md"),
		});
		return String(file);
	}

	async function renderWithMathJax(value: string): Promise<string> {
		const processor = makeProcessor(fixtureRoot, { enableMath: true, mathEngine: "mathjax" });
		const file = await processor.process({
			value,
			path: path.resolve(fixtureRoot, "index.md"),
		});
		return String(file);
	}

	test("renders inline math with KaTeX", async () => {
		const html = await render("Energy is $E = mc^2$ exactly.");

		expect(html).toContain('class="obsidian-math"');
		expect(html).toContain("katex");
		expect(html).not.toContain("$E = mc^2$");
	});

	test("renders display math as a block wrapper", async () => {
		const html = await render("$$\n\\int_0^1 x^2 \\, dx\n$$");

		expect(html).toContain('class="obsidian-math-display"');
		expect(html).toContain("katex-display");
	});

	test("renders math with MathJax when the engine asks for it", async () => {
		const html = await renderWithMathJax("Energy is $E = mc^2$ exactly.");

		expect(html).toContain('class="obsidian-math"');
		expect(html).toContain("mjx-container");
		expect(html).not.toContain("katex");
		// MathJax styles the page with a stylesheet it generates at render time.
		expect(html).toContain("<style>");
	});

	test("MathJax understands the TeX Obsidian's engine does", async () => {
		// `\\ce` is mhchem: the reason to pick MathJax over KaTeX in the first place.
		const html = await renderWithMathJax("Water is $\\ce{H2O}$.");

		expect(html).toContain("mjx-container");
		expect(html).not.toContain("katex");
	});

	test("leaves prices alone", async () => {
		const html = await render("It costs $5 and $10 in total.");

		expect(html).toContain("$5 and $10");
		expect(html).not.toContain("katex");
	});

	test("ignores math inside fenced code and inline code", async () => {
		const fenced = await render("```\n$E = mc^2$\n```");
		const inline = await render("Use `$E = mc^2$` here.");

		expect(fenced).not.toContain("katex");
		expect(fenced).toContain("$E = mc^2$");
		expect(inline).not.toContain("katex");
		expect(inline).toContain("$E = mc^2$");
	});

	test("reports malformed TeX through KaTeX rather than failing", async () => {
		const html = await render("Broken $\\frac{}{$ math.");

		expect(html).toContain("katex-error");
	});

	test("leaves math literal when the option is off", async () => {
		const html = await render("Energy is $E = mc^2$ exactly.", false);

		expect(html).not.toContain("katex");
		expect(html).toContain("$E = mc^2$");
	});
});

describe("mermaid rendering", () => {
	const fixtureRoot = path.resolve(process.cwd(), "test/markdown/fixtures/basic");
	const diagram = "graph TD\n  A[Start] --> B[End]";

	async function render(value: string, enableMermaid = true): Promise<string> {
		const processor = makeProcessor(fixtureRoot, { enableMermaid });
		const file = await processor.process({
			value,
			path: path.resolve(fixtureRoot, "index.md"),
		});
		return String(file);
	}

	async function renderWith(
		value: string,
		overrides: Partial<NormalizedPluginOptions>,
	): Promise<string> {
		const processor = makeProcessor(fixtureRoot, { enableMermaid: true, ...overrides });
		const file = await processor.process({
			value,
			path: path.resolve(fixtureRoot, "index.md"),
		});
		return String(file);
	}

	test("emits a client-rendered placeholder for mermaid fences", async () => {
		const html = await render(`\`\`\`mermaid\n${diagram}\n\`\`\``);

		expect(html).toContain('class="obsidian-mermaid-block"');
		expect(html).toContain("data-code=");
		expect(html).toContain("A[Start] --&gt; B[End]");
		expect(html).not.toContain("language-mermaid");
	});

	test("stamps the default strict security level on the placeholder", async () => {
		const html = await render(`\`\`\`mermaid\n${diagram}\n\`\`\``);

		expect(html).toContain('data-security="strict"');
	});

	test("stamps a configured security level on the placeholder", async () => {
		const html = await renderWith(`\`\`\`mermaid\n${diagram}\n\`\`\``, {
			mermaidSecurityLevel: "loose",
		});

		expect(html).toContain('data-security="loose"');
	});

	test("escapes quotes so the source cannot break the attribute", async () => {
		const html = await render('```mermaid\ngraph TD\n  A["quoted label"]\n```');

		expect(html).toContain("&quot;quoted label&quot;");
		expect(html).not.toContain('data-code="graph TD\n  A["');
	});

	test("leaves other code fences untouched", async () => {
		const html = await render("```js\nconst a = 1;\n```");

		expect(html).not.toContain("obsidian-mermaid-block");
		expect(html).toContain("const a = 1;");
	});

	test("leaves mermaid fences literal when the option is off", async () => {
		const html = await render(`\`\`\`mermaid\n${diagram}\n\`\`\``, false);

		expect(html).not.toContain("obsidian-mermaid-block");
		expect(html).toContain("A[Start] --> B[End]");
	});
});

describe("unsupported fenced blocks", () => {
	const fenceRoot = path.resolve(process.cwd(), "test/markdown/fixtures/basic");

	async function render(
		value: string,
		overrides: Partial<NormalizedPluginOptions> = {},
	): Promise<{ output: string; unsupported: string[] }> {
		const file = await makeProcessor(fenceRoot, overrides).process({
			value,
			path: path.resolve(fenceRoot, "index.md"),
		});
		return {
			output: String(file),
			unsupported: file.messages
				.map(String)
				.filter((message) => message.includes("unsupported-block")),
		};
	}

	test("reports a tasks fence and still renders it as code", async () => {
		const { output, unsupported } = await render("```tasks\nnot done\n```");

		// The block stays visible — it is the missing signal that caused the
		// reader to mistake raw plugin syntax for a rendered query.
		expect(output).toContain("```tasks");
		expect(unsupported).toHaveLength(1);
		expect(unsupported[0]).toContain("[!tasks]");
		expect(unsupported[0]).toContain("not executed by this plugin");
	});

	test("stays silent for an ordinary language fence", async () => {
		const { output, unsupported } = await render("```js\nconst a = 1;\n```");

		expect(output).toContain("const a = 1;");
		expect(unsupported).toHaveLength(0);
	});

	test("stays silent for a dataviewjs fence while Dataview is enabled", async () => {
		const { unsupported } = await render(
			["```dataviewjs", 'dv.paragraph("hello");', "```"].join("\n"),
			{ enableDataview: true },
		);

		expect(unsupported).toHaveLength(0);
	});

	test("reports a dataviewjs fence while Dataview is disabled", async () => {
		const { unsupported } = await render(
			["```dataviewjs", 'dv.paragraph("hello");', "```"].join("\n"),
		);

		expect(unsupported).toHaveLength(1);
		expect(unsupported[0]).toContain("[!dataviewjs]");
	});

	test("fails the build for an unsupported fence in error mode", async () => {
		await expect(
			makeProcessor(fenceRoot, { onUnsupportedBlock: "error" }).process({
				value: "```base\nfilters\n```",
				path: path.resolve(fenceRoot, "index.md"),
			}),
		).rejects.toThrow("[!base]");
	});
});

describe("math and mermaid plugin wiring", () => {
	test("loads KaTeX's stylesheet when math is on", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const plugin = markdown({ enableMath: true });

		expect(plugin.globalStyles).toBeDefined();
		expect(String(plugin.globalStyles)).toMatch(/katex\.css$/);
	});

	test("prefers the combined stylesheet when both are on", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const plugin = markdown({ enableMath: true, enableDefaultStyles: true });

		expect(String(plugin.globalStyles)).toMatch(/math\.css$/);
	});

	test("skips KaTeX's stylesheet when MathJax renders the math", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const plugin = markdown({ enableMath: true, mathEngine: "mathjax" });

		// MathJax emits its own generated stylesheet with the page instead.
		expect(String(plugin.globalStyles)).not.toMatch(/katex\.css$/);
	});

	test("defaults the math engine to KaTeX", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const plugin = markdown({ enableMath: true });

		expect(String(plugin.globalStyles)).toMatch(/katex\.css$/);
	});

	test("registers the mermaid component by path", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const plugin = markdown({ enableMermaid: true });
		const components = plugin.globalUIComponents ?? [];

		expect(components).toHaveLength(1);
		const [componentPath] = components[0] as [string, object];
		expect(componentPath).toMatch(/MermaidBlocks\.(tsx|js)$/);
		expect(fs.existsSync(componentPath)).toBe(true);
	});

	test("registers nothing extra by default", async () => {
		const { markdown } = await import("../../src/markdown/index");
		const plugin = markdown();

		expect("globalStyles" in plugin).toBe(false);
		expect(plugin.globalUIComponents).toBeUndefined();
	});
});

describe("comment stripping", () => {
	const fixtureRoot = path.resolve(process.cwd(), "test/markdown/fixtures/basic");

	async function render(value: string): Promise<string> {
		const processor = makeProcessor(fixtureRoot);
		const file = await processor.process({
			value,
			path: path.resolve(fixtureRoot, "index.md"),
		});
		return String(file);
	}

	test("strips a comment inside one line", async () => {
		const html = await render("Visible %%hidden%% text.");

		expect(html).not.toContain("hidden");
		expect(html).toContain("Visible  text.");
	});

	test("strips a comment that spans paragraphs", async () => {
		const html = await render(
			"Before.\n\n%%\nPrivate draft one.\n\nPrivate draft two.\n%%\n\nAfter.",
		);

		expect(html).not.toContain("Private draft");
		expect(html).toContain("Before.");
		expect(html).toContain("After.");
	});

	test("strips the containers a comment emptied", async () => {
		const html = await render(
			"Visible. %%\n\n## Private heading\n\nPrivate paragraph.\n%%\n\nStill visible.",
		);

		expect(html).not.toContain("Private");
		expect(html).not.toContain("<h2");
		expect(html).toContain("Still visible.");
	});

	test("keeps delimiters inside code fences and inline code", async () => {
		const fenced = await render("```\n%% not a comment %%\n```");
		const inline = await render("Use `%%` literally.");

		expect(fenced).toContain("%% not a comment %%");
		expect(inline).toContain("%%");
	});

	test("leaves an unclosed delimiter alone", async () => {
		const html = await render("Visible %% dangling text.");

		expect(html).toContain("%% dangling text.");
	});
});

describe("unresolved wikilinks", () => {
	const fixtureRoot = path.resolve(process.cwd(), "test/markdown/fixtures/basic");

	async function render(value: string, overrides = {}): Promise<string> {
		const processor = makeProcessor(fixtureRoot, {
			onBrokenLink: "warn",
			onAmbiguousLink: "warn",
			...overrides,
		});
		const file = await processor.process({
			value,
			path: path.resolve(fixtureRoot, "index.md"),
		});
		return String(file);
	}

	test("marks a missing target with the label the reader expects", async () => {
		const html = await render("See [[does-not-exist|Missing page]] here.");

		expect(html).toContain('class="obsidian-unresolved"');
		expect(html).toContain(">Missing page<");
		// The original syntax is kept as an attribute, never as visible text.
		expect(html).not.toContain(">[[does-not-exist");
		expect(html).toContain('data-wikilink="[[does-not-exist|Missing page]]"');
	});

	test("falls back to the target when there is no alias", async () => {
		const html = await render("See [[does-not-exist]] here.");

		expect(html).toContain(">does-not-exist<");
	});

	test("escapes the original syntax it stores", async () => {
		const html = await render('See [[does-not-exist|a "quoted" label]] here.');

		expect(html).toContain("&quot;quoted&quot;");
		expect(html).not.toContain('title="Unable to resolve wikilink: [[does-not-exist|a "quoted"');
	});

	test("marks ambiguous targets too", async () => {
		const ambiguousRoot = path.resolve(process.cwd(), "test/markdown/fixtures/ambiguous");
		const processor = makeProcessor(ambiguousRoot, {
			onBrokenLink: "warn",
			onAmbiguousLink: "warn",
		});
		const file = await processor.process({
			value: "See [[getting-started]] here.",
			path: path.resolve(ambiguousRoot, "index.md"),
		});

		expect(String(file)).toContain('class="obsidian-unresolved"');
	});
});

describe("comment stripping warnings", () => {
	const fixtureRoot = path.resolve(process.cwd(), "test/markdown/fixtures/basic");

	async function warningsFor(value: string): Promise<string[]> {
		const warnings: string[] = [];
		const original = console.warn;
		console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
		try {
			const processor = makeProcessor(fixtureRoot);
			await processor.process({
				value,
				path: path.resolve(fixtureRoot, "index.md"),
			});
		} finally {
			console.warn = original;
		}
		return warnings;
	}

	test("strips a heading the comment hides, without warning about the outline", async () => {
		// The page data hook drops the outline entry (see the extendPageData
		// tests), so nothing is left for the remark pass to report.
		const warnings = await warningsFor("Visible. %%\n\n## Private heading\n\n%%\n\nStill visible.");

		expect(warnings).toHaveLength(0);
	});

	test("stays quiet for comments without headings", async () => {
		const warnings = await warningsFor("Visible. %%\n\nPrivate paragraph.\n%%\n\nStill visible.");

		expect(warnings).toHaveLength(0);
	});
});

describe("daily navigation hrefs", () => {
	test("encodes route paths like every other emitted link", async () => {
		const { renderDailyNavigation } = await import("../../src/markdown/daily-notes");
		const page = (relativePath: string, routePath: string) =>
			({
				relativePath,
				routePath,
				absolutePath: `/vault/${relativePath}`,
				title: routePath,
			}) as never;

		const html = renderDailyNavigation(
			page("2026-01-02.md", "/vault/2026-01-02"),
			[
				page("2026-01-01.md", "/vault/2026-01-01"),
				page("2026-01-02.md", "/vault/2026-01-02"),
				page("2026-01-03.md", "/vault/Daily Notes/2026-01-03 #1"),
			],
			{ folder: "", dateFormat: "YYYY-MM-DD", navigation: true } as never,
		);

		// The invariant under test: emitted hrefs are URL-encoded, so a route with
		// a space or a `#` cannot silently become a different URL.
		expect(html).toContain('href="/vault/2026-01-01"');
		expect(html).toContain("Daily%20Notes/2026-01-03%20%231");
		expect(html).not.toContain('href="/vault/Daily Notes/');
	});
});
