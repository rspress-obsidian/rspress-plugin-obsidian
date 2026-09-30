import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildContentIndex } from "./content-index.ts";

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
 * ambiguity is reachable — and then the resolver must report every candidate
 * rather than silently pick one. That is why the diagnostics legitimately
 * differ per OS.
 */
describe("case-only-different files", () => {
	test("keeps both candidates and reports the ambiguity instead of picking one", async () => {
		await withVault(
			{ "Note.md": "# Note\n", "NOTE.md": "# NOTE\n", "source.md": "[[note]]\n" },
			async (root) => {
				const index = await buildContentIndex(root);
				const routes = index.pages
					.filter((page) => page.baseName.toLowerCase() === "note")
					.map((page) => page.routePath);

				expect(routes).toHaveLength(2);
				// Both case-insensitive maps see both pages: a lookup that lands
				// there is ambiguous, and must be reported as such.
				expect(index.byBaseNameCI.get("note")).toHaveLength(2);
				expect(index.byFilePathKeyCI.get("note")).toHaveLength(2);

				// The backlink resolver reaches that ambiguity and records a backlink
				// for every candidate instead of guessing one.
				for (const route of routes) {
					expect(index.backlinks.get(route)?.map((ref) => ref.relativePath)).toEqual(["source.md"]);
				}
			},
		);
	});
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
