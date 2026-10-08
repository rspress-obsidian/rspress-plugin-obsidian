/**
 * Obsidian rendering behaviour, compiled to HTML the way a Rspress page is:
 * remark-gfm, then (where it matters) Rspress's own remark plugins, then this
 * plugin's pass, then remark-rehype.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import path from "node:path";
import { remarkContainerSyntax } from "@rspress/core/dist/node/mdx/remarkPlugins/containerSyntax.js";
import { remarkImage } from "@rspress/core/dist/node/mdx/remarkPlugins/image.js";
import type { Root } from "mdast";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { type PluggableList, unified } from "unified";
import { visit } from "unist-util-visit";
import { VFile } from "vfile";
import { isPluginOwnedImageUrl } from "./media.ts";
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

interface RenderOptions extends Partial<NormalizedPluginOptions> {
	page?: string;
	siteBase?: string;
	/** Remark plugins Rspress runs before plugin passes. */
	before?: PluggableList;
}

function processorFor({ page, siteBase, before = [], ...overrides }: RenderOptions = {}) {
	return unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(before)
		.use(remarkWikilink, {
			getDocsRoot: () => root,
			getSiteBase: () => siteBase ?? "/",
			options: { ...OPTIONS, ...overrides },
		});
}

async function render(
	value: string,
	options: RenderOptions = {},
): Promise<{ html: string; file: VFile }> {
	const file = new VFile({ value, path: path.join(root, options.page ?? "index.md") });
	const processor = processorFor(options)
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(rehypeStringify, { allowDangerousHtml: true });
	const result = await processor.process(file);
	return { html: String(result), file: result };
}

async function html(value: string, options: RenderOptions = {}): Promise<string> {
	return (await render(value, options)).html;
}

/** Run the remark half only and return the tree (for MDX-shaped output). */
async function tree(
	value: string,
	options: RenderOptions = {},
): Promise<{ tree: Root; file: VFile }> {
	const file = new VFile({ value, path: path.join(root, options.page ?? "index.md") });
	const processor = processorFor(options);
	const result = (await processor.run(processor.parse(file), file)) as Root;
	return { tree: result, file };
}

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
	warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe("markdown images resolve like Obsidian attachments", () => {
	test("a bare file name resolves to the attachment wherever it is stored", async () => {
		expect(await html("![](img.png)")).toContain('<img src="/attachments/img.png"');
	});

	test("a path relative to the note, an angle-bracket path and a percent-encoded name resolve", async () => {
		const output = await html("![](attachments/img.png) ![](<my image.png>) ![](my%20image.png)");
		// The first exists next to the page, so it is left for Rspress to bundle.
		expect(output).toContain('src="attachments/img.png"');
		expect(output.match(/src="\/attachments\/my%20image\.png"/g)).toHaveLength(2);
	});

	test("a size caption sizes the image and names it after the file", async () => {
		const output = await html("![120](img.png) ![A caption|120x40](img.png)");
		expect(output).toContain(
			'<img src="/attachments/img.png" alt="img" width="120" loading="lazy" />',
		);
		expect(output).toContain(
			'<img src="/attachments/img.png" alt="A caption" width="120" height="40" loading="lazy" />',
		);
	});

	test("a sized image never emits an unsafe URL", async () => {
		const output = await html("![250](javascript:alert(1))");
		expect(output).not.toContain('src="javascript:');
	});

	test("an image that resolves nowhere is reported through onBrokenLink", async () => {
		const { file } = await render("![](nowhere.png)");
		expect(file.messages.some((m) => String(m).includes('Image "nowhere.png" not found'))).toBe(
			true,
		);
		await expect(render("![](nowhere.png)", { onBrokenLink: "error" })).rejects.toThrow(
			/failed to resolve/,
		);
	});

	// Rspress's remarkImage runs first and turns each relative image into an
	// `<img>` bound to `import image0 from "img.png"`, which no bundler resolves.
	test("rewrites the import Rspress created to the attachment the vault resolves", async () => {
		const remarkImageOptions = {
			docDirectory: root,
			remarkImageOptions: { checkDeadImages: false },
		};
		const { tree: result, file } = await tree(
			"![120](img.png) ![](local.png) ![](my%20image.png) ![](nowhere.png)",
			{ page: "notes/inner.md", before: [[remarkImage, remarkImageOptions]] },
		);
		const imports = result.children
			.filter((node) => node.type === ("mdxjsEsm" as string))
			.map((node) => (node as unknown as { value: string }).value);
		const images: Array<{ attributes: Array<{ name: string; value: unknown }> }> = [];
		visit(result, (node) => {
			if (node.type === ("mdxJsxFlowElement" as string)) images.push(node as never);
		});
		const attribute = (index: number, name: string) =>
			images[index]?.attributes.find((entry) => entry.name === name)?.value;

		expect(imports).toEqual([
			'import image0 from "../attachments/img.png"',
			'import image1 from "./local.png"',
			'import image2 from "../attachments/my image.png"',
		]);
		expect(attribute(0, "width")).toBe("120");
		expect(attribute(0, "alt")).toBe("img");
		// Nothing to bundle: the import is dropped (so the build does not die on
		// it) and the miss is reported instead.
		expect(attribute(3, "src")).toBe("/nowhere.png");
		expect(file.messages.some((m) => String(m).includes('Image "nowhere.png" not found'))).toBe(
			true,
		);
	});

	test("exempts every relative image url from Rspress's dead-image gate", () => {
		expect(isPluginOwnedImageUrl("img.png")).toBe(true);
		expect(isPluginOwnedImageUrl("my%20image.png")).toBe(true);
		expect(isPluginOwnedImageUrl("/logo.png")).toBe(false);
		expect(isPluginOwnedImageUrl("https://x.dev/a.png")).toBe(false);
		expect(isPluginOwnedImageUrl("data:image/png;base64,AA")).toBe(false);
	});
});

describe("math is tokenized like Obsidian", () => {
	test("prices stay prose and `\\$` is an escape", async () => {
		const output = await html("It costs $5 and $10, or \\$3 \\$4.");
		expect(output).not.toContain("katex");
		expect(output).toContain("$5 and $10, or $3 $4.");
	});

	test("emphasis and highlight markers inside a formula stay TeX", async () => {
		const output = await html("Product $a*b*c$ and $a==b$ and $\\{1,2\\}$.");
		expect(output).not.toContain("<em>");
		expect(output).not.toContain("<mark>");
		expect(output.match(/class="obsidian-math"/g)).toHaveLength(3);
		expect(output).toContain('<span class="mopen">{</span>');
	});

	test("`$$…$$` written inside a paragraph is display math", async () => {
		const output = await html("Inline $$E=mc^2$$ display.");
		expect(output).toContain('class="obsidian-math-display"');
		expect(output).toContain("katex-display");
	});

	test("math inside a callout body is rendered by the same tokenizer", async () => {
		const output = await html("> [!note] Title\n> Body $a*b*c$ here.");
		expect(output).toContain('class="obsidian-math"');
		expect(output).not.toContain("<em>");
	});
});

describe("highlights span inline markup", () => {
	test("bold inside a highlight and a working link inside a highlight", async () => {
		const output = await html("==**bold** text== and ==see [[Note]]==");
		expect(output).toContain("<mark><strong>bold</strong> text</mark>");
		expect(output).toContain('<mark>see <a href="/Note">Note</a></mark>');
	});

	test("never fires inside code", async () => {
		const output = await html("`a==b==c`");
		expect(output).not.toContain("<mark>");
	});
});

describe("wikilinks whose names hold emphasis delimiters", () => {
	test("are recognised as links, not emphasis", async () => {
		const output = await html("[[__init__]] and [[*draft*]] and [[Note|*alias*]]");
		expect(output).toContain('data-wikilink="[[__init__]]">__init__</span>');
		expect(output).toContain('data-wikilink="[[*draft*]]">*draft*</span>');
		expect(output).toContain('<a href="/Note">*alias*</a>');
		expect(output).not.toContain("<strong>");
		expect(output).not.toContain("<em>");
	});

	test("splits an escaped alias pipe written inside a table", async () => {
		const output = await html("| Link |\n| --- |\n| [[Note\\|Alias]] |");
		expect(output).toContain('<a href="/Note">Alias</a>');
	});
});

describe("callouts", () => {
	test("accept hyphenated custom types and pass metadata on", async () => {
		const output = await html("> [!my-type|wide] Custom\n> Body");
		expect(output).toContain(
			'<div class="callout callout-my-type" data-callout="my-type" data-callout-metadata="wide">',
		);
	});

	test("title the callout with its type when no title is written", async () => {
		expect(await html("> [!tip]\n> Body")).toContain('<div class="callout-title">Tip</div>');
	});

	test("map Obsidian's aliases to the shared styling", async () => {
		const output = await html("> [!caution] A\n> x\n\n> [!hint] B\n> y\n\n> [!error] C\n> z");
		expect(output).toContain('class="callout callout-warning" data-callout="caution"');
		expect(output).toContain('class="callout callout-tip" data-callout="hint"');
		expect(output).toContain('class="callout callout-danger" data-callout="error"');
	});

	test("restore `[!important]` from Rspress's alert transform, fold sign included", async () => {
		const output = await html("> [!important]- Read this\n> First paragraph.", {
			before: [remarkContainerSyntax],
		});
		expect(output).toContain('<details class="callout callout-tip" data-callout="important">');
		expect(output).toContain('<summary class="callout-title">Read this</summary>');
		expect(output).not.toContain("- Read this");
	});

	test("read the first paragraph with GFM", async () => {
		const output = await html("> [!note] Title\n> Visit https://example.com ~~old~~ text");
		expect(output).toContain('<a href="https://example.com">');
		expect(output).toContain("<del>old</del>");
	});

	test("never leak a comment into the title", async () => {
		const output = await html("> [!note] Public title %%secret-title%%\n> Body");
		expect(output).not.toContain("secret-title");
		expect(output).toContain("Public title");
	});
});

describe("block ids", () => {
	test("render as a non-link element carrying the id", async () => {
		const output = await html("First line of paragraph\nsecond line ^para", { page: "Note.md" });
		expect(output).toContain('<span class="obsidian-block-anchor" id="^para"></span>');
		expect(output).not.toContain('<a id="^para"');
	});

	test("embedding a multi-line paragraph by its block id embeds the whole paragraph", async () => {
		const output = await html("![[Note#^para]]");
		expect(output).toMatch(/<p>First line of paragraph\s+second line/);
	});
});

describe("transclusion", () => {
	test("embedded headings and footnotes never duplicate the host's ids", async () => {
		const output = await html(
			"## Second heading\n\nHost text[^1].\n\n![[Note]]\n\n[^1]: Host footnote.",
			{ page: "Host.md" },
		);
		const ids = [...output.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids).toContain("second-heading");
		expect(ids).toContain("embed-1-second-heading");
		expect(ids).toContain("fn-1");
		expect(ids).toContain("embed-1-fn-1");
	});

	test("a note embeds one of its own sections", async () => {
		const { html: output, file } = await render("# A\n\n![[#B]]\n\n# B\n\nSection B text", {
			page: "Self.md",
		});
		expect(output).toContain('class="obsidian-transclusion"');
		expect(output.match(/Section B text/g)).toHaveLength(2);
		expect(file.messages.some((m) => String(m).includes("Circular"))).toBe(false);
	});

	test("a section that embeds itself is refused as circular", async () => {
		const { file } = await render("# Loop\n\n## Part\n\n![[#Part]]", { page: "Loop.md" });
		expect(file.messages.some((m) => String(m).includes("Circular transclusion"))).toBe(true);
	});
});

describe("heading ids match the content index", () => {
	test("headings holding math, a wikilink or an underscore get the index's slug", async () => {
		const output = await html("## Energy $E=mc^2$\n\n## See [[Note|the note]]\n\n## my_function", {
			page: "Headings.md",
		});
		expect(output).toContain('<h2 id="energy-emc2">');
		expect(output).toContain('<h2 id="see-the-note">');
		expect(output).toContain('<h2 id="my_function">');
		expect(output).toContain('<a href="/Note">the note</a>');
	});

	test("a heading link and the page agree", async () => {
		expect(await html("[[Headings#my_function]]")).toContain('href="/Headings#my_function"');
	});
});

describe("soft line breaks", () => {
	test("render single newlines as breaks when strict line breaks are off", async () => {
		const output = await html("one\ntwo", { strictLineBreaks: false });
		expect(output).toContain("one<br>\ntwo");
	});

	test("keep CommonMark on docs pages by default", async () => {
		expect(await html("one\ntwo")).toContain("<p>one\ntwo</p>");
	});

	test("follow Obsidian's default on vault pages", async () => {
		expect(await html("one\ntwo", { vaultRoot: root })).toContain("one<br>\ntwo");
	});
});

describe("task statuses", () => {
	test("custom statuses render as checked tasks carrying data-task", async () => {
		const output = await html("- [/] doing\n- [-] dropped\n- [ ] open\n- [x] done");
		expect(output).toContain(
			'<li class="task-list-item" data-task="/"><input type="checkbox" checked disabled> doing</li>',
		);
		expect(output).toContain('data-task="-"><input type="checkbox" checked disabled> dropped');
		expect(output).toContain('data-task=""><input type="checkbox" disabled> open');
		expect(output).toContain('data-task="x"><input type="checkbox" checked disabled> done');
	});
});

describe("tags", () => {
	test("link to the canonical lowercase route and skip code and heading links", async () => {
		const output = await html("Tagged #Project, `#incode` and [[#Second heading]].", {
			page: "Note.md",
		});
		expect(output).toContain('<a href="/tags/project">#Project</a>');
		expect(output).not.toContain("/tags/incode");
		expect(output).not.toContain("/tags/Second");
	});

	test("leave an escaped \\# as text, as Obsidian does, in prose, quotes and callout bodies", async () => {
		const output = await html(
			[
				"Issue \\#12 and \\#notatag beside #real",
				"",
				"> [!note] Title \\#nope",
				"> body \\#nope2 #yes",
			].join("\n"),
			{ page: "Note.md" },
		);
		expect(output).toContain("Issue #12 and #notatag beside");
		expect(output).toContain('<a href="/tags/real">#real</a>');
		expect(output).toContain('<a href="/tags/yes">#yes</a>');
		// The index never records `\#notatag` as a tag, so a link would be dead.
		expect(output).not.toMatch(/\/tags\/(notatag|nope|12)/);
	});
});

describe("block ids", () => {
	test("a caret word before more inline text is prose, not a block id", async () => {
		const output = await html("Raise a ^x **bold** move.", { page: "Note.md" });
		expect(output).toContain("Raise a ^x");
		expect(output).not.toContain('id="^x"');
	});
});

describe("media embeds", () => {
	test("caption and size on an image embed", async () => {
		const output = await html("![[img.png|A caption|300]]");
		expect(output).toContain('alt="A caption" width="300"');
	});

	test("audio, video and PDF frames honour the site base; images are left to Rspress", async () => {
		const output = await html("![[song.mp3]]\n\n![[doc.pdf]]\n\n![[img.png]]", {
			siteBase: "/repo/",
		});
		expect(output).toContain('<audio controls src="/repo/attachments/song.mp3">');
		expect(output).toContain('<iframe class="obsidian-pdf-frame" src="/repo/attachments/doc.pdf"');
		// Rspress's `img` component adds the base to a root-relative src itself.
		expect(output).toContain('<img src="/attachments/img.png"');
	});
});

describe("unsupported plugin fences", () => {
	test("stay code blocks and are reported", async () => {
		const { html: output, file } = await render("```tasks\nnot done\n```");
		expect(output).toContain('<code class="language-tasks">not done');
		expect(file.messages.some((m) => String(m).includes("[!tasks]"))).toBe(true);
	});
});
