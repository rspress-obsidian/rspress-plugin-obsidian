/**
 * The query language shared by the graph panel's search box and the plugin's
 * `groups` colour option, so a query typed into one behaves the same in the
 * other. It follows Obsidian's search syntax:
 *
 * - `word` — matches the node's name or path, and the note's text once the
 *   search data has loaded
 * - `"a phrase"` — the same, for an exact phrase
 * - `/regex/` — a regular expression (case-insensitive) instead of plain text
 * - `path:folder`, `file:name`, `tag:project` (subtags included),
 *   `content:text` — one field only
 * - `line:(a b)` — `a` and `b` on the same line; `section:(a b)` — under the
 *   same heading
 * - `a b` both, `a OR b` either, `-a` not, `( … )` grouping; an operator
 *   applies to a whole group (`path:(docs OR guide)`)
 *
 * An input with no matchable term (empty, a stray `-`) matches every node,
 * which is what the unfiltered panel wants. A malformed regex matches nothing.
 */

type Matcher = { kind: "text"; value: string } | { kind: "regex"; regex: RegExp };

/** Where a term looks: `any` is name, path and text; the rest name one field. */
type TermField = "any" | "path" | "file" | "tag" | "content";

export type GraphQueryExpr =
	| { type: "and"; items: GraphQueryExpr[] }
	| { type: "or"; items: GraphQueryExpr[] }
	| { type: "not"; item: GraphQueryExpr }
	| { type: "term"; field: TermField; matcher: Matcher }
	| { type: "scoped"; scope: "line" | "section"; expr: GraphQueryExpr };

export interface GraphQuery {
	expr?: GraphQueryExpr;
	/** True when the input carried no matchable term — matches everything. */
	isEmpty: boolean;
	/** True when a term reads note text, which loads separately. */
	needsText: boolean;
}

/** What a query matches against. `tags` are the tag names this node links to, lowercased. */
export interface QueryableNode {
	id: string;
	label: string;
	/** File path relative to its root; empty for tags and unresolved links. */
	path: string;
	tags?: readonly string[];
}

const OPERATORS: Record<string, TermField | "line" | "section"> = {
	path: "path",
	file: "file",
	tag: "tag",
	content: "content",
	line: "line",
	section: "section",
};

type Token =
	| { type: "open" | "close" | "not" | "or" }
	| { type: "operator"; name: TermField | "line" | "section" }
	| { type: "value"; matcher: Matcher };

function tokenize(input: string): Token[] {
	const tokens: Token[] = [];
	let index = 0;
	while (index < input.length) {
		const char = input[index] ?? "";
		if (/\s/.test(char)) {
			index += 1;
			continue;
		}
		if (char === "(" || char === ")") {
			tokens.push({ type: char === "(" ? "open" : "close" });
			index += 1;
			continue;
		}
		if (char === "-" && index + 1 < input.length && !/\s/.test(input[index + 1] ?? "")) {
			tokens.push({ type: "not" });
			index += 1;
			continue;
		}
		if (char === '"') {
			const end = input.indexOf('"', index + 1);
			const stop = end === -1 ? input.length : end;
			const phrase = input
				.slice(index + 1, stop)
				.trim()
				.toLowerCase();
			if (phrase) tokens.push({ type: "value", matcher: { kind: "text", value: phrase } });
			index = stop + 1;
			continue;
		}
		if (char === "/") {
			const end = findRegexEnd(input, index + 1);
			if (end !== -1) {
				tokens.push({ type: "value", matcher: compileRegex(input.slice(index + 1, end)) });
				index = end + 1;
				continue;
			}
		}
		const operator = /^([a-z]+):/i.exec(input.slice(index));
		const operatorName = operator?.[1]?.toLowerCase();
		if (operator && operatorName && OPERATORS[operatorName]) {
			tokens.push({ type: "operator", name: OPERATORS[operatorName] });
			index += operator[0].length;
			continue;
		}
		let end = index;
		while (end < input.length && !/[\s()"]/.test(input[end] ?? "")) end += 1;
		const word = input.slice(index, end);
		index = end;
		if (word === "OR") tokens.push({ type: "or" });
		else if (word && word !== "-") {
			tokens.push({ type: "value", matcher: { kind: "text", value: word.toLowerCase() } });
		}
	}
	return tokens;
}

function findRegexEnd(input: string, start: number): number {
	for (let index = start; index < input.length; index += 1) {
		if (input[index] === "\\") index += 1;
		else if (input[index] === "/") return index > start ? index : -1;
	}
	return -1;
}

function compileRegex(source: string): Matcher {
	try {
		return { kind: "regex", regex: new RegExp(source, "i") };
	} catch {
		// A regex still being typed matches nothing rather than everything.
		return { kind: "regex", regex: /(?!)/ };
	}
}

class Parser {
	private position = 0;
	needsText = false;

	constructor(private readonly tokens: Token[]) {}

	parse(): GraphQueryExpr | undefined {
		const items: GraphQueryExpr[] = [];
		while (this.position < this.tokens.length) {
			const expr = this.parseOr("any");
			if (expr) items.push(expr);
			// A stray `)` is skipped rather than ending the query.
			else this.position += 1;
		}
		return combine("and", items);
	}

	private parseOr(field: TermField): GraphQueryExpr | undefined {
		const items: GraphQueryExpr[] = [];
		const first = this.parseAnd(field);
		if (first) items.push(first);
		while (this.peek()?.type === "or") {
			this.position += 1;
			const next = this.parseAnd(field);
			if (next) items.push(next);
		}
		return combine("or", items);
	}

	private parseAnd(field: TermField): GraphQueryExpr | undefined {
		const items: GraphQueryExpr[] = [];
		for (let token = this.peek(); token; token = this.peek()) {
			if (token.type === "or" || token.type === "close") break;
			const unary = this.parseUnary(field);
			if (unary) items.push(unary);
		}
		return combine("and", items);
	}

	private parseUnary(field: TermField): GraphQueryExpr | undefined {
		const token = this.peek();
		if (token?.type === "not") {
			this.position += 1;
			const item = this.parseUnary(field);
			return item ? { type: "not", item } : undefined;
		}
		return this.parsePrimary(field);
	}

	private parsePrimary(field: TermField): GraphQueryExpr | undefined {
		const token = this.peek();
		if (!token) return undefined;
		this.position += 1;
		switch (token.type) {
			case "open": {
				const inner = this.parseOr(field);
				if (this.peek()?.type === "close") this.position += 1;
				return inner;
			}
			case "operator": {
				if (token.name === "line" || token.name === "section") {
					this.needsText = true;
					const inner = this.parsePrimary("any");
					return inner ? { type: "scoped", scope: token.name, expr: inner } : undefined;
				}
				return this.parsePrimary(token.name);
			}
			case "value":
				if (field === "any" || field === "content") this.needsText = true;
				return {
					type: "term",
					field,
					matcher:
						field === "tag" && token.matcher.kind === "text"
							? { kind: "text", value: token.matcher.value.replace(/^#+/, "") }
							: token.matcher,
				};
			default:
				return undefined;
		}
	}

	private peek(): Token | undefined {
		return this.tokens[this.position];
	}
}

function combine(type: "and" | "or", items: GraphQueryExpr[]): GraphQueryExpr | undefined {
	if (items.length === 0) return undefined;
	return items.length === 1 ? items[0] : { type, items };
}

export function parseGraphQuery(input: string): GraphQuery {
	const parser = new Parser(tokenize(input));
	const expr = parser.parse();
	return { expr, isEmpty: !expr, needsText: Boolean(expr) && parser.needsText };
}

/**
 * Whether `node` matches. `text` is the note's visible source when the search
 * data has loaded; without it, text-only terms match nothing and plain terms
 * fall back to the name and path.
 */
export function matchesGraphQuery(node: QueryableNode, query: GraphQuery, text?: string): boolean {
	if (!query.expr) return true;
	return evaluate(query.expr, node, text, undefined);
}

function evaluate(
	expr: GraphQueryExpr,
	node: QueryableNode,
	text: string | undefined,
	scope: string | undefined,
): boolean {
	switch (expr.type) {
		case "and":
			return expr.items.every((item) => evaluate(item, node, text, scope));
		case "or":
			return expr.items.some((item) => evaluate(item, node, text, scope));
		case "not":
			return !evaluate(expr.item, node, text, scope);
		case "scoped": {
			if (text === undefined) return false;
			const parts = expr.scope === "line" ? text.split("\n") : splitSections(text);
			return parts.some((part) => evaluate(expr.expr, node, text, part));
		}
		case "term":
			return matchTerm(expr.field, expr.matcher, node, text, scope);
	}
}

function matchTerm(
	field: TermField,
	matcher: Matcher,
	node: QueryableNode,
	text: string | undefined,
	scope: string | undefined,
): boolean {
	const test = (haystack: string) =>
		matcher.kind === "text"
			? haystack.toLowerCase().includes(matcher.value)
			: matcher.regex.test(haystack);
	switch (field) {
		case "path":
			return test(node.path || node.id);
		case "file":
			return test(node.path ? (node.path.split("/").pop() ?? node.path) : node.label);
		case "tag":
			return (node.tags ?? []).some((tag) =>
				matcher.kind === "text"
					? tag === matcher.value || tag.startsWith(`${matcher.value}/`)
					: matcher.regex.test(tag),
			);
		case "content":
			return test(scope ?? text ?? "");
		case "any":
			// Inside `line:`/`section:` a plain term means "in this line".
			if (scope !== undefined) return test(scope);
			return test(node.label) || test(node.path || node.id) || (text !== undefined && test(text));
	}
}

/** A note split at its headings; text before the first heading is its own section. */
function splitSections(text: string): string[] {
	const sections: string[] = [];
	let current: string[] = [];
	for (const line of text.split("\n")) {
		if (/^#{1,6}\s/.test(line) && current.length > 0) {
			sections.push(current.join("\n"));
			current = [];
		}
		current.push(line);
	}
	sections.push(current.join("\n"));
	return sections;
}
