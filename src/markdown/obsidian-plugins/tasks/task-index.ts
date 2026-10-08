/**
 * Every task in the published notes, read once per content-index generation:
 * each note's list items (tasks and the plain items nested under them), with
 * the heading each sits under. Code blocks, frontmatter and `%%comments%%`
 * hold no tasks, as in Obsidian.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { getContentLineFlags } from "../../../shared/content-flags.js";
import { blankCommentRanges, findCommentRanges } from "../../comments.js";
import { parseMomentDate } from "../../daily-notes.js";
import type { ContentIndex, ContentPage } from "../../types.js";
import { type Day, dayFromParts, dayOfLocalDate, isoDay } from "./dates.js";
import type { FilenameDates, TaskStatus } from "./settings.js";
import { type ListEntry, parseListLine, type Task, type TaskFile } from "./task.js";

const HEADING_LINE = /^\s{0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const LIST_START = /^[\s>]*(?:[-*+]|[0-9]+[.)])(?:\s|$)/;

/** What decides which lines are tasks and what they hold: different settings, a different index. */
export interface TaskParseSettings {
	globalFilter: string;
	statuses: ReadonlyMap<string, TaskStatus>;
	/** Set when undated tasks take their note's file name as their scheduled date. */
	filenameDates?: FilenameDates;
}

/**
 * The date a note's file name gives its undated tasks (Tasks' "Use filename
 * as Scheduled date"), or `undefined` when the setting is off, the note is
 * outside the listed folders, or the name holds no date. The configured
 * format is tried first and strictly; then `YYYY-MM-DD`, then `YYYYMMDD`,
 * anywhere in the name.
 */
export function filenameDate(
	filePath: string,
	settings: FilenameDates | undefined,
): Day | undefined {
	if (!settings) return undefined;
	if (
		settings.folders.length > 0 &&
		!settings.folders.some((folder) => filePath.startsWith(`${folder}/`))
	) {
		return undefined;
	}
	const basename = filePath.slice(filePath.lastIndexOf("/") + 1).replace(/\.[^.]*$/, "");
	if (settings.format) {
		const date = parseMomentDate(basename, settings.format);
		if (date) return dayOfLocalDate(date);
	}
	const match = /(\d{4})-(\d{2})-(\d{2})/.exec(basename) ?? /(\d{4})(\d{2})(\d{2})/.exec(basename);
	if (!match) return undefined;
	const day = dayFromParts(Number(match[1]), Number(match[2]), Number(match[3]));
	return Number.isNaN(day) ? undefined : day;
}

/** Indentation width, a tab counting as four columns and a `>` as one. */
function indentWidth(indentation: string): number {
	let width = 0;
	for (const char of indentation) width += char === "\t" ? 4 - (width % 4) : 1;
	return width;
}

/** The path Tasks shows for a note: relative to its root, with the extension. */
export function taskFilePath(page: ContentPage, index: ContentIndex): string {
	const relative = path.relative(index.rootDir, page.absolutePath);
	return (relative.startsWith("..") ? path.basename(page.absolutePath) : relative)
		.split(path.sep)
		.join("/");
}

/** The tasks of one note's source, linked into list trees. */
export function parseNoteTasks(
	source: string,
	file: TaskFile,
	settings: TaskParseSettings,
): Task[] {
	const raw = source.split(/\r?\n/);
	const fallback = filenameDate(file.path, settings.filenameDates);
	// Comment-blanked lines decide where tasks are; the line as written is the
	// task, so an inline `%%note%%` stays in its description (as in Tasks) and
	// is hidden when the description renders.
	const lines = source.includes("%%")
		? blankCommentRanges(source, findCommentRanges(source)).split(/\r?\n/)
		: raw;
	const isContent = getContentLineFlags(raw);
	const tasks: Task[] = [];
	let heading: string | undefined;
	let open: { entry: ListEntry; width: number }[] = [];

	lines.forEach((text, line) => {
		if (!isContent[line] || text.trim() === "") return;
		const headingMatch = HEADING_LINE.exec(text);
		if (headingMatch) {
			heading = headingMatch[1];
			open = [];
			return;
		}
		const entry = LIST_START.test(text)
			? parseListLine(raw[line] ?? text, {
					file,
					line,
					heading,
					statuses: settings.statuses,
					globalFilter: settings.globalFilter,
				})
			: undefined;
		if (!entry) {
			// An unindented paragraph ends the list; an indented line continues its item.
			if (!/^[\s>]/.test(text)) open = [];
			return;
		}
		const width = indentWidth(entry.indentation);
		while ((open.at(-1)?.width ?? -1) >= width) open.pop();
		const parent = open.at(-1)?.entry;
		if (parent) {
			entry.parent = parent;
			parent.children.push(entry);
		}
		open.push({ entry, width });
		if (entry.kind !== "task") return;
		const { start, scheduled, due } = entry.dates;
		if (fallback !== undefined && !start && !scheduled && !due) {
			entry.dates.scheduled = { text: isoDay(fallback), day: fallback };
			entry.scheduledInferred = true;
		}
		tasks.push(entry);
	});
	return tasks;
}

const cache = new WeakMap<ContentIndex, Map<string, Promise<Task[]>>>();

function settingsKey(settings: TaskParseSettings): string {
	return JSON.stringify([
		settings.globalFilter,
		[...settings.statuses.values()],
		settings.filenameDates ?? null,
	]);
}

async function indexTasks(index: ContentIndex, settings: TaskParseSettings): Promise<Task[]> {
	const perNote = await Promise.all(
		index.pages.map(async (page) => {
			let source: string;
			try {
				source = await fs.readFile(page.absolutePath, "utf8");
			} catch {
				// A note deleted since the index was built has no tasks to list.
				return [];
			}
			return parseNoteTasks(source, { page, path: taskFilePath(page, index) }, settings);
		}),
	);
	return perNote.flat();
}

/** Every task in `indexes`, parsed once per index generation and settings. */
export async function collectTasks(
	indexes: readonly ContentIndex[],
	settings: TaskParseSettings,
): Promise<Task[]> {
	const key = settingsKey(settings);
	const lists = await Promise.all(
		indexes.map((index) => {
			let byKey = cache.get(index);
			if (!byKey) {
				byKey = new Map();
				cache.set(index, byKey);
			}
			let tasks = byKey.get(key);
			if (!tasks) {
				tasks = indexTasks(index, settings);
				byKey.set(key, tasks);
			}
			return tasks;
		}),
	);
	return lists.flat();
}
