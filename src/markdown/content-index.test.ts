import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { caseSensitiveFilesystem } from "../../test/case-sensitive-fs.js";
import { buildContentIndex, getCachedContentIndex } from "./content-index.ts";

/** Run `body` against a throwaway vault built from `files`. */
async function withVault(
	files: Record<string, string>,
	body: (root: string) => Promise<void>,
): Promise<void> {
	const root = mkdtempSync(path.join(os.tmpdir(), "obsidian-frontmatter-"));
	try {
		for (const [name, content] of Object.entries(files)) {
			// Nested fixtures (`public/vault/media/clip.png`) are the norm here, so
			// the parent has to exist before the file does.
			const target = path.join(root, name);
			mkdirSync(path.dirname(target), { recursive: true });
			writeFileSync(target, content);
		}
		await body(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/** Collect console.warn output produced while `body` runs. */
async function warningsWhile(body: () => Promise<void>): Promise<string[]> {
	const warnings: string[] = [];
	const original = console.warn;
	console.warn = (...args: unknown[]) => warnings.push(args.map(String).join(" "));
	try {
		await body();
	} finally {
		console.warn = original;
	}
	return warnings;
}

describe("frontmatter engine allow-list", () => {
	test("does not execute a ---js frontmatter block", async () => {
		const marker = path.join(os.tmpdir(), `matter-pwned-${process.pid}-${Date.now()}`);
		try {
			await withVault(
				{
					"note.md": [
						"---js",
						`require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'pwned');`,
						"---",
						"# Body",
					].join("\n"),
				},
				async (root) => {
					const index = await buildContentIndex(root);

					// The block must not have run, and the page must still publish.
					expect(existsSync(marker)).toBe(false);
					expect(index.pages.map((page) => page.relativePath)).toEqual(["note.md"]);
				},
			);
		} finally {
			rmSync(marker, { force: true });
		}
	});

	test("reports the refused file and why its metadata was dropped", async () => {
		await withVault({ "note.md": "---js\nreturn { title: 'x' };\n---\n\n# Body" }, async (root) => {
			const warnings = await warningsWhile(async () => {
				await buildContentIndex(root);
			});

			expect(warnings.some((line) => line.includes("note.md"))).toBe(true);
			expect(warnings.some((line) => line.includes("JavaScript frontmatter"))).toBe(true);
		});
	});

	test("refuses an unregistered language marker", async () => {
		await withVault({ "note.md": "---coffee\ntitle: x\n---\n\n# Body" }, async (root) => {
			const warnings = await warningsWhile(async () => {
				await buildContentIndex(root);
			});

			expect(warnings.some((line) => line.includes("Unsupported frontmatter language"))).toBe(true);
		});
	});
});

describe("frontmatter parsing", () => {
	test("reads YAML frontmatter unchanged", async () => {
		await withVault(
			{
				"note.md": [
					"---",
					"title: YAML Page",
					"aliases: [Alt One, Alt Two]",
					"tags: [alpha]",
					"---",
					"",
					"# Body",
				].join("\n"),
				"draft.md": ["---", "publish: false", "---", "", "# Draft"].join("\n"),
			},
			async (root) => {
				const index = await buildContentIndex(root);
				const page = index.pages[0];

				expect(page?.title).toBe("YAML Page");
				expect(page?.aliases).toEqual(["Alt One", "Alt Two"]);
				expect(page?.tags).toEqual(["alpha"]);
				// `publish: false` still drops the page from the index entirely.
				expect(index.pages.map((entry) => entry.relativePath)).toEqual(["note.md"]);
			},
		);
	});

	test("reads JSON frontmatter", async () => {
		await withVault(
			{ "note.md": '---json\n{"title": "JSON Page", "tags": ["beta"]}\n---\n\n# Body' },
			async (root) => {
				const index = await buildContentIndex(root);
				const page = index.pages[0];

				expect(page?.title).toBe("JSON Page");
				expect(page?.tags).toEqual(["beta"]);
			},
		);
	});

	test("treats a leading thematic break as content, not frontmatter", async () => {
		await withVault({ "note.md": "---\n\n# Body\n" }, async (root) => {
			const index = await buildContentIndex(root);
			const page = index.pages[0];

			expect(page?.relativePath).toBe("note.md");
			expect(page?.title).toBeUndefined();
		});
	});
});

const NFD_CAFE = "cafe\u0301";
const NFC_CAFE = "caf\u00e9";

/**
 * macOS reports filenames decomposed (NFD) while note text is usually composed
 * (NFC), so `[[café]]` would never match `café.md` there. Linux can hold either
 * spelling, which is what makes both halves of the fold testable here; only the
 * macOS CI leg proves a file that the OS itself stores decomposed.
 */
describe("unicode-normalized resolution", () => {
	test("resolves a composed wikilink to a file named decomposed on disk", async () => {
		await withVault(
			{ [`${NFD_CAFE}.md`]: "# Café\n", "index.md": `[[${NFC_CAFE}]]\n` },
			async (root) => {
				const index = await buildContentIndex(root);
				const target = index.pages.find((page) => page.baseName === NFC_CAFE);
				if (!target) throw new Error("decomposed page was not indexed");

				// The key is folded; the route keeps the bytes the filesystem reported.
				expect(target.filePathKey).toBe(NFC_CAFE);
				expect(target.routePath).toBe(`/${NFD_CAFE}`);
				expect(index.backlinks.get(target.routePath)?.map((ref) => ref.relativePath)).toEqual([
					"index.md",
				]);
			},
		);
	});

	test("resolves a decomposed wikilink to a file named composed on disk", async () => {
		await withVault(
			{ [`${NFC_CAFE}.md`]: "# Café\n", "index.md": `[[${NFD_CAFE}]]\n` },
			async (root) => {
				const index = await buildContentIndex(root);
				const target = index.pages.find((page) => page.baseName === NFC_CAFE);
				if (!target) throw new Error("composed page was not indexed");

				expect(index.backlinks.get(target.routePath)?.map((ref) => ref.relativePath)).toEqual([
					"index.md",
				]);
			},
		);
	});
});

/**
 * A case-insensitive filesystem (Windows, default macOS) cannot hold `Note.md`
 * and `NOTE.md` side by side, so the case-insensitive maps there always hold one
 * entry and every lookup resolves. Linux can hold both — the only place this
 * ambiguity is reachable — and then the link resolves to one of them the way
 * Obsidian picks, and the backlink follows the link.
 */
describe("case-only-different files", () => {
	test.skipIf(!caseSensitiveFilesystem)(
		"backlinks only the candidate the link resolves to",
		async () => {
			await withVault(
				{ "Note.md": "# Note\n", "NOTE.md": "# NOTE\n", "source.md": "[[note]]\n" },
				async (root) => {
					const index = await buildContentIndex(root);
					expect(index.byBaseNameCI.get("note")).toHaveLength(2);
					expect(index.byFilePathKeyCI.get("note")).toHaveLength(2);

					// Same folder and length: the alphabetically first path ("NOTE.md").
					expect(index.backlinks.get("/NOTE")?.map((ref) => ref.relativePath)).toEqual([
						"source.md",
					]);
					expect(index.backlinks.get("/Note")).toBeUndefined();
				},
			);
		},
	);
});

describe("attachment URLs", () => {
	test("serves a file under public/ from the site root, not from /public", async () => {
		// Rspress copies `public/` to the root and nothing else, so this file is
		// reachable at `/vault/media/clip.png`. Indexing it as
		// `/public/vault/media/clip.png` produced a `src` that no route serves,
		// which is invisible until a page embeds it and the browser 404s.
		await withVault({ "public/vault/media/clip.png": "not really a png" }, async (root) => {
			const index = await buildContentIndex(root);
			expect(index.assets.map((asset) => asset.urlPath)).toEqual(["/vault/media/clip.png"]);
		});
	});

	test("keeps a route prefix for an attachment outside public/", async () => {
		await withVault({ "media/gradient.png": "not really a png either" }, async (root) => {
			const index = await buildContentIndex(root, { routePrefix: "/vault" });
			expect(index.assets.map((asset) => asset.urlPath)).toEqual(["/vault/media/gradient.png"]);
		});
	});

	test("percent-encodes a public asset's segments", async () => {
		await withVault({ "public/media/My Clip.png": "x" }, async (root) => {
			const index = await buildContentIndex(root);
			expect(index.assets[0]?.urlPath).toBe("/media/My%20Clip.png");
		});
	});
});

describe("wikilink targets", () => {
	test("counts a reference-style definition as a link to the page", async () => {
		// The graph extractor already counted these and the resolver already
		// rewrote them; excluding them made the two subsystems disagree.
		await withVault(
			{
				"index.md": "See [the target][r].\n\n[r]: Target.md\n",
				"Target.md": "# Target\n",
			},
			async (root) => {
				const index = await buildContentIndex(root);
				const source = index.backlinks.get("/Target");
				expect(source?.map((ref) => ref.relativePath)).toEqual(["index.md"]);
			},
		);
	});

	test("resolves a reference definition carrying a heading fragment", async () => {
		await withVault(
			{
				"Other.md": "[q]\n\n[q]: Target.md#Section\n",
				"Target.md": "# Target\n\n## Section\n",
			},
			async (root) => {
				const index = await buildContentIndex(root);
				expect(index.backlinks.get("/Target")?.map((ref) => ref.relativePath)).toEqual([
					"Other.md",
				]);
			},
		);
	});

	test("does not treat a footnote or citation definition as a link", async () => {
		await withVault(
			{
				"index.md": "Body[^1] and a citation[~cite].\n\n[^1]: Target.md\n[~cite]: Target.md\n",
				"Target.md": "# Target\n",
			},
			async (root) => {
				const index = await buildContentIndex(root);
				expect(index.backlinks.get("/Target")).toBeUndefined();
			},
		);
	});

	test("ignores an external or fragment-only definition", async () => {
		await withVault(
			{
				"index.md": "[a]: https://example.com\n[b]: #anchor\n[c]: mailto:x@y.z\n",
			},
			async (root) => {
				const index = await buildContentIndex(root);
				expect(index.backlinks.size).toBe(0);
			},
		);
	});
});

describe("wikilink target normalization", () => {
	test("a query string does not hide a link from the backlinks", async () => {
		// The graph extractor already cut at `?` as well as `#`; splitting at `#`
		// alone left `Note.md?from=docs` in the path, failed the `.md` test, and
		// dropped the link silently.
		for (const link of [
			"[to b](b.md?from=docs)",
			"[to b](b.md?from=docs#Head)",
			"[to b](b.md#Head)",
			"[to b](b.md)",
		]) {
			await withVault({ "a.md": `# A\n\n${link}\n`, "b.md": "# B\n" }, async (root) => {
				const index = await buildContentIndex(root);
				expect(index.backlinks.get("/b")?.map((ref) => ref.relativePath)).toEqual(["a.md"]);
			});
		}
	});

	test("an attachment embed is not a page link", async () => {
		// It can never resolve to a page, so it earned nothing as a backlink — but
		// it did reach Dataview, where `file.outlinks` rendered a link to a route
		// that does not exist.
		await withVault(
			{
				"a.md": "# A\n\nAn image ![[pic.png]] and a clip ![[clip.mp4]] and a page [[b]].\n",
				"b.md": "# B\n",
				"pic.png": "x",
				"clip.mp4": "x",
			},
			async (root) => {
				const index = await buildContentIndex(root);
				const a = index.pages.find((p) => p.filePathKey === "a");
				expect(a?.wikilinkTargets).toEqual(["b"]);
			},
		);
	});

	test("a note whose title contains a dot is still a page link", async () => {
		// The attachment filter keys on a known media extension precisely so that
		// a prose title like `Chapter 1. Introduction` — the same shape that broke
		// canvas embeds — keeps resolving.
		await withVault(
			{ "a.md": "# A\n\nSee [[Chapter 1. Introduction]] and [[v1.0 Roadmap]].\n" },
			async (root) => {
				const index = await buildContentIndex(root);
				const a = index.pages.find((p) => p.filePathKey === "a");
				expect(a?.wikilinkTargets).toEqual(["chapter 1. introduction", "v1.0 roadmap"]);
			},
		);
	});
});

describe("publishable files", () => {
	test("never indexes dotfiles or files in dot-directories", async () => {
		await withVault(
			{
				".env": "SECRET=1",
				"sub/.secrets.json": "{}",
				".obsidian/app.json": "{}",
				"Note.md": "# Note",
				"img.png": "png",
			},
			async (root) => {
				const index = await buildContentIndex(root);
				expect(index.assets.map((asset) => asset.relativePath)).toEqual(["img.png"]);
				expect(index.pages.map((page) => page.relativePath)).toEqual(["Note.md"]);
			},
		);
	});

	test("never indexes the excluded folders, and keeps a sibling with a similar name", async () => {
		await withVault(
			{
				"Templates/Daily.md": "# <% tp.file.title %>",
				"Templates/nested/x.png": "png",
				"Templates archive/Old.md": "# Old",
				"Note.md": "# Note",
			},
			async (root) => {
				const index = await buildContentIndex(root, { excludeFolders: ["/Templates/"] });
				expect(index.pages.map((page) => page.relativePath).sort()).toEqual([
					"Note.md",
					"Templates archive/Old.md",
				]);
				expect(index.assets).toEqual([]);
			},
		);
	});
});

describe("heading ids", () => {
	test("match the ids the rendered page gives its headings", async () => {
		await withVault(
			{
				"Note.md": [
					"## my_function",
					"## See [[x|alias]]",
					"## Title %%draft%%",
					"## **Bold** and ~~gone~~",
					"## Energy $E=mc^2$",
					"## Duplicate",
					"## Duplicate",
					"## Custom {#custom-id}",
					"> ## Quoted",
				].join("\n\n"),
			},
			async (root) => {
				const index = await buildContentIndex(root);
				const page = index.byFilePathKey.get("Note");
				expect(page?.headings.map((h) => h.explicitId ?? h.slug)).toEqual([
					"my_function",
					"see-alias",
					"title",
					"bold-and-gone",
					"energy-emc2",
					"duplicate",
					"duplicate-1",
					"custom-id",
					"quoted",
				]);
				expect(page?.headings[1]?.rawText).toBe("See alias");
			},
		);
	});

	test("keeps commented headings and comment text out of the index", async () => {
		await withVault(
			{
				"other.md": "## Plan\n%% secret salary 120k %%\nPublic text\n\n%%\n## Hidden\n%%\n",
			},
			async (root) => {
				const page = (await buildContentIndex(root)).byFilePathKey.get("other");
				expect(page?.headings.map((h) => h.rawText)).toEqual(["Plan"]);
				expect(page?.headings[0]?.preview).toBe("Public text");
			},
		);
	});

	test("leaves an Excalidraw note's data headings out, keeping its links and element ids", async () => {
		await withVault(
			{
				"Plan.excalidraw.md": [
					"---",
					"excalidraw-plugin: parsed",
					"---",
					"## Notes on the plan",
					"",
					"# Excalidraw Data",
					"",
					"## Text Elements",
					"Ship [[Target]] ^box1",
					"",
					"%%",
					"## Drawing",
					"```json",
					"{}",
					"```",
					"%%",
				].join("\n"),
				"Target.md": "# Target",
				"Plain.md": "# Excalidraw Data\n\n## Text Elements\n",
			},
			async (root) => {
				const index = await buildContentIndex(root);
				const drawing = index.byFilePathKey.get("Plan.excalidraw");
				// Otherwise backlinks and the graph label the drawing "Excalidraw Data".
				expect(drawing?.headings.map((h) => h.rawText)).toEqual(["Notes on the plan"]);
				expect(drawing?.wikilinkTargets).toContain("target");
				expect(drawing?.blocks.map((b) => b.id)).toEqual(["box1"]);
				// Only a drawing note: the same headings in an ordinary note are its own.
				expect(index.byFilePathKey.get("Plain")?.headings.map((h) => h.rawText)).toEqual([
					"Excalidraw Data",
					"Text Elements",
				]);
			},
		);
	});
});

describe("tags", () => {
	test("are read from prose only, not anchors, code or link destinations", async () => {
		await withVault(
			{
				"Note.md": [
					"---",
					"tags: alpha, Beta",
					"---",
					"Use `#include <stdio.h>` and see [[#Setup]] or [jump](#install).",
					'Visit https://example.com/#frag and <a href="#x">x</a>.',
					"%% #secret %%",
					"```",
					"#fenced",
					"```",
					"Real #tag and #nested/child, [label #inlabel](Other.md).",
				].join("\n"),
			},
			async (root) => {
				const page = (await buildContentIndex(root)).byFilePathKey.get("Note");
				expect(page?.tags).toEqual(["alpha", "Beta", "tag", "nested/child", "inlabel"]);
			},
		);
	});
});

describe("legacy list properties", () => {
	test("split a comma-separated aliases string", async () => {
		await withVault(
			{ "Note.md": "---\naliases: First, Second Name\ncssclass: wide tall\n---\nBody" },
			async (root) => {
				const page = (await buildContentIndex(root)).byFilePathKey.get("Note");
				expect(page?.aliases).toEqual(["First", "Second Name"]);
				expect(page?.cssclasses).toEqual(["wide", "tall"]);
			},
		);
	});
});

describe("outlinks", () => {
	test("include frontmatter property links and count them as backlinks", async () => {
		await withVault(
			{
				"Source.md":
					'---\nrelated: "[[Target]]"\nup: ["[[Folder/Deep]]"]\n---\nBody without links.',
				"Target.md": "# Target",
				"Folder/Deep.md": "# Deep",
			},
			async (root) => {
				const index = await buildContentIndex(root);
				const source = index.byFilePathKey.get("Source");
				expect(source?.outlinks?.map((link) => link.target)).toEqual(["Target", "Folder/Deep"]);
				expect(index.backlinks.get("/Target")?.map((ref) => ref.routePath)).toEqual(["/Source"]);
				expect(index.backlinks.get("/Folder/Deep")?.map((ref) => ref.routePath)).toEqual([
					"/Source",
				]);
			},
		);
	});

	test("include markdown images and links to attachments, not site URLs", async () => {
		await withVault(
			{
				"Note.md":
					"![](img.png) [spec](docs/spec%20v2.pdf) [abs](/downloads/app.zip) [ext](https://x.y/a.png) ![[clip.mp4]]",
			},
			async (root) => {
				const page = (await buildContentIndex(root)).byFilePathKey.get("Note");
				expect(page?.outlinks?.map((link) => [link.target, link.isEmbed])).toEqual([
					["clip.mp4", true],
					["img.png", true],
					["docs/spec v2.pdf", false],
				]);
			},
		);
	});

	test("split an escaped alias pipe inside a table cell", async () => {
		await withVault(
			{
				"A.md": "| Link | Img |\n| --- | --- |\n| [[Page\\|Alias]] | ![[img.png\\|100]] |\n",
				"Page.md": "# Page",
			},
			async (root) => {
				const index = await buildContentIndex(root);
				const links = index.byFilePathKey.get("A")?.outlinks ?? [];
				expect(links.map((link) => [link.target, link.alias])).toEqual([
					["Page", "Alias"],
					["img.png", "100"],
				]);
				expect(index.backlinks.get("/Page")?.map((ref) => ref.routePath)).toEqual(["/A"]);
			},
		);
	});

	test("a note named like a media extension is a page link", async () => {
		await withVault({ "A.md": "See [[SVG]].", "SVG.md": "# SVG" }, async (root) => {
			const index = await buildContentIndex(root);
			expect(index.byFilePathKey.get("A")?.wikilinkTargets).toEqual(["svg"]);
			expect(index.backlinks.get("/SVG")?.map((ref) => ref.routePath)).toEqual(["/A"]);
		});
	});
});

describe("docs routes", () => {
	test("drop the default language and version like Rspress", async () => {
		await withVault(
			{ "en/guide.md": "# Guide", "zh/guide.md": "# 指南", "en/index.md": "# Home" },
			async (root) => {
				const index = await buildContentIndex(root, {
					locales: { lang: "en", langs: ["en", "zh"] },
				});
				expect(index.pages.map((page) => page.routePath).sort()).toEqual([
					"/",
					"/guide",
					"/zh/guide",
				]);
			},
		);
	});
});

describe("Dataview metadata", () => {
	test("is skipped when Dataview is off", async () => {
		await withVault(
			{ "Note.md": "---\nstatus: done\n---\nfield:: value\n- [ ] task" },
			async (root) => {
				const off = (await getCachedContentIndex(root, { dataview: false })).byFilePathKey.get(
					"Note",
				);
				expect(off?.dataviewFields).toEqual({});
				expect(off?.dataviewTasks).toEqual([]);
				const on = (await getCachedContentIndex(root)).byFilePathKey.get("Note");
				expect(on?.dataviewTasks.length).toBe(1);
			},
		);
	});
});

describe("frontmatter property links under YAML anchors", () => {
	test("an alias bomb or a self-referencing list indexes in linear time", async () => {
		const levels = ['a0: &a0 ["[[Target]]"]'];
		for (let level = 1; level <= 12; level++) {
			const refs = Array.from({ length: 9 }, () => `*a${level - 1}`).join(", ");
			levels.push(`a${level}: &a${level} [${refs}]`);
		}
		await withVault(
			{
				"Bomb.md": `---\n${levels.join("\n")}\n---\nBody`,
				"Cycle.md": '---\nloop: &l ["[[Target]]", *l]\n---\nBody',
				"Target.md": "# Target",
			},
			async (root) => {
				const index = await buildContentIndex(root);
				expect(index.byFilePathKey.get("Bomb")?.outlinks?.map((link) => link.target)).toEqual([
					"Target",
				]);
				expect(
					index.backlinks
						.get("/Target")
						?.map((ref) => ref.routePath)
						.sort(),
				).toEqual(["/Bomb", "/Cycle"]);
			},
		);
	}, 5000);
});

describe("rebuilds", () => {
	test("parse a note recreated after it left the root afresh", async () => {
		await withVault(
			{ "Note.md": "---\ntitle: First\n---\n", "Other.md": "# Other" },
			async (root) => {
				const note = path.join(root, "Note.md");
				const stamp = new Date("2026-01-01T00:00:00Z");
				utimesSync(note, stamp, stamp);
				const titleOf = async () =>
					(await getCachedContentIndex(root)).byFilePathKey.get("Note")?.title;
				expect(await titleOf()).toBe("First");

				rmSync(note);
				expect(await titleOf()).toBeUndefined();

				// Same size and mtime, other text: only a parse kept for a file that
				// had left the root could still answer "First".
				writeFileSync(note, "---\ntitle: Fresh\n---\n");
				utimesSync(note, stamp, stamp);
				expect(await titleOf()).toBe("Fresh");
			},
		);
	});
});
