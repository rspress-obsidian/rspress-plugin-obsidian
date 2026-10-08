/**
 * DataviewJS, interpreted — never evaluated as JavaScript.
 *
 * A small JavaScript subset is tokenized, parsed and run by this module:
 * `const`/`let`/`var`, assignment to declared variables, `if`/`else`,
 * `for (… of …)`, arrow functions, template literals, the usual operators,
 * and the `dv` API over the content index. Identifiers resolve only to
 * variables the script declared, `dv` and a few safe globals; properties are
 * read only from a value's own enumerable fields; methods are an explicit
 * allowlist per value type. Nothing reaches the host: there is no `eval`,
 * `Function`, global object or prototype access.
 */
import { escapeHtmlAttribute, escapeHtmlText } from "../shared/escape.js";
import type { DailyNoteConfig } from "./daily-notes.js";
import {
	createDataviewEnvironment,
	type DataviewEnvironment,
	type DataviewSettings,
	renderQueryIn,
	renderTaskList,
} from "./dataview.js";
import {
	callDataviewFunction,
	DqlCursor,
	evaluate as evaluateDql,
	parseExpression,
	parseSource,
} from "./dataview-expression.js";
import { renderValue } from "./dataview-render.js";
import {
	addDuration,
	compareValues,
	DataviewDuration,
	DataviewFunction,
	DataviewLink,
	formatLuxonDate,
	isoWeek,
	luxonWeekday,
	parseDatePlus,
	parseDuration,
	valueToString,
} from "./dataview-values.js";
import {
	checkListLength,
	checkSize,
	concatLists,
	concatTexts,
	flatList,
	isStackOverflow,
	joinTexts,
	padText,
	repeatText,
	replaceText,
	STACK_OVERFLOW_MESSAGE,
	WorkBudget,
} from "./interpreter-limits.js";
import type { ContentIndex, ContentPage } from "./types.js";

export interface DataviewJsResult {
	html?: string;
	error?: string;
}

/**
 * Names a script may not mention as identifiers: host objects, code-loading
 * and prototype access. Matched on identifier tokens only, so a string such
 * as `"open a window"` is just text. A Set rather than an object literal,
 * because `constructor` and `__proto__` are exactly the keys an object
 * literal cannot hold as plain data.
 */
const FORBIDDEN_IDENTIFIERS = new Set([
	"globalThis",
	"global",
	"process",
	"require",
	"import",
	"export",
	"fetch",
	"Bun",
	"Deno",
	"window",
	"document",
	"eval",
	"Function",
	"constructor",
	"prototype",
	"__proto__",
	"setTimeout",
	"setInterval",
	"fs",
	"app",
]);

/** Keywords of JavaScript this interpreter does not implement. */
const UNSUPPORTED_KEYWORDS: Record<string, true> = {
	while: true,
	do: true,
	switch: true,
	class: true,
	function: true,
	new: true,
	delete: true,
	in: true,
	instanceof: true,
	try: true,
	throw: true,
	yield: true,
	this: true,
	with: true,
	void: true,
	break: true,
	continue: true,
};

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

interface Token {
	type: "number" | "string" | "template" | "identifier" | "punct" | "eof";
	value: string;
	/** Template literal pieces: the text runs and the `${…}` sources between them. */
	quasis?: string[];
	expressions?: string[];
	pos: number;
	newlineBefore: boolean;
}

const PUNCTUATORS = [
	"===",
	"!==",
	"...",
	"**",
	"=>",
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"??",
	"?.",
	"+=",
	"-=",
	"*=",
	"/=",
	"++",
	"--",
	"<<",
	">>",
	"+",
	"-",
	"*",
	"/",
	"%",
	"<",
	">",
	"!",
	"=",
	"(",
	")",
	"[",
	"]",
	"{",
	"}",
	",",
	";",
	".",
	":",
	"?",
	"&",
	"|",
	"^",
	"~",
];

const IDENTIFIER_START = /[\p{L}_$]/u;
const IDENTIFIER_PART = /[\p{L}\p{N}_$]/u;

function readString(source: string, start: number): { value: string; end: number } {
	const quote = source[start];
	let value = "";
	let index = start + 1;
	while (index < source.length) {
		const char = source[index] ?? "";
		if (char === quote) return { value, end: index + 1 };
		if (char === "\n") break;
		if (char === "\\") {
			const next = source[index + 1] ?? "";
			const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0" };
			if (next === "u" && /^[0-9a-fA-F]{4}$/.test(source.slice(index + 2, index + 6))) {
				value += String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 6), 16));
				index += 6;
				continue;
			}
			value += escapes[next] ?? next;
			index += 2;
			continue;
		}
		value += char;
		index += 1;
	}
	throw new Error(`Unterminated string in DataviewJS at offset ${start}.`);
}

/** Skip a string, template or balanced braces inside a template `${…}`. */
function templateExpressionEnd(source: string, start: number): number {
	let depth = 0;
	let index = start;
	while (index < source.length) {
		const char = source[index];
		if (char === '"' || char === "'") {
			index = readString(source, index).end;
			continue;
		}
		if (char === "`") {
			index = readTemplate(source, index).end;
			continue;
		}
		if (char === "{") depth += 1;
		else if (char === "}") {
			if (depth === 0) return index;
			depth -= 1;
		}
		index += 1;
	}
	throw new Error("Unterminated expression in a DataviewJS template literal.");
}

function readTemplate(
	source: string,
	start: number,
): { quasis: string[]; expressions: string[]; end: number } {
	const quasis: string[] = [];
	const expressions: string[] = [];
	let text = "";
	let index = start + 1;
	while (index < source.length) {
		const char = source[index] ?? "";
		if (char === "`") {
			quasis.push(text);
			return { quasis, expressions, end: index + 1 };
		}
		if (char === "\\") {
			const next = source[index + 1] ?? "";
			text += ({ n: "\n", t: "\t" } as Record<string, string>)[next] ?? next;
			index += 2;
			continue;
		}
		if (char === "$" && source[index + 1] === "{") {
			const end = templateExpressionEnd(source, index + 2);
			quasis.push(text);
			text = "";
			expressions.push(source.slice(index + 2, end));
			index = end + 1;
			continue;
		}
		text += char;
		index += 1;
	}
	throw new Error("Unterminated DataviewJS template literal.");
}

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let index = 0;
	let newlineBefore = false;
	while (index < source.length) {
		const char = source[index] ?? "";
		if (char === "\n") {
			newlineBefore = true;
			index += 1;
			continue;
		}
		if (/\s/.test(char)) {
			index += 1;
			continue;
		}
		if (source.startsWith("//", index)) {
			const end = source.indexOf("\n", index);
			index = end < 0 ? source.length : end;
			continue;
		}
		if (source.startsWith("/*", index)) {
			const end = source.indexOf("*/", index + 2);
			if (end < 0) throw new Error("Unterminated comment in DataviewJS.");
			if (source.slice(index, end).includes("\n")) newlineBefore = true;
			index = end + 2;
			continue;
		}
		const pos = index;
		if (char === '"' || char === "'") {
			const { value, end } = readString(source, index);
			tokens.push({ type: "string", value, pos, newlineBefore });
			index = end;
		} else if (char === "`") {
			const { quasis, expressions, end } = readTemplate(source, index);
			tokens.push({ type: "template", value: "", quasis, expressions, pos, newlineBefore });
			index = end;
		} else if (/\d/.test(char) || (char === "." && /\d/.test(source[index + 1] ?? ""))) {
			const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(index));
			const text = match?.[0] ?? char;
			tokens.push({ type: "number", value: text, pos, newlineBefore });
			index += text.length;
		} else if (IDENTIFIER_START.test(char)) {
			let end = index + 1;
			while (end < source.length && IDENTIFIER_PART.test(source[end] ?? "")) end += 1;
			const name = source.slice(index, end);
			if (FORBIDDEN_IDENTIFIERS.has(name)) {
				throw new Error(`DataviewJS source references a forbidden host or runtime API: ${name}.`);
			}
			tokens.push({ type: "identifier", value: name, pos, newlineBefore });
			index = end;
		} else {
			const punct = PUNCTUATORS.find((candidate) => source.startsWith(candidate, index));
			if (!punct) throw new Error(`Unexpected character "${char}" in DataviewJS.`);
			tokens.push({ type: "punct", value: punct, pos, newlineBefore });
			index += punct.length;
		}
		newlineBefore = false;
	}
	tokens.push({ type: "eof", value: "", pos: source.length, newlineBefore: true });
	return tokens;
}

// ---------------------------------------------------------------------------
// Syntax tree
// ---------------------------------------------------------------------------

type Expr =
	| { k: "literal"; value: unknown }
	| { k: "template"; quasis: string[]; expressions: Expr[] }
	| { k: "identifier"; name: string }
	| { k: "array"; items: Expr[] }
	| { k: "object"; props: Array<[string, Expr]> }
	| { k: "member"; object: Expr; property: string; optional: boolean }
	| { k: "index"; object: Expr; index: Expr; optional: boolean }
	| { k: "call"; callee: Expr; args: Expr[]; optional: boolean }
	| { k: "unary"; op: string; argument: Expr }
	| { k: "binary"; op: string; left: Expr; right: Expr }
	| { k: "conditional"; test: Expr; then: Expr; otherwise: Expr }
	| { k: "arrow"; params: string[]; body: Expr | Stmt[] }
	| { k: "assign"; op: string; target: string; value: Expr };

type Stmt =
	| { k: "declare"; kind: "const" | "let" | "var"; name: string; init?: Expr }
	| { k: "expression"; expr: Expr }
	| { k: "if"; test: Expr; then: Stmt; otherwise?: Stmt }
	| { k: "forOf"; name: string; iterable: Expr; body: Stmt }
	| { k: "block"; body: Stmt[] }
	| { k: "return"; value?: Expr }
	| { k: "empty" };

const BINARY_PRECEDENCE: Record<string, number> = {
	"??": 1,
	"||": 2,
	"&&": 3,
	"==": 4,
	"!=": 4,
	"===": 4,
	"!==": 4,
	"<": 5,
	">": 5,
	"<=": 5,
	">=": 5,
	"+": 6,
	"-": 6,
	"*": 7,
	"/": 7,
	"%": 7,
};

class Parser {
	private cursor = 0;

	constructor(
		private readonly tokens: Token[],
		private readonly source: string,
	) {}

	private peek(offset = 0): Token {
		return this.tokens[Math.min(this.cursor + offset, this.tokens.length - 1)] as Token;
	}

	private next(): Token {
		const token = this.peek();
		if (token.type !== "eof") this.cursor += 1;
		return token;
	}

	private is(value: string, offset = 0): boolean {
		const token = this.peek(offset);
		return (token.type === "punct" || token.type === "identifier") && token.value === value;
	}

	private expect(value: string): Token {
		if (!this.is(value)) this.unexpected(`expected "${value}"`);
		return this.next();
	}

	private unexpected(detail?: string): never {
		const token = this.peek();
		const line = this.source.slice(0, token.pos).split("\n").length;
		const found = token.type === "eof" ? "end of script" : `"${token.value || "`…`"}"`;
		throw new Error(
			`Unsupported DataviewJS syntax ${found} on line ${line}${detail ? ` (${detail})` : ""}.`,
		);
	}

	program(): Stmt[] {
		const body: Stmt[] = [];
		while (this.peek().type !== "eof") body.push(this.statement());
		return body;
	}

	/** Automatic semicolon insertion: `;`, a line break, `}` or the end close a statement. */
	private endStatement(): void {
		if (this.is(";")) {
			this.next();
			return;
		}
		const token = this.peek();
		if (token.type === "eof" || token.newlineBefore || this.is("}")) return;
		this.unexpected("expected the end of the statement");
	}

	private statement(): Stmt {
		const token = this.peek();
		if (this.is(";")) {
			this.next();
			return { k: "empty" };
		}
		if (this.is("{")) return this.block();
		if (token.type === "identifier") {
			if (token.value === "const" || token.value === "let" || token.value === "var") {
				this.next();
				const name = this.identifierName();
				let init: Expr | undefined;
				if (this.is("=")) {
					this.next();
					init = this.expression();
				} else if (token.value === "const") {
					this.unexpected("a const needs a value");
				}
				this.endStatement();
				return { k: "declare", kind: token.value, name, init };
			}
			if (token.value === "if") {
				this.next();
				this.expect("(");
				const test = this.expression();
				this.expect(")");
				const then = this.statement();
				if (this.is("else")) {
					this.next();
					return { k: "if", test, then, otherwise: this.statement() };
				}
				return { k: "if", test, then };
			}
			if (token.value === "for") {
				this.next();
				this.expect("(");
				if (this.is("const") || this.is("let") || this.is("var")) this.next();
				const name = this.identifierName();
				if (!this.is("of")) this.unexpected("only for (… of …) loops are supported");
				this.next();
				const iterable = this.expression();
				this.expect(")");
				return { k: "forOf", name, iterable, body: this.statement() };
			}
			if (token.value === "return") {
				this.next();
				const next = this.peek();
				if (this.is(";") || this.is("}") || next.type === "eof" || next.newlineBefore) {
					this.endStatement();
					return { k: "return" };
				}
				const value = this.expression();
				this.endStatement();
				return { k: "return", value };
			}
		}
		const expr = this.expression();
		this.endStatement();
		return { k: "expression", expr };
	}

	private block(): Stmt {
		this.expect("{");
		const body: Stmt[] = [];
		while (!this.is("}")) {
			if (this.peek().type === "eof") this.unexpected('expected "}"');
			body.push(this.statement());
		}
		this.next();
		return { k: "block", body };
	}

	private identifierName(): string {
		const token = this.next();
		if (token.type !== "identifier" || Object.hasOwn(UNSUPPORTED_KEYWORDS, token.value)) {
			this.cursor -= 1;
			this.unexpected("expected a name");
		}
		return token.value;
	}

	expression(): Expr {
		return this.assignment();
	}

	private assignment(): Expr {
		const token = this.peek();
		const operator = this.peek(1);
		if (
			token.type === "identifier" &&
			operator.type === "punct" &&
			["=", "+=", "-=", "*=", "/="].includes(operator.value)
		) {
			this.next();
			this.next();
			return { k: "assign", op: operator.value, target: token.value, value: this.assignment() };
		}
		const arrow = this.tryArrow();
		if (arrow) return arrow;
		return this.conditional();
	}

	private tryArrow(): Expr | undefined {
		const token = this.peek();
		if (
			token.type === "identifier" &&
			this.is("=>", 1) &&
			!Object.hasOwn(UNSUPPORTED_KEYWORDS, token.value)
		) {
			this.next();
			this.next();
			return { k: "arrow", params: [token.value], body: this.arrowBody() };
		}
		if (token.type === "identifier" && token.value === "async") {
			// `async` changes nothing here: every dv call is synchronous.
			const after = this.peek(1);
			if (after.type === "identifier" || (after.type === "punct" && after.value === "(")) {
				this.next();
				const inner = this.tryArrow();
				if (inner) return inner;
				this.cursor -= 1;
			}
		}
		if (!this.is("(")) return undefined;
		const start = this.cursor;
		this.next();
		const params: string[] = [];
		while (!this.is(")")) {
			const param = this.peek();
			if (param.type !== "identifier") {
				this.cursor = start;
				return undefined;
			}
			this.next();
			params.push(param.value);
			if (this.is(",")) this.next();
			else if (!this.is(")")) {
				this.cursor = start;
				return undefined;
			}
		}
		this.next();
		if (!this.is("=>")) {
			this.cursor = start;
			return undefined;
		}
		this.next();
		return { k: "arrow", params, body: this.arrowBody() };
	}

	private arrowBody(): Expr | Stmt[] {
		if (!this.is("{")) return this.assignment();
		const block = this.block();
		return block.k === "block" ? block.body : [block];
	}

	private conditional(): Expr {
		const test = this.binary(1);
		if (!this.is("?")) return test;
		this.next();
		const then = this.assignment();
		this.expect(":");
		return { k: "conditional", test, then, otherwise: this.assignment() };
	}

	private binary(minimum: number): Expr {
		let left = this.unary();
		for (;;) {
			const token = this.peek();
			if (token.type !== "punct") return left;
			if (["**", "&", "|", "^", "<<", ">>", "~"].includes(token.value)) {
				this.unexpected(`the ${token.value} operator is not supported`);
			}
			const precedence = BINARY_PRECEDENCE[token.value];
			if (precedence === undefined || precedence < minimum) return left;
			this.next();
			left = { k: "binary", op: token.value, left, right: this.binary(precedence + 1) };
		}
	}

	private unary(): Expr {
		const token = this.peek();
		if (
			token.type === "punct" &&
			(token.value === "!" || token.value === "-" || token.value === "+")
		) {
			this.next();
			return { k: "unary", op: token.value, argument: this.unary() };
		}
		if (
			token.type === "punct" &&
			(token.value === "++" || token.value === "--" || token.value === "~")
		) {
			this.unexpected(`the ${token.value} operator is not supported`);
		}
		if (token.type === "identifier" && (token.value === "typeof" || token.value === "await")) {
			this.next();
			return { k: "unary", op: token.value, argument: this.unary() };
		}
		return this.postfix(this.primary());
	}

	private postfix(base: Expr): Expr {
		let expr = base;
		for (;;) {
			if (this.is(".") || this.is("?.")) {
				const optional = this.next().value === "?.";
				if (optional && this.is("(")) {
					this.next();
					expr = { k: "call", callee: expr, args: this.callArguments(), optional };
					continue;
				}
				if (optional && this.is("[")) {
					this.next();
					const index = this.expression();
					this.expect("]");
					expr = { k: "index", object: expr, index, optional };
					continue;
				}
				const name = this.next();
				if (name.type !== "identifier") {
					this.cursor -= 1;
					this.unexpected("expected a property name");
				}
				expr = { k: "member", object: expr, property: name.value, optional };
			} else if (this.is("[")) {
				this.next();
				const index = this.expression();
				this.expect("]");
				expr = { k: "index", object: expr, index, optional: false };
			} else if (this.is("(")) {
				this.next();
				expr = { k: "call", callee: expr, args: this.callArguments(), optional: false };
			} else if (this.is("++") || this.is("--")) {
				this.unexpected(`the ${this.peek().value} operator is not supported`);
			} else {
				return expr;
			}
		}
	}

	private callArguments(): Expr[] {
		const args: Expr[] = [];
		while (!this.is(")")) {
			if (this.is("...")) this.unexpected("spread arguments are not supported");
			args.push(this.expression());
			if (this.is(",")) this.next();
			else if (!this.is(")")) this.unexpected('expected "," or ")"');
		}
		this.next();
		return args;
	}

	private primary(): Expr {
		const token = this.next();
		switch (token.type) {
			case "number":
				return { k: "literal", value: Number(token.value) };
			case "string":
				return { k: "literal", value: token.value };
			case "template":
				return {
					k: "template",
					quasis: token.quasis ?? [],
					expressions: (token.expressions ?? []).map((source) => parseExpressionSource(source)),
				};
			case "identifier": {
				const name = token.value;
				if (name === "true") return { k: "literal", value: true };
				if (name === "false") return { k: "literal", value: false };
				if (name === "null") return { k: "literal", value: null };
				if (name === "undefined") return { k: "literal", value: undefined };
				if (
					Object.hasOwn(UNSUPPORTED_KEYWORDS, name) ||
					["const", "let", "var", "if", "for", "else", "return"].includes(name)
				) {
					this.cursor -= 1;
					this.unexpected(`"${name}" is not supported here`);
				}
				return { k: "identifier", name };
			}
			case "punct": {
				if (token.value === "(") {
					const inner = this.expression();
					this.expect(")");
					return inner;
				}
				if (token.value === "[") {
					const items: Expr[] = [];
					while (!this.is("]")) {
						if (this.is("...")) this.unexpected("spread is not supported");
						items.push(this.expression());
						if (this.is(",")) this.next();
						else if (!this.is("]")) this.unexpected('expected "," or "]"');
					}
					this.next();
					return { k: "array", items };
				}
				if (token.value === "{") {
					const props: Array<[string, Expr]> = [];
					while (!this.is("}")) {
						const key = this.next();
						if (key.type !== "identifier" && key.type !== "string" && key.type !== "number") {
							this.cursor -= 1;
							this.unexpected("expected an object key");
						}
						if (key.type === "identifier" && (this.is(",") || this.is("}"))) {
							props.push([key.value, { k: "identifier", name: key.value }]);
						} else {
							this.expect(":");
							props.push([key.value, this.expression()]);
						}
						if (this.is(",")) this.next();
						else if (!this.is("}")) this.unexpected('expected "," or "}"');
					}
					this.next();
					return { k: "object", props };
				}
				break;
			}
		}
		this.cursor -= 1;
		return this.unexpected();
	}
}

function parseExpressionSource(source: string): Expr {
	const parser = new Parser(tokenize(source), source);
	const expr = parser.expression();
	return expr;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

class Scope {
	private readonly values = new Map<string, { value: unknown; constant: boolean }>();

	constructor(private readonly parent?: Scope) {}

	declare(name: string, value: unknown, constant: boolean): void {
		if (this.values.has(name)) throw new Error(`DataviewJS: "${name}" is already declared.`);
		this.values.set(name, { value, constant });
	}

	lookup(name: string): { value: unknown; constant: boolean } | undefined {
		return this.values.get(name) ?? this.parent?.lookup(name);
	}

	assign(name: string, value: unknown): void {
		const binding = this.values.get(name);
		if (binding) {
			if (binding.constant) throw new Error(`DataviewJS: cannot assign to the constant "${name}".`);
			binding.value = value;
			return;
		}
		if (!this.parent) throw new Error(`DataviewJS: "${name}" is not declared.`);
		this.parent.assign(name, value);
	}
}

/** The `dv` object, a marker the evaluator dispatches API calls on. */
const DV = Object.freeze({ kind: "dv" });
/** `dv.func`: every DQL function. */
const DV_FUNC = Object.freeze({ kind: "dv.func" });
/** `Math`: a handful of pure helpers. */
const MATH = Object.freeze({ kind: "Math" });

class ReturnSignal {
	constructor(readonly value: unknown) {}
}

const MAX_CALL_DEPTH = 200;
/**
 * Evaluation steps, plus what the script builds, before a runaway script is
 * stopped: room for a script that compares every page with every other.
 */
const MAX_WORK = 50_000_000;

interface Runtime {
	env: DataviewEnvironment;
	output: string[];
	depth: number;
	budget: WorkBudget;
}

function run(statements: Stmt[], scope: Scope, rt: Runtime): void {
	for (const statement of statements) execute(statement, scope, rt);
}

function execute(statement: Stmt, scope: Scope, rt: Runtime): void {
	rt.budget.spend();
	switch (statement.k) {
		case "empty":
			return;
		case "declare":
			scope.declare(
				statement.name,
				statement.init ? evaluate(statement.init, scope, rt) : undefined,
				statement.kind === "const",
			);
			return;
		case "expression":
			evaluate(statement.expr, scope, rt);
			return;
		case "if":
			if (evaluate(statement.test, scope, rt)) execute(statement.then, new Scope(scope), rt);
			else if (statement.otherwise) execute(statement.otherwise, new Scope(scope), rt);
			return;
		case "forOf": {
			const iterable = evaluate(statement.iterable, scope, rt);
			if (!Array.isArray(iterable)) throw new Error("DataviewJS: for (… of …) needs an array.");
			for (const item of iterable) {
				const inner = new Scope(scope);
				inner.declare(statement.name, item, false);
				execute(statement.body, inner, rt);
			}
			return;
		}
		case "block":
			run(statement.body, new Scope(scope), rt);
			return;
		case "return":
			throw new ReturnSignal(statement.value ? evaluate(statement.value, scope, rt) : undefined);
	}
}

function makeFunction(
	params: string[],
	body: Expr | Stmt[],
	scope: Scope,
	rt: Runtime,
): DataviewFunction {
	return new DataviewFunction((args) => {
		if (rt.depth >= MAX_CALL_DEPTH) throw new Error("DataviewJS: too much recursion.");
		rt.depth += 1;
		try {
			const inner = new Scope(scope);
			params.forEach((name, position) => {
				inner.declare(name, args[position], false);
			});
			if (!Array.isArray(body)) return evaluate(body, inner, rt);
			try {
				run(body, inner, rt);
			} catch (signal) {
				if (signal instanceof ReturnSignal) return signal.value;
				throw signal;
			}
			return undefined;
		} finally {
			rt.depth -= 1;
		}
	});
}

function invoke(fn: unknown, args: unknown[]): unknown {
	if (!(fn instanceof DataviewFunction))
		throw new Error("DataviewJS: expected a function such as p => p.file.name.");
	return fn.invoke(args);
}

function evaluate(expr: Expr, scope: Scope, rt: Runtime): unknown {
	rt.budget.spend();
	switch (expr.k) {
		case "literal":
			return expr.value;
		case "template": {
			let text = expr.quasis[0] ?? "";
			expr.expressions.forEach((part, position) => {
				text = concatTexts(
					text,
					jsString(evaluate(part, scope, rt)) + (expr.quasis[position + 1] ?? ""),
				);
			});
			return text;
		}
		case "identifier": {
			const binding = scope.lookup(expr.name);
			if (binding) return binding.value;
			if (expr.name === "dv") return DV;
			if (expr.name === "Math") return MATH;
			if (expr.name === "String" || expr.name === "Number" || expr.name === "Boolean") {
				return new DataviewFunction(([value]) =>
					expr.name === "String"
						? jsString(value)
						: expr.name === "Number"
							? Number(value)
							: Boolean(value),
				);
			}
			throw new Error(`DataviewJS: "${expr.name}" is not defined.`);
		}
		case "array":
			return expr.items.map((item) => evaluate(item, scope, rt));
		case "object":
			return Object.fromEntries(
				expr.props.map(([key, value]) => [key, evaluate(value, scope, rt)]),
			);
		case "member": {
			const object = evaluate(expr.object, scope, rt);
			if (expr.optional && object == null) return undefined;
			return readProperty(object, expr.property);
		}
		case "index": {
			const object = evaluate(expr.object, scope, rt);
			if (expr.optional && object == null) return undefined;
			const index = evaluate(expr.index, scope, rt);
			if (typeof index === "number" && Array.isArray(object)) return object[index];
			if (typeof index === "number" && typeof object === "string") return object[index];
			if (typeof index !== "string" && typeof index !== "number") {
				throw new Error("DataviewJS: an index must be a string or a number.");
			}
			return readProperty(object, String(index));
		}
		case "call":
			return callExpression(expr, scope, rt);
		case "unary": {
			const value = evaluate(expr.argument, scope, rt);
			if (expr.op === "!") return !value;
			if (expr.op === "-") return -Number(value);
			if (expr.op === "+") return Number(value);
			if (expr.op === "await") return value;
			return value instanceof DataviewFunction
				? "function"
				: value === null
					? "object"
					: typeof value;
		}
		case "binary": {
			if (expr.op === "&&") {
				const left = evaluate(expr.left, scope, rt);
				return left ? evaluate(expr.right, scope, rt) : left;
			}
			if (expr.op === "||") {
				const left = evaluate(expr.left, scope, rt);
				return left ? left : evaluate(expr.right, scope, rt);
			}
			if (expr.op === "??") {
				const left = evaluate(expr.left, scope, rt);
				return left ?? evaluate(expr.right, scope, rt);
			}
			return binary(expr.op, evaluate(expr.left, scope, rt), evaluate(expr.right, scope, rt));
		}
		case "conditional":
			return evaluate(expr.test, scope, rt)
				? evaluate(expr.then, scope, rt)
				: evaluate(expr.otherwise, scope, rt);
		case "arrow":
			return makeFunction(expr.params, expr.body, scope, rt);
		case "assign": {
			const binding = scope.lookup(expr.target);
			if (!binding) throw new Error(`DataviewJS: "${expr.target}" is not declared.`);
			const value = evaluate(expr.value, scope, rt);
			const next = expr.op === "=" ? value : binary(expr.op.slice(0, 1), binding.value, value);
			scope.assign(expr.target, next);
			return next;
		}
	}
}

/** `String(value)` with Dataview's display for links, dates and durations. */
function jsString(value: unknown): string {
	if (value === null || value === undefined || typeof value !== "object") return String(value);
	return valueToString(value);
}

function comparable(value: unknown): unknown {
	if (value instanceof Date) return value.getTime();
	if (value instanceof DataviewDuration) return value.toMillis();
	return value;
}

function binary(op: string, left: unknown, right: unknown): unknown {
	switch (op) {
		case "===":
		case "==": {
			if (
				typeof left === "object" &&
				left !== null &&
				typeof right === "object" &&
				right !== null
			) {
				return compareValues(left, right) === 0;
			}
			return op === "==" && left == null && right == null
				? true
				: comparable(left) === comparable(right);
		}
		case "!==":
		case "!=":
			return !binary(op === "!==" ? "===" : "==", left, right);
		case "<":
		case "<=":
		case ">":
		case ">=": {
			const a = comparable(left);
			const b = comparable(right);
			const comparison =
				(typeof a === "number" && typeof b === "number") ||
				(typeof a === "string" && typeof b === "string")
					? a < b
						? -1
						: a > b
							? 1
							: 0
					: compareValues(left, right);
			if (op === "<") return comparison < 0;
			if (op === "<=") return comparison <= 0;
			if (op === ">") return comparison > 0;
			return comparison >= 0;
		}
		case "+":
			if (typeof left === "string" || typeof right === "string")
				return concatTexts(jsString(left), jsString(right));
			if (left instanceof Date && right instanceof DataviewDuration)
				return addDuration(left, right);
			if (typeof left === "number" && typeof right === "number") return left + right;
			break;
		case "-":
			if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime();
			if (left instanceof Date && right instanceof DataviewDuration)
				return addDuration(left, right, -1);
			if (typeof left === "number" && typeof right === "number") return left - right;
			break;
		case "*":
			if (typeof left === "number" && typeof right === "number") return left * right;
			break;
		case "/":
			if (typeof left === "number" && typeof right === "number") return left / right;
			break;
		case "%":
			if (typeof left === "number" && typeof right === "number") return left % right;
			break;
	}
	throw new Error(
		`DataviewJS: the ${op} operator does not apply to ${describe(left)} and ${describe(right)}.`,
	);
}

function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	if (value instanceof Date) return "a date";
	if (value instanceof DataviewLink) return "a link";
	return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/** Luxon-style properties of a date, which `dv` scripts read off `file.mtime` and friends. */
function dateProperty(date: Date, name: string): unknown {
	switch (name) {
		case "year":
			return date.getFullYear();
		case "month":
			return date.getMonth() + 1;
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
		case "weekday":
			return luxonWeekday(date);
		case "weekNumber":
			return isoWeek(date).week;
		case "weekYear":
			return isoWeek(date).year;
		case "ts":
			return date.getTime();
		default:
			return undefined;
	}
}

/** A value's own field — never an inherited one, so prototypes are unreachable. */
function readProperty(value: unknown, property: string): unknown {
	if (value === null || value === undefined) {
		throw new Error(`DataviewJS: cannot read "${property}" of ${value}.`);
	}
	if (Array.isArray(value)) {
		if (property === "length") return value.length;
		if (property === "values") return value;
		if (/^\d+$/.test(property)) return value[Number(property)];
		// `pages.file.name`: a field of every element, as Dataview's DataArray does.
		// Grown item by item: lists of the same long list would flatten into its square.
		const fields: unknown[] = [];
		for (const item of value) {
			if (item === null || item === undefined) continue;
			const field = readProperty(item, property);
			for (const entry of Array.isArray(field) ? field : [field]) {
				fields.push(entry);
				checkListLength(fields.length);
			}
		}
		return fields;
	}
	if (typeof value === "string") return property === "length" ? value.length : undefined;
	if (value instanceof Date) return dateProperty(value, property);
	if (value instanceof DataviewDuration) {
		return Object.hasOwn(value, property) ? Reflect.get(value, property) : undefined;
	}
	if (value instanceof DataviewLink) {
		if (
			property === "path" ||
			property === "display" ||
			property === "subpath" ||
			property === "embed" ||
			property === "type"
		) {
			return value[property];
		}
		return undefined;
	}
	if (value === DV || value === DV_FUNC || value === MATH || value instanceof DataviewFunction) {
		if (value === DV && property === "func") return DV_FUNC;
		return undefined;
	}
	if (typeof value === "object") {
		return Object.hasOwn(value, property) &&
			Object.prototype.propertyIsEnumerable.call(value, property)
			? Reflect.get(value, property)
			: undefined;
	}
	return undefined;
}

function callExpression(expr: Extract<Expr, { k: "call" }>, scope: Scope, rt: Runtime): unknown {
	const callee = expr.callee;
	if (callee.k === "member") {
		const receiver = evaluate(callee.object, scope, rt);
		if (callee.optional && receiver == null) return undefined;
		const args = expr.args.map((arg) => evaluate(arg, scope, rt));
		const result = callMethod(receiver, callee.property, args, rt);
		checkSize(result);
		rt.budget.charge(result, receiver);
		return result;
	}
	const fn = evaluate(callee, scope, rt);
	if (expr.optional && fn == null) return undefined;
	return invoke(
		fn,
		expr.args.map((arg) => evaluate(arg, scope, rt)),
	);
}

function callMethod(receiver: unknown, name: string, args: unknown[], rt: Runtime): unknown {
	if (receiver === DV) {
		const emitted = rt.output.length;
		const result = callDv(name, args, rt);
		// Rendered output is built too: a loop rendering a huge value each pass must still stop.
		for (const html of rt.output.slice(emitted)) rt.budget.charge(html, undefined);
		return result;
	}
	if (receiver === DV_FUNC) return callDataviewFunction(name, rt.env.ctx, args);
	if (receiver === MATH) {
		const numbers = args.map(Number);
		switch (name) {
			case "round":
				return Math.round(numbers[0] ?? Number.NaN);
			case "floor":
				return Math.floor(numbers[0] ?? Number.NaN);
			case "ceil":
				return Math.ceil(numbers[0] ?? Number.NaN);
			case "abs":
				return Math.abs(numbers[0] ?? Number.NaN);
			case "min":
				return Math.min(...numbers);
			case "max":
				return Math.max(...numbers);
		}
		throw new Error(`Unsupported DataviewJS function: Math.${name}.`);
	}
	if (Array.isArray(receiver)) return callArrayMethod(receiver, name, args, rt.budget);
	if (typeof receiver === "string") return callStringMethod(receiver, name, args);
	if (typeof receiver === "number") {
		if (name === "toFixed") return receiver.toFixed(Number(args[0] ?? 0));
		if (name === "toString") return String(receiver);
	}
	if (receiver instanceof Date) {
		if (name === "toFormat") return formatLuxonDate(receiver, String(args[0] ?? ""));
		if (name === "toISODate") return formatLuxonDate(receiver, "yyyy-MM-dd");
		if (name === "toMillis" || name === "valueOf") return receiver.getTime();
		if (name === "plus" || name === "minus") {
			const duration =
				args[0] instanceof DataviewDuration ? args[0] : parseDuration(String(args[0] ?? ""));
			if (!duration) throw new Error(`DataviewJS: ${name}() needs a duration.`);
			return addDuration(receiver, duration, name === "plus" ? 1 : -1);
		}
		if (name === "toString") return valueToString(receiver);
	}
	if (receiver instanceof DataviewDuration) {
		if (name === "toMillis") return receiver.toMillis();
		if (name === "toHuman" || name === "toString") return receiver.toHuman();
	}
	if (receiver instanceof DataviewLink && name === "toString") return receiver.markdown();
	const property =
		receiver !== null && receiver !== undefined ? readProperty(receiver, name) : undefined;
	if (property instanceof DataviewFunction) return property.invoke(args);
	throw new Error(`Unsupported DataviewJS method: ${name}() on ${describe(receiver)}.`);
}

function callStringMethod(text: string, name: string, args: unknown[]): unknown {
	const arg = (position: number) => String(args[position] ?? "");
	switch (name) {
		case "toUpperCase":
			return text.toUpperCase();
		case "toLowerCase":
			return text.toLowerCase();
		case "trim":
			return text.trim();
		case "includes":
			return text.includes(arg(0));
		case "startsWith":
			return text.startsWith(arg(0));
		case "endsWith":
			return text.endsWith(arg(0));
		case "indexOf":
			return text.indexOf(arg(0));
		case "slice":
			return text.slice(Number(args[0] ?? 0), args[1] === undefined ? undefined : Number(args[1]));
		case "substring":
			return text.substring(
				Number(args[0] ?? 0),
				args[1] === undefined ? undefined : Number(args[1]),
			);
		case "split":
			return text.split(arg(0));
		case "replace":
			return replaceText(text, arg(0), arg(1), false);
		case "replaceAll":
			return replaceText(text, arg(0), arg(1), true);
		case "padStart":
			return padText(text, Number(args[0] ?? 0), args[1] === undefined ? " " : arg(1), false);
		case "padEnd":
			return padText(text, Number(args[0] ?? 0), args[1] === undefined ? " " : arg(1), true);
		case "repeat":
			return repeatText(text, Math.max(0, Number(args[0] ?? 0)));
		case "charAt":
			return text.charAt(Number(args[0] ?? 0));
		case "toString":
			return text;
		case "localeCompare":
			return text.localeCompare(arg(0));
	}
	throw new Error(`Unsupported DataviewJS method: ${name}() on a string.`);
}

function sortKeyed(
	list: unknown[],
	key: (value: unknown) => unknown,
	descending: boolean,
): unknown[] {
	const keyed = list.map((value) => ({ value, key: key(value) }));
	keyed.sort((left, right) => {
		const comparison = compareValues(left.key, right.key);
		return descending ? -comparison : comparison;
	});
	return keyed.map((entry) => entry.value);
}

function callArrayMethod(
	list: unknown[],
	name: string,
	args: unknown[],
	budget: WorkBudget,
): unknown {
	const fn = args[0];
	const apply = (value: unknown, index: number) => invoke(fn, [value, index]);
	switch (name) {
		case "where":
		case "filter":
			return list.filter((value, index) => Boolean(apply(value, index)));
		case "map":
			return list.map((value, index) => apply(value, index));
		case "flatMap": {
			// Grown item by item: a callback returning a long list each time would square it.
			const flattened: unknown[] = [];
			list.forEach((value, index) => {
				const result = apply(value, index);
				for (const entry of Array.isArray(result) ? result : [result]) {
					flattened.push(entry);
					checkListLength(flattened.length);
				}
			});
			return flattened;
		}
		case "forEach":
			list.forEach((value, index) => {
				apply(value, index);
			});
			return undefined;
		case "sort": {
			const key =
				fn === undefined ? (value: unknown) => value : (value: unknown) => invoke(fn, [value]);
			return sortKeyed(list, key, String(args[1] ?? "asc").toLowerCase() === "desc");
		}
		case "groupBy": {
			const groups: Array<{ key: unknown; rows: unknown[] }> = [];
			for (const value of sortKeyed(list, (item) => invoke(fn, [item]), false)) {
				const key = invoke(fn, [value]);
				const last = groups[groups.length - 1];
				if (last && compareValues(last.key, key) === 0) last.rows.push(value);
				else groups.push({ key, rows: [value] });
			}
			return groups;
		}
		case "distinct": {
			const result: unknown[] = [];
			const keys: unknown[] = [];
			for (const value of list) {
				const key = fn === undefined ? value : invoke(fn, [value]);
				// Each key is compared with every kept one: quadratic, so it is paid for.
				budget.spend(keys.length);
				if (keys.some((seen) => compareValues(seen, key) === 0)) continue;
				keys.push(key);
				result.push(value);
			}
			return result;
		}
		case "limit":
			return list.slice(0, Math.max(0, Number(args[0] ?? 0)));
		case "slice":
			return list.slice(Number(args[0] ?? 0), args[1] === undefined ? undefined : Number(args[1]));
		case "join":
			return joinTexts(list, args[0] === undefined ? ", " : String(args[0]), jsString);
		case "flat":
			return flatList(list, Math.max(0, Math.min(16, Number(args[0] ?? 1))));
		case "first":
			return list[0];
		case "last":
			return list[list.length - 1];
		case "find":
			return list.find((value, index) => Boolean(apply(value, index)));
		case "findIndex":
			return list.findIndex((value, index) => Boolean(apply(value, index)));
		case "includes":
			return list.some((value) => binary("===", value, args[0]));
		case "indexOf":
			return list.findIndex((value) => binary("===", value, args[0]));
		case "some":
		case "any":
			return list.some((value, index) => Boolean(apply(value, index)));
		case "every":
		case "all":
			return list.every((value, index) => Boolean(apply(value, index)));
		case "none":
			return !list.some((value, index) => Boolean(apply(value, index)));
		case "concat":
			return concatLists([list, ...args.map((arg) => (Array.isArray(arg) ? arg : [arg]))]);
		case "array":
			return [...list];
		case "reverse":
			return [...list].reverse();
	}
	throw new Error(`Unsupported DataviewJS collection method: ${name}.`);
}

/** The pages a `dv.pages()` source selects, parsed with the DQL source grammar. */
function selectPages(source: unknown, env: DataviewEnvironment): ContentPage[] {
	if (source === undefined || source === null || String(source).trim() === "")
		return env.index.pages;
	const cursor = new DqlCursor(String(source));
	cursor.skipSpace();
	const parsed = parseSource(cursor);
	cursor.skipSpace();
	if (!cursor.done) throw new Error(`Unsupported Dataview source: ${String(source)}`);
	return env.pagesFor(parsed);
}

function pagesFor(source: unknown, env: DataviewEnvironment): unknown[] {
	return selectPages(source, env).map((page) => env.pageValues(page));
}

function pageFor(target: unknown, env: DataviewEnvironment): unknown {
	const link =
		target instanceof DataviewLink
			? target
			: typeof target === "string"
				? DataviewLink.parseInner(target.replace(/^\[\[|\]\]$/g, ""))
				: undefined;
	if (!link) return undefined;
	const page = env.resolvePage(link);
	return page ? env.pageValues(page) : undefined;
}

const ELEMENT_TAGS: Record<string, true> = {
	div: true,
	span: true,
	p: true,
	b: true,
	i: true,
	strong: true,
	em: true,
	code: true,
	small: true,
	mark: true,
	blockquote: true,
	h1: true,
	h2: true,
	h3: true,
	h4: true,
	h5: true,
	h6: true,
};

function callDv(name: string, args: unknown[], rt: Runtime): unknown {
	const { env, output } = rt;
	const rc = env.rc;
	switch (name) {
		case "pages":
			return pagesFor(args[0], env);
		case "pagePaths":
			return selectPages(args[0], env).map((page) => page.relativePath);
		case "page":
			return pageFor(args[0], env);
		case "current":
			return env.pageValues(env.currentPage);
		case "array":
			return Array.isArray(args[0]) ? args[0] : args[0] === undefined ? [] : [args[0]];
		case "isArray":
			return Array.isArray(args[0]);
		case "date":
			return args[0] instanceof Date
				? args[0]
				: typeof args[0] === "string"
					? parseDatePlus(args[0])
					: null;
		case "duration":
			return typeof args[0] === "string" ? (parseDuration(args[0])?.normalize() ?? null) : null;
		case "fileLink":
			return new DataviewLink(
				String(args[0] ?? ""),
				"file",
				undefined,
				args[2] === undefined ? undefined : String(args[2]),
				args[1] === true,
			);
		case "sectionLink":
			return new DataviewLink(
				String(args[0] ?? ""),
				"header",
				String(args[1] ?? ""),
				args[3] === undefined ? undefined : String(args[3]),
				args[2] === true,
			);
		case "blockLink":
			return new DataviewLink(
				String(args[0] ?? ""),
				"block",
				String(args[1] ?? ""),
				args[3] === undefined ? undefined : String(args[3]),
				args[2] === true,
			);
		case "compare":
			return compareValues(args[0], args[1]);
		case "equal":
			return compareValues(args[0], args[1]) === 0;
		case "evaluate":
		case "tryEvaluate": {
			const context = args[1];
			const data =
				context && typeof context === "object" && !Array.isArray(context)
					? Object.fromEntries(Object.entries(context))
					: {};
			const value = evaluateDql(parseExpression(String(args[0] ?? "")), env.ctx, data);
			return name === "evaluate" ? { successful: true, value } : value;
		}
		case "execute":
			output.push(renderQueryIn(String(args[0] ?? ""), env));
			return undefined;
		case "paragraph":
			output.push(`<p class="dataviewjs-paragraph">${renderValue(args[0], rc, true)}</p>`);
			return undefined;
		case "span":
			output.push(`<span class="dataviewjs-span">${renderValue(args[0], rc, true)}</span>`);
			return undefined;
		case "header": {
			const requested = Number(args[0]);
			const level = Number.isFinite(requested)
				? Math.min(6, Math.max(1, Math.trunc(requested)))
				: 2;
			output.push(`<h${level}>${renderValue(args[1], rc, true)}</h${level}>`);
			return undefined;
		}
		case "el": {
			const tag = String(args[0] ?? "").toLowerCase();
			if (!Object.hasOwn(ELEMENT_TAGS, tag)) {
				throw new Error(`DataviewJS: dv.el() does not create <${tag}> elements.`);
			}
			const options = args[2] && typeof args[2] === "object" ? args[2] : undefined;
			const cls =
				options && Object.hasOwn(options, "cls") ? Reflect.get(options, "cls") : undefined;
			const classes = Array.isArray(cls)
				? cls.map(String).join(" ")
				: cls === undefined
					? ""
					: String(cls);
			output.push(
				`<${tag}${classes ? ` class="${escapeHtmlAttribute(classes)}"` : ""}>${renderValue(args[1], rc, true)}</${tag}>`,
			);
			return undefined;
		}
		case "list": {
			const items = Array.isArray(args[0]) ? args[0] : args[0] === undefined ? [] : [args[0]];
			output.push(
				`<ul class="dataviewjs-list">${items.map((item) => `<li>${renderValue(item, rc)}</li>`).join("")}</ul>`,
			);
			return undefined;
		}
		case "taskList": {
			const tasks = Array.isArray(args[0]) ? args[0].flat(Number.POSITIVE_INFINITY) : [];
			if (args[1] === false) {
				output.push(`<div class="dataviewjs-task-list">${renderTaskList(tasks, env)}</div>`);
				return undefined;
			}
			// Grouped by file by default, as `dv.taskList(tasks, groupByFile = true)` is.
			const byFile = new Map<string, unknown[]>();
			for (const task of tasks) {
				const path =
					task && typeof task === "object" ? String(Reflect.get(task, "path") ?? "") : "";
				const bucket = byFile.get(path);
				if (bucket) bucket.push(task);
				else byFile.set(path, [task]);
			}
			const groups = [...byFile].map(
				([path, items]) =>
					`<h4>${rc.linkHtml(new DataviewLink(path))}</h4><div class="dataview result-group">${renderTaskList(items, env)}</div>`,
			);
			output.push(`<div class="dataviewjs-task-list">${groups.join("")}</div>`);
			return undefined;
		}
		case "table": {
			const headers = Array.isArray(args[0]) ? args[0] : [];
			const rows = Array.isArray(args[1]) ? args[1] : [];
			const head = headers.map((header) => `<th>${escapeHtmlText(jsString(header))}</th>`).join("");
			const body = rows
				.map(
					(row) =>
						`<tr>${(Array.isArray(row) ? row : [row]).map((cell) => `<td>${renderValue(cell, rc)}</td>`).join("")}</tr>`,
				)
				.join("");
			output.push(
				`<table class="dataviewjs-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`,
			);
			return undefined;
		}
		case "view":
			throw new Error(
				"Unsupported DataviewJS function: dv.view() loads script files, which a static build does not run.",
			);
	}
	throw new Error(`Unsupported DataviewJS function: dv.${name}.`);
}

function newRuntime(
	currentPage: ContentPage,
	index: ContentIndex,
	dailyConfig: DailyNoteConfig | undefined,
	settings: DataviewSettings | undefined,
): Runtime {
	return {
		env: createDataviewEnvironment(currentPage, index, dailyConfig, settings),
		output: [],
		depth: 0,
		budget: new WorkBudget(MAX_WORK, "DataviewJS: the script"),
	};
}

/** A failed script's result; a stack overflow (deep nesting) is named as such. */
function failure(error: unknown): DataviewJsResult {
	if (isStackOverflow(error)) return { error: `DataviewJS: ${STACK_OVERFLOW_MESSAGE}` };
	return { error: error instanceof Error ? error.message : String(error) };
}

/**
 * Run a `dataviewjs` block. Statements may be separated by `;` or line breaks;
 * anything outside the supported subset is an error naming the line, never a
 * silently skipped statement.
 */
export function renderDataviewJs(
	source: string,
	currentPage: ContentPage,
	index: ContentIndex,
	dailyConfig?: DailyNoteConfig,
	settings?: DataviewSettings,
): DataviewJsResult {
	try {
		const program = new Parser(tokenize(source), source).program();
		const rt = newRuntime(currentPage, index, dailyConfig, settings);
		try {
			run(program, new Scope(), rt);
		} catch (signal) {
			if (!(signal instanceof ReturnSignal)) throw signal;
		}
		return { html: rt.output.join("\n") };
	} catch (error) {
		return failure(error);
	}
}

/** An inline DataviewJS query — the `expr` of `` `$= expr` ``: its value, rendered inline. */
export function renderDataviewJsInline(
	source: string,
	currentPage: ContentPage,
	index: ContentIndex,
	dailyConfig?: DailyNoteConfig,
	settings?: DataviewSettings,
): DataviewJsResult {
	try {
		const program = new Parser(tokenize(source), source).program();
		const rt = newRuntime(currentPage, index, dailyConfig, settings);
		// The value of the last expression statement is the result, as in Dataview.
		const last = program[program.length - 1];
		const scope = new Scope();
		run(program.slice(0, -1), scope, rt);
		let value: unknown;
		if (last?.k === "expression") value = evaluate(last.expr, scope, rt);
		else if (last) execute(last, scope, rt);
		const rendered = value === undefined ? "" : renderValue(value, rt.env.rc, true);
		return { html: `<span class="dataview-inline">${rt.output.join("")}${rendered}</span>` };
	} catch (error) {
		return failure(error);
	}
}
