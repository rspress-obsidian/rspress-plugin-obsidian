// The graph's build half, driven the way the plugin drives it: real files in a
// temp tree, the routes Rspress would publish for them, and the shared content
// index + `resolveWikiLink` doing the resolution. Each test names the reader-
// visible bug it pins.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getCachedContentIndex } from "../../markdown/content-index.js";
import { setCanvasRoutes } from "../../shared/canvas-routes.js";
import { setPublishedContent } from "../../shared/published-content.js";
import { deriveRoutePath } from "../../shared/route-path.js";
import { decodeGraphPayload } from "../graph-payload.js";
import type { GraphData, GraphPayload } from "../types.js";
import { buildGraphModules, type CollectedRoute, type GraphBuildOptions } from "./index.js";

const roots: string[] = [];

afterEach(async () => {
	setPublishedContent(undefined);
	setCanvasRoutes([]);
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeTree(files: Record<string, string>, root?: string): Promise<string> {
	const dir = root ?? (await mkdtemp(path.join(tmpdir(), "graph-build-")));
	if (!root) roots.push(dir);
	for (const [relativePath, content] of Object.entries(files)) {
		const file = path.join(dir, relativePath);
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, content);
	}
	return dir;
}

/** The routes Rspress publishes for a tree's markdown files. */
function routesFor(root: string, files: Record<string, string>, prefix = ""): CollectedRoute[] {
	return Object.keys(files)
		.filter((file) => /\.mdx?$/.test(file))
		.map((relativePath) => ({
			routePath: deriveRoutePath(relativePath, prefix),
			absolutePath: path.join(root, relativePath),
			relativePath,
			pageName: relativePath.replace(/\.mdx?$/, ""),
		}));
}

async function build(
	routes: CollectedRoute[],
	docsRoot: string,
	options: Partial<GraphBuildOptions> = {},
): Promise<{ graph: GraphData; modules: Record<string, string> }> {
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		const result = await buildGraphModules(
			routes,
			{},
			{
				docsRoot,
				base: "/",
				onUnresolvedLink: "ignore",
				...options,
			},
		);
		return { graph: result.graphData, modules: result.modules };
	} finally {
		warn.mockRestore();
	}
}

async function buildDocs(files: Record<string, string>, options: Partial<GraphBuildOptions> = {}) {
	const root = await writeTree(files);
	return { root, ...(await build(routesFor(root, files), root, options)) };
}

function edgesFrom(graph: GraphData, source: string): string[] {
	return graph.links
		.filter((link) => link.source === source)
		.map((link) => link.target)
		.sort();
}

function labelOf(graph: GraphData, id: string): string | undefined {
	return graph.nodes.find((node) => node.id === id)?.label;
}

describe("link resolution matches the page and its backlinks", () => {
	test("an aliased wikilink inside a table row (escaped pipe) links the note", async () => {
		const { graph } = await buildDocs({
			"a.md": "| Link | Note |\n| --- | --- |\n| [[Page\\|Alias]] | x |\n",
			"Page.md": "# Page\n",
		});
		expect(edgesFrom(graph, "/a")).toEqual(["/Page"]);
	});

	test("a percent-encoded markdown link reaches the multi-word note", async () => {
		const { graph } = await buildDocs({
			"a.md": "See [the note](My%20Note.md) and [cjk](%E6%97%A5%E6%9C%AC.md).\n",
			"My Note.md": "body\n",
			"日本.md": "body\n",
		});
		expect(edgesFrom(graph, "/a")).toEqual(["/My Note", "/日本"]);
	});

	test("the resolver ladder decides: an exact basename first, then an alias", async () => {
		const { graph } = await buildDocs({
			"exact.md": "[[foo]]\n",
			"aliased.md": "[[Foo]]\n",
			"foo.md": "x\n",
			"bar.md": "---\naliases: [Foo]\n---\nx\n",
		});
		expect(edgesFrom(graph, "/exact")).toEqual(["/foo"]);
		// The old graph resolver took the case-insensitive basename first and drew
		// this edge to /foo while the page linked /bar.
		expect(edgesFrom(graph, "/aliased")).toEqual(["/bar"]);
	});

	test("comments do not link: %% … %% and <!-- … --> are hidden on the page", async () => {
		const { graph } = await buildDocs({
			"a.md":
				"visible %% [[Secret]] %% text\n\n%%\n[[Hidden]]\n%%\n\n<!-- [[InHtml]] -->\n[[Shown]]\n",
			"Secret.md": "x\n",
			"Hidden.md": "x\n",
			"InHtml.md": "x\n",
			"Shown.md": "x\n",
		});
		expect(edgesFrom(graph, "/a")).toEqual(["/Shown"]);
	});

	test("links in code are documentation, not links", async () => {
		const { graph } = await buildDocs({
			"a.md": "```md\n[[Fenced]]\n```\n\nInline `[[Spanned]]` and [[Real]].\n",
			"Fenced.md": "x\n",
			"Spanned.md": "x\n",
			"Real.md": "x\n",
		});
		expect(edgesFrom(graph, "/a")).toEqual(["/Real"]);
	});

	test("frontmatter property links count, as in Obsidian ≥ 1.4", async () => {
		const { graph } = await buildDocs({
			"a.md": '---\nrelated: "[[Target]]"\nup: ["[[Folder/Deep]]"]\n---\nbody\n',
			"Target.md": "x\n",
			"Folder/Deep.md": "x\n",
		});
		expect(edgesFrom(graph, "/a")).toEqual(["/Folder/Deep", "/Target"]);
	});

	test("case-insensitive paths and path-suffix links resolve like the page", async () => {
		const { graph } = await buildDocs({
			"sub/src.md": "[[folder/note]] and [[Inner/Leaf]]\n",
			"folder/Note.md": "x\n",
			"deep/Inner/Leaf.md": "x\n",
		});
		expect(edgesFrom(graph, "/sub/src")).toEqual(["/deep/Inner/Leaf", "/folder/Note"]);
	});

	test("an obsidian://open link is a link to the note it opens", async () => {
		const { graph } = await buildDocs({
			"a.md": "[open](obsidian://open?vault=v&file=Target)\n",
			"Target.md": "x\n",
		});
		expect(edgesFrom(graph, "/a")).toEqual(["/Target"]);
	});

	test("a link to a heading still links the note, even when the heading is gone", async () => {
		const { graph } = await buildDocs({
			"a.md": "[[Target#Missing heading]]\n",
			"Target.md": "# Present\n",
		});
		expect(edgesFrom(graph, "/a")).toEqual(["/Target"]);
	});

	test("graph edges between pages are exactly the index's backlinks", async () => {
		const files = {
			"index.md": "[[alpha]] [Beta](beta.md) [[Gamma|g]] ![[alpha]]\n",
			"alpha.md": "---\nrelated: '[[beta]]'\n---\n[[index]]\n",
			"beta.md": "| [[gamma\\|x]] |\n|---|\n",
			"Gamma.md": "%% [[alpha]] %%\n",
		};
		const { root, graph } = await buildDocs(files);
		const index = await getCachedContentIndex(root, {});
		const fromBacklinks = [...index.backlinks]
			.flatMap(([target, refs]) => refs.map((ref) => `${ref.routePath}→${target}`))
			.sort();
		const fromGraph = graph.links
			.filter((link) => graph.nodes.find((node) => node.id === link.target)?.kind === "page")
			.map((link) => `${link.source}→${link.target}`)
			.sort();
		expect(fromGraph).toEqual(fromBacklinks);
	});
});

describe("vault publishing", () => {
	test("vault-root paths resolve under vaultRoutePrefix, and docs pages reach vault notes", async () => {
		const vaultFiles = {
			"Notes/Setup.md": "x\n",
			"Daily/d1.md": "[[Notes/Setup]]\n",
		};
		const docsFiles = { "index.md": "[[Setup]]\n" };
		const vaultRoot = await writeTree(vaultFiles);
		const docsRoot = await writeTree(docsFiles);
		setPublishedContent({
			docsRoot,
			vaultRoot,
			vaultRoutePrefix: "/vault",
			docsIndexOptions: {},
			vaultIndexOptions: { routePrefix: "/vault" },
			enableCaseInsensitiveLookup: true,
			enableFuzzyMatching: false,
		});
		const routes = [
			...routesFor(docsRoot, docsFiles),
			...routesFor(vaultRoot, vaultFiles, "/vault"),
		];

		const { graph } = await build(routes, docsRoot);

		expect(edgesFrom(graph, "/vault/Daily/d1")).toEqual(["/vault/Notes/Setup"]);
		expect(edgesFrom(graph, "/")).toEqual(["/vault/Notes/Setup"]);
	});
});

describe("node kinds", () => {
	test("attachments become attachment nodes instead of unresolved-link warnings", async () => {
		const { graph } = await buildDocs(
			{
				"a.md": "![[pic.png]] [spec](assets/spec.pdf) [[report.pdf]] [dl](/downloads/app.zip)\n",
				"pic.png": "png",
				"assets/spec.pdf": "pdf",
				"report.pdf": "pdf",
			},
			{ onUnresolvedLink: "error" },
		);
		const attachments = graph.nodes.filter((node) => node.kind === "attachment");
		expect(attachments.map((node) => node.label).sort()).toEqual([
			"pic.png",
			"report.pdf",
			"spec.pdf",
		]);
		expect(edgesFrom(graph, "/a")).toEqual(attachments.map((node) => node.id).sort());
	});

	test("a link to a missing note becomes one unresolved node, however it is spelled", async () => {
		const { graph } = await buildDocs({
			"a.md": "[[Not Yet Written]] and [[not yet written#h]]\n",
			"b.md": "[[Not Yet Written]]\n",
		});
		const ghosts = graph.nodes.filter((node) => node.kind === "unresolved");
		expect(ghosts).toHaveLength(1);
		expect(ghosts[0]?.navigable).toBe(false);
		expect(edgesFrom(graph, "/b")).toEqual([ghosts[0]?.id ?? "missing"]);
	});

	test("onUnresolvedLink: error still fails the build for a missing note", async () => {
		const root = await writeTree({ "a.md": "[[Nowhere]]\n" });
		await expect(
			buildGraphModules(
				routesFor(root, { "a.md": "" }),
				{},
				{
					docsRoot: root,
					base: "/",
					onUnresolvedLink: "error",
				},
			),
		).rejects.toThrow("/a -> Nowhere");
	});
});

describe("tags", () => {
	test("unicode tags are whole tags, and case variants share one node", async () => {
		const { graph } = await buildDocs({
			"a.md": "#日本語 and #café and #Project and #📚 (#paren) ,#comma\n",
			"b.md": "---\ntags: [project, Café]\n---\n#2024-review is a tag, #2024 is not\n",
		});
		const tags = graph.nodes.filter((node) => node.kind === "tag").map((node) => node.id);
		expect(tags.sort()).toEqual(
			[
				"/tags/%F0%9F%93%9A",
				"/tags/2024-review",
				"/tags/caf%C3%A9",
				"/tags/comma",
				"/tags/paren",
				"/tags/project",
				"/tags/%E6%97%A5%E6%9C%AC%E8%AA%9E",
			]
				.map((id) => decodeURIComponent(id))
				.sort(),
		);
		expect(edgesFrom(graph, "/b")).toEqual(["/tags/2024-review", "/tags/café", "/tags/project"]);
	});

	test("a tag page route links up whatever case its tag is written in", async () => {
		const files = { "a.md": "#Project\n" };
		const root = await writeTree(files);
		const routes = [
			...routesFor(root, files),
			// The markdown plugin's tag page, published through `addPages`.
			{
				routePath: "/tags/project",
				absolutePath: path.join(root, "node_modules/.rspress/runtime/temp-1.mdx"),
				relativePath: "tags/project.mdx",
				pageName: "tags_project",
			},
		];
		const { graph } = await build(routes, root);
		expect(edgesFrom(graph, "/a")).toEqual(["/tags/project"]);
		const tagNode = graph.nodes.find((node) => node.id === "/tags/project");
		expect(tagNode).toMatchObject({ kind: "tag", navigable: true, label: "#Project" });
	});
});

describe("node labels", () => {
	test("docs pages: frontmatter title, else the first H1, else the file name — never a code comment or Rspress pageName", async () => {
		const { graph } = await buildDocs({
			"index.md": "# Welcome\n",
			"titled.md": "---\ntitle: Custom Title\n---\n# Heading\n",
			"getting-started.md": "Intro.\n\n# Getting Started\n",
			"Projects/Alpha.md": "```bash\n# install deps\n```\n",
			"yaml.md": "---\n# yaml comment\nkey: v\n---\nbody\n",
			"guide/index.md": "x\n",
		});
		expect(labelOf(graph, "/")).toBe("Welcome");
		expect(labelOf(graph, "/titled")).toBe("Custom Title");
		expect(labelOf(graph, "/getting-started")).toBe("Getting Started");
		expect(labelOf(graph, "/Projects/Alpha")).toBe("Alpha");
		expect(labelOf(graph, "/yaml")).toBe("yaml");
		expect(labelOf(graph, "/guide")).toBe("guide");
	});
});

describe("canvas boards", () => {
	test("a board links to its cards' files and its text cards' links, not to its notes' links", async () => {
		const files = {
			"Notes/Alpha.md": "[[Gamma]] [[Delta]]\n",
			"Notes/Beta.md": "x\n",
			"Gamma.md": "x\n",
			"Delta.md": "x\n",
			"Epsilon.md": "x\n",
			"Board.canvas": JSON.stringify({
				nodes: [
					{ id: "1", type: "file", file: "Notes/Alpha.md" },
					{ id: "2", type: "file", file: "Notes/Beta.md" },
					{ id: "3", type: "text", text: "See [[Epsilon]]\n#board-tag" },
					{ id: "4", type: "link", url: "https://example.com" },
				],
				edges: [],
			}),
		};
		const root = await writeTree(files);
		setCanvasRoutes([
			{
				absolutePath: path.join(root, "Board.canvas"),
				routePath: "/canvas/board",
				source: "Board.canvas",
			},
		]);
		// What Rspress routes for the board: the canvas feature's temp page,
		// whose content inlines every card note's body.
		const tempPage = await writeTree({
			"temp-0.mdx": "<CanvasViewer notes={{ Alpha: '[[Gamma]] [[Delta]]' }} />\n",
		});
		const routes = [
			...routesFor(root, files),
			{
				routePath: "/canvas/board",
				absolutePath: path.join(tempPage, "temp-0.mdx"),
				relativePath: "canvas/board.mdx",
				pageName: "canvas_board",
			},
		];

		const { graph } = await build(routes, root);

		expect(edgesFrom(graph, "/canvas/board")).toEqual([
			"/Epsilon",
			"/Notes/Alpha",
			"/Notes/Beta",
			"/tags/board-tag",
		]);
		expect(labelOf(graph, "/canvas/board")).toBe("Board.canvas");
	});

	test("[[Board.canvas]] links to the board's route", async () => {
		const files = { "a.md": "[[Board.canvas]]\n", "Board.canvas": '{"nodes":[]}' };
		const root = await writeTree(files);
		setCanvasRoutes([
			{
				absolutePath: path.join(root, "Board.canvas"),
				routePath: "/canvas/board",
				source: "Board.canvas",
			},
		]);
		const routes = [
			...routesFor(root, files),
			{
				routePath: "/canvas/board",
				absolutePath: path.join(root, "node_modules/.rspress/runtime/temp-0.mdx"),
				relativePath: "canvas/board.mdx",
				pageName: "canvas_board",
			},
		];
		const { graph } = await build(routes, root);
		expect(edgesFrom(graph, "/a")).toEqual(["/canvas/board"]);
	});
});

describe("routes no content index holds", () => {
	test("another plugin's page outside the docs root keeps its title, links and tags", async () => {
		const files = { "Target.md": "x\n" };
		const root = await writeTree(files);
		const extra = await writeTree({
			"extra.mdx": "---\ntitle: '  Extra Page  '\n---\nSee [[Target]] #plugin-tag\n",
			"bad.md": "---\ntitle: [unclosed\n---\n[[Target]]\n",
		});
		const routes = [
			...routesFor(root, files),
			{
				routePath: "/extra",
				absolutePath: path.join(extra, "extra.mdx"),
				relativePath: "extra.mdx",
				pageName: "extra",
			},
			{
				routePath: "/bad",
				absolutePath: path.join(extra, "bad.md"),
				relativePath: "bad.md",
				pageName: "bad",
			},
		];
		const { graph } = await build(routes, root);
		expect(labelOf(graph, "/extra")).toBe("Extra Page");
		expect(edgesFrom(graph, "/extra")).toEqual(["/Target", "/tags/plugin-tag"]);
		// Broken frontmatter falls back to the file name, and its links still count.
		expect(labelOf(graph, "/bad")).toBe("bad");
		expect(edgesFrom(graph, "/bad")).toEqual(["/Target"]);
	});

	test("a routed file that is missing on disk stays a link-less node named by its route", async () => {
		const root = await writeTree({ "a.md": "x\n" });
		const routes = [
			...routesFor(root, { "a.md": "" }),
			{
				routePath: "/gone/Lost%20Note",
				absolutePath: path.join(root, "..", "nowhere", "Lost Note.md"),
				relativePath: "gone/Lost Note.md",
				pageName: "gone_lost",
			},
		];
		const { graph } = await build(routes, root);
		expect(labelOf(graph, "/gone/Lost%20Note")).toBe("Lost Note");
		expect(edgesFrom(graph, "/gone/Lost%20Note")).toEqual([]);
	});

	test("a generated listing page is a node without outgoing links", async () => {
		const root = await writeTree({
			"a.md": "x\n",
			"node_modules/.rspress/runtime/temp-9.mdx": "[[a]]\n",
		});
		const routes = [
			...routesFor(root, { "a.md": "" }),
			{
				routePath: "/calendar",
				absolutePath: path.join(root, "node_modules/.rspress/runtime/temp-9.mdx"),
				relativePath: "calendar.mdx",
				pageName: "calendar",
			},
		];
		const { graph } = await build(routes, root);
		expect(labelOf(graph, "/calendar")).toBe("calendar");
		expect(edgesFrom(graph, "/calendar")).toEqual([]);
	});

	test("a malformed percent escape in a tag route is shown verbatim", async () => {
		const root = await writeTree({ "a.md": "x\n" });
		const routes = [
			...routesFor(root, { "a.md": "" }),
			{
				routePath: "/tags/100%",
				absolutePath: path.join(root, "node_modules/t.mdx"),
				relativePath: "tags/100.mdx",
				pageName: "tags_100",
			},
		];
		const { graph } = await build(routes, root);
		expect(graph.nodes.find((node) => node.kind === "tag")?.label).toBe("#100%");
	});

	test("a vault board resolves its cards against the vault", async () => {
		const vaultFiles = {
			"Notes/Setup.md": "# Installing the tool\n\nx\n",
			"Boards/Plan.canvas": JSON.stringify({
				nodes: [{ id: "1", type: "text", text: "[[Setup]]" }],
				edges: [],
			}),
		};
		const vaultRoot = await writeTree(vaultFiles);
		const docsRoot = await writeTree({ "index.md": "x\n" });
		setPublishedContent({
			docsRoot,
			vaultRoot,
			vaultRoutePrefix: "/vault",
			docsIndexOptions: {},
			vaultIndexOptions: { routePrefix: "/vault" },
			enableCaseInsensitiveLookup: true,
			enableFuzzyMatching: false,
		});
		setCanvasRoutes([
			{
				absolutePath: path.join(vaultRoot, "Boards/Plan.canvas"),
				routePath: "/vault/Boards/Plan",
				source: "Boards/Plan.canvas",
			},
		]);
		const routes = [
			...routesFor(docsRoot, { "index.md": "" }),
			...routesFor(vaultRoot, vaultFiles, "/vault"),
			{
				routePath: "/vault/Boards/Plan",
				absolutePath: path.join(docsRoot, "node_modules/temp-1.mdx"),
				relativePath: "vault/Boards/Plan.mdx",
				pageName: "plan",
			},
		];
		const { graph } = await build(routes, docsRoot);
		expect(edgesFrom(graph, "/vault/Boards/Plan")).toEqual(["/vault/Notes/Setup"]);
		expect(labelOf(graph, "/vault/Boards/Plan")).toBe("Plan.canvas");
		// A vault note keeps Obsidian's file-name label even with an H1.
		expect(labelOf(graph, "/vault/Notes/Setup")).toBe("Setup");
	});
});

describe("profiling", () => {
	test("profile: true reports the build's counts through the logger", async () => {
		const files = { "index.md": "[[b]]\n", "b.md": "x\n" };
		const root = await writeTree(files);
		const lines: string[] = [];
		await build(routesFor(root, files), root, {
			profile: true,
			logger: (line: string) => lines.push(line),
		});
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("routes=2 | nodes=2 | links=1 | resolvedLinks=1");
		expect(lines[0]).toContain("reusedModule=false");
	});
});

describe("modules", () => {
	test("the graph ships as a compact payload that decodes to the same graph", async () => {
		const { graph, modules } = await buildDocs({ "index.md": "[[b]]\n", "b.md": "x\n" });
		const source = modules["virtual-graph-data"] ?? "";
		const payload = new Function(
			`${source.replace("export const graphPayload =", "return").replace(/export default graphPayload;\s*$/, "")}`,
		)() as GraphPayload;
		expect(payload.links).toEqual([payload.ids.indexOf("/"), payload.ids.indexOf("/b")]);
		expect(source).not.toContain("routePath");
		expect(decodeGraphPayload(payload)).toEqual(graph);
	});

	test("search text hides comments and skips routes Rspress does not publish", async () => {
		const files = {
			"a.md": "Visible <!-- internal: hunter2 --> text %% secret %%\n",
			"private.md": "---\npublish: false\n---\nPrivate body\n",
		};
		const root = await writeTree(files);
		// The markdown plugin removed the private page's route before the build.
		const routes = routesFor(root, files).filter((route) => route.routePath !== "/private");
		const { graph, modules } = await build(routes, root);
		const everything = Object.values(modules).join("\n");
		expect(everything).toContain("Visible");
		expect(everything).not.toContain("hunter2");
		expect(everything).not.toContain("secret");
		expect(everything).not.toContain("Private body");
		expect(graph.nodes.map((node) => node.id)).toEqual(["/a"]);
	});

	test("an unchanged site reuses the modules without resolving or reading anything", async () => {
		const files = { "a.md": "[[b]]\n", "b.md": "x\n" };
		const root = await writeTree(files);
		const routes = routesFor(root, files);
		const state = {};
		const options = { docsRoot: root, base: "/", onUnresolvedLink: "ignore" as const };

		const first = await buildGraphModules(routes, state, options);
		const second = await buildGraphModules(routes, state, options);

		expect(first.diagnostics).toMatchObject({
			reusedModule: false,
			resolvedLinks: 1,
			filesRead: 2,
		});
		expect(second.diagnostics).toMatchObject({
			reusedModule: true,
			resolvedLinks: 0,
			filesRead: 0,
		});
		expect(second.modules).toBe(first.modules);
	});

	test("editing one note re-resolves the site but re-reads only that note", async () => {
		const files = { "a.md": "[[b]]\n", "b.md": "x\n", "c.md": "x\n" };
		const root = await writeTree(files);
		const routes = routesFor(root, files);
		const state = {};
		const options = { docsRoot: root, base: "/", onUnresolvedLink: "ignore" as const };
		await buildGraphModules(routes, state, options);

		// An explicit later mtime, so the index sees the edit without waiting on
		// the filesystem clock.
		const edited = path.join(root, "a.md");
		await writeFile(edited, "[[b]] [[c]]\n");
		const later = new Date(Date.now() + 10_000);
		await utimes(edited, later, later);
		const rebuilt = await buildGraphModules(routes, state, options);

		expect(rebuilt.diagnostics).toMatchObject({
			reusedModule: false,
			resolvedLinks: 2,
			filesRead: 1,
		});
		expect(edgesFrom(rebuilt.graphData, "/a")).toEqual(["/b", "/c"]);
	});
});
