/**
 * The canvas and markdown features side by side, the way Rspress drives them:
 * every plugin's `addPages` starts at once (`Promise.all` in its plugin
 * driver), so neither may assume the other has finished.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { RspressPlugin, UserConfig } from "@rspress/core";
import rehypeStringify from "rehype-stringify";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { VFile } from "vfile";
import { markdown } from "../markdown/index";
import { canvas } from "./index";

const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function site(files: Record<string, string>) {
	const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "canvas-markdown-")));
	cleanup.push(root);
	const vault = path.join(root, "vault");
	const docs = path.join(root, "docs");
	await mkdir(docs, { recursive: true });
	// A docs page may name a vault file by the URL it would be served at.
	await writeFile(path.join(docs, "index.md"), "[raw board](/vault/Board.canvas)\n");
	for (const [name, content] of Object.entries(files)) {
		await mkdir(path.dirname(path.join(vault, name)), { recursive: true });
		await writeFile(path.join(vault, name), content);
	}
	const md = markdown({ vaultRoot: vault, vaultRoutePrefix: "/vault", onBrokenLink: "warn" });
	const board = canvas({
		vaultRoot: vault,
		fileRoutePrefix: "/vault",
		outDir: path.join(root, "out"),
		exclude: ["Drafts/**"],
	});
	const config = (await md.config?.(
		{ root: docs, plugins: [md, board] },
		{ addPlugin: () => {}, removePlugin: () => {} },
		false,
	)) as UserConfig;
	return { vault, md, board, config };
}

/** What the markdown feature staged as attachments, relative to its staging directory. */
async function staged(plugin: RspressPlugin): Promise<string[]> {
	let staging = "";
	for (const rsbuildPlugin of (plugin.builderConfig?.plugins ?? []) as unknown as Array<{
		name: string;
		setup: (api: unknown) => void;
	}>) {
		if (rsbuildPlugin.name !== "rspress-plugin-obsidian:assets") continue;
		rsbuildPlugin.setup({
			context: { rootPath: "/" },
			modifyRsbuildConfig: (fn: (config: Record<string, unknown>) => void) => {
				const config: { server?: { publicDir?: Array<{ name: string }> } } = {};
				fn(config);
				staging = config.server?.publicDir?.at(-1)?.name ?? "";
			},
		});
	}
	cleanup.push(staging);
	const entries = await readdir(staging, { recursive: true }).catch(() => []);
	return entries.map((entry) => String(entry).split(path.sep).join("/"));
}

async function render(plugin: RspressPlugin, file: string, value: string): Promise<string> {
	const tuple = plugin.markdown?.remarkPlugins?.[0] as [never, never];
	return String(
		await unified()
			.use(remarkParse)
			.use(tuple[0], tuple[1])
			.use(remarkRehype, { allowDangerousHtml: true })
			.use(rehypeStringify, { allowDangerousHtml: true })
			.process(new VFile({ value, path: file })),
	);
}

const NOTE = "[[Board.canvas]] and [[Draft.canvas]]\n";
const FILES = {
	"Note.md": NOTE,
	"Board.canvas": JSON.stringify({
		nodes: [
			{ id: "a", type: "text", text: "%%a private remark%%", x: 0, y: 0, width: 1, height: 1 },
		],
	}),
	// Indexed by the markdown feature, but the canvas feature leaves it out:
	// the raw file must not be served in its place.
	"Drafts/Draft.canvas": JSON.stringify({ nodes: [] }),
};

describe("canvas and markdown addPages running at once", () => {
	for (const order of ["markdown first", "canvas first"] as const) {
		test(`${order}: no raw board is staged, and links reach the board page`, async () => {
			const { vault, md, board, config } = await site(FILES);
			const plugins = order === "markdown first" ? [md, board] : [board, md];
			const pages = await Promise.all(plugins.map((plugin) => plugin.addPages?.(config, false)));
			const routes = pages.flatMap((list) => list ?? []).map((page) => page.routePath);

			expect(routes).toContain("/canvas/board");
			expect(routes).not.toContain("/canvas/drafts/draft");
			expect((await staged(md)).filter((entry) => entry.endsWith(".canvas"))).toEqual([]);
			const html = await render(md, path.join(vault, "Note.md"), NOTE);
			expect(html).toContain('href="/canvas/board"');
			expect(html).not.toContain("/vault/Board.canvas");
			expect(html).not.toContain("/vault/Drafts/Draft.canvas");
		});
	}
});
