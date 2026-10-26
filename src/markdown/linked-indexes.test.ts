import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getCachedBacklinksIndex } from "./backlinks.js";
import { buildContentIndex } from "./content-index.js";
import { linkContentIndexes } from "./linked-indexes.js";
import { parseWikiLink } from "./parse-wikilink.js";
import { resolveWikiLink } from "./resolve-wikilink.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tree(files: Record<string, string>) {
	const root = await mkdtemp(path.join(tmpdir(), "linked-indexes-"));
	roots.push(root);
	for (const [name, content] of Object.entries(files)) {
		await writeFile(path.join(root, name), content);
	}
	return root;
}

describe("linkContentIndexes", () => {
	test("links each tree to the other without touching the indexes it is given", async () => {
		const docs = await buildContentIndex(await tree({ "index.md": "[[Plan]]\n" }));
		const vault = await buildContentIndex(await tree({ "Plan.md": "x\n" }), {
			routePrefix: "/vault",
		});

		const linked = linkContentIndexes(docs, vault);
		const docsPage = linked.docs.byFilePathKey.get("index");
		if (!docsPage) throw new Error("fixture page missing");

		const resolved = resolveWikiLink(parseWikiLink("Plan", "[[Plan]]"), {
			currentPage: docsPage,
			index: linked.docs,
		});
		expect(resolved.status).toBe("ok");
		expect(resolved.href).toBe("/vault/Plan");
		expect(
			(await getCachedBacklinksIndex(linked.vault ?? vault))
				.get("/vault/Plan")
				?.map((ref) => ref.routePath),
		).toEqual(["/"]);

		expect(docs.linkedIndexes).toBeUndefined();
		expect(vault.linkedIndexes).toBeUndefined();
		expect(
			resolveWikiLink(parseWikiLink("Plan", "[[Plan]]"), { currentPage: docsPage, index: docs })
				.status,
		).toBe("broken-page");
	});

	test("hands every reader of the same pair the same views", async () => {
		const docs = await buildContentIndex(await tree({ "index.md": "x\n" }));
		const vault = await buildContentIndex(await tree({ "Plan.md": "x\n" }));
		const other = await buildContentIndex(await tree({ "Other.md": "x\n" }));

		expect(linkContentIndexes(docs, vault)).toBe(linkContentIndexes(docs, vault));
		expect(linkContentIndexes(docs, other).docs).not.toBe(linkContentIndexes(docs, vault).docs);
		expect(linkContentIndexes(docs)).toEqual({ docs });
	});
});
