import { describe, expect, test } from "bun:test";
import { generateTagPages } from "./tag-pages.ts";
import type { ContentIndex, ContentPage } from "./types.ts";

/**
 * The generated tag pages are markdown that Rspress then parses with raw HTML
 * enabled, so anything a page `title` contributes has to be inert in two
 * directions: it cannot become an element, and it cannot break out of the
 * `[label](destination)` it is written into and leave the rest of the title as
 * page content.
 */

function makePage(overrides: Partial<ContentPage> = {}): ContentPage {
	return {
		absolutePath: "/vault/eve.md",
		relativePath: "eve.md",
		routePath: "/Eve",
		pathKey: "Eve",
		filePathKey: "Eve",
		baseName: "Eve",
		title: "Eve",
		aliases: [],
		tags: ["alpha"],
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
	};
}

function makeIndex(pages: ContentPage[]): ContentIndex {
	const index = {
		pages,
		assets: [],
		byAbsolutePath: new Map(),
		byPathKey: new Map(),
		byFilePathKey: new Map(),
		byBaseName: new Map(),
		byTitle: new Map(),
		byAlias: new Map(),
		byTag: new Map(),
		byAssetPath: new Map(),
		byAssetBaseName: new Map(),
		byPathKeyCI: new Map(),
		byFilePathKeyCI: new Map(),
		byBaseNameCI: new Map(),
		byAssetPathCI: new Map(),
		byAssetBaseNameCI: new Map(),
		backlinks: new Map(),
	} as unknown as ContentIndex;
	return index;
}

function generatedFor(title: string): string {
	const index = makeIndex([makePage({ title })]);
	return generateTagPages(index)[0]?.content ?? "";
}

describe("generated tag pages", () => {
	test("a newline in a title cannot close the link label and start raw HTML", () => {
		// The heading escaped `& < > [ ] \n \r` and the label only `\ [ ]`, so this
		// `- [hello\n<img src=x onerror=alert(1)>](/Eve)` and a live element once
		// Rspress parsed the page with raw HTML enabled.
		const content = generatedFor("hello\n<img src=x onerror=alert(1)>");

		expect(content).not.toMatch(/\[hello\n/);
		expect(content).toContain("hello &lt;img");
		expect(content.split("\n").filter((l) => l.startsWith("- ["))).toHaveLength(1);
	});

	test("a script tag in a title stays text", () => {
		expect(generatedFor("<script>alert(1)</script>")).toContain(
			"[&lt;script&gt;alert(1)&lt;/script&gt;](/Eve)",
		);
	});

	test("brackets and parens in a title cannot form a second link", () => {
		const content = generatedFor("a] (b) c");

		expect(content).toContain("a\\]");
		expect(content).toContain("](/Eve)");
	});

	test("an ordinary multi-line title collapses onto one line", () => {
		// A YAML block scalar is a plausible typo, and it used to split the
		// generated list item across lines.
		const content = generatedFor("multi\r\nline");

		expect(content).toContain("multi line");
		expect(content).not.toContain("\r");
	});

	test("a plain title is untouched", () => {
		expect(generatedFor("Getting Started")).toContain("- [Getting Started](/Eve)");
	});
});

describe("tag page routes", () => {
	test("docs and vault share one page per tag, whatever the casing", () => {
		const docs = makeIndex([
			makePage({ absolutePath: "/docs/a.md", routePath: "/a", title: "A", tags: ["project"] }),
		]);
		const vault = makeIndex([
			makePage({
				absolutePath: "/vault/b.md",
				routePath: "/vault/b",
				title: "B",
				tags: ["Project"],
			}),
			makePage({
				absolutePath: "/vault/c.md",
				routePath: "/vault/c",
				title: "C",
				tags: ["Project/Sub"],
			}),
		]);

		const pages = generateTagPages(docs, vault);
		const routes = pages.map((page) => page.routePath);

		// Rspress refuses a route added twice, so the old per-index generation
		// failed the build here.
		expect(routes).toEqual(["/tags/project", "/tags/project/sub"]);
		const project = pages.find((page) => page.routePath === "/tags/project")?.content ?? "";
		// The most common spelling names the page; every tagged page is listed,
		// a nested child included.
		expect(project).toContain("# \\#Project");
		expect(project).toContain("- [A](/a)");
		expect(project).toContain("- [B](/vault/b)");
		expect(project).toContain("- [C](/vault/c)");
	});
});
