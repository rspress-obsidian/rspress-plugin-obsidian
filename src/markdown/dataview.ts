import { getContentLineFlags } from "../shared/content-flags.js";
import { escapeHtmlAttribute, escapeHtmlText, sanitizeUrl } from "../shared/escape.js";
import type { DailyNoteConfig } from "./daily-notes.js";
import { parseDailyNoteDate } from "./daily-notes.js";
import type { ContentIndex, ContentPage, DataviewListItem, DataviewTask } from "./types.js";
import { normalizeFilePathKey, routeHref } from "./utils.js";

interface DataviewLink {
	kind: "link";
	label: string;
	href: string;
}

interface QueryRow {
	page: ContentPage;
	values: Record<string, unknown>;
	item?: DataviewTask | DataviewListItem;
	groupRows?: QueryRow[];
}

interface QueryField {
	expression: string;
	label: string;
}

/** A single `FROM` source term, parsed into the kind Dataview documents. */
type SourceAtom =
	/** `#tag` — the page carries the tag or a sub-tag of it. */
	| { kind: "tag"; value: string }
	/** `"path"` — a folder (or one file), by lowercased vault path key. */
	| { kind: "folder"; value: string }
	/** `[[note]]` — pages that link to `note`. */
	| { kind: "link"; value: string }
	/** `inlinks([[note]])` — alias of the bare link form. */
	| { kind: "inlinks"; value: string }
	/** `outlinks([[note]])` — pages that `note` links to. */
	| { kind: "outlinks"; value: string };

type SourceExpression =
	| { kind: "atom"; atom: SourceAtom }
	| { kind: "not"; expression: SourceExpression }
	| { kind: "and" | "or"; left: SourceExpression; right: SourceExpression };

interface QueryPlan {
	kind: "TABLE" | "LIST" | "TASK" | "CALENDAR";
	fields: QueryField[];
	withoutId: boolean;
	source?: SourceExpression;
	where: string[];
	sort: Array<{ expression: string; descending: boolean }>;
	/** `GROUP BY` keys, in the order written; the first is the group label. */
	groupBy: Array<{ expression: string; label: string }>;
	flatten: Array<{ expression: string; alias?: string }>;
	/**
	 * `THEN <aggregate>` — a summary value per group, the way Dataview appends
	 * totals under a grouped table. Named `summary` rather than `then` so the
	 * plan never looks like a thenable to `await`.
	 */
	summary?: { expression: string };
	/** `LIMIT` operand: a literal count or an expression evaluated per query. */
	limitExpression?: string;
}

interface QueryResult {
	html?: string;
	error?: string;
}

const INLINE_FIELD_PATTERN = /[[(]([^\]():]+?)::\s*([^\])\n]+?)[\])]/g;
const STANDALONE_FIELD_PATTERN = /^\s*(?:[-*+]\s+|\d+[.)]\s+)?([^:\n]+?)::\s*(.*?)\s*$/;
const TASK_PATTERN = /^(\s*)([-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*)$/;
const LIST_PATTERN = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/** Vault-authored regexes are executed during the build, so both dimensions of
 *  a catastrophic backtracking blow-up are bounded: pattern size and the
 *  subject it runs against. */
const MAX_REGEX_PATTERN_LENGTH = 1000;
const MAX_REGEX_SUBJECT_LENGTH = 10_000;
/** Nested quantifiers (`(a+)+`, `a{2,}+`) are the textbook catastrophic
 *  backtracking shapes. This is deliberately a heuristic, not a ReDoS analyser —
 *  exotic blow-ups such as `(a|a)*` get through, bounded instead by the subject
 *  length cap. */
const NESTED_QUANTIFIER_PATTERN =
	/\((?:\\.|[^()\\])*[*+](?:\\.|[^()\\])*\)\s*[*+{]|\{\d+,?\d*\}\s*[*+{]/;

export function extractDataviewMetadata(
	markdown: string,
	frontmatter: Record<string, unknown>,
	filePath: string,
): {
	fields: Record<string, unknown>;
	tasks: DataviewTask[];
	lists: DataviewListItem[];
} {
	const fields: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(frontmatter)) {
		fields[key] = normalizeValue(value);
		fields[sanitizeFieldKey(key)] = normalizeValue(value);
	}

	const tasks: DataviewTask[] = [];
	const lists: DataviewListItem[] = [];
	const lines = markdown.split(/\r?\n/);
	// The shared boundary rule, not a third copy of it. This one previously
	// opened frontmatter on a bare leading `---` with no closing delimiter, so a
	// note opening on the thematic break lost every task, list item and inline
	// field below it while headings and tags still indexed — `getContentLineFlags`
	// requires the closing `---` precisely to avoid that.
	const isContent = getContentLineFlags(lines);

	for (let index = 0; index < lines.length; index += 1) {
		if (!isContent[index]) continue;
		const line = lines[index] ?? "";
		const taskMatch = TASK_PATTERN.exec(line);
		if (taskMatch) {
			const text = taskMatch[4] ?? "";
			const itemFields = fieldsFromLine(text);
			const task = {
				text: stripInlineFieldMarkup(text),
				completed: (taskMatch[3] ?? "").toLowerCase() === "x",
				line: index + 1,
				path: filePath,
				fields: itemFields,
			};
			tasks.push(task);
			lists.push(task);
			continue;
		}

		const listMatch = LIST_PATTERN.exec(line);
		if (listMatch) {
			const text = listMatch[3] ?? "";
			lists.push({
				text: stripInlineFieldMarkup(text),
				line: index + 1,
				path: filePath,
				fields: fieldsFromLine(text),
			});
			continue;
		}

		for (const field of extractInlineFields(line)) {
			fields[field.key] = field.value;
			fields[sanitizeFieldKey(field.key)] = field.value;
		}
	}

	return { fields, tasks, lists };
}

export function renderDataviewQuery(
	query: string,
	currentPage: ContentPage,
	index: ContentIndex,
	dailyConfig?: DailyNoteConfig,
): QueryResult {
	try {
		const plan = parseQuery(query);
		const rows = executeQuery(plan, currentPage, index, dailyConfig);
		return { html: renderRows(plan, rows) };
	} catch (error) {
		return {
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function renderDataviewInline(
	expression: string,
	currentPage: ContentPage,
	index: ContentIndex,
	dailyConfig?: DailyNoteConfig,
): QueryResult {
	try {
		const row = createPageRow(currentPage, index, dailyConfig);
		const value = evaluateExpression(expression.trim(), row, index);
		// An unknown field resolves to null rather than throwing. There is no
		// value to show, and prose like "the default = here." is far likelier to
		// be prose than a query, so emit no span at all and let the caller keep
		// the source as written — an empty `<span>` silently ate the text.
		if (value == null) return { html: "" };
		return { html: `<span class="dataview-inline">${renderValue(value)}</span>` };
	} catch (error) {
		return {
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

function parseQuery(source: string): QueryPlan {
	const lines = source
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"));
	const header = lines.shift();
	if (!header) throw new Error("Dataview query is empty.");

	const headerMatch = /^(TABLE|LIST|TASK|CALENDAR)\b\s*(.*)$/i.exec(header);
	if (!headerMatch) {
		throw new Error(`Unsupported Dataview query type: ${header}.`);
	}
	const kind = headerMatch[1]?.toUpperCase() as QueryPlan["kind"];
	const headerBody = headerMatch[2]?.trim() ?? "";
	const withoutId = /^WITHOUT\s+ID\b/i.test(headerBody);
	const fieldBody = withoutId ? headerBody.replace(/^WITHOUT\s+ID\b/i, "").trim() : headerBody;
	const fields =
		kind === "TABLE" || kind === "CALENDAR"
			? parseFields(fieldBody)
			: kind === "LIST" && fieldBody
				? parseFields(fieldBody)
				: [];
	const plan: QueryPlan = {
		kind,
		fields,
		withoutId,
		where: [],
		sort: [],
		groupBy: [],
		flatten: [],
	};

	for (const line of lines) {
		const from = /^FROM\s+(.+)$/i.exec(line);
		if (from) {
			if (plan.source) throw new Error("A Dataview query can contain only one FROM clause.");
			plan.source = parseSource(from[1] ?? "");
			continue;
		}
		const where = /^WHERE\s+(.+)$/i.exec(line);
		if (where) {
			plan.where.push(where[1]?.trim() ?? "");
			continue;
		}
		const sort = /^SORT\s+(.+)$/i.exec(line);
		if (sort) {
			for (const item of splitTopLevel(sort[1] ?? ",")) {
				const match = /^(.*?)(?:\s+(ASC|DESC))?$/i.exec(item.trim());
				if (!match?.[1]) throw new Error(`Invalid SORT expression: ${item}.`);
				plan.sort.push({
					expression: match[1].trim(),
					descending: match[2]?.toUpperCase() === "DESC",
				});
			}
			continue;
		}
		const group = /^GROUP\s+BY\s+(.+)$/i.exec(line);
		if (group) {
			// Dataview accepts several keys; each keeps its own alias, and a
			// repeated GROUP BY adds to the list rather than replacing it.
			for (const item of splitTopLevel(group[1] ?? ",")) {
				if (!item.trim()) continue;
				plan.groupBy.push(parseAliasedField(item));
			}
			continue;
		}
		const then = /^THEN\s+(.+)$/i.exec(line);
		if (then) {
			// One summary per group; a second THEN replaces the first rather than
			// rendering two summaries for the same rows.
			plan.summary = { expression: then[1]?.trim() ?? "" };
			continue;
		}
		const flatten = /^FLATTEN\s+(.+)$/i.exec(line);
		if (flatten) {
			const field = parseAliasedField(flatten[1] ?? "");
			plan.flatten.push({
				expression: field.expression,
				alias: field.label === field.expression ? undefined : field.label,
			});
			continue;
		}
		const limit = /^LIMIT\s+(.+)$/i.exec(line);
		if (limit) {
			// Dataview evaluates the operand as an expression, so `LIMIT
			// len(rows)` works as well as a literal count.
			plan.limitExpression = limit[1]?.trim() ?? "";
			continue;
		}
		throw new Error(`Unsupported Dataview command: ${line}.`);
	}

	return plan;
}

function parseFields(source: string): QueryField[] {
	if (!source) return [];
	return splitTopLevel(source).map(parseAliasedField);
}

function parseAliasedField(source: string): QueryField {
	const match = /^(.*?)\s+AS\s+(.+)$/i.exec(source.trim());
	if (match?.[1] && match[2]) {
		return { expression: match[1].trim(), label: stripQuotes(match[2].trim()) };
	}
	return { expression: source.trim(), label: source.trim() };
}
function executeQuery(
	plan: QueryPlan,
	currentPage: ContentPage,
	index: ContentIndex,
	dailyConfig?: DailyNoteConfig,
): QueryRow[] {
	// The FROM filter reads only the page, never the row's values, so it runs
	// before any row exists. Building all N rows and discarding most of them
	// cost the same for a query matching 40 pages as one matching 1960 — both
	// 2.43ms at 2000 pages, against 0.40ms with no FROM at all.
	const source = plan.source;
	const pages = source
		? index.pages.filter((page) => matchesSource(source, page, index))
		: index.pages;
	let rows =
		plan.kind === "TASK"
			? createTaskRows(pages, index, dailyConfig)
			: pages.map((page) => createPageRow(page, index, dailyConfig));
	for (const flatten of plan.flatten) {
		const next: QueryRow[] = [];
		const defaultAlias = flatten.expression.split(".").at(-1) ?? flatten.expression;
		const alias = flatten.alias ?? defaultAlias;
		for (const row of rows) {
			const value = evaluateExpression(flatten.expression, row, index);
			if (Array.isArray(value)) {
				for (const item of value) {
					next.push({
						...row,
						values: { ...row.values, [alias]: item },
					});
				}
			} else {
				next.push({ ...row, values: { ...row.values, [alias]: value } });
			}
		}
		rows = next;
	}
	for (const expression of plan.where) {
		rows = rows.filter((row) => Boolean(evaluateExpression(expression, row, index)));
	}
	if (plan.groupBy.length > 0) {
		// Every key is evaluated against each row and the results form a
		// composite key, so `GROUP BY status, owner` yields one row per pair —
		// grouping key by key would let the first key's representative value
		// decide the second.
		const groups = new Map<string, { values: unknown[]; members: QueryRow[] }>();
		for (const row of rows) {
			const values = plan.groupBy.map((key) => evaluateExpression(key.expression, row, index));
			const groupKey = stableValue(values);
			const group = groups.get(groupKey);
			if (group) group.members.push(row);
			else groups.set(groupKey, { values, members: [row] });
		}
		rows = [...groups.values()].map((group) => {
			const first = group.members[0];
			const values: Record<string, unknown> = { ...(first?.values ?? {}), rows: group.members };
			plan.groupBy.forEach((key, position) => {
				values[key.label] = group.values[position];
			});
			// `key` stays the first grouping key, matching Dataview's single-group
			// behaviour for the common one-key query.
			values.key = group.values[0];
			return {
				page: first?.page ?? currentPage,
				values,
				groupRows: group.members,
			};
		});
	}
	for (let sortIndex = plan.sort.length - 1; sortIndex >= 0; sortIndex -= 1) {
		const sort = plan.sort[sortIndex];
		if (!sort) continue;
		rows.sort((left, right) => {
			const comparison = compareValues(
				evaluateExpression(sort.expression, left, index),
				evaluateExpression(sort.expression, right, index),
			);
			return sort.descending ? -comparison : comparison;
		});
	}
	const limited = applyLimit(plan, rows, currentPage, index);

	// `THEN <aggregate>` appends a summary row per group, after sorting and the
	// limit, so the totals cover what the table actually shows.
	if (plan.summary) {
		return limited.map((row) => {
			const members = row.groupRows;
			if (!members || members.length === 0) return row;
			const summary = evaluateExpression(plan.summary?.expression ?? "", row, index);
			return {
				...row,
				values: { ...row.values, key: summary, rows: members },
			};
		});
	}
	return limited;
}

/** `LIMIT` over a literal count or an expression evaluated against a row. */
function applyLimit(
	plan: QueryPlan,
	rows: QueryRow[],
	currentPage: ContentPage,
	index: ContentIndex,
): QueryRow[] {
	if (plan.limitExpression === undefined) return rows;
	const literal = Number(plan.limitExpression);
	const count = Number.isFinite(literal)
		? literal
		: Number(
				evaluateExpression(
					plan.limitExpression,
					rows[0] ?? { page: currentPage, values: {} },
					index,
				),
			);
	if (!Number.isFinite(count) || count < 0) return rows;
	return rows.slice(0, count);
}

function createTaskRows(
	pages: ContentPage[],
	index: ContentIndex,
	dailyConfig?: DailyNoteConfig,
): QueryRow[] {
	const rows: QueryRow[] = [];
	for (const page of pages) {
		for (const task of page.dataviewTasks) {
			rows.push({
				page,
				item: task,
				values: {
					...createPageValues(page, index, dailyConfig),
					...task.fields,
					text: task.text,
					completed: task.completed,
					line: task.line,
				},
			});
		}
	}
	return rows;
}

function createPageRow(
	page: ContentPage,
	index: ContentIndex,
	dailyConfig?: DailyNoteConfig,
): QueryRow {
	return { page, values: createPageValues(page, index, dailyConfig) };
}
/**
 * Per-page value objects, keyed by page identity.
 *
 * A page's values depend only on `(page, index, dailyConfig)`, but a query
 * rebuilt them for every page on every fence — so a vault with a fence on
 * each of its N notes spent O(N²) building the same objects, once per
 * `new Date`, `toISOString` and outlink resolution each. One entry per page,
 * replaced whenever any of those three inputs changes, makes that linear.
 *
 * The entries are read-only. Every consumer copies before changing anything
 * (`executeQuery`'s FLATTEN/GROUP BY/summary stages all spread `row.values`,
 * and `createTaskRows` spreads the result), so sharing one object between
 * queries cannot leak a mutated value into the next fence.
 */
const pageValuesCache = new WeakMap<
	ContentPage,
	{ index: ContentIndex; dailyConfig?: DailyNoteConfig; values: Record<string, unknown> }
>();

function createPageValues(
	page: ContentPage,
	index: ContentIndex,
	dailyConfig?: DailyNoteConfig,
): Record<string, unknown> {
	const cached = pageValuesCache.get(page);
	if (cached && cached.index === index && cached.dailyConfig === dailyConfig) {
		return cached.values;
	}
	const ctime = new Date(page.fileCtimeMs);
	const mtime = new Date(page.fileMtimeMs);
	const dailyDate = dailyConfig ? parseDailyNoteDate(page.relativePath, dailyConfig) : undefined;
	const file = {
		path: page.relativePath,
		name: page.baseName,
		folder: page.relativePath.includes("/")
			? page.relativePath.slice(0, page.relativePath.lastIndexOf("/"))
			: "",
		ext: page.relativePath.split(".").pop() ?? "md",
		size: page.fileSizeBytes,
		link: pageLink(page),
		tags: page.tags.map((tag) => `#${tag}`),
		etags: [...page.tags],
		outlinks: page.wikilinkTargets.map((target) => linkForTarget(target, index)),
		inlinks: (index.backlinks.get(page.routePath) ?? []).map((backlink) => ({
			kind: "link" as const,
			label: backlink.title,
			href: backlink.routePath,
		})),
		tasks: page.dataviewTasks,
		lists: page.dataviewLists,
		ctime,
		mtime,
		cday: ctime.toISOString().slice(0, 10),
		mday: mtime.toISOString().slice(0, 10),
		day: dailyDate,
	};
	const values = {
		...page.dataviewFields,
		file,
		tags: file.tags,
		aliases: page.aliases,
		name: page.title ?? page.baseName,
	};
	pageValuesCache.set(page, { index, dailyConfig, values });
	return values;
}

/**
 * Normalize a `FROM` link or path argument — `[[note]]`, `[[note|alias]]`,
 * `[[note#heading]]`, `"folder"`, `"folder/File.md"` — to a vault path key.
 * Returns `undefined` for anything that is not a well-formed link or quoted
 * path, which the caller reports as an unsupported source.
 */
function normalizeSourcePath(raw: string): string | undefined {
	const quote = raw[0];
	const inner =
		raw.startsWith("[[") && raw.endsWith("]]")
			? raw.slice(2, -2)
			: (quote === '"' || quote === "'") && raw.length > 1 && raw.endsWith(quote)
				? raw.slice(1, -1)
				: undefined;
	if (inner === undefined) return undefined;
	// Alias and anchor fragments are ignored, matching the resolver.
	const key = normalizeFilePathKey((inner.split("|")[0] ?? "").split("#")[0] ?? "").toLowerCase();
	return key.length > 0 ? key : undefined;
}

/**
 * Parse a `FROM` clause into an expression tree of {@link SourceAtom}s.
 *
 * Unrecognized sources throw, so a malformed `FROM` surfaces through the
 * plugin's `onDataviewError` path instead of silently matching nothing.
 */
function parseSource(source: string): SourceExpression {
	const tokens: string[] = [];
	const pattern =
		/\s*(\[\[[^\]]*\]\]|inlinks|outlinks|#\S+|"[^"]*"|'[^']*'|\(|\)|-|AND|OR|[^\s()]+)/gi;
	for (const match of source.matchAll(pattern)) {
		if (match[1]) tokens.push(match[1]);
	}

	let cursor = 0;
	const fail = (): never => {
		throw new Error(`Unsupported Dataview source: ${source.trim()}`);
	};

	const parseAtom = (): SourceExpression => {
		if (tokens[cursor] === "-") {
			cursor += 1;
			return { kind: "not", expression: parseAtom() };
		}
		const token = tokens[cursor];
		if (!token) return fail();
		cursor += 1;

		if (token === "(") {
			const expression = parseOr();
			if (tokens[cursor] !== ")") return fail();
			cursor += 1;
			return expression;
		}

		const lower = token.toLowerCase();
		if (lower === "inlinks" || lower === "outlinks") {
			// `inlinks([[note]])` / `outlinks([[note]])` — one link argument.
			if (tokens[cursor] !== "(") return fail();
			cursor += 1;
			const value = normalizeSourcePath(tokens[cursor] ?? "");
			if (value === undefined || tokens[cursor + 1] !== ")") return fail();
			cursor += 2;
			return { kind: "atom", atom: { kind: lower, value } };
		}
		if (token.startsWith("#")) {
			const value = token.slice(1);
			return value ? { kind: "atom", atom: { kind: "tag", value } } : fail();
		}

		const value = normalizeSourcePath(token);
		if (value === undefined) return fail();
		if (token.startsWith("[[")) return { kind: "atom", atom: { kind: "link", value } };
		if (token.startsWith('"') || token.startsWith("'")) {
			return { kind: "atom", atom: { kind: "folder", value } };
		}
		return fail();
	};

	const parseAnd = (): SourceExpression => {
		let left = parseAtom();
		while (tokens[cursor]?.toUpperCase() === "AND") {
			cursor += 1;
			left = { kind: "and", left, right: parseAtom() };
		}
		return left;
	};

	const parseOr = (): SourceExpression => {
		let left = parseAnd();
		while (tokens[cursor]?.toUpperCase() === "OR") {
			cursor += 1;
			left = { kind: "or", left, right: parseAtom() };
		}
		return left;
	};

	if (tokens.length === 0) return fail();
	const expression = parseOr();
	// Trailing junk means the source did not parse as written.
	if (cursor < tokens.length) return fail();
	return expression;
}

function matchesSource(
	expression: SourceExpression,
	page: ContentPage,
	index: ContentIndex,
): boolean {
	switch (expression.kind) {
		case "not":
			return !matchesSource(expression.expression, page, index);
		case "and":
			return (
				matchesSource(expression.left, page, index) && matchesSource(expression.right, page, index)
			);
		case "or":
			return (
				matchesSource(expression.left, page, index) || matchesSource(expression.right, page, index)
			);
		default:
			return matchesSourceAtom(expression.atom, page, index);
	}
}

function matchesSourceAtom(atom: SourceAtom, page: ContentPage, index: ContentIndex): boolean {
	const filePathKey = page.filePathKey.toLowerCase();
	switch (atom.kind) {
		case "tag":
			return page.tags.some((tag) => tag === atom.value || tag.startsWith(`${atom.value}/`));
		case "folder":
			// A folder (or a single file) addressed by vault path, lowercased.
			return filePathKey === atom.value || filePathKey.startsWith(`${atom.value}/`);
		case "link":
		case "inlinks":
			// Pages that link *to* the target: the target appears in their outlinks.
			return page.wikilinkTargets.includes(atom.value);
		case "outlinks": {
			// Pages the target links *to*: resolve the target page and match its
			// own outlink targets against this row.
			const sources =
				index.byFilePathKeyCI.get(atom.value) ?? index.byBaseNameCI.get(atom.value) ?? [];
			return sources.some((source) =>
				source.wikilinkTargets.some((target) => {
					const key = normalizeFilePathKey(target).toLowerCase();
					const base = key.split("/").pop() ?? key;
					return (
						filePathKey === key ||
						page.baseName.toLowerCase() === base ||
						filePathKey.endsWith(`/${key}`)
					);
				}),
			);
		}
	}
}

function renderRows(plan: QueryPlan, rows: QueryRow[]): string {
	if (plan.kind === "LIST") {
		return `<ul class="dataview dataview-list">${rows.map((row) => `<li>${renderValue(plan.fields[0] ? evaluateExpression(plan.fields[0].expression, row, undefined) : row.values.file && typeof row.values.file === "object" ? (row.values.file as { link?: unknown }).link : row.page.baseName)}</li>`).join("")}</ul>`;
	}
	if (plan.kind === "TASK") {
		const taskHtml = rows
			.map((row) => {
				if (row.groupRows) {
					return `<li><strong>${renderValue(getField(row, "key"))}</strong><ul>${row.groupRows.map(renderTaskItem).join("")}</ul></li>`;
				}
				return renderTaskItem(row);
			})
			.join("");
		return `<ul class="dataview dataview-task-list">${taskHtml}</ul>`;
	}
	if (plan.kind === "CALENDAR") {
		return renderCalendarGrid(plan, rows);
	}
	const fields =
		plan.fields.length > 0 ? plan.fields : [{ expression: "file.link", label: "File" }];
	const headers = plan.withoutId ? fields : [{ expression: "file.link", label: "File" }, ...fields];
	const head = headers.map((field) => `<th>${escapeHtmlText(field.label)}</th>`).join("");
	const body = rows
		.map(
			(row) =>
				`<tr>${headers.map((field) => `<td>${renderValue(evaluateExpression(field.expression, row, undefined))}</td>`).join("")}</tr>`,
		)
		.join("");
	return `<table class="dataview dataview-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}
function renderTaskItem(row: QueryRow): string {
	const task = row.item;
	if (!task) return "";
	const checked = "completed" in task && task.completed ? " checked" : "";
	return `<li><input type="checkbox" disabled${checked} /> ${escapeHtmlText(task.text)}</li>`;
}

/**
 * Token lists per expression source. A query evaluates its expressions once
 * per row and the same expression strings recur across every fence in the
 * vault, so re-running the tokenizer each time was 15% of a Dataview render.
 * The tokens are derived only from the source and are read, never consumed.
 */
const expressionTokens = new Map<string, string[]>();

function evaluateExpression(source: string, row: QueryRow, _index?: ContentIndex): unknown {
	let tokens = expressionTokens.get(source);
	if (!tokens) {
		tokens = tokenizeExpression(source);
		expressionTokens.set(source, tokens);
	}
	let cursor = 0;
	const parseOr = (): unknown => {
		let value = parseAnd();
		while (tokens[cursor]?.toUpperCase() === "OR") {
			cursor += 1;
			const right = Boolean(parseAnd());
			value = Boolean(value) || right;
		}
		return value;
	};
	const parseAnd = (): unknown => {
		let value = parseComparison();
		while (tokens[cursor]?.toUpperCase() === "AND") {
			cursor += 1;
			const right = Boolean(parseComparison());
			value = Boolean(value) && right;
		}
		return value;
	};
	const parseComparison = (): unknown => {
		let left = parseAdditive();
		const operator = tokens[cursor];
		if (operator && ["=", "!=", "<", "<=", ">", ">="].includes(operator)) {
			cursor += 1;
			const right = parseAdditive();
			const comparison = compareValues(left, right);
			left =
				operator === "="
					? comparison === 0
					: operator === "!="
						? comparison !== 0
						: operator === "<"
							? comparison < 0
							: operator === "<="
								? comparison <= 0
								: operator === ">"
									? comparison > 0
									: comparison >= 0;
		}
		return left;
	};
	const parseAdditive = (): unknown => {
		let value = parseMultiplicative();
		while (tokens[cursor] === "+" || tokens[cursor] === "-") {
			const operator = tokens[cursor++];
			const right = parseMultiplicative();
			value =
				operator === "+"
					? typeof value === "string" || typeof right === "string"
						? `${value ?? ""}${right ?? ""}`
						: Number(value ?? 0) + Number(right ?? 0)
					: Number(value ?? 0) - Number(right ?? 0);
		}
		return value;
	};
	const parseMultiplicative = (): unknown => {
		let value = parseUnary();
		while (tokens[cursor] === "*" || tokens[cursor] === "/") {
			const operator = tokens[cursor++];
			const right = Number(parseUnary());
			value =
				operator === "*"
					? Number(value ?? 0) * right
					: right === 0
						? null
						: Number(value ?? 0) / right;
		}
		return value;
	};
	const parseUnary = (): unknown => {
		if (tokens[cursor] === "!" || tokens[cursor]?.toUpperCase() === "NOT") {
			cursor += 1;
			return !parseUnary();
		}
		if (tokens[cursor] === "-") {
			cursor += 1;
			return -Number(parseUnary());
		}
		return parsePrimary();
	};
	const parsePrimary = (): unknown => {
		const token = tokens[cursor++];
		if (token === "(") {
			const value = parseOr();
			if (tokens[cursor] === ")") cursor += 1;
			return value;
		}
		if (!token) return null;
		if (token.startsWith('"') || token.startsWith("'"))
			return token.slice(1, -1).replace(/\\([\\"'])/g, "$1");
		if (/^\d+(?:\.\d+)?$/.test(token)) return Number(token);
		// `today` and `now` are DQL literals, not field lookups: a note can have
		// a field called `today`, but the query language reserves the word.
		if (token.toLowerCase() === "today") return new Date().toISOString().slice(0, 10);
		if (token.toLowerCase() === "now") return new Date();
		if (token.toLowerCase() === "true") return true;
		if (token.toLowerCase() === "false") return false;
		if (token.toLowerCase() === "null") return null;
		if (tokens[cursor] === "(") {
			cursor += 1;
			const args: unknown[] = [];
			while (tokens[cursor] && tokens[cursor] !== ")") {
				args.push(parseOr());
				if (tokens[cursor] === ",") cursor += 1;
				else break;
			}
			if (tokens[cursor] === ")") cursor += 1;
			return evaluateFunction(token, args);
		}
		// Bracket indexing: `rows[0]`, `scores[-1]`, `tags[1]`. Chained indexes
		// walk further into the value, and an out-of-range index reads as null
		// rather than throwing mid-query.
		let value = getField(row, token);
		while (tokens[cursor] === "[") {
			cursor += 1;
			let indexToken = tokens[cursor];
			// The tokenizer reads a leading `-` as its own token, so a negative
			// index is rejoined here rather than leaking into the arithmetic
			// that follows.
			if (indexToken === "-" && /^\d+$/.test(tokens[cursor + 1] ?? "")) {
				indexToken = `-${tokens[cursor + 1]}`;
				cursor += 1;
			}
			if (tokens[cursor + 1] === "]") cursor += 2;
			if (indexToken === undefined) break;
			value = readIndex(value, indexToken);
		}
		return value;
	};
	return parseOr();
}

/** One `field[index]` step, where the index is a literal number or a quoted key. */
function readIndex(value: unknown, indexToken: string): unknown {
	const source = Array.isArray(value) ? value : null;
	const key = /^-?\d+$/.test(indexToken)
		? Number(indexToken)
		: indexToken.replace(/^["']|["']$/g, "");
	if (source) {
		const at = Number(key);
		if (!Number.isInteger(at)) return null;
		// A negative index counts back from the end, as DQL does.
		const resolved = at < 0 ? source.length + at : at;
		return source[resolved] ?? null;
	}
	if (value && typeof value === "object") {
		return readProperty(value, String(key));
	}
	return null;
}

function tokenizeExpression(source: string): string[] {
	const tokens: string[] = [];
	const pattern =
		/\s*(\[\[[^\]]+\]\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|<=|>=|!=|=|<|>|\(|\)|\[|\]|,|!|\+|\*|\/|-|\d+(?:\.\d+)?|[A-Za-z_][A-Za-z0-9_.-]*)/g;
	for (const match of source.matchAll(pattern)) {
		if (match[1]) tokens.push(match[1]);
	}
	return tokens;
}

function compileDataviewRegex(pattern: string, flags: string, subject: string): RegExp {
	if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
		throw new Error(
			`Dataview pattern is too long (${pattern.length} characters, limit ${MAX_REGEX_PATTERN_LENGTH}).`,
		);
	}
	if (subject.length > MAX_REGEX_SUBJECT_LENGTH) {
		throw new Error(
			`Dataview regex subject is too long (${subject.length} characters, limit ${MAX_REGEX_SUBJECT_LENGTH}).`,
		);
	}
	if (NESTED_QUANTIFIER_PATTERN.test(pattern)) {
		throw new Error(`Dataview pattern "${pattern}" uses nested quantifiers.`);
	}
	return new RegExp(pattern, flags);
}

function evaluateFunction(name: string, args: unknown[]): unknown {
	const normalized = name.toLowerCase();
	if (normalized === "date") return parseDateValue(args[0]);
	if (normalized === "today") return new Date().toISOString().slice(0, 10);
	if (normalized === "length")
		return Array.isArray(args[0]) || typeof args[0] === "string" ? args[0].length : 0;
	if (normalized === "contains")
		return Array.isArray(args[0])
			? args[0].some((value) => compareValues(value, args[1]) === 0)
			: String(args[0] ?? "").includes(String(args[1] ?? ""));
	if (normalized === "startswith") return String(args[0] ?? "").startsWith(String(args[1] ?? ""));
	if (normalized === "endswith") return String(args[0] ?? "").endsWith(String(args[1] ?? ""));
	if (normalized === "lower") return String(args[0] ?? "").toLowerCase();
	if (normalized === "upper") return String(args[0] ?? "").toUpperCase();
	if (normalized === "round") {
		const digits = Number(args[1] ?? 0);
		const factor = 10 ** digits;
		return Math.round(Number(args[0] ?? 0) * factor) / factor;
	}
	if (normalized === "floor") return Math.floor(Number(args[0] ?? 0));
	if (normalized === "ceil") return Math.ceil(Number(args[0] ?? 0));
	if (normalized === "regexmatch") {
		const subject = String(args[1] ?? "");
		return compileDataviewRegex(String(args[0] ?? ""), "", subject).test(subject);
	}
	if (normalized === "replace") {
		const input = String(args[0] ?? "");
		return input.replace(
			compileDataviewRegex(String(args[1] ?? ""), "g", input),
			String(args[2] ?? ""),
		);
	}
	if (normalized === "split") return String(args[0] ?? "").split(String(args[1] ?? ","));
	if (normalized === "join")
		return Array.isArray(args[0])
			? args[0].map(String).join(String(args[1] ?? ", "))
			: String(args[0] ?? "");
	if (normalized === "typeof") {
		if (args[0] instanceof Date) return "date";
		return Array.isArray(args[0]) ? "array" : args[0] === null ? "null" : typeof args[0];
	}
	if (normalized === "default") return args[0] == null ? args[1] : args[0];
	if (normalized === "choice") return args[0] ? args[1] : args[2];
	// Date arithmetic and formatting: Dataview's `date()` returns a Luxon-style
	// date, and these are the operations notes reach for most.
	if (
		normalized === "year" ||
		normalized === "month" ||
		normalized === "weeknumber" ||
		normalized === "weekyear"
	) {
		const date = parseDateValue(args[0]);
		if (!date) return null;
		if (normalized === "year") return date.getUTCFullYear();
		if (normalized === "month") return date.getUTCMonth() + 1;
		if (normalized === "weekyear") return isoWeekParts(date).year;
		return isoWeekParts(date).week;
	}
	if (normalized === "weekday") {
		const date = parseDateValue(args[0]);
		// Luxon numbers weekdays 1 (Monday) through 7 (Sunday).
		if (!date) return null;
		const day = date.getUTCDay();
		return day === 0 ? 7 : day;
	}
	if (normalized === "hour" || normalized === "minute" || normalized === "second") {
		const date = parseDateValue(args[0]);
		if (!date) return null;
		if (normalized === "hour") return date.getUTCHours();
		if (normalized === "minute") return date.getUTCMinutes();
		return date.getUTCSeconds();
	}
	if (normalized === "now") return new Date();
	if (normalized === "striptime") {
		const date = parseDateValue(args[0]);
		return date
			? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
			: null;
	}
	if (normalized === "dateformat" || normalized === "formatdate") {
		const date = parseDateValue(args[0]);
		if (!date) return null;
		return formatDataviewDate(date, String(args[1] ?? "yyyy-MM-dd"));
	}
	if (normalized === "dateplus" || normalized === "dateminus") {
		const date = parseDateValue(args[0]);
		if (!date) return null;
		const duration = normalizeDuration(args[1]);
		if (!duration) return null;
		const sign = normalized === "dateplus" ? 1 : -1;
		return addDuration(date, duration, sign);
	}
	// String helpers Dataview notes reach for beyond the basic set.
	if (normalized === "trim") return String(args[0] ?? "").trim();
	if (normalized === "truncate") {
		const input = String(args[0] ?? "");
		const length = Number(args[1] ?? 0);
		return length >= 0
			? input.slice(0, length)
			: input.slice(0, Math.max(0, input.length + length));
	}
	if (normalized === "padleft" || normalized === "padright") {
		const input = String(args[0] ?? "");
		const length = Number(args[1] ?? 0);
		const fill = String(args[2] ?? " ").slice(0, 1) || " ";
		const padding = fill.repeat(Math.max(0, length - input.length));
		return normalized === "padleft" ? padding + input : input + padding;
	}
	if (normalized === "titlecase" || normalized === "capitalize") {
		const input = String(args[0] ?? "");
		const cased = input.replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
		return normalized === "titlecase" ? cased : cased.charAt(0).toUpperCase() + cased.slice(1);
	}
	if (normalized === "reversestring") return [...String(args[0] ?? "")].reverse().join("");
	if (normalized === "firstvalueof" || normalized === "lastvalueof") {
		const source = Array.isArray(args[0]) ? args[0] : [];
		return normalized === "firstvalueof"
			? (source[0] ?? null)
			: (source[source.length - 1] ?? null);
	}
	if (normalized === "nonnull" || normalized === "defaultblank") {
		const values = (Array.isArray(args[0]) ? args[0] : []).filter(
			(value) => value !== null && value !== undefined && value !== "",
		);
		return normalized === "nonnull" ? values : (values[0] ?? null);
	}
	if (normalized === "strictsort") {
		return [...(Array.isArray(args[0]) ? args[0] : [])].sort(compareValues);
	}
	if (normalized === "distinct" || normalized === "unique") {
		const seen = new Set<string>();
		const values: unknown[] = [];
		for (const value of Array.isArray(args[0]) ? args[0] : []) {
			const key = stableValue(value);
			if (seen.has(key)) continue;
			seen.add(key);
			values.push(value);
		}
		return values;
	}
	if (normalized === "flatten") {
		const values = Array.isArray(args[0]) ? args[0] : [];
		return Array.isArray(args[1])
			? values.flatMap((value) => (Array.isArray(value) ? value : [value]))
			: values;
	}
	if (normalized === "any" || normalized === "all") {
		const values = Array.isArray(args[0]) ? args[0] : [];
		return normalized === "any"
			? values.some((value) => Boolean(value))
			: values.every((value) => Boolean(value));
	}
	if (["sum", "average", "min", "max"].includes(normalized)) {
		const values = (Array.isArray(args[0]) ? args[0] : args).map(Number).filter(Number.isFinite);
		if (normalized === "sum") return values.reduce((sum, value) => sum + value, 0);
		if (normalized === "average")
			return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
		if (normalized === "min") return values.length ? Math.min(...values) : null;
		return values.length ? Math.max(...values) : null;
	}
	throw new Error(`Unsupported Dataview function: ${name}.`);
}
function getField(row: QueryRow, path: string): unknown {
	if (path.startsWith("[[") && path.endsWith("]]"))
		return {
			kind: "link",
			label: path.slice(2, -2),
			href: "#",
		} satisfies DataviewLink;
	const parts = path.split(".");
	let current: unknown = row.values;
	for (const part of parts) {
		if (Array.isArray(current)) {
			current = current.map((item) => readProperty(item, part));
			continue;
		}
		current = readProperty(current, part);
		if (current === undefined) return undefined;
	}
	return current;
}

function readProperty(value: unknown, property: string): unknown {
	if (!value || typeof value !== "object") return undefined;
	if ("values" in value && value.values && typeof value.values === "object") {
		value = value.values;
	}
	if (!value || typeof value !== "object") return undefined;
	// The three-way match and its single `find` are kept exactly as they were:
	// the first key satisfying ANY test wins, so hoisting the cheap tests into
	// tiers would change which of two matching keys is returned. Only the
	// sanitizing is memoized — it ran a regex strip, trim, lowercase and
	// whitespace collapse for every key of every row, and frontmatter keys
	// repeat across the whole vault.
	const lower = property.toLowerCase();
	const entry = Object.entries(value).find(
		([key]) => key === property || key.toLowerCase() === lower || sanitizedFieldKey(key) === lower,
	);
	return entry?.[1];
}

const sanitizedFieldKeys = new Map<string, string>();

function sanitizedFieldKey(key: string): string {
	const cached = sanitizedFieldKeys.get(key);
	if (cached !== undefined) return cached;
	const sanitized = sanitizeFieldKey(key);
	sanitizedFieldKeys.set(key, sanitized);
	return sanitized;
}

function renderValue(value: unknown): string {
	if (value == null) return "";
	if (isDataviewLink(value)) {
		// The href can come straight from note frontmatter, so it is untrusted
		// whenever the vault is: `escapeHtmlAttribute` stops quote-breaking but
		// happily emits `href="javascript:..."`. A rejected URL degrades to the
		// label as plain text rather than a live link.
		const href = sanitizeUrl(value.href);
		return href
			? `<a href="${escapeHtmlAttribute(href)}">${escapeHtmlText(value.label)}</a>`
			: escapeHtmlText(value.label);
	}
	if (value instanceof Date) return escapeHtmlText(value.toISOString().slice(0, 10));
	if (Array.isArray(value)) return value.map(renderValue).join(", ");
	if (typeof value === "object") return escapeHtmlText(JSON.stringify(value));
	return escapeHtmlText(String(value));
}

function createLink(page: ContentPage): DataviewLink {
	return {
		kind: "link",
		label: page.title ?? page.baseName,
		href: routeHref(page.routePath, page.relativePath),
	};
}

function pageLink(page: ContentPage): DataviewLink {
	return createLink(page);
}

function linkForTarget(target: string, index: ContentIndex): DataviewLink {
	const key = normalizeFilePathKey(target).toLowerCase();
	const page =
		index.byFilePathKeyCI.get(key)?.[0] ?? index.byBaseNameCI.get(key.split("/").pop() ?? key)?.[0];
	return page ? createLink(page) : { kind: "link", label: target, href: `/${target}` };
}

function extractInlineFields(line: string): Array<{ key: string; value: unknown }> {
	const fields: Array<{ key: string; value: unknown }> = [];
	for (const match of line.matchAll(INLINE_FIELD_PATTERN)) {
		const key = stripMarkdownMarkup(match[1] ?? "").trim();
		if (key) fields.push({ key, value: parseValue(match[2] ?? "") });
	}
	const standalone = STANDALONE_FIELD_PATTERN.exec(line);
	if (standalone?.[1])
		fields.push({
			key: stripMarkdownMarkup(standalone[1]).trim(),
			value: parseValue(standalone[2] ?? ""),
		});
	return fields;
}

function fieldsFromLine(line: string): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	for (const field of extractInlineFields(line)) {
		fields[field.key] = field.value;
		fields[sanitizeFieldKey(field.key)] = field.value;
	}
	return fields;
}

function parseValue(value: string): unknown {
	const trimmed = value.trim();
	if (!trimmed) return "";
	if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
	if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
	if (/^\d{4}-\d{2}-\d{2}(?:T[^\s]+)?$/.test(trimmed)) return parseDateValue(trimmed);
	if (
		(trimmed.startsWith("[") && trimmed.endsWith("]")) ||
		(trimmed.startsWith("(") && trimmed.endsWith(")"))
	)
		return trimmed
			.slice(1, -1)
			.split(",")
			.map((item) => parseValue(item));
	return stripQuotes(trimmed);
}

function parseDateValue(value: unknown): Date | null {
	if (value instanceof Date) return value;
	if (typeof value !== "string") return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
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
 * ponytail: the ceiling is that distinct-value count rather than a depth or
 * node cap, which keeps shared frontmatter behaviorally identical. A value that
 * is still being copied — a genuinely cyclic `&a [*a]`, which js-yaml parses —
 * collapses to `null`: an unfinishable value degrades instead of recursing
 * until the stack blows.
 */
function normalizeValue(
	value: unknown,
	copies: WeakMap<object, unknown> = new WeakMap(),
	active: WeakSet<object> = new WeakSet(),
): unknown {
	if (value instanceof Date) return value;
	if (!value || typeof value !== "object") return value;
	if (copies.has(value)) return copies.get(value);
	if (active.has(value)) return null;
	active.add(value);
	const copy = Array.isArray(value)
		? value.map((item) => normalizeValue(item, copies, active))
		: Object.fromEntries(
				Object.entries(value).map(([key, item]) => [key, normalizeValue(item, copies, active)]),
			);
	active.delete(value);
	copies.set(value, copy);
	return copy;
}

function sanitizeFieldKey(key: string): string {
	return stripMarkdownMarkup(key).trim().toLowerCase().replace(/\s+/g, "-");
}

function stripInlineFieldMarkup(value: string): string {
	return value.replace(INLINE_FIELD_PATTERN, "").trim();
}

function stripMarkdownMarkup(value: string): string {
	return value.replace(/[*_~`]/g, "");
}

function stripQuotes(value: string): string {
	return value.replace(/^("|')|("|')$/g, "");
}

function splitTopLevel(value: string): string[] {
	const result: string[] = [];
	let start = 0;
	let depth = 0;
	let quote = "";
	for (let index = 0; index < value.length; index += 1) {
		const char = value[index];
		if (quote) {
			if (char === quote && value[index - 1] !== "\\") quote = "";
			continue;
		}
		if (char === '"' || char === "'") quote = char;
		else if (char === "(") depth += 1;
		else if (char === ")") depth -= 1;
		else if (char === "," && depth === 0) {
			result.push(value.slice(start, index).trim());
			start = index + 1;
		}
	}
	result.push(value.slice(start).trim());
	return result.filter(Boolean);
}

function compareValues(left: unknown, right: unknown): number {
	if (left == null && right == null) return 0;
	if (left == null) return -1;
	if (right == null) return 1;
	if (isDataviewLink(left) && isDataviewLink(right)) {
		return left.href === right.href
			? 0
			: left.label.localeCompare(right.label, undefined, {
					sensitivity: "base",
				});
	}
	if (isDataviewLink(left)) return left.label.localeCompare(String(right));
	if (isDataviewLink(right)) return String(left).localeCompare(right.label);
	const leftDate = left instanceof Date ? left.getTime() : undefined;
	const rightDate = right instanceof Date ? right.getTime() : undefined;
	if (leftDate !== undefined && rightDate !== undefined) return leftDate - rightDate;
	if (typeof left === "number" && typeof right === "number") return left - right;
	return String(left).localeCompare(String(right), undefined, {
		numeric: true,
		sensitivity: "base",
	});
}

function stableValue(value: unknown): string {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === "object") return JSON.stringify(value);
	return String(value);
}

function isDataviewLink(value: unknown): value is DataviewLink {
	return Boolean(value && typeof value === "object" && (value as DataviewLink).kind === "link");
}

/** The date a calendar row is filed under: `file.day` for a daily note, else its creation day. */
function calendarDate(row: QueryRow): Date | undefined {
	const raw = getField(row, "file.day") ?? getField(row, "file.cday");
	// `file.day` is already a Date; `file.cday` is the ISO day string. Both are
	// read as UTC so a calendar never shifts a note across a day boundary.
	if (raw instanceof Date) {
		return Number.isNaN(raw.getTime()) ? undefined : raw;
	}
	if (typeof raw !== "string") return undefined;
	const date = new Date(`${raw}T00:00:00Z`);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

const CALENDAR_WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/**
 * Render a CALENDAR query as a month grid, the way Dataview does.
 *
 * One grid per month present in the results, newest first. Rows without a date
 * keep the flat list they used to render in, so a query over undated notes still
 * shows something useful instead of an empty calendar.
 */
function renderCalendarGrid(plan: QueryPlan, rows: QueryRow[]): string {
	const dated: { row: QueryRow; date: Date }[] = [];
	const undated: QueryRow[] = [];
	for (const row of rows) {
		const date = calendarDate(row);
		if (date) dated.push({ row, date });
		else undated.push(row);
	}
	if (dated.length === 0) return renderCalendarList(plan, rows);

	const months = new Map<string, { date: Date; rows: QueryRow[] }>();
	for (const entry of dated) {
		const key = `${entry.date.getUTCFullYear()}-${entry.date.getUTCMonth()}`;
		const month = months.get(key);
		if (month) month.rows.push(entry.row);
		else months.set(key, { date: entry.date, rows: [entry.row] });
	}
	const ordered = [...months.values()].sort(
		(left, right) => right.date.getTime() - left.date.getTime(),
	);

	const grids = ordered.map((month) => renderMonthGrid(plan, month.date, month.rows)).join("");
	const leftovers =
		undated.length > 0
			? `<ul class="dataview-calendar-list">${undated.map((row) => `<li>${renderCalendarEntry(plan, row)}</li>`).join("")}</ul>`
			: "";
	return `<div class="dataview dataview-calendar">${grids}${leftovers}</div>`;
}

function renderCalendarList(plan: QueryPlan, rows: QueryRow[]): string {
	const items = rows.map((row) => `<li>${renderCalendarEntry(plan, row)}</li>`).join("");
	return `<div class="dataview dataview-calendar"><ul class="dataview-calendar-list">${items}</ul></div>`;
}

function renderCalendarEntry(plan: QueryPlan, row: QueryRow): string {
	const label = plan.fields[0]
		? evaluateExpression(plan.fields[0].expression, row, undefined)
		: null;
	return `${renderValue(label)} — ${renderValue(pageLink(row.page))}`;
}

function renderMonthGrid(plan: QueryPlan, anchor: Date, rows: QueryRow[]): string {
	const year = anchor.getUTCFullYear();
	const month = anchor.getUTCMonth();
	const byDay = new Map<number, QueryRow[]>();
	for (const row of rows) {
		const date = calendarDate(row);
		if (!date || date.getUTCMonth() !== month || date.getUTCFullYear() !== year) continue;
		const day = date.getUTCDate();
		const bucket = byDay.get(day);
		if (bucket) bucket.push(row);
		else byDay.set(day, [row]);
	}

	// Weeks start on Sunday, so the grid opens with the days before the 1st.
	const leading = new Date(Date.UTC(year, month, 1)).getUTCDay();
	const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
	const cells: string[] = [];
	for (let offset = 0; offset < leading; offset += 1) {
		cells.push('<td class="dataview-calendar-day is-empty"></td>');
	}
	for (let day = 1; day <= daysInMonth; day += 1) {
		const entries = (byDay.get(day) ?? [])
			.map((row) => `<li>${renderCalendarEntry(plan, row)}</li>`)
			.join("");
		const classes = ["dataview-calendar-day"];
		if ((day + leading - 1) % 7 === 0) classes.push("is-weekend");
		if (day === new Date().getUTCDate() && month === new Date().getUTCMonth()) {
			classes.push("is-today");
		}
		cells.push(
			`<td class="${classes.join(" ")}"><span class="dataview-calendar-date">${day}</span>${entries ? `<ul>${entries}</ul>` : ""}</td>`,
		);
	}

	const monthName = new Intl.DateTimeFormat("en", { month: "long", timeZone: "UTC" }).format(
		new Date(Date.UTC(year, month, 1)),
	);
	const header = CALENDAR_WEEKDAYS.map((day) => `<th>${day}</th>`).join("");
	return `<table class="dataview-calendar-month"><caption>${escapeHtmlText(`${monthName} ${year}`)}</caption><thead><tr>${header}</tr></thead><tbody><tr>${cells.join("")}</tr></tbody></table>`;
}

/** ISO week number and its week-numbering year, as Dataview reports them. */
function isoWeekParts(date: Date): { week: number; year: number } {
	// Thursday of the current week decides the year a week belongs to.
	const target = new Date(date.getTime());
	const day = (target.getUTCDay() + 6) % 7;
	target.setUTCDate(target.getUTCDate() - day + 3);
	const year = target.getUTCFullYear();
	const firstThursday = new Date(Date.UTC(year, 0, 4));
	const firstDay = (firstThursday.getUTCDay() + 6) % 7;
	firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDay + 3);
	const week = 1 + Math.round((target.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
	return { week, year };
}

/** Dataview duration strings: `1 day`, `2 weeks`, `3 months`, `1y`. */
function normalizeDuration(value: unknown): Record<string, number> | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return { day: value };
	if (typeof value !== "string") return undefined;
	const duration: Record<string, number> = {};
	const pattern =
		/(\d+)\s*(year|years|y|month|months|mo|week|weeks|w|day|days|d|hour|hours|h|minute|minutes|min|m|second|seconds|s)\b/gi;
	for (const match of value.matchAll(pattern)) {
		const amount = Number(match[1]);
		const unit = (match[2] ?? "").toLowerCase();
		if (unit.startsWith("y")) duration.year = (duration.year ?? 0) + amount;
		else if (unit.startsWith("mo")) duration.month = (duration.month ?? 0) + amount;
		else if (unit.startsWith("w")) duration.week = (duration.week ?? 0) + amount;
		else if (unit.startsWith("d")) duration.day = (duration.day ?? 0) + amount;
		else if (unit.startsWith("h")) duration.hour = (duration.hour ?? 0) + amount;
		else if (unit.startsWith("mi") || unit === "m")
			duration.minute = (duration.minute ?? 0) + amount;
		else duration.second = (duration.second ?? 0) + amount;
	}
	return Object.keys(duration).length > 0 ? duration : undefined;
}

function addDuration(date: Date, duration: Record<string, number>, sign: number): Date {
	const result = new Date(date.getTime());
	if (duration.year) result.setUTCFullYear(result.getUTCFullYear() + sign * duration.year);
	if (duration.month) result.setUTCMonth(result.getUTCMonth() + sign * duration.month);
	if (duration.week) result.setUTCDate(result.getUTCDate() + sign * 7 * duration.week);
	if (duration.day) result.setUTCDate(result.getUTCDate() + sign * duration.day);
	if (duration.hour) result.setUTCHours(result.getUTCHours() + sign * duration.hour);
	if (duration.minute) result.setUTCMinutes(result.getUTCMinutes() + sign * duration.minute);
	if (duration.second) result.setUTCSeconds(result.getUTCSeconds() + sign * duration.second);
	return result;
}

const DATAVIEW_MONTHS = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/**
 * Format a date with Dataview's Luxon token set.
 *
 * The tokens that differ from Moment's are the ones Dataview users write most:
 * `yyyy`/`YYYY` for the year, `dd` for the day of the month, `LLLL d` for a
 * written date. Everything unknown is copied through, so an unsupported token
 * degrades to its own text instead of silently vanishing.
 */
function formatDataviewDate(date: Date, format: string): string {
	const pad = (value: number, length = 2) => String(value).padStart(length, "0");
	return format.replace(
		/LLLL|yyyy|YYYY|yy|MMMM|MMM|MM|LL|dd|DD|ddddd|d|HH|hh|mm|ss|SSS|a|EEEE|EEE/g,
		(token) => {
			switch (token) {
				case "LLLL":
					return `${DATAVIEW_MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
				case "yyyy":
				case "YYYY":
					return pad(date.getUTCFullYear(), 4);
				case "yy":
					return pad(date.getUTCFullYear(), 4).slice(-2);
				case "MMMM":
					return DATAVIEW_MONTHS[date.getUTCMonth()] ?? "";
				case "MMM":
					return (DATAVIEW_MONTHS[date.getUTCMonth()] ?? "").slice(0, 3);
				case "MM":
					return pad(date.getUTCMonth() + 1);
				case "LL":
					return pad(date.getUTCMonth() + 1);
				case "dd":
				case "DD":
					return pad(date.getUTCDate());
				// Luxon's `d` is the day without padding, and `hh` its 12-hour form.
				case "d":
					return String(date.getUTCDate());
				case "ddddd":
					return String(date.getUTCDate());
				case "HH":
					return pad(date.getUTCHours());
				case "hh":
					return pad(date.getUTCHours() % 12 || 12);
				case "mm":
					return pad(date.getUTCMinutes());
				case "ss":
					return pad(date.getUTCSeconds());
				case "SSS":
					return pad(date.getUTCMilliseconds(), 3);
				case "a":
					return date.getUTCHours() < 12 ? "AM" : "PM";
				case "EEEE":
					return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][
						date.getUTCDay()
					] as string;
				case "EEE":
					return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getUTCDay()] as string;
				default:
					return token;
			}
		},
	);
}
