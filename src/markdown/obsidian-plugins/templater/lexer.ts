import { compileSafeRegex, UnsafeRegexError } from "../../../shared/safe-regex.js";
import { messageOf } from "./builtins.js";
import type { Expr } from "./parser.js";
import { FORBIDDEN_IDENTIFIERS, FORBIDDEN_PROPERTIES, TemplaterError } from "./values.js";

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export interface Token {
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

export function tokenize(source: string, origin?: string): Token[] {
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
