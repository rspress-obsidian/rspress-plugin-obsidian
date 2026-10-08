/**
 * The JavaScript inside Templater commands, interpreted — never evaluated.
 *
 * Templater compiles a template into one async function: text becomes
 * `tR += "…"`, `<% expr %>` appends the expression's value, and `<%* … %>`
 * is pasted in as statements, so a block opened in one command can close in
 * a later one. This module builds the same program from the template's
 * chunks and runs it over a small JavaScript subset: `const`/`let`,
 * assignment and `++`/`--` on variables, `if`/`else`, `for (… of …)` with
 * array destructuring, arrow functions, template and regex literals,
 * `await` (a no-op: every host call is awaited already), the ternary and the
 * usual operators, plus allowlisted methods on strings, arrays, numbers,
 * dates and the host objects (`tp`, `moment`, `Math`, `JSON`, …).
 *
 * Identifiers resolve only to variables the program declared and the globals
 * it was given. Properties are read only from a value's own enumerable
 * fields or a host object's own table, and `constructor`, `__proto__` and
 * `prototype` are refused as names and as computed keys. There is no `eval`,
 * `Function`, `import()`, `require` or global object to reach.
 */
import {
	checkListLength,
	checkSize,
	concatLists,
	concatTexts,
	flatList,
	growthCost,
	isStackOverflow,
	joinTexts,
	padText,
	repeatText,
	replaceText,
	STACK_OVERFLOW_MESSAGE,
} from "../../interpreter-limits.js";
import { compileSafeRegex, UnsafeRegexError } from "../../safe-regex.js";

/** An error whose message is shown to the author in place of the command. */
export class TemplaterError extends Error {}

/** A callable the program may invoke: a host function or an arrow function. */
export class HostFunction {
	constructor(
		readonly label: string,
		readonly call: (args: unknown[]) => unknown,
	) {}
}

/**
 * A host value with its own property table and methods — a `tp` module, a
 * moment, a file. Nothing outside the table is reachable from a program.
 */
export abstract class HostValue {
	abstract readonly label: string;

	abstract property(name: string): unknown;

	method(name: string, args: unknown[]): unknown {
		const member = this.property(name);
		if (member instanceof HostFunction) return member.call(args);
		throw new TemplaterError(`${this.label}.${name} is not a function.`);
	}

	/** What `${value}` and `<% value %>` show. */
	toTemplateString(): string {
		return "[object Object]";
	}

	/** The number standing for the value in arithmetic and comparison (a timestamp). */
	primitive(): number | undefined {
		return undefined;
	}
}

/** A host namespace: named members, optionally computed for unknown names. */
export class HostObject extends HostValue {
	constructor(
		readonly label: string,
		private readonly members: Record<string, unknown>,
		private readonly fallback?: (name: string) => unknown,
	) {
		super();
	}

	override property(name: string): unknown {
		if (Object.hasOwn(this.members, name)) return this.members[name];
		return this.fallback?.(name);
	}

	keys(): string[] {
		return Object.keys(this.members);
	}
}

/**
 * Names a program may not mention: host objects, code loading and prototype
 * access. Matched on identifier tokens, so a string such as `"open the
 * window"` is just text. A Set, because `constructor` and `__proto__` are the
 * keys an object literal cannot hold as plain data.
 */
const FORBIDDEN_IDENTIFIERS = new Set([
	"globalThis",
	"global",
	"self",
	"process",
	"require",
	"module",
	"exports",
	"import",
	"export",
	"fetch",
	"XMLHttpRequest",
	"Bun",
	"Deno",
	"window",
	"document",
	"navigator",
	"eval",
	"Function",
	"Reflect",
	"Proxy",
	"constructor",
	"prototype",
	"__proto__",
	"__defineGetter__",
	"__defineSetter__",
	"__lookupGetter__",
	"setTimeout",
	"setInterval",
	"queueMicrotask",
	"app",
]);

/** Property names refused even when computed (`x["constructor"]`). */
const FORBIDDEN_PROPERTIES = new Set([
	"constructor",
	"prototype",
	"__proto__",
	"__defineGetter__",
	"__defineSetter__",
	"__lookupGetter__",
	"__lookupSetter__",
]);

/** Keywords of JavaScript this interpreter does not implement. */
const UNSUPPORTED_KEYWORDS: Record<string, true> = {
	while: true,
	do: true,
	switch: true,
	class: true,
	function: true,
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
	var: true,
};

const RESERVED_NAMES: Record<string, true> = {
	...UNSUPPORTED_KEYWORDS,
	const: true,
	let: true,
	if: true,
	else: true,
	for: true,
	of: true,
	return: true,
	new: true,
	typeof: true,
	await: true,
	async: true,
	true: true,
	false: true,
	null: true,
	undefined: true,
};

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

interface Token {
	type:
		| "number"
		| "string"
		| "template"
		| "regex"
		| "identifier"
		| "punct"
		| "text"
		| "output"
		| "eof";
	value: string;
	pos: number;
	newlineBefore: boolean;
	/** The command the token was written in; errors and markers name it. */
	origin?: string;
	quasis?: string[];
	expressions?: string[];
	flags?: string;
	/** An `output` token: the parsed expression, or why it does not parse. */
	expr?: Expr;
	error?: string;
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
	"%=",
	"++",
	"--",
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
const STRING_ESCAPES: Record<string, string> = {
	n: "\n",
	t: "\t",
	r: "\r",
	b: "\b",
	f: "\f",
	v: "\v",
	"0": "\0",
};

/** A `\x` escape inside a string or template literal: its value and length. */
function readEscape(source: string, index: number): { value: string; length: number } {
	const next = source[index + 1] ?? "";
	if (next === "u" && /^[0-9a-fA-F]{4}$/.test(source.slice(index + 2, index + 6))) {
		return {
			value: String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 6), 16)),
			length: 6,
		};
	}
	if (next === "x" && /^[0-9a-fA-F]{2}$/.test(source.slice(index + 2, index + 4))) {
		return {
			value: String.fromCharCode(Number.parseInt(source.slice(index + 2, index + 4), 16)),
			length: 4,
		};
	}
	// A backslash before a line break continues the line.
	if (next === "\n") return { value: "", length: 2 };
	return { value: STRING_ESCAPES[next] ?? next, length: 2 };
}

function readString(source: string, start: number): { value: string; end: number } {
	const quote = source[start];
	let value = "";
	let index = start + 1;
	while (index < source.length) {
		const char = source[index] ?? "";
		if (char === quote) return { value, end: index + 1 };
		if (char === "\n") break;
		if (char === "\\") {
			const escaped = readEscape(source, index);
			value += escaped.value;
			index += escaped.length;
			continue;
		}
		value += char;
		index += 1;
	}
	throw new TemplaterError("Unterminated string.");
}

/** Skip a string, template or balanced braces inside a template's `${…}`. */
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
	throw new TemplaterError("Unterminated expression in a template literal.");
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
			const escaped = readEscape(source, index);
			text += escaped.value;
			index += escaped.length;
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
	throw new TemplaterError("Unterminated template literal.");
}

function readRegex(source: string, start: number): { pattern: string; flags: string; end: number } {
	let index = start + 1;
	let inClass = false;
	while (index < source.length) {
		const char = source[index] ?? "";
		if (char === "\n") break;
		if (char === "\\") {
			index += 2;
			continue;
		}
		if (char === "[") inClass = true;
		else if (char === "]") inClass = false;
		else if (char === "/" && !inClass) {
			const flags = /^[dgimsuy]*/.exec(source.slice(index + 1))?.[0] ?? "";
			return { pattern: source.slice(start + 1, index), flags, end: index + 1 + flags.length };
		}
		index += 1;
	}
	throw new TemplaterError("Unterminated regular expression.");
}

/** Whether a `/` after `previous` starts a regex rather than dividing. */
function regexAllowedAfter(previous: Token | undefined): boolean {
	if (!previous) return true;
	if (previous.type === "punct") return ![")", "]", "}"].includes(previous.value);
	if (previous.type === "identifier") {
		return ["return", "typeof", "await", "else", "of"].includes(previous.value);
	}
	return previous.type !== "number" && previous.type !== "string" && previous.type !== "template";
}

function tokenize(source: string, origin?: string): Token[] {
	const tokens: Token[] = [];
	let index = 0;
	let newlineBefore = true;
	const push = (token: Omit<Token, "newlineBefore" | "origin">) => {
		tokens.push({ ...token, newlineBefore, origin });
		newlineBefore = false;
	};
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
			if (end < 0) throw new TemplaterError("Unterminated comment.");
			if (source.slice(index, end).includes("\n")) newlineBefore = true;
			index = end + 2;
			continue;
		}
		const pos = index;
		if (char === '"' || char === "'") {
			const { value, end } = readString(source, index);
			push({ type: "string", value, pos });
			index = end;
		} else if (char === "`") {
			const { quasis, expressions, end } = readTemplate(source, index);
			push({ type: "template", value: "", quasis, expressions, pos });
			index = end;
		} else if (char === "/" && regexAllowedAfter(tokens[tokens.length - 1])) {
			const { pattern, flags, end } = readRegex(source, index);
			try {
				compileSafeRegex(pattern, flags);
			} catch (error) {
				throw new TemplaterError(
					error instanceof UnsafeRegexError
						? error.message
						: `Invalid regular expression /${pattern}/: ${messageOf(error)}`,
				);
			}
			push({ type: "regex", value: pattern, flags, pos });
			index = end;
		} else if (/\d/.test(char) || (char === "." && /\d/.test(source[index + 1] ?? ""))) {
			const match = /^(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(
				source.slice(index),
			);
			const text = match?.[0] ?? char;
			push({ type: "number", value: text, pos });
			index += text.length;
		} else if (IDENTIFIER_START.test(char)) {
			let end = index + 1;
			while (end < source.length && IDENTIFIER_PART.test(source[end] ?? "")) end += 1;
			const name = source.slice(index, end);
			const previous = tokens[tokens.length - 1];
			// After a dot the name is a property (`tp.app`, `tp.frontmatter.module`):
			// property reads have their own guard, `FORBIDDEN_PROPERTIES`.
			const isProperty =
				previous?.type === "punct" && (previous.value === "." || previous.value === "?.");
			if (FORBIDDEN_IDENTIFIERS.has(name) && !(isProperty && !FORBIDDEN_PROPERTIES.has(name))) {
				throw new TemplaterError(
					name === "app"
						? "The Obsidian `app` object does not exist on a static site."
						: `\`${name}\` is not available to templates.`,
				);
			}
			push({ type: "identifier", value: name, pos });
			index = end;
		} else {
			const punct = PUNCTUATORS.find((candidate) => source.startsWith(candidate, index));
			if (!punct) throw new TemplaterError(`Unexpected character "${char}".`);
			push({ type: "punct", value: punct, pos });
			index += punct.length;
		}
	}
	return tokens;
}

// ---------------------------------------------------------------------------
// Syntax tree
// ---------------------------------------------------------------------------

type Pattern = string | string[];

type Expr =
	| { k: "literal"; value: unknown }
	| { k: "regex"; pattern: string; flags: string }
	| { k: "template"; quasis: string[]; expressions: Expr[] }
	| { k: "identifier"; name: string }
	| { k: "array"; items: Expr[] }
	| { k: "object"; props: Array<[string, Expr]> }
	| { k: "member"; object: Expr; property: string; optional: boolean }
	| { k: "index"; object: Expr; index: Expr; optional: boolean }
	| { k: "call"; callee: Expr; args: Expr[]; optional: boolean }
	| { k: "new"; callee: string; args: Expr[] }
	| { k: "unary"; op: string; argument: Expr }
	| { k: "binary"; op: string; left: Expr; right: Expr }
	| { k: "conditional"; test: Expr; then: Expr; otherwise: Expr }
	| { k: "arrow"; params: string[]; body: Expr | Stmt[] }
	| { k: "assign"; op: string; target: string; value: Expr }
	| { k: "update"; op: "++" | "--"; prefix: boolean; target: string };

type Stmt = { origin?: string } & (
	| { k: "declare"; constant: boolean; pattern: Pattern; init?: Expr }
	| { k: "expression"; expr: Expr }
	| { k: "if"; test: Expr; then: Stmt; otherwise?: Stmt }
	| { k: "forOf"; pattern: Pattern; iterable: Expr; body: Stmt }
	| { k: "block"; body: Stmt[] }
	| { k: "return"; value?: Expr }
	| { k: "empty" }
	/** Template text between commands. */
	| { k: "emit"; text: string }
	/** A `<% expr %>` command; `error` when its expression does not parse. */
	| { k: "output"; expr?: Expr; error?: string }
);

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
	"**": 8,
};

const ASSIGNMENT_OPERATORS: Record<string, true> = {
	"=": true,
	"+=": true,
	"-=": true,
	"*=": true,
	"/=": true,
	"%=": true,
};

const EOF: Token = { type: "eof", value: "", pos: 0, newlineBefore: true };

class Parser {
	private cursor = 0;

	constructor(private readonly tokens: Token[]) {}

	private peek(offset = 0): Token {
		return this.tokens[this.cursor + offset] ?? EOF;
	}

	private next(): Token {
		const token = this.peek();
		// Past the end too, so a caller stepping back (`cursor -= 1`) lands on the token it read.
		this.cursor += 1;
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
		const found =
			token.type === "eof"
				? "the end of the template"
				: token.type === "text" || token.type === "output"
					? "template text"
					: `"${token.value || "`…`"}"`;
		// At the end, the command that was left open is the one to name.
		const origin =
			token.origin ?? this.tokens[Math.min(this.cursor, this.tokens.length) - 1]?.origin;
		throw new TemplaterError(
			`Unsupported syntax: ${found}${detail ? ` (${detail})` : ""}${origin ? ` in \`${origin}\`` : ""}.`,
		);
	}

	program(): Stmt[] {
		const body: Stmt[] = [];
		while (this.peek().type !== "eof") body.push(this.statement());
		return body;
	}

	expressionOnly(): Expr {
		const expr = this.expression();
		if (this.is(";")) this.next();
		if (this.peek().type !== "eof") this.unexpected("expected a single expression");
		return expr;
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
		const statement = this.statementBody(token);
		return token.origin ? { ...statement, origin: token.origin } : statement;
	}

	private statementBody(token: Token): Stmt {
		if (token.type === "text") {
			this.next();
			return { k: "emit", text: token.value };
		}
		if (token.type === "output") {
			this.next();
			return { k: "output", expr: token.expr, error: token.error };
		}
		if (this.is(";")) {
			this.next();
			return { k: "empty" };
		}
		if (this.is("{")) return this.block();
		if (token.type === "identifier") {
			if (token.value === "const" || token.value === "let") {
				this.next();
				const pattern = this.pattern();
				let init: Expr | undefined;
				if (this.is("=")) {
					this.next();
					init = this.expression();
				} else if (token.value === "const" || Array.isArray(pattern)) {
					this.unexpected("a declaration needs a value");
				}
				this.endStatement();
				return { k: "declare", constant: token.value === "const", pattern, init };
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
				if (this.is("const") || this.is("let")) this.next();
				const pattern = this.pattern();
				if (!this.is("of")) this.unexpected("only for (… of …) loops are supported");
				this.next();
				const iterable = this.expression();
				this.expect(")");
				return { k: "forOf", pattern, iterable, body: this.statement() };
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
		if (token.type !== "identifier" || Object.hasOwn(RESERVED_NAMES, token.value)) {
			this.cursor -= 1;
			this.unexpected("expected a name");
		}
		return token.value;
	}

	/** A binding: a name, or an array pattern of names (`[key, value]`). */
	private pattern(): Pattern {
		if (!this.is("[")) return this.identifierName();
		this.next();
		const names: string[] = [];
		while (!this.is("]")) {
			names.push(this.identifierName());
			if (this.is(",")) this.next();
			else if (!this.is("]")) this.unexpected('expected "," or "]"');
		}
		this.next();
		return names;
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
			Object.hasOwn(ASSIGNMENT_OPERATORS, operator.value)
		) {
			const target = this.identifierName();
			this.next();
			return { k: "assign", op: operator.value, target, value: this.assignment() };
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
			!Object.hasOwn(RESERVED_NAMES, token.value)
		) {
			this.next();
			this.next();
			return { k: "arrow", params: [token.value], body: this.arrowBody() };
		}
		if (token.type === "identifier" && token.value === "async") {
			// `async` changes nothing here: every call is awaited already.
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
			if (param.type !== "identifier" || Object.hasOwn(RESERVED_NAMES, param.value)) {
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
			if (["&", "|", "^", "~"].includes(token.value)) {
				this.unexpected(`the ${token.value} operator is not supported`);
			}
			const precedence = BINARY_PRECEDENCE[token.value];
			if (precedence === undefined || precedence < minimum) return left;
			this.next();
			// `**` is right-associative; every other operator here is left-associative.
			const right = this.binary(token.value === "**" ? precedence : precedence + 1);
			left = { k: "binary", op: token.value, left, right };
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
		if (token.type === "punct" && (token.value === "++" || token.value === "--")) {
			this.next();
			return { k: "update", op: token.value, prefix: true, target: this.identifierName() };
		}
		if (token.type === "identifier" && (token.value === "typeof" || token.value === "await")) {
			this.next();
			return { k: "unary", op: token.value, argument: this.unary() };
		}
		if (token.type === "identifier" && token.value === "new") {
			this.next();
			const callee = this.identifierName();
			if (callee !== "Date") this.unexpected("only `new Date(…)` is supported");
			let args: Expr[] = [];
			if (this.is("(")) {
				this.next();
				args = this.callArguments();
			}
			return this.postfix({ k: "new", callee, args });
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
			} else if (this.is("[") && !this.peek().newlineBefore) {
				this.next();
				const index = this.expression();
				this.expect("]");
				expr = { k: "index", object: expr, index, optional: false };
			} else if (this.is("(") && !this.peek().newlineBefore) {
				this.next();
				expr = { k: "call", callee: expr, args: this.callArguments(), optional: false };
			} else if ((this.is("++") || this.is("--")) && !this.peek().newlineBefore) {
				if (expr.k !== "identifier") this.unexpected("only a variable can be incremented");
				const op = this.next().value === "++" ? "++" : "--";
				return { k: "update", op, prefix: false, target: expr.name };
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
			case "regex":
				return { k: "regex", pattern: token.value, flags: token.flags ?? "" };
			case "template":
				return {
					k: "template",
					quasis: token.quasis ?? [],
					expressions: (token.expressions ?? []).map((source) =>
						new Parser(tokenize(source, token.origin)).expressionOnly(),
					),
				};
			case "identifier": {
				const name = token.value;
				if (name === "true") return { k: "literal", value: true };
				if (name === "false") return { k: "literal", value: false };
				if (name === "null") return { k: "literal", value: null };
				if (name === "undefined") return { k: "literal", value: undefined };
				if (Object.hasOwn(RESERVED_NAMES, name)) {
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
						if (FORBIDDEN_PROPERTIES.has(key.value)) {
							throw new TemplaterError(`\`${key.value}\` is not available to templates.`);
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

// ---------------------------------------------------------------------------
// Program assembly
// ---------------------------------------------------------------------------

/** One piece of a template, in order: text, an output command, or statements. */
export type TemplateChunk =
	| { kind: "text"; value: string }
	| { kind: "output"; code: string; raw: string }
	| { kind: "exec"; code: string; raw: string };

/** A template compiled to statements, ready to run. */
export interface TemplateProgram {
	statements: Stmt[];
}

/**
 * Compile a template's chunks into one program, as Templater does: an output
 * command stands alone (a syntax error in it is local to it), while
 * execution commands are read together, so `<%* if (x) { %>…<%* } %>` is one
 * `if`. Throws {@link TemplaterError} when the statements do not parse.
 */
export function compileTemplate(chunks: readonly TemplateChunk[]): TemplateProgram {
	const tokens: Token[] = [];
	for (const chunk of chunks) {
		if (chunk.kind === "text") {
			tokens.push({ type: "text", value: chunk.value, pos: 0, newlineBefore: true });
		} else if (chunk.kind === "output") {
			const token: Token = {
				type: "output",
				value: "",
				pos: 0,
				newlineBefore: true,
				origin: chunk.raw,
			};
			try {
				token.expr = new Parser(tokenize(chunk.code, chunk.raw)).expressionOnly();
			} catch (error) {
				token.error = isStackOverflow(error) ? STACK_OVERFLOW_MESSAGE : messageOf(error);
			}
			tokens.push(token);
		} else {
			const own = tokenize(chunk.code, chunk.raw);
			const first = own[0];
			if (first) first.newlineBefore = true;
			tokens.push(...own);
		}
	}
	return { statements: new Parser(tokens).program() };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

class Scope {
	private readonly values = new Map<string, { value: unknown; constant: boolean }>();

	constructor(private readonly parent?: Scope) {}

	declare(name: string, value: unknown, constant: boolean): void {
		if (this.values.has(name)) throw new TemplaterError(`"${name}" is already declared.`);
		this.values.set(name, { value, constant });
	}

	lookup(name: string): { value: unknown; constant: boolean } | undefined {
		return this.values.get(name) ?? this.parent?.lookup(name);
	}

	assign(name: string, value: unknown): void {
		const binding = this.values.get(name);
		if (binding) {
			if (binding.constant) throw new TemplaterError(`Cannot assign to the constant "${name}".`);
			binding.value = value;
			return;
		}
		if (!this.parent) throw new TemplaterError(`"${name}" is not declared.`);
		this.parent.assign(name, value);
	}
}

class ReturnSignal {
	constructor(readonly value: unknown) {}
}

/** Raised when a program runs away; never caught by a statement, so it ends the run. */
class BudgetExceeded extends TemplaterError {}

const MAX_CALL_DEPTH = 200;
const MAX_STEPS = 1_000_000;

/** How far a run has gone: steps taken (and what they built), and the arrow-function call depth. */
export interface RunBudget {
	steps: number;
	depth: number;
}

/** What a program runs against. */
export interface ProgramRuntime {
	/** Names visible to the program besides its own variables (`tp`, `moment`). */
	globals: Record<string, unknown>;
	/** The clock `new Date()` reads. */
	now: Date;
	/**
	 * A command failed: report it and return what replaces it in the output
	 * (the in-place error marker).
	 */
	onError(message: string, command: string): string;
	/**
	 * Shared by a template and every template it includes, so a loop of
	 * includes cannot multiply the budget; a fresh one by default.
	 */
	budget?: RunBudget;
}

interface Runtime extends ProgramRuntime {
	budget: RunBudget;
}

/** The output variable every template program writes to. */
const OUTPUT = "tR";

/**
 * Run a compiled template and return what it wrote to `tR`. A failing
 * command is replaced by `onError`'s marker and the run goes on with the
 * next statement, the way the rest of a note still renders around one bad
 * command.
 */
export async function runTemplate(
	program: TemplateProgram,
	runtime: ProgramRuntime,
): Promise<string> {
	const clock = runtime.now;
	const rt: Runtime = {
		...runtime,
		globals: {
			Date: new HostObject("Date", {
				now: new HostFunction("Date.now", () => clock.getTime()),
			}),
			...runtime.globals,
		},
		budget: runtime.budget ?? { steps: 0, depth: 0 },
	};
	const scope = new Scope();
	scope.declare(OUTPUT, "", false);
	try {
		await run(program.statements, scope, rt);
	} catch (signal) {
		if (signal instanceof ReturnSignal) {
			return signal.value === undefined ? outputOf(scope) : toTemplateString(signal.value);
		}
		if (!(signal instanceof BudgetExceeded)) throw signal;
		append(scope, rt.onError(signal.message, ""));
	}
	return outputOf(scope);
}

function outputOf(scope: Scope): string {
	return toTemplateString(scope.lookup(OUTPUT)?.value ?? "");
}

function append(scope: Scope, text: string): void {
	scope.assign(OUTPUT, concatTexts(toTemplateString(scope.lookup(OUTPUT)?.value ?? ""), text));
}

/** Count `units` of work (a step, or what an operation built) against the run's budget. */
function step(rt: Runtime, units = 1): void {
	rt.budget.steps += units;
	if (rt.budget.steps > MAX_STEPS) {
		throw new BudgetExceeded(`The template ran more than ${MAX_STEPS} steps and was stopped.`);
	}
}

async function run(statements: Stmt[], scope: Scope, rt: Runtime): Promise<void> {
	for (const statement of statements) {
		if (!statement.origin) {
			await execute(statement, scope, rt);
			continue;
		}
		try {
			await execute(statement, scope, rt);
		} catch (error) {
			if (error instanceof ReturnSignal || error instanceof BudgetExceeded) throw error;
			const message = isStackOverflow(error) ? STACK_OVERFLOW_MESSAGE : messageOf(error);
			append(scope, rt.onError(message, statement.origin));
		}
	}
}

function bind(scope: Scope, pattern: Pattern, value: unknown, constant: boolean): void {
	if (typeof pattern === "string") {
		scope.declare(pattern, value, constant);
		return;
	}
	if (!Array.isArray(value)) throw new TemplaterError("Only an array can be destructured.");
	pattern.forEach((name, position) => {
		scope.declare(name, value[position], constant);
	});
}

async function execute(statement: Stmt, scope: Scope, rt: Runtime): Promise<void> {
	step(rt);
	switch (statement.k) {
		case "empty":
			return;
		case "emit":
			append(scope, statement.text);
			return;
		case "output":
			if (statement.error !== undefined) throw new TemplaterError(statement.error);
			if (statement.expr) {
				append(scope, toTemplateString(await evaluate(statement.expr, scope, rt)));
			}
			return;
		case "declare":
			bind(
				scope,
				statement.pattern,
				statement.init ? await evaluate(statement.init, scope, rt) : undefined,
				statement.constant,
			);
			return;
		case "expression":
			await evaluate(statement.expr, scope, rt);
			return;
		case "if":
			if (await evaluate(statement.test, scope, rt)) {
				await run([statement.then], new Scope(scope), rt);
			} else if (statement.otherwise) {
				await run([statement.otherwise], new Scope(scope), rt);
			}
			return;
		case "forOf": {
			const iterable = await evaluate(statement.iterable, scope, rt);
			const items = typeof iterable === "string" ? [...iterable] : iterable;
			if (!Array.isArray(items)) throw new TemplaterError("for (… of …) needs an array.");
			// A snapshot: a loop that pushes onto its own array still ends.
			for (const item of [...items]) {
				const inner = new Scope(scope);
				bind(inner, statement.pattern, item, false);
				await run([statement.body], inner, rt);
			}
			return;
		}
		case "block":
			await run(statement.body, new Scope(scope), rt);
			return;
		case "return":
			throw new ReturnSignal(
				statement.value ? await evaluate(statement.value, scope, rt) : undefined,
			);
	}
}

function makeFunction(
	params: string[],
	body: Expr | Stmt[],
	scope: Scope,
	rt: Runtime,
): HostFunction {
	return new HostFunction("function", async (args) => {
		if (rt.budget.depth >= MAX_CALL_DEPTH) throw new BudgetExceeded("Too much recursion.");
		rt.budget.depth += 1;
		try {
			const inner = new Scope(scope);
			params.forEach((name, position) => {
				inner.declare(name, args[position], false);
			});
			if (!Array.isArray(body)) return await evaluate(body, inner, rt);
			try {
				await run(body, inner, rt);
			} catch (signal) {
				if (signal instanceof ReturnSignal) return signal.value;
				throw signal;
			}
			return undefined;
		} finally {
			rt.budget.depth -= 1;
		}
	});
}

/** Call a function value the program holds (a callback, a host function). */
export async function invoke(fn: unknown, args: unknown[]): Promise<unknown> {
	if (!(fn instanceof HostFunction)) {
		throw new TemplaterError(`Expected a function, got ${describe(fn)}.`);
	}
	return await fn.call(args);
}

async function evaluate(expr: Expr, scope: Scope, rt: Runtime): Promise<unknown> {
	step(rt);
	switch (expr.k) {
		case "literal":
			return expr.value;
		case "regex":
			return new RegExp(expr.pattern, expr.flags);
		case "template": {
			let text = expr.quasis[0] ?? "";
			for (const [position, part] of expr.expressions.entries()) {
				text = concatTexts(
					text,
					toTemplateString(await evaluate(part, scope, rt)) + (expr.quasis[position + 1] ?? ""),
				);
			}
			return text;
		}
		case "identifier": {
			const binding = scope.lookup(expr.name);
			if (binding) return binding.value;
			if (Object.hasOwn(rt.globals, expr.name)) return rt.globals[expr.name];
			if (Object.hasOwn(BUILTINS, expr.name)) return BUILTINS[expr.name];
			throw new TemplaterError(`"${expr.name}" is not defined.`);
		}
		case "array": {
			const items: unknown[] = [];
			for (const item of expr.items) items.push(await evaluate(item, scope, rt));
			return items;
		}
		case "object": {
			const entries: Array<[string, unknown]> = [];
			for (const [key, value] of expr.props) entries.push([key, await evaluate(value, scope, rt)]);
			return Object.fromEntries(entries);
		}
		case "member": {
			const object = await evaluate(expr.object, scope, rt);
			if (expr.optional && object == null) return undefined;
			return readProperty(object, expr.property);
		}
		case "index": {
			const object = await evaluate(expr.object, scope, rt);
			if (expr.optional && object == null) return undefined;
			const index = await evaluate(expr.index, scope, rt);
			if (typeof index !== "string" && typeof index !== "number") {
				throw new TemplaterError("An index must be a string or a number.");
			}
			return readProperty(object, String(index));
		}
		case "call":
			return await callExpression(expr, scope, rt);
		case "new": {
			const args: unknown[] = [];
			for (const arg of expr.args) args.push(await evaluate(arg, scope, rt));
			return constructDate(args, rt);
		}
		case "unary": {
			const value = await evaluate(expr.argument, scope, rt);
			switch (expr.op) {
				case "!":
					return !value;
				case "-":
					return -toNumber(value);
				case "+":
					return toNumber(value);
				case "await":
					return value;
				default:
					return value instanceof HostFunction
						? "function"
						: value === null || typeof value === "object"
							? "object"
							: typeof value;
			}
		}
		case "binary": {
			if (expr.op === "&&") {
				const left = await evaluate(expr.left, scope, rt);
				return left ? await evaluate(expr.right, scope, rt) : left;
			}
			if (expr.op === "||") {
				const left = await evaluate(expr.left, scope, rt);
				return left ? left : await evaluate(expr.right, scope, rt);
			}
			if (expr.op === "??") {
				const left = await evaluate(expr.left, scope, rt);
				return left ?? (await evaluate(expr.right, scope, rt));
			}
			return binary(
				expr.op,
				await evaluate(expr.left, scope, rt),
				await evaluate(expr.right, scope, rt),
			);
		}
		case "conditional":
			return (await evaluate(expr.test, scope, rt))
				? await evaluate(expr.then, scope, rt)
				: await evaluate(expr.otherwise, scope, rt);
		case "arrow":
			return makeFunction(expr.params, expr.body, scope, rt);
		case "assign": {
			const binding = scope.lookup(expr.target);
			if (!binding) throw new TemplaterError(`"${expr.target}" is not declared.`);
			const value = await evaluate(expr.value, scope, rt);
			const next = expr.op === "=" ? value : binary(expr.op.slice(0, -1), binding.value, value);
			scope.assign(expr.target, next);
			return next;
		}
		case "update": {
			const binding = scope.lookup(expr.target);
			if (!binding) throw new TemplaterError(`"${expr.target}" is not declared.`);
			const previous = toNumber(binding.value);
			const next = expr.op === "++" ? previous + 1 : previous - 1;
			scope.assign(expr.target, next);
			return expr.prefix ? next : previous;
		}
	}
}

async function callExpression(
	expr: Extract<Expr, { k: "call" }>,
	scope: Scope,
	rt: Runtime,
): Promise<unknown> {
	const callee = expr.callee;
	if (callee.k === "member" || callee.k === "index") {
		const receiver = await evaluate(callee.object, scope, rt);
		if (callee.optional && receiver == null) return undefined;
		const name =
			callee.k === "member" ? callee.property : String(await evaluate(callee.index, scope, rt));
		const args: unknown[] = [];
		for (const arg of expr.args) args.push(await evaluate(arg, scope, rt));
		if (expr.optional && readProperty(receiver, name) == null && !hasMethod(receiver, name)) {
			return undefined;
		}
		return built(await callMethod(receiver, name, args), receiver, rt);
	}
	const fn = await evaluate(callee, scope, rt);
	if (expr.optional && fn == null) return undefined;
	const args: unknown[] = [];
	for (const arg of expr.args) args.push(await evaluate(arg, scope, rt));
	if (!(fn instanceof HostFunction)) {
		throw new TemplaterError(`${calleeName(callee)} is not a function.`);
	}
	return built(await fn.call(args), undefined, rt);
}

/** A call's result, checked against the size limits and charged for what it built beyond `input`. */
function built(result: unknown, input: unknown, rt: Runtime): unknown {
	checkSize(result);
	step(rt, growthCost(result, input, MAX_STEPS - rt.budget.steps + 1));
	return result;
}

function calleeName(expr: Expr): string {
	if (expr.k === "identifier") return expr.name;
	if (expr.k === "member") return `${calleeName(expr.object)}.${expr.property}`;
	return "The expression";
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** `String(value)`, the way a command's value lands in the note. */
export function toTemplateString(value: unknown): string {
	if (value === null || value === undefined || typeof value !== "object") {
		return value instanceof HostFunction ? "function" : String(value);
	}
	if (value instanceof HostFunction) return "function";
	if (Array.isArray(value)) {
		return joinTexts(value, ",", (item) => (item == null ? "" : toTemplateString(item)));
	}
	if (value instanceof HostValue) return value.toTemplateString();
	if (value instanceof Date) return value.toString();
	if (value instanceof RegExp) return value.toString();
	return "[object Object]";
}

/**
 * A primitive standing for `value` in arithmetic and comparison: a date's or
 * moment's timestamp, else the value's display string.
 */
function toPrimitive(value: unknown): unknown {
	if (value === null || typeof value !== "object") return value;
	if (value instanceof Date) return value.getTime();
	if (value instanceof HostValue) {
		const primitive = value.primitive();
		if (primitive !== undefined) return primitive;
	}
	return toTemplateString(value);
}

function toNumber(value: unknown): number {
	return Number(toPrimitive(value));
}

function binary(op: string, left: unknown, right: unknown): unknown {
	if (op === "===" || op === "!==") {
		const same =
			typeof left === "object" && left !== null
				? left === right
				: Object.is(left, right) || left === right;
		return op === "===" ? same : !same;
	}
	if (op === "==" || op === "!=") {
		const objects =
			typeof left === "object" && left !== null && typeof right === "object" && right !== null;
		// JavaScript's loose equality over primitives is side-effect free.
		// biome-ignore lint/suspicious/noDoubleEquals: `==` is the operator being interpreted.
		const same = objects ? left === right : toPrimitive(left) == toPrimitive(right);
		return op === "==" ? same : !same;
	}
	if (op === "+") {
		const a = typeof left === "object" && left !== null ? toTemplateString(left) : left;
		const b = typeof right === "object" && right !== null ? toTemplateString(right) : right;
		if (typeof a === "string" || typeof b === "string") {
			return concatTexts(toTemplateString(a), toTemplateString(b));
		}
		return Number(a) + Number(b);
	}
	const a = toPrimitive(left);
	const b = toPrimitive(right);
	switch (op) {
		case "<":
			return (a as number) < (b as number);
		case ">":
			return (a as number) > (b as number);
		case "<=":
			return (a as number) <= (b as number);
		case ">=":
			return (a as number) >= (b as number);
		case "-":
			return Number(a) - Number(b);
		case "*":
			return Number(a) * Number(b);
		case "/":
			return Number(a) / Number(b);
		case "%":
			return Number(a) % Number(b);
		default:
			return Number(a) ** Number(b);
	}
}

function describe(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (Array.isArray(value)) return "an array";
	if (value instanceof Date) return "a date";
	if (value instanceof HostValue) return value.label;
	return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/** A value's own field — never an inherited one, so prototypes are unreachable. */
function readProperty(value: unknown, property: string): unknown {
	if (FORBIDDEN_PROPERTIES.has(property)) {
		throw new TemplaterError(`\`${property}\` is not available to templates.`);
	}
	if (value === null || value === undefined) {
		throw new TemplaterError(`Cannot read "${property}" of ${value}.`);
	}
	if (Array.isArray(value) || typeof value === "string") {
		if (property === "length") return value.length;
		return /^\d+$/.test(property) ? value[Number(property)] : undefined;
	}
	if (value instanceof HostValue) return value.property(property);
	if (value instanceof RegExp) {
		if (property === "source") return value.source;
		if (property === "flags") return value.flags;
		return undefined;
	}
	if (isPlainObject(value)) {
		return Object.hasOwn(value, property) &&
			Object.prototype.propertyIsEnumerable.call(value, property)
			? value[property]
			: undefined;
	}
	return undefined;
}

function hasMethod(receiver: unknown, name: string): boolean {
	if (receiver === null || receiver === undefined) return false;
	return (
		typeof receiver === "string" ||
		Array.isArray(receiver) ||
		typeof receiver === "number" ||
		receiver instanceof Date ||
		receiver instanceof RegExp ||
		(receiver instanceof HostValue && receiver.property(name) !== undefined)
	);
}

async function callMethod(receiver: unknown, name: string, args: unknown[]): Promise<unknown> {
	if (FORBIDDEN_PROPERTIES.has(name)) {
		throw new TemplaterError(`\`${name}\` is not available to templates.`);
	}
	if (receiver instanceof HostValue) return await receiver.method(name, args);
	if (Array.isArray(receiver)) return await callArrayMethod(receiver, name, args);
	if (typeof receiver === "string") return await callStringMethod(receiver, name, args);
	if (typeof receiver === "number") {
		if (name === "toFixed") {
			return receiver.toFixed(Math.max(0, Math.min(100, Number(args[0] ?? 0) || 0)));
		}
		if (name === "toPrecision" && args[0] !== undefined) {
			return receiver.toPrecision(Math.max(1, Math.min(100, Number(args[0]))));
		}
		if (name === "toString") {
			const radix = Number(args[0] ?? 10);
			return receiver.toString(radix >= 2 && radix <= 36 ? radix : 10);
		}
	}
	if (typeof receiver === "boolean" && name === "toString") return String(receiver);
	if (receiver instanceof Date) return callDateMethod(receiver, name);
	if (receiver instanceof RegExp) {
		if (name === "test") {
			receiver.lastIndex = 0;
			return receiver.test(toTemplateString(args[0]));
		}
		if (name === "toString") return receiver.toString();
	}
	if (isPlainObject(receiver)) {
		const member = readProperty(receiver, name);
		if (member instanceof HostFunction) return await member.call(args);
	}
	throw new TemplaterError(`Unsupported method: ${name}() on ${describe(receiver)}.`);
}

function callDateMethod(date: Date, name: string): unknown {
	switch (name) {
		case "getFullYear":
			return date.getFullYear();
		case "getMonth":
			return date.getMonth();
		case "getDate":
			return date.getDate();
		case "getDay":
			return date.getDay();
		case "getHours":
			return date.getHours();
		case "getMinutes":
			return date.getMinutes();
		case "getSeconds":
			return date.getSeconds();
		case "getMilliseconds":
			return date.getMilliseconds();
		case "getTime":
		case "valueOf":
			return date.getTime();
		case "toISOString":
		case "toJSON":
			return date.toISOString();
		case "toDateString":
			return date.toDateString();
		case "toTimeString":
			return date.toTimeString();
		case "toString":
			return date.toString();
	}
	throw new TemplaterError(`Unsupported method: ${name}() on a date.`);
}

async function replaceWith(
	text: string,
	pattern: unknown,
	replacement: unknown,
	all: boolean,
): Promise<string> {
	if (!(replacement instanceof HostFunction)) {
		const substitute = toTemplateString(replacement);
		if (pattern instanceof RegExp) {
			if (all && !pattern.global) throw new TemplaterError("replaceAll() needs a global regex.");
			return replaceText(text, pattern, substitute, false);
		}
		return replaceText(text, toTemplateString(pattern), substitute, all);
	}
	// A replacer callback: collect the matches, then call it for each in turn.
	const regex =
		pattern instanceof RegExp
			? new RegExp(pattern.source, all ? `${pattern.flags.replace("g", "")}g` : pattern.flags)
			: undefined;
	const matches: Array<{ index: number; groups: string[] }> = [];
	if (regex) {
		if (regex.global) {
			for (const match of text.matchAll(regex)) {
				matches.push({ index: match.index, groups: [...match].map((part) => part ?? "") });
			}
		} else {
			const match = regex.exec(text);
			if (match) matches.push({ index: match.index, groups: [...match].map((part) => part ?? "") });
		}
	} else {
		const search = toTemplateString(pattern);
		let from = text.indexOf(search);
		while (from >= 0) {
			matches.push({ index: from, groups: [search] });
			if (!all) break;
			from = text.indexOf(search, from + Math.max(1, search.length));
		}
	}
	let result = "";
	let cursor = 0;
	for (const match of matches) {
		const whole = match.groups[0] ?? "";
		result = concatTexts(result, text.slice(cursor, match.index));
		result = concatTexts(
			result,
			toTemplateString(await replacement.call([...match.groups, match.index, text])),
		);
		cursor = match.index + whole.length;
	}
	return result + text.slice(cursor);
}

async function callStringMethod(text: string, name: string, args: unknown[]): Promise<unknown> {
	const arg = (position: number) => toTemplateString(args[position] ?? "");
	const optionalNumber = (position: number) =>
		args[position] === undefined ? undefined : Number(args[position]);
	switch (name) {
		case "toUpperCase":
		case "toLocaleUpperCase":
			return text.toUpperCase();
		case "toLowerCase":
		case "toLocaleLowerCase":
			return text.toLowerCase();
		case "trim":
			return text.trim();
		case "trimStart":
			return text.trimStart();
		case "trimEnd":
			return text.trimEnd();
		case "includes":
		case "contains":
			return text.includes(arg(0));
		case "startsWith":
			return text.startsWith(arg(0), optionalNumber(1));
		case "endsWith":
			return text.endsWith(arg(0), optionalNumber(1));
		case "indexOf":
			return text.indexOf(arg(0), optionalNumber(1));
		case "lastIndexOf":
			return text.lastIndexOf(arg(0), optionalNumber(1));
		case "slice":
			return text.slice(Number(args[0] ?? 0), optionalNumber(1));
		case "substring":
			return text.substring(Number(args[0] ?? 0), optionalNumber(1));
		case "at":
			return text.at(Number(args[0] ?? 0));
		case "charAt":
			return text.charAt(Number(args[0] ?? 0));
		case "split": {
			const separator = args[0];
			if (separator === undefined) return [text];
			const limit = optionalNumber(1);
			return separator instanceof RegExp
				? text.split(separator, limit)
				: text.split(toTemplateString(separator), limit);
		}
		case "replace":
			return await replaceWith(text, args[0], args[1], false);
		case "replaceAll":
			return await replaceWith(text, args[0], args[1], true);
		case "match": {
			if (!(args[0] instanceof RegExp)) {
				throw new TemplaterError("match() needs a regular expression.");
			}
			const match = text.match(args[0]);
			return match ? [...match] : null;
		}
		case "search":
			return args[0] instanceof RegExp ? text.search(args[0]) : text.indexOf(arg(0));
		case "padStart":
			return padText(text, Number(args[0] ?? 0), args[1] === undefined ? " " : arg(1), false);
		case "padEnd":
			return padText(text, Number(args[0] ?? 0), args[1] === undefined ? " " : arg(1), true);
		case "repeat":
			return repeatText(text, Math.max(0, Number(args[0] ?? 0)));
		case "concat":
			return concatTexts(
				text,
				joinTexts(args, "", (value) => toTemplateString(value)),
			);
		case "localeCompare":
			return text.localeCompare(arg(0));
		case "normalize":
			return text.normalize();
		case "toString":
		case "valueOf":
			return text;
	}
	throw new TemplaterError(`Unsupported method: ${name}() on a string.`);
}

async function sortList(list: unknown[], compare: unknown): Promise<unknown[]> {
	if (compare === undefined) {
		return list.sort((left, right) => {
			const a = toTemplateString(left);
			const b = toTemplateString(right);
			return a < b ? -1 : a > b ? 1 : 0;
		});
	}
	// A merge sort, so the comparator can be awaited.
	const sorted = await mergeSort([...list], async (left, right) =>
		toNumber(await invoke(compare, [left, right])),
	);
	list.splice(0, list.length, ...sorted);
	return list;
}

async function mergeSort(
	list: unknown[],
	compare: (left: unknown, right: unknown) => Promise<number>,
): Promise<unknown[]> {
	if (list.length < 2) return list;
	const middle = Math.floor(list.length / 2);
	const left = await mergeSort(list.slice(0, middle), compare);
	const right = await mergeSort(list.slice(middle), compare);
	const merged: unknown[] = [];
	let i = 0;
	let j = 0;
	while (i < left.length && j < right.length) {
		if ((await compare(left[i], right[j])) <= 0) merged.push(left[i++]);
		else merged.push(right[j++]);
	}
	return merged.concat(left.slice(i), right.slice(j));
}

async function callArrayMethod(list: unknown[], name: string, args: unknown[]): Promise<unknown> {
	const fn = args[0];
	const each = async <T>(
		visit: (value: unknown, result: unknown, index: number) => T | undefined,
	): Promise<T | undefined> => {
		for (const [index, value] of list.entries()) {
			const outcome = visit(value, await invoke(fn, [value, index, list]), index);
			if (outcome !== undefined) return outcome;
		}
		return undefined;
	};
	switch (name) {
		case "map": {
			const mapped: unknown[] = [];
			for (const [index, value] of list.entries())
				mapped.push(await invoke(fn, [value, index, list]));
			return mapped;
		}
		case "filter": {
			const kept: unknown[] = [];
			for (const [index, value] of list.entries()) {
				if (await invoke(fn, [value, index, list])) kept.push(value);
			}
			return kept;
		}
		case "forEach":
			await each(() => undefined);
			return undefined;
		case "find":
			return (await each((value, result) => (result ? { value } : undefined)))?.value;
		case "findIndex":
			return (await each((_value, result, index) => (result ? { index } : undefined)))?.index ?? -1;
		case "some":
			return (await each((_value, result) => (result ? true : undefined))) ?? false;
		case "every":
			return !((await each((_value, result) => (result ? undefined : true))) ?? false);
		case "reduce": {
			let accumulator: unknown;
			let start = 0;
			if (args.length > 1) accumulator = args[1];
			else {
				if (list.length === 0)
					throw new TemplaterError("reduce() of an empty array needs a start value.");
				accumulator = list[0];
				start = 1;
			}
			for (let index = start; index < list.length; index += 1) {
				accumulator = await invoke(fn, [accumulator, list[index], index, list]);
			}
			return accumulator;
		}
		case "includes":
		case "contains":
			return list.some((value) => binary("===", value, args[0]));
		case "indexOf":
			return list.findIndex((value) => binary("===", value, args[0]));
		case "join":
			return joinTexts(list, args[0] === undefined ? "," : toTemplateString(args[0]), (value) =>
				value == null ? "" : toTemplateString(value),
			);
		case "slice":
			return list.slice(Number(args[0] ?? 0), args[1] === undefined ? undefined : Number(args[1]));
		case "concat":
			return concatLists([list, ...args.map((value) => (Array.isArray(value) ? value : [value]))]);
		case "reverse":
			return list.reverse();
		case "sort":
			return await sortList(list, fn);
		case "flat":
			return flatList(list, Math.max(0, Math.min(100, Number(args[0] ?? 1))));
		case "push":
			return list.push(...args);
		case "pop":
			return list.pop();
		case "shift":
			return list.shift();
		case "unshift":
			return list.unshift(...args);
		case "at":
			return list.at(Number(args[0] ?? 0));
		case "first":
			return list[0];
		case "last":
			return list[list.length - 1];
		case "unique":
			// A Set keeps first occurrences and compares as `===` does here (NaN equals NaN):
			// linear, where a pairwise scan of a long list would hang the build.
			return [...new Set(list)];
		case "toString":
			return toTemplateString(list);
	}
	throw new TemplaterError(`Unsupported method: ${name}() on an array.`);
}

// ---------------------------------------------------------------------------
// Built-in globals
// ---------------------------------------------------------------------------

/**
 * `new Date(…)`: the template's clock when called without arguments, so a
 * build with a pinned `now` is reproducible.
 */
function constructDate(args: unknown[], rt: Runtime): Date {
	if (args.length === 0) return new Date(rt.now.getTime());
	if (args.length === 1) {
		const value = args[0];
		if (value instanceof Date) return new Date(value.getTime());
		if (typeof value === "number" || typeof value === "string") return new Date(value);
		return new Date(toNumber(value));
	}
	const parts = args.map((value) => toNumber(value));
	return new Date(
		parts[0] ?? 0,
		parts[1] ?? 0,
		parts[2] ?? 1,
		parts[3] ?? 0,
		parts[4] ?? 0,
		parts[5] ?? 0,
		parts[6] ?? 0,
	);
}

const MATH_FUNCTIONS: Record<string, (...values: number[]) => number> = {
	round: Math.round,
	floor: Math.floor,
	ceil: Math.ceil,
	trunc: Math.trunc,
	abs: Math.abs,
	sign: Math.sign,
	sqrt: Math.sqrt,
	cbrt: Math.cbrt,
	pow: Math.pow,
	min: Math.min,
	max: Math.max,
	log: Math.log,
	log10: Math.log10,
	log2: Math.log2,
	exp: Math.exp,
	sin: Math.sin,
	cos: Math.cos,
	tan: Math.tan,
};

/**
 * Plain data for `JSON.stringify`: host values become their display string.
 * `seen` counts the values copied: lists that hold the same long list again
 * and again would otherwise copy into its square.
 */
function toJsonValue(value: unknown, seen = { values: 0 }): unknown {
	seen.values += 1;
	checkListLength(seen.values);
	if (value === null || typeof value !== "object") {
		return value instanceof HostFunction ? undefined : value;
	}
	if (Array.isArray(value)) return value.map((item) => toJsonValue(item, seen) ?? null);
	if (value instanceof Date) return value.toISOString();
	if (value instanceof HostFunction) return undefined;
	if (value instanceof HostValue) return value.toTemplateString();
	if (isPlainObject(value)) {
		return Object.fromEntries(
			Object.entries(value)
				.map(([key, item]) => [key, toJsonValue(item, seen)] as const)
				.filter(([, item]) => item !== undefined),
		);
	}
	return undefined;
}

function plainEntries(value: unknown): Array<[string, unknown]> {
	if (value instanceof HostObject) return value.keys().map((key) => [key, value.property(key)]);
	if (isPlainObject(value)) return Object.entries(value);
	if (Array.isArray(value)) return value.map((item, index) => [String(index), item]);
	throw new TemplaterError(`Expected an object, got ${describe(value)}.`);
}

const BUILTINS: Record<string, unknown> = {
	Math: new HostObject(
		"Math",
		{
			...Object.fromEntries(
				Object.entries(MATH_FUNCTIONS).map(([name, fn]) => [
					name,
					new HostFunction(`Math.${name}`, (args) => fn(...args.map((value) => toNumber(value)))),
				]),
			),
			PI: Math.PI,
			E: Math.E,
		},
		(name) =>
			name === "random"
				? new HostFunction("Math.random", () => {
						throw new TemplaterError(
							"Math.random() is not available: a published page must be the same on every build.",
						);
					})
				: undefined,
	),
	JSON: new HostObject("JSON", {
		stringify: new HostFunction("JSON.stringify", ([value, , indent]) =>
			JSON.stringify(
				toJsonValue(value),
				null,
				typeof indent === "number" || typeof indent === "string" ? indent : undefined,
			),
		),
		parse: new HostFunction("JSON.parse", ([text]) => {
			try {
				return JSON.parse(toTemplateString(text));
			} catch (error) {
				throw new TemplaterError(`JSON.parse: ${messageOf(error)}`);
			}
		}),
	}),
	Object: new HostObject("Object", {
		keys: new HostFunction("Object.keys", ([value]) => plainEntries(value).map(([key]) => key)),
		values: new HostFunction("Object.values", ([value]) =>
			plainEntries(value).map(([, item]) => item),
		),
		entries: new HostFunction("Object.entries", ([value]) =>
			plainEntries(value).map(([key, item]) => [key, item]),
		),
		fromEntries: new HostFunction("Object.fromEntries", ([value]) => {
			if (!Array.isArray(value)) throw new TemplaterError("Object.fromEntries() needs an array.");
			return Object.fromEntries(
				value.map((entry) => {
					const [key, item] = Array.isArray(entry) ? entry : [];
					const name = toTemplateString(key);
					if (FORBIDDEN_PROPERTIES.has(name)) {
						throw new TemplaterError(`\`${name}\` is not available to templates.`);
					}
					return [name, item];
				}),
			);
		}),
	}),
	Array: new HostObject("Array", {
		isArray: new HostFunction("Array.isArray", ([value]) => Array.isArray(value)),
	}),
	String: new HostFunction("String", ([value]) =>
		value === undefined ? "" : toTemplateString(value),
	),
	Number: new HostFunction("Number", ([value]) => toNumber(value ?? 0)),
	Boolean: new HostFunction("Boolean", ([value]) => Boolean(value)),
	parseInt: new HostFunction("parseInt", ([value, radix]) =>
		Number.parseInt(toTemplateString(value), radix === undefined ? undefined : Number(radix)),
	),
	parseFloat: new HostFunction("parseFloat", ([value]) =>
		Number.parseFloat(toTemplateString(value)),
	),
	isNaN: new HostFunction("isNaN", ([value]) => Number.isNaN(toNumber(value))),
	// Logging goes nowhere: a static build has no console to show it in.
	console: new HostObject("console", {}, (name) =>
		["log", "info", "warn", "error", "debug"].includes(name)
			? new HostFunction(`console.${name}`, () => undefined)
			: undefined,
	),
};

export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
