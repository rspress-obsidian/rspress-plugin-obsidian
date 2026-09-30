import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { caseSensitiveFilesystem } from "../../test/case-sensitive-fs.js";
import { findCanvasBoardByPath, setCanvasRoutes } from "../shared/canvas-routes.js";
import { canvas } from "./index";
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
	// The route registry is process-wide state shared with the markdown
	// plugin's resolver; a temp vault's routes must not leak into other test files.
	setCanvasRoutes([]);
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface VaultFixture {
	root: string;
	vault: string;
	docs: string;
	outside: string;
}

async function createVaultFixture(): Promise<VaultFixture> {
	const root = await mkdtemp(path.join(tmpdir(), "canvas-vault-"));
	tempDirs.push(root);
	const vault = path.join(root, "vault");
	const docs = path.join(root, "docs");
	const outside = path.join(root, "outside");
	await mkdir(path.join(vault, "Notes"), { recursive: true });
	await mkdir(outside, { recursive: true });
	await mkdir(docs, { recursive: true });
	return { root, vault, docs, outside };
}

async function publishBoard(board: CanvasData, { vault, docs }: VaultFixture) {
	await writeFile(path.join(vault, "Board.canvas"), JSON.stringify(board));
	const plugin = canvas({ vaultRoot: vault, fileRoutePrefix: "/vault" });
	const pages = await plugin.addPages?.({ root: docs }, false);
	const published = JSON.parse(
		await readFile(path.join(docs, "public", "__canvases__", "Board.json"), "utf-8"),
	) as CanvasData;
	return { pages, published };
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

			expect(publishedFileNode(published, "direct").fileContent).toContain("inside");
			expect(publishedFileNode(published, "linked").fileContent).toContain("inside");
			expect(published.notes?.["linked-inside.md"]).toContain("inside");
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

			const { pages, published } = await publishBoard(
				{
					nodes: [
						fileCard("leak-note", "Linked-Outside.md"),
						fileCard("leak-asset", "linked-outside.png"),
					],
					edges: [],
				},
				fixture,
			);

			expect(publishedFileNode(published, "leak-note").fileContent).toBeUndefined();
			expect(publishedFileNode(published, "leak-asset").assetUrl).toBeUndefined();
			expect(published.notes).toBeUndefined();
			expect(published.assets).toBeUndefined();
			// The page prop embeds the same JSON the public file carries.
			expect(JSON.stringify(pages?.map((page) => page.content))).not.toContain("OUTSIDE-CONTENT");
			expect(JSON.stringify(pages?.map((page) => page.content))).not.toContain("OUTSIDE-BYTES");
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

			const plugin = canvas({ vaultRoot: fixture.vault, fileRoutePrefix: "/vault" });
			const pages = await plugin.addPages?.({ root: fixture.docs }, false);

			expect(pages?.map((page) => page.routePath)).toEqual(["/canvas/board"]);
		},
	);

	test("registers published boards for the wikilink resolver", async () => {
		const fixture = await createVaultFixture();
		await writeFile(
			path.join(fixture.vault, "Demo.canvas"),
			JSON.stringify({ nodes: [], edges: [] }),
		);
		await writeFile(
			path.join(fixture.vault, "Notes", "Nested Board.canvas"),
			JSON.stringify({ nodes: [], edges: [] }),
		);

		const plugin = canvas({ vaultRoot: fixture.vault, fileRoutePrefix: "/vault" });
		const pages = await plugin.addPages?.({ root: fixture.docs }, false);

		expect(pages).toHaveLength(2);
		expect(findCanvasBoardByPath(path.join(fixture.vault, "Demo.canvas"))?.routePath).toBe(
			"/canvas/demo",
		);
		expect(
			findCanvasBoardByPath(path.join(fixture.vault, "Notes", "Nested Board.canvas"))?.routePath,
		).toBe("/canvas/notes/nested-board");
		// A file the scan never saw stays unpublished, so resolution falls back
		// to treating it as an ordinary attachment.
		expect(findCanvasBoardByPath(path.join(fixture.vault, "Excluded.canvas"))).toBeUndefined();
	});
});

describe("canvas enrichment", () => {
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
		await writeFile(path.join(fixture.vault, "pic.png"), "PNG-BYTES");
		await writeFile(path.join(fixture.vault, "clip.mp3"), "MP3-BYTES");
		await writeFile(path.join(fixture.vault, "movie.mp4"), "MP4-BYTES");
		await writeFile(path.join(fixture.vault, "doc.pdf"), "PDF-BYTES");
		await writeFile(path.join(fixture.vault, "archive.bin"), "BIN-BYTES");
	}

	test("enriches markdown notes, subpaths, media assets and group backgrounds", async () => {
		const fixture = await createVaultFixture();
		await writeVaultFiles(fixture);

		const { published } = await publishBoard(
			{
				nodes: [
					{
						id: "text",
						type: "text",
						x: 0,
						y: 0,
						width: 200,
						height: 100,
						text: "See ![[pic.png]] and ![alt](pic.png) and ![web](https://cdn.example/x.png) and ![abs](/x.png) and ![data](data:image/png;base64,AAAA)",
					},
					fileCard("heading", "Notes/Welcome.md", "#Getting Started"),
					fileCard("block", "Notes/Welcome.md", "#^intro"),
					fileCard("missing-heading", "Notes/Welcome.md", "#Nope"),
					fileCard("image", "pic.png"),
					fileCard("audio", "clip.mp3"),
					fileCard("video", "movie.mp4"),
					fileCard("pdf", "doc.pdf"),
					fileCard("unknown-mime", "archive.bin"),
					{
						id: "group",
						type: "group",
						x: 0,
						y: 0,
						width: 300,
						height: 300,
						label: "Zone",
						background: "pic.png",
						backgroundStyle: "repeat",
					},
				],
				edges: [],
			},
			fixture,
		);

		// Frontmatter is stripped before the note is published.
		expect(published.notes?.["notes/welcome.md"]).not.toContain("title: Welcome");
		expect(published.notes?.["notes/welcome.md"]).toContain("# Getting Started");

		// A heading subpath slices that section, and a `#^block` subpath its block.
		expect(publishedFileNode(published, "heading").fileContent).toContain("Body text here.");
		expect(publishedFileNode(published, "block").fileContent).toBe("Body text here.");
		expect(publishedFileNode(published, "missing-heading").isError).toBe(true);
		expect(publishedFileNode(published, "missing-heading").fileContent).toContain("Unable to find");

		// Media nodes carry the data URL and the flags the card switches on.
		expect(publishedFileNode(published, "image").assetUrl).toMatch(/^data:image\/png;base64,/);
		expect(publishedFileNode(published, "image").isImage).toBe(true);
		expect(publishedFileNode(published, "image").imageUrl).toBe(
			publishedFileNode(published, "image").assetUrl,
		);
		expect(publishedFileNode(published, "audio").isAudio).toBe(true);
		expect(publishedFileNode(published, "video").isVideo).toBe(true);
		expect(publishedFileNode(published, "pdf").isPdf).toBe(true);
		// No MIME type for the extension, so there is nothing to inline.
		expect(publishedFileNode(published, "unknown-mime").assetUrl).toBeUndefined();

		// The group background and the two markdown embeds resolve to the same asset;
		// the remote, absolute and data URLs are left alone.
		expect(publishedGroupNode(published, "group").backgroundUrl).toMatch(
			/^data:image\/png;base64,/,
		);
		// Every inlined asset is keyed by its lower-cased vault path; the remote,
		// absolute and data URLs in the text card are left alone, and the extension
		// with no MIME type contributes nothing.
		expect(Object.keys(published.assets ?? {}).sort()).toEqual([
			"clip.mp3",
			"doc.pdf",
			"movie.mp4",
			"pic.png",
		]);
	});

	test("inlines an asset a text card references with a subpath", async () => {
		// `#page=2` is a location inside the document, not part of its name. Kept
		// whole it was read as a file called `doc.pdf#page=2`, which does not exist,
		// so the board shipped without the asset and the card fell back to a URL
		// nothing served.
		const fixture = await createVaultFixture();
		await writeVaultFiles(fixture);
		const { published } = await publishBoard(
			{
				nodes: [
					{
						id: "text",
						type: "text",
						x: 0,
						y: 0,
						width: 200,
						height: 100,
						text: "![[doc.pdf#page=2]] ![[pic.png|300]] ![[clip.mp3#t=1]]",
					},
				],
				edges: [],
			},
			fixture,
		);

		expect(Object.keys(published.assets ?? {}).sort()).toEqual(["clip.mp3", "doc.pdf", "pic.png"]);
		expect(published.assets?.["doc.pdf"]).toMatch(/^data:application\/pdf;base64,/);
	});

	test("warns and renders the card without content when a note cannot be read", async () => {
		const fixture = await createVaultFixture();
		// A directory where a note and an asset are expected: the path resolves, the
		// read does not.
		await mkdir(path.join(fixture.vault, "Notes", "Folder.md"), { recursive: true });
		await mkdir(path.join(fixture.vault, "broken.png"), { recursive: true });

		const warnings: string[] = [];
		const originalWarn = console.warn;
		console.warn = (...args: unknown[]) => {
			warnings.push(args.join(" "));
		};
		try {
			const { published } = await publishBoard(
				{
					nodes: [
						fileCard("gone", "Notes/Missing.md"),
						fileCard("unreadable", "Notes/Folder.md"),
						fileCard("unreadable-asset", "broken.png"),
					],
					edges: [],
				},
				fixture,
			);
			expect(publishedFileNode(published, "gone").fileContent).toBeUndefined();
			expect(publishedFileNode(published, "unreadable").fileContent).toBeUndefined();
			expect(publishedFileNode(published, "unreadable-asset").assetUrl).toBeUndefined();
			expect(published.assets).toBeUndefined();
		} finally {
			console.warn = originalWarn;
		}

		expect(warnings.join("\n")).toContain("Notes/Missing.md");
		expect(warnings.join("\n")).toContain("Notes/Folder.md");
	});

	// A document-level failure (unparseable JSON) leaves nothing to render, so
	// the raw board is still published and the build keeps going.
	test("falls back to the raw canvas when enrichment cannot validate it", async () => {
		const fixture = await createVaultFixture();
		const errors: string[] = [];
		const originalError = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args.join(" "));
		};
		let routePaths: string[] = [];
		try {
			await writeFile(path.join(fixture.vault, "Board.canvas"), "{ not json");
			const plugin = canvas({ vaultRoot: fixture.vault, fileRoutePrefix: "/vault" });
			const pages = await plugin.addPages?.({ root: fixture.docs }, false);
			routePaths = pages?.map((page) => page.routePath) ?? [];
		} finally {
			console.error = originalError;
		}

		expect(errors.join("\n")).toContain("Failed to process canvas file");
		expect(routePaths).toEqual(["/canvas/board"]);
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
			const plugin = canvas({ vaultRoot: fixture.vault, fileRoutePrefix: "/vault" });
			const pages = await plugin.addPages?.({ root: fixture.docs }, false);
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

			const plugin = canvas({ vaultRoot: fixture.vault, fileRoutePrefix: "/vault" });

			await expect(plugin.addPages?.({ root: fixture.docs }, false)).rejects.toThrow(
				/route collision/,
			);
		},
	);

	test("reports a failure to write the embed JSON", async () => {
		const fixture = await createVaultFixture();
		await writeFile(
			path.join(fixture.vault, "Board.canvas"),
			JSON.stringify({ nodes: [], edges: [] }),
		);
		// A file where the public directory belongs makes `mkdir` fail.
		await writeFile(path.join(fixture.docs, "public"), "not a directory");

		const errors: string[] = [];
		const originalError = console.error;
		console.error = (...args: unknown[]) => {
			errors.push(args.join(" "));
		};
		let routePaths: string[] = [];
		try {
			const plugin = canvas({ vaultRoot: fixture.vault, fileRoutePrefix: "/vault" });
			const pages = await plugin.addPages?.({ root: fixture.docs }, false);
			routePaths = pages?.map((page) => page.routePath) ?? [];
		} finally {
			console.error = originalError;
		}

		expect(errors.join("\n")).toContain("Failed to write embed JSON");
		// The page is still generated; only the embed's JSON is missing.
		expect(routePaths).toEqual(["/canvas/board"]);
	});
});

describe("canvas plugin options", () => {
	test("injects the canvas stylesheet by default", () => {
		expect(typeof canvas().globalStyles).toBe("string");
		expect(typeof canvas({ vaultRoot: "/tmp/vault" }).globalStyles).toBe("string");
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
		const pages = await canvas().addPages?.({ root: fixture.docs }, false);
		expect(routePaths(pages)).toEqual(["/canvas/board"]);
	});

	test("resolves a relative content root against the working directory", async () => {
		const fixture = await createVaultFixture();
		await writeCanvas(path.join(fixture.docs, "Board.canvas"));
		const cwd = process.cwd();
		process.chdir(fixture.root);
		try {
			const pages = await canvas().addPages?.({ root: "docs" }, false);
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
		const pages = await canvas().addPages?.({ root: fixture.docs }, false);
		expect(routePaths(pages)).toEqual(["/canvas/keep"]);
	});

	test("exclude adds to the built-ins instead of replacing them", async () => {
		const fixture = await createVaultFixture();
		await writeCanvas(path.join(fixture.docs, "Keep.canvas"));
		await writeCanvas(path.join(fixture.docs, "drafts", "Idea.canvas"));
		await writeCanvas(path.join(fixture.docs, "node_modules", "Stray.canvas"));
		const pages = await canvas({ exclude: ["**/drafts/**"] }).addPages?.(
			{ root: fixture.docs },
			false,
		);
		expect(routePaths(pages)).toEqual(["/canvas/keep"]);
	});
});
