import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { rehypeHeaderAnchor } from "@rspress/core/dist/node/mdx/rehypePlugins/headerAnchor.js";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { parseCanvas } from "../../src/canvas/parser.ts";
import type { ContentIndex } from "../../src/markdown/content-index.ts";
import { buildContentIndex } from "../../src/markdown/content-index.ts";
import { remarkWikilink } from "../../src/markdown/remark-wikilink.ts";
import type { NormalizedPluginOptions } from "../../src/markdown/types.ts";

// A vault edited on Windows reaches the pipeline with CRLF line endings, and
// nothing else about it differs. These tests build the same vault twice — once
// with LF, once with CRLF — and assert the published result is byte-identical,
// because that is the property a Windows CI leg needs to be able to diff build
// artifacts against the Linux one. Linux can create every CRLF byte a Windows
// checkout has, so the whole comparison runs here; what CI adds is only that a
// real `core.autocrlf=true` checkout really does produce these files.

/** Frontmatter tags, a heading, a block id, an inline tag and a wrapped body. */
const NOTE = `# Note

## Target Heading

A paragraph inside the target. ^block-one

More text after the block.
`;

/** Every construct that is rebuilt from a source slice during the remark pass. */
const INDEX = `# Index

Intro paragraph that wraps
onto a second source line.

\`\`\`ts
const a = 1;
const b = 2;
\`\`\`

> [!note] Callout title
> Callout body that wraps
> onto another line.

%% this comment must not publish %%

Link to [[Note]], [[Note#Target Heading]] and [[Note#^block-one]].

![[Note#Target Heading]]

An inline tag: #inline/only
`;

const TAGS = `---
title: Tags
tags:
  - front/only
aliases:
  - Alias Page
---

# Tags

Frontmatter only.
`;

const BOARD = JSON.stringify(
	{
		nodes: [
			{ id: "n1", type: "text", x: 0, y: 0, width: 200, height: 100, text: "Note text" },
			{
				id: "n2",
				type: "file",
				file: "Note.md",
				subpath: "#Target Heading",
				x: 300,
				y: 0,
				width: 200,
				height: 100,
			},
		],
		edges: [{ id: "e1", fromNode: "n1", toNode: "n2" }],
	},
	null,
	2,
);

const VAULT: Record<string, string> = {
	"Index.md": INDEX,
	"Note.md": NOTE,
	"Tags.md": TAGS,
	"Board.canvas": BOARD,
};

/** The vault on disk, with every line ending rewritten to `eol`. */
const writeVault = (eol: "\n" | "\r\n"): string => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-vault-eol-"));
	for (const [name, content] of Object.entries(VAULT)) {
		fs.writeFileSync(path.join(root, name), content.replace(/\n/g, eol));
	}
	return root;
};

const OPTIONS: NormalizedPluginOptions = {
	vaultRoot: undefined,
	vaultRoutePrefix: "/vault",
	onBrokenLink: "error",
	onAmbiguousLink: "error",
	enableFuzzyMatching: false,
	enableCaseInsensitiveLookup: false,
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
	enableTagLinking: false,
	enableCallouts: true,
	enableBacklinks: false,
	enableUnlinkedMentions: false,
	enableTransclusion: true,
	enableMediaEmbeds: false,
	enableTagPages: false,
	enableMath: false,
	mathEngine: "katex",
	enableMermaid: false,
	mermaidSecurityLevel: "strict",
	enableDefaultStyles: false,
};

/**
 * The remark half of the build, driven exactly as Rspress drives it: parse,
 * plugin, rehype, stringify — plus Rspress's own header-anchor pass so the
 * emitted heading ids are the ones a wikilink fragment has to match.
 */
const render = async (root: string, name: string): Promise<string> => {
	const processor = unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkWikilink, { getDocsRoot: () => root, options: OPTIONS })
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(rehypeHeaderAnchor)
		.use(rehypeStringify, { allowDangerousHtml: true });
	const filePath = path.join(root, name);
	return String(
		await processor.process({ path: filePath, value: fs.readFileSync(filePath, "utf-8") }),
	);
};

const lfRoot = writeVault("\n");
const crlfRoot = writeVault("\r\n");

describe("CRLF vault (Windows-authored)", () => {
	test("indexes headings, blocks, tags and wikilink targets the same as LF", async () => {
		const [lf, crlf] = await Promise.all([buildContentIndex(lfRoot), buildContentIndex(crlfRoot)]);

		const summary = (index: ContentIndex) =>
			index.pages.map((page) => ({
				relativePath: page.relativePath,
				title: page.title,
				aliases: page.aliases,
				headings: page.headings.map((heading) => heading.slug),
				blocks: page.blocks.map((block) => block.id),
				tags: page.tags,
				wikilinkTargets: page.wikilinkTargets,
			}));

		// The index is built from `\r?\n`-split lines, so CRLF must not change a
		// single field — headings, `^block` ids, frontmatter tags and inline tags
		// included.
		expect(summary(crlf)).toEqual(summary(lf));
		expect(summary(crlf)).toEqual([
			{
				relativePath: "Index.md",
				title: undefined,
				aliases: [],
				headings: ["index"],
				blocks: [],
				tags: ["inline/only"],
				wikilinkTargets: ["note"],
			},
			{
				relativePath: "Note.md",
				title: undefined,
				aliases: [],
				headings: ["note", "target-heading"],
				blocks: ["block-one"],
				tags: [],
				wikilinkTargets: [],
			},
			{
				relativePath: "Tags.md",
				title: "Tags",
				aliases: ["Alias Page"],
				headings: ["tags"],
				blocks: [],
				tags: ["front/only"],
				wikilinkTargets: [],
			},
		]);

		// A backlink is only recorded when the target resolved through the index,
		// so this proves `[[Note]]` was read from the CRLF body.
		expect(crlf.backlinks.get("/Note")?.map((ref) => ref.relativePath)).toEqual(["Index.md"]);
	});

	test("renders byte-identical HTML to the LF vault", async () => {
		const [lf, crlf] = await Promise.all([
			render(lfRoot, "Index.md"),
			render(crlfRoot, "Index.md"),
		]);

		// Not "equal modulo \r": equal, byte for byte. `\r` inside a paragraph,
		// fenced code block, callout or transclusion is invisible in a browser but
		// turns a cross-platform artifact diff into noise.
		expect(crlf).toBe(lf);
		expect(crlf).not.toContain("\r");
	});

	test("resolves wikilinks, heading anchors and block subpaths", async () => {
		const html = await render(crlfRoot, "Index.md");

		expect(html).toContain('<a href="/Note">Note</a>');
		expect(html).toContain('href="/Note#target-heading"');
		expect(html).toContain('href="/Note#%5Eblock-one"');
		expect(html).not.toContain("[[Note");
		// The fragments point at ids the emitted headings actually carry.
		expect(html).toContain('<h1 id="index">');
		expect(html).toContain('<h2 id="target-heading">');
	});

	test("keeps multi-line paragraphs, fences, callouts and transclusions intact", async () => {
		const html = await render(crlfRoot, "Index.md");

		expect(html).toContain("<p>Intro paragraph that wraps\nonto a second source line.</p>");
		expect(html).toContain("const a = 1;\nconst b = 2;\n");
		expect(html).toContain("callout-note");
		expect(html).toContain("Callout body that wraps\nonto another line.");
		expect(html).toContain('class="obsidian-transclusion"');
		expect(html).toContain("A paragraph inside the target.");
	});

	test("strips Obsidian comments and does not publish them", async () => {
		const html = await render(crlfRoot, "Index.md");

		expect(html).not.toContain("this comment must not publish");
	});

	test("parses a CRLF canvas file identically to the LF one", () => {
		const crlfCanvas = fs.readFileSync(path.join(crlfRoot, "Board.canvas"), "utf-8");
		const lfCanvas = fs.readFileSync(path.join(lfRoot, "Board.canvas"), "utf-8");

		expect(crlfCanvas).toContain("\r\n");
		expect(parseCanvas(crlfCanvas)).toEqual(parseCanvas(lfCanvas));
		expect(parseCanvas(crlfCanvas).nodes).toHaveLength(2);
		expect(parseCanvas(crlfCanvas).edges).toEqual([
			{
				id: "e1",
				fromNode: "n1",
				fromSide: undefined,
				fromEnd: undefined,
				toNode: "n2",
				toSide: undefined,
				toEnd: undefined,
				color: undefined,
				label: undefined,
			},
		]);
	});
});
