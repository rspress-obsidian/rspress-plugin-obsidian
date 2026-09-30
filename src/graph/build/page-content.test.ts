import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGraphBuildCache } from "./cache";
import { buildPageContentModule } from "./page-content";
import { PREVIEW_CONTENT_LENGTH } from "./preview-content";
import type { CollectedRoute } from "./types";

/** Build the client module for a single note whose body is `noteBody`. */
async function buildModuleFor(noteBody: string): Promise<string> {
	const rootDir = await mkdtemp(join(tmpdir(), "graph-page-content-"));

	try {
		const absolutePath = join(rootDir, "note.md");
		await writeFile(absolutePath, `---\ntitle: Note\n---\n\n${noteBody}`);

		const route: CollectedRoute = {
			routePath: "/note",
			absolutePath,
			relativePath: "note.md",
			pageName: "note",
		};
		const cache = createGraphBuildCache();
		cache.documents.set(absolutePath, {
			mtimeMs: 1,
			size: 1,
			contentHash: "hash",
			inferredTitle: "Note",
			names: [],
			rawLinks: [],
		});

		const { moduleSource } = await buildPageContentModule([route], cache);
		return moduleSource;
	} finally {
		await rm(rootDir, { recursive: true, force: true });
	}
}

/** The preview content the client receives for the single-note module. */
function shippedContent(moduleSource: string): string {
	const match = /^export const pageContentData = (.*); export default pageContentData;$/.exec(
		moduleSource,
	);
	const json = match?.[1];
	if (!json) throw new Error(`unexpected module source: ${moduleSource}`);

	const [page] = JSON.parse(json) as Array<{ content: string }>;
	if (!page) throw new Error("module shipped no page");
	return page.content;
}

describe("buildPageContentModule", () => {
	test("ships only the preview head of a long note", async () => {
		const noteBody = "x".repeat(4_000);
		const moduleSource = await buildModuleFor(noteBody);

		expect(moduleSource).toContain(noteBody.slice(0, PREVIEW_CONTENT_LENGTH + 1));
		expect(moduleSource).not.toContain(noteBody.slice(0, PREVIEW_CONTENT_LENGTH + 2));
		expect(moduleSource.length).toBeLessThan(noteBody.length);
	});

	test("ships a note that fits the preview budget in full", async () => {
		const noteBody = "A note short enough to preview whole.";
		const moduleSource = await buildModuleFor(noteBody);

		expect(moduleSource).toContain(noteBody);
	});

	test("ships the note body as plain prose without markdown markers", async () => {
		const noteBody = [
			"# Getting Started",
			"",
			"Install **the plugin** with `bun add x` and read [the guide](/guide/next).",
			"",
			"Then see [[Other Note|the other note]].",
		].join("\n");
		const moduleSource = await buildModuleFor(noteBody);

		expect(shippedContent(moduleSource)).toBe(
			"Getting Started Install the plugin with bun add x and read the guide. Then see the other note.",
		);
	});

	test("keeps arithmetic and snake_case intact", async () => {
		const noteBody = "Compute 2 * 3 while keeping snake_case intact.";
		const moduleSource = await buildModuleFor(noteBody);

		expect(shippedContent(moduleSource)).toBe(noteBody);
	});

	test("strips markers before spending the preview budget", async () => {
		const moduleSource = await buildModuleFor(`# ${"x".repeat(4_000)}`);

		expect(shippedContent(moduleSource)).toBe("x".repeat(PREVIEW_CONTENT_LENGTH + 1));
	});

	test("bounds the shipped payload by the sentinel budget", async () => {
		const moduleSource = await buildModuleFor(`## ${"word ".repeat(4_000)}`);
		const content = shippedContent(moduleSource);

		expect(content.length).toBe(PREVIEW_CONTENT_LENGTH + 1);
		expect(content.startsWith("word word ")).toBe(true);
	});
});
