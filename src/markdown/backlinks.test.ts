import { describe, expect, test } from "bun:test";
import path from "node:path";
import { normalizeLookupValue } from "../shared/slug.js";
import { buildBacklinksIndex, getCachedBacklinksIndex, renderBacklinksHtml } from "./backlinks.ts";
import { buildContentIndex } from "./content-index.ts";
import type { ContentIndex, ContentPage } from "./types.ts";

const ambiguousRoot = path.resolve(process.cwd(), "test/markdown/fixtures/ambiguous");
const aliasRoot = path.resolve(process.cwd(), "test/markdown/fixtures/aliases");
const compatRoot = path.resolve(process.cwd(), "test/markdown/fixtures/compatibility");
const basicRoot = path.resolve(process.cwd(), "test/markdown/fixtures/basic");
const labelRoot = path.resolve(process.cwd(), "test/markdown/fixtures/backlink-labels");

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

/** Build the name→page maps `buildContentIndex` produces, by hand. */
function makeIndex(pages: ContentPage[]): ContentIndex {
	const push = (map: Map<string, ContentPage[]>, key: string, page: ContentPage): void => {
		const list = map.get(key) ?? [];
		list.push(page);
		map.set(key, list);
	};

	const byAbsolutePath = new Map<string, ContentPage>();
	const byPathKey = new Map<string, ContentPage>();
	const byFilePathKey = new Map<string, ContentPage>();
	const byFilePathKeyCI = new Map<string, ContentPage[]>();
	const byBaseName = new Map<string, ContentPage[]>();
	const byBaseNameCI = new Map<string, ContentPage[]>();
	const byTitle = new Map<string, ContentPage[]>();
	const byAlias = new Map<string, ContentPage[]>();

	for (const page of pages) {
		byAbsolutePath.set(page.absolutePath, page);
		byPathKey.set(page.pathKey, page);
		byFilePathKey.set(page.filePathKey, page);
		push(byFilePathKeyCI, page.filePathKey.toLowerCase(), page);
		if (page.baseName.length > 0) {
			push(byBaseName, page.baseName, page);
			push(byBaseNameCI, page.baseName.toLowerCase(), page);
		}
		if (page.title) push(byTitle, normalizeLookupValue(page.title), page);
		for (const alias of page.aliases) push(byAlias, normalizeLookupValue(alias), page);
	}

	return {
		rootDir: "/vault",
		pages,
		assets: [],
		byAbsolutePath,
		byPathKey,
		byFilePathKey,
		byBaseName,
		byTitle,
		byAlias,
		byTag: new Map(),
		byAssetPath: new Map(),
		byAssetBaseName: new Map(),
		byPathKeyCI: new Map(),
		byFilePathKeyCI,
		byBaseNameCI,
		byAssetPathCI: new Map(),
		byAssetBaseNameCI: new Map(),
		backlinks: new Map(),
	};
}

describe("renderBacklinksHtml", () => {
	test("returns an empty string when there are no backlinks", () => {
		expect(renderBacklinksHtml([])).toBe("");
	});

	test("renders one list item per distinct source page", () => {
		const html = renderBacklinksHtml([
			{ routePath: "/a", title: "Alpha" },
			{ routePath: "/b", title: "Beta" },
		]);

		expect(html).toContain('<a href="/a">Alpha</a>');
		expect(html).toContain('<a href="/b">Beta</a>');
		expect(html.match(/<li>/g)).toHaveLength(2);
	});

	test("renders unlinked mentions as their own section with context", () => {
		const html = renderBacklinksHtml(
			[],
			[
				{
					routePath: "/notes/source",
					relativePath: "notes/source.md",
					title: "Source",
					snippet: "I read Widget Notes yesterday.",
				},
			],
		);

		// A mention is not a link, so the reference list stays empty and only the
		// mention section renders.
		expect(html).not.toContain(">Backlinks<");
		expect(html).toContain('<div class="obsidian-backlinks obsidian-unlinked-mentions">');
		expect(html).toContain('<a href="/notes/source">Source</a>');
		expect(html).toContain(
			'<span class="obsidian-mention-context">I read Widget Notes yesterday.</span>',
		);
	});

	test("renders both sections when a page has links and mentions", () => {
		const html = renderBacklinksHtml(
			[{ routePath: "/a", title: "Alpha" }],
			[
				{
					routePath: "/b",
					relativePath: "b.md",
					title: "Beta",
					snippet: "mentions it",
				},
			],
		);

		expect(html).toContain(">Backlinks<");
		expect(html).toContain(">Unlinked mentions<");
		expect(html.indexOf(">Backlinks<")).toBeLessThan(html.indexOf(">Unlinked mentions<"));
	});

	test("escapes a mention snippet and keeps the index-route href form", () => {
		const html = renderBacklinksHtml(
			[],
			[
				{
					routePath: "/wikilinks",
					relativePath: "wikilinks/index.md",
					title: "Wikilinks",
					snippet: '<img src=x onerror="alert(1)"> & more',
				},
			],
		);

		expect(html).toContain('href="/wikilinks/"');
		expect(html).not.toContain("<img");
		// The snippet is element text, not an attribute, so only `& < >` need
		// escaping — quotes stay literal, as they do in backlink titles.
		expect(html).toContain('&lt;img src=x onerror="alert(1)"&gt; &amp; more');
	});

	test("escapes HTML metacharacters in titles and encodes spaced routes", () => {
		const html = renderBacklinksHtml([
			{ routePath: "/vault/create a link", title: 'A & B <b>bold</b> "quoted"' },
		]);

		expect(html).toContain('href="/vault/create%20a%20link"');
		expect(html).toContain("A &amp; B &lt;b&gt;bold&lt;/b&gt;");
		// The title lands in element text, not an attribute, so quotes stay literal.
		expect(html).toContain('"quoted"');
	});
});

describe("buildBacklinksIndex", () => {
	test("resolves and labels backlinks from real wikilink targets", async () => {
		const index = await buildContentIndex(labelRoot);

		const backlinks = await buildBacklinksIndex(index);

		expect(backlinks.get("/target")).toEqual([
			{ routePath: "/linker-heading", relativePath: "linker-heading.md", title: "My Heading" },
			{ routePath: "/linker-plain", relativePath: "linker-plain.md", title: "linker plain" },
			{ routePath: "/linker-title", relativePath: "linker-title.md", title: "Custom Title" },
		]);
	});

	test("records one backlink per source page when a target is ambiguous", async () => {
		const index = await buildContentIndex(ambiguousRoot);

		const backlinks = await buildBacklinksIndex(index);

		expect(backlinks.get("/guide/getting-started")).toEqual([
			{ routePath: "/", relativePath: "index.md", title: "Home" },
		]);
		expect(backlinks.get("/reference/getting-started")).toEqual([
			{ routePath: "/", relativePath: "index.md", title: "Home" },
		]);
	});

	test("records backlinks for alias and title targets", async () => {
		const index = await buildContentIndex(aliasRoot);

		const backlinks = await buildBacklinksIndex(index);

		expect(backlinks.get("/guide/getting-started")).toEqual([
			{ routePath: "/", relativePath: "index.md", title: "Alias Home" },
		]);
	});

	test("resolves note-relative backlink targets from the source page", async () => {
		const index = await buildContentIndex(compatRoot);

		const backlinks = await buildBacklinksIndex(index);

		expect(backlinks.get("/shared/Concept")).toEqual([
			{ routePath: "/notes/current", relativePath: "notes/current.md", title: "Current Note" },
		]);
	});

	test("falls back to a case-insensitive basename, title, and alias", async () => {
		const source = makePage({
			filePathKey: "notes/source",
			wikilinkTargets: ["widget", "my title", "shared alias"],
		});
		const byBaseNamePage = makePage({ filePathKey: "notes/Widget" });
		const byTitlePage = makePage({ filePathKey: "notes/Elsewhere", title: "My Title" });
		const byAliasPage = makePage({ filePathKey: "notes/Another", aliases: ["Shared Alias"] });
		const index = makeIndex([source, byBaseNamePage, byTitlePage, byAliasPage]);

		const backlinks = await buildBacklinksIndex(index);

		expect(backlinks.get("/notes/Widget")).toEqual([
			{ routePath: "/notes/source", relativePath: "notes/source.md", title: "source" },
		]);
		expect(backlinks.get("/notes/Elsewhere")).toEqual([
			{ routePath: "/notes/source", relativePath: "notes/source.md", title: "source" },
		]);
		expect(backlinks.get("/notes/Another")).toEqual([
			{ routePath: "/notes/source", relativePath: "notes/source.md", title: "source" },
		]);
	});

	test("counts a page once per target and never links to itself", async () => {
		const source = makePage({
			filePathKey: "notes/source",
			wikilinkTargets: ["notes/source", "../notes/target", "../notes/target"],
		});
		const target = makePage({ filePathKey: "notes/target" });
		const index = makeIndex([source, target]);

		const backlinks = await buildBacklinksIndex(index);

		expect(backlinks.has("/notes/source")).toBe(false);
		expect(backlinks.get("/notes/target")).toEqual([
			{ routePath: "/notes/source", relativePath: "notes/source.md", title: "source" },
		]);
	});
});

describe("getCachedBacklinksIndex", () => {
	test("returns the pre-built map when the index already has backlinks", async () => {
		const index = await buildContentIndex(basicRoot);
		expect(index.backlinks.size).toBeGreaterThan(0);

		const result = await getCachedBacklinksIndex(index);

		expect(result).toBe(index.backlinks);
	});

	test("builds and then caches the index for hand-built content indexes", async () => {
		const source = makePage({ filePathKey: "index", wikilinkTargets: ["target"] });
		const target = makePage({ filePathKey: "target" });
		const index = makeIndex([source, target]);

		const first = await getCachedBacklinksIndex(index);
		const second = await getCachedBacklinksIndex(index);

		expect(first).toBe(second);
		expect(first.get("/target")).toEqual([
			{ routePath: "/index", relativePath: "index.md", title: "index" },
		]);
	});
});
