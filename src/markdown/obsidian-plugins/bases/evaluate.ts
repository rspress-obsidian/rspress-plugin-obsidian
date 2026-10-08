/**
 * The interpreter for parsed Bases formulas and filters, and the functions
 * Obsidian documents for each value type (Functions.md).
 *
 * Every lookup into a function table or a property bag goes through
 * `Object.hasOwn`, so `toString`, `constructor` or `__proto__` written in a
 * formula reach only what is defined here, never JavaScript's own prototype.
 * A failure is a value ({@link ErrorValue}) that flows through the rest of
 * the formula and shows in its cell, as Obsidian shows it.
 */
import { escapeHtmlAttribute } from "../../../shared/escape.js";
import { formatDailyNoteDate } from "../../daily-notes.js";
import { momentFrom } from "../../date-math.js";
import {
	checkSize,
	checkTextLength,
	concatLists,
	concatTexts,
	flatList,
	isStackOverflow,
	joinTexts,
	ResourceLimitError,
	repeatText,
	replaceText,
	STACK_OVERFLOW_MESSAGE,
	WorkBudget,
} from "../../interpreter-limits.js";
import type { ContentPage } from "../../types.js";
import type { Dataset } from "./dataset.js";
import { type Expr, parseExpression } from "./expression.js";
import {
	addDuration,
	asDate,
	type BaseFile,
	compareValues,
	DateValue,
	type DisplayFormats,
	DurationValue,
	durationMs,
	ErrorValue,
	FileValue,
	fileOf,
	HtmlValue,
	IconValue,
	ImageValue,
	ISO_FORMATS,
	isEmptyValue,
	isTruthy,
	LinkValue,
	ObjectValue,
	parseDateText,
	parseDuration,
	RegexValue,
	startOfDay,
	typeOf,
	type Value,
	valueKey,
	valuesEqual,
	valueToString,
} from "./values.js";

/** What every formula of one base render shares. */
export interface EvalEnv {
	dataset: Dataset;
	now: Date;
	formats: DisplayFormats;
	/** `this`: the base file on its own page, the embedding note otherwise. */
	thisFile: BaseFile | undefined;
	/** The base's formulas, parsed; a formula that does not parse is its error. */
	formulas: Record<string, Expr | ErrorValue>;
	/** The note `link()` and `file()` resolve from. */
	contextPage: ContentPage;
	/** Seeds `random()`, so the same build renders the same numbers. */
	seed: string;
}

/** One row's evaluation state: its formula results, and the formulas being evaluated (for cycles). */
export class RowScope {
	readonly formulaCache = new Map<string, Value>();
	readonly evaluating: string[] = [];
	randomCalls = 0;
	constructor(readonly file: BaseFile | undefined) {}
}

type Locals = Readonly<Record<string, Value>>;

interface Invocation {
	env: EvalEnv;
	row: RowScope;
	locals: Locals;
	args: Expr[];
}

type Method<T> = (receiver: T, args: Value[], call: Invocation) => Value;
type LazyMethod<T> = (receiver: T, call: Invocation) => Value;

/** A property a view shows, sorts or groups by: `note.x` (or bare `x`), `file.x`, `formula.x`. */
export interface PropertyRef {
	/** As written in the base. */
	id: string;
	kind: "note" | "file" | "formula";
	name: string;
}

export function parsePropertyId(id: string): PropertyRef {
	const match = /^(note|file|formula)\.(.+)$/s.exec(id.trim());
	if (match?.[1] && match[2]) {
		return { id, kind: match[1] as PropertyRef["kind"], name: match[2] };
	}
	return { id, kind: "note", name: id.trim() };
}

/** Parse a formula or filter statement, keeping a syntax error as its value. */
export function compileExpression(source: unknown): Expr | ErrorValue {
	try {
		return parseExpression(String(source ?? ""));
	} catch (error) {
		const message = isStackOverflow(error) ? STACK_OVERFLOW_MESSAGE : (error as Error).message;
		return new ErrorValue(`Syntax error: ${message}`);
	}
}

/** List elements evaluated, plus what calls build, per base render. */
const MAX_RENDER_WORK = 20_000_000;
const budgets = new WeakMap<EvalEnv, WorkBudget>();

/** The render's work budget: `list.map(list.map(…))` over long lists must still end. */
function budgetOf(env: EvalEnv): WorkBudget {
	let budget = budgets.get(env);
	if (!budget) {
		budget = new WorkBudget(MAX_RENDER_WORK, "The base's formulas");
		budgets.set(env, budget);
	}
	return budget;
}

/** The value of `ref` for `row`. */
export function propertyValue(ref: PropertyRef, env: EvalEnv, row: RowScope): Value {
	if (ref.kind === "formula") return evaluateFormula(ref.name, env, row);
	const file = row.file;
	if (!file) return null;
	if (ref.kind === "file") {
		const field = own(FILE_FIELDS, ref.name);
		return field ? field(file, env) : null;
	}
	return own(file.properties, ref.name) ?? null;
}

/** `formula.name` for `row`: computed once per row, with circular references reported. */
export function evaluateFormula(name: string, env: EvalEnv, row: RowScope): Value {
	return guarded(() => formulaValue(name, env, row));
}

/** Evaluate an expression for `row`, with `locals` (`value`, `index`, `acc`, `values`) in scope. */
export function evaluate(expr: Expr, env: EvalEnv, row: RowScope, locals: Locals = {}): Value {
	return guarded(() => evaluateNode(expr, env, row, locals));
}

/**
 * A formula that outgrew a build limit is a warning, like any value-dependent
 * failure: the same formula is fine for notes with smaller values. One nested
 * too deeply for the stack fails for every note, so it is an error.
 */
function guarded(run: () => Value): Value {
	try {
		return run();
	} catch (error) {
		if (error instanceof ResourceLimitError) return new ErrorValue(error.message, "warning");
		if (isStackOverflow(error)) return new ErrorValue(STACK_OVERFLOW_MESSAGE);
		throw error;
	}
}

function formulaValue(name: string, env: EvalEnv, row: RowScope): Value {
	const cached = row.formulaCache.get(name);
	if (cached !== undefined) return cached;
	if (row.evaluating.includes(name)) {
		return new ErrorValue(
			`Circular formula reference: ${[...row.evaluating.slice(row.evaluating.indexOf(name)), name].join(" → ")}`,
		);
	}
	const formula = own(env.formulas, name);
	if (!formula) return new ErrorValue(`Unknown formula "${name}"`);
	if (formula instanceof ErrorValue) return formula;
	row.evaluating.push(name);
	try {
		const value = evaluateNode(formula, env, row, {});
		row.formulaCache.set(name, value);
		return value;
	} finally {
		// Also when a limit ends the evaluation: the row's later formulas are not "circular".
		row.evaluating.pop();
	}
}

function evaluateNode(expr: Expr, env: EvalEnv, row: RowScope, locals: Locals): Value {
	switch (expr.kind) {
		case "literal":
			return expr.value;
		case "regex":
			return new RegexValue(new RegExp(expr.source, expr.flags));
		case "list": {
			const items: Value[] = [];
			for (const item of expr.items) {
				const value = evaluateNode(item, env, row, locals);
				if (value instanceof ErrorValue) return value;
				items.push(value);
			}
			return items;
		}
		case "identifier":
			return identifier(expr.name, env, row, locals);
		case "member":
			if (isScope(expr.object, "formula", locals)) return formulaValue(expr.name, env, row);
			return member(evaluateNode(expr.object, env, row, locals), expr.name, env);
		case "index": {
			const key = evaluateNode(expr.index, env, row, locals);
			if (key instanceof ErrorValue) return key;
			if (isScope(expr.object, "formula", locals)) {
				return formulaValue(text(key), env, row);
			}
			return indexValue(evaluateNode(expr.object, env, row, locals), key, env);
		}
		case "call":
			return call(expr, env, row, locals);
		case "unary":
			return unary(expr.operator, evaluateNode(expr.operand, env, row, locals));
		case "binary":
			return binary(expr, env, row, locals);
	}
}

function isScope(expr: Expr, name: string, locals: Locals): boolean {
	return expr.kind === "identifier" && expr.name === name && !Object.hasOwn(locals, name);
}

function identifier(name: string, env: EvalEnv, row: RowScope, locals: Locals): Value {
	if (Object.hasOwn(locals, name)) return locals[name] ?? null;
	switch (name) {
		case "file":
			return row.file ? new FileValue(row.file) : null;
		case "this":
			return env.thisFile ? new FileValue(env.thisFile, true) : null;
		case "note":
			return row.file ? new ObjectValue(row.file.properties) : null;
		case "formula":
			return new ErrorValue("`formula` must be followed by a formula name (`formula.name`)");
	}
	return row.file ? (own(row.file.properties, name) ?? null) : null;
}

/** `Object.hasOwn`-guarded lookup: a formula never reaches a prototype member. */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
	return Object.hasOwn(table, key) ? table[key] : undefined;
}

const FILE_FIELDS: Record<string, (file: BaseFile, env: EvalEnv) => Value> = {
	// Obsidian's runtime names a note without `.md`, as its views list it.
	name: (file) => (file.ext === "md" ? file.basename : file.name),
	basename: (file) => file.basename,
	path: (file) => file.path,
	folder: (file) => file.folder,
	ext: (file) => file.ext,
	size: (file) => file.size,
	ctime: (file) => new DateValue(file.ctimeMs, true),
	mtime: (file) => new DateValue(file.mtimeMs, true),
	tags: (file) => [...file.tags],
	links: (file, env) => [...env.dataset.links(file)],
	embeds: (file, env) => [...env.dataset.embeds(file)],
	backlinks: (file, env) => [...env.dataset.backlinks(file)],
	properties: (file) => new ObjectValue(file.properties),
	file: (file) => new FileValue(file),
};

const DATE_FIELDS: Record<string, (date: Date) => number> = {
	year: (date) => date.getFullYear(),
	month: (date) => date.getMonth() + 1,
	day: (date) => date.getDate(),
	hour: (date) => date.getHours(),
	minute: (date) => date.getMinutes(),
	second: (date) => date.getSeconds(),
	millisecond: (date) => date.getMilliseconds(),
};

/** The type names Obsidian's runtime uses in its messages (`Cannot find "x" on type String`). */
const RUNTIME_TYPE_NAMES: Record<string, string> = {
	null: "Null",
	boolean: "Boolean",
	number: "Number",
	string: "String",
	list: "List",
	date: "Date",
	duration: "Duration",
	link: "Link",
	file: "File",
	object: "Object",
	regexp: "RegExp",
	html: "HTML",
	image: "Image",
	icon: "Icon",
	error: "Error",
};

function runtimeType(value: Value): string {
	const type = typeOf(value);
	return RUNTIME_TYPE_NAMES[type] ?? type;
}

/**
 * `value.name`. A field the value's type does not have is Obsidian's error
 * value, `Cannot find "name" on type T`. It is a warning: the formula is fine
 * for notes whose value has the field, as `(due - today()).days` is wherever
 * `due` is missing. A missing property, or a key an object does not have, is
 * simply nothing.
 */
function member(value: Value, name: string, env: EvalEnv): Value {
	if (value === null || value instanceof ErrorValue) return value;
	const missing = () =>
		new ErrorValue(`Cannot find "${name}" on type ${runtimeType(value)}`, "warning");
	if (value instanceof FileValue) {
		if (value.isThis && name !== "file") {
			if (name === "note") return new ObjectValue(value.file.properties);
			return own(value.file.properties, name) ?? null;
		}
		return own(FILE_FIELDS, name)?.(value.file, env) ?? missing();
	}
	if (name === "length" && (typeof value === "string" || Array.isArray(value))) {
		return value.length;
	}
	if (value instanceof DateValue) {
		return own(DATE_FIELDS, name)?.(new Date(value.ms)) ?? missing();
	}
	if (value instanceof ObjectValue) return own(value.entries, name) ?? null;
	return missing();
}

/** `value[key]`: an element, a character, an entry or a field. */
function indexValue(value: Value, key: Value, env: EvalEnv): Value {
	if (value === null || value instanceof ErrorValue) return value;
	if (typeof key === "number" && (Array.isArray(value) || typeof value === "string")) {
		return value[key] ?? null;
	}
	return member(value, valueToString(key, ISO_FORMATS), env);
}

function unary(operator: "!" | "-", operand: Value): Value {
	if (operand instanceof ErrorValue) return operand;
	if (operator === "!") return !isTruthy(operand);
	if (operand === null) return null;
	if (operand instanceof DurationValue) return new DurationValue(-operand.months, -operand.ms);
	const number = toNumber(operand);
	return number === undefined
		? new ErrorValue(`Invalid operator "-" for ${runtimeType(operand)}`, "warning")
		: -number;
}

function binary(
	expr: Extract<Expr, { kind: "binary" }>,
	env: EvalEnv,
	row: RowScope,
	locals: Locals,
): Value {
	const left = evaluateNode(expr.left, env, row, locals);
	if (left instanceof ErrorValue) return left;
	if (expr.operator === "&&") {
		return isTruthy(left) ? evaluateNode(expr.right, env, row, locals) : left;
	}
	if (expr.operator === "||") {
		return isTruthy(left) ? left : evaluateNode(expr.right, env, row, locals);
	}
	const right = evaluateNode(expr.right, env, row, locals);
	if (right instanceof ErrorValue) return right;
	switch (expr.operator) {
		case "==":
			return valuesEqual(left, right);
		case "!=":
			return !valuesEqual(left, right);
		case "<":
		case "<=":
		case ">":
		case ">=": {
			const order = compareValues(left, right);
			if (order === undefined) return false;
			if (expr.operator === "<") return order < 0;
			if (expr.operator === "<=") return order <= 0;
			if (expr.operator === ">") return order > 0;
			return order >= 0;
		}
		default:
			return arithmetic(expr.operator, left, right);
	}
}

/** A duration operand: a duration, or a string that reads as one (`"1 day"`). */
function asDuration(value: Value): DurationValue | undefined {
	if (value instanceof DurationValue) return value;
	return typeof value === "string" ? parseDuration(value) : undefined;
}

function toNumber(value: Value): number | undefined {
	if (typeof value === "number") return value;
	if (typeof value === "boolean") return Number(value);
	if (typeof value === "string" && value.trim() !== "") {
		const number = Number(value);
		return Number.isNaN(number) ? undefined : number;
	}
	return undefined;
}

/**
 * `+ - * / %`, with date arithmetic as Obsidian's runtime does it: a date plus
 * or minus a duration is a date; a date minus a date is the Duration between
 * them ("a day"); a duration scales by a number on its right (`2 * duration`
 * is an invalid operator); and a duration divided by a number is that many
 * milliseconds, so `(due - today()) / 86400000` counts days. `+` joins text
 * when either side is text. Arithmetic with a missing value is missing, so an
 * empty property leaves its cell empty.
 */
function arithmetic(operator: "+" | "-" | "*" | "/" | "%", left: Value, right: Value): Value {
	const invalid = () =>
		new ErrorValue(
			`Invalid operator between ${runtimeType(left)} and ${runtimeType(right)}`,
			"warning",
		);
	if (operator === "+" || operator === "-") {
		const sign = operator === "+" ? 1 : -1;
		if (left instanceof DateValue) {
			const duration = asDuration(right);
			if (duration) return addDuration(left, duration, sign);
			const other = operator === "-" ? asDate(right) : undefined;
			if (other) return new DurationValue(0, left.ms - other.ms);
		}
		if (right instanceof DateValue && operator === "+") {
			const duration = asDuration(left);
			if (duration) return addDuration(right, duration, 1);
		}
		if (left instanceof DurationValue && right instanceof DurationValue) {
			return new DurationValue(left.months + sign * right.months, left.ms + sign * right.ms);
		}
		if (operator === "+") {
			if (typeof left === "number" && typeof right === "number") return left + right;
			if (typeof left === "string" || typeof right === "string") {
				return concatTexts(valueToString(left, ISO_FORMATS), valueToString(right, ISO_FORMATS));
			}
			if (Array.isArray(left) && Array.isArray(right)) return concatLists([left, right]);
		}
	}
	if (left === null || right === null) return null;
	if (left instanceof DurationValue && operator === "*") {
		const factor = toNumber(right);
		return factor === undefined
			? invalid()
			: new DurationValue(left.months * factor, left.ms * factor);
	}
	if (left instanceof DurationValue && operator === "/") {
		const divisor = toNumber(right);
		return divisor === undefined ? invalid() : durationMs(left) / divisor;
	}
	if (left instanceof DurationValue || right instanceof DurationValue) return invalid();
	const a = toNumber(left);
	const b = toNumber(right);
	if (a === undefined || b === undefined) return invalid();
	switch (operator) {
		case "+":
			return a + b;
		case "-":
			return a - b;
		case "*":
			return a * b;
		case "/":
			return a / b;
		case "%":
			return a % b;
	}
}

function call(
	expr: Extract<Expr, { kind: "call" }>,
	env: EvalEnv,
	row: RowScope,
	locals: Locals,
): Value {
	const invocation: Invocation = { env, row, locals, args: expr.args };
	const { callee } = expr;
	if (callee.kind === "identifier") {
		if (callee.name === "if") {
			const [condition, then, otherwise] = expr.args;
			if (!condition || !then) return new ErrorValue("if() needs a condition and a result");
			const test = evaluateNode(condition, env, row, locals);
			if (test instanceof ErrorValue) return test;
			if (isTruthy(test)) return evaluateNode(then, env, row, locals);
			return otherwise ? evaluateNode(otherwise, env, row, locals) : null;
		}
		const fn = own(GLOBAL_FUNCTIONS, callee.name);
		if (!fn) return new ErrorValue(`Cannot find function "${callee.name}"`);
		const args = evaluateArgs(invocation);
		return args instanceof ErrorValue ? args : built(fn(null, args, invocation), undefined, env);
	}
	if (callee.kind !== "member") return new ErrorValue("Only functions can be called");
	const receiver = evaluateNode(callee.object, env, row, locals);
	if (receiver instanceof ErrorValue) return receiver;
	return built(callMethod(receiver, callee.name, invocation), receiver, env);
}

/** A call's result, checked against the size limits and charged for what it built beyond `input`. */
function built(result: Value, input: Value | undefined, env: EvalEnv): Value {
	checkSize(result);
	budgetOf(env).charge(result, input);
	return result;
}

function evaluateArgs(invocation: Invocation): Value[] | ErrorValue {
	const values: Value[] = [];
	for (const arg of invocation.args) {
		const value = evaluateNode(arg, invocation.env, invocation.row, invocation.locals);
		if (value instanceof ErrorValue) return value;
		values.push(value);
	}
	return values;
}

function callMethod(receiver: Value, name: string, invocation: Invocation): Value {
	if (Array.isArray(receiver)) {
		const lazy = own(LIST_LAZY_METHODS, name);
		if (lazy) return lazy(receiver, invocation);
		return invoke(LIST_METHODS, receiver, name, invocation);
	}
	if (receiver === null) {
		// A missing property: `isEmpty()` is true, `toString()` empty, and any
		// other function has nothing to work on, so its result is missing too.
		return own(ANY_METHODS, name) ? invoke({}, receiver, name, invocation) : null;
	}
	if (typeof receiver === "string") return invoke(STRING_METHODS, receiver, name, invocation);
	if (typeof receiver === "number") return invoke(NUMBER_METHODS, receiver, name, invocation);
	if (receiver instanceof DateValue) return invoke(DATE_METHODS, receiver, name, invocation);
	if (receiver instanceof LinkValue) return invoke(LINK_METHODS, receiver, name, invocation);
	if (receiver instanceof FileValue) return invoke(FILE_METHODS, receiver, name, invocation);
	if (receiver instanceof ObjectValue) return invoke(OBJECT_METHODS, receiver, name, invocation);
	if (receiver instanceof RegexValue) return invoke(REGEX_METHODS, receiver, name, invocation);
	return invoke({}, receiver, name, invocation);
}

function invoke<T extends Value>(
	table: Readonly<Record<string, Method<T>>>,
	receiver: T,
	name: string,
	invocation: Invocation,
): Value {
	const method = own(table, name) ?? own(ANY_METHODS, name);
	// A method the value's type lacks is about this note's data: the same
	// formula runs for notes whose property has that type.
	if (!method) {
		return new ErrorValue(
			`Cannot find function "${name}" on type ${runtimeType(receiver)}`,
			"warning",
		);
	}
	const args = evaluateArgs(invocation);
	return args instanceof ErrorValue ? args : method(receiver, args, invocation);
}

/** An argument as text, the way a formula stringifies it. */
function text(value: Value | undefined): string {
	return valueToString(value ?? null, ISO_FORMATS);
}

function integer(value: Value | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

const ANY_METHODS: Record<string, Method<Value>> = {
	isTruthy: (receiver) => isTruthy(receiver),
	isType: (receiver, [type]) => typeof type === "string" && typeOf(receiver) === type.toLowerCase(),
	toString: ((receiver) => text(receiver)) satisfies Method<Value>,
	isEmpty: (receiver) => isEmptyValue(receiver),
};

/** A deterministic `random()`: a hash of the seed, the row and the call, run through mulberry32. */
function seededRandom(key: string): number {
	let hash = 2166136261;
	for (let i = 0; i < key.length; i += 1) {
		hash ^= key.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	let t = (hash + 0x6d2b79f5) >>> 0;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function numbersOf(values: Value[]): number[] {
	return flatList(values, Number.POSITIVE_INFINITY).filter(
		(value): value is number => typeof value === "number" && !Number.isNaN(value),
	);
}

function extreme(values: Value[], sign: 1 | -1): Value {
	let best: Value = null;
	for (const value of flatList(values, 1) as Value[]) {
		if (value === null) continue;
		if (best === null) {
			best = value;
			continue;
		}
		const order = compareValues(value, best);
		if (order !== undefined && sign * order > 0) best = value;
	}
	return best;
}

function toLink(target: Value, display: Value | undefined, call: Invocation): Value {
	const shown = display === undefined || display === null ? undefined : text(display);
	if (target instanceof FileValue) {
		return new LinkValue(target.file.path, shown, target.file, target.file.page);
	}
	if (target instanceof LinkValue) {
		return new LinkValue(target.target, shown ?? target.display, target.file, target.source);
	}
	if (typeof target !== "string") {
		return new ErrorValue(`link() needs a path, not a ${typeOf(target)}`, "warning");
	}
	return call.env.dataset.link(target, call.env.contextPage, shown);
}

const GLOBAL_FUNCTIONS: Record<string, Method<null>> = {
	now: (_, _args, { env }) => new DateValue(env.now.getTime(), true),
	today: (_, _args, { env }) => startOfDay(env.now.getTime()),
	date: (_, [value]) => {
		if (value instanceof DateValue) return value;
		if (typeof value === "number") return new DateValue(value, true);
		if (typeof value === "string") {
			return parseDateText(value) ?? new ErrorValue(`date() cannot read "${value}"`, "warning");
		}
		return new ErrorValue(`date() needs a string, not a ${typeOf(value ?? null)}`, "warning");
	},
	duration: (_, [value]) => {
		if (value instanceof DurationValue) return value;
		if (typeof value === "number") return new DurationValue(0, value);
		const duration = typeof value === "string" ? parseDuration(value) : undefined;
		return duration ?? new ErrorValue(`duration() cannot read "${text(value)}"`, "warning");
	},
	number: (_, [value = null]) => {
		if (value === null) return null;
		if (value instanceof DateValue) return value.ms;
		// Obsidian's runtime does not turn a Duration into a number; divide it instead.
		if (value instanceof DurationValue) {
			return new ErrorValue("Cannot convert Duration to a number", "warning");
		}
		const number = toNumber(value);
		return (
			number ??
			new ErrorValue(`Unable to parse ${JSON.stringify(text(value))} as a number.`, "warning")
		);
	},
	list: (_, [value = null]) => (Array.isArray(value) ? value : value === null ? [] : [value]),
	link: (_, [target = null, display], call) => toLink(target, display, call),
	image: (_, [source = null]) => (source === null ? null : new ImageValue(source)),
	icon: (_, [name]) => new IconValue(text(name)),
	max: (_, args) => extreme(args, 1),
	min: (_, args) => extreme(args, -1),
	file: (_, [target = null], { env }) => {
		const file =
			fileOf(target) ??
			(typeof target === "string" ? env.dataset.resolve(target, env.contextPage) : undefined);
		return file ? new FileValue(file) : null;
	},
	html: (_, [markup]) => new HtmlValue(text(markup)),
	escapeHTML: (_, [markup]) => escapeHtmlAttribute(text(markup)),
	random: (_, _args, { env, row }) => {
		row.randomCalls += 1;
		return seededRandom(`${env.seed}|${row.file?.path ?? ""}|${row.randomCalls}`);
	},
};

const STRING_METHODS: Record<string, Method<string>> = {
	contains: (receiver, [value]) => receiver.includes(text(value)),
	containsAll: (receiver, values) => values.every((value) => receiver.includes(text(value))),
	containsAny: (receiver, values) => values.some((value) => receiver.includes(text(value))),
	startsWith: (receiver, [value]) => receiver.startsWith(text(value)),
	endsWith: (receiver, [value]) => receiver.endsWith(text(value)),
	lower: (receiver) => receiver.toLowerCase(),
	upper: (receiver) => receiver.toUpperCase(),
	title: (receiver) =>
		receiver.replace(
			/(^|[\s\-_])(\p{L})/gu,
			(_match, gap: string, letter: string) => `${gap}${letter.toUpperCase()}`,
		),
	trim: (receiver) => receiver.trim(),
	replace: (receiver, [pattern, replacement]) => {
		const by = text(replacement);
		if (pattern instanceof RegexValue) {
			return replaceText(
				receiver,
				new RegExp(pattern.regex.source, pattern.regex.flags),
				by,
				false,
			);
		}
		// Literal replacement text: a function, so `$&` in it is not a pattern.
		const search = text(pattern);
		const matches = search === "" ? receiver.length + 1 : receiver.split(search).length - 1;
		checkTextLength(receiver.length + matches * by.length);
		return receiver.replaceAll(search, () => by);
	},
	repeat: (receiver, [count]) => repeatText(receiver, Math.max(0, integer(count, 0))),
	reverse: (receiver) => [...receiver].reverse().join(""),
	slice: (receiver, [start, end]) =>
		receiver.slice(
			integer(start, 0),
			end === undefined ? undefined : integer(end, receiver.length),
		),
	split: (receiver, [separator, limit]) => {
		const parts =
			separator instanceof RegexValue
				? receiver.split(new RegExp(separator.regex.source, separator.regex.flags))
				: receiver.split(text(separator));
		return limit === undefined ? parts : parts.slice(0, Math.max(0, integer(limit, parts.length)));
	},
};

const NUMBER_METHODS: Record<string, Method<number>> = {
	abs: (receiver) => Math.abs(receiver),
	ceil: (receiver) => Math.ceil(receiver),
	floor: (receiver) => Math.floor(receiver),
	round: (receiver, [digits]) => {
		const places = integer(digits, 0);
		// Shift by exponent text, not by multiplying: 1.005 * 100 is 100.49999…
		return Number(`${Math.round(Number(`${receiver}e${places}`))}e${-places}`);
	},
	toFixed: (receiver, [precision]) =>
		receiver.toFixed(Math.min(100, Math.max(0, integer(precision, 0)))),
	isEmpty: () => false,
};

const DATE_METHODS: Record<string, Method<DateValue>> = {
	date: (receiver) => startOfDay(receiver.ms),
	format: (receiver, [format]) =>
		formatDailyNoteDate(new Date(receiver.ms), format === undefined ? "YYYY-MM-DD" : text(format)),
	time: (receiver) => formatDailyNoteDate(new Date(receiver.ms), "HH:mm:ss"),
	relative: (receiver, _args, { env }) => momentFrom(new Date(receiver.ms), env.now),
};

function containsValue(list: Value[], value: Value): boolean {
	return list.some((item) => valuesEqual(item, value));
}

const LIST_METHODS: Record<string, Method<Value[]>> = {
	contains: (receiver, [value = null]) => containsValue(receiver, value),
	containsAll: (receiver, values) => values.every((value) => containsValue(receiver, value)),
	containsAny: (receiver, values) => values.some((value) => containsValue(receiver, value)),
	flat: (receiver) => flatList(receiver, Number.POSITIVE_INFINITY) as Value[],
	join: (receiver, [separator]) =>
		joinTexts(receiver, separator === undefined ? "," : text(separator), text),
	reverse: (receiver) => [...receiver].reverse(),
	slice: (receiver, [start, end]) =>
		receiver.slice(
			integer(start, 0),
			end === undefined ? undefined : integer(end, receiver.length),
		),
	sort: (receiver) =>
		[...receiver].sort((a, b) => {
			if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
			return compareValues(a, b) ?? valueKey(a).localeCompare(valueKey(b));
		}),
	unique: (receiver) => {
		const seen = new Set<string>();
		return receiver.filter((item) => {
			// Obsidian de-duplicates links by how they read, not by the file they reach.
			const key = item instanceof LinkValue ? `link:${text(item)}` : valueKey(item);
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	},
	sum: (receiver) => numbersOf(receiver).reduce((total, value) => total + value, 0),
	mean: (receiver) => {
		const numbers = numbersOf(receiver);
		return numbers.length === 0 ? null : numbers.reduce((a, b) => a + b, 0) / numbers.length;
	},
	median: (receiver) => {
		const numbers = numbersOf(receiver).sort((a, b) => a - b);
		if (numbers.length === 0) return null;
		const middle = Math.floor(numbers.length / 2);
		return numbers.length % 2 === 1
			? (numbers[middle] ?? null)
			: ((numbers[middle - 1] ?? 0) + (numbers[middle] ?? 0)) / 2;
	},
	min: (receiver) => extreme(receiver, -1),
	max: (receiver) => extreme(receiver, 1),
};

/** List functions whose argument is an expression run per element (`value`, `index`, `acc`). */
const LIST_LAZY_METHODS: Record<string, LazyMethod<Value[]>> = {
	filter: (receiver, { env, row, locals, args: [predicate] }) => {
		if (!predicate) return new ErrorValue("filter() needs an expression");
		const kept: Value[] = [];
		const budget = budgetOf(env);
		for (const [index, value] of receiver.entries()) {
			budget.spend();
			const keep = evaluateNode(predicate, env, row, { ...locals, value, index });
			if (keep instanceof ErrorValue) return keep;
			if (isTruthy(keep)) kept.push(value);
		}
		return kept;
	},
	map: (receiver, { env, row, locals, args: [mapper] }) => {
		if (!mapper) return new ErrorValue("map() needs an expression");
		const mapped: Value[] = [];
		const budget = budgetOf(env);
		for (const [index, value] of receiver.entries()) {
			budget.spend();
			const result = evaluateNode(mapper, env, row, { ...locals, value, index });
			if (result instanceof ErrorValue) return result;
			mapped.push(result);
		}
		return mapped;
	},
	reduce: (receiver, { env, row, locals, args: [reducer, initial] }) => {
		if (!reducer) return new ErrorValue("reduce() needs an expression");
		const budget = budgetOf(env);
		let acc = initial ? evaluateNode(initial, env, row, locals) : null;
		for (const [index, value] of receiver.entries()) {
			if (acc instanceof ErrorValue) return acc;
			budget.spend();
			acc = evaluateNode(reducer, env, row, { ...locals, value, index, acc });
		}
		return acc;
	},
};

/** The files a link, a file or a path written in `from` stands for. */
function targetFile(
	value: Value,
	from: ContentPage | undefined,
	env: EvalEnv,
): BaseFile | undefined {
	return (
		fileOf(value) ??
		(typeof value === "string" ? env.dataset.resolve(value, from ?? env.contextPage) : undefined)
	);
}

/**
 * Whether `file` links to `other`: to the file `other` resolves to, from
 * `file`'s folder; or, when it resolves to nothing, through a link whose text
 * is exactly `other` (`[[Missing Note]]` matches "Missing Note", not
 * "Missing Note.md").
 */
function fileLinksTo(file: BaseFile, other: Value, env: EvalEnv): boolean {
	const links = env.dataset.links(file);
	const target = targetFile(other, file.page, env);
	if (target) return links.some((link) => link.file === target);
	const written = other instanceof LinkValue ? other.target : other;
	return typeof written === "string" && links.some((link) => !link.file && link.target === written);
}

const LINK_METHODS: Record<string, Method<LinkValue>> = {
	asFile: (receiver) => (receiver.file ? new FileValue(receiver.file) : null),
	linksTo: (receiver, [other = null], { env }) =>
		receiver.file ? fileLinksTo(receiver.file, other, env) : false,
};

const FILE_METHODS: Record<string, Method<FileValue>> = {
	asLink: (receiver, [display], call) => toLink(receiver, display, call),
	hasLink: (receiver, [other = null], { env }) => fileLinksTo(receiver.file, other, env),
	hasProperty: (receiver, [name]) => Object.hasOwn(receiver.file.properties, text(name)),
	hasTag: (receiver, tags) => {
		const fileTags = receiver.file.tags.map((tag) => tag.toLowerCase());
		return tags.some((value) => {
			const wanted = text(value).replace(/^#/, "").toLowerCase();
			return fileTags.some((tag) => tag === wanted || tag.startsWith(`${wanted}/`));
		});
	},
	inFolder: (receiver, [folder]) => {
		const wanted = text(folder).replace(/^\/+|\/+$/g, "");
		const current = receiver.file.folder.replace(/^\/+|\/+$/g, "");
		return wanted === "" || current === wanted || current.startsWith(`${wanted}/`);
	},
};

const OBJECT_METHODS: Record<string, Method<ObjectValue>> = {
	keys: (receiver) => Object.keys(receiver.entries),
	values: (receiver) => Object.values(receiver.entries),
};

const REGEX_METHODS: Record<string, Method<RegexValue>> = {
	matches: (receiver, [value]) =>
		new RegExp(receiver.regex.source, receiver.regex.flags.replace(/[gy]/g, "")).test(text(value)),
};
