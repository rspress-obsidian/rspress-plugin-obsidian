import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { caseSensitiveFilesystem } from "../../test/case-sensitive-fs.js";
import { KATEX_STYLESHEET_PATH } from "../katex-stylesheet.js";
import { markdown } from "../markdown/index";
import { findCanvasBoards } from "../shared/canvas-routes.js";
import { canvas } from "./index";
import { parseCanvas } from "./parser";
import type { CanvasData, CanvasFileData, CanvasGroupData } from "./types";

/**
 * A real symlink needs Developer Mode or elevation on Windows (EPERM
 * otherwise) — a machine setting, not a regression. Probe once and skip the
 * link-dependent tests rather than fail a contributor's checkout; junctions are
 * no substitute, since the links point at files.
 */
const symlinksSupported = (() => {
	const probe = mkdtempSync(path.join(tmpdir(), "canvas-symlink-probe-"));
	const target = path.join(probe, "target");
	try {
		writeFileSync(target, "");
		symlinkSync(target, path.join(probe, "link"));
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "EPERM" && code !== "EACCES" && code !== "ENOTSUP") throw error;
		return false;
	} finally {
		rmSync(probe, { recursive: true, force: true });
	}
})();

if (!symlinksSupported) {
	console.warn(
		"canvas symlink tests skipped: this account cannot create symlinks (enable Windows Developer Mode)",
	);
}

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface VaultFixture {
	root: string;
	vault: string;
	docs: string;
	outside: string;
	out: string;
}

async function createVaultFixture(): Promise<VaultFixture> {
	const root = await mkdtemp(path.join(tmpdir(), "canvas-vault-"));
	tempDirs.push(root);
	const vault = path.join(root, "vault");
	const docs = path.join(root, "docs");
	const outside = path.join(root, "outside");
	const out = path.join(root, "out");
	await mkdir(path.join(vault, "Notes"), { recursive: true });
	await mkdir(outside, { recursive: true });
	await mkdir(docs, { recursive: true });
	return { root, vault, docs, outside, out };
}

function vaultPlugin({ vault, out }: VaultFixture) {
	return canvas({ vaultRoot: vault, fileRoutePrefix: "/vault", outDir: out });
}

async function readPublished(fixture: VaultFixture, name = "Board"): Promise<CanvasData> {
	return parseCanvas(
		await readFile(path.join(fixture.out, "__canvases__", `${name}.json`), "utf-8"),
		{
			enriched: true,
		},
	);
}

async function publishBoard(board: CanvasData, fixture: VaultFixture) {
	await writeFile(path.join(fixture.vault, "Board.canvas"), JSON.stringify(board));
	const pages = await vaultPlugin(fixture).addPages?.({ root: fixture.docs }, false);
	const raw = await readFile(path.join(fixture.out, "__canvases__", "Board.json"), "utf-8");
	return { pages, published: await readPublished(fixture), raw };
}

function fileCard(id: string, file: string, subpath?: string): CanvasFileData {
	return { id, type: "file", x: 0, y: 0, width: 100, height: 100, file, subpath };
}

function publishedFileNode(data: CanvasData, id: string): CanvasFileData {
	const node = data.nodes.find((item) => item.id === id);
	if (node?.type !== "file") throw new Error(`no published file node ${id}`);
	return node;
}

function publishedGroupNode(data: CanvasData, id: string): CanvasGroupData {
	const node = data.nodes.find((item) => item.id === id);
	if (node?.type !== "group") throw new Error(`no published group node ${id}`);
	return node;
}

describe("canvas vault containment", () => {
	test.skipIf(!symlinksSupported)(
		"reads vault files that resolve inside the vault, symlink or not",
		async () => {
			const fixture = await createVaultFixture();
			await writeFile(path.join(fixture.vault, "Notes", "Welcome.md"), "# Welcome\n\ninside");
			await symlink(
				path.join(fixture.vault, "Notes", "Welcome.md"),
				path.join(fixture.vault, "Linked-Inside.md"),
			);

			const { published } = await publishBoard(
				{
					nodes: [fileCard("direct", "Notes/Welcome.md"), fileCard("linked", "Linked-Inside.md")],
					edges: [],
				},
				fixture,
			);

			// The index skips symlinks, so only the real file is published.
			expect(publishedFileNode(published, "direct").resolvedFile?.kind).toBe("note");
			expect(published.notes?.["notes/welcome.md"]).toContain("inside");
			expect(publishedFileNode(published, "linked").resolvedFile?.kind).not.toBe("note");
		},
	);

	test.skipIf(!symlinksSupported)(
		"neither reads nor publishes a vault path that resolves outside the vault",
		async () => {
			const fixture = await createVaultFixture();
			await writeFile(path.join(fixture.outside, "Secret.md"), "# Secret\n\nOUTSIDE-CONTENT");
			await writeFile(path.join(fixture.outside, "secret.png"), "OUTSIDE-BYTES");
			await symlink(
				path.join(fixture.outside, "Secret.md"),
				path.join(fixture.vault, "Linked-Outside.md"),
			);
			await symlink(
				path.join(fixture.outside, "secret.png"),
				path.join(fixture.vault, "linked-outside.png"),
			);

			const { pages, published, raw } = await publishBoard(
				{
					nodes: [
						fileCard("leak-note", "Linked-Outside.md"),
						fileCard("leak-asset", "linked-outside.png"),
					],
					edges: [],
				},
				fixture,
			);

			expect(publishedFileNode(published, "leak-note").resolvedFile?.key).toBeUndefined();
			expect(publishedFileNode(published, "leak-asset").resolvedFile?.key).toBeUndefined();
			expect(published.notes).toBeUndefined();
			expect(published.assets).toBeUndefined();
			expect(JSON.stringify(pages?.map((page) => page.content))).not.toContain("OUTSIDE-CONTENT");
			expect(raw).not.toContain("OUTSIDE");
			expect(existsSync(path.join(fixture.out, "vault", "linked-outside.png"))).toBe(false);
		},
	);

	test.skipIf(!symlinksSupported)(
		"ignores canvas files reached through a symlinked file or directory",
		async () => {
			const fixture = await createVaultFixture();
			await writeFile(
				path.join(fixture.outside, "Outside.canvas"),
				JSON.stringify({ nodes: [], edges: [] }),
			);
			await symlink(fixture.outside, path.join(fixture.vault, "linked-dir"));
			await symlink(
				path.join(fixture.outside, "Outside.canvas"),
				path.join(fixture.vault, "Linked.canvas"),
			);
			await writeFile(
				path.join(fixture.vault, "Board.canvas"),
				JSON.stringify({ nodes: [], edges: [] }),
			);

			const pages = await vaultPlugin(fixture).addPages?.({ root: fixture.docs }, false);

			expect(pages?.map((page) => page.routePath)).toEqual(["/canvas/board"]);
		},
	);

	test("publishes its boards for the site's wikilink resolver", async () => {
		const fixture = await createVaultFixture();
		await writeFile(
			path.join(fixture.vault, "Demo.canvas"),
			JSON.stringify({ nodes: [], edges: [] }),
		);
		await writeFile(
			path.join(fixture.vault, "Notes", "Nested Board.canvas"),
			JSON.stringify({ nodes: [], edges: [] }),
		);

		const plugin = vaultPlugin(fixture);
		const pages = await plugin.addPages?.({ root: fixture.docs }, false);
		const boards = await findCanvasBoards({ plugins: [plugin] });

		expect(pages).toHaveLength(2);
		expect(boards?.byPath(path.join(fixture.vault, "Demo.canvas"))?.routePath).toBe("/canvas/demo");
		expect(
			boards?.byPath(path.join(fixture.vault, "Notes", "Nested Board.canvas"))?.routePath,
		).toBe("/canvas/notes/nested-board");
		// A file the scan never saw stays unpublished, so resolution falls back
		// to treating it as an ordinary attachment.
		expect(boards?.byPath(path.join(fixture.vault, "Excluded.canvas"))).toBeUndefined();
	});

	test("a reader asking while the scan runs waits for that scan's boards", async () => {
		const fixture = await createVaultFixture();
		await writeFile(path.join(fixture.vault, "Demo.canvas"), JSON.stringify({ nodes: [] }));
		const plugin = vaultPlugin(fixture);
		// Rspress starts every plugin's `addPages` at once; a sibling reads the
		// boards before this one has finished.
		const running = plugin.addPages?.({ root: fixture.docs }, false);
		const boards = await findCanvasBoards({ plugins: [plugin] });
		expect(boards?.bySource("Demo.canvas")?.routePath).toBe("/canvas/demo");
		await running;
	});

	test("skips boards under `_` folders, as the content index skips notes", async () => {
		const fixture = await createVaultFixture();
		for (const name of ["_private/Hidden.canvas", "__kept/Shown.canvas", "Templates/T.canvas"]) {
			await mkdir(path.dirname(path.join(fixture.vault, name)), { recursive: true });
			await writeFile(path.join(fixture.vault, name), JSON.stringify({ nodes: [] }));
		}
		const pages = await vaultPlugin(fixture).addPages?.({ root: fixture.docs }, false);
		expect(pages?.map((page) => page.routePath)).toEqual([
			"/canvas/templates/t",
			"/canvas/__kept/shown",
		]);
		expect(existsSync(path.join(fixture.out, "__canvases__", "_private"))).toBe(false);
	});

	test("skips boards in the folders the markdown feature excludes from the vault", async () => {
		const fixture = await createVaultFixture();
		for (const name of ["Templates/T.canvas", "Board.canvas"]) {
			await mkdir(path.dirname(path.join(fixture.vault, name)), { recursive: true });
			await writeFile(path.join(fixture.vault, name), JSON.stringify({ nodes: [] }));
		}
		// Templater keeps its templates folder out of the site.
		const md = markdown({
			vaultRoot: fixture.vault,
			enableTemplater: true,
			templater: { templatesFolder: "Templates" },
		});
		const plugin = vaultPlugin(fixture);
		const pages = await plugin.addPages?.({ root: fixture.docs, plugins: [md, plugin] }, false);
		expect(pages?.map((page) => page.routePath)).toEqual(["/canvas/board"]);
	});

	test("a card linking a board the scan left out does not publish the raw file", async () => {
		const fixture = await createVaultFixture();
		await mkdir(path.join(fixture.vault, "Drafts"), { recursive: true });
		await writeFile(
			path.join(fixture.vault, "Drafts", "Draft.canvas"),
			JSON.stringify({
				nodes: [{ id: "x", type: "text", text: "%%SECRET%%", x: 0, y: 0, width: 1, height: 1 }],
			}),
		);
		const card = {
			id: "t",
			type: "text",
			x: 0,
			y: 0,
			width: 1,
			height: 1,
			text: "[[Draft.canvas]]",
		};
		await writeFile(path.join(fixture.vault, "Board.canvas"), JSON.stringify({ nodes: [card] }));
		await canvas({
			vaultRoot: fixture.vault,
			fileRoutePrefix: "/vault",
			outDir: fixture.out,
			exclude: ["Drafts/**"],
		}).addPages?.({ root: fixture.docs }, false);

		const published = await readPublished(fixture);
		expect(published.links?.[""]?.["Draft.canvas"]).toEqual({});
		expect(existsSync(path.join(fixture.out, "vault", "Drafts"))).toBe(false);
	});
});

describe("canvas publishing", () => {
	const WELCOME_NOTE = [
		"---",
		"title: Welcome",
		"---",
		"",
		"# Getting Started",
		"",
		"Body text here. ^intro",
		"",
		"## Next",
		"",
		"More.",
	].join("\n");

	async function writeVaultFiles(fixture: VaultFixture): Promise<void> {
		await writeFile(path.join(fixture.vault, "Notes", "Welcome.md"), WELCOME_NOTE);
		await mkdir(path.join(fixture.vault, "attachments"), { recursive: true });
		await writeFile(path.join(fixture.vault, "attachments", "pic.png"), "PNG-BYTES");
		await writeFile(path.join(fixture.vault, "clip.mp3"), "MP3-BYTES");
		await writeFile(path.join(fixture.vault, "movie.mkv"), "MKV-BYTES");
		await writeFile(path.join(fixture.vault, "doc.pdf"), "PDF-BYTES");
		await writeFile(path.join(fixture.vault, "archive.zip"), "ZIP-BYTES");
		await writeFile(path.join(fixture.vault, "photo.bmp"), "BMP-BYTES");
	}

	test("publishes media as files referenced by URL, each stored once", async () => {
		const fixture = await createVaultFixture();
		await writeVaultFiles(fixture);

		const { published, raw, pages } = await publishBoard(
			{
				nodes: [
					fileCard("image", "attachments/pic.png"),
					fileCard("bmp", "photo.bmp"),
					fileCard("audio", "clip.mp3"),
					fileCard("video", "movie.mkv"),
					fileCard("pdf", "doc.pdf"),
					fileCard("zip", "archive.zip"),
					{
						id: "group",
						type: "group",
						x: 0,
						y: 0,
						width: 300,
						height: 300,
						label: "Zone",
						background: "attachments/pic.png",
						backgroundStyle: "repeat",
					},
				],
				edges: [],
			},
			fixture,
		);

		expect(
			Object.fromEntries(
				["image", "bmp", "audio", "video", "pdf", "zip"].map((id) => [
					id,
					publishedFileNode(published, id).resolvedFile,
				]),
			),
		).toEqual({
			image: { kind: "image", key: "attachments/pic.png" },
			bmp: { kind: "image", key: "photo.bmp" },
			audio: { kind: "audio", key: "clip.mp3" },
			video: { kind: "video", key: "movie.mkv" },
			pdf: { kind: "pdf", key: "doc.pdf" },
			zip: { kind: "file", key: "archive.zip" },
		});
		expect(publishedGroupNode(published, "group").resolvedBackground).toBe("attachments/pic.png");
		expect(published.assets?.["attachments/pic.png"]).toBe("/vault/attachments/pic.png");
		// The bytes are copied to the URL they are served at, never inlined.
		expect(await readFile(path.join(fixture.out, "vault", "attachments", "pic.png"), "utf-8")).toBe(
			"PNG-BYTES",
		);
		expect(await readFile(path.join(fixture.out, "vault", "archive.zip"), "utf-8")).toBe(
			"ZIP-BYTES",
		);
		expect(raw).not.toContain("base64");
		// The image is used twice and listed once.
		expect(raw.split("/vault/attachments/pic.png")).toHaveLength(2);
		// The route page names the board; it does not carry it.
		expect(pages?.[0]?.content).toContain('src={"Board.canvas"}');
		expect(pages?.[0]?.content).not.toContain("nodes");
	});

	test("rebuilds its output each time, so removed boards and files stop being published", async () => {
		const fixture = await createVaultFixture();
		await writeVaultFiles(fixture);
		await writeFile(
			path.join(fixture.vault, "Old.canvas"),
			JSON.stringify({ nodes: [fileCard("img", "attachments/pic.png")] }),
		);
		await vaultPlugin(fixture).addPages?.({ root: fixture.docs }, false);
		expect(existsSync(path.join(fixture.out, "__canvases__", "Old.json"))).toBe(true);
		expect(existsSync(path.join(fixture.out, "vault", "attachments", "pic.png"))).toBe(true);

		await rm(path.join(fixture.vault, "Old.canvas"));
		// A previous version of the plugin wrote board JSON into the site's public/.
		await mkdir(path.join(fixture.docs, "public", "__canvases__"), { recursive: true });
		await writeFile(path.join(fixture.docs, "public", "__canvases__", "Stale.json"), "{}");
		await writeFile(path.join(fixture.vault, "New.canvas"), JSON.stringify({ nodes: [] }));
		await vaultPlugin(fixture).addPages?.({ root: fixture.docs }, false);

		expect(existsSync(path.join(fixture.out, "__canvases__", "Old.json"))).toBe(false);
		expect(existsSync(path.join(fixture.out, "vault", "attachments", "pic.png"))).toBe(false);
		expect(existsSync(path.join(fixture.out, "__canvases__", "New.json"))).toBe(true);
		expect(existsSync(path.join(fixture.docs, "public", "__canvases__"))).toBe(false);
	});

	test("serves its output as a public directory and learns the site base", async () => {
		const fixture = await createVaultFixture();
		await writeFile(path.join(fixture.vault, "Board.canvas"), JSON.stringify({ nodes: [] }));
		const plugin = vaultPlugin(fixture);
		await plugin.addPages?.({ root: fixture.docs, base: "/docs/" }, false);
		const server = plugin.builderConfig?.server as { publicDir?: { name: string }[] };
		expect(server.publicDir?.map((entry) => entry.name)).toEqual([fixture.out]);
		expect(plugin.builderConfig?.source?.define).toEqual({
			__RSPRESS_OBSIDIAN_CANVAS_BASE__: JSON.stringify("/docs/"),
			__RSPRESS_OBSIDIAN_KATEX_STYLESHEET__: JSON.stringify(KATEX_STYLESHEET_PATH),
		});
		// Cards typeset math in the browser, which loads KaTeX's stylesheet from
		// the directory this plugin publishes rather than the global stylesheet.
		const builderPlugins = (plugin.builderConfig?.plugins ?? []) as Array<{ name?: string }>;
		expect(builderPlugins.map((builderPlugin) => builderPlugin.name)).toContain(
			"rspress-plugin-obsidian:katex-stylesheet",
		);
	});

	test("resolves card links like Obsidian: shortest path, relative, and per note", async () => {
		const fixture = await createVaultFixture();
		await writeVaultFiles(fixture);
		await mkdir(path.join(fixture.vault, "notes"), { recursive: true });
		await writeFile(path.join(fixture.vault, "notes", "Loose.md"), "Loose body [[Welcome]]");
		await mkdir(path.join(fixture.vault, "Boards"), { recursive: true });
		await writeFile(path.join(fixture.vault, "Boards", "Sibling.md"), "sibling");
		await writeFile(
			path.join(fixture.vault, "Boards", "Board.canvas"),
			JSON.stringify({
				nodes: [
					{
						id: "t",
						type: "text",
						x: 0,
						y: 0,
						width: 10,
						height: 10,
						text: "![[pic.png]] [[Loose]] ![[Loose]] [[./Sibling]] [[Nowhere]] ![](my%20pic.png) [x](https://e.com)",
					},
				],
			}),
		);
		await writeFile(path.join(fixture.vault, "my pic.png"), "PNG");
		await vaultPlugin(fixture).addPages?.({ root: fixture.docs }, false);
		const published = await readPublished(fixture, "Boards/Board");
		const links = published.links?.[""] ?? {};

		expect(links["pic.png"]).toMatchObject({ asset: "attachments/pic.png" });
		expect(links.Loose?.href).toMatch(/^\/vault\/notes\/loose$/i);
		expect(links.Loose?.note).toBe("notes/loose.md");
		expect(links["./Sibling"]?.href).toMatch(/^\/vault\/boards\/sibling$/i);
		expect(links.Nowhere).toEqual({});
		expect(links["my pic.png"]).toMatchObject({ asset: "my pic.png" });
		expect(links["https://e.com"]).toBeUndefined();
		expect(published.assets?.["my pic.png"]).toBe("/vault/my%20pic.png");
		// The transcluded note's own links resolve in its own scope.
		expect(published.links?.["notes/loose.md"]?.Welcome?.href).toMatch(
			/^\/vault\/notes\/welcome$/i,
		);
	});

	test("never publishes a publish: false note, by file node or by transclusion", async () => {
		const fixture = await createVaultFixture();
		await writeFile(
			path.join(fixture.vault, "Private.md"),
			"---\npublish: false\n---\nSECRET-BODY",
		);
		const { published, raw } = await publishBoard(
			{
				nodes: [
					fileCard("file", "Private.md"),
					{
						id: "t",
						type: "text",
						x: 0,
						y: 0,
						width: 1,
						height: 1,
						text: "![[Private]] [[Private]]",
					},
				],
				edges: [],
			},
			fixture,
		);
		expect(publishedFileNode(published, "file").resolvedFile).toEqual({ kind: "private" });
		expect(published.links?.[""]?.Private).toEqual({});
		expect(published.notes).toBeUndefined();
		expect(raw).not.toContain("SECRET-BODY");
	});

	test("publishes a private card without the path or subpath it names", async () => {
		const fixture = await createVaultFixture();
		await writeFile(
			path.join(fixture.vault, "Unpublished-Plan.md"),
			"---\npublish: false\n---\nbody",
		);
		await mkdir(path.join(fixture.vault, ".hidden"), { recursive: true });
		await writeFile(path.join(fixture.vault, ".hidden", "Diary-2026.md"), "# Tax plans\n\nbody");
		const { published, raw } = await publishBoard(
			{
				nodes: [
					fileCard("unpublished", "Unpublished-Plan.md"),
					fileCard("dotfile", ".hidden/Diary-2026.md", "#Tax plans"),
				],
				edges: [],
			},
			fixture,
		);
		for (const id of ["unpublished", "dotfile"]) {
			expect(publishedFileNode(published, id)).toMatchObject({
				file: "",
				resolvedFile: { kind: "private" },
			});
			expect(publishedFileNode(published, id).subpath).toBeUndefined();
		}
		expect(raw).not.toContain("Unpublished-Plan");
		expect(raw).not.toContain("Diary-2026");
		expect(raw).not.toContain(".hidden");
		expect(raw).not.toContain("Tax plans");
	});

	test("strips %%comments%% from text cards and from the notes cards show", async () => {
		const fixture = await createVaultFixture();
		await writeFile(
			path.join(fixture.vault, "Shown.md"),
			"---\ntitle: Shown\n---\nVisible %%NOTE-SECRET%% text\n\n%%\nBLOCK-SECRET\n%%\n\n`%%code%%` stays\n",
		);
		await writeFile(path.join(fixture.vault, "Embedded.md"), "Embedded %%EMBED-SECRET%% body\n");
		const { published, raw } = await publishBoard(
			{
				nodes: [
					fileCard("file", "Shown.md"),
					{
						id: "t",
						type: "text",
						x: 0,
						y: 0,
						width: 1,
						height: 1,
						text: "Card %%CARD-SECRET%% text ![[Embedded]] %%[[Hidden-Link]]%%",
					},
				],
				edges: [],
			},
			fixture,
		);
		for (const secret of ["NOTE-SECRET", "BLOCK-SECRET", "EMBED-SECRET", "CARD-SECRET"]) {
			expect(raw).not.toContain(secret);
		}
		// A link inside a comment is not on the board, so it is not resolved either.
		expect(raw).not.toContain("Hidden-Link");
		const text = published.nodes.find((node) => node.id === "t");
		expect(text?.type === "text" && text.text).toBe("Card  text ![[Embedded]] ");
		expect(published.notes?.["shown.md"]).toContain("Visible  text");
		expect(published.notes?.["shown.md"]).toContain("`%%code%%` stays");
		expect(published.notes?.["embedded.md"]).toBe("Embedded  body\n");
	});

	test("strips HTML comments outside code from text cards and the notes cards show", async () => {
		const fixture = await createVaultFixture();
		await writeFile(
			path.join(fixture.vault, "Shown.md"),
			"Visible <!-- NOTE-SECRET --> text\n\n<!--\nBLOCK-SECRET\n-->\n\n`<!-- code -->` stays\n",
		);
		const { published, raw } = await publishBoard(
			{
				nodes: [
					fileCard("file", "Shown.md"),
					{
						id: "t",
						type: "text",
						x: 0,
						y: 0,
						width: 1,
						height: 1,
						text: "Card <!-- CARD-SECRET --> text <!-- UNCLOSED-SECRET",
					},
				],
				edges: [],
			},
			fixture,
		);
		for (const secret of ["NOTE-SECRET", "BLOCK-SECRET", "CARD-SECRET", "UNCLOSED-SECRET"]) {
			expect(raw).not.toContain(secret);
		}
		const text = published.nodes.find((node) => node.id === "t");
		expect(text?.type === "text" && text.text).toBe("Card  text ");
		expect(published.notes?.["shown.md"]).toContain("Visible  text");
		expect(published.notes?.["shown.md"]).toContain("`<!-- code -->` stays");
	});

	test("strips comments in a body that opens with a rule, as the note page does", async () => {
		const fixture = await createVaultFixture();
		// After the real frontmatter, `---` … `---` is two rules around a
		// paragraph, not a second frontmatter block.
		await writeFile(
			path.join(fixture.vault, "Ruled.md"),
			"---\ntitle: Ruled\n---\n---\ntext %% NOTE-SECRET %%\n---\n",
		);
		const { published, raw } = await publishBoard(
			{
				nodes: [
					fileCard("ruled", "Ruled.md"),
					{
						id: "t",
						type: "text",
						x: 0,
						y: 0,
						width: 1,
						height: 1,
						text: "---\ncard %% CARD-SECRET %%\n---",
					},
				],
				edges: [],
			},
			fixture,
		);
		expect(raw).not.toContain("NOTE-SECRET");
		expect(raw).not.toContain("CARD-SECRET");
		expect(published.notes?.["ruled.md"]).toBe("---\ntext \n---\n");
		const text = published.nodes.find((node) => node.id === "t");
		expect(text?.type === "text" && text.text).toBe("---\ncard \n---");
	});

	test("publishes private attachments and boards of every kind without their paths", async () => {
		const fixture = await createVaultFixture();
		await mkdir(path.join(fixture.vault, ".hidden"), { recursive: true });
		await mkdir(path.join(fixture.vault, "_drafts"), { recursive: true });
		await writeFile(path.join(fixture.vault, ".hidden", "Passport-scan.png"), "png");
		await writeFile(path.join(fixture.vault, "_drafts", "Salary-review.pdf"), "pdf");
		await writeFile(
			path.join(fixture.vault, ".hidden", "Secret-board.canvas"),
			JSON.stringify({ nodes: [], edges: [] }),
		);
		const { published, raw } = await publishBoard(
			{
				nodes: [
					fileCard("image", ".hidden/Passport-scan.png"),
					fileCard("pdf", "_drafts/Salary-review.pdf", "#page=2"),
					fileCard("board", ".hidden/Secret-board.canvas"),
					fileCard("gone", "Never-existed.png"),
				],
				edges: [],
			},
			fixture,
		);
		for (const id of ["image", "pdf", "board"]) {
			expect(publishedFileNode(published, id)).toMatchObject({
				file: "",
				resolvedFile: { kind: "private" },
			});
			expect(publishedFileNode(published, id).subpath).toBeUndefined();
		}
		for (const name of ["Passport-scan", "Salary-review", "Secret-board", ".hidden", "_drafts"]) {
			expect(raw).not.toContain(name);
		}
		// Not on disk at all: missing, and the card still names what it wanted.
		expect(publishedFileNode(published, "gone")).toMatchObject({
			file: "Never-existed.png",
			resolvedFile: { kind: "missing" },
		});
	});

	test("publishes a group whose background is private without its path", async () => {
		const fixture = await createVaultFixture();
		await mkdir(path.join(fixture.vault, ".hidden"), { recursive: true });
		await writeFile(path.join(fixture.vault, ".hidden", "Backdrop-secret.png"), "png");
		const group = (id: string, background: string): CanvasGroupData => ({
			id,
			type: "group",
			x: 0,
			y: 0,
			width: 10,
			height: 10,
			background,
		});
		const { published, raw } = await publishBoard(
			{
				nodes: [group("private", ".hidden/Backdrop-secret.png"), group("gone", "Never-there.png")],
				edges: [],
			},
			fixture,
		);
		const groups = new Map(published.nodes.map((node) => [node.id, node as CanvasGroupData]));
		expect(groups.get("private")?.background).toBeUndefined();
		expect(groups.get("private")?.resolvedBackground).toBeUndefined();
		expect(raw).not.toContain("Backdrop-secret");
		expect(raw).not.toContain(".hidden");
		// Not on disk at all: missing, and the group still names what it wanted.
		expect(groups.get("gone")?.background).toBe("Never-there.png");
	});

	test("a private file named in another case is still private", async () => {
		const fixture = await createVaultFixture();
		await mkdir(path.join(fixture.vault, "_drafts"), { recursive: true });
		await writeFile(path.join(fixture.vault, "_drafts", "Salary-review.pdf"), "pdf");
		const { published, raw } = await publishBoard(
			{ nodes: [fileCard("pdf", "_DRAFTS/salary-REVIEW.pdf")], edges: [] },
			fixture,
		);
		expect(publishedFileNode(published, "pdf")).toMatchObject({
			file: "",
			resolvedFile: { kind: "private" },
		});
		expect(raw.toLowerCase()).not.toContain("salary");
	});

	test("passes an empty iframeSandbox through as the strictest sandbox", async () => {
		const fixture = await createVaultFixture();
		await writeFile(
			path.join(fixture.vault, "Board.canvas"),
			JSON.stringify({ nodes: [], edges: [] }),
		);
		const pages = await canvas({
			vaultRoot: fixture.vault,
			outDir: fixture.out,
			iframeSandbox: "",
		}).addPages?.({ root: fixture.docs }, false);
		expect(pages?.[0]?.content).toContain('iframeSandbox={""}');
	});

	test("file-node subpaths use the shared slicer and fall back to the whole note", async () => {
		const fixture = await createVaultFixture();
		await writeVaultFiles(fixture);
		await writeFile(
			path.join(fixture.vault, "Notes", "Deep.md"),
			"# Parent\n\n## Child\n\n```bash\n# not a heading\n```\n\nchild body\n\n# Other\n",
		);
		const { published } = await publishBoard(
			{
				nodes: [
					fileCard("nested", "Notes/Deep.md", "#Parent#Child"),
					fileCard("block", "Notes/Welcome.md", "#^intro"),
					fileCard("missing", "Notes/Welcome.md", "#Nope"),
				],
				edges: [],
			},
			fixture,
		);
		// Frontmatter is stripped before the note is published.
		expect(published.notes?.["notes/welcome.md"]).not.toContain("title: Welcome");
		expect(publishedFileNode(published, "nested").resolvedFile).toMatchObject({
			kind: "note",
			key: "notes/deep.md",
		});
		expect(publishedFileNode(published, "nested").resolvedFile?.missingSubpath).toBeUndefined();
		expect(publishedFileNode(published, "block").resolvedFile?.missingSubpath).toBeUndefined();
		expect(publishedFileNode(published, "missing").resolvedFile).toMatchObject({
			kind: "note",
			missingSubpath: true,
		});
		expect(publishedFileNode(published, "missing").resolvedFile?.href).toMatch(
			/^\/vault\/notes\/welcome$/i,
		);
	});

	test("a file node naming another board links to that board's page", async () => {
		const fixture = await createVaultFixture();
		await writeFile(path.join(fixture.vault, "Other.canvas"), JSON.stringify({ nodes: [] }));
		const { published } = await publishBoard(
			{ nodes: [fileCard("board", "Other.canvas"), fileCard("gone", "Gone.canvas")], edges: [] },
			fixture,
		);
		expect(publishedFileNode(published, "board").resolvedFile).toEqual({
			kind: "canvas",
			href: "/canvas/other",
		});
		expect(publishedFileNode(published, "gone").resolvedFile).toEqual({ kind: "missing" });
	});

	test("warns and marks the card when a file is missing", async () => {
		const fixture = await createVaultFixture();
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(args.join(" "));
		};
		try {
			const { published } = await publishBoard(
				{
					nodes: [fileCard("gone", "Notes/Missing.md"), fileCard("gone-asset", "broken.png")],
					edges: [],
				},
				fixture,
			);
			expect(publishedFileNode(published, "gone").resolvedFile).toEqual({ kind: "missing" });
			expect(publishedFileNode(published, "gone-asset").resolvedFile).toEqual({ kind: "missing" });
			expect(published.assets).toBeUndefined();
		} finally {
			console.warn = originalWarn;
		}
		expect(warnings.join("\n")).toContain("Notes/Missing.md");
		expect(warnings.join("\n")).toContain("broken.png");
	});

	// A document-level failure leaves nothing that is safe to publish: the
	// source board still holds the comments and private paths enrichment
	// strips, so no JSON is written (the viewer shows its load error) and the
	// build keeps going.
	test.each([
		["unparseable JSON", "{ not json"],
		[
			"edges that are not a list",
			JSON.stringify({
				nodes: [
					{ id: "t", type: "text", x: 0, y: 0, width: 1, height: 1, text: "%%RAW-SECRET%%" },
					{ id: "f", type: "file", x: 0, y: 0, width: 1, height: 1, file: ".hidden/Diary.md" },
				],
				edges: "nope",
			}),
		],
	])("publishes no board JSON when enrichment fails (%s)", async (_name, source) => {
		const fixture = await createVaultFixture();
		const errors: string[] = [];
		const originalError = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args.join(" "));
		};
		let routePaths: string[] = [];
		try {
			await writeFile(path.join(fixture.vault, "Board.canvas"), source);
			const pages = await vaultPlugin(fixture).addPages?.({ root: fixture.docs }, false);
			routePaths = pages?.map((page) => page.routePath) ?? [];
		} finally {
			console.error = originalError;
		}

		expect(errors.join("\n")).toContain("Failed to process canvas file");
		expect(routePaths).toEqual(["/canvas/board"]);
		expect(existsSync(path.join(fixture.out, "__canvases__", "Board.json"))).toBe(false);
	});

	// A single malformed card no longer costs the whole board: the node is
	// dropped, the reason is reported, and the rest of the board still renders.
	test("publishes a board with a malformed node and reports what it skipped", async () => {
		const fixture = await createVaultFixture();
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(args.join(" "));
		};
		let routePaths: string[] = [];
		try {
			await writeFile(
				path.join(fixture.vault, "Board.canvas"),
				JSON.stringify({
					nodes: [
						{ id: "n", type: "blob", x: 0, y: 0, width: 10, height: 10 },
						{ id: "ok", type: "text", x: 0, y: 0, width: 10, height: 10, text: "hi" },
					],
					edges: [],
				}),
			);
			const pages = await vaultPlugin(fixture).addPages?.({ root: fixture.docs }, false);
			routePaths = pages?.map((page) => page.routePath) ?? [];
		} finally {
			console.warn = originalWarn;
		}

		expect(warnings.join("\n")).toContain('Skipped node 0 "n"');
		expect(routePaths).toEqual(["/canvas/board"]);
	});

	test.skipIf(!caseSensitiveFilesystem)(
		"reports a route collision instead of publishing one canvas twice",
		async () => {
			const fixture = await createVaultFixture();
			await writeFile(
				path.join(fixture.vault, "Board.canvas"),
				JSON.stringify({ nodes: [], edges: [] }),
			);
			await writeFile(
				path.join(fixture.vault, "board.canvas"),
				JSON.stringify({ nodes: [], edges: [] }),
			);

			await expect(vaultPlugin(fixture).addPages?.({ root: fixture.docs }, false)).rejects.toThrow(
				/route collision/,
			);
		},
	);
});

describe("canvas plugin options", () => {
	test("injects the canvas stylesheet by default", () => {
		expect(typeof canvas().globalStyles).toBe("string");
		expect(typeof canvas({ vaultRoot: "/tmp/vault" }).globalStyles).toBe("string");
	});

	test("link nodes preview the site by default, like Obsidian", async () => {
		const fixture = await createVaultFixture();
		await writeFile(path.join(fixture.vault, "Board.canvas"), JSON.stringify({ nodes: [] }));
		const pages = await vaultPlugin(fixture).addPages?.({ root: fixture.docs }, false);
		expect(pages?.[0]?.content).toContain("linkPreview={true}");
		const off = await canvas({
			vaultRoot: fixture.vault,
			outDir: fixture.out,
			linkPreview: false,
		}).addPages?.({ root: fixture.docs }, false);
		expect(off?.[0]?.content).toContain("linkPreview={false}");
	});

	test("enableDefaultStyles: false leaves the stylesheet out", () => {
		expect(canvas({ enableDefaultStyles: false }).globalStyles).toBeUndefined();
	});

	test("warns only when a vault root is set without a file route prefix", () => {
		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(args.join(" "));
		};
		try {
			canvas({ vaultRoot: "/tmp/vault" });
			canvas({ vaultRoot: "/tmp/vault", fileRoutePrefix: "/vault" });
			canvas({ fileRoutePrefix: "/vault" });
			canvas();
		} finally {
			console.warn = originalWarn;
		}

		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("fileRoutePrefix");
	});
});

describe("canvas defaults", () => {
	const emptyBoard = JSON.stringify({ nodes: [], edges: [] });

	async function writeCanvas(file: string): Promise<void> {
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, emptyBoard);
	}

	function routePaths(pages: { routePath: string }[] | undefined): string[] {
		return (pages ?? []).map((page) => page.routePath);
	}

	test("vaults the Rspress content root when vaultRoot is not set", async () => {
		const fixture = await createVaultFixture();
		await writeCanvas(path.join(fixture.docs, "Board.canvas"));
		const pages = await canvas({ outDir: fixture.out }).addPages?.({ root: fixture.docs }, false);
		expect(routePaths(pages)).toEqual(["/canvas/board"]);
	});

	test("resolves a relative content root against the working directory", async () => {
		const fixture = await createVaultFixture();
		await writeCanvas(path.join(fixture.docs, "Board.canvas"));
		const cwd = process.cwd();
		process.chdir(fixture.root);
		try {
			const pages = await canvas({ outDir: fixture.out }).addPages?.({ root: "docs" }, false);
			expect(routePaths(pages)).toEqual(["/canvas/board"]);
		} finally {
			process.chdir(cwd);
		}
	});

	test("skips node_modules, dist, .git, doc_build and coverage unasked", async () => {
		const fixture = await createVaultFixture();
		await writeCanvas(path.join(fixture.docs, "Keep.canvas"));
		for (const dir of ["node_modules/pkg", "dist", ".git/hooks", "coverage", "doc_build"]) {
			await writeCanvas(path.join(fixture.docs, dir, "Stray.canvas"));
		}
		const pages = await canvas({ outDir: fixture.out }).addPages?.({ root: fixture.docs }, false);
		expect(routePaths(pages)).toEqual(["/canvas/keep"]);
	});

	test("exclude adds to the built-ins instead of replacing them", async () => {
		const fixture = await createVaultFixture();
		await writeCanvas(path.join(fixture.docs, "Keep.canvas"));
		await writeCanvas(path.join(fixture.docs, "drafts", "Idea.canvas"));
		await writeCanvas(path.join(fixture.docs, "node_modules", "Stray.canvas"));
		const pages = await canvas({ exclude: ["**/drafts/**"], outDir: fixture.out }).addPages?.(
			{ root: fixture.docs },
			false,
		);
		expect(routePaths(pages)).toEqual(["/canvas/keep"]);
	});
});
