import fs from "node:fs";
import { getContentLineFlags } from "../../../shared/content-flags.js";
import { parseFrontmatter, stripFrontmatter } from "../../../shared/frontmatter.js";
import { blankCommentRanges, findCommentRanges } from "../../comments.js";
import { scanPageHeadings } from "../../heading-text.js";
import type { ContentIndex } from "../../types.js";
import { readObsidianPluginSettings } from "../settings.js";
import type { ObsidianPluginFeature, PluginRenderContext } from "../types.js";
import {
	boardSettingsLayer,
	KANBAN_FRONTMATTER_KEY,
	optionSettingsLayer,
	resolveKanbanSettings,
} from "./board-settings.js";
import { parseNow } from "./dates.js";
import { extractSettingsBlock, parseKanbanBoard } from "./parse.js";
import { BoardRenderer } from "./render.js";

/** The upstream plugin's id: its settings live in `.obsidian/plugins/obsidian-kanban/`. */
const KANBAN_PLUGIN_ID = "obsidian-kanban";

const sourceCache = new WeakMap<ContentIndex, Map<string, Promise<string>>>();

/**
 * The note's whole source. A feature gets the note without its frontmatter
 * (Rspress strips it before compiling; a transclusion strips it too) and with
 * comments blanked, and a board needs both: its frontmatter says it is a
 * board, and its settings sit in a `%% … %%` comment. The compiled page is
 * read once; a transcluded note once per index generation.
 */
function noteSource(ctx: PluginRenderContext): Promise<string> {
	const compiled = String(ctx.file);
	if (ctx.mode === "page" && compiled.startsWith("---")) return Promise.resolve(compiled);
	const { absolutePath } = ctx.currentPage;
	let cache = sourceCache.get(ctx.index);
	if (!cache) {
		cache = new Map();
		sourceCache.set(ctx.index, cache);
	}
	let pending = ctx.mode === "page" ? undefined : cache.get(absolutePath);
	if (!pending) {
		// A page this plugin generated has no file; what is compiled is all there is.
		const fallback = ctx.mode === "page" ? compiled : "";
		pending = fs.promises.readFile(absolutePath, "utf8").catch(() => fallback);
		if (ctx.mode !== "page") cache.set(absolutePath, pending);
	}
	return pending;
}

/**
 * The ids the page gives its headings, keyed by the heading's line in the
 * board body, so `[[Board#Lane]]` lands on the lane.
 */
function laneIds(source: string, body: string): Map<number, string> {
	const offset = source.slice(0, source.length - body.length).split("\n").length - 1;
	const lines = source.split(/\r?\n/);
	const blanked = source.includes("%%")
		? blankCommentRanges(source, findCommentRanges(source)).split(/\r?\n/)
		: lines;
	const ids = new Map<number, string>();
	for (const heading of scanPageHeadings(blanked, getContentLineFlags(lines))) {
		if (heading.topLevel) ids.set(heading.line - offset + 1, heading.id);
	}
	return ids;
}

async function renderBoard(ctx: PluginRenderContext) {
	const source = await noteSource(ctx);
	// Most notes are not boards; skip the frontmatter parse for them.
	if (!source.startsWith("---") || !source.includes(KANBAN_FRONTMATTER_KEY)) return undefined;
	let frontmatter: Record<string, unknown>;
	try {
		frontmatter = parseFrontmatter(source).data;
	} catch {
		// Not readable as a board; the content index reports the frontmatter.
		return undefined;
	}
	if (!frontmatter[KANBAN_FRONTMATTER_KEY]) return undefined;

	const { options } = ctx;
	const kanban = options.kanban;
	const body = stripFrontmatter(source);
	const block = extractSettingsBlock(body);
	const vault =
		kanban.readVaultSettings === false
			? undefined
			: readObsidianPluginSettings(options.vaultRoot, KANBAN_PLUGIN_ID);
	const settings = resolveKanbanSettings(
		[boardSettingsLayer(frontmatter, block.settings), optionSettingsLayer(kanban), vault ?? {}],
		options,
	);

	let error: string | undefined;
	if (block.error) {
		error = `The Kanban settings of "${ctx.currentPage.relativePath}" cannot be read: ${block.error}. The board renders with the global settings.`;
		ctx.report(error);
	}
	let now = parseNow(kanban.now);
	if (!now) {
		ctx.report(
			`\`kanban.now\` (${String(kanban.now)}) is not a date; relative dates use the build's clock.`,
		);
		now = new Date();
	}

	const board = parseKanbanBoard(
		body,
		settings,
		{ dataview: options.enableDataview, tasks: options.enableTasks },
		options.enableMath,
	);
	const renderer = new BoardRenderer({
		ctx,
		settings,
		now,
		showArchive: kanban.showArchive === true,
		laneIds: laneIds(source, body),
	});
	return renderer.render(board, error);
}

/** The Kanban plugin: notes with `kanban-plugin` frontmatter rendered as boards. */
export const kanbanFeature: ObsidianPluginFeature = {
	id: "kanban",
	label: "Kanban",
	enableOption: "enableKanban",
	isEnabled: (options) => options.enableKanban,
	async renderNote(_tree, ctx) {
		if (!ctx.wholeNote) return undefined;
		const html = await renderBoard(ctx);
		return html === undefined ? undefined : [{ type: "html", value: html }];
	},
};
