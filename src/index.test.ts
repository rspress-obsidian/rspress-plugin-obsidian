// The umbrella entry is what `rspress-plugin-obsidian` resolves to, so this file
// is the only place the composition contract and the re-export surface are
// exercised as a consumer meets them: `rspress.config.ts` imports
// `pluginObsidian` from here, and user code imports the helpers from here.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import * as umbrella from "./index.ts";
import * as markdownEntry from "./markdown/index.ts";

const {
	buildContentIndex,
	encodeTagPathSegment,
	findWikilinkMatches,
	generateTagPages,
	parseWikiLink,
	pluginObsidian,
	resolveWikiLink,
} = umbrella;

const basicRoot = path.resolve(import.meta.dir, "..", "test/markdown/fixtures/basic");
const tagsRoot = path.resolve(import.meta.dir, "..", "test/markdown/fixtures/tags");

/** A plugin object as the options are handed to Rspress, read loosely. */
const fields = (plugin: unknown): Record<string, unknown> => plugin as Record<string, unknown>;

describe("pluginObsidian", () => {
	test("composes the three feature plugins in the order the builder returns them", () => {
		const plugins = pluginObsidian((markdown, canvas, graphview) => [
			markdown({ vaultRoot: "/vault" }),
			canvas({ vaultRoot: "/vault", fileRoutePrefix: "/vault" }),
			graphview({ defaultOpen: true }),
		]);

		expect(plugins.map((plugin) => plugin.name)).toEqual([
			"rspress-plugin-obsidian:markdown",
			"rspress-plugin-obsidian:canvas",
			"rspress-plugin-obsidian:graph",
		]);
	});

	test("returns exactly the plugins the builder builds, so a consumer can compose a subset", () => {
		expect(pluginObsidian(() => [])).toEqual([]);
		expect(
			pluginObsidian((_markdown, canvas) => [
				canvas({ vaultRoot: "/vault", fileRoutePrefix: "/vault" }),
			]).map((plugin) => plugin.name),
		).toEqual(["rspress-plugin-obsidian:canvas"]);
	});

	test("hands the builder factories that honour the options passed to them", () => {
		const [markdownPlugin, graph] = pluginObsidian((markdown, _canvas, graphview) => [
			markdown({ vaultRoot: "/vault", enableMermaid: true }),
			graphview({ enableDefaultStyles: true }),
		]);
		const [plainMarkdown] = pluginObsidian((markdown) => [markdown({ vaultRoot: "/vault" })]);

		// `enableMermaid` is what registers the client component drawing the
		// placeholders; `enableDefaultStyles` is what ships the panel stylesheet.
		// Both reach Rspress as paths, so the assertion is that each option
		// produced one and that it names a file Rspress can load.
		const uiComponents = fields(markdownPlugin).globalUIComponents as [string, object][];
		expect(uiComponents).toHaveLength(1);
		expect(existsSync(uiComponents[0]?.[0] ?? "")).toBe(true);
		expect(fields(plainMarkdown).globalUIComponents).toBeUndefined();
		const stylesheet = fields(graph).globalStyles as string;
		expect(existsSync(stylesheet)).toBe(true);
		expect(stylesheet).toEndWith(".css");
	});
});

describe("root entry re-exports", () => {
	test("finds and parses the wikilinks a note contains", () => {
		const matches = findWikilinkMatches("See [[Note|Alias]] and ![[Embed.png]]");
		expect(matches.map((match) => match.fullMatch)).toEqual(["[[Note|Alias]]", "![[Embed.png]]"]);

		expect(parseWikiLink(matches[0]?.inner ?? "", matches[0]?.fullMatch ?? "")).toMatchObject({
			target: "Note",
			alias: "Alias",
			isEmbed: false,
		});
		expect(parseWikiLink(matches[1]?.inner ?? "", matches[1]?.fullMatch ?? "")).toMatchObject({
			target: "Embed.png",
			isEmbed: true,
		});
	});

	test("resolves a wikilink against a real content index", async () => {
		const index = await buildContentIndex(basicRoot);
		const currentPage = index.byFilePathKey.get("index");
		if (!currentPage) throw new Error("fixture page missing");

		const parsed = parseWikiLink(
			"guide/getting-started#Install",
			"[[guide/getting-started#Install|Install guide]]",
		);
		const resolved = resolveWikiLink(parsed, { currentPage, index });

		expect(resolved.status).toBe("ok");
		// Obsidian's display text for an unaliased heading link: the link text
		// as written, with `#` shown as ` > `.
		expect(resolved.label).toBe("guide/getting-started > Install");
		expect(resolved.href).toContain("getting-started");
		expect(resolved.targetPage?.relativePath).toBe("guide/getting-started.md");
	});

	test("generates one tag page per tag, listing the pages that carry it", async () => {
		const pages = generateTagPages(await buildContentIndex(tagsRoot));

		expect(pages.map((page) => page.routePath).sort()).toEqual([
			"/tags/obsidian",
			"/tags/tutorial",
		]);
		expect(pages.find((page) => page.routePath === "/tags/tutorial")?.content).toContain(
			"# \\#tutorial",
		);
		expect(pages.find((page) => page.routePath === "/tags/obsidian")?.content).toContain(
			"Tagged Guide",
		);
	});

	test("encodes a tag into a path segment that survives a URL", () => {
		expect(encodeTagPathSegment("daily note")).toBe("daily%20note");
		expect(encodeTagPathSegment("#todo")).toBe("%23todo");
		expect(encodeTagPathSegment("C++")).toBe("C++");
	});

	test("re-exports every runtime helper the /markdown entry exports", () => {
		// `docs/markdown/guide/api.md` documents the API as exported from
		// `rspress-plugin-obsidian`, and the package ships `/markdown` as a
		// subpath — a helper added to one entry and not the other silently
		// breaks that promise for whichever side missed it.
		const missing = Object.keys(markdownEntry).filter((key) => !(key in umbrella));
		expect(missing).toEqual([]);
	});
});
