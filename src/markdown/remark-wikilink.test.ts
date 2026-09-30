import { afterEach, describe, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { VFile } from "vfile";
import { setCanvasRoutes } from "../shared/canvas-routes.js";
import { normalizeLookupValue } from "../shared/slug.js";
import { remarkWikilink } from "./remark-wikilink.ts";
import type { ContentAsset, ContentIndex, ContentPage, NormalizedPluginOptions } from "./types.ts";

const basicRoot = path.resolve(process.cwd(), "test/markdown/fixtures/basic");
const assetsRoot = path.resolve(process.cwd(), "test/markdown/fixtures/assets");
const ambiguousRoot = path.resolve(process.cwd(), "test/markdown/fixtures/ambiguous");

const wikilinkCompatRoot = path.resolve(process.cwd(), "test/markdown/fixtures/wikilink-compat");

const DEFAULT_OPTIONS: NormalizedPluginOptions = {
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
	enableCallouts: false,
	enableBacklinks: false,
	enableUnlinkedMentions: false,
	enableTransclusion: false,
	enableMediaEmbeds: false,
	enableTagPages: false,
	enableMath: false,
	mathEngine: "katex",
	enableMermaid: false,
	mermaidSecurityLevel: "strict",
	enableDefaultStyles: false,
};

function makeProcessor(
	docsRoot: string,
	optionOverrides: Partial<NormalizedPluginOptions> = {},
	getContentIndex?: (filePath: string) => Promise<ContentIndex>,
) {
	return unified()
		.use(remarkParse)
		.use(remarkWikilink, {
			getDocsRoot: () => docsRoot,
			...(getContentIndex ? { getContentIndex } : {}),
			options: { ...DEFAULT_OPTIONS, ...optionOverrides },
		})
		.use(remarkStringify);
}

/** Capture console warnings so a test can assert the message Rspress never reads. */
function captureWarnings(): { calls: string[]; restore: () => void } {
	const calls: string[] = [];
	const spy = spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
		calls.push(args.map(String).join(" "));
	});
	return { calls, restore: () => spy.mockRestore() };
}

function makePage(overrides: Partial<ContentPage> & { filePathKey: string }): ContentPage {
	const { filePathKey } = overrides;
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
		push(byBaseName, page.baseName, page);
		push(byBaseNameCI, page.baseName.toLowerCase(), page);
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

describe("wikilink diagnostics", () => {
	test("warn mode reports a broken link and still renders the unresolved marker", async () => {
		const warnings = captureWarnings();
		try {
			const processor = makeProcessor(basicRoot, { onBrokenLink: "warn" });
			const file = await processor.process({
				value: "See [[nonexistent]] here.",
				path: path.resolve(basicRoot, "index.md"),
			});

			expect(String(file)).toContain('class="obsidian-unresolved"');
			expect(file.messages).toHaveLength(1);
			expect(String(file.messages[0])).toContain("[[nonexistent]]");
			expect(warnings.calls.some((call) => call.includes("[[nonexistent]]"))).toBe(true);
		} finally {
			warnings.restore();
		}
	});

	test("error mode fails the build for a broken link", async () => {
		const processor = makeProcessor(basicRoot, { onBrokenLink: "error" });

		await expect(
			processor.process({
				value: "See [[nonexistent]] here.",
				path: path.resolve(basicRoot, "index.md"),
			}),
		).rejects.toThrow(/failed to resolve/);
	});

	test("warn mode reports an ambiguous link and renders the unresolved marker", async () => {
		const warnings = captureWarnings();
		try {
			const processor = makeProcessor(ambiguousRoot, {
				onBrokenLink: "warn",
				onAmbiguousLink: "warn",
			});
			const file = await processor.process({
				value: "See [[getting-started]] here.",
				path: path.resolve(ambiguousRoot, "index.md"),
			});

			expect(String(file)).toContain('class="obsidian-unresolved"');
			expect(file.messages.some((m) => String(m).includes("ambiguous-page"))).toBe(true);
		} finally {
			warnings.restore();
		}
	});

	test("error mode fails the build for an ambiguous link", async () => {
		const processor = makeProcessor(ambiguousRoot, {
			onBrokenLink: "error",
			onAmbiguousLink: "error",
		});

		await expect(
			processor.process({
				value: "See [[getting-started]] here.",
				path: path.resolve(ambiguousRoot, "index.md"),
			}),
		).rejects.toThrow(/failed to resolve/);
	});

	test("reports a file that is not in the content index and skips processing", async () => {
		const processor = makeProcessor(basicRoot);
		const file = await processor.process({
			value: "[[guide/getting-started]]",
			path: path.resolve(basicRoot, "missing.md"),
		});

		expect(String(file)).toContain("guide/getting-started");
		expect(String(file)).not.toContain("(/guide/getting-started)");
		expect(file.messages).toHaveLength(1);
		expect(String(file.messages[0])).toContain("not found in content index");
	});

	test("processes a generated page outside the content root without warning", async () => {
		// Rspress compiles a page from `addPages` by writing its content to
		// node_modules/.rspress/runtime/temp-NN.mdx, so it is never in the index.
		// That is by design, and the pass still has to run on it.
		const processor = makeProcessor(basicRoot);
		const file = await processor.process({
			value: "[[guide/getting-started]]",
			path: path.resolve(process.cwd(), "node_modules/.rspress/runtime/temp-0.mdx"),
		});

		expect(String(file)).toContain("(/guide/getting-started)");
		expect(file.messages).toHaveLength(0);
	});

	test("renders math on a generated page, so the whole pipeline runs", async () => {
		const processor = makeProcessor(basicRoot, { enableMath: true });
		const file = await processor.process({
			value: "Energy is $E = mc^2$.",
			path: path.resolve(process.cwd(), "node_modules/.rspress/runtime/temp-0.mdx"),
		});

		expect(String(file)).toContain("katex");
		expect(file.messages).toHaveLength(0);
	});

	test("takes a generated page's title from its frontmatter", async () => {
		const processor = makeProcessor(basicRoot);
		const file = await processor.process({
			value: '---\ntitle: "#tag"\n---\n\nPages tagged here.',
			path: path.resolve(process.cwd(), "node_modules/.rspress/runtime/temp-0.mdx"),
		});

		// The title is read for self-references and diagnostics; a header the
		// frontmatter pass rejects must not throw here either.
		expect(String(file)).toContain("Pages tagged here");
		expect(file.messages.filter((m) => m.fatal)).toHaveLength(0);
	});

	test("does not decorate a generated page with a backlinks panel", async () => {
		const processor = makeProcessor(basicRoot, { enableBacklinks: true });
		const file = await processor.process({
			value: "[[guide/getting-started]]",
			path: path.resolve(process.cwd(), "node_modules/.rspress/runtime/temp-0.mdx"),
		});

		expect(String(file)).toContain("(/guide/getting-started)");
		expect(String(file)).not.toContain("obsidian-backlinks");
	});

	test("leaves a document with no file path untouched", async () => {
		const processor = makeProcessor(basicRoot);
		const file = await processor.process({ value: "See [[guide/getting-started]] here." });

		expect(String(file)).toContain("guide/getting-started");
		expect(String(file)).not.toContain("(/guide/getting-started)");
		expect(file.messages).toHaveLength(0);
	});

	test("reports a non-fatal pipeline failure through the file instead of rejecting", async () => {
		const processor = makeProcessor(basicRoot, {}, async () => {
			throw new Error("index unavailable");
		});
		const file = await processor.process({
			value: "See [[guide/getting-started]] here.",
			path: path.resolve(basicRoot, "index.md"),
		});

		expect(file.messages).toHaveLength(1);
		expect(String(file.messages[0])).toContain("Unexpected error processing");
		expect(String(file.messages[0])).toContain("index unavailable");
	});
});

describe("wikilink skip guards", () => {
	test("does not transform wikilinks inside code, link labels, or link definitions", async () => {
		const processor = makeProcessor(basicRoot);
		const file = await processor.process({
			value: [
				"```md",
				"[[guide/getting-started]]",
				"```",
				"",
				"Inline `[[guide/getting-started]]` stays put.",
				"",
				"A [label with [[guide/getting-started]]](https://example.com) link.",
				"",
				"[ref]: guide/getting-started",
				"",
				"Live [[guide/getting-started]].",
			].join("\n"),
			path: path.resolve(basicRoot, "index.md"),
		});
		const output = String(file);

		expect(output).toContain("```md\n[[guide/getting-started]]\n```");
		expect(output).toContain("Inline `[[guide/getting-started]]` stays put.");
		expect(output).toContain("](https://example.com)");
		expect(output).toContain("[ref]: guide/getting-started");
		expect(output).toContain("[getting started](/guide/getting-started)");
	});

	test("leaves highlight syntax inside a wikilink alias to the link", async () => {
		const processor = makeProcessor(basicRoot);
		const file = await processor.process({
			value: "See [[guide/getting-started|==Emphasis==]] now.",
			path: path.resolve(basicRoot, "index.md"),
		});
		const output = String(file);

		expect(output).toContain("==Emphasis==");
		expect(output).not.toContain("<mark>");
	});
});

describe("unsupported plugin fences", () => {
	test("warn mode reports a kanban fence and keeps the block as code", async () => {
		const warnings = captureWarnings();
		try {
			const processor = makeProcessor(basicRoot);
			const file = await processor.process({
				value: "```kanban\n- [ ] Ship it\n```",
				path: path.resolve(basicRoot, "index.md"),
			});

			expect(file.messages.some((m) => String(m).includes("[!kanban]"))).toBe(true);
			expect(warnings.calls.some((call) => call.includes("[!kanban]"))).toBe(true);
			// The board content is still published, as an ordinary code block.
			expect(String(file)).toContain("- [ ] Ship it");
		} finally {
			warnings.restore();
		}
	});

	test("error mode fails the build for a kanban fence", async () => {
		const processor = makeProcessor(basicRoot, { onUnsupportedBlock: "error" });

		await expect(
			processor.process({
				value: "```kanban\n- [ ] Ship it\n```",
				path: path.resolve(basicRoot, "index.md"),
			}),
		).rejects.toThrow(/\[!kanban\]/);
	});

	test("warn mode reports a tasks fence the plugin will not execute", async () => {
		const warnings = captureWarnings();
		try {
			const processor = makeProcessor(basicRoot);
			const file = await processor.process({
				value: "```tasks\ndue: today\n```",
				path: path.resolve(basicRoot, "index.md"),
			});

			expect(file.messages.some((m) => String(m).includes("[!tasks]"))).toBe(true);
		} finally {
			warnings.restore();
		}
	});

	test("an ordinary language fence stays silent", async () => {
		const warnings = captureWarnings();
		try {
			const processor = makeProcessor(basicRoot);
			const file = await processor.process({
				value: "```ts\nconst x = 1;\n```",
				path: path.resolve(basicRoot, "index.md"),
			});

			expect(file.messages).toHaveLength(0);
			expect(warnings.calls).toHaveLength(0);
		} finally {
			warnings.restore();
		}
	});
});

describe("dataview diagnostics", () => {
	test("warn mode reports an unsupported inline dataview expression", async () => {
		const processor = makeProcessor(basicRoot, {
			enableDataview: true,
			onDataviewError: "warn",
		});
		const file = await processor.process({
			value: "Count: = unknownfn(1)",
			path: path.resolve(basicRoot, "index.md"),
		});

		expect(file.messages.some((m) => String(m).includes("Unsupported Dataview function"))).toBe(
			true,
		);
	});

	test("error mode fails the build for an unsupported inline dataview expression", async () => {
		const processor = makeProcessor(basicRoot, {
			enableDataview: true,
			onDataviewError: "error",
		});

		await expect(
			processor.process({
				value: "Count: = unknownfn(1)",
				path: path.resolve(basicRoot, "index.md"),
			}),
		).rejects.toThrow(/Unsupported Dataview function/);
	});

	// The `=` marker and the whitespace after it used to be re-emitted as literal
	// text, so ordinary prose lost characters and a working expression kept a
	// tail ("…index</span>me").
	test("leaves prose containing an equals sign untouched", async () => {
		const processor = makeProcessor(basicRoot, { enableDataview: true });
		const file = await processor.process({
			value: "The default = here.",
			path: path.resolve(basicRoot, "index.md"),
		});

		expect(String(file).trim()).toBe("The default = here.");
	});

	test("renders every inline expression in one text node exactly once", async () => {
		const processor = makeProcessor(basicRoot, { enableDataview: true });
		const file = await processor.process({
			value: "a = file.name, b = file.name",
			path: path.resolve(basicRoot, "index.md"),
		});
		const output = String(file);

		expect(output.match(/<span class="dataview-inline">/g) ?? []).toHaveLength(2);
		expect(output).not.toContain("name</span>");
	});

	test("emits no empty span for an unknown field", async () => {
		const processor = makeProcessor(basicRoot, { enableDataview: true });
		const file = await processor.process({
			value: "Status = nosuchfield",
			path: path.resolve(basicRoot, "index.md"),
		});

		expect(String(file).trim()).toBe("Status = nosuchfield");
	});
});

describe("transclusion diagnostics", () => {
	test("renders a section that resolves but cannot be extracted as a link", async () => {
		const processor = makeProcessor(wikilinkCompatRoot, { enableTransclusion: true });
		const file = await processor.process({
			value: "![[Folder/Space Note#duplicate-1]]",
			path: path.resolve(wikilinkCompatRoot, "index.md"),
		});
		const output = String(file);

		expect(output).toContain('class="obsidian-embed"');
		expect(output).toContain('href="/Folder/Space Note"');
		expect(file.messages.some((m) => String(m).includes('"duplicate-1" not found in'))).toBe(true);
	});

	test("reports a transcluded page whose file cannot be read", async () => {
		const currentPage = makePage({ filePathKey: "index" });
		const brokenTarget = makePage({
			filePathKey: "target",
			absolutePath: "/vault/does-not-exist/target.md",
		});
		const index = makeIndex([currentPage, brokenTarget]);
		const processor = makeProcessor("/vault", { enableTransclusion: true }, async () => index);

		const file = await processor.process({
			value: "![[target]]",
			path: "/vault/index.md",
		});

		expect(file.messages.some((m) => String(m).includes("Failed to read"))).toBe(true);
		expect(String(file)).toContain('data-obsidian-embed="true"');
	});
});

describe("markdown embed diagnostics", () => {
	test("warn mode reports an unresolvable markdown embed and leaves it as written", async () => {
		const warnings = captureWarnings();
		try {
			const processor = makeProcessor(basicRoot, { onBrokenLink: "warn" });
			const file = await processor.process({
				value: "![alt](no-such-page.md)",
				path: path.resolve(basicRoot, "index.md"),
			});

			expect(String(file)).toContain("![alt](no-such-page.md)");
			expect(file.messages.some((m) => String(m).includes("no-such-page.md"))).toBe(true);
		} finally {
			warnings.restore();
		}
	});

	test("error mode fails the build for an unresolvable markdown embed", async () => {
		const processor = makeProcessor(basicRoot, { onBrokenLink: "error" });

		await expect(
			processor.process({
				value: "![alt](no-such-page.md)",
				path: path.resolve(basicRoot, "index.md"),
			}),
		).rejects.toThrow(/failed to resolve/);
	});
});

describe("media embeds", () => {
	test("renders a page embed with a non-media extension as a normal link", async () => {
		const processor = makeProcessor(basicRoot, { enableMediaEmbeds: true });
		const file = await processor.process({
			value: "![[guide/getting-started]]",
			path: path.resolve(basicRoot, "index.md"),
		});
		const output = String(file);

		expect(output).toContain('href="/guide/getting-started"');
		expect(output).not.toContain("<img");
	});

	test("resolves a case-insensitive attachment path that differs only by case", async () => {
		const processor = makeProcessor(assetsRoot, {
			enableMediaEmbeds: true,
			enableCaseInsensitiveLookup: true,
		});
		const file = await processor.process({
			value: "![[document.pdf]]",
			path: path.resolve(assetsRoot, "index.md"),
		});
		const output = String(file);

		expect(output).toContain('src="/Document.pdf"');
		expect(file.messages).toHaveLength(0);
	});

	test("resolves a nested attachment indexed off disk", async () => {
		const currentPage = makePage({ filePathKey: "index" });
		const nested = makeAsset({ pathKey: "nested/pic.png", urlPath: "/nested/pic.png" });
		const index = makeIndex([currentPage], [nested]);
		const processor = makeProcessor("/vault", { enableMediaEmbeds: true }, async () => index);

		const exact = await processor.process({
			value: "![[nested/pic.png]]",
			path: "/vault/index.md",
		});
		const basename = await processor.process({ value: "![[pic.png]]", path: "/vault/index.md" });

		expect(String(exact)).toContain('src="/nested/pic.png"');
		expect(String(basename)).toContain('src="/nested/pic.png"');
	});

	test("resolves an attachment basename case-insensitively when it is not on disk", async () => {
		const currentPage = makePage({ filePathKey: "index" });
		const asset = makeAsset({ pathKey: "nested/pic.png", urlPath: "/nested/pic.png" });
		const index = makeIndex([currentPage], [asset]);
		const processor = makeProcessor(
			"/vault",
			{ enableMediaEmbeds: true, enableCaseInsensitiveLookup: true },
			async () => index,
		);

		const file = await processor.process({ value: "![[PIC.PNG]]", path: "/vault/index.md" });

		expect(String(file)).toContain('src="/nested/pic.png"');
	});

	test("resolves an attachment that exists next to the note", async () => {
		const processor = makeProcessor(assetsRoot, { enableMediaEmbeds: true });
		const file = await processor.process({
			value: "![[image.png]]",
			path: path.resolve(assetsRoot, "index.md"),
		});

		expect(String(file)).toContain('src="/image.png"');
		expect(file.messages).toHaveLength(0);
	});

	test("resolves an attachment relative to the docs root for a nested note", async () => {
		// Forward slashes: the plugin normalizes the incoming file path before
		// looking it up in `byAbsolutePath`, so a `path.join` absolute path —
		// which is backslashes on Windows — never matches the key.
		const currentPage = makePage({
			filePathKey: "guide/index",
			absolutePath: path.join(assetsRoot, "guide", "index.md").replace(/\\/g, "/"),
			relativePath: "guide/index.md",
		});
		const index = makeIndex([currentPage]);
		const processor = makeProcessor(assetsRoot, { enableMediaEmbeds: true }, async () => index);

		const file = await processor.process({
			value: "![[image.png]]",
			path: path.join(assetsRoot, "guide", "index.md"),
		});

		expect(String(file)).toContain('src="/image.png"');
		expect(file.messages).toHaveLength(0);
	});

	test("resolves an indexed root attachment that is not on disk", async () => {
		const currentPage = makePage({
			filePathKey: "sub/index",
			absolutePath: "/vault/sub/index.md",
			relativePath: "sub/index.md",
		});
		const index = makeIndex([currentPage], [makeAsset({ pathKey: "pic.png" })]);
		const processor = makeProcessor("/vault", { enableMediaEmbeds: true }, async () => index);

		const file = await processor.process({ value: "![[pic.png]]", path: "/vault/sub/index.md" });

		expect(String(file)).toContain('src="/pic.png"');
	});
});

describe("comment stripping", () => {
	test("removes a comment from a rebuilt callout body", async () => {
		const processor = makeProcessor(basicRoot, { enableCallouts: true });
		const file = await processor.process({
			value: "> [!note] Title\n> Body %%hidden%% tail",
			path: path.resolve(basicRoot, "index.md"),
		});

		expect(String(file)).not.toContain("hidden");
		expect(String(file)).toContain("Body");
	});

	test("drops a callout body that is only a comment", async () => {
		const processor = makeProcessor(basicRoot, { enableCallouts: true });
		const file = await processor.process({
			value: "> [!note] Title\n> %%only-comment%%",
			path: path.resolve(basicRoot, "index.md"),
		});

		expect(String(file)).not.toContain("only-comment");
		expect(String(file)).toContain("callout-title");
	});

	test("keeps text outside an inline comment in a paragraph containing an entity", async () => {
		const processor = makeProcessor(basicRoot);
		const file = await processor.process({
			value: "Text %%hidden%% and \\[x\\] and &amp; end.",
			path: path.resolve(basicRoot, "index.md"),
		});
		const output = String(file);

		expect(output).not.toContain("hidden");
		expect(output).toContain("Text");
		expect(output).toContain("and");
	});
});

describe("callout restoration guards", () => {
	test("leaves foreign and positionless container directives untouched", async () => {
		const source = "> [!note] Title\n> Body\n";
		const tree = unified().use(remarkParse).use(remarkGfm).parse(source) as unknown as {
			children: unknown[];
		};
		// A directive Rspress did not create for a GitHub alert...
		const foreign = {
			type: "containerDirective",
			name: "note",
			attributes: { type: "note" },
			children: [],
		};
		// ...and a recognized callout marker with no source positions to verify.
		const positionless = {
			type: "containerDirective",
			name: "$$$callout$$$",
			attributes: { type: "note" },
			children: [],
		};
		tree.children = [foreign, positionless];

		const transformer = (
			remarkWikilink as unknown as (
				options: unknown,
			) => (tree: unknown, file: unknown) => Promise<void>
		)({
			getDocsRoot: () => basicRoot,
			options: { ...DEFAULT_OPTIONS, enableCallouts: true },
		});
		const file = new VFile({ value: source, path: path.resolve(basicRoot, "index.md") });

		await transformer(tree, file);

		const json = JSON.stringify(tree);
		expect(json).toContain('"containerDirective"');
		expect(json.match(/"containerDirective"/g)).toHaveLength(2);
	});

	test("transforms a callout blockquote that carries no source positions", async () => {
		const tree = {
			type: "root",
			children: [
				{
					type: "blockquote",
					children: [
						{
							type: "paragraph",
							children: [{ type: "text", value: "[!note] Recovered title\nBody text" }],
						},
					],
				},
			],
		};

		const transformer = (
			remarkWikilink as unknown as (
				options: unknown,
			) => (tree: unknown, file: unknown) => Promise<void>
		)({
			getDocsRoot: () => basicRoot,
			options: { ...DEFAULT_OPTIONS, enableCallouts: true },
		});
		const file = new VFile({ value: "", path: path.resolve(basicRoot, "index.md") });

		await transformer(tree, file);

		const json = JSON.stringify(tree);
		expect(json).toContain("callout callout-note");
		expect(json).toContain("Recovered title");
		expect(json).not.toContain("[!note]");
	});
});

describe("canvas boards in wikilinks", () => {
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

	test("embeds a published board as the CanvasEmbed component", async () => {
		setCanvasRoutes([
			{ absolutePath: "/vault/Demo.canvas", routePath: "/canvas/demo", source: "Demo.canvas" },
		]);
		const { index } = canvasFixture();
		const processor = makeProcessor("/vault", { enableMediaEmbeds: true }, async () => index);

		// The component only exists in an MDX-compiled tree, so assert on the
		// AST: `remarkStringify` has no handler for a JSX node.
		const tree = await processor.run(
			processor.parse("![[Demo.canvas]]"),
			new VFile({ path: "/vault/index.md" }),
		);
		const serialized = JSON.stringify(tree);

		expect(serialized).toContain('"type":"mdxJsxFlowElement"');
		expect(serialized).toContain('"name":"CanvasEmbed"');
		expect(serialized).toContain('"name":"src","value":"Demo.canvas"');
		expect(serialized).toContain('"name":"fileRoutePrefix","value":"/vault"');
	});

	test("links a published board when media embeds are off", async () => {
		setCanvasRoutes([
			{ absolutePath: "/vault/Demo.canvas", routePath: "/canvas/demo", source: "Demo.canvas" },
		]);
		const { index } = canvasFixture();
		const processor = makeProcessor("/vault", {}, async () => index);

		const file = await processor.process({
			value: "![[Demo.canvas]]",
			path: "/vault/index.md",
		});
		const output = String(file);

		expect(output).toContain('href="/canvas/demo"');
		expect(output).toContain('class="obsidian-embed"');
		expect(output).not.toContain("![[Demo.canvas]]");
	});

	test("links a plain board wikilink to the viewer route", async () => {
		setCanvasRoutes([
			{ absolutePath: "/vault/Demo.canvas", routePath: "/canvas/demo", source: "Demo.canvas" },
		]);
		const { index } = canvasFixture();
		const processor = makeProcessor("/vault", {}, async () => index);

		const file = await processor.process({
			value: "See [[Demo.canvas]] for the plan.",
			path: "/vault/index.md",
		});

		expect(String(file)).toContain("[Demo](/canvas/demo)");
		expect(String(file)).not.toContain("/vault/Demo.canvas");
	});

	test("links an unpublished board embed to the raw attachment", async () => {
		const { index } = canvasFixture();
		const processor = makeProcessor("/vault", { enableMediaEmbeds: true }, async () => index);

		const file = await processor.process({
			value: "![[Demo.canvas]]",
			path: "/vault/index.md",
		});
		const output = String(file);

		// Without a canvas route the attachment URL is all there is — never a
		// `<CanvasEmbed>` pointing at a board that was not published.
		expect(output).toContain('href="/vault/Demo.canvas"');
		expect(output).not.toContain("CanvasEmbed");
	});
});

// Rspress registers `remark-gfm` ahead of this plugin, so micromark consumes
// `[^1]` / `[^1]:` into mdast nodes before the text-level pass ever sees them.
// These run the plugin over a gfm-parsed tree, which is the only shape that
// reproduces the duplicated footnotes section and its dead back-links.
describe("footnotes after remark-gfm", () => {
	function makeGfmProcessor() {
		return unified()
			.use(remarkParse)
			.use(remarkGfm)
			.use(remarkWikilink, {
				getDocsRoot: () => basicRoot,
				options: { ...DEFAULT_OPTIONS },
			})
			.use(remarkStringify);
	}

	const source = [
		"A claim[^1] and an aside^[inline note] plus **bold** text.",
		"",
		"[^1]: The definition.",
		"",
	].join("\n");

	test("renders exactly one footnotes section, not one per parser", async () => {
		const file = await makeGfmProcessor().process({ value: source, path: "/index.md" });
		const output = String(file);

		expect(output.match(/class="footnotes"/g) ?? []).toHaveLength(1);
		// remark-gfm would emit its own `<section data-footnotes>`; leaving the
		// definitions in the tree is what produced the second section.
		expect(output).not.toContain("data-footnotes");
	});

	test("emits a reference anchor for every back-link it renders", async () => {
		const file = await makeGfmProcessor().process({ value: source, path: "/index.md" });
		const output = String(file);

		const targets = [...output.matchAll(/href="#(fnref-[^"]+)"/g)].map(
			(match) => match[1] as string,
		);
		expect(targets.length).toBeGreaterThan(0);
		for (const target of targets) {
			expect(output).toContain(`id="${target}"`);
		}
	});

	test("keeps a reference anchor for each construct, inline ones included", async () => {
		const file = await makeGfmProcessor().process({ value: source, path: "/index.md" });
		const output = String(file);

		expect(output).toContain('id="fnref-1"');
		expect(output).toContain('id="fnref-inline-1"');
	});
});

// A sentence-ending `.` used to be swallowed into the identifier, so
// `its folder is = file.folder.` resolved a field named `file.folder.` and
// matched nothing — the expression then silently rendered as literal text.
test("does not absorb a sentence-final period into an inline expression", async () => {
	const processor = makeProcessor(basicRoot, { enableDataview: true });
	const file = await processor.process({
		value: "The file name is = file.name, and its folder is = file.folder.",
		path: path.resolve(basicRoot, "index.md"),
	});
	const output = String(file);

	expect(output.match(/<span class="dataview-inline">/g) ?? []).toHaveLength(2);
	// The period stays prose: it is the sentence's, not the field's.
	expect(output.trimEnd().endsWith("</span>.")).toBe(true);
	expect(output).not.toContain("= file.folder");
});

// Enabling `enableDataview` on a page containing `$E = mc^2$` used to break the
// math: the inline pass matched the `= mc` inside it and split the text node, so
// the math pattern could no longer find both delimiters in one run.
test("leaves a text node whole when nothing in it is a dataview field", async () => {
	const processor = makeProcessor(basicRoot, { enableDataview: true });
	const source = "Inline math is written like $E = mc^2$ here.";
	const file = await processor.process({
		value: source,
		path: path.resolve(basicRoot, "index.md"),
	});

	// Byte-identical: the inline pass matched the `= mc` inside the math and used
	// to split the node around it, which stopped every later inline pass that
	// needs its neighbours from seeing the whole run.
	expect(String(file).trim()).toBe(source);
});

test("still renders math when dataview sees an equals sign inside it", async () => {
	const processor = makeProcessor(basicRoot, { enableDataview: true, enableMath: true });
	const file = await processor.process({
		value: "Inline math is written like $E = mc^2$ here.",
		path: path.resolve(basicRoot, "index.md"),
	});
	const output = String(file);

	expect(output).not.toContain("$E = mc^2$");
	expect(output).toContain("katex");
});

// The pipeline stages in `remarkWikilinkInner` are ordered, and at least one
// pair is genuinely order-dependent: a stage that runs after a source-rebuilding
// one sees different nodes, because rebuilding produces nodes with no source
// positions. The callout/comment case below was verified to fail when its two
// stages are swapped.
//
// Not every adjacent pair is observable from the outside — moving the
// highlights stage across the footnotes stage, or the cleanup stage before the
// embed stage, leaves the rendered output identical. Those cases are still worth
// asserting, because they hold the composed behaviour while the pipeline is
// edited, but they are not order pins and should not be read as ones.
describe("pipeline ordering", () => {
	// `onBrokenLink: "warn"` throughout: two of these cases reference something
	// that does not resolve, which is how the anchor and embed stages stay
	// observable without a real target to point at.
	const run = (value: string, overrides: Partial<NormalizedPluginOptions> = {}) =>
		makeProcessor(basicRoot, { onBrokenLink: "warn", ...overrides })
			.process({ value, path: path.resolve(basicRoot, "index.md") })
			.then(String);

	test("callouts rebuild from source, so comments inside them need the value pass", async () => {
		// If the comment strip ran only before callouts, the rebuilt callout body
		// would keep its `%% … %%` and publish it.
		const output = await run("> [!note] Kept\n> visible %% hidden %% text", {
			enableCallouts: true,
		});

		expect(output).toContain("Kept");
		expect(output).not.toContain("hidden");
	});

	test("comments run before highlights, so a commented highlight is never built", async () => {
		const output = await run("%% ==hidden== %% visible");

		expect(output).not.toContain("<mark>");
		expect(output).toContain("visible");
	});

	test("highlights run before wikilinks, so `==` inside a link stays literal", async () => {
		const output = await run("[[index#==weird==]]");

		expect(output).not.toContain("<mark>");
	});

	test("math runs after wikilinks, so a resolved href is never read as TeX", async () => {
		const output = await run("See [[index]] for $x^2$.", { enableMath: true });

		expect(output).toContain("katex");
		// The link survives intact rather than being eaten by the math pass. The
		// pipeline is serialized back to Markdown here, so the anchor is `](/)`.
		expect(output).toContain("[index](/)");
	});

	test("cleanup runs after embeds, so a block embed is not left inside a <p>", async () => {
		const output = await run("![[guide/advanced]]", { enableTransclusion: true });

		// A resolved note embed becomes a block-level `<div>`; without the cleanup
		// stage it would still be wrapped in the paragraph it was written in.
		expect(output).toContain("obsidian-transclusion");
		expect(output).not.toMatch(/<p[^>]*>\s*<div/);
	});
});

// macOS and Windows report `existsSync("document.pdf")` as true for a file
// actually named `Document.pdf`. The resolver used to return the name as typed,
// emitting a URL the site never publishes; it now takes the casing the index
// recorded. Simulated here rather than left to CI, because the behaviour is a
// property of the filesystem and a Linux checkout cannot produce it.
test("a case-insensitive filesystem does not make the emitted URL lowercase", async () => {
	const realExistsSync = fs.existsSync;
	const asCaseInsensitive = (candidate: string): boolean =>
		realExistsSync(candidate) ||
		realExistsSync(candidate.replace(/document\.pdf$/i, "Document.pdf"));
	const spy = spyOn(fs, "existsSync").mockImplementation(((candidate: string) =>
		asCaseInsensitive(String(candidate))) as typeof fs.existsSync);
	try {
		const processor = makeProcessor(assetsRoot, {
			enableMediaEmbeds: true,
			enableCaseInsensitiveLookup: true,
		});
		const file = await processor.process({
			value: "![[document.pdf]]",
			path: path.resolve(assetsRoot, "index.md"),
		});

		expect(String(file)).toContain('src="/Document.pdf"');
	} finally {
		spy.mockRestore();
	}
});
