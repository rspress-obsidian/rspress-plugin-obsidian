import { type Token, tokenize, UNSUPPORTED_KEYWORDS } from "./dataview-js-lexer.js";

// ---------------------------------------------------------------------------
// Syntax tree
// ---------------------------------------------------------------------------

export type Expr =
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

export type Stmt =
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

export class Parser {
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
