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
	checkSize,
	concatTexts,
	growthCost,
	isStackOverflow,
	STACK_OVERFLOW_MESSAGE,
} from "../../interpreter-limits.js";
import { BUILTINS, constructDate, messageOf } from "./builtins.js";
import { type Token, tokenize } from "./lexer.js";
import { callMethod } from "./methods.js";
import { type Expr, Parser, type Pattern, type Stmt } from "./parser.js";
import {
	binary,
	describe,
	HostFunction,
	HostObject,
	hasMethod,
	readProperty,
	TemplaterError,
	toNumber,
	toTemplateString,
} from "./values.js";

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

export interface Runtime extends ProgramRuntime {
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
