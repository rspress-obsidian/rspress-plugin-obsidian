// The umbrella entry is what `rspress-plugin-obsidian` resolves to: the
// composition contract and the public surface are exercised here as a consumer
// meets them — `rspress.config.ts` imports `pluginObsidian` from here.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RspressPlugin } from "@rspress/core";
import { parseCanvas } from "./canvas/parser.ts";
import * as umbrella from "./index.ts";
import { findPublishedContent } from "./shared/published-content.ts";

const { pluginObsidian } = umbrella;

const tempDirs: string[] = [];

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A plugin object as the options are handed to Rspress, read loosely. */
const fields = (plugin: unknown): Record<string, unknown> => plugin as Record<string, unknown>;

describe("pluginObsidian", () => {
	test("composes the three feature plugins in the order the builder returns them", () => {
		const plugins = pluginObsidian((markdown, canvas, graphview) => [
			markdown({ vaultRoot: "/vault" }),
			canvas({ vaultRoot: "/vault", fileRoutePrefix: "/vault" }),
			graphview({ defaultOpen: true }),
		]);

		expect(plugins.map((plugin) => plugin.name)).toEqual([
			"rspress-plugin-obsidian:markdown",
			"rspress-plugin-obsidian:canvas",
			"rspress-plugin-obsidian:graph",
		]);
	});

	test("returns exactly the plugins the builder builds, so a consumer can compose a subset", () => {
		expect(pluginObsidian(() => [])).toEqual([]);
		expect(pluginObsidian({ vaultRoot: "/vault" }, () => [])).toEqual([]);
		expect(
			pluginObsidian((_markdown, canvas) => [
				canvas({ vaultRoot: "/vault", fileRoutePrefix: "/vault" }),
			]).map((plugin) => plugin.name),
		).toEqual(["rspress-plugin-obsidian:canvas"]);
	});

	test("hands the builder factories that honour the options passed to them", () => {
		const [markdownPlugin, graph] = pluginObsidian((markdown, _canvas, graphview) => [
			markdown({ vaultRoot: "/vault", enableMermaid: true }),
			graphview({ enableDefaultStyles: true }),
		]);
		const [plainMarkdown] = pluginObsidian((markdown) => [markdown({ vaultRoot: "/vault" })]);

		// `enableMermaid` is what registers the client component drawing the
		// placeholders; `enableDefaultStyles` is what ships the panel stylesheet.
		// Both reach Rspress as paths, so the assertion is that each option
		// produced one and that it names a file Rspress can load.
		const uiComponents = fields(markdownPlugin).globalUIComponents as [string, object][];
		expect(uiComponents).toHaveLength(1);
		expect(existsSync(uiComponents[0]?.[0] ?? "")).toBe(true);
		expect(fields(plainMarkdown).globalUIComponents).toBeUndefined();
		const stylesheet = fields(graph).globalStyles as string;
		expect(existsSync(stylesheet)).toBe(true);
		expect(stylesheet).toEndWith(".css");
	});
});

describe("pluginObsidian shared options", () => {
	/** A vault with one note and a board whose card links it; boards publish to `out`. */
	async function createVault() {
		const root = await mkdtemp(path.join(tmpdir(), "plugin-obsidian-"));
		tempDirs.push(root);
		const vault = path.join(root, "vault");
		const docs = path.join(root, "docs");
		await mkdir(vault, { recursive: true });
		await mkdir(docs, { recursive: true });
		await writeFile(path.join(vault, "Note.md"), "x\n");
		await writeFile(
			path.join(vault, "Board.canvas"),
			JSON.stringify({
				nodes: [{ id: "t", type: "text", x: 0, y: 0, width: 10, height: 10, text: "[[Note]]" }],
				edges: [],
			}),
		);
		return { vault, docs, out: path.join(root, "out") };
	}

	/** Where the board's card links the note, once the canvas plugin has published it. */
	async function cardHref(plugin: RspressPlugin | undefined, docs: string, out: string) {
		await plugin?.addPages?.({ root: docs }, true);
		const board = parseCanvas(
			await readFile(path.join(out, "__canvases__", "Board.json"), "utf-8"),
			{
				enriched: true,
			},
		);
		return board.links?.[""]?.Note?.href;
	}

	test("the vault is named once for markdown and canvas", async () => {
		const { vault, docs, out } = await createVault();
		const warn = spyOn(console, "warn").mockImplementation(() => {});
		try {
			const [markdownPlugin, canvasPlugin] = pluginObsidian(
				{ vaultRoot: vault, vaultRoutePrefix: "/notes" },
				(markdown, canvas) => [markdown(), canvas({ outDir: out })],
			);

			expect(findPublishedContent({ plugins: [markdownPlugin] })).toMatchObject({
				vaultRoot: vault,
				vaultRoutePrefix: "/notes",
			});
			// Canvas alone (no markdown plugin in this site) indexes the vault
			// itself: its cards link notes under the shared prefix.
			expect(await cardHref(canvasPlugin, docs, out)).toBe("/notes/Note");
			expect(warn).not.toHaveBeenCalled();
		} finally {
			warn.mockRestore();
		}
	});

	test("canvas cards follow the default vault prefix when only the vault is shared", async () => {
		const { vault, docs, out } = await createVault();
		const [canvasPlugin] = pluginObsidian({ vaultRoot: vault }, (_markdown, canvas) => [
			canvas({ outDir: out }),
		]);

		expect(await cardHref(canvasPlugin, docs, out)).toBe("/vault/Note");
	});

	test("an option passed to a feature's factory wins over the shared one", async () => {
		const { vault, docs, out } = await createVault();
		const other = path.join(path.dirname(vault), "other");
		const [markdownPlugin, canvasPlugin] = pluginObsidian(
			{ vaultRoot: other, vaultRoutePrefix: "/notes" },
			(markdown, canvas) => [
				markdown({ vaultRoot: vault, vaultRoutePrefix: "/kb" }),
				canvas({ vaultRoot: vault, fileRoutePrefix: "/kb", outDir: out }),
			],
		);

		expect(findPublishedContent({ plugins: [markdownPlugin] })).toMatchObject({
			vaultRoot: vault,
			vaultRoutePrefix: "/kb",
		});
		expect(await cardHref(canvasPlugin, docs, out)).toBe("/kb/Note");
	});
});

describe("root entry", () => {
	test("exports the feature factories and pluginObsidian, nothing else at runtime", () => {
		// Helpers (content index, resolver, canvas parser…) live on the feature
		// entries — `rspress-plugin-obsidian/markdown`, `/canvas`, `/graph`.
		expect(Object.keys(umbrella).sort()).toEqual([
			"canvas",
			"graphview",
			"markdown",
			"pluginObsidian",
		]);
	});
});
