import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { VFile } from "vfile";
import { getCachedContentIndex } from "./content-index";
import { type MediaContext, resolveMediaSrc } from "./media";
import { normalizePluginOptions } from "./normalize-options";
import { remarkWikilink } from "./remark-wikilink";
import type { ContentIndex } from "./types";

let root: string;

beforeAll(() => {
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-media-")));
	fs.mkdirSync(path.join(root, "notes"), { recursive: true });
	fs.writeFileSync(path.join(root, "notes/Note.md"), "# Note\n");
});

afterAll(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function contextFor(index: ContentIndex): MediaContext {
	return {
		docsRoot: root,
		currentFilePath: path.join(root, "notes/Note.md"),
		index,
		enableCaseInsensitiveLookup: false,
		siteBase: "/",
		embedMedia: true,
		fileChecks: new Map(),
	};
}

describe("attachment lookups on disk", () => {
	// Each compiled page starts with no disk answers; the content index stays
	// the same object across pages because its signature never lists
	// `_`-prefixed files.
	const nextPage = async (): Promise<MediaContext> => contextFor(await getCachedContentIndex(root));

	test("a page answers a path once: an attachment added mid-page waits for the next", async () => {
		const draftPath = path.join(root, "notes/_draft.png");
		const page = await nextPage();
		expect(resolveMediaSrc("_draft.png", page).found).toBe(false);

		fs.writeFileSync(draftPath, "");
		expect(resolveMediaSrc("_draft.png", page).found).toBe(false);

		const next = await nextPage();
		expect(next.index).toBe(page.index);
		expect(resolveMediaSrc("_draft.png", next)).toMatchObject({
			found: true,
			url: "/notes/_draft.png",
		});
	});

	test("an attachment deleted in watch mode is gone from the next page", async () => {
		const gonePath = path.join(root, "notes/_gone.png");
		fs.writeFileSync(gonePath, "");
		const page = await nextPage();
		expect(resolveMediaSrc("_gone.png", page).found).toBe(true);

		fs.rmSync(gonePath);
		const next = await nextPage();
		expect(next.index).toBe(page.index);
		expect(resolveMediaSrc("_gone.png", next).found).toBe(false);
	});

	test("the remark pass used on its own sees an attachment added between runs", async () => {
		// One processor, as a site using `remarkWikilink` without `markdown()`
		// keeps it: nothing ever tells the pass a new build has started.
		const processor = unified()
			.use(remarkParse)
			.use(remarkWikilink, {
				getDocsRoot: () => root,
				options: normalizePluginOptions({ onBrokenLink: "warn" }),
			});
		const missing = async (): Promise<string[]> => {
			const file = new VFile({
				value: "![](_later.png)\n",
				path: path.join(root, "notes/Note.md"),
			});
			await processor.run(processor.parse(file), file);
			return file.messages.map((message) => message.reason).filter((r) => r.includes("_later"));
		};

		expect(await missing()).not.toEqual([]);
		fs.writeFileSync(path.join(root, "notes/_later.png"), "");
		expect(await missing()).toEqual([]);
	});
});
