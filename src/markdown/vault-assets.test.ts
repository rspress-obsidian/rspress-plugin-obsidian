import { describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFileRoutes } from "../shared/file-routes.js";
import { buildContentIndex } from "./content-index.js";
import { syncAssets, vaultFileForSiteUrl } from "./vault-assets.js";

describe("vaultFileForSiteUrl", () => {
	const root = path.resolve("/tmp/vault");

	test("maps a published URL to the file behind it", () => {
		expect(vaultFileForSiteUrl("/vault/media/x.png", root, "vault")).toBe(
			path.join(root, "media/x.png"),
		);
	});

	test("decodes the URL and ignores a query or fragment", () => {
		expect(vaultFileForSiteUrl("/vault/media/a%20b.png?w=1#top", root, "vault")).toBe(
			path.join(root, "media/a b.png"),
		);
	});

	test("refuses what the site never publishes", () => {
		expect(vaultFileForSiteUrl("/other/x.png", root, "vault")).toBeUndefined();
		expect(vaultFileForSiteUrl("/vault/.hidden.png", root, "vault")).toBeUndefined();
		expect(vaultFileForSiteUrl("/vault/.secret/x.png", root, "vault")).toBeUndefined();
		expect(vaultFileForSiteUrl("/vault/%2Ehidden.png", root, "vault")).toBeUndefined();
		expect(vaultFileForSiteUrl("/vault/../secret.png", root, "vault")).toBeUndefined();
		expect(vaultFileForSiteUrl("/vault/x.png", undefined, "vault")).toBeUndefined();
	});

	test("keeps a malformed escape literal instead of guessing", () => {
		expect(vaultFileForSiteUrl("/vault/%E0%A4%A.png", root, "vault")).toBeUndefined();
	});
});

describe("syncAssets", () => {
	test("stages the attachment a page links, even when the page text is gone", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "rspress-vault-assets-"));
		const docsRoot = path.join(workspace, "docs");
		const vaultRoot = path.join(workspace, "vault");
		const stagingDir = path.join(workspace, "staging");
		try {
			await fs.mkdir(vaultRoot, { recursive: true });
			await fs.mkdir(docsRoot, { recursive: true });
			await fs.writeFile(path.join(docsRoot, "photo.png"), "png");
			await fs.writeFile(path.join(docsRoot, "a.md"), "# A\n\n![[photo.png]]\n");
			await fs.writeFile(path.join(vaultRoot, "v.md"), "# V\n");
			const docs = await buildContentIndex(docsRoot);
			const vault = await buildContentIndex(vaultRoot, { routePrefix: "/vault" });
			// The published URL scan reads the page text again; a page deleted
			// between the index and the asset pass must not fail the build.
			await fs.rm(path.join(docsRoot, "a.md"));

			await syncAssets({
				stagingDir,
				vaultRoot,
				vaultRoutePrefix: "/vault",
				docs,
				vault,
				resolveOptions: { enableCaseInsensitiveLookup: true, enableFuzzyMatching: false },
				canvasBoards: () => undefined,
				fileRoutes: createFileRoutes(),
			});

			expect(await fs.readFile(path.join(stagingDir, "photo.png"), "utf8")).toBe("png");
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});

	test("stages an attachment but not a file that has a page", async () => {
		const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "rspress-vault-assets-"));
		const docsRoot = path.join(workspace, "docs");
		const vaultRoot = path.join(workspace, "vault");
		const stagingDir = path.join(workspace, "staging");
		try {
			await fs.mkdir(vaultRoot, { recursive: true });
			await fs.mkdir(docsRoot, { recursive: true });
			await fs.writeFile(path.join(vaultRoot, "photo.png"), "png");
			await fs.writeFile(path.join(vaultRoot, "Projects.base"), "views:\n");
			await fs.writeFile(path.join(vaultRoot, "v.md"), "![[Projects.base]] and [[photo.png]]\n");
			const docs = await buildContentIndex(docsRoot);
			const vault = await buildContentIndex(vaultRoot, { routePrefix: "/vault" });
			const fileRoutes = createFileRoutes();
			fileRoutes.set("bases", [
				{
					kind: "bases",
					absolutePath: path.join(vaultRoot, "Projects.base"),
					routePath: "/vault/Projects",
					source: "Projects.base",
				},
			]);

			await syncAssets({
				stagingDir,
				vaultRoot,
				vaultRoutePrefix: "/vault",
				docs,
				vault,
				resolveOptions: { enableCaseInsensitiveLookup: true, enableFuzzyMatching: false },
				canvasBoards: () => undefined,
				fileRoutes,
			});

			expect(await fs.readFile(path.join(stagingDir, "vault/photo.png"), "utf8")).toBe("png");
			expect(await fs.readdir(stagingDir)).toEqual(["vault"]);
		} finally {
			await fs.rm(workspace, { recursive: true, force: true });
		}
	});
});
