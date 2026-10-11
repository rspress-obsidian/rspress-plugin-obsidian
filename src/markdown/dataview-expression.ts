/**
 * Dataview Query Language expressions and sources: a parser over the whole
 * query text (newlines are whitespace, as in Dataview's parsimmon grammar) and
 * an evaluator with Dataview's operators, indexing rules and function library
 * (`expression/parse.ts`, `context.ts`, `binaryop.ts`, `functions.ts` of
 * blacksmithgu/obsidian-dataview).
 */
import { unescapeString } from "./dataview-metadata.js";
import {
	addDuration,
	compareValues,
	DATE_SHORTHAND_NAMES,
	DataviewDuration,
	DataviewExternalLink,
	DataviewFunction,
	DataviewLink,
	type DataviewType,
	dateShorthand,
	diffDates,
	escapeRegExp,
	fileTitle,
	formatDuration,
	formatLuxonDate,
	isoWeek,
	isTruthy,
	luxonWeekday,
	matchDurationPrefix,
	parseDateLiteral,
	parseDuration,
	parseWithLuxonFormat,
	startOfDay,
	typeOf,
	valueToString,
} from "./dataview-values.js";
import {
	checkSize,
	concatLists,
	concatTexts,
	flatList,
	joinTexts,
	padText,
	repeatText,
	replaceText,
	WorkBudget,
} from "./interpreter-limits.js";
import { assertSafeRegex } from "./safe-regex.js";

export type BinaryOp =
	| "+"
	| "-"
	| "*"
	| "/"
	| "%"
	| "="
	| "!="
	| "<"
	| "<="
	| ">"
	| ">="
	| "&"
	| "|";

/** A parsed expression (Dataview's `Field`). */
export type Field =
	| { type: "literal"; value: unknown }
	| { type: "dateShorthand"; name: string }
	| { type: "variable"; name: string }
	| { type: "index"; object: Field; index: Field }
	| { type: "function"; func: Field; args: Field[] }
	| { type: "binary"; op: BinaryOp; left: Field; right: Field }
	| { type: "negated"; child: Field }
	| { type: "negative"; child: Field }
	| { type: "list"; values: Field[] }
	| { type: "object"; values: Array<[string, Field]> }
	| { type: "lambda"; args: string[]; body: Field };

/** A `FROM` source (Dataview's `Source`). */
export type Source =
	| { type: "all" }
	| { type: "tag"; tag: string }
	| { type: "folder"; folder: string }
	| { type: "link"; inner: string; direction: "incoming" | "outgoing" }
	| { type: "negate"; child: Source }
	| { type: "binary"; op: "&" | "|"; left: Source; right: Source };

/** Words a bare variable may not be, so `LIST FROM …` never reads `FROM` as a field. */
const KEYWORDS: Record<string, true> = {
	FROM: true,
	WHERE: true,
	LIMIT: true,
	GROUP: true,
	FLATTEN: true,
	SORT: true,
};

const IDENTIFIER =
	/[\p{L}_\p{Extended_Pictographic}](?:[\p{L}\p{N}_\-\p{Extended_Pictographic}]|\u200d|\ufe0f)*/uy;
const NUMBER = /-?\d+(?:\.\d+)?/y;
const BOOLEAN = /(?:true|false|True|False)(?![\p{L}\p{N}_-])/uy;
const NULL = /null(?![\p{L}\p{N}_-])/uy;
const LINK = /(!?)\[\[([^[\]]*?)\]\]/y;
const BOOLEAN_OP = /(?:and|or)(?![\p{L}\p{N}_-])|&|\|/iuy;
const COMPARE_OP = />=|<=|!=|>|<|=(?!>)/y;
const PLUS_MINUS_OP = /[+-]/y;
const MUL_DIV_OP = /[*/%]/y;
const DATE_LITERAL_PREFIX =
	/\d{4}-\d{2}(?:-\d{2}(?:T\d{2}(?::\d{2}(?::\d{2}(?:\.\d{3})?)?)?)?)?(?:Z|[+-]\d{1,2}(?::\d{2})?|\[[0-9A-Za-z+\-/_]+\])?/y;
const TAG = /#[^\u2000-\u206F\u2E00-\u2E7F'!"#$%&()*+,.:;<=>?@^`{|}~[\]\\\s]+/uy;
const SHORTHAND = new RegExp(
	`(?:${DATE_SHORTHAND_NAMES.map(escapeRegExp).join("|")})(?![\\p{L}\\p{N}_-])`,
	"uy",
);

/** A position over query text, with Dataview's whitespace and `//` comment rules. */
export class DqlCursor {
	pos = 0;

	constructor(
		readonly source: string,
		/** `//` line comments count as whitespace (between query clauses). */
		readonly comments = false,
	) {}

	get done(): boolean {
		return this.pos >= this.source.length;
	}

	startsWith(text: string): boolean {
		return this.source.startsWith(text, this.pos);
	}

	skipSpace(): void {
		for (;;) {
			const start = this.pos;
			while (this.pos < this.source.length && /\s/.test(this.source[this.pos] ?? "")) this.pos += 1;
			if (this.comments && this.startsWith("//")) {
				const end = this.source.indexOf("\n", this.pos);
				this.pos = end < 0 ? this.source.length : end + 1;
			}
			if (this.pos === start) return;
		}
	}

	match(pattern: RegExp): RegExpExecArray | null {
		pattern.lastIndex = this.pos;
		const match = pattern.exec(this.source);
		if (match) this.pos += match[0].length;
		return match;
	}

	text(literal: string): boolean {
		if (!this.startsWith(literal)) return false;
		this.pos += literal.length;
		return true;
	}

	/** A case-insensitive keyword that is not the start of a longer word. */
	word(keyword: string): boolean {
		const candidate = this.source.slice(this.pos, this.pos + keyword.length);
		if (candidate.toUpperCase() !== keyword.toUpperCase()) return false;
		if (/[\p{L}\p{N}_-]/u.test(this.source[this.pos + keyword.length] ?? "")) return false;
		this.pos += keyword.length;
		return true;
	}

	location(at = this.pos): string {
		const before = this.source.slice(0, at);
		const line = before.split("\n").length;
		const column = at - (before.lastIndexOf("\n") + 1) + 1;
		return `line ${line}, column ${column}`;
	}

	/** The rest of the current line, for error messages. */
	lineRest(at = this.pos): string {
		const end = this.source.indexOf("\n", at);
		return this.source.slice(at, end < 0 ? undefined : end).trim();
	}

	fail(message: string): never {
		throw new Error(`${message} (${this.location()}).`);
	}
}

function expectText(cursor: DqlCursor, literal: string, what: string): void {
	cursor.skipSpace();
	if (!cursor.text(literal)) {
		cursor.fail(`Expected ${what} but found "${cursor.lineRest().slice(0, 40) || "end of query"}"`);
	}
}

/** Whether an expression can start here: not the end, a closing token, or a clause keyword. */
export function startsExpression(cursor: DqlCursor): boolean {
	if (cursor.done) return false;
	const identifier = cursor.match(IDENTIFIER);
	if (identifier) {
		cursor.pos -= identifier[0].length;
		return !isKeyword(identifier[0], cursor.source[cursor.pos + identifier[0].length]);
	}
	return !/[),\]}]/.test(cursor.source[cursor.pos] ?? "");
}

/** A clause keyword in variable position — except `sort(…)`, which is a function. */
function isKeyword(word: string, next: string | undefined): boolean {
	const upper = word.toUpperCase();
	return Object.hasOwn(KEYWORDS, upper) && !(upper === "SORT" && next === "(");
}

/** Parse one expression at the cursor (Dataview's `field`). */
export function parseField(cursor: DqlCursor): Field {
	return parseBinary(cursor, 0);
}

const OPERATOR_LEVELS: RegExp[] = [BOOLEAN_OP, COMPARE_OP, PLUS_MINUS_OP, MUL_DIV_OP];

function parseBinary(cursor: DqlCursor, level: number): Field {
	const operator = OPERATOR_LEVELS[level];
	if (!operator) return parseIndexField(cursor);
	let left = parseBinary(cursor, level + 1);
	for (;;) {
		const before = cursor.pos;
		cursor.skipSpace();
		const match = cursor.match(operator);
		if (!match) {
			cursor.pos = before;
			return left;
		}
		const text = match[0].toLowerCase();
		const op = (text === "and" ? "&" : text === "or" ? "|" : text) as BinaryOp;
		cursor.skipSpace();
		left = { type: "binary", op, left, right: parseBinary(cursor, level + 1) };
	}
}

function parseIndexField(cursor: DqlCursor): Field {
	let result = parseAtom(cursor);
	for (;;) {
		if (cursor.startsWith(".")) {
			cursor.pos += 1;
			const name = cursor.match(IDENTIFIER);
			if (!name) cursor.fail("Expected a field name after '.'");
			result = { type: "index", object: result, index: { type: "literal", value: name[0] } };
		} else if (cursor.startsWith("[") && !cursor.startsWith("[[")) {
			cursor.pos += 1;
			cursor.skipSpace();
			const index = parseField(cursor);
			expectText(cursor, "]", "']'");
			result = { type: "index", object: result, index };
		} else if (cursor.startsWith("(")) {
			cursor.pos += 1;
			result = { type: "function", func: result, args: parseArguments(cursor, ")") };
		} else {
			return result;
		}
	}
}

/** `a, b, c` up to `close` (consumed). */
function parseArguments(cursor: DqlCursor, close: string): Field[] {
	const args: Field[] = [];
	cursor.skipSpace();
	if (cursor.text(close)) return args;
	for (;;) {
		cursor.skipSpace();
		args.push(parseField(cursor));
		cursor.skipSpace();
		if (cursor.text(",")) continue;
		expectText(cursor, close, `',' or '${close}'`);
		return args;
	}
}

function parseString(cursor: DqlCursor): string | undefined {
	const quote = cursor.source[cursor.pos];
	if (quote !== '"' && quote !== "'") return undefined;
	let index = cursor.pos + 1;
	while (index < cursor.source.length) {
		const char = cursor.source[index];
		if (char === "\\") index += 2;
		else if (char === quote) break;
		else index += 1;
	}
	if (index >= cursor.source.length) cursor.fail("Unterminated string");
	const raw = cursor.source.slice(cursor.pos + 1, index);
	cursor.pos = index + 1;
	return unescapeString(raw);
}

/** `(a, b) => body`, or `undefined` (cursor unmoved) when this is not a lambda. */
function tryParseLambda(cursor: DqlCursor): Field | undefined {
	const start = cursor.pos;
	cursor.pos += 1;
	const args: string[] = [];
	cursor.skipSpace();
	if (!cursor.startsWith(")")) {
		for (;;) {
			cursor.skipSpace();
			const name = cursor.match(IDENTIFIER);
			if (!name) {
				cursor.pos = start;
				return undefined;
			}
			args.push(name[0]);
			cursor.skipSpace();
			if (!cursor.text(",")) break;
		}
	}
	cursor.skipSpace();
	if (!cursor.text(")")) {
		cursor.pos = start;
		return undefined;
	}
	cursor.skipSpace();
	if (!cursor.text("=>")) {
		cursor.pos = start;
		return undefined;
	}
	cursor.skipSpace();
	return { type: "lambda", args, body: parseField(cursor) };
}

/** `date(today)` / `date(2026-01-05)` and `dur(1 day)`: literal forms, not calls. */
function tryParseSpecialLiteral(cursor: DqlCursor): Field | undefined {
	const start = cursor.pos;
	if (cursor.text("date(")) {
		cursor.skipSpace();
		const shorthand = cursor.match(SHORTHAND);
		let field: Field | undefined;
		if (shorthand) {
			field = { type: "dateShorthand", name: shorthand[0] };
		} else {
			const text = cursor.match(DATE_LITERAL_PREFIX);
			const date = text ? parseDateLiteral(text[0]) : null;
			if (date) field = { type: "literal", value: date };
		}
		cursor.skipSpace();
		if (field && cursor.text(")")) return field;
		cursor.pos = start;
		return undefined;
	}
	if (cursor.text("dur(")) {
		cursor.skipSpace();
		const duration = matchDurationPrefix(cursor.source, cursor.pos);
		if (duration) {
			cursor.pos = duration.end;
			cursor.skipSpace();
			if (cursor.text(")")) return { type: "literal", value: duration.duration.normalize() };
		}
		cursor.pos = start;
	}
	return undefined;
}

function parseAtom(cursor: DqlCursor): Field {
	const char = cursor.source[cursor.pos];
	// `[[x]]` is a link; `[[1], [2]]` is a list of lists, as in Dataview.
	const link = cursor.match(LINK);
	if (link) {
		return { type: "literal", value: DataviewLink.parseInner(link[2] ?? "", link[1] === "!") };
	}
	if (char === "!") {
		cursor.pos += 1;
		return { type: "negated", child: parseIndexField(cursor) };
	}
	if (char === "[") {
		cursor.pos += 1;
		return { type: "list", values: parseArguments(cursor, "]") };
	}
	if (char === "{") {
		cursor.pos += 1;
		const values: Array<[string, Field]> = [];
		cursor.skipSpace();
		if (cursor.text("}")) return { type: "object", values };
		for (;;) {
			cursor.skipSpace();
			const key = parseString(cursor) ?? cursor.match(IDENTIFIER)?.[0];
			if (key === undefined) cursor.fail("Expected an object key");
			expectText(cursor, ":", "':'");
			cursor.skipSpace();
			values.push([key, parseField(cursor)]);
			cursor.skipSpace();
			if (cursor.text(",")) continue;
			expectText(cursor, "}", "',' or '}'");
			return { type: "object", values };
		}
	}
	if (char === "(") {
		const lambda = tryParseLambda(cursor);
		if (lambda) return lambda;
		cursor.pos += 1;
		cursor.skipSpace();
		const inner = parseField(cursor);
		expectText(cursor, ")", "')'");
		return inner;
	}
	const bool = cursor.match(BOOLEAN);
	if (bool) {
		return { type: "literal", value: bool[0].toLowerCase() === "true" };
	}
	const number = cursor.match(NUMBER);
	if (number) return { type: "literal", value: Number.parseFloat(number[0]) };
	if (char === "-") {
		cursor.pos += 1;
		return { type: "negative", child: parseIndexField(cursor) };
	}
	const text = parseString(cursor);
	if (text !== undefined) return { type: "literal", value: text };
	const special = tryParseSpecialLiteral(cursor);
	if (special) return special;
	if (cursor.match(NULL)) return { type: "literal", value: null };
	const identifier = cursor.match(IDENTIFIER);
	if (identifier) {
		if (isKeyword(identifier[0], cursor.source[cursor.pos])) {
			cursor.pos -= identifier[0].length;
			cursor.fail(`Expected an expression but found the keyword ${identifier[0].toUpperCase()}`);
		}
		return { type: "variable", name: identifier[0] };
	}
	if (cursor.done) cursor.fail("Expected an expression but the query ended");
	return cursor.fail(`Unexpected "${cursor.lineRest().slice(0, 40)}"`);
}

const expressionCache = new Map<string, Field>();

/**
 * Parse a standalone expression (an inline query, a `LIMIT` operand). The
 * whole text must be one expression; anything left over is an error, never a
 * silently shorter expression.
 */
export function parseExpression(source: string): Field {
	const cached = expressionCache.get(source);
	if (cached) return cached;
	const cursor = new DqlCursor(source);
	cursor.skipSpace();
	const field = parseField(cursor);
	cursor.skipSpace();
	if (!cursor.done) {
		cursor.fail(
			`Unexpected "${cursor.lineRest().slice(0, 40)}" after the expression "${source.slice(0, cursor.pos).trim()}"`,
		);
	}
	expressionCache.set(source, field);
	return field;
}

/** `FROM` sources: tags, folders, links, `outgoing(…)`, negation, `and`/`or`, parentheses. */
export function parseSource(cursor: DqlCursor): Source {
	const start = cursor.pos;
	const fail = (): never => {
		throw new Error(
			`Unsupported Dataview source: ${cursor.source.slice(start).split("\n")[0]?.trim() ?? ""}`,
		);
	};
	const atom = (): Source => {
		cursor.skipSpace();
		if (cursor.text("(")) {
			const inner = binary();
			cursor.skipSpace();
			if (!cursor.text(")")) fail();
			return inner;
		}
		if (cursor.text("-") || cursor.text("!")) return { type: "negate", child: atom() };
		for (const [name, direction] of [
			["outgoing", "outgoing"],
			["outlinks", "outgoing"],
			["inlinks", "incoming"],
		] as const) {
			const before = cursor.pos;
			if (cursor.word(name)) {
				cursor.skipSpace();
				if (cursor.text("(")) {
					cursor.skipSpace();
					const link = cursor.match(LINK);
					cursor.skipSpace();
					if (!link || !cursor.text(")")) fail();
					return linkSource(link?.[2] ?? "", direction);
				}
				cursor.pos = before;
			}
		}
		if (cursor.startsWith("csv(")) {
			throw new Error(
				"Unsupported Dataview source: csv() reads a file at query time, which a static build does not do.",
			);
		}
		const link = cursor.match(LINK);
		if (link) return linkSource(link[2] ?? "", "incoming");
		const folder = parseString(cursor);
		if (folder !== undefined) return { type: "folder", folder };
		const tag = cursor.match(TAG);
		if (tag) return { type: "tag", tag: tag[0] };
		return fail();
	};
	const linkSource = (inner: string, direction: "incoming" | "outgoing"): Source => {
		// `[[]]` and `[[#]]` name the current page; a link of only spaces names nothing.
		if (inner.length > 0 && inner.trim() === "") fail();
		return { type: "link", inner, direction };
	};
	const binary = (): Source => {
		let left = atom();
		for (;;) {
			const before = cursor.pos;
			cursor.skipSpace();
			const op = cursor.match(BOOLEAN_OP);
			if (!op) {
				cursor.pos = before;
				return left;
			}
			const text = op[0].toLowerCase();
			left = {
				type: "binary",
				op: text === "and" || text === "&" ? "&" : "|",
				left,
				right: atom(),
			};
		}
	};
	return binary();
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** What an expression is evaluated against, besides the row it reads. */
export interface EvalContext {
	/** Variables visible to every row: `this`, the current page. */
	globals: Record<string, unknown>;
	/** The build's clock for `date(today)`, `date(now)` and friends. */
	now: Date;
	/** The page values a link points at (indexing into a link), or `null`. */
	resolveLink(link: DataviewLink): Record<string, unknown> | null;
	/** The canonical target of a link, so `[[Alice]]` equals Alice's `file.link`. */
	normalizeLink(link: DataviewLink): string;
	/** The canonical path for a link written as text (`link("Alice")`). */
	normalizePath(path: string): string;
}

export function evaluate(
	field: Field,
	ctx: EvalContext,
	data: Record<string, unknown> = {},
): unknown {
	switch (field.type) {
		case "literal":
			return field.value;
		case "dateShorthand":
			return dateShorthand(field.name, ctx.now);
		case "variable":
			if (Object.hasOwn(data, field.name)) return data[field.name] ?? null;
			if (Object.hasOwn(ctx.globals, field.name)) return ctx.globals[field.name] ?? null;
			return null;
		case "negated":
			return !isTruthy(evaluate(field.child, ctx, data));
		case "negative": {
			const value = evaluate(field.child, ctx, data);
			if (value === null || value === undefined) return null;
			if (typeof value === "number") return -value;
			if (value instanceof DataviewDuration) return value.map((part) => -part);
			throw new Error(`Cannot negate a ${typeOf(value)}.`);
		}
		case "binary": {
			// `and`/`or` short-circuit so `x and x.y > 1` never indexes a null.
			const left = evaluate(field.left, ctx, data);
			if (field.op === "&" && !isTruthy(left)) return false;
			if (field.op === "|" && isTruthy(left)) return true;
			return binaryOp(field.op, left, evaluate(field.right, ctx, data), ctx);
		}
		case "list":
			return field.values.map((value) => evaluate(value, ctx, data));
		case "object":
			return Object.fromEntries(
				field.values.map(([key, value]) => [key, evaluate(value, ctx, data)]),
			);
		case "lambda": {
			const budget = budgetOf(ctx);
			return new DataviewFunction((args) => {
				// Own data properties, so a parameter named `__proto__` is a name, not a prototype.
				const scope: Record<string, unknown> = {
					...data,
					...Object.fromEntries(field.args.map((name, position) => [name, args[position] ?? null])),
				};
				const result = evaluate(field.body, ctx, scope);
				budget.spend();
				budget.charge(result, undefined);
				return result;
			});
		}
		case "function": {
			const callee =
				field.func.type === "variable" ? field.func.name : evaluate(field.func, ctx, data);
			const args = field.args.map((arg) => evaluate(arg, ctx, data));
			if (callee instanceof DataviewFunction) return normalizeResult(callee.invoke(args));
			if (typeof callee === "string") return callDataviewFunction(callee, ctx, args);
			throw new Error(`Cannot call a ${typeOf(callee)} as a function.`);
		}
		case "index": {
			const index = evaluate(field.index, ctx, data);
			if (index === null || index === undefined) return null;
			if (typeof index !== "string" && typeof index !== "number") {
				throw new Error("Can only index with a string or number.");
			}
			const object =
				field.object.type === "variable" && field.object.name === "row"
					? { ...ctx.globals, ...data }
					: evaluate(field.object, ctx, data);
			return indexValue(object, index, ctx);
		}
	}
}

function normalizeResult(value: unknown): unknown {
	return value === undefined ? null : value;
}

/** Property names a date answers to (`date.year`, `file.mtime.hour`). */
function dateProperty(date: Date, name: string): unknown {
	switch (name) {
		case "year":
			return date.getFullYear();
		case "month":
			return date.getMonth() + 1;
		case "weekyear":
			return isoWeek(date).week;
		case "week":
			return Math.floor(date.getDate() / 7) + 1;
		case "weekday":
			return luxonWeekday(date);
		case "day":
			return date.getDate();
		case "hour":
			return date.getHours();
		case "minute":
			return date.getMinutes();
		case "second":
			return date.getSeconds();
		case "millisecond":
			return date.getMilliseconds();
		default:
			return null;
	}
}

const DURATION_PROPERTIES: Record<
	string,
	"years" | "months" | "weeks" | "days" | "hours" | "minutes" | "seconds" | "milliseconds"
> = {
	year: "years",
	years: "years",
	month: "months",
	months: "months",
	weeks: "weeks",
	day: "days",
	days: "days",
	hour: "hours",
	hours: "hours",
	minute: "minutes",
	minutes: "minutes",
	second: "seconds",
	seconds: "seconds",
	millisecond: "milliseconds",
	milliseconds: "milliseconds",
};

/** `object[index]` with Dataview's rules for each type. */
export function indexValue(object: unknown, index: string | number, ctx: EvalContext): unknown {
	switch (typeOf(object)) {
		case "object": {
			if (typeof index !== "string") {
				throw new Error('Can only index into objects with strings (a.b or a["b"]).');
			}
			const record = object as Record<string, unknown>;
			return Object.hasOwn(record, index) ? (record[index] ?? null) : null;
		}
		case "link": {
			if (typeof index !== "string") {
				throw new Error('Can only index into links with strings (a.b or a["b"]).');
			}
			const page = ctx.resolveLink(object as DataviewLink);
			return page && Object.hasOwn(page, index) ? (page[index] ?? null) : null;
		}
		case "array": {
			const list = object as unknown[];
			if (typeof index === "number")
				return index >= 0 && index < list.length ? (list[index] ?? null) : null;
			// `rows.file.link`: a string index maps over the elements ("swizzling").
			const result: unknown[] = [];
			for (const item of list) {
				try {
					result.push(indexValue(item, index, ctx));
				} catch {
					// Dataview drops elements that cannot be indexed.
				}
			}
			return result;
		}
		case "string": {
			if (typeof index !== "number") throw new Error("String indexing requires a numeric index.");
			const text = object as string;
			return index >= 0 && index < text.length ? (text[index] ?? null) : null;
		}
		case "date":
			if (typeof index !== "string") throw new Error("Date indexing requires a unit name.");
			return dateProperty(object as Date, index);
		case "duration": {
			if (typeof index !== "string") throw new Error("Duration indexing requires a unit name.");
			const unit = Object.hasOwn(DURATION_PROPERTIES, index)
				? DURATION_PROPERTIES[index]
				: undefined;
			return unit ? (object as DataviewDuration).as(unit) : null;
		}
		default:
			return null;
	}
}

const ARITHMETIC: Record<string, true> = { "+": true, "-": true, "*": true, "/": true, "%": true };

/** Dataview's binary operator table. */
export function binaryOp(op: BinaryOp, left: unknown, right: unknown, ctx: EvalContext): unknown {
	const leftType = typeOf(left);
	const rightType = typeOf(right);
	switch (op) {
		case "&":
			return isTruthy(left) && isTruthy(right);
		case "|":
			return isTruthy(left) || isTruthy(right);
		case "=":
		case "!=":
		case "<":
		case "<=":
		case ">":
		case ">=": {
			const comparison = compareValues(left, right, ctx.normalizeLink);
			if (op === "=") return comparison === 0;
			if (op === "!=") return comparison !== 0;
			if (op === "<") return comparison < 0;
			if (op === "<=") return comparison <= 0;
			if (op === ">") return comparison > 0;
			return comparison >= 0;
		}
	}
	if (op === "+" && (leftType === "string" || rightType === "string")) {
		return concatTexts(valueToString(left), valueToString(right));
	}
	// A missing field in arithmetic gives no value rather than a number.
	if (ARITHMETIC[op] && (leftType === "null" || rightType === "null")) return null;
	if (leftType === "number" && rightType === "number") {
		const a = left as number;
		const b = right as number;
		if (op === "+") return a + b;
		if (op === "-") return a - b;
		if (op === "*") return a * b;
		if (op === "/") return a / b;
		return a % b;
	}
	if (op === "*" && leftType === "string" && rightType === "number") {
		return (right as number) < 0 ? "" : repeatText(left as string, right as number);
	}
	if (op === "*" && leftType === "number" && rightType === "string") {
		return (left as number) < 0 ? "" : repeatText(right as string, left as number);
	}
	if (leftType === "date" && rightType === "duration" && (op === "+" || op === "-")) {
		return addDuration(left as Date, right as DataviewDuration, op === "+" ? 1 : -1);
	}
	if (leftType === "duration" && rightType === "date" && op === "+") {
		return addDuration(right as Date, left as DataviewDuration, 1);
	}
	if (leftType === "date" && rightType === "date" && op === "-") {
		return diffDates(left as Date, right as Date);
	}
	if (leftType === "duration" && rightType === "duration" && (op === "+" || op === "-")) {
		return (left as DataviewDuration)
			.plus(right as DataviewDuration, op === "+" ? 1 : -1)
			.normalize();
	}
	if (leftType === "duration" && rightType === "number" && (op === "*" || op === "/")) {
		const factor = right as number;
		return (left as DataviewDuration)
			.map((part) => (op === "*" ? part * factor : part / factor))
			.normalize();
	}
	if (leftType === "number" && rightType === "duration" && op === "*") {
		const factor = left as number;
		return (right as DataviewDuration).map((part) => part * factor).normalize();
	}
	if (leftType === "array" && rightType === "array" && op === "+") {
		return concatLists([left as unknown[], right as unknown[]]);
	}
	if (leftType === "object" && rightType === "object" && op === "+") {
		return { ...(left as object), ...(right as object) };
	}
	throw new Error(`No implementation found for '${leftType} ${op} ${rightType}'.`);
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

type FunctionImpl = (ctx: EvalContext, args: unknown[]) => unknown;
type TypeSpec = DataviewType | "*";

/** Dataview's `FunctionBuilder`: typed variants, first match wins, optional vectorization. */
class FunctionBuilder {
	private readonly variants: Array<{ args: TypeSpec[] | "varargs"; impl: FunctionImpl }> = [];
	private readonly vectorized: Record<number, number[]> = {};

	constructor(private readonly name: string) {}

	add(args: TypeSpec[], impl: (args: unknown[], ctx: EvalContext) => unknown): this {
		this.variants.push({ args, impl: (ctx, values) => impl(values, ctx) });
		return this;
	}

	vararg(impl: (args: unknown[], ctx: EvalContext) => unknown): this {
		this.variants.push({ args: "varargs", impl: (ctx, values) => impl(values, ctx) });
		return this;
	}

	vectorize(count: number, positions: number[]): this {
		this.vectorized[count] = positions;
		return this;
	}

	build(): FunctionImpl {
		const self: FunctionImpl = (ctx, args) => {
			const types = args.map(typeOf);
			const positions = (this.vectorized[args.length] ?? []).filter(
				(position) => types[position] === "array",
			);
			if (positions.length > 0) {
				const length = Math.min(
					...positions.map((position) => (args[position] as unknown[]).length),
				);
				const result: unknown[] = [];
				for (let item = 0; item < length; item += 1) {
					result.push(
						self(
							ctx,
							args.map((arg, position) =>
								positions.includes(position) ? (arg as unknown[])[item] : arg,
							),
						),
					);
				}
				return result;
			}
			for (const variant of this.variants) {
				if (variant.args === "varargs") return variant.impl(ctx, args);
				if (variant.args.length !== types.length) continue;
				if (variant.args.every((type, position) => type === "*" || type === types[position])) {
					return variant.impl(ctx, args);
				}
			}
			throw new Error(
				`No implementation of '${this.name}' found for arguments: ${types.join(", ") || "none"}.`,
			);
		};
		return self;
	}
}

/** Vault-authored regexes run during the build: the subject is bounded too, as a backstop to the pattern check. */
const MAX_REGEX_SUBJECT_LENGTH = 10_000;

function compileRegex(pattern: string, flags: string, subject: string): RegExp {
	assertSafeRegex(pattern);
	if (subject.length > MAX_REGEX_SUBJECT_LENGTH) {
		throw new Error(
			`Dataview regex subject is too long (${subject.length} characters, limit ${MAX_REGEX_SUBJECT_LENGTH}).`,
		);
	}
	try {
		return new RegExp(pattern, flags);
	} catch (error) {
		throw new Error(`Invalid Dataview pattern "${pattern}": ${(error as Error).message}`);
	}
}

/** Lambda calls, and what they and the functions build, allowed per query. */
const MAX_QUERY_WORK = 50_000_000;
const budgets = new WeakMap<EvalContext, WorkBudget>();

/** The query's work budget: `map(xs, (x) => map(xs, …))` over long lists must still end. */
function budgetOf(ctx: EvalContext): WorkBudget {
	let budget = budgets.get(ctx);
	if (!budget) {
		budget = new WorkBudget(MAX_QUERY_WORK, "The Dataview query");
		budgets.set(ctx, budget);
	}
	return budget;
}

function call(fn: unknown, args: unknown[]): unknown {
	if (!(fn instanceof DataviewFunction)) throw new Error("Expected a function such as (x) => x.");
	return normalizeResult(fn.invoke(args));
}

function equals(left: unknown, right: unknown, ctx: EvalContext): boolean {
	return compareValues(left, right, ctx.normalizeLink) === 0;
}

function cyrb53(text: string, seed = 0): number {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let index = 0; index < text.length; index += 1) {
		const char = text.charCodeAt(index);
		h1 = Math.imul(h1 ^ char, 2654435761);
		h2 = Math.imul(h2 ^ char, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** `display()` / markdown-free text: `[[a|b]]` → b, `[[a]]` → a, emphasis markers dropped. */
function stripMarkdown(text: string): string {
	return text
		.replace(/!?\[\[([^\]|]*?)\|([^\]]*?)\]\]/g, "$2")
		.replace(/!?\[\[([^\]]*?)\]\]/g, "$1")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_~`]+/g, "")
		.replace(/==/g, "");
}

const NUMBER_IN_TEXT = /-?[0-9]+(\.[0-9]+)?/;

const contains: FunctionImpl = new FunctionBuilder("contains")
	.add(["array", "*"], ([list, item], ctx) =>
		(list as unknown[]).some((element) => contains(ctx, [element, item])),
	)
	.add(["string", "string"], ([text, part]) => (text as string).includes(part as string))
	.add(["object", "string"], ([object, key]) => Object.hasOwn(object as object, key as string))
	.add(["*", "*"], ([left, right], ctx) => equals(left, right, ctx))
	.vectorize(2, [1])
	.build();

const icontains: FunctionImpl = new FunctionBuilder("icontains")
	.add(["array", "*"], ([list, item], ctx) =>
		(list as unknown[]).some((element) => icontains(ctx, [element, item])),
	)
	.add(["string", "string"], ([text, part]) =>
		(text as string).toLocaleLowerCase().includes((part as string).toLocaleLowerCase()),
	)
	.add(["object", "string"], ([object, key]) => Object.hasOwn(object as object, key as string))
	.add(["*", "*"], ([left, right], ctx) => equals(left, right, ctx))
	.vectorize(2, [1])
	.build();

const min: FunctionImpl = new FunctionBuilder("min")
	.add(["*", "null"], ([value]) => value)
	.add(["null", "*"], ([, value]) => value)
	.add(["array"], ([list], ctx) => min(ctx, list as unknown[]))
	.add(["*", "*"], ([left, right], ctx) =>
		compareValues(left, right, ctx.normalizeLink) <= 0 ? left : right,
	)
	.vararg((args, ctx) =>
		args.length === 0 ? null : args.reduce((best, value) => min(ctx, [best, value])),
	)
	.build();

const max: FunctionImpl = new FunctionBuilder("max")
	.add(["*", "null"], ([value]) => value)
	.add(["null", "*"], ([, value]) => value)
	.add(["array"], ([list], ctx) => max(ctx, list as unknown[]))
	.add(["*", "*"], ([left, right], ctx) =>
		compareValues(left, right, ctx.normalizeLink) > 0 ? left : right,
	)
	.vararg((args, ctx) =>
		args.length === 0 ? null : args.reduce((best, value) => max(ctx, [best, value])),
	)
	.build();

function extremeBy(list: unknown[], fn: unknown, ctx: EvalContext, sign: 1 | -1): unknown {
	if (list.length === 0) return null;
	const mapped = list
		.map((value) => ({ value, key: call(fn, [value]) }))
		.filter((entry) => entry.key !== null);
	if (mapped.length === 0) return list[0];
	return mapped.reduce((best, entry) =>
		sign * compareValues(best.key, entry.key, ctx.normalizeLink) <= 0 ? best : entry,
	).value;
}

const reduce: FunctionImpl = new FunctionBuilder("reduce")
	.add(["array", "string"], ([list, op], ctx) => {
		const values = list as unknown[];
		if (values.length === 0) return null;
		if (!["+", "-", "*", "/", "&", "|"].includes(op as string)) {
			throw new Error("reduce(array, op) supports '+', '-', '/', '*', '&', and '|'.");
		}
		return values
			.slice(1)
			.reduce((total, value) => binaryOp(op as BinaryOp, total, value, ctx), values[0]);
	})
	.add(["array", "function"], ([list, fn]) => {
		const values = list as unknown[];
		if (values.length === 0) return null;
		let total = values[0];
		for (const value of values.slice(1)) {
			if (value === null || value === undefined) continue;
			total = call(fn, [total, value]);
		}
		return total;
	})
	.add(["null", "*"], () => null)
	.add(["*", "null"], () => null)
	.vectorize(2, [1])
	.build();

const sum: FunctionImpl = new FunctionBuilder("sum")
	.add(["array"], ([list], ctx) => reduce(ctx, [list, "+"]))
	.add(["*"], ([value]) => value)
	.build();

const truncate: FunctionImpl = new FunctionBuilder("truncate")
	.add(["string", "number", "string"], ([text, length, suffix]) => {
		const value = text as string;
		const end = (length as number) - (suffix as string).length;
		return value.length > end ? value.slice(0, Math.max(0, end)) + (suffix as string) : value;
	})
	.add(["string", "number"], ([text, length], ctx) => truncate(ctx, [text, length, "..."]))
	.add(["null", "*"], () => null)
	.add(["*", "null"], () => null)
	.add(["null", "*", "*"], () => null)
	.add(["*", "null", "*"], () => null)
	.add(["*", "*", "null"], () => null)
	.vectorize(2, [0, 1])
	.vectorize(3, [0, 1, 2])
	.build();

const join: FunctionImpl = new FunctionBuilder("join")
	.add(["array", "string"], ([list, separator]) =>
		joinTexts(list as unknown[], separator as string, valueToString),
	)
	.add(["array", "null"], ([list], ctx) => join(ctx, [list, ", "]))
	.add(["*", "string"], ([value]) => valueToString(value))
	.add(["array"], ([list], ctx) => join(ctx, [list, ", "]))
	.add(["*"], ([value]) => valueToString(value))
	.vectorize(2, [1])
	.build();

function nullary(
	name: string,
	impl: (value: unknown, ctx: EvalContext) => unknown,
	type: TypeSpec,
) {
	return new FunctionBuilder(name)
		.add([type], ([value], ctx) => impl(value, ctx))
		.add(["null"], () => null)
		.vectorize(1, [0])
		.build();
}

function stringPair(name: string, impl: (left: string, right: string) => unknown) {
	return new FunctionBuilder(name)
		.add(["string", "string"], ([left, right]) => impl(left as string, right as string))
		.add(["null", "*"], () => null)
		.add(["*", "null"], () => null)
		.vectorize(2, [0, 1])
		.build();
}

function padding(name: string, side: "start" | "end") {
	const pad = (text: unknown, length: unknown, fill: unknown) =>
		padText(text as string, length as number, fill as string, side === "end");
	return new FunctionBuilder(name)
		.add(["string", "number"], ([text, length]) => pad(text, length, " "))
		.add(["string", "number", "string"], ([text, length, fill]) => pad(text, length, fill))
		.add(["null", "*"], () => null)
		.add(["*", "null"], () => null)
		.add(["null", "*", "*"], () => null)
		.add(["*", "null", "*"], () => null)
		.add(["*", "*", "null"], () => null)
		.vectorize(2, [0, 1])
		.vectorize(3, [0, 1, 2])
		.build();
}

function linkTo(path: string, ctx: EvalContext, display?: string, embed = false): DataviewLink {
	return new DataviewLink(ctx.normalizePath(path), "file", undefined, display, embed);
}

const link: FunctionImpl = new FunctionBuilder("link")
	.add(["string"], ([path], ctx) => linkTo(path as string, ctx))
	.add(["link"], ([value]) => value)
	.add(["null"], () => null)
	.vectorize(1, [0])
	.add(["string", "string"], ([path, display], ctx) =>
		linkTo(path as string, ctx, display as string),
	)
	.add(["string", "string", "boolean"], ([path, display, embed], ctx) =>
		linkTo(path as string, ctx, display as string, embed as boolean),
	)
	.add(["link", "string"], ([value, display]) =>
		(value as DataviewLink).withDisplay(display as string),
	)
	.add(["null", "*"], () => null)
	.add(["*", "null"], ([value], ctx) => link(ctx, [value]))
	.vectorize(2, [0, 1])
	.build();

const elink: FunctionImpl = new FunctionBuilder("elink")
	.add(
		["string", "string"],
		([url, display]) => new DataviewExternalLink(url as string, display as string),
	)
	.add(["string", "null"], ([url]) => new DataviewExternalLink(url as string))
	.add(["null", "*"], () => null)
	.vectorize(2, [0])
	.add(["string"], ([url]) => new DataviewExternalLink(url as string))
	.add(["null"], () => null)
	.vectorize(1, [0])
	.build();

const dateFn: FunctionImpl = new FunctionBuilder("date")
	.add(["string"], ([text], ctx) => {
		const trimmed = (text as string).trim();
		return dateShorthand(trimmed, ctx.now) ?? parseDateLiteral(trimmed);
	})
	.add(["date"], ([value]) => value)
	.add(["link"], ([value], ctx) => {
		const target = value as DataviewLink;
		const fromText =
			(target.display && parseDateLiteral(target.display)) || parseDateLiteral(target.path);
		if (fromText) return fromText;
		const file = ctx.resolveLink(target)?.file;
		return file && typeof file === "object" && "day" in file ? (file.day ?? null) : null;
	})
	.add(["string", "string"], ([text, format]) => {
		if (format === "x" || format === "X") {
			const match = NUMBER_IN_TEXT.exec(text as string);
			if (!match) throw new Error(`Not a number for format (${format}): ${text}.`);
			return new Date(Number.parseInt(match[0], 10) * (format === "X" ? 1000 : 1));
		}
		const parsed = parseWithLuxonFormat(text as string, format as string);
		if (!parsed) throw new Error(`Can't handle format (${format}) on date string (${text}).`);
		return parsed;
	})
	.add(["null", "string"], () => null)
	.add(["null"], () => null)
	.vectorize(1, [0])
	.build();

/** The DQL function library, by lowercase name. */
const FUNCTIONS: Record<string, FunctionImpl> = {
	// Constructors
	object: (_ctx, args) => {
		if (args.length % 2 !== 0) throw new Error("object() requires an even number of arguments.");
		const entries: Array<[string, unknown]> = [];
		for (let index = 0; index < args.length; index += 2) {
			const key = args[index];
			if (typeof key !== "string") {
				throw new Error("Keys should be of type string for object(key1, value1, ...).");
			}
			entries.push([key, args[index + 1] ?? null]);
		}
		// `fromEntries` defines own properties: `object("__proto__", x)` is a key, not a prototype.
		return Object.fromEntries(entries);
	},
	list: (_ctx, args) => args,
	array: (_ctx, args) => args,
	date: dateFn,
	dur: new FunctionBuilder("dur")
		.add(["string"], ([text]) => parseDuration(text as string)?.normalize() ?? null)
		.add(["duration"], ([value]) => value)
		.add(["null"], () => null)
		.vectorize(1, [0])
		.build(),
	number: nullary(
		"number",
		(value) => {
			if (typeof value === "number") return value;
			const match = NUMBER_IN_TEXT.exec(value as string);
			return match ? Number.parseFloat(match[0]) : null;
		},
		"*",
	),
	string: new FunctionBuilder("string").add(["*"], ([value]) => valueToString(value)).build(),
	link,
	embed: new FunctionBuilder("embed")
		.add(["link"], ([value]) => (value as DataviewLink).withEmbed(true))
		.vectorize(1, [0])
		.add(["link", "boolean"], ([value, embed]) =>
			(value as DataviewLink).withEmbed(embed as boolean),
		)
		.add(["null"], () => null)
		.add(["null", "*"], () => null)
		.add(["*", "null"], () => null)
		.vectorize(2, [0, 1])
		.build(),
	elink,
	typeof: (_ctx, [value]) => {
		const type = typeOf(value);
		return type === "widget" ? "widget" : type;
	},

	// Numbers
	round: new FunctionBuilder("round")
		.add(["number"], ([value]) => Math.round(value as number))
		.add(["null"], () => null)
		.vectorize(1, [0])
		.add(["number", "number"], ([value, places]) =>
			(places as number) <= 0
				? Math.round(value as number)
				: Number.parseFloat((value as number).toFixed(places as number)),
		)
		.add(["number", "null"], ([value]) => Math.round(value as number))
		.add(["null", "*"], () => null)
		.vectorize(2, [0])
		.build(),
	trunc: nullary("trunc", (value) => Math.trunc(value as number), "number"),
	floor: nullary("floor", (value) => Math.floor(value as number), "number"),
	ceil: nullary("ceil", (value) => Math.ceil(value as number), "number"),
	min,
	max,
	sum,
	product: new FunctionBuilder("product")
		.add(["array"], ([list], ctx) => reduce(ctx, [list, "*"]))
		.add(["*"], ([value]) => value)
		.build(),
	average: new FunctionBuilder("average")
		.add(["array"], ([list], ctx) => {
			const values = list as unknown[];
			if (values.length === 0) return null;
			const total = sum(ctx, [values]);
			return total === null || total === undefined
				? null
				: binaryOp("/", total, values.length, ctx);
		})
		.add(["*"], ([value]) => value)
		.build(),
	minby: new FunctionBuilder("minby")
		.add(["array", "function"], ([list, fn], ctx) => extremeBy(list as unknown[], fn, ctx, 1))
		.add(["null", "function"], () => null)
		.build(),
	maxby: new FunctionBuilder("maxby")
		.add(["array", "function"], ([list, fn], ctx) => extremeBy(list as unknown[], fn, ctx, -1))
		.add(["null", "function"], () => null)
		.build(),

	// Objects, arrays and strings
	contains,
	icontains,
	econtains: new FunctionBuilder("econtains")
		.add(["array", "*"], ([list, item], ctx) =>
			(list as unknown[]).some((element) => equals(item, element, ctx)),
		)
		.add(["string", "string"], ([text, part]) => (text as string).includes(part as string))
		.add(["object", "string"], ([object, key]) => Object.hasOwn(object as object, key as string))
		.add(["*", "*"], ([left, right], ctx) => equals(left, right, ctx))
		.vectorize(2, [1])
		.build(),
	containsword: stringPair("containsword", (text, word) =>
		new RegExp(`\\b${escapeRegExp(word)}\\b`, "i").test(text),
	),
	extract: (ctx, args) => {
		const [object, ...keys] = args;
		const pick = (value: unknown): unknown =>
			Object.fromEntries(
				keys.map((key) => {
					if (typeof key !== "string")
						throw new Error("extract(object, key1, ...) must be called with string keys.");
					return [key, indexValue(value, key, ctx)];
				}),
			);
		return Array.isArray(object) ? object.map(pick) : pick(object);
	},
	sort: new FunctionBuilder("sort")
		.add(["array"], ([list], ctx) =>
			[...(list as unknown[])].sort((left, right) => compareValues(left, right, ctx.normalizeLink)),
		)
		.add(["array", "function"], ([list, fn], ctx) =>
			[...(list as unknown[])]
				.map((value) => ({ value, key: call(fn, [value]) }))
				.sort((left, right) => compareValues(left.key, right.key, ctx.normalizeLink))
				.map((entry) => entry.value),
		)
		.add(["*"], ([value]) => value)
		.build(),
	reverse: new FunctionBuilder("reverse")
		.add(["array"], ([list]) => [...(list as unknown[])].reverse())
		.add(["string"], ([text]) => [...(text as string)].reverse().join(""))
		.add(["*"], ([value]) => value)
		.build(),
	length: new FunctionBuilder("length")
		.add(["array"], ([list]) => (list as unknown[]).length)
		.add(["object"], ([object]) => Object.keys(object as object).length)
		.add(["string"], ([text]) => (text as string).length)
		.add(["null"], () => 0)
		.build(),
	nonnull: new FunctionBuilder("nonnull")
		.add(["array"], ([list]) =>
			(list as unknown[]).filter((value) => value !== null && value !== undefined),
		)
		.vararg((args) => args.filter((value) => value !== null && value !== undefined))
		.build(),
	firstvalue: new FunctionBuilder("firstvalue")
		.add(
			["array"],
			([list]) =>
				(list as unknown[]).find((value) => value !== null && value !== undefined) ?? null,
		)
		.add(["null"], () => null)
		.build(),
	all: new FunctionBuilder("all")
		.add(["array"], ([list]) => (list as unknown[]).every(isTruthy))
		.add(["array", "function"], ([list, fn]) =>
			(list as unknown[]).every((value) => isTruthy(call(fn, [value]))),
		)
		.vararg((args) => args.every(isTruthy))
		.build(),
	any: new FunctionBuilder("any")
		.add(["array"], ([list]) => (list as unknown[]).some(isTruthy))
		.add(["array", "function"], ([list, fn]) =>
			(list as unknown[]).some((value) => isTruthy(call(fn, [value]))),
		)
		.vararg((args) => args.some(isTruthy))
		.build(),
	none: new FunctionBuilder("none")
		.add(["array"], ([list]) => !(list as unknown[]).some(isTruthy))
		.add(
			["array", "function"],
			([list, fn]) => !(list as unknown[]).some((value) => isTruthy(call(fn, [value]))),
		)
		.vararg((args) => !args.some(isTruthy))
		.build(),
	join,
	filter: new FunctionBuilder("filter")
		.add(["array", "function"], ([list, fn]) =>
			(list as unknown[]).filter((value) => isTruthy(call(fn, [value]))),
		)
		.add(["null", "*"], () => null)
		.build(),
	map: new FunctionBuilder("map")
		.add(["array", "function"], ([list, fn]) =>
			(list as unknown[]).map((value) => call(fn, [value])),
		)
		.add(["null", "*"], () => null)
		.build(),
	flat: new FunctionBuilder("flat")
		.add(["array"], ([list]) => flatList(list as unknown[], 1))
		.add(["array", "number"], ([list, depth]) => flatList(list as unknown[], depth as number))
		.add(["null"], () => null)
		.build(),
	slice: new FunctionBuilder("slice")
		.add(["array"], ([list]) => [...(list as unknown[])])
		.add(["array", "number"], ([list, start]) => (list as unknown[]).slice(start as number))
		.add(["array", "number", "number"], ([list, start, end]) =>
			(list as unknown[]).slice(start as number, end as number),
		)
		.add(["null"], () => null)
		.build(),
	unique: new FunctionBuilder("unique")
		.add(["array"], ([list], ctx) => {
			const result: unknown[] = [];
			const budget = budgetOf(ctx);
			for (const value of list as unknown[]) {
				// Each value is compared with every kept one: quadratic, so it is paid for.
				budget.spend(result.length);
				if (!result.some((seen) => equals(seen, value, ctx))) result.push(value);
			}
			return result;
		})
		.add(["null"], () => null)
		.build(),
	reduce,

	// Strings
	regextest: new FunctionBuilder("regextest")
		.add(["string", "string"], ([pattern, text]) =>
			compileRegex(pattern as string, "", text as string).test(text as string),
		)
		.add(["null", "*"], () => false)
		.add(["*", "null"], () => false)
		.vectorize(2, [0, 1])
		.build(),
	regexmatch: new FunctionBuilder("regexmatch")
		.add(["string", "string"], ([pattern, text]) => {
			let source = pattern as string;
			if (!source.startsWith("^") && !source.endsWith("$")) source = `^${source}$`;
			return compileRegex(source, "", text as string).test(text as string);
		})
		.add(["null", "*"], () => false)
		.add(["*", "null"], () => false)
		.vectorize(2, [0, 1])
		.build(),
	regexreplace: new FunctionBuilder("regexreplace")
		.add(["string", "string", "string"], ([text, pattern, replacement]) =>
			replaceText(
				text as string,
				compileRegex(pattern as string, "g", text as string),
				replacement as string,
				true,
			),
		)
		.add(["null", "*", "*"], () => null)
		.add(["*", "null", "*"], () => null)
		.add(["*", "*", "null"], () => null)
		.vectorize(3, [0, 1, 2])
		.build(),
	replace: new FunctionBuilder("replace")
		.add(["string", "string", "string"], ([text, pattern, replacement]) =>
			joinTexts((text as string).split(pattern as string), replacement as string, String),
		)
		.add(["null", "*", "*"], () => null)
		.add(["*", "null", "*"], () => null)
		.add(["*", "*", "null"], () => null)
		.vectorize(3, [0, 1, 2])
		.build(),
	lower: nullary("lower", (value) => (value as string).toLocaleLowerCase(), "string"),
	upper: nullary("upper", (value) => (value as string).toLocaleUpperCase(), "string"),
	split: new FunctionBuilder("split")
		.add(["string", "string"], ([text, delimiter]) =>
			(text as string)
				.split(compileRegex(delimiter as string, "", text as string))
				.map((part) => part ?? ""),
		)
		.add(["string", "string", "number"], ([text, delimiter, limit]) =>
			(text as string)
				.split(compileRegex(delimiter as string, "", text as string), limit as number)
				.map((part) => part ?? ""),
		)
		.add(["null", "*"], () => null)
		.add(["*", "null"], () => null)
		.add(["*", "*", "null"], () => null)
		.add(["*", "null", "*"], () => null)
		.add(["null", "*", "*"], () => null)
		.build(),
	startswith: stringPair("startswith", (text, prefix) => text.startsWith(prefix)),
	endswith: stringPair("endswith", (text, suffix) => text.endsWith(suffix)),
	padleft: padding("padleft", "start"),
	padright: padding("padright", "end"),
	substring: new FunctionBuilder("substring")
		.add(["string", "number"], ([text, start]) => (text as string).substring(start as number))
		.add(["string", "number", "number"], ([text, start, end]) =>
			(text as string).substring(start as number, end as number),
		)
		.add(["null", "*"], () => null)
		.add(["*", "null"], () => null)
		.add(["null", "*", "*"], () => null)
		.add(["*", "null", "*"], () => null)
		.add(["*", "*", "null"], () => null)
		.vectorize(2, [0, 1])
		.vectorize(3, [0, 1, 2])
		.build(),
	truncate,

	// Utilities
	default: new FunctionBuilder("default")
		.add(["*", "*"], ([value, fallback]) =>
			value === null || value === undefined ? fallback : value,
		)
		.vectorize(2, [0, 1])
		.build(),
	ldefault: new FunctionBuilder("ldefault")
		.add(["*", "*"], ([value, fallback]) =>
			value === null || value === undefined ? fallback : value,
		)
		.build(),
	display: (_ctx, [value]) => {
		const show = (item: unknown): string => {
			if (item === null || item === undefined) return "";
			if (Array.isArray(item)) return item.map(show).join(", ");
			if (typeof item === "string") return stripMarkdown(item);
			if (item instanceof DataviewLink)
				return item.display ? stripMarkdown(item.display) : fileTitle(item.path);
			return valueToString(item);
		};
		return show(value);
	},
	choice: new FunctionBuilder("choice")
		.add(["*", "*", "*"], ([condition, left, right]) => (isTruthy(condition) ? left : right))
		.vectorize(3, [0])
		.build(),
	striptime: nullary("striptime", (value) => startOfDay(value as Date), "date"),
	dateformat: new FunctionBuilder("dateformat")
		.add(["date", "string"], ([date, format]) => formatLuxonDate(date as Date, format as string))
		.add(["null", "string"], () => null)
		.vectorize(2, [0])
		.build(),
	durationformat: new FunctionBuilder("durationformat")
		.add(["duration", "string"], ([duration, format]) =>
			formatDuration(duration as DataviewDuration, format as string),
		)
		.add(["null", "string"], () => null)
		.vectorize(2, [0])
		.build(),
	currencyformat: new FunctionBuilder("currencyformat")
		.add(["number", "string"], ([amount, currency]) =>
			new Intl.NumberFormat("en-US", { style: "currency", currency: currency as string }).format(
				amount as number,
			),
		)
		.add(["null", "string"], () => null)
		.add(["number"], ([amount]) =>
			new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
				amount as number,
			),
		)
		.add(["null"], () => null)
		.vectorize(2, [0])
		.build(),
	// Dates are already read in the build's local zone.
	localtime: nullary("localtime", (value) => value, "date"),
	hash: new FunctionBuilder("hash")
		.add(["string", "number"], ([seed, variant]) => cyrb53(seed as string, variant as number))
		.add(["string", "string"], ([seed, text]) => cyrb53((seed as string) + (text as string)))
		.add(["string", "string", "number"], ([seed, text, variant]) =>
			cyrb53((seed as string) + (text as string), variant as number),
		)
		.build(),
	meta: new FunctionBuilder("meta")
		.add(["link"], ([value]) => {
			const target = value as DataviewLink;
			return {
				display: target.display ?? null,
				embed: target.embed,
				path: target.path,
				subpath: target.subpath ?? null,
				type: target.type,
			};
		})
		.build(),
};

/** Call a DQL function by name (DataviewJS `dv.func.<name>` uses the same library). */
export function callDataviewFunction(name: string, ctx: EvalContext, args: unknown[]): unknown {
	const key = name.toLowerCase();
	// Own keys only: `constructor(…)` must not reach Object.
	const impl = Object.hasOwn(FUNCTIONS, key) ? FUNCTIONS[key] : undefined;
	if (!impl) throw new Error(`Unsupported Dataview function: ${name}.`);
	const result = normalizeResult(impl(ctx, args));
	checkSize(result);
	budgetOf(ctx).charge(result, args[0]);
	return result;
}
