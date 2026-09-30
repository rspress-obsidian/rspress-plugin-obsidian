import { describe, expect, spyOn, test } from "bun:test";
import path from "node:path";
import { setCanvasRoutes } from "../../shared/canvas-routes.js";
import type { ScannedRouteDocument } from "./cache";
import { buildGraphData } from "./graph-builder";
import type { CollectedRoute } from "./types";

// Fixtures must use platform-absolute paths. The resolver does
// `path.resolve(path.dirname(sourceAbsolutePath), rawLink)`, so a POSIX-looking
// `/docs/guide.md` is absolute on Linux but merely root-relative on Windows,
// where `path.resolve` anchors it to the CWD while the alias keys stay
// root-relative — and every relative link in this file silently stopped
// resolving there.
const DOCS_ROOT = path.resolve(process.cwd(), "docs");

function makeRoute(
	routePath: string,
	absolutePath: string,
	pageName = routePath.slice(1) || "index",
): CollectedRoute {
	const absolute = path.resolve(DOCS_ROOT, absolutePath);
	return {
		routePath,
		absolutePath: absolute,
		relativePath: path.relative(DOCS_ROOT, absolute).replace(/\\/g, "/"),
		pageName,
	};
}

function makeScannedDocument(
	route: CollectedRoute,
	rawLinks: string[],
	inferredTitle?: string,
	names: string[] = [],
): ScannedRouteDocument {
	return {
		route,
		mtimeMs: 1000,
		size: 100,
		contentHash: "abc123",
		inferredTitle,
		names,
		rawLinks,
	};
}

describe("buildGraphData", () => {
	test("resolves relative, extensionless, mdx, index, and absolute links", () => {
		const home = makeRoute("/", "/docs/index.md");
		const guide = makeRoute("/guide", "/docs/guide/index.md", "guide/index");
		const install = makeRoute("/guide/install", "/docs/guide/install.mdx", "guide/install");
		const api = makeRoute("/api", "/docs/api.mdx", "api");

		const graphData = buildGraphData(
			[home, guide, install, api],
			[
				makeScannedDocument(home, ["./guide", "./api.mdx"]),
				makeScannedDocument(guide, ["./install", "../api.mdx", "/index.md"]),
				makeScannedDocument(install, ["../index.md"]),
				makeScannedDocument(api, []),
			],
		);

		expect(graphData.links).toEqual([
			{ source: "/", target: "/guide" },
			{ source: "/", target: "/api" },
			{ source: "/guide", target: "/guide/install" },
			{ source: "/guide", target: "/api" },
			{ source: "/guide", target: "/" },
			{ source: "/guide/install", target: "/" },
		]);
	});

	test("skips broken links and deduplicates repeated links per route", () => {
		const source = makeRoute("/source", "/docs/source.md");
		const target = makeRoute("/target", "/docs/target.md");

		const graphData = buildGraphData(
			[source, target],
			[
				makeScannedDocument(source, ["./target.md", "./target", "/target/", "./missing.md"]),
				makeScannedDocument(target, []),
			],
		);

		expect(graphData.links).toEqual([{ source: "/source", target: "/target" }]);
	});

	test("uses inferred titles first, then home and page name fallbacks", () => {
		const home = makeRoute("/", "/docs/index.md", "index");
		const titled = makeRoute("/custom", "/docs/custom.md", "custom-page");
		const fallback = makeRoute("/fallback", "/docs/fallback.md", "fallback-page");

		const graphData = buildGraphData(
			[home, titled, fallback],
			[
				makeScannedDocument(home, []),
				makeScannedDocument(titled, [], "Custom Title"),
				makeScannedDocument(fallback, []),
			],
		);

		expect(graphData.nodes.map((node) => [node.id, node.label])).toEqual([
			["/", "Home"],
			["/custom", "Custom Title"],
			["/fallback", "fallback-page"],
		]);
	});

	test("reports unresolved internal links without failing the build", () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		const home = makeRoute("/", "/docs/index.md");
		const guide = makeRoute("/guide", "/docs/guide.md");

		const graphData = buildGraphData(
			[home, guide],
			[
				makeScannedDocument(home, ["./guide.md", "./missing.md", "./also-missing.md"]),
				makeScannedDocument(guide, []),
			],
		);

		expect(graphData.links).toEqual([{ source: "/", target: "/guide" }]);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		const message = warnSpy.mock.calls[0]?.[0] as string;
		expect(message).toContain("1 page(s)");
		expect(message).toContain("./missing.md");
		expect(message).toContain("./also-missing.md");
		expect(message).not.toContain("./guide.md");
		warnSpy.mockRestore();
	});

	test("stays quiet about unresolved links when the site says to ignore them", () => {
		// A site that documents unresolved links on purpose, or that has already
		// told the markdown plugin what it wants to hear about, sets this.
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		const home = makeRoute("/", "/docs/index.md");
		const guide = makeRoute("/guide", "/docs/guide.md");

		const graphData = buildGraphData(
			[home, guide],
			[makeScannedDocument(home, ["./guide.md", "./missing.md"]), makeScannedDocument(guide, [])],
			"ignore",
		);

		// The graph itself is unchanged: the resolvable link is still an edge.
		expect(graphData.links).toEqual([{ source: "/", target: "/guide" }]);
		expect(warnSpy).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	test("fails the build on an unresolved link when the site asks it to", () => {
		const home = makeRoute("/", "/docs/index.md");
		const guide = makeRoute("/guide", "/docs/guide.md");

		expect(() =>
			buildGraphData(
				[home, guide],
				[makeScannedDocument(home, ["./guide.md", "./missing.md"]), makeScannedDocument(guide, [])],
				"error",
			),
		).toThrow(/1 page\(s\) reference 1 unresolved internal link/);
	});

	test("normalizes trailing slashes so index pages cannot collide with the root", () => {
		const root = makeRoute("/", "/docs/index.md");
		const nestedIndex = makeRoute("/guide", "/docs/guide/index.md");

		const graphData = buildGraphData(
			[root, nestedIndex],
			[makeScannedDocument(root, ["/guide/"]), makeScannedDocument(nestedIndex, ["/"])],
		);

		expect(graphData.nodes.map((node) => node.id)).toEqual(["/", "/guide"]);
		expect(graphData.links).toEqual([
			{ source: "/", target: "/guide" },
			{ source: "/guide", target: "/" },
		]);
	});

	test("resolves a canvas link through the published board registry without warning", () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		const home = makeRoute("/", "/docs/index.md");
		// The canvas feature hands Rspress a temp file as the route's path, so
		// file matching can never find this board — only the registry can.
		const board = makeRoute("/canvas/demo", "/tmp/rspress-canvas-1/Demo.canvas", "Demo.canvas");
		setCanvasRoutes([
			{ absolutePath: "/vault/Demo.canvas", routePath: "/canvas/demo", source: "Demo.canvas" },
		]);

		try {
			const graphData = buildGraphData(
				[home, board],
				[
					makeScannedDocument(home, ["Demo.canvas", "./missing.md"]),
					makeScannedDocument(board, []),
				],
			);

			expect(graphData.links).toEqual([{ source: "/", target: "/canvas/demo" }]);
			expect(warnSpy).toHaveBeenCalledTimes(1);
			const message = warnSpy.mock.calls[0]?.[0] as string;
			expect(message).toContain("./missing.md");
			expect(message).not.toContain("Demo.canvas");
		} finally {
			setCanvasRoutes([]);
			warnSpy.mockRestore();
		}
	});
});

describe("basename resolution", () => {
	test("resolves a bare wikilink target the way Obsidian does", () => {
		const intro = makeRoute("/vault/guide/intro", "/vault/guide/intro.md");
		const welcome = makeRoute("/vault/Welcome", "/vault/Welcome.md");
		const setup = makeRoute("/vault/guide/Setup Guide", "/vault/guide/Setup Guide.md");

		const graphData = buildGraphData(
			[intro, welcome, setup],
			[makeScannedDocument(intro, ["Welcome", "Setup Guide#Install", "setup guide"])],
		);

		// Case-insensitive, fragment stripped, and resolved from anywhere in the
		// tree — a vault link rarely spells out the path.
		expect(graphData.links).toEqual([
			{ source: "/vault/guide/intro", target: "/vault/Welcome" },
			{ source: "/vault/guide/intro", target: "/vault/guide/Setup Guide" },
		]);
	});

	test("leaves an ambiguous basename unresolved", () => {
		const source = makeRoute("/source", "/docs/source.md");
		const first = makeRoute("/a/note", "/docs/a/note.md");
		const second = makeRoute("/b/note", "/docs/b/note.md");

		const graphData = buildGraphData(
			[source, first, second],
			[makeScannedDocument(source, ["note"])],
		);

		expect(graphData.links).toEqual([]);
	});

	test("does not basename-resolve an explicitly relative target", () => {
		const source = makeRoute("/source", "/docs/source.md");
		const elsewhere = makeRoute("/elsewhere/target", "/docs/elsewhere/target.md");

		const graphData = buildGraphData(
			[source, elsewhere],
			[makeScannedDocument(source, ["./target.md", "../target.md"])],
		);

		// The markdown pipeline resolves `./…` against the source file and reports
		// a miss as broken, so the graph must not invent an edge for it.
		expect(graphData.links).toEqual([]);
	});

	test("leaves a genuinely missing target unresolved", () => {
		const source = makeRoute("/source", "/docs/source.md");
		const elsewhere = makeRoute("/elsewhere/target", "/docs/elsewhere/target.md");

		const graphData = buildGraphData(
			[source, elsewhere],
			[makeScannedDocument(source, ["./missing.md", "/target.md"])],
		);

		expect(graphData.links).toEqual([]);
	});
});

describe("case-insensitive path resolution", () => {
	test("resolves a relative link whose case differs from the file on disk", () => {
		// `[x](../Guide/Note.md)` renders on the page — the markdown resolver's
		// `byFilePathKeyCI` is on by default — so the graph must produce the edge.
		const source = makeRoute("/source", "/docs/source.md");
		const note = makeRoute("/guide/note", "/docs/guide/note.md");

		const graphData = buildGraphData(
			[source, note],
			[makeScannedDocument(source, ["./Guide/Note.md", "./guide/NOTE"])],
		);

		expect(graphData.links).toEqual([{ source: "/source", target: "/guide/note" }]);
	});

	test("leaves a case-only ambiguous relative link unresolved", () => {
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		const source = makeRoute("/source", "/docs/source.md");
		const lower = makeRoute("/guide/note", "/docs/guide/note.md");
		const upper = makeRoute("/guide/Note", "/docs/guide/Note.md");

		const graphData = buildGraphData(
			[source, lower, upper],
			[makeScannedDocument(source, ["./guide/NOTE.md"])],
		);

		// Two files differ only in case, so the fallback cannot choose — the link
		// stays unresolved and reports, exactly like the resolver's ambiguity.
		expect(graphData.links).toEqual([]);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		warnSpy.mockRestore();
	});
});

describe("tag targets", () => {
	test("drops a tag target with no tag route instead of warning", () => {
		// Tag routes exist only with `enableTagPages`; a graphview()-only install
		// must not warn on every tag in the vault.
		const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
		const home = makeRoute("/", "/docs/index.md");

		const graphData = buildGraphData([home], [makeScannedDocument(home, ["/tags/project/ideas"])]);

		expect(graphData.links).toEqual([]);
		expect(warnSpy).not.toHaveBeenCalled();
		warnSpy.mockRestore();
	});

	test("links a tag target that resolves to a generated tag page", () => {
		const home = makeRoute("/", "/docs/index.md");
		const tagPage = makeRoute(
			"/tags/project/ideas",
			"/docs/tags/project/ideas.md",
			"tags/project/ideas",
		);

		const graphData = buildGraphData(
			[home, tagPage],
			[makeScannedDocument(home, ["/tags/project/ideas"]), makeScannedDocument(tagPage, [])],
		);

		expect(graphData.links).toEqual([{ source: "/", target: "/tags/project/ideas" }]);
	});
});

describe("frontmatter name resolution", () => {
	test("resolves a link that names a page by frontmatter title or alias", () => {
		const source = makeRoute("/source", "/docs/source.md");
		const titled = makeRoute("/notes/short", "/docs/notes/short.md");

		const graphData = buildGraphData(
			[source, titled],
			[
				makeScannedDocument(source, ["My Long Title", "alt name"]),
				makeScannedDocument(titled, [], "My Long Title", ["My Long Title", "Alt Name"]),
			],
		);

		// Both names resolve to the same page, so the second link deduplicates.
		expect(graphData.links).toEqual([{ source: "/source", target: "/notes/short" }]);
	});

	test("leaves a name claimed by several pages unresolved", () => {
		const source = makeRoute("/source", "/docs/source.md");
		const first = makeRoute("/a", "/docs/a.md");
		const second = makeRoute("/b", "/docs/b.md");

		const graphData = buildGraphData(
			[source, first, second],
			[
				makeScannedDocument(source, ["Shared Name"]),
				makeScannedDocument(first, [], undefined, ["Shared Name"]),
				makeScannedDocument(second, [], undefined, ["Shared Name"]),
			],
		);

		expect(graphData.links).toEqual([]);
	});

	test("resolves a path before a same-named page elsewhere", () => {
		const source = makeRoute("/source", "/docs/source.md");
		const exact = makeRoute("/elsewhere", "/docs/elsewhere.md");
		const named = makeRoute("/named", "/docs/named.md");

		const graphData = buildGraphData(
			[source, exact, named],
			[
				makeScannedDocument(source, ["elsewhere"]),
				makeScannedDocument(exact, []),
				makeScannedDocument(named, [], undefined, ["elsewhere"]),
			],
		);

		expect(graphData.links).toEqual([{ source: "/source", target: "/elsewhere" }]);
	});
});
