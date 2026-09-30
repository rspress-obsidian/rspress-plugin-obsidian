import { afterEach, describe, expect, test } from "bun:test";
import path from "node:path";
import { setCanvasRoutes } from "../shared/canvas-routes.js";
import { normalizeLookupValue } from "../shared/slug.js";
import { buildContentIndex } from "./content-index.ts";
import { parseWikiLink } from "./parse-wikilink.ts";
import { resolveWikiLink } from "./resolve-wikilink.ts";
import type {
	ContentAsset,
	ContentIndex,
	ContentPage,
	ParsedWikiLink,
	ResolveContext,
} from "./types.ts";

const basicRoot = path.resolve(process.cwd(), "test/markdown/fixtures/basic");
const compatRoot = path.resolve(process.cwd(), "test/markdown/fixtures/compatibility");
const assetsRoot = path.resolve(process.cwd(), "test/markdown/fixtures/assets");
const collisionRoot = path.resolve(process.cwd(), "test/markdown/fixtures/path-collisions");

/** Minimal in-memory page for branches the fixtures cannot express. */
function makePage(overrides: Partial<ContentPage> = {}): ContentPage {
	const filePathKey = overrides.filePathKey ?? "page";
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

function makeAsset(overrides: Partial<ContentAsset> & { pathKey: string }): ContentAsset {
	const { pathKey } = overrides;
	return {
		absolutePath: `/vault/${pathKey}`,
		relativePath: pathKey,
		baseName: pathKey.split("/").pop() ?? pathKey,
		urlPath: `/${pathKey}`,
		...overrides,
		pathKey,
	};
}

/** Build the same lookup tables `buildContentIndex` produces, by hand. */
function makeIndex(pages: ContentPage[], assets: ContentAsset[] = []): ContentIndex {
	const push = <T>(map: Map<string, T[]>, key: string, value: T): void => {
		const list = map.get(key) ?? [];
		list.push(value);
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

	const byAssetPath = new Map<string, ContentAsset>();
	const byAssetPathCI = new Map<string, ContentAsset[]>();
	const byAssetBaseName = new Map<string, ContentAsset[]>();
	const byAssetBaseNameCI = new Map<string, ContentAsset[]>();
	for (const asset of assets) {
		byAssetPath.set(asset.pathKey, asset);
		push(byAssetPathCI, asset.pathKey.toLowerCase(), asset);
		push(byAssetBaseName, asset.baseName, asset);
		push(byAssetBaseNameCI, asset.baseName.toLowerCase(), asset);
	}

	return {
		rootDir: "/vault",
		pages,
		assets,
		byAbsolutePath,
		byPathKey,
		byFilePathKey,
		byBaseName,
		byTitle,
		byAlias,
		byTag: new Map(),
		byAssetPath,
		byAssetBaseName,
		byPathKeyCI: new Map(),
		byFilePathKeyCI,
		byBaseNameCI,
		byAssetPathCI,
		byAssetBaseNameCI,
		backlinks: new Map(),
	};
}

function resolve(target: string, context: ResolveContext) {
	return resolveWikiLink(parseWikiLink(target, `[[${target}]]`), context);
}

describe("resolveWikiLink note-relative targets", () => {
	test("resolves a relative attachment by exact path", async () => {
		const index = await buildContentIndex(assetsRoot);
		const currentPage = index.byFilePathKey.get("index");
		if (!currentPage) throw new Error("fixture page missing");

		const result = resolve("./image.png", { currentPage: currentPage, index });

		expect(result.status).toBe("ok");
		expect(result.href).toBe("/image.png");
		expect(result.label).toBe("image.png");
	});

	test("reports a relative target that resolves to a directory", async () => {
		const index = await buildContentIndex(compatRoot);
		const currentPage = index.byFilePathKey.get("notes/current");
		if (!currentPage) throw new Error("fixture page missing");

		const result = resolve("./", { currentPage: currentPage, index });

		expect(result.status).toBe("broken-page");
		expect(result.message).toContain("Unable to resolve relative wikilink target");
		expect(result.message).toContain("notes/current.md");
	});

	test("reports an ambiguous case-insensitive relative page", () => {
		const current = makePage({ filePathKey: "notes/other" });
		const pageA = makePage({ filePathKey: "notes/Alpha" });
		const pageB = makePage({ filePathKey: "notes/alpha" });
		const index = makeIndex([current, pageA, pageB]);

		const result = resolve("../NOTES/ALPHA", {
			currentPage: current,
			index,
			options: { enableCaseInsensitiveLookup: true },
		});

		expect(result.status).toBe("ambiguous-page");
		expect(result.message).toContain("is ambiguous; use a more specific path instead.");
	});

	test("reports ambiguous case-insensitive relative attachments", () => {
		const current = makePage({ filePathKey: "notes/other" });
		const index = makeIndex(
			[current],
			[makeAsset({ pathKey: "dir/Pic.png" }), makeAsset({ pathKey: "dir/pIC.png" })],
		);

		const result = resolve("../dir/PIC.png", {
			currentPage: current,
			index,
			options: { enableCaseInsensitiveLookup: true },
		});

		expect(result.status).toBe("ambiguous-page");
		expect(result.message).toContain("matches multiple attachments; use a case-sensitive path.");
	});
});

describe("resolveWikiLink attachments", () => {
	test("resolves a path-qualified target to a unique attachment basename", async () => {
		const index = await buildContentIndex(assetsRoot);
		const currentPage = index.byFilePathKey.get("index");
		if (!currentPage) throw new Error("fixture page missing");

		const result = resolve("images/image.png", { currentPage: currentPage, index });

		expect(result.status).toBe("ok");
		expect(result.href).toBe("/image.png");
	});

	test("reports an ambiguous attachment basename", () => {
		const current = makePage({ filePathKey: "index" });
		const index = makeIndex(
			[current],
			[makeAsset({ pathKey: "a/pic.png" }), makeAsset({ pathKey: "b/pic.png" })],
		);

		const result = resolve("c/pic.png", { currentPage: current, index });

		expect(result.status).toBe("ambiguous-page");
		expect(result.message).toContain("matches multiple attachments; use a path-qualified link.");
	});

	test("reports ambiguous case-insensitive attachment paths", () => {
		const current = makePage({ filePathKey: "index" });
		const index = makeIndex(
			[current],
			[makeAsset({ pathKey: "Pic.png" }), makeAsset({ pathKey: "pic.png" })],
		);

		const result = resolve("PIC.PNG", {
			currentPage: current,
			index,
			options: { enableCaseInsensitiveLookup: true },
		});

		expect(result.status).toBe("ambiguous-page");
		expect(result.message).toContain("matches multiple attachments; use a case-sensitive path.");
	});
});

describe("resolveWikiLink case-insensitive and fuzzy fallbacks", () => {
	test("reports an ambiguous case-insensitive page path", () => {
		const current = makePage({ filePathKey: "index" });
		const pageA = makePage({ filePathKey: "notes/Alpha" });
		const pageB = makePage({ filePathKey: "notes/alpha" });
		const index = makeIndex([current, pageA, pageB]);

		const result = resolve("NOTES/ALPHA", {
			currentPage: current,
			index,
			options: { enableCaseInsensitiveLookup: true },
		});

		expect(result.status).toBe("ambiguous-page");
		expect(result.message).toContain("is ambiguous; use a more specific path instead.");
	});

	test("resolves a case-insensitive page path to a single match", () => {
		const current = makePage({ filePathKey: "index" });
		const page = makePage({ filePathKey: "notes/Alpha" });
		const index = makeIndex([current, page]);

		const result = resolve("NOTES/ALPHA", {
			currentPage: current,
			index,
			options: { enableCaseInsensitiveLookup: true },
		});

		expect(result.status).toBe("ok");
		expect(result.href).toBe("/notes/Alpha");
	});

	test("resolves a case-insensitive basename to a single match", () => {
		const current = makePage({ filePathKey: "index" });
		const page = makePage({ filePathKey: "notes/Alpha" });
		const index = makeIndex([current, page]);

		const result = resolve("ALPHA", {
			currentPage: current,
			index,
			options: { enableCaseInsensitiveLookup: true },
		});

		expect(result.status).toBe("ok");
		expect(result.href).toBe("/notes/Alpha");
	});

	test("reports an ambiguous fuzzy target when shortest suffixes tie", () => {
		const current = makePage({ filePathKey: "index" });
		const pageA = makePage({ filePathKey: "a/note", baseName: "a-note" });
		const pageB = makePage({ filePathKey: "b/note", baseName: "b-note" });
		const index = makeIndex([current, pageA, pageB]);

		const result = resolve("note", {
			currentPage: current,
			index,
			options: { enableFuzzyMatching: true },
		});

		expect(result.status).toBe("ambiguous-page");
		expect(result.message).toContain("Fuzzy wikilink target");
		expect(result.message).toContain("matched multiple pages");
	});

	test("falls back to broken-page when fuzzy matching finds nothing", () => {
		const current = makePage({ filePathKey: "index" });
		const index = makeIndex([current, makePage({ filePathKey: "guide/page" })]);

		const result = resolve("zzz", {
			currentPage: current,
			index,
			options: { enableFuzzyMatching: true },
		});

		expect(result.status).toBe("broken-page");
		expect(result.message).toBe('Unable to resolve wikilink target "zzz".');
	});
});

describe("resolveWikiLink vault search", () => {
	test("reports a vault search that matches nothing", async () => {
		const index = await buildContentIndex(basicRoot);
		const currentPage = index.byFilePathKey.get("index");
		if (!currentPage) throw new Error("fixture page missing");

		const result = resolve("## not-a-heading-anywhere", { currentPage: currentPage, index });

		expect(result.status).toBe("broken-page");
		expect(result.message).toContain('Vault search target "not-a-heading-anywhere" did not match');
	});

	test("reports a vault search that matches several headings", async () => {
		const index = await buildContentIndex(basicRoot);
		const currentPage = index.byFilePathKey.get("index");
		if (!currentPage) throw new Error("fixture page missing");

		const result = resolve("## advanced", { currentPage: currentPage, index });

		expect(result.status).toBe("ambiguous-page");
		expect(result.message).toContain('Vault search target "advanced" matched multiple heading');
	});

	test("reports an empty vault search query", async () => {
		const index = await buildContentIndex(basicRoot);
		const currentPage = index.byFilePathKey.get("index");
		if (!currentPage) throw new Error("fixture page missing");

		const result = resolve("##", { currentPage: currentPage, index });

		expect(result.status).toBe("broken-page");
		expect(result.message).toBe("Vault search target is empty in [[##]].");
	});
});

describe("resolveWikiLink current-page references", () => {
	test("reports a missing current-page anchor with the available headings", async () => {
		const index = await buildContentIndex(basicRoot);
		const currentPage = index.byFilePathKey.get("index");
		if (!currentPage) throw new Error("fixture page missing");

		const result = resolve("#Missing", { currentPage: currentPage, index });

		expect(result.status).toBe("broken-anchor");
		expect(result.message).toContain('Unable to resolve anchor "Missing"');
		expect(result.message).toContain("Available headings: Home");
	});

	test("reports a missing current-page block reference", async () => {
		const index = await buildContentIndex(basicRoot);
		const currentPage = index.byFilePathKey.get("index");
		if (!currentPage) throw new Error("fixture page missing");

		const result = resolve("#^missing-block", { currentPage: currentPage, index });

		expect(result.status).toBe("broken-anchor");
		expect(result.message).toContain('Unable to resolve block reference "^missing-block"');
		expect(result.message).toContain("No blocks found on this page.");
	});

	test("reports an empty current-page anchor value", async () => {
		const index = await buildContentIndex(basicRoot);
		const currentPage = index.byFilePathKey.get("index");
		if (!currentPage) throw new Error("fixture page missing");

		const parsed: ParsedWikiLink = {
			raw: "[[#]]",
			target: "",
			isEmbed: false,
			subpath: { kind: "heading", value: "" },
			isCurrentPageReference: true,
		};

		const result = resolveWikiLink(parsed, { currentPage: currentPage, index });

		expect(result.status).toBe("broken-anchor");
		expect(result.message).toBe("Missing current-page anchor target.");
	});
});

describe("resolveWikiLink heading fallbacks", () => {
	test("resolves a heading by emoji-preserving slug prefix", async () => {
		const index = await buildContentIndex(compatRoot);
		const currentPage = index.byFilePathKey.get("index");
		if (!currentPage) throw new Error("fixture page missing");

		const result = resolve("shared/Concept#Punctuation", { currentPage: currentPage, index });

		expect(result.status).toBe("ok");
		expect(result.href).toBe("/shared/Concept#punctuation-ab--c");
		expect(result.label).toBe("Punctuation");
	});

	test("resolves a heading by case-insensitive substring", async () => {
		const index = await buildContentIndex(compatRoot);
		const currentPage = index.byFilePathKey.get("index");
		if (!currentPage) throw new Error("fixture page missing");

		const result = resolve("shared/Concept#A/B", { currentPage: currentPage, index });

		expect(result.status).toBe("ok");
		expect(result.href).toBe("/shared/Concept#punctuation-ab--c");
	});

	test("uses the raw target as label when the page has no filename", () => {
		const page = makePage({ filePathKey: "odd", baseName: "" });
		const index = makeIndex([page]);

		const result = resolve("odd", { currentPage: makePage({ filePathKey: "index" }), index });

		expect(result.status).toBe("ok");
		expect(result.label).toBe("odd");
	});
});

describe("resolveWikiLink folder index paths", () => {
	test("distinguishes a flat file from its folder index", async () => {
		const index = await buildContentIndex(collisionRoot);
		const currentPage = index.byFilePathKey.get("index");
		if (!currentPage) throw new Error("fixture page missing");

		const flat = resolve("foo", { currentPage: currentPage, index });
		const folder = resolve("foo/index", { currentPage: currentPage, index });

		// `foo.md` publishes at foo.html; the folder index publishes at
		// foo/index.html, so its href keeps the trailing slash that makes Rspress
		// (and a file-mapping host) resolve it.
		expect(flat.href).toBe("/foo");
		expect(folder.href).toBe("/foo/");
	});
});

/**
 * macOS stores filenames decomposed (NFD) while a note's text is usually
 * composed (NFC). The index folds its keys to NFC, so every lookup here has to
 * fold the raw target the same way or nothing ever matches on macOS. Linux can
 * write either spelling, which is what makes this testable off-platform.
 */
describe("resolveWikiLink Unicode normalization", () => {
	const NFD_CAFE = "cafe\u0301";
	const NFC_CAFE = "caf\u00e9";

	test("resolves a decomposed wikilink against a composed path key", () => {
		const target = makePage({ filePathKey: `notes/${NFC_CAFE}` });
		const current = makePage({ filePathKey: "index" });
		const index = makeIndex([target, current]);

		const result = resolve(`notes/${NFD_CAFE}`, { currentPage: current, index });

		expect(result.status).toBe("ok");
		// The href is percent-encoded; the page route it comes from is not.
		expect(result.href).toBe(`/notes/${encodeURIComponent(NFC_CAFE)}`);
	});

	test("resolves a decomposed wikilink against a composed basename", () => {
		const target = makePage({ filePathKey: `notes/${NFC_CAFE}` });
		const current = makePage({ filePathKey: "index" });
		const index = makeIndex([target, current]);

		const result = resolve(NFD_CAFE, { currentPage: current, index });

		expect(result.status).toBe("ok");
		expect(result.href).toBe(`/notes/${encodeURIComponent(NFC_CAFE)}`);
	});

	test("resolves a decomposed wikilink against a composed title", () => {
		const target = makePage({ filePathKey: "notes/other", title: NFC_CAFE });
		const current = makePage({ filePathKey: "index" });
		const index = makeIndex([target, current]);

		const result = resolve(NFD_CAFE, { currentPage: current, index });

		expect(result.status).toBe("ok");
		expect(result.href).toBe("/notes/other");
	});
});

describe("resolveWikiLink canvas boards", () => {
	afterEach(() => {
		setCanvasRoutes([]);
	});

	function canvasFixture() {
		const currentPage = makePage({ filePathKey: "index" });
		const board = makeAsset({
			pathKey: "Demo.canvas",
			relativePath: "Demo.canvas",
			baseName: "Demo.canvas",
			urlPath: "/vault/Demo.canvas",
		});
		return { currentPage, index: makeIndex([currentPage], [board]) };
	}

	test("links a published board to its viewer route instead of the raw file", () => {
		setCanvasRoutes([
			{ absolutePath: "/vault/Demo.canvas", routePath: "/canvas/demo", source: "Demo.canvas" },
		]);
		const { currentPage, index } = canvasFixture();

		const result = resolve("Demo.canvas", { currentPage, index });

		expect(result.status).toBe("ok");
		expect(result.href).toBe("/canvas/demo");
		expect(result.label).toBe("Demo");
		expect(result.canvasSrc).toBe("Demo.canvas");
	});

	test("keeps an alias as the label and still marks the canvas source", () => {
		setCanvasRoutes([
			{ absolutePath: "/vault/Demo.canvas", routePath: "/canvas/demo", source: "Demo.canvas" },
		]);
		const { currentPage, index } = canvasFixture();

		const result = resolve("Demo.canvas|My board", { currentPage, index });

		expect(result.status).toBe("ok");
		expect(result.href).toBe("/canvas/demo");
		expect(result.label).toBe("My board");
		expect(result.canvasSrc).toBe("Demo.canvas");
	});

	test("drops a heading subpath on a board link", () => {
		setCanvasRoutes([
			{ absolutePath: "/vault/Demo.canvas", routePath: "/canvas/demo", source: "Demo.canvas" },
		]);
		const { currentPage, index } = canvasFixture();

		const result = resolve("Demo.canvas#Heading", { currentPage, index });

		expect(result.status).toBe("ok");
		expect(result.href).toBe("/canvas/demo");
	});

	test("resolves a board for a page whose index never contains vault files", () => {
		// A docs page resolves against the docs index: no vault asset, but
		// stray same-name `.canvas` copies under the docs tree that make the
		// basename fan-out report ambiguity (the embed.mdx build failure).
		const currentPage = makePage({ filePathKey: "canvas/guide/embed" });
		const strays = [
			makeAsset({ pathKey: "public/vault/Demo.canvas", relativePath: "public/vault/Demo.canvas" }),
			makeAsset({
				pathKey: "public/vault-assets/Demo.canvas",
				relativePath: "public/vault-assets/Demo.canvas",
			}),
		];
		const index = makeIndex([currentPage], strays);

		expect(resolve("Demo.canvas", { currentPage, index }).status).toBe("ambiguous-page");

		setCanvasRoutes([
			{ absolutePath: "/vault/Demo.canvas", routePath: "/canvas/demo", source: "Demo.canvas" },
		]);
		const result = resolve("Demo.canvas", { currentPage, index });
		expect(result.status).toBe("ok");
		expect(result.href).toBe("/canvas/demo");
		expect(result.label).toBe("Demo");
		expect(result.canvasSrc).toBe("Demo.canvas");
	});

	test("keeps the raw attachment href while the board is unpublished", () => {
		const { currentPage, index } = canvasFixture();

		const result = resolve("Demo.canvas", { currentPage, index });

		expect(result.status).toBe("ok");
		expect(result.href).toBe("/vault/Demo.canvas");
		expect(result.label).toBe("Demo.canvas");
		expect(result.canvasSrc).toBeUndefined();
	});
});
