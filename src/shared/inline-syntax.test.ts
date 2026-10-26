/**
 * The two markdown readers — the page pipeline (remark) and the canvas card
 * renderer (marked) — run over the same inputs and must agree on what a reader
 * sees: which links resolve where, which words are tags, what is highlighted,
 * which formulas are typeset and which comments are gone. Each side runs as it
 * does in a build: the page through this plugin's remark pass, the card through
 * the canvas build (which resolves its links and strips its comments) and then
 * the browser renderer, over one vault.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { VFile } from "vfile";
import { toHastMathHandlers } from "../../test/markdown/math-element";
import { canvas } from "../canvas/index";
import { parseCanvas } from "../canvas/parser";
import type { CanvasData } from "../canvas/types";
import { renderMarkdown } from "../canvas/utils/markdown";
import { remarkWikilink } from "../markdown/remark-wikilink";
import type { NormalizedPluginOptions } from "../markdown/types";
import { HIGHLIGHT_PATTERN, highlightAt, MATH_PATTERN, mathAt } from "./inline-syntax";

const FIXTURE = path.resolve(import.meta.dir, "../../test/markdown/fixtures/render-features");

const PAGE_OPTIONS: NormalizedPluginOptions = {
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

/** Each input, as a page's body and as a text card's text. */
const CASES: { name: string; source: string }[] = [
	{
		name: "wikilinks, aliases and heading links",
		source: "See [[Note]], [[Note|the note]] and [[Note#Second heading]].",
	},
	{ name: "tags, nested and numeric", source: "Tagged #project/alpha, #2024 and #done." },
	{ name: "an escaped hash is not a tag", source: "Not \\#escaped but #real." },
	{
		name: "highlights, single = and nested markup",
		source: "a ==key=value== b ==**bold** [[Note]]== c",
	},
	{ name: "spaced and over-long runs are not highlights", source: "x == spaced == y ===z=== w" },
	{ name: "inline and display math", source: "Energy $E = mc^2$ and $$x^2$$ here." },
	{ name: "dollar amounts stay prose", source: "It costs $5 and $10, or \\$3." },
	{
		name: "comments inline and across paragraphs",
		source: "Visible %%HIDDEN-ONE [[Note]]%% text.\n\n%%\nHIDDEN-TWO #hiddentag\n%%\n\nAfter.",
	},
	{ name: "code spans hold no syntax", source: "Code `[[Note]] #tag ==x== $y$ %%z%%` only." },
];

interface Outcome {
	links: { text: string; href: string }[];
	tags: string[];
	highlights: string[];
	math: string[];
	text: string;
}

function outcome(html: string, kind: "page" | "canvas"): Outcome {
	const root = document.createElement("div");
	root.innerHTML = html;
	const anchors = [...root.querySelectorAll("a[href]")];
	const isTag = (anchor: Element) =>
		kind === "page" && (anchor.getAttribute("href") ?? "").startsWith("/tags/");
	const tags =
		kind === "page"
			? anchors.filter(isTag).map((anchor) => anchor.textContent ?? "")
			: [...root.querySelectorAll(".canvas-tag")].map((tag) => tag.textContent ?? "");
	const math =
		kind === "page"
			? [...root.querySelectorAll("annotation")].map((node) => node.textContent ?? "")
			: [...root.querySelectorAll(".canvas-math")].map(
					(node) => node.getAttribute("data-tex") ?? "",
				);
	// KaTeX writes the formula's text into its markup; only the source shows.
	for (const formula of root.querySelectorAll(
		".obsidian-math, .obsidian-math-display, .canvas-math",
	)) {
		formula.remove();
	}
	return {
		links: anchors
			.filter((anchor) => !isTag(anchor))
			.map((anchor) => ({
				text: anchor.textContent ?? "",
				href: decodeURI(anchor.getAttribute("href") ?? "").toLowerCase(),
			})),
		tags,
		highlights: [...root.querySelectorAll("mark")].map((mark) => mark.textContent ?? ""),
		math,
		text: (root.textContent ?? "").replace(/\s+/g, " ").trim(),
	};
}

let vault = "";
let board: CanvasData;
let warn: ReturnType<typeof spyOn>;

beforeAll(async () => {
	warn = spyOn(console, "warn").mockImplementation(() => {});
	vault = await mkdtemp(path.join(tmpdir(), "syntax-parity-"));
	await cp(FIXTURE, vault, { recursive: true });
	const nodes = CASES.map((item, index) => ({
		id: `case-${index}`,
		type: "text" as const,
		x: 0,
		y: index * 100,
		width: 100,
		height: 100,
		text: item.source,
	}));
	await writeFile(path.join(vault, "Board.canvas"), JSON.stringify({ nodes, edges: [] }));
	const out = path.join(vault, ".out");
	await canvas({ vaultRoot: vault, outDir: out }).addPages?.({ root: vault }, false);
	board = parseCanvas(await readFile(path.join(out, "__canvases__", "Board.json"), "utf-8"), {
		enriched: true,
	});
});

afterAll(async () => {
	warn.mockRestore();
	await rm(vault, { recursive: true, force: true });
});

async function renderPage(source: string): Promise<string> {
	const file = new VFile({ value: source, path: path.join(vault, "index.md") });
	const result = await unified()
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkWikilink, {
			getDocsRoot: () => vault,
			getSiteBase: () => "/",
			options: PAGE_OPTIONS,
		})
		.use(remarkRehype, { allowDangerousHtml: true, handlers: toHastMathHandlers })
		.use(rehypeStringify, { allowDangerousHtml: true })
		.process(file);
	return String(result);
}

function renderCard(index: number): string {
	const node = board.nodes.find((item) => item.id === `case-${index}`);
	if (node?.type !== "text") throw new Error(`no published card case-${index}`);
	return renderMarkdown(node.text, {
		links: board.links,
		notes: board.notes,
		assets: board.assets,
		base: "/",
	});
}

describe("the page and a canvas card read Obsidian syntax alike", () => {
	CASES.forEach((item, index) => {
		test(item.name, async () => {
			const page = outcome(await renderPage(item.source), "page");
			const card = outcome(renderCard(index), "canvas");
			expect(card).toEqual(page);
			expect(card.text).not.toContain("HIDDEN");
		});
	});

	test("the table exercises every outcome it compares", async () => {
		const all = await Promise.all(CASES.map((item) => renderPage(item.source)));
		const outcomes = all.map((html) => outcome(html, "page"));
		expect(outcomes.some((entry) => entry.links.length > 0)).toBe(true);
		expect(outcomes.some((entry) => entry.tags.length > 0)).toBe(true);
		expect(outcomes.some((entry) => entry.highlights.length > 0)).toBe(true);
		expect(outcomes.some((entry) => entry.math.length > 0)).toBe(true);
	});
});

describe("shared patterns", () => {
	test("find highlights and formulas in a plain string", () => {
		expect(
			[..."==a== b ==c=d== == e == ===f===".matchAll(HIGHLIGHT_PATTERN)].map((m) => m[1]),
		).toEqual(["a", "c=d"]);
		// `$5 and $6` is prose, and a `$` inside a code span pairs with nothing outside it.
		const formulas = [..."$$x$$ $y$, $5 and $6, \\$z, `a$` b$".matchAll(MATH_PATTERN)];
		expect(formulas.map((m) => m[1] ?? m[2])).toEqual(["x", "y"]);
	});

	test("match a token only at the start of a string", () => {
		expect(highlightAt("==a== rest")).toEqual({ raw: "==a==", content: "a" });
		expect(highlightAt("x ==a==")).toBeUndefined();
		expect(mathAt("$$x$$")).toEqual({ raw: "$$x$$", content: "x", display: true });
		expect(mathAt("$y$ rest")).toEqual({ raw: "$y$", content: "y", display: false });
		expect(mathAt("$ y$")).toBeUndefined();
	});
});
