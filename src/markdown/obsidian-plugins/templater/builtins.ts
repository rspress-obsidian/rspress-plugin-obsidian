import { checkListLength } from "../../interpreter-limits.js";
import type { Runtime } from "./interpreter.js";
import {
	describe,
	FORBIDDEN_PROPERTIES,
	HostFunction,
	HostObject,
	HostValue,
	isPlainObject,
	TemplaterError,
	toNumber,
	toTemplateString,
} from "./values.js";

// ---------------------------------------------------------------------------
// Built-in globals
// ---------------------------------------------------------------------------

/**
 * `new Date(…)`: the template's clock when called without arguments, so a
 * build with a pinned `now` is reproducible.
 */
export function constructDate(args: unknown[], rt: Runtime): Date {
	if (args.length === 0) return new Date(rt.now.getTime());
	if (args.length === 1) {
		const value = args[0];
		if (value instanceof Date) return new Date(value.getTime());
		if (typeof value === "number" || typeof value === "string") return new Date(value);
		return new Date(toNumber(value));
	}
	const parts = args.map((value) => toNumber(value));
	return new Date(
		parts[0] ?? 0,
		parts[1] ?? 0,
		parts[2] ?? 1,
		parts[3] ?? 0,
		parts[4] ?? 0,
		parts[5] ?? 0,
		parts[6] ?? 0,
	);
}

const MATH_FUNCTIONS: Record<string, (...values: number[]) => number> = {
	round: Math.round,
	floor: Math.floor,
	ceil: Math.ceil,
	trunc: Math.trunc,
	abs: Math.abs,
	sign: Math.sign,
	sqrt: Math.sqrt,
	cbrt: Math.cbrt,
	pow: Math.pow,
	min: Math.min,
	max: Math.max,
	log: Math.log,
	log10: Math.log10,
	log2: Math.log2,
	exp: Math.exp,
	sin: Math.sin,
	cos: Math.cos,
	tan: Math.tan,
};

/**
 * Plain data for `JSON.stringify`: host values become their display string.
 * `seen` counts the values copied: lists that hold the same long list again
 * and again would otherwise copy into its square.
 */
function toJsonValue(value: unknown, seen = { values: 0 }): unknown {
	seen.values += 1;
	checkListLength(seen.values);
	if (value === null || typeof value !== "object") {
		return value instanceof HostFunction ? undefined : value;
	}
	if (Array.isArray(value)) return value.map((item) => toJsonValue(item, seen) ?? null);
	if (value instanceof Date) return value.toISOString();
	if (value instanceof HostFunction) return undefined;
	if (value instanceof HostValue) return value.toTemplateString();
	if (isPlainObject(value)) {
		return Object.fromEntries(
			Object.entries(value)
				.map(([key, item]) => [key, toJsonValue(item, seen)] as const)
				.filter(([, item]) => item !== undefined),
		);
	}
	return undefined;
}

function plainEntries(value: unknown): Array<[string, unknown]> {
	if (value instanceof HostObject) return value.keys().map((key) => [key, value.property(key)]);
	if (isPlainObject(value)) return Object.entries(value);
	if (Array.isArray(value)) return value.map((item, index) => [String(index), item]);
	throw new TemplaterError(`Expected an object, got ${describe(value)}.`);
}

export const BUILTINS: Record<string, unknown> = {
	Math: new HostObject(
		"Math",
		{
			...Object.fromEntries(
				Object.entries(MATH_FUNCTIONS).map(([name, fn]) => [
					name,
					new HostFunction(`Math.${name}`, (args) => fn(...args.map((value) => toNumber(value)))),
				]),
			),
			PI: Math.PI,
			E: Math.E,
		},
		(name) =>
			name === "random"
				? new HostFunction("Math.random", () => {
						throw new TemplaterError(
							"Math.random() is not available: a published page must be the same on every build.",
						);
					})
				: undefined,
	),
	JSON: new HostObject("JSON", {
		stringify: new HostFunction("JSON.stringify", ([value, , indent]) =>
			JSON.stringify(
				toJsonValue(value),
				null,
				typeof indent === "number" || typeof indent === "string" ? indent : undefined,
			),
		),
		parse: new HostFunction("JSON.parse", ([text]) => {
			try {
				return JSON.parse(toTemplateString(text));
			} catch (error) {
				throw new TemplaterError(`JSON.parse: ${messageOf(error)}`);
			}
		}),
	}),
	Object: new HostObject("Object", {
		keys: new HostFunction("Object.keys", ([value]) => plainEntries(value).map(([key]) => key)),
		values: new HostFunction("Object.values", ([value]) =>
			plainEntries(value).map(([, item]) => item),
		),
		entries: new HostFunction("Object.entries", ([value]) =>
			plainEntries(value).map(([key, item]) => [key, item]),
		),
		fromEntries: new HostFunction("Object.fromEntries", ([value]) => {
			if (!Array.isArray(value)) throw new TemplaterError("Object.fromEntries() needs an array.");
			return Object.fromEntries(
				value.map((entry) => {
					const [key, item] = Array.isArray(entry) ? entry : [];
					const name = toTemplateString(key);
					if (FORBIDDEN_PROPERTIES.has(name)) {
						throw new TemplaterError(`\`${name}\` is not available to templates.`);
					}
					return [name, item];
				}),
			);
		}),
	}),
	Array: new HostObject("Array", {
		isArray: new HostFunction("Array.isArray", ([value]) => Array.isArray(value)),
	}),
	String: new HostFunction("String", ([value]) =>
		value === undefined ? "" : toTemplateString(value),
	),
	Number: new HostFunction("Number", ([value]) => toNumber(value ?? 0)),
	Boolean: new HostFunction("Boolean", ([value]) => Boolean(value)),
	parseInt: new HostFunction("parseInt", ([value, radix]) =>
		Number.parseInt(toTemplateString(value), radix === undefined ? undefined : Number(radix)),
	),
	parseFloat: new HostFunction("parseFloat", ([value]) =>
		Number.parseFloat(toTemplateString(value)),
	),
	isNaN: new HostFunction("isNaN", ([value]) => Number.isNaN(toNumber(value))),
	// Logging goes nowhere: a static build has no console to show it in.
	console: new HostObject("console", {}, (name) =>
		["log", "info", "warn", "error", "debug"].includes(name)
			? new HostFunction(`console.${name}`, () => undefined)
			: undefined,
	),
};

export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
