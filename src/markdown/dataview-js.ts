/**
 * DataviewJS, interpreted — never evaluated as JavaScript.
 *
 * A small JavaScript subset is tokenized, parsed and run by this module and its
 * `dataview-js-*` siblings: `const`/`let`/`var`, assignment to declared
 * variables, `if`/`else`, `for (… of …)`, arrow functions, template literals,
 * the usual operators, and the `dv` API over the content index. Identifiers
 * resolve only to variables the script declared, `dv` and a few safe globals;
 * properties are read only from a value's own enumerable fields; methods are an
 * explicit allowlist per value type. Nothing reaches the host: there is no
 * `eval`, `Function`, global object or prototype access.
 */
import type { DailyNoteConfig } from "./daily-notes.js";
import {
	createDataviewEnvironment,
	type DataviewEnvironment,
	type DataviewSettings,
} from "./dataview.js";
import { callDataviewFunction } from "./dataview-functions.js";
import { callDv } from "./dataview-js-api.js";
import { tokenize } from "./dataview-js-lexer.js";
import {
	binary,
	callArrayMethod,
	callStringMethod,
	DV,
	DV_FUNC,
	describe,
	invoke,
	jsString,
	MATH,
	readProperty,
} from "./dataview-js-methods.js";
import { type Expr, Parser, type Stmt } from "./dataview-js-parser.js";
import { renderValue } from "./dataview-render.js";
import {
	addDuration,
	DataviewDuration,
	DataviewFunction,
	DataviewLink,
	formatLuxonDate,
	parseDuration,
	valueToString,
} from "./dataview-values.js";
import {
	checkSize,
	concatTexts,
	isStackOverflow,
	STACK_OVERFLOW_MESSAGE,
	WorkBudget,
} from "./interpreter-limits.js";
import type { ContentIndex, ContentPage } from "./types.js";

export interface DataviewJsResult {
	html?: string;
	error?: string;
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

class ReturnSignal {
	constructor(readonly value: unknown) {}
}

const MAX_CALL_DEPTH = 200;
/**
 * Evaluation steps, plus what the script builds, before a runaway script is
 * stopped: room for a script that compares every page with every other.
 */
const MAX_WORK = 50_000_000;

export interface Runtime {
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
