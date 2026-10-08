/**
 * Bases end to end: a docs tree and a vault indexed the way the plugin
 * indexes them, `.base` pages registered through `addPages`, and every page
 * compiled through the real remark pass — including a generated base page the
 * way Rspress hands it over (from a temp file, its frontmatter stripped).
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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { VFile } from "vfile";
import { publishedFileRoutes, setPublishedFileRoutes } from "../../../shared/file-routes.js";
import { stripFrontmatter } from "../../../shared/frontmatter.js";
import { buildContentIndex } from "../../content-index.js";
import { normalizePluginOptions } from "../../normalize-options.js";
import { remarkWikilink } from "../../remark-wikilink.js";
import type { ContentIndex, NormalizedPluginOptions } from "../../types.js";
import type { PluginPage } from "../types.js";
import { basesFeature } from "./index.js";

const PROJECTS_BASE = `filters: file.inFolder("Projects")
formulas:
  here: this.file.name
views:
  - type: table
    name: My table
    order: [file.name, status, formula.here]
  - type: kanban
    name: Board
    groupBy: status
    order: [file.name]
`;

const VAULT: Record<string, string> = {
	"Projects.base": PROJECTS_BASE,
	"Projects/Alpha.md":
		"---\nstatus: Doing\n---\n# Alpha\n\nSee [[Projects.base]] and [[Projects.base#Board]].\n",
	"Projects/Beta.md": "---\nstatus: Done\n---\n# Beta\n",
	"Dashboard.md":
		"# Dashboard\n\n![[Projects.base]]\n\n![[Projects.base#Board]]\n\n![[Projects.base#Nope]]\n",
	"Loop.base": 'filters: file.name == "Loop"\nviews:\n  - type: table\n    order: [file.name, e]\n',
	"Loop.md": '---\ne: "Itself: ![[Loop.base]]"\n---\n# Loop\n\n![[Loop.base]]\n',
	"Broken.base": "views: [unclosed",
	"Clash.base": "views: []",
	"Gone.base": "views: []",
	"Places.base":
		'filters: file.inFolder("Places")\nviews:\n  - type: map\n    name: Map\n    coordinates: where\n    center: this.where\n',
	"Places/Paris.md": '---\nwhere: "48.85, 2.29"\n---\n# Paris\n',
	"Atlas.md": "---\nwhere: [45, 9]\n---\n# Atlas\n\n![[Places.base]]\n",
	".obsidian/plugins/maps/data.json": JSON.stringify({
		tileSets: [
			{ id: "1", name: "Vault", lightTiles: "https://vault.example/style.json", darkTiles: "" },
		],
	}),
};

const DOCS: Record<string, string> = {
	"index.md": "# Docs\n\n[[Guide.base]]\n",
	"Guide.base": "views:\n  - type: list\n    name: Everything\n",
	"Clash.base": "views: []",
	"fence.md":
		'# Fence\n\n```base\nformulas:\n  me: this.file.basename\nfilters: file.name == "fence"\nviews:\n  - type: table\n    order: [formula.me]\n```\n',
};

let tmp: string;
let vaultRoot: string;
let docsRoot: string;
let docs: ContentIndex;
let vault: ContentIndex;
let options: NormalizedPluginOptions;
let pages: PluginPage[];
let warn: Mock<typeof console.warn>;

function write(root: string, files: Record<string, string>): void {
	for (const [name, content] of Object.entries(files)) {
		const target = path.join(root, name);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, content);
	}
}

beforeAll(async () => {
	tmp = mkdtempSync(path.join(os.tmpdir(), "bases-pages-"));
	vaultRoot = path.join(tmp, "vault");
	docsRoot = path.join(tmp, "docs");
	write(vaultRoot, VAULT);
	write(docsRoot, DOCS);
	vault = await buildContentIndex(vaultRoot, { routePrefix: "/vault" });
	docs = await buildContentIndex(docsRoot);
	docs.linkedIndexes = [vault];
	vault.linkedIndexes = [docs];
	options = normalizePluginOptions({
		vaultRoot,
		enableBases: true,
		enableTransclusion: true,
		onPluginError: "warn",
		onBrokenLink: "warn",
		bases: { now: new Date(2024, 4, 10) },
	});
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

beforeEach(async () => {
	warn = spyOn(console, "warn").mockImplementation(() => {});
	// The registry is cleared before each test (test-setup.ts); `addPages` runs
	// before any page compiles, as in a build.
	pages =
		(await basesFeature.addPages?.({
			options,
			docsRoot,
			vaultRoot,
			vaultRoutePrefix: "/vault",
			siteBase: "/",
			docs,
			vault,
			resolveOptions: { enableCaseInsensitiveLookup: true, enableFuzzyMatching: false },
		})) ?? [];
});

afterEach(() => warn.mockRestore());

const isVaultFile = (filePath: string): boolean => filePath.startsWith(`${vaultRoot}${path.sep}`);

async function compile(
	filePath: string,
	value: string,
	siteBase = "/",
): Promise<{ html: string; messages: string[] }> {
	const processor = unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkWikilink, {
			getDocsRoot: (file) => (file && isVaultFile(file) ? vaultRoot : docsRoot),
			getContentIndex: async (file) => (isVaultFile(file) ? vault : docs),
			getPublishedIndexes: async () => [docs, vault],
			getSiteBase: () => siteBase,
			options,
		})
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(rehypeStringify, { allowDangerousHtml: true });
	const result = await processor.process(new VFile({ value, path: filePath }));
	return { html: String(result), messages: result.messages.map((message) => message.message) };
}

/** A vault note, compiled as Rspress compiles it: frontmatter already stripped. */
function note(relativePath: string) {
	return compile(path.join(vaultRoot, relativePath), stripFrontmatter(VAULT[relativePath] ?? ""));
}

/** A generated page as Rspress compiles it: from a temp file outside every root, without frontmatter. */
function generated(page: PluginPage | undefined) {
	if (!page?.content) throw new Error("no generated page");
	return compile(
		path.join(tmp, "node_modules/.rspress/runtime/temp-1.mdx"),
		stripFrontmatter(page.content),
	);
}

describe("base pages", () => {
	test("each published .base file gets a page under routePrefix, registered as its route", () => {
		expect(pages.map((page) => page.routePath).sort()).toEqual([
			"/bases/Broken",
			"/bases/Clash",
			"/bases/Gone",
			"/bases/Guide",
			"/bases/Loop",
			"/bases/Places",
			"/bases/Projects",
		]);
		expect(
			publishedFileRoutes("bases").find((route) => route.routePath === "/bases/Projects"),
		).toEqual({
			kind: "bases",
			absolutePath: path.join(vaultRoot, "Projects.base"),
			routePath: "/bases/Projects",
			source: "Projects.base",
		});
		const projects = pages.find((page) => page.routePath === "/bases/Projects");
		expect(projects?.content).toBe(
			'---\ntitle: "Projects"\n---\n\n{/* obsidian-base: %2Fbases%2FProjects */}\n',
		);
		// Two trees publishing the same route: the vault's file wins, and the clash is reported.
		expect(
			publishedFileRoutes("bases").find((route) => route.routePath === "/bases/Clash")
				?.absolutePath,
		).toBe(path.join(vaultRoot, "Clash.base"));
		expect(
			warn.mock.calls.some(([message]) => String(message).includes("Clash.base is not published")),
		).toBe(true);
	});

	test("the route prefix is an option", async () => {
		const custom = await basesFeature.addPages?.({
			options: { ...options, bases: { routePrefix: "views/" } },
			docsRoot,
			siteBase: "/",
			vaultRoutePrefix: "/vault",
			docs,
			resolveOptions: {},
		});
		expect(custom?.map((page) => page.routePath).sort()).toEqual(["/views/Clash", "/views/Guide"]);
	});

	test("[[Projects.base]] links to the page, [[Projects.base#View]] to the view on it", async () => {
		const { html } = await note("Projects/Alpha.md");
		expect(html).toContain('href="/bases/Projects"');
		expect(html).toContain('href="/bases/Projects#Board"');
		const fromDocs = await compile(path.join(docsRoot, "index.md"), DOCS["index.md"] ?? "");
		expect(fromDocs.html).toContain('href="/bases/Guide"');
	});

	test("the page renders every view, ids = view names, `this` = the base file", async () => {
		const { html } = await generated(pages.find((page) => page.routePath === "/bases/Projects"));
		expect(html).toContain("<h1");
		expect(html).toContain(">Projects</h1>");
		expect(html).toContain(
			'<section class="bases-view" data-view-type="table" data-view-name="My table" id="My table">',
		);
		expect(html).toContain(
			'<section class="bases-view" data-view-type="kanban" data-view-name="Board" id="Board">',
		);
		expect(html).toContain('<td class="bases-td" data-property="formula.here">Projects.base</td>');
		expect(html).toContain('<a href="/vault/Projects/Alpha">Alpha</a>');
		expect(html).not.toContain("obsidian-base");
	});

	test("a docs-root base page, and a broken one shown in place", async () => {
		const guide = await generated(pages.find((page) => page.routePath === "/bases/Guide"));
		expect(guide.html).toContain('<ul class="bases-list"');
		const broken = await generated(pages.find((page) => page.routePath === "/bases/Broken"));
		expect(broken.html).toContain(
			'<div class="bases-error"><strong>Broken.base</strong>: Invalid YAML',
		);
		expect(broken.messages.some((message) => message.includes("Broken.base: Invalid YAML"))).toBe(
			true,
		);
	});

	test("a base file gone after its page was registered is reported, not rendered empty", async () => {
		const gone = pages.find((page) => page.routePath === "/bases/Gone");
		rmSync(path.join(vaultRoot, "Gone.base"));
		try {
			const { html, messages } = await generated(gone);
			expect(html).toContain('<div class="bases-error">Gone.base cannot be read</div>');
			expect(messages.some((message) => message.includes("Gone.base cannot be read"))).toBe(true);
		} finally {
			writeFileSync(path.join(vaultRoot, "Gone.base"), "views: []");
		}
	});

	test("only a generated page is replaced: a marker in a note, or an unknown route, is left alone", async () => {
		const { html } = await compile(
			path.join(vaultRoot, "Projects/Beta.md"),
			"# Beta\n\n`{/* obsidian-base: %2Fbases%2FProjects */}`\n",
		);
		expect(html).not.toContain("bases-container");
		const unknown = await generated({
			routePath: "/x",
			content: "{/* obsidian-base: %2Fnowhere */}\n",
		});
		expect(unknown.html).not.toContain("bases-container");
		setPublishedFileRoutes("bases", []);
		const unregistered = await generated(
			pages.find((page) => page.routePath === "/bases/Projects"),
		);
		expect(unregistered.html).not.toContain("bases-container");
	});
});

describe("embeds", () => {
	test("![[x.base]] renders every view, ![[x.base#View]] just that view, `this` = the embedding note", async () => {
		const { html, messages } = await note("Dashboard.md");
		const embeds = html.split('<div class="bases-embed">').slice(1);
		// The third names a view the base does not have.
		expect(embeds).toHaveLength(3);
		expect(embeds[0]).toContain('<div class="bases-views">');
		expect(embeds[0]).toContain('<td class="bases-td" data-property="formula.here">Dashboard</td>');
		// Inside a page, the views carry no ids: the base's own page owns them.
		expect(embeds[0]).not.toContain('id="Board"');
		expect(embeds[1]).not.toContain("bases-view-tab");
		expect(embeds[1]).toContain('data-view-name="Board"');
		expect(embeds[1]).not.toContain('data-view-name="My table"');
		expect(html).toContain(
			'<div class="bases-error">Projects.base has no view named "Nope" (views: "My table", "Board")</div>',
		);
		expect(messages.some((message) => message.includes('has no view named "Nope"'))).toBe(true);
	});

	test("a base whose results embed the same base stops at the second level", async () => {
		const { html, messages } = await note("Loop.md");
		expect(html).toContain("Loop.base embeds itself through its own results");
		expect(messages.some((message) => message.includes("embeds itself"))).toBe(true);
	});

	test("an embed of a .base file that does not exist falls back to the broken-link form", async () => {
		const { html, messages } = await compile(
			path.join(vaultRoot, "Projects/Beta.md"),
			"![[Missing.base]]\n",
		);
		expect(html).not.toContain("bases-container");
		expect(messages.some((message) => message.includes("Missing.base"))).toBe(true);
	});

	test("a base file unreadable at embed time is reported in place", async () => {
		rmSync(path.join(vaultRoot, "Gone.base"));
		try {
			const { html } = await compile(path.join(vaultRoot, "Projects/Beta.md"), "![[Gone.base]]\n");
			expect(html).toContain('<div class="bases-error">Gone.base cannot be read</div>');
		} finally {
			writeFileSync(path.join(vaultRoot, "Gone.base"), "views: []");
		}
	});
});

describe("blocks", () => {
	test("a ```base block renders in place with `this` = the note containing it", async () => {
		const { html } = await compile(path.join(docsRoot, "fence.md"), DOCS["fence.md"] ?? "");
		expect(html).toContain('<td class="bases-td" data-property="formula.me">fence</td>');
		expect(html).not.toContain("<code");
	});
});

describe("map views", () => {
	/** The settings a map view hands the client (see `runtime/map-markup.ts`). */
	function mapConfig(html: string): Record<string, unknown> {
		const raw = /data-bases-map="([^"]*)"/.exec(html)?.[1] ?? "";
		return JSON.parse(raw.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
	}

	test("the client component drawing them is registered, and the bundle keeps maplibre-gl", () => {
		const components = basesFeature.globalUIComponents?.() ?? [];
		expect(components).toHaveLength(1);
		expect(components[0]).toMatch(/BasesMaps\.(tsx|js)$/);
		expect(existsSync(components[0] ?? "")).toBe(true);
		// maplibre-gl is installed here, so nothing is aliased away.
		expect(basesFeature.builderConfig?.(options)).toEqual({});
	});

	test("on the base's own page the map fills the page; embedded it is sized, centred on `this`", async () => {
		const page = await generated(
			pages.find((candidate) => candidate.routePath === "/bases/Places"),
		);
		// `this` is the base file, which has no `where`: the map centres on its markers.
		expect(mapConfig(page.html)).toMatchObject({ center: null, height: null });
		expect(page.html).toContain('data-map-route="/vault/Places/Paris"');
		const atlas = await compile(
			path.join(vaultRoot, "Atlas.md"),
			stripFrontmatter(VAULT["Atlas.md"] ?? ""),
			"/site/",
		);
		expect(mapConfig(atlas.html)).toMatchObject({
			center: [45, 9],
			height: 400,
			// Marker routes stay routes; the client adds the base to their links.
			base: "/site/",
		});
		expect(atlas.html).toContain('data-map-route="/vault/Places/Paris"');
	});

	test("the vault's Maps plugin background is used, unless readVaultSettings is off", async () => {
		const page = await generated(
			pages.find((candidate) => candidate.routePath === "/bases/Places"),
		);
		expect(mapConfig(page.html)).toMatchObject({
			tiles: ["https://vault.example/style.json"],
			tilesDark: ["https://vault.example/style.json"],
		});
		const saved = options;
		options = { ...options, bases: { ...options.bases, readVaultSettings: false } };
		try {
			const off = await generated(
				pages.find((candidate) => candidate.routePath === "/bases/Places"),
			);
			expect(mapConfig(off.html)).toMatchObject({
				tiles: ["https://tiles.openfreemap.org/styles/bright"],
			});
		} finally {
			options = saved;
		}
	});
});
