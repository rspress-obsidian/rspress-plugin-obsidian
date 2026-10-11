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
export const UNSUPPORTED_KEYWORDS: Record<string, true> = {
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

export interface Token {
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

export function tokenize(source: string): Token[] {
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
