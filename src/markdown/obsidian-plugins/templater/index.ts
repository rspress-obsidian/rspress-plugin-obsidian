import fs from "node:fs/promises";
import path from "node:path";
import type { Html, Root, RootContent, Text } from "mdast";
import type { Parent } from "unist";
import { visit } from "unist-util-visit";
import type { VFile } from "vfile";
import { escapeHtmlAttribute, escapeHtmlText } from "../../../shared/escape.js";
import { parseFrontmatter, stripFrontmatter } from "../../../shared/frontmatter.js";
import { parseDailyNoteDate } from "../../daily-notes.js";
import { parseWikiLink } from "../../parse-wikilink.js";
import { SKIP_PARENT_TYPES } from "../../remark-diagnostics.js";
import { compileSafeRegex } from "../../safe-regex.js";
import { parseObsidianMarkdown } from "../../syntax.js";
import type { ContentPage } from "../../types.js";
import type { ObsidianPluginFeature, PluginRenderContext } from "../types.js";
import { scanCommands, type TemplaterCommand } from "./engine.js";
import { messageOf } from "./interpreter.js";
import { resolveTemplaterSettings, type TemplaterSettings } from "./settings.js";
import { expandWithTp, RUN_MODE, type RunMode, type TemplaterHost, VaultFile } from "./tp.js";

const reportedProblems = new WeakSet<TemplaterSettings>();

function settingsFor(ctx: PluginRenderContext): TemplaterSettings {
	const settings = resolveTemplaterSettings(ctx.options);
	if (!reportedProblems.has(settings)) {
		reportedProblems.add(settings);
		for (const problem of settings.problems) ctx.report(problem, "warn");
	}
	return settings;
}

/** `/`-separated, whatever the platform. */
function posix(relativePath: string): string {
	return relativePath.split(path.sep).join("/");
}

function isInside(relativePath: string, folder: string): boolean {
	return folder !== "" && (relativePath === folder || relativePath.startsWith(`${folder}/`));
}

/** The in-place marker a failed command leaves in the note. */
function errorMarkerHtml(message: string): string {
	return `<span class="templater-error" title="${escapeHtmlAttribute(message)}">Templater: ${escapeHtmlText(message)}</span>`;
}

/**
 * Errors of the file being compiled, by placeholder number. A command's
 * output is markdown (a template) or text (a dynamic command), and an error
 * written into it as HTML would be re-read as markdown — `File [[X]] doesn't
 * exist` would become a broken link. So a failed command leaves a
 * private-use placeholder, and {@link restoreErrorMarkers} swaps each one for
 * its HTML once the tree is built.
 */
const pendingErrors = new WeakMap<VFile, string[]>();
const PLACEHOLDER = /\uE000(\d+)\uE001/g;

function placeholderFor(file: VFile, message: string): string {
	const errors = pendingErrors.get(file) ?? [];
	pendingErrors.set(file, errors);
	errors.push(message);
	return `\uE000${errors.length - 1}\uE001`;
}

function restoreErrorMarkers(tree: Root, file: VFile): void {
	const errors = pendingErrors.get(file);
	if (!errors) return;
	const messageAt = (index: string) => errors[Number(index)] ?? "";
	visit(tree, (node, index, parent) => {
		if ((node.type === "code" || node.type === "inlineCode") && node.value.includes("\uE000")) {
			node.value = node.value.replace(
				PLACEHOLDER,
				(_match, at: string) => `Templater: ${messageAt(at)}`,
			);
			return undefined;
		}
		if (node.type === "html" && node.value.includes("\uE000")) {
			node.value = node.value.replace(PLACEHOLDER, (_match, at: string) =>
				errorMarkerHtml(messageAt(at)),
			);
			return undefined;
		}
		// A link whose target a failed command was meant to write has no target:
		// it becomes the command's error marker rather than a link to the
		// placeholder (`[[<% bad %>]]`, `[x](<% bad %>)`).
		const target =
			node.type === "wikiLink"
				? node.value
				: node.type === "link" || node.type === "image"
					? node.url
					: undefined;
		if (target?.includes("\uE000") && parent && index !== undefined) {
			const markers: RootContent[] = [...target.matchAll(PLACEHOLDER)].map((match) => ({
				type: "html",
				value: errorMarkerHtml(messageAt(match[1] ?? "")),
			}));
			(parent.children as RootContent[]).splice(index, 1, ...markers);
			return index + markers.length;
		}
		if (node.type !== "text" || !parent || index === undefined || !node.value.includes("\uE000")) {
			return undefined;
		}
		const nodes: RootContent[] = [];
		let cursor = 0;
		for (const match of node.value.matchAll(PLACEHOLDER)) {
			if (match.index > cursor)
				nodes.push({ type: "text", value: node.value.slice(cursor, match.index) });
			nodes.push({
				type: "html",
				value: errorMarkerHtml(messageAt(match[1] ?? "")),
			} satisfies Html);
			cursor = match.index + match[0].length;
		}
		if (cursor < node.value.length) nodes.push({ type: "text", value: node.value.slice(cursor) });
		(parent.children as RootContent[]).splice(index, 1, ...nodes);
		return index + nodes.length;
	});
}

async function vaultFileAt(root: string, relativePath: string): Promise<VaultFile | undefined> {
	const absolute = path.resolve(root, relativePath);
	if (absolute !== root && !absolute.startsWith(root + path.sep)) return undefined;
	try {
		const stat = await fs.stat(absolute);
		if (!stat.isFile()) return undefined;
		return new VaultFile(posix(path.relative(root, absolute)), absolute, {
			ctime: stat.birthtimeMs || stat.ctimeMs,
			mtime: stat.mtimeMs,
			size: stat.size,
		});
	} catch {
		return undefined;
	}
}

function vaultFileOf(page: ContentPage): VaultFile {
	return new VaultFile(posix(page.relativePath), page.absolutePath, {
		ctime: page.fileCtimeMs,
		mtime: page.fileMtimeMs,
		size: page.fileSizeBytes,
	});
}

/** Every file under `folder`, for the basename lookup of a link into the templates folder. */
async function filesUnder(folder: string): Promise<string[]> {
	const entries = await fs
		.readdir(folder, { withFileTypes: true, recursive: true })
		.catch(() => []);
	return entries
		.filter((entry) => entry.isFile())
		.map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * The file a link path names. A published note resolves as any wikilink
 * does; the templates folder is never published, so a template (the usual
 * target of `tp.file.include`) is looked up on disk, by path and then by name.
 */
async function findFile(
	ctx: PluginRenderContext,
	settings: TemplaterSettings,
	linkpath: string,
): Promise<VaultFile | undefined> {
	if (!linkpath) return undefined;
	const resolved = await ctx.resolve(parseWikiLink(linkpath, `[[${linkpath}]]`));
	if (resolved.targetPage) return vaultFileOf(resolved.targetPage);
	const root = ctx.docsRoot;
	const folders = settings.templatesFolder ? ["", settings.templatesFolder] : [""];
	for (const folder of folders) {
		for (const candidate of [linkpath, `${linkpath}.md`]) {
			const file = await vaultFileAt(root, path.join(folder, candidate));
			if (file) return file;
		}
	}
	if (!settings.templatesFolder) return undefined;
	const wanted = path.basename(linkpath).toLowerCase();
	const match = (await filesUnder(path.join(root, settings.templatesFolder))).find((file) => {
		const name = path.basename(file).toLowerCase();
		return name === wanted || name === `${wanted}.md`;
	});
	return match ? vaultFileAt(root, path.relative(root, match)) : undefined;
}

interface RunOptions {
	runMode: RunMode;
	templateFile?: VaultFile;
	/** The target's content when the template runs; its file on disk by default. */
	content?: string;
}

async function hostFor(
	ctx: PluginRenderContext,
	settings: TemplaterSettings,
	{ runMode, templateFile, content }: RunOptions,
): Promise<TemplaterHost> {
	const page = ctx.currentPage;
	const raw = await fs.readFile(page.absolutePath, "utf8").catch(() => ctx.source);
	let frontmatter: Record<string, unknown> = {};
	try {
		frontmatter = parseFrontmatter(raw).data;
	} catch {
		// Malformed frontmatter is the content index's diagnostic to report.
	}
	const target = vaultFileOf(page);
	return {
		now: settings.now ?? new Date(),
		target,
		templateFile: templateFile ?? target,
		runMode,
		root: ctx.docsRoot,
		tags: page.tags.map((tag) => `#${tag}`),
		frontmatter,
		content: content ?? raw,
		systemCommands: settings.systemCommands,
		findFile: (linkpath) => findFile(ctx, settings, linkpath),
		report: (message, mode) => ctx.report(message, mode),
		errorMarker: (message, command) => {
			ctx.report(command ? `${message} (in \`${command}\`)` : message);
			return placeholderFor(ctx.file, message);
		},
	};
}

/** Nodes parsed from a template carry offsets into the template, not the note. */
function withoutPositions(nodes: RootContent[]): RootContent[] {
	const root: Root = { type: "root", children: nodes };
	visit(root, (node) => {
		delete node.position;
	});
	return root.children;
}

function parseOutput(markdown: string, ctx: PluginRenderContext): RootContent[] {
	// The template's own properties become the note's in Obsidian; here they
	// are not rendered as a rule and stray text.
	return withoutPositions(
		parseObsidianMarkdown(stripFrontmatter(markdown), { enableMath: ctx.options.enableMath })
			.children,
	);
}

/** The template a folder or file regex rule picks for a new note at `relativePath`. */
function matchingTemplate(
	relativePath: string,
	settings: TemplaterSettings,
	ctx: PluginRenderContext,
): string | undefined {
	if (settings.folderTemplates.length > 0) {
		const folders: string[] = [];
		let folder = path.posix.dirname(relativePath);
		for (;;) {
			folders.push(folder === "." ? "" : folder);
			if (folder === "." || folder === "/" || folder === "") break;
			folder = path.posix.dirname(folder);
		}
		// The deepest folder with a rule wins; `/` is the catch-all.
		for (const candidate of folders) {
			const rule = settings.folderTemplates.find(
				(entry) => entry.folder.replace(/^\/+|\/+$/g, "") === candidate,
			);
			if (rule) return rule.template;
		}
	}
	for (const rule of settings.fileTemplates) {
		let regex: RegExp;
		try {
			regex = compileSafeRegex(rule.regex);
		} catch (error) {
			ctx.report(`File regex template "${rule.regex}" cannot be used: ${messageOf(error)}`);
			continue;
		}
		if (regex.test(relativePath)) return rule.template;
	}
	return undefined;
}

/** Whether Templater would run on a new note at `relativePath`. */
function triggersOn(relativePath: string, settings: TemplaterSettings): boolean {
	return (
		settings.triggerOnFileCreation &&
		!isInside(relativePath, settings.templatesFolder) &&
		!settings.ignoreFolders.some((folder) => isInside(relativePath, folder))
	);
}

/** Notes another plugin renders whole: their commands are left to the reading-view pass. */
const PLUGIN_NOTE_KEYS = ["kanban-plugin", "excalidraw-plugin"];

/**
 * Read from the file: Rspress hands the remark pass a note without its
 * frontmatter, so the keys that mark a board or a drawing are only on disk.
 */
async function belongsToAnotherPlugin(page: ContentPage): Promise<boolean> {
	try {
		const data = parseFrontmatter(await fs.readFile(page.absolutePath, "utf8")).data;
		return PLUGIN_NOTE_KEYS.some((key) => Object.hasOwn(data, key));
	} catch {
		return false;
	}
}

/** A folder or file regex template applied to an empty note, as on creation in Obsidian. */
async function renderNewNote(
	ctx: PluginRenderContext,
	settings: TemplaterSettings,
): Promise<RootContent[] | undefined> {
	const relativePath = posix(ctx.currentPage.relativePath);
	if (!triggersOn(relativePath, settings)) return undefined;
	const { options } = ctx;
	// The daily-notes stage fills a daily note from its own template, and runs
	// Templater over it there.
	if (
		options.enableDailyNotes &&
		options.dailyNotes.template &&
		parseDailyNoteDate(ctx.currentPage.relativePath, options.dailyNotes)
	) {
		return undefined;
	}
	const template = matchingTemplate(relativePath, settings, ctx);
	if (!template) return undefined;
	const templateFile =
		(await vaultFileAt(ctx.docsRoot, template)) ??
		(await vaultFileAt(ctx.docsRoot, `${template}.md`));
	if (!templateFile) {
		const message = `Couldn't find template ${template}`;
		ctx.report(message);
		return [{ type: "html", value: errorMarkerHtml(message) }];
	}
	const source = await fs.readFile(templateFile.absolutePath, "utf8");
	const host = await hostFor(ctx, settings, { runMode: RUN_MODE.OverwriteFile, templateFile });
	return parseOutput(await expandWithTp(source, host, true), ctx);
}

type PhrasingRun = Array<Text | { type: "wikiLink"; value: string }>;

/**
 * A command's output in the reading view: text, as Templater sets the DOM
 * text node's value.
 */
async function evaluateCommand(
	command: TemplaterCommand,
	ctx: PluginRenderContext,
	settings: TemplaterSettings,
): Promise<RootContent[]> {
	const host = await hostFor(ctx, settings, {
		runMode: command.dynamic ? RUN_MODE.DynamicProcessor : RUN_MODE.OverwriteActiveFile,
	});
	const output = await expandWithTp(command.raw, host, false);
	return output ? [{ type: "text", value: output }] : [];
}

/** Replace the evaluated commands of one run of text and wikilinks. */
function rebuildRun(
	run: PhrasingRun,
	replacements: ReadonlyArray<{ command: TemplaterCommand; nodes: RootContent[] }>,
): RootContent[] {
	const out: RootContent[] = [];
	const push = (node: RootContent) => {
		const last = out[out.length - 1];
		if (node.type === "text" && last?.type === "text") last.value += node.value;
		else out.push(node);
	};
	let offset = 0;
	let next = 0;
	for (const node of run) {
		const start = offset;
		const end = offset + node.value.length;
		offset = end;
		let cursor = start;
		while (cursor < end) {
			const replacement = replacements[next];
			if (!replacement || replacement.command.start >= end) {
				push(
					cursor === start && node.type === "wikiLink"
						? (node as RootContent)
						: { type: "text", value: node.value.slice(cursor - start) },
				);
				break;
			}
			if (replacement.command.start > cursor) {
				push({
					type: "text",
					value: node.value.slice(cursor - start, replacement.command.start - start),
				});
				cursor = replacement.command.start;
				continue;
			}
			if (replacement.command.start === cursor)
				for (const piece of replacement.nodes) push({ ...piece });
			cursor = Math.min(end, replacement.command.end);
			if (replacement.command.end <= end) next += 1;
		}
	}
	return out;
}

/**
 * Commands left in a published note, the reading-view pass: `<%+ %>` is
 * evaluated, and its output is text, as Templater writes it into the DOM;
 * `<% %>` and `<%* %>` stay as written (or are evaluated with
 * `renderCommands: "all"`). Runs of text and wikilinks are read together,
 * so `tp.file.include("[[Note]]")` sees its link; code, links and HTML are
 * never read.
 */
async function processCommandsInTree(
	tree: Root,
	ctx: PluginRenderContext,
	settings: TemplaterSettings,
): Promise<void> {
	const parents: Parent[] = [];
	visit(tree, (node) => {
		if (SKIP_PARENT_TYPES[node.type]) return "skip";
		if ("children" in node && Array.isArray(node.children)) parents.push(node as Parent);
		return undefined;
	});
	const reportLiterals = ctx.mode === "page";
	for (const parent of parents) {
		const children = parent.children as RootContent[];
		if (!children.some((child) => child.type === "text" && child.value.includes("<%"))) continue;
		const rebuilt: RootContent[] = [];
		let index = 0;
		while (index < children.length) {
			const child = children[index] as RootContent;
			if (child.type !== "text" && child.type !== "wikiLink") {
				rebuilt.push(child);
				index += 1;
				continue;
			}
			const run: PhrasingRun = [];
			while (index < children.length) {
				const candidate = children[index] as RootContent;
				if (candidate.type !== "text" && candidate.type !== "wikiLink") break;
				run.push(candidate as PhrasingRun[number]);
				index += 1;
			}
			// One string for the run, so a command reads across the wikilinks in it.
			const text = run.map((node) => node.value).join("");
			const { commands, unclosed } = scanCommands(text);
			if (unclosed !== undefined && reportLiterals) {
				ctx.report(
					`A Templater command starting "${text.slice(unclosed, unclosed + 40)}" is split by formatting or a line of its own, so it is shown as written.`,
					"warn",
				);
			}
			const replacements: Array<{ command: TemplaterCommand; nodes: RootContent[] }> = [];
			for (const command of commands) {
				if (command.dynamic || settings.renderCommands === "all") {
					replacements.push({ command, nodes: await evaluateCommand(command, ctx, settings) });
				} else if (reportLiterals) {
					ctx.report(
						`Templater command \`${command.raw}\` is shown as written: Obsidian runs it only when a template is applied. Use \`<%+ %>\` for a command the published page evaluates, or set \`templater.renderCommands: "all"\`.`,
						"warn",
					);
				}
			}
			rebuilt.push(...(replacements.length > 0 ? rebuildRun(run, replacements) : run));
		}
		parent.children = rebuilt;
	}
}

/** The Templater plugin: `<% %>` commands evaluated where Obsidian evaluates them. */
export const templaterFeature: ObsidianPluginFeature = {
	id: "templater",
	label: "Templater",
	enableOption: "enableTemplater",
	isEnabled: (options) => options.enableTemplater,

	excludedFolders: (options) => {
		const settings = resolveTemplaterSettings(options);
		return [settings.templatesFolder, settings.userScriptsFolder].filter(Boolean);
	},

	async expandTemplate(template, ctx) {
		const settings = settingsFor(ctx);
		if (!triggersOn(posix(ctx.currentPage.relativePath), settings)) return template;
		// The daily-notes core plugin creates the note with its template filled
		// in; Templater then replaces the commands in that new file.
		const host = await hostFor(ctx, settings, {
			runMode: RUN_MODE.OverwriteFile,
			content: template,
		});
		return await expandWithTp(template, host, true);
	},

	async renderNote(_tree, ctx) {
		if (!ctx.wholeNote) return undefined;
		const settings = settingsFor(ctx);
		// Rspress passes the body alone; frontmatter is stripped for raw input too.
		const body = stripFrontmatter(ctx.source);
		if (body.trim() === "") return await renderNewNote(ctx, settings);
		if (
			settings.renderCommands !== "all" ||
			!scanCommands(body).commands.some((command) => !command.dynamic) ||
			(await belongsToAnotherPlugin(ctx.currentPage))
		) {
			return undefined;
		}
		// "Replace templates in the active file", run over the whole note so a
		// `<%* if … %>` block spanning paragraphs works as it does in Obsidian.
		const host = await hostFor(ctx, settings, { runMode: RUN_MODE.OverwriteActiveFile });
		return parseOutput(await expandWithTp(body, host, true), ctx);
	},

	async transformTree(tree, ctx) {
		await processCommandsInTree(tree, ctx, settingsFor(ctx));
		restoreErrorMarkers(tree, ctx.file);
	},
};
