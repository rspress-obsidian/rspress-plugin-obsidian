/**
 * Dataview Query Language expressions and sources: a parser over the whole
 * query text (newlines are whitespace, as in Dataview's parsimmon grammar) and
 * an evaluator (`expression/parse.ts` and `context.ts` of
 * blacksmithgu/obsidian-dataview). The operators and indexing rules are in
 * `dataview-operators.ts`, the function library in `dataview-functions.ts`.
 */
import { escapeRegExp } from "../shared/escape.js";
import { callDataviewFunction } from "./dataview-functions.js";
import { unescapeString } from "./dataview-metadata.js";
import {
	type BinaryOp,
	binaryOp,
	budgetOf,
	type EvalContext,
	indexValue,
	normalizeResult,
} from "./dataview-operators.js";
import {
	DATE_SHORTHAND_NAMES,
	DataviewDuration,
	DataviewFunction,
	DataviewLink,
	dateShorthand,
	isTruthy,
	matchDurationPrefix,
	parseDateLiteral,
	typeOf,
} from "./dataview-values.js";

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
				const scope: Record<string, unknown> = { ...data };
				for (let position = 0; position < field.args.length; position += 1) {
					const name = field.args[position] as string;
					const value = args[position] ?? null;
					// Assigning `__proto__` would set the prototype; it must be a plain name.
					// Plain assignment for the rest: defining every parameter cost a third of
					// a lambda call.
					if (name === "__proto__") {
						Object.defineProperty(scope, name, {
							value,
							writable: true,
							enumerable: true,
							configurable: true,
						});
					} else {
						scope[name] = value;
					}
				}
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
