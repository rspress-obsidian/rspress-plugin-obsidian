import { concatTexts, joinTexts } from "../../interpreter-limits.js";

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
export const FORBIDDEN_IDENTIFIERS = new Set([
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
export const FORBIDDEN_PROPERTIES = new Set([
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

export const RESERVED_NAMES: Record<string, true> = {
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
// Values
// ---------------------------------------------------------------------------

export function isPlainObject(value: unknown): value is Record<string, unknown> {
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

export function toNumber(value: unknown): number {
	return Number(toPrimitive(value));
}

export function binary(op: string, left: unknown, right: unknown): unknown {
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

export function describe(value: unknown): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (Array.isArray(value)) return "an array";
	if (value instanceof Date) return "a date";
	if (value instanceof HostValue) return value.label;
	return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/** A value's own field — never an inherited one, so prototypes are unreachable. */
export function readProperty(value: unknown, property: string): unknown {
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

export function hasMethod(receiver: unknown, name: string): boolean {
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
