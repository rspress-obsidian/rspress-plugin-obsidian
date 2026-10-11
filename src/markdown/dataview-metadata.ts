/**
 * Page metadata the way Dataview indexes it (`data-import/markdown-file.ts` and
 * `data-import/inline-field.ts` of blacksmithgu/obsidian-dataview): frontmatter
 * properties, `key:: value` inline fields, and list items / tasks with their
 * nesting, fields and emoji shorthands.
 */
import { getContentLineFlags } from "../shared/content-flags.js";
import { INLINE_TAG_PATTERN, tagNameFromMatch } from "../shared/paths.js";
import { DataviewLink, parseDateLiteral, parseDuration } from "./dataview-values.js";
import type { DataviewListItem, DataviewTask } from "./types.js";

/** One `[key:: value]`, `(key:: value)`, emoji shorthand or full-line `key:: value`. */
export interface InlineField {
	key: string;
	value: string;
	/** Offset of the opening bracket (or emoji, or line start). */
	start: number;
	/** Offset just past the closing bracket. */
	end: number;
	wrapping: "[" | "(" | "emoji" | "line";
}

const WRAPPER_CLOSE: Record<string, string> = { "[": "]", "(": ")" };

/** Bracket-depth matching, so `[up:: [[Home]]]` closes on its own `]`. */
function findClosing(
	line: string,
	start: number,
	open: string,
	close: string,
): { value: string; end: number } | undefined {
	let nesting = 0;
	let escaped = false;
	for (let index = start; index < line.length; index += 1) {
		const char = line[index];
		if (char === "\\") {
			escaped = !escaped;
			continue;
		}
		if (escaped) {
			escaped = false;
			continue;
		}
		if (char === open) nesting += 1;
		else if (char === close) nesting -= 1;
		if (nesting < 0) return { value: line.slice(start, index).trim(), end: index + 1 };
	}
	return undefined;
}

function findWrappedField(line: string, start: number): InlineField | undefined {
	const open = line[start] ?? "";
	const close = WRAPPER_CLOSE[open];
	if (!close) return undefined;
	const separator = line.indexOf("::", start + 1);
	if (separator < 0) return undefined;
	const key = line.slice(start + 1, separator).trim();
	// A key never spans a bracket: `See [a link](x) and k:: v` is not a field.
	if (/[[\]()]/.test(key)) return undefined;
	const closing = findClosing(line, separator + 2, open, close);
	if (!closing) return undefined;
	return {
		key,
		value: closing.value,
		start,
		end: closing.end,
		wrapping: open === "[" ? "[" : "(",
	};
}

/** Tasks-plugin and Dataview emoji shorthands for task dates. */
const EMOJI_DATE_FIELDS: Array<{ pattern: RegExp; key: string }> = [
	{ pattern: /\u{2795}\s*(\d{4}-\d{2}-\d{2})/u, key: "created" },
	{ pattern: /\u{1F6EB}\s*(\d{4}-\d{2}-\d{2})/u, key: "start" },
	{ pattern: /[\u{23F3}\u{231B}]\s*(\d{4}-\d{2}-\d{2})/u, key: "scheduled" },
	{ pattern: /(?:\u{1F4C5}|\u{1F4C6}|\u{1F5D3}\u{FE0F}?)\s*(\d{4}-\d{2}-\d{2})/u, key: "due" },
	{ pattern: /\u{2705}\s*(\d{4}-\d{2}-\d{2})/u, key: "completion" },
];

/** Tasks-plugin priority signifiers, which Dataview itself leaves as text. */
const PRIORITY_EMOJI: Array<[string, string]> = [
	["\u{1F53A}", "highest"],
	["\u{23EB}", "high"],
	["\u{1F53C}", "medium"],
	["\u{1F53D}", "low"],
	["\u{23EC}", "lowest"],
];

/** Every Tasks-plugin signifier, so a 🔁 rule stops at the next one. */
const TASK_SIGNIFIER =
	/[\u{2795}\u{1F6EB}\u{23F3}\u{231B}\u{1F4C5}\u{1F4C6}\u{1F5D3}\u{2705}\u{274C}\u{1F53A}\u{23EB}\u{1F53C}\u{1F53D}\u{23EC}\u{1F194}\u{26D4}\u{1F3C1}\u{1F501}[(]/u;

function extractTaskShorthands(line: string, isTask: boolean): InlineField[] {
	const fields: InlineField[] = [];
	for (const { pattern, key } of EMOJI_DATE_FIELDS) {
		const match = pattern.exec(line);
		if (!match) continue;
		fields.push({
			key,
			value: match[1] ?? "",
			start: match.index,
			end: match.index + match[0].length,
			wrapping: "emoji",
		});
	}
	if (!isTask) return fields;
	for (const [emoji, priority] of PRIORITY_EMOJI) {
		const at = line.indexOf(emoji);
		if (at < 0) continue;
		fields.push({
			key: "priority",
			value: priority,
			start: at,
			end: at + emoji.length,
			wrapping: "emoji",
		});
		break;
	}
	const recurrence = line.indexOf("\u{1F501}");
	if (recurrence >= 0) {
		const from = recurrence + "\u{1F501}".length;
		const rest = line.slice(from);
		const stop = rest.search(TASK_SIGNIFIER);
		const rule = (stop < 0 ? rest : rest.slice(0, stop)).trim();
		if (rule) {
			fields.push({
				key: "recurrence",
				value: `"${rule.replace(/["\\]/g, "\\$&")}"`,
				start: recurrence,
				end: from + (stop < 0 ? rest.length : stop),
				wrapping: "emoji",
			});
		}
	}
	return fields;
}

/**
 * `[key:: value]` and `(key:: value)` fields in a line, plus the task emoji
 * shorthands when `includeTaskFields`, in source order and never overlapping.
 */
export function extractInlineFields(
	line: string,
	includeTaskFields = false,
	isTask = false,
): InlineField[] {
	let fields: InlineField[] = [];
	for (const wrapper of ["[", "("]) {
		let found = line.indexOf(wrapper);
		while (found >= 0) {
			const field = findWrappedField(line, found);
			if (!field) {
				found = line.indexOf(wrapper, found + 1);
				continue;
			}
			fields.push(field);
			found = line.indexOf(wrapper, field.end);
		}
	}
	if (includeTaskFields) fields = fields.concat(extractTaskShorthands(line, isTask));
	fields.sort((left, right) => left.start - right.start);
	const kept: InlineField[] = [];
	for (const field of fields) {
		const last = kept[kept.length - 1];
		if (!last || last.end <= field.start) kept.push(field);
	}
	return kept;
}

/**
 * A key that may stand alone on a line: leading markup (`- `, `**`, `> `) is
 * skipped, then letters, digits, spaces, `_`, `/`, `-` and emoji, then trailing
 * `_*~\``. Anything else — `[`, `:` — means the line is prose, not a field.
 */
const FULL_LINE_KEY =
	/^[^0-9\p{L}\p{N}_]*((?:[\p{L}\p{N}_\s/-]|\p{Extended_Pictographic}|\u200d|\ufe0f)+?)[_*~`]*$/u;

/** `key:: value` filling a whole line (or list item). */
export function extractFullLineField(text: string): InlineField | undefined {
	const separator = text.indexOf("::");
	if (separator < 0) return undefined;
	const match = FULL_LINE_KEY.exec(text.slice(0, separator).trim());
	const key = match?.[1]?.trim();
	if (!key) return undefined;
	return {
		key,
		value: text.slice(separator + 2).trim(),
		start: 0,
		end: text.length,
		wrapping: "line",
	};
}

const TAG_ATOM = /^#[^\u2000-\u206F\u2E00-\u2E7F'!"#$%&()*+,.:;<=>?@^`{|}~[\]\\\s]+$/u;

function parseInlineAtom(text: string): { ok: true; value: unknown } | { ok: false } {
	const value = text.trim();
	if (!value) return { ok: false };
	const date = parseDateLiteral(value);
	if (date) return { ok: true, value: date };
	const duration = parseDuration(value);
	if (duration) return { ok: true, value: duration.normalize() };
	const quoted = /^"((?:\\.|[^"\\])*)"$/.exec(value);
	if (quoted) return { ok: true, value: unescapeString(quoted[1] ?? "") };
	if (TAG_ATOM.test(value)) return { ok: true, value };
	const link = /^(!?)\[\[([^[\]]*?)\]\]$/.exec(value);
	if (link) return { ok: true, value: DataviewLink.parseInner(link[2] ?? "", link[1] === "!") };
	if (/^(?:true|false|True|False)$/.test(value))
		return { ok: true, value: value.toLowerCase() === "true" };
	if (/^-?\d+(?:\.\d+)?$/.test(value)) return { ok: true, value: Number.parseFloat(value) };
	if (value === "null") return { ok: true, value: null };
	return { ok: false };
}

/** Dataview's string escapes: `\"` and `\\` unescape, any other `\x` stays as written. */
export function unescapeString(value: string): string {
	return value.replace(/\\(.)/gu, (match, char: string) =>
		char === '"' || char === "\\" || char === "'" ? char : match,
	);
}

/** Split on commas outside quotes and `[[…]]`. */
function splitInlineList(value: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quoted = false;
	let start = 0;
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (quoted) {
			if (char === "\\") index += 1;
			else if (char === '"') quoted = false;
			continue;
		}
		if (char === '"') quoted = true;
		else if (char === "[") depth += 1;
		else if (char === "]") depth -= 1;
		else if (char === "," && depth === 0) {
			parts.push(value.slice(start, index));
			start = index + 1;
		}
	}
	parts.push(value.slice(start));
	return parts;
}

/**
 * An inline field value as Dataview reads it: a date, duration, quoted string,
 * tag, link, boolean, number or `null` — or a comma-separated list of those —
 * and otherwise the text itself. An empty value is `null`.
 */
export function parseInlineValue(value: string): unknown {
	if (value.trim() === "") return null;
	const parts = splitInlineList(value);
	if (parts.length > 1) {
		const atoms: unknown[] = [];
		for (const part of parts) {
			const atom = parseInlineAtom(part);
			if (!atom.ok) return value;
			atoms.push(atom.value);
		}
		return atoms;
	}
	const atom = parseInlineAtom(value);
	return atom.ok ? atom.value : value;
}

/**
 * A frontmatter string becomes a date, duration or link when it is exactly
 * one (`due: 2026-01-05`, `up: "[[Home]]"`), the way Dataview reads
 * properties. YAML timestamps arrive as JS dates at UTC; their wall-clock
 * fields are kept as local time, matching how Obsidian reads a property.
 */
function frontmatterLeaf(value: unknown): unknown {
	if (value instanceof Date) {
		const local = new Date(
			value.getUTCFullYear(),
			value.getUTCMonth(),
			value.getUTCDate(),
			value.getUTCHours(),
			value.getUTCMinutes(),
			value.getUTCSeconds(),
			value.getUTCMilliseconds(),
		);
		local.setFullYear(value.getUTCFullYear());
		return local;
	}
	if (typeof value !== "string") return value;
	const date = parseDateLiteral(value);
	if (date) return date;
	const duration = parseDuration(value);
	if (duration) return duration;
	const link = /^(!?)\[\[([^[\]]*?)\]\]$/.exec(value.trim());
	if (link) return DataviewLink.parseInner(link[2] ?? "", link[1] === "!");
	return value;
}

/**
 * Copy a frontmatter value into plain arrays and objects.
 *
 * js-yaml resolves a YAML alias to one shared object, so an alias bomb
 * (`bomb: &l0 [x, …]` plus nine references to the level below, per level) is a
 * handful of distinct arrays — but copying every element eagerly walks every
 * *path* through it, which is `9^depth` nodes: twelve levels of ~400 bytes of
 * frontmatter never finishes. Copies are therefore memoized by object identity,
 * so a repeated object is copied once and every reference reuses that copy and
 * the walk is linear in the number of distinct values — legitimate frontmatter
 * (nested maps, lists of maps) copies exactly as before.
 *
 * The ceiling is that distinct-value count rather than a depth or node cap,
 * which keeps shared frontmatter behaviorally identical. A value that is still
 * being copied — a genuinely cyclic `&a [*a]`, which js-yaml parses —
 * collapses to `null`: an unfinishable value degrades instead of recursing
 * until the stack blows.
 */
function normalizeFrontmatterValue(
	value: unknown,
	copies: WeakMap<object, unknown>,
	active: WeakSet<object>,
): unknown {
	if (value === undefined) return null;
	if (!value || typeof value !== "object" || value instanceof Date) return frontmatterLeaf(value);
	if (copies.has(value)) return copies.get(value);
	if (active.has(value)) return null;
	active.add(value);
	const copy = Array.isArray(value)
		? value.map((item) => normalizeFrontmatterValue(item, copies, active))
		: Object.fromEntries(
				Object.entries(value).map(([key, item]) => [
					key,
					normalizeFrontmatterValue(item, copies, active),
				]),
			);
	active.delete(value);
	copies.set(value, copy);
	return copy;
}

/**
 * Dataview's `canonicalizeVarName`: lowercase letters, digits, `_` and `-`
 * kept, whitespace becomes `-`, emoji kept, everything else dropped — so
 * `Due Date` is also readable as `due-date` and `**Status**` as `status`.
 */
export function canonicalizeKey(key: string): string {
	let result = "";
	for (const match of key.matchAll(
		/(\p{Extended_Pictographic}(?:\u200d\p{Extended_Pictographic}|\ufe0f)*)|([\p{L}\p{N}_-]+)|(\s)|./gsu,
	)) {
		if (match[1]) result += match[1];
		else if (match[2]) result += match[2].toLocaleLowerCase();
		else if (match[3]) result += "-";
	}
	return result;
}

type FieldGroups = Map<string, unknown[]>;

function addField(groups: FieldGroups, key: string, value: unknown): void {
	const existing = groups.get(key);
	if (existing) existing.push(value);
	else groups.set(key, [value]);
}

function mergeFieldGroups(target: FieldGroups, source: FieldGroups): void {
	for (const [key, values] of source) {
		const existing = target.get(key);
		if (existing) existing.push(...values);
		else target.set(key, [...values]);
	}
}

/**
 * Flatten collected values: one value stays a scalar, a repeated key becomes a
 * list, and every key is also reachable by its canonical form unless another
 * field already owns that name.
 */
function finalizeFields(groups: FieldGroups): Record<string, unknown> {
	const canonical: FieldGroups = new Map();
	for (const [key, values] of groups) {
		const name = canonicalizeKey(key);
		if (!name || groups.has(name)) continue;
		const existing = canonical.get(name);
		if (existing) existing.push(...values);
		else canonical.set(name, [...values]);
	}
	const fields: Record<string, unknown> = {};
	for (const source of [groups, canonical]) {
		for (const [key, values] of source) {
			fields[key] = values.length === 1 ? values[0] : values;
		}
	}
	return fields;
}

const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:([ \t]+)(.*))?$/u;
const TASK_BOX = /^\[(.)\](?:[ \t]+([\s\S]*))?$/u;
const THEMATIC_BREAK = /^[ \t]{0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const HEADING = /^[ \t]{0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
/** Lines that interrupt a paragraph, so they cannot lazily continue a list item. */
const BLOCK_START = /^[ \t]*(?:#{1,6}(?:[ \t]|$)|```|~~~|<[a-zA-Z/!]|\|)/;
const WIKILINK = /(!?)\[\[([^[\]]+?)\]\]/g;

function columnWidth(whitespace: string): number {
	let width = 0;
	for (const char of whitespace) width += char === "\t" ? 4 - (width % 4) : 1;
	return width;
}

interface OpenItem {
	item: DataviewListItem;
	contentIndent: number;
	textLines: string[];
}

/** Registry of each page's raw frontmatter, read back for `file.frontmatter`. */
const frontmatterByFields = new WeakMap<Record<string, unknown>, Record<string, unknown>>();

/** The frontmatter `extractDataviewMetadata` saw for a page's `fields` object. */
export function frontmatterOf(fields: Record<string, unknown>): Record<string, unknown> {
	return frontmatterByFields.get(fields) ?? {};
}

/** The `[[wikilinks]]` in a piece of text, as Dataview links. */
export function linksInText(text: string): DataviewLink[] {
	return [...text.matchAll(WIKILINK)].map((match) =>
		DataviewLink.parseInner(match[2] ?? "", match[1] === "!"),
	);
}

/** The `#tags` in a piece of text, with their `#`. */
export function tagsInText(text: string): string[] {
	const tags: string[] = [];
	for (const match of text.matchAll(INLINE_TAG_PATTERN)) {
		const tag = tagNameFromMatch(match[1] ?? "");
		if (tag) tags.push(`#${tag}`);
	}
	return tags;
}

/**
 * Index a note's Dataview metadata: frontmatter properties and inline fields
 * (as `fields`, raw keys plus canonical ones), and its list items and tasks.
 * Fields written on plain list items are page fields too; fields on a task
 * belong to that task, as in Dataview.
 */
export function extractDataviewMetadata(
	markdown: string,
	frontmatter: Record<string, unknown>,
	filePath: string,
): {
	fields: Record<string, unknown>;
	tasks: DataviewTask[];
	lists: DataviewListItem[];
} {
	const pageFields: FieldGroups = new Map();
	const copies = new WeakMap<object, unknown>();
	const active = new WeakSet<object>();
	const frontmatterCopy: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(frontmatter)) {
		const normalized = normalizeFrontmatterValue(value, copies, active);
		frontmatterCopy[key] = normalized;
		addField(pageFields, key, normalized);
	}

	const lines = markdown.split(/\r?\n/);
	// The shared boundary rule, not a third copy of it: a note opening on a
	// thematic break with no closing `---` is content, not endless frontmatter.
	const isContent = getContentLineFlags(lines);
	const open: OpenItem[] = [];
	const finished: OpenItem[] = [];
	let quoteDepth = 0;
	let previousBlank = true;
	let section: string | undefined;

	const parseContentLine = (line: string) => {
		if (line.length > 32_768 || !line.includes("::")) return;
		const trimmed = line.trim();
		const inline = extractInlineFields(trimmed);
		if (inline.length > 0) {
			for (const field of inline) addField(pageFields, field.key, parseInlineValue(field.value));
			return;
		}
		const full = extractFullLineField(trimmed);
		if (full) addField(pageFields, full.key, parseInlineValue(full.value));
	};

	for (let index = 0; index < lines.length; index += 1) {
		const raw = lines[index] ?? "";
		if (!isContent[index]) {
			open.length = 0;
			previousBlank = true;
			continue;
		}
		const quote = /^((?:[ \t]*>)*)/.exec(raw)?.[1] ?? "";
		const depth = (quote.match(/>/g) ?? []).length;
		let line = raw.slice(quote.length);
		if (depth > 0 && line.startsWith(" ")) line = line.slice(1);
		if (depth !== quoteDepth) {
			open.length = 0;
			quoteDepth = depth;
		}
		if (line.trim() === "") {
			previousBlank = true;
			continue;
		}

		const heading = HEADING.exec(line);
		if (heading) {
			open.length = 0;
			section = (heading[2] ?? "").trim();
			parseContentLine(line);
			previousBlank = false;
			continue;
		}
		if (THEMATIC_BREAK.test(line)) {
			open.length = 0;
			previousBlank = true;
			continue;
		}

		const listMatch = LIST_ITEM.exec(line);
		if (listMatch) {
			const indent = columnWidth(listMatch[1] ?? "");
			const symbol = listMatch[2] ?? "-";
			const spacing = columnWidth(listMatch[3] ?? " ");
			const contentIndent = indent + symbol.length + (spacing > 4 ? 1 : spacing);
			while (open.length > 0 && (open[open.length - 1]?.contentIndent ?? 0) > indent) open.pop();
			const parent = open[open.length - 1];
			let text = listMatch[4] ?? "";
			let status: string | undefined;
			const box = TASK_BOX.exec(text);
			if (box) {
				status = box[1];
				text = box[2] ?? "";
			}
			const item: DataviewListItem = {
				text: "",
				line: index,
				lineCount: 1,
				path: filePath,
				fields: {},
				symbol,
				children: [],
				tags: [],
				...(parent ? { parent: parent.item.line } : {}),
				...(section !== undefined ? { section } : {}),
				...(status !== undefined ? { status } : {}),
			};
			parent?.item.children.push(index);
			const entry: OpenItem = { item, contentIndent, textLines: [text.trim()] };
			open.push(entry);
			finished.push(entry);
			previousBlank = false;
			continue;
		}

		const indent = columnWidth(/^[ \t]*/.exec(line)?.[0] ?? "");
		if (open.length > 0 && !BLOCK_START.test(line)) {
			// Right after item text a line continues it lazily, as in CommonMark;
			// after a blank line it is a paragraph of the deepest item it is
			// indented under, and closes the items nested deeper than that.
			let owner = previousBlank ? -1 : open.length - 1;
			if (previousBlank) {
				for (let at = open.length - 1; at >= 0; at -= 1) {
					if ((open[at]?.contentIndent ?? 0) <= indent) {
						owner = at;
						break;
					}
				}
			}
			const entry = open[owner];
			if (entry) {
				open.length = owner + 1;
				entry.textLines.push(line.trim());
				entry.item.lineCount = index - entry.item.line + 1;
				previousBlank = false;
				continue;
			}
		}
		open.length = 0;
		parseContentLine(line);
		previousBlank = false;
	}

	const lists: DataviewListItem[] = [];
	const tasks: DataviewTask[] = [];
	const byLine = new Map<number, DataviewListItem>();
	const taskByLine = new Map<number, DataviewTask>();
	for (const { item, textLines } of finished) {
		item.text = textLines.join("\n");
		const flat = textLines.join(" ");
		const itemFields: FieldGroups = new Map();
		const isTask = item.status !== undefined;
		for (const field of extractInlineFields(flat, true, isTask)) {
			addField(itemFields, field.key, parseInlineValue(field.value));
		}
		if (!isTask && itemFields.size === 0) {
			const full = extractFullLineField(flat);
			if (full) addField(itemFields, full.key, parseInlineValue(full.value));
		}
		item.fields = finalizeFields(itemFields);
		item.tags = tagsInText(flat);
		if (!isTask) mergeFieldGroups(pageFields, itemFields);
		byLine.set(item.line, item);
		if (isTask) {
			const status = item.status ?? " ";
			const completed = status === "x" || status === "X";
			const task = Object.assign(item, { status, completed, fullyCompleted: completed });
			tasks.push(task);
			taskByLine.set(task.line, task);
		}
		lists.push(item);
	}
	// A task is fully completed only when every task nested under it is.
	for (const task of tasks) {
		if (task.completed) continue;
		let parentLine = task.parent;
		while (parentLine !== undefined) {
			const ancestor = taskByLine.get(parentLine);
			if (ancestor) ancestor.fullyCompleted = false;
			parentLine = byLine.get(parentLine)?.parent;
		}
	}

	const fields = finalizeFields(pageFields);
	frontmatterByFields.set(fields, frontmatterCopy);
	return { fields, tasks, lists };
}
