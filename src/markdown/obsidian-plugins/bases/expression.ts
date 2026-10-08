/**
 * The Bases formula and filter language, parsed into a tree the evaluator
 * interprets. Nothing here — or in the evaluator — ever hands text to `eval`,
 * `Function` or any other JavaScript entry point: the grammar is JavaScript's
 * expression subset Obsidian's parser accepts (literals, lists, regular
 * expressions, `!`/unary `-`, arithmetic, comparison, `&&`/`||`, member access,
 * indexing and calls) and nothing else.
 *
 * Where Obsidian's parser and its documentation differ, the parser wins: it
 * rejects object literals (`{"a": 1}`), unary `+`, and a method on a bare
 * number (`1.isTruthy()`; `(1).isTruthy()` is fine), so this one does too.
 */
import { assertSafeRegex, UnsafeRegexError } from "../../safe-regex.js";

export type Expr =
	| { kind: "literal"; value: null | boolean | number | string }
	| { kind: "regex"; source: string; flags: string }
	| { kind: "list"; items: Expr[] }
	| { kind: "identifier"; name: string }
	| { kind: "member"; object: Expr; name: string }
	| { kind: "index"; object: Expr; index: Expr }
	| { kind: "call"; callee: Expr; args: Expr[] }
	| { kind: "unary"; operator: "!" | "-"; operand: Expr }
	| { kind: "binary"; operator: BinaryOperator; left: Expr; right: Expr };

export type BinaryOperator =
	| "||"
	| "&&"
	| "=="
	| "!="
	| "<"
	| "<="
	| ">"
	| ">="
	| "+"
	| "-"
	| "*"
	| "/"
	| "%";

/** A formula that does not parse; the message names the position. */
export class ExpressionSyntaxError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ExpressionSyntaxError";
	}
}

type Token =
	| { type: "number"; value: number; at: number }
	| { type: "string"; value: string; at: number }
	| { type: "regex"; source: string; flags: string; at: number }
	| { type: "identifier"; value: string; at: number }
	| { type: "punct"; value: string; at: number }
	| { type: "end"; at: number };

/** Longest first, so `===` is not read as `==` then `=`. */
const PUNCTUATORS = [
	"===",
	"!==",
	"==",
	"!=",
	"<=",
	">=",
	"&&",
	"||",
	"<",
	">",
	"+",
	"-",
	"*",
	"/",
	"%",
	"!",
	"(",
	")",
	"[",
	"]",
	",",
	".",
];

/** JavaScript's strict operators mean what the loose ones do here: values carry their type. */
const OPERATOR_ALIASES: Record<string, string> = { "===": "==", "!==": "!=" };

const STRING_ESCAPES: Record<string, string> = {
	n: "\n",
	t: "\t",
	r: "\r",
	"0": "\0",
	b: "\b",
	f: "\f",
	v: "\v",
};

const IDENTIFIER_START = /[\p{L}_$]/u;
const IDENTIFIER_PART = /[\p{L}\p{N}\p{M}_$]/u;
const NUMBER = /(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/y;

/** Split a formula into tokens. A `/` starts a regular expression wherever an operand may start. */
function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let at = 0;
	const operandEnds = (): boolean => {
		const last = tokens.at(-1);
		if (!last) return false;
		if (last.type === "punct") return last.value === ")" || last.value === "]";
		return true;
	};
	while (at < source.length) {
		const char = source[at] ?? "";
		if (/\s/.test(char)) {
			at += 1;
			continue;
		}
		NUMBER.lastIndex = at;
		const number = /[\d.]/.test(char) ? NUMBER.exec(source) : null;
		if (number) {
			if (source[NUMBER.lastIndex] === ".") {
				throw new ExpressionSyntaxError(
					`A number cannot be followed by "." at position ${NUMBER.lastIndex + 1}; write (${number[0]}).name`,
				);
			}
			tokens.push({ type: "number", value: Number(number[0]), at });
			at = NUMBER.lastIndex;
			continue;
		}
		if (char === '"' || char === "'") {
			const [value, end] = readString(source, at);
			tokens.push({ type: "string", value, at });
			at = end;
			continue;
		}
		if (char === "/" && !operandEnds()) {
			const [pattern, flags, end] = readRegex(source, at);
			tokens.push({ type: "regex", source: pattern, flags, at });
			at = end;
			continue;
		}
		if (IDENTIFIER_START.test(char)) {
			let end = at + char.length;
			while (end < source.length && IDENTIFIER_PART.test(source[end] ?? "")) end += 1;
			tokens.push({ type: "identifier", value: source.slice(at, end), at });
			at = end;
			continue;
		}
		const punct = PUNCTUATORS.find((candidate) => source.startsWith(candidate, at));
		if (!punct) throw new ExpressionSyntaxError(`Unexpected "${char}" at position ${at + 1}`);
		tokens.push({ type: "punct", value: OPERATOR_ALIASES[punct] ?? punct, at });
		at += punct.length;
	}
	tokens.push({ type: "end", at });
	return tokens;
}

function readString(source: string, start: number): [string, number] {
	const quote = source[start];
	let value = "";
	let at = start + 1;
	while (at < source.length) {
		const char = source[at] ?? "";
		if (char === quote) return [value, at + 1];
		if (char === "\\" && at + 1 < source.length) {
			const next = source[at + 1] ?? "";
			value += STRING_ESCAPES[next] ?? next;
			at += 2;
			continue;
		}
		value += char;
		at += 1;
	}
	throw new ExpressionSyntaxError(`Unterminated string starting at position ${start + 1}`);
}

function readRegex(source: string, start: number): [string, string, number] {
	let at = start + 1;
	let inClass = false;
	while (at < source.length) {
		const char = source[at];
		if (char === "\\") {
			at += 2;
			continue;
		}
		if (char === "[") inClass = true;
		else if (char === "]") inClass = false;
		else if (char === "/" && !inClass) break;
		at += 1;
	}
	if (at >= source.length) {
		throw new ExpressionSyntaxError(
			`Unterminated regular expression starting at position ${start + 1}`,
		);
	}
	const pattern = source.slice(start + 1, at);
	let end = at + 1;
	while (end < source.length && /[dgimsuyv]/.test(source[end] ?? "")) end += 1;
	const flags = source.slice(at + 1, end);
	try {
		assertSafeRegex(pattern);
		new RegExp(pattern, flags);
	} catch (error) {
		throw new ExpressionSyntaxError(
			error instanceof UnsafeRegexError
				? error.message
				: `Invalid regular expression /${pattern}/${flags}: ${(error as Error).message}`,
		);
	}
	return [pattern, flags, end];
}

/** Binary operators by precedence level, loosest first. */
const PRECEDENCE: readonly (readonly BinaryOperator[])[] = [
	["||"],
	["&&"],
	["==", "!="],
	["<", "<=", ">", ">="],
	["+", "-"],
	["*", "/", "%"],
];

const KEYWORDS: Record<string, null | boolean> = { true: true, false: false, null: null };

/** Parse one formula or filter statement. Throws {@link ExpressionSyntaxError}. */
export function parseExpression(source: string): Expr {
	const tokens = tokenize(source);
	let position = 0;
	const peek = (): Token => tokens[position] ?? { type: "end", at: source.length };
	const isPunct = (value: string): boolean => {
		const token = peek();
		return token.type === "punct" && token.value === value;
	};
	const expect = (value: string): void => {
		if (!isPunct(value)) fail(`Expected "${value}"`);
		position += 1;
	};
	const fail = (message: string): never => {
		const token = peek();
		const found = token.type === "end" ? "end of formula" : `position ${token.at + 1}`;
		throw new ExpressionSyntaxError(`${message} at ${found}`);
	};

	const binary = (level: number): Expr => {
		const operators = PRECEDENCE[level];
		if (!operators) return unary();
		let left = binary(level + 1);
		for (;;) {
			const token = peek();
			const operator =
				token.type === "punct"
					? operators.find((candidate) => candidate === token.value)
					: undefined;
			if (!operator) return left;
			position += 1;
			left = { kind: "binary", operator, left, right: binary(level + 1) };
		}
	};

	const unary = (): Expr => {
		for (const operator of ["!", "-"] as const) {
			if (isPunct(operator)) {
				position += 1;
				return { kind: "unary", operator, operand: unary() };
			}
		}
		return postfix(primary());
	};

	const postfix = (start: Expr): Expr => {
		let expr = start;
		for (;;) {
			if (isPunct(".")) {
				position += 1;
				const token = peek();
				if (token.type !== "identifier") return fail("Expected a property or function name");
				position += 1;
				expr = { kind: "member", object: expr, name: token.value };
			} else if (isPunct("[")) {
				position += 1;
				const index = binary(0);
				expect("]");
				expr = { kind: "index", object: expr, index };
			} else if (isPunct("(")) {
				position += 1;
				expr = { kind: "call", callee: expr, args: sequence(")") };
			} else {
				return expr;
			}
		}
	};

	const sequence = (close: string): Expr[] => {
		const items: Expr[] = [];
		while (!isPunct(close)) {
			items.push(binary(0));
			if (!isPunct(",")) break;
			position += 1;
		}
		expect(close);
		return items;
	};

	const primary = (): Expr => {
		const token = peek();
		position += 1;
		switch (token.type) {
			case "number":
			case "string":
				return { kind: "literal", value: token.value };
			case "regex":
				return { kind: "regex", source: token.source, flags: token.flags };
			case "identifier":
				if (Object.hasOwn(KEYWORDS, token.value)) {
					return { kind: "literal", value: KEYWORDS[token.value] ?? null };
				}
				return { kind: "identifier", name: token.value };
			case "punct":
				if (token.value === "(") {
					const inner = binary(0);
					expect(")");
					return inner;
				}
				if (token.value === "[") return { kind: "list", items: sequence("]") };
				break;
		}
		position -= 1;
		return fail(token.type === "end" ? "Expected a value" : `Unexpected "${tokenText(token)}"`);
	};

	const expr = binary(0);
	if (peek().type !== "end") fail(`Unexpected "${tokenText(peek())}"`);
	return expr;
}

function tokenText(token: Token): string {
	switch (token.type) {
		case "regex":
			return `/${token.source}/${token.flags}`;
		case "end":
			return "";
		default:
			return String(token.value);
	}
}
