import { type Token, tokenize } from "./lexer.js";
import { FORBIDDEN_PROPERTIES, RESERVED_NAMES, TemplaterError } from "./values.js";

// ---------------------------------------------------------------------------
// Syntax tree
// ---------------------------------------------------------------------------

export type Pattern = string | string[];

export type Expr =
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

export type Stmt = { origin?: string } & (
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

export class Parser {
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
