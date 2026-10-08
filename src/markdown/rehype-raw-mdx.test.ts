import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import path from "node:path";
import { compile, nodeTypes } from "@mdx-js/mdx";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import type { Pluggable } from "unified";
import { VFile } from "vfile";
import { rehypeRawForMdx } from "./rehype-raw-mdx.ts";
import { remarkWikilink } from "./remark-wikilink.ts";
import type { NormalizedPluginOptions } from "./types.ts";

const root = path.resolve(process.cwd(), "test/markdown/fixtures/render-features");

const OPTIONS: NormalizedPluginOptions = {
	vaultRoot: undefined,
	vaultRoutePrefix: "/vault",
	onBrokenLink: "warn",
	onAmbiguousLink: "warn",
	enableFuzzyMatching: false,
	enableCaseInsensitiveLookup: true,
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
	enableTagLinking: true,
	enableCallouts: true,
	enableBacklinks: false,
	enableUnlinkedMentions: false,
	enableTransclusion: true,
	enableMediaEmbeds: true,
	enableTagPages: false,
	enableMath: true,
	mathEngine: "katex",
	enableMermaid: false,
	mermaidSecurityLevel: "strict",
	enableDefaultStyles: false,
	enableTasks: false,
	tasks: {},
	enableKanban: false,
	kanban: {},
	enableExcalidraw: false,
	excalidraw: {},
	enableBases: false,
	bases: {},
	enableTemplater: false,
	templater: {},
	onPluginError: "error",
};

/**
 * Compile a page the way Rspress does: MDX, remark-gfm, the plugin, and — for
 * `.md` pages only — Rspress's own `rehype-raw` before plugin rehype plugins.
 */
async function compileMdx(
	value: string,
	siteBase = "/",
	format: "md" | "mdx" = "mdx",
): Promise<string> {
	const file = new VFile({
		value,
		path: path.join(root, format === "md" ? "index.md" : "page.mdx"),
	});
	const result = await compile(file, {
		format,
		jsx: true,
		remarkPlugins: [
			remarkGfm,
			[remarkWikilink, { getDocsRoot: () => root, getSiteBase: () => siteBase, options: OPTIONS }],
		],
		rehypePlugins: [
			...(format === "md"
				? [[rehypeRaw, { passThrough: [...nodeTypes] }] satisfies Pluggable]
				: []),
			[rehypeRawForMdx, { getSiteBase: () => siteBase }],
		],
	});
	return String(result);
}

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
	warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe("rehypeRawForMdx", () => {
	test("an .mdx page with Obsidian constructs compiles", async () => {
		const output = await compileMdx(
			"A claim[^1] and ==**marked**== $a*b$ text.\n\n> [!tip] Title\n> Body\n\n[^1]: Source.",
		);
		expect(output).toContain("<_components.mark><_components.strong>");
		expect(output).toContain('className="footnote-ref"');
		expect(output).toContain('className="callout callout-tip"');
		expect(output).toContain('className="obsidian-math"');
	});

	test("prefixes the site base on a media embed of an .mdx page", async () => {
		const output = await compileMdx("![[song.mp3]]", "/repo/");
		expect(output).toContain('src="/repo/attachments/song.mp3"');
	});

	test("prefixes the site base on raw media an .md note writes itself", async () => {
		const output = await compileMdx(
			'<video controls src="/clip.mp4"><source src="/clip.webm" /></video>\n',
			"/repo/",
			"md",
		);
		expect(output).toContain('src="/repo/clip.mp4"');
		expect(output).toContain('src="/repo/clip.webm"');
	});
});
