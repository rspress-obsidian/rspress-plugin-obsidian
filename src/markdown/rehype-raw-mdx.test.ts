import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import path from "node:path";
import { compile, evaluate, nodeTypes } from "@mdx-js/mdx";
import { createElement } from "react";
import * as runtime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import rehypeRaw from "rehype-raw";
import remarkGfm from "remark-gfm";
import type { Pluggable } from "unified";
import { VFile } from "vfile";
import { renderMathHtml } from "../math.ts";
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
		// The formula is one element holding KaTeX's markup as a string. Compiled
		// element by element it would be dozens of JSX nodes per formula, which is
		// most of the build time of a math-heavy vault.
		expect(output).toContain(
			'<_components.span className="obsidian-math" dangerouslySetInnerHTML={{',
		);
		expect(output).toContain("katex");
		expect(output).not.toContain('className="katex"');
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

describe("math as one element", () => {
	/**
	 * Evaluate a page as Rspress compiles it and render it, so what is compared
	 * is the HTML a reader's browser receives.
	 */
	async function renderPage(value: string, format: "md" | "mdx"): Promise<string> {
		const file = new VFile({
			value,
			path: path.join(root, format === "md" ? "index.md" : "page.mdx"),
		});
		const { default: Content } = await evaluate(file, {
			...runtime,
			format,
			remarkPlugins: [
				remarkGfm,
				[remarkWikilink, { getDocsRoot: () => root, getSiteBase: () => "/", options: OPTIONS }],
			],
			rehypePlugins: [
				...(format === "md"
					? [[rehypeRaw, { passThrough: [...nodeTypes] }] satisfies Pluggable]
					: []),
				[rehypeRawForMdx, { getSiteBase: () => "/" }],
			],
		});
		return renderToStaticMarkup(createElement(Content));
	}

	// The markup travels through the compiled page as a string literal. A
	// character mishandled on the way would corrupt a formula without failing the
	// build. Each of these survives only if the round trip is exact.
	const FORMULAS = [
		"a < b",
		"a > b",
		"x \\& y",
		"\\text{a & b}",
		"\\text{&lt;b&gt;}",
		"\\text{<b>bold</b>}",
		"\\text{\"quoted\" and 'single'}",
		"\\frac{1}{2} + \\sqrt{x}",
		"a \\\\ b",
		"\u03b1 \u2192 \u03b2 \u2211",
	];

	for (const format of ["md", "mdx"] as const) {
		for (const tex of FORMULAS) {
			test(`${format}: $${tex}$ renders the engine's own markup`, async () => {
				if (format === "mdx" && /[<>]/.test(tex)) return; // MDX reads a bare `<` as JSX before math
				const html = await renderPage(`Before $${tex}$ after.\n`, format);
				expect(html).toBe(
					`<p>Before <span class="obsidian-math">${renderMathHtml(tex, false, "katex")}</span> after.</p>`,
				);
			});
		}
	}

	test("display math on its own lines is a block element", async () => {
		const html = await renderPage("$$\n\\frac{a}{b} < c\n$$\n", "md");
		expect(html).toBe(
			`<div class="obsidian-math-display">${renderMathHtml("\\frac{a}{b} < c", true, "katex")}</div>`,
		);
	});

	test("$$ inside a paragraph is an inline display element", async () => {
		const html = await renderPage("Text $$x^2$$ more.\n", "md");
		expect(html).toBe(
			`<p>Text <span class="obsidian-math-display">${renderMathHtml("x^2", true, "katex")}</span> more.</p>`,
		);
	});
});
