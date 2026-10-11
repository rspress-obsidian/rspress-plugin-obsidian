/**
 * Kanban's markdown format, read the way the plugin's list parser
 * (`src/parsers/formats/list.ts`) reads it: every heading opens a lane, the
 * first list after it holds the lane's cards, `***` + `## Archive` holds the
 * archive, and a `%% kanban:settings %%` block holds the board's settings.
 */
import type { Heading, List, ListItem, Root, RootContent } from "mdast";
import { visit } from "unist-util-visit";
import { INLINE_TAG_PATTERN, tagNameFromMatch } from "../../../shared/paths.js";
import { extractInlineFields, type InlineField } from "../../dataview-metadata.js";
import { escapeRegExp } from "../../dataview-values.js";
import { parseWikiLink } from "../../parse-wikilink.js";
import { parseObsidianMarkdown, plainText } from "../../syntax.js";
import type { ParsedWikiLink } from "../../types.js";
import type { KanbanSettingsLayer, ResolvedKanbanSettings } from "./board-settings.js";

/** One card: a top-level item of a lane's list, with everything under it. */
export interface KanbanCard {
	/** The card's markdown as written, without its marker, checkbox or block id. */
	raw: string;
	/** The markdown the card shows: `raw` minus what the settings move out of it. */
	title: string;
	checked: boolean;
	/** The checkbox character (` ` when unchecked or absent). */
	checkChar: string;
	blockId?: string;
	/** Tags written in the card, with their `#`, sorted. */
	tags: string[];
	/** The last `@{…}` (or `@[[…]]`) date, as written. */
	dateText?: string;
	/** The last `@@{…}` time, as written. */
	timeText?: string;
	/** The last link to a note: the note whose metadata the card shows. */
	link?: ParsedWikiLink;
	/** `[key:: value]` fields and Tasks emoji fields, as Kanban extracts them. */
	inlineFields: InlineField[];
}

export interface KanbanLane {
	/** The heading's markdown, without its WIP limit. */
	title: string;
	/** The WIP limit `(N)` after the title; `0` when there is none. */
	maxItems: number;
	/** The lane has the `**Complete**` marker: cards moved into it are completed. */
	complete: boolean;
	/** The heading's line in the board's body (1-based). */
	line: number;
	cards: KanbanCard[];
}

export interface KanbanBoard {
	lanes: KanbanLane[];
	archive: KanbanCard[];
}

/** Which inline fields a card yields: Dataview's need `enableDataview`, emoji ones `enableTasks`. */
export interface InlineFieldSources {
	dataview: boolean;
	tasks: boolean;
}

/** The fields Tasks owns; Kanban only reads them from a card's first line. */
export const TASK_FIELDS: Record<string, true> = {
	priority: true,
	start: true,
	created: true,
	scheduled: true,
	due: true,
	completion: true,
	cancelled: true,
	id: true,
	dependsOn: true,
	recurrence: true,
};

const COMPLETE_MARKER = "Complete";
const ARCHIVE_HEADING = "Archive";
const SETTINGS_MARKER = "%% kanban:settings";

/** Nodes whose text is never read for tags, dates or times. */
const CODE_NODES: Record<string, true> = {
	inlineCode: true,
	code: true,
	math: true,
	inlineMath: true,
	html: true,
};

/** Nodes whose text is never read for tags (a `#` in a link is part of the link). */
const LINK_NODES: Record<string, true> = {
	image: true,
	linkReference: true,
	imageReference: true,
};

/**
 * The board's `%% kanban:settings %%` block. `error` describes a block that
 * is there but cannot be read; the board then renders with the global
 * settings, as nothing of the block can be trusted.
 */
export function extractSettingsBlock(body: string): {
	settings: KanbanSettingsLayer;
	error?: string;
} {
	const at = body.lastIndexOf(SETTINGS_MARKER);
	if (at < 0) return { settings: {} };
	const block = /^%% kanban:settings[ \t]*\r?\n[ \t]*```[^\n]*\r?\n([\s\S]*?)\r?\n?[ \t]*```/.exec(
		body.slice(at),
	);
	if (!block) return { settings: {}, error: "the block has no ``` fence holding its JSON" };
	try {
		const parsed: unknown = JSON.parse(block[1] ?? "");
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return { settings: parsed as KanbanSettingsLayer };
		}
		return { settings: {}, error: "the block's JSON is not an object" };
	} catch (error) {
		return {
			settings: {},
			error: `the block is not valid JSON (${error instanceof Error ? error.message : String(error)})`,
		};
	}
}

interface Range {
	start: number;
	end: number;
}

/** `text` with every range (relative offsets) blanked to `\0`, offsets kept. */
function mask(text: string, ranges: readonly Range[]): string {
	let masked = text;
	for (const { start, end } of ranges) {
		const from = Math.max(0, start);
		const to = Math.min(text.length, end);
		if (to > from) masked = masked.slice(0, from) + "\0".repeat(to - from) + masked.slice(to);
	}
	return masked;
}

/**
 * Kanban's `markRangeForDeletion` + `executeDeletion`: each range, widened
 * over the spaces around it, collapses into a single space.
 */
function deleteRanges(text: string, ranges: readonly Range[]): string {
	let marked = text;
	for (const range of ranges) {
		let start = range.start;
		while (start > 0 && marked[start - 1] === " ") start -= 1;
		let end = range.end;
		while (end < marked.length - 1 && marked[end] === " ") end += 1;
		marked = marked.slice(0, start) + "\0".repeat(end - start) + marked.slice(end);
	}
	return marked.replace(/ *\0+ */g, " ").trim();
}

/** Remove up to `columns` columns of indentation from every line after the first. */
function dedent(text: string, columns: number): string {
	return text
		.split("\n")
		.map((line, index) => {
			if (index === 0) return line;
			let column = 0;
			let cut = 0;
			while (cut < line.length && column < columns) {
				const char = line[cut];
				if (char === " ") column += 1;
				else if (char === "\t") column += 4 - (column % 4);
				else break;
				cut += 1;
			}
			return line.slice(cut);
		})
		.join("\n")
		.trim();
}

function offsetsOf(node: { position?: { start: { offset?: number }; end: { offset?: number } } }) {
	return { start: node.position?.start.offset ?? 0, end: node.position?.end.offset ?? 0 };
}

const collator = new Intl.Collator(undefined, { numeric: true });

function cardFromListItem(
	item: ListItem,
	body: string,
	settings: ResolvedKanbanSettings,
	sources: InlineFieldSources,
): KanbanCard {
	const { start, end } = offsetsOf(item);
	const itemSource = body.slice(start, end);
	const lineStart = body.lastIndexOf("\n", start - 1) + 1;
	const marker = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|(?=\r?\n)|$)/.exec(itemSource)?.[0] ?? "";
	// CommonMark's content column: the marker's own indentation plus its width.
	const indent = start - lineStart + marker.length;
	let consumed = marker.length;
	let checkChar = " ";
	let checked = false;
	const checkbox = /^\[([^\]\n])\](?:[ \t]+|(?=\r?\n)|$)/.exec(itemSource.slice(consumed));
	if (checkbox) {
		checkChar = checkbox[1] ?? " ";
		checked = checkChar !== " ";
		consumed += checkbox[0].length;
	}
	const contentStart = start + consumed;
	const content = body.slice(contentStart, end).replace(/\r\n?/g, "\n");

	const codeRanges: Range[] = [];
	const linkRanges: Range[] = [];
	const links: { range: Range; link: ParsedWikiLink }[] = [];
	visit(item, (node) => {
		const range = offsetsOf(node);
		const relative = { start: range.start - contentStart, end: range.end - contentStart };
		const type: string = node.type;
		if (CODE_NODES[type]) {
			codeRanges.push(relative);
		} else if (type === "wikiLink") {
			linkRanges.push(relative);
			const value = "value" in node && typeof node.value === "string" ? node.value : "";
			if (value.startsWith("[[")) {
				links.push({ range: relative, link: parseWikiLink(value.slice(2, -2), value) });
			}
		} else if (node.type === "link") {
			linkRanges.push(relative);
			if (!/:\/\//.test(node.url) && /\.md$/i.test(node.url)) {
				let target = node.url;
				try {
					target = decodeURIComponent(node.url);
				} catch {
					// Kept as written: the link is resolved the same way either way.
				}
				target = target.replace(/\.md$/i, "");
				links.push({ range: relative, link: parseWikiLink(target, `[[${target}]]`) });
			}
		} else if (LINK_NODES[type]) {
			linkRanges.push(relative);
		}
	});

	const deletions: Range[] = [];
	let blockId: string | undefined;
	const firstLineEnd = content.indexOf("\n") < 0 ? content.length : content.indexOf("\n");
	const blockMatch = /\s+\^([a-zA-Z0-9-]+)$/.exec(content.slice(0, firstLineEnd));
	if (blockMatch) {
		blockId = blockMatch[1];
		deletions.push({ start: blockMatch.index, end: firstLineEnd });
	}

	// Times first: a time trigger usually starts with the date trigger (`@@`, `@`).
	let codeMasked = mask(content, codeRanges);
	let timeText: string | undefined;
	const time = new RegExp(`(^|\\s)${escapeRegExp(settings.timeTrigger)}\\{([^}\\n]+)\\}`, "g");
	for (const match of codeMasked.matchAll(time)) {
		const from = match.index + (match[1]?.length ?? 0);
		timeText = match[2];
		if (settings.moveDates) deletions.push({ start: from, end: match.index + match[0].length });
		codeMasked = mask(codeMasked, [{ start: from, end: match.index + match[0].length }]);
	}
	let dateText: string | undefined;
	const dateLinks: Range[] = [];
	const trigger = escapeRegExp(settings.dateTrigger);
	const date = new RegExp(`(^|\\s)${trigger}(?:\\{([^}\\n]+)\\}|\\[\\[([^\\]\\n]+)\\]\\])`, "g");
	for (const match of codeMasked.matchAll(date)) {
		const range = {
			start: match.index + (match[1]?.length ?? 0),
			end: match.index + match[0].length,
		};
		dateText = match[2] ?? match[3];
		if (match[3] !== undefined) dateLinks.push(range);
		if (settings.moveDates) deletions.push(range);
	}

	const tags: string[] = [];
	for (const match of mask(codeMasked, linkRanges).matchAll(INLINE_TAG_PATTERN)) {
		const name = tagNameFromMatch(match[1] ?? "");
		if (!name || content[match.index - 1] === "\\") continue;
		tags.push(`#${name}`);
		if (settings.moveTags)
			deletions.push({ start: match.index, end: match.index + 1 + name.length });
	}
	tags.sort(collator.compare);

	const cardLinks = links.filter(
		({ range }) =>
			!dateLinks.some((dateLink) => range.start >= dateLink.start && range.end <= dateLink.end),
	);
	let title = dedent(deleteRanges(content, deletions), indent);
	const raw = dedent(
		blockMatch ? content.slice(0, blockMatch.index) + content.slice(firstLineEnd) : content,
		indent,
	);

	let inlineFields: InlineField[] = [];
	if (sources.dataview || sources.tasks) {
		const titleFirstLineEnd = title.indexOf("\n");
		inlineFields = extractInlineFields(title, sources.tasks, true).filter((field) => {
			if (field.wrapping === "emoji")
				return titleFirstLineEnd < 0 || field.end <= titleFirstLineEnd;
			if (!sources.dataview) return false;
			return !TASK_FIELDS[field.key] || titleFirstLineEnd < 0 || field.end <= titleFirstLineEnd;
		});
		const moveBody = settings.inlineMetadataPosition !== "body";
		for (const field of [...inlineFields].reverse()) {
			const isTask = field.wrapping === "emoji" || Boolean(TASK_FIELDS[field.key]);
			if (isTask ? !settings.moveTaskMetadata : !moveBody) continue;
			title = title.slice(0, field.start) + title.slice(field.end);
		}
		// A removed field leaves its spaces behind: collapse them between words,
		// and drop them at a line end, where two would make a hard break.
		title = title
			.replace(/[ \t]+\n/g, "\n")
			.replace(/(\S)[ \t]{2,}/g, "$1 ")
			.trim();
	}

	return {
		raw,
		title,
		checked,
		checkChar,
		...(blockId && { blockId }),
		tags,
		...(dateText !== undefined && { dateText }),
		...(timeText !== undefined && { timeText }),
		...(cardLinks.length > 0 && { link: cardLinks[cardLinks.length - 1]?.link }),
		inlineFields,
	};
}

/** Kanban's `parseLaneTitle`: `Doing (3)` is the lane `Doing` with a WIP limit of 3. */
function parseLaneTitle(text: string): { title: string; maxItems: number } {
	const title = text.replace(/<br>/g, "\n").trim();
	const match = /^(.*?)\s*\((\d+)\)$/.exec(title);
	return match ? { title: match[1] ?? "", maxItems: Number(match[2]) } : { title, maxItems: 0 };
}

function headingText(heading: Heading, body: string): string {
	const first = heading.children[0];
	const last = heading.children[heading.children.length - 1];
	if (!first || !last) return "";
	return body.slice(offsetsOf(first).start, offsetsOf(last).end);
}

/**
 * The list a lane's cards live in: the first list after its heading, before
 * the next heading or the settings block. A `Complete` paragraph on the way
 * marks the lane complete.
 */
function laneList(children: RootContent[], from: number): { list?: List; complete: boolean } {
	let complete = false;
	for (let index = from + 1; index < children.length; index += 1) {
		const child = children[index];
		if (!child || child.type === "heading") break;
		if (child.type === "list") return { list: child, complete };
		if (child.type === "paragraph") {
			const text = plainText(child.children).trim();
			if (text.startsWith(SETTINGS_MARKER)) break;
			if (text === COMPLETE_MARKER) complete = true;
		}
	}
	return { complete };
}

/** Read a board's body (frontmatter already removed) into lanes and an archive. */
export function parseKanbanBoard(
	body: string,
	settings: ResolvedKanbanSettings,
	sources: InlineFieldSources,
	enableMath: boolean,
): KanbanBoard {
	const tree: Root = parseObsidianMarkdown(body, { enableMath });
	const lanes: KanbanLane[] = [];
	const archive: KanbanCard[] = [];
	tree.children.forEach((child, index) => {
		if (child.type !== "heading") return;
		const { list, complete } = laneList(tree.children, index);
		const cards = (list?.children ?? []).map((item) =>
			cardFromListItem(item, body, settings, sources),
		);
		const isArchive =
			plainText(child.children).trim() === ARCHIVE_HEADING &&
			tree.children[index - 1]?.type === "thematicBreak";
		if (isArchive) {
			archive.push(...cards);
			return;
		}
		lanes.push({
			...parseLaneTitle(headingText(child, body)),
			complete,
			line: child.position?.start.line ?? 0,
			cards,
		});
	});
	return { lanes, archive };
}
