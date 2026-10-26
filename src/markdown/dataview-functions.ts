/**
 * The DQL function library (`functions.ts` of blacksmithgu/obsidian-dataview),
 * shared by DQL expressions and DataviewJS's `dv.func`.
 */
import { escapeRegExp } from "../shared/escape.js";
import { assertSafeRegex } from "../shared/safe-regex.js";
import {
	type BinaryOp,
	binaryOp,
	budgetOf,
	type EvalContext,
	indexValue,
	normalizeResult,
} from "./dataview-operators.js";
import {
	compareValues,
	type DataviewDuration,
	DataviewExternalLink,
	DataviewFunction,
	DataviewLink,
	type DataviewType,
	dateShorthand,
	fileTitle,
	formatDuration,
	formatLuxonDate,
	isTruthy,
	parseDateLiteral,
	parseDuration,
	parseWithLuxonFormat,
	startOfDay,
	typeOf,
	valueToString,
} from "./dataview-values.js";
import { checkSize, flatList, joinTexts, padText, replaceText } from "./interpreter-limits.js";

type FunctionImpl = (ctx: EvalContext, args: unknown[]) => unknown;
type TypeSpec = DataviewType | "*";

/** Dataview's `FunctionBuilder`: typed variants, first match wins, optional vectorization. */
class FunctionBuilder {
	private readonly variants: Array<{ args: TypeSpec[] | "varargs"; impl: FunctionImpl }> = [];
	private readonly vectorized: Record<number, number[]> = {};

	constructor(private readonly name: string) {}

	add(args: TypeSpec[], impl: (args: unknown[], ctx: EvalContext) => unknown): this {
		this.variants.push({ args, impl: (ctx, values) => impl(values, ctx) });
		return this;
	}

	vararg(impl: (args: unknown[], ctx: EvalContext) => unknown): this {
		this.variants.push({ args: "varargs", impl: (ctx, values) => impl(values, ctx) });
		return this;
	}

	vectorize(count: number, positions: number[]): this {
		this.vectorized[count] = positions;
		return this;
	}

	build(): FunctionImpl {
		const self: FunctionImpl = (ctx, args) => {
			const types = args.map(typeOf);
			const positions = (this.vectorized[args.length] ?? []).filter(
				(position) => types[position] === "array",
			);
			if (positions.length > 0) {
				const length = Math.min(
					...positions.map((position) => (args[position] as unknown[]).length),
				);
				const result: unknown[] = [];
				for (let item = 0; item < length; item += 1) {
					result.push(
						self(
							ctx,
							args.map((arg, position) =>
								positions.includes(position) ? (arg as unknown[])[item] : arg,
							),
						),
					);
				}
				return result;
			}
			for (const variant of this.variants) {
				if (variant.args === "varargs") return variant.impl(ctx, args);
				if (variant.args.length !== types.length) continue;
				if (variant.args.every((type, position) => type === "*" || type === types[position])) {
					return variant.impl(ctx, args);
				}
			}
			throw new Error(
				`No implementation of '${this.name}' found for arguments: ${types.join(", ") || "none"}.`,
			);
		};
		return self;
	}
}

/** Vault-authored regexes run during the build: the subject is bounded too, as a backstop to the pattern check. */
const MAX_REGEX_SUBJECT_LENGTH = 10_000;

function compileRegex(pattern: string, flags: string, subject: string): RegExp {
	assertSafeRegex(pattern, flags);
	if (subject.length > MAX_REGEX_SUBJECT_LENGTH) {
		throw new Error(
			`Dataview regex subject is too long (${subject.length} characters, limit ${MAX_REGEX_SUBJECT_LENGTH}).`,
		);
	}
	try {
		return new RegExp(pattern, flags);
	} catch (error) {
		throw new Error(`Invalid Dataview pattern "${pattern}": ${(error as Error).message}`);
	}
}

const REGEX_SYNTAX = /[\\^$.*+?()[\]{}|]/;

/**
 * `split` on a Dataview pattern. A pattern without regex syntax matches exactly
 * its own text, and a plain-string split is several times faster than the
 * regex one; `split(text, "")` over long text in a lambda is the common case.
 * The pattern is still compiled first, for the same safety and length checks.
 */
function splitText(text: string, delimiter: string, limit: number | undefined): string[] {
	const pattern = compileRegex(delimiter, "", text);
	if (!REGEX_SYNTAX.test(delimiter)) return text.split(delimiter, limit);
	const parts = text.split(pattern, limit);
	// A capture group that took no part in a match splits out as `undefined`.
	for (let index = 0; index < parts.length; index += 1) parts[index] ??= "";
	return parts;
}

function call(fn: unknown, args: unknown[]): unknown {
	if (!(fn instanceof DataviewFunction)) throw new Error("Expected a function such as (x) => x.");
	return normalizeResult(fn.invoke(args));
}

function equals(left: unknown, right: unknown, ctx: EvalContext): boolean {
	return compareValues(left, right, ctx.normalizeLink) === 0;
}

function cyrb53(text: string, seed = 0): number {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let index = 0; index < text.length; index += 1) {
		const char = text.charCodeAt(index);
		h1 = Math.imul(h1 ^ char, 2654435761);
		h2 = Math.imul(h2 ^ char, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** `display()` / markdown-free text: `[[a|b]]` → b, `[[a]]` → a, emphasis markers dropped. */
function stripMarkdown(text: string): string {
	return text
		.replace(/!?\[\[([^\]|]*?)\|([^\]]*?)\]\]/g, "$2")
		.replace(/!?\[\[([^\]]*?)\]\]/g, "$1")
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/[*_~`]+/g, "")
		.replace(/==/g, "");
}

const NUMBER_IN_TEXT = /-?[0-9]+(\.[0-9]+)?/;

const contains: FunctionImpl = new FunctionBuilder("contains")
	.add(["array", "*"], ([list, item], ctx) =>
		(list as unknown[]).some((element) => contains(ctx, [element, item])),
	)
	.add(["string", "string"], ([text, part]) => (text as string).includes(part as string))
	.add(["object", "string"], ([object, key]) => Object.hasOwn(object as object, key as string))
	.add(["*", "*"], ([left, right], ctx) => equals(left, right, ctx))
	.vectorize(2, [1])
	.build();

const icontains: FunctionImpl = new FunctionBuilder("icontains")
	.add(["array", "*"], ([list, item], ctx) =>
		(list as unknown[]).some((element) => icontains(ctx, [element, item])),
	)
	.add(["string", "string"], ([text, part]) =>
		(text as string).toLocaleLowerCase().includes((part as string).toLocaleLowerCase()),
	)
	.add(["object", "string"], ([object, key]) => Object.hasOwn(object as object, key as string))
	.add(["*", "*"], ([left, right], ctx) => equals(left, right, ctx))
	.vectorize(2, [1])
	.build();

const min: FunctionImpl = new FunctionBuilder("min")
	.add(["*", "null"], ([value]) => value)
	.add(["null", "*"], ([, value]) => value)
	.add(["array"], ([list], ctx) => min(ctx, list as unknown[]))
	.add(["*", "*"], ([left, right], ctx) =>
		compareValues(left, right, ctx.normalizeLink) <= 0 ? left : right,
	)
	.vararg((args, ctx) =>
		args.length === 0 ? null : args.reduce((best, value) => min(ctx, [best, value])),
	)
	.build();

const max: FunctionImpl = new FunctionBuilder("max")
	.add(["*", "null"], ([value]) => value)
	.add(["null", "*"], ([, value]) => value)
	.add(["array"], ([list], ctx) => max(ctx, list as unknown[]))
	.add(["*", "*"], ([left, right], ctx) =>
		compareValues(left, right, ctx.normalizeLink) > 0 ? left : right,
	)
	.vararg((args, ctx) =>
		args.length === 0 ? null : args.reduce((best, value) => max(ctx, [best, value])),
	)
	.build();

function extremeBy(list: unknown[], fn: unknown, ctx: EvalContext, sign: 1 | -1): unknown {
	if (list.length === 0) return null;
	const mapped = list
		.map((value) => ({ value, key: call(fn, [value]) }))
		.filter((entry) => entry.key !== null);
	if (mapped.length === 0) return list[0];
	return mapped.reduce((best, entry) =>
		sign * compareValues(best.key, entry.key, ctx.normalizeLink) <= 0 ? best : entry,
	).value;
}

const reduce: FunctionImpl = new FunctionBuilder("reduce")
	.add(["array", "string"], ([list, op], ctx) => {
		const values = list as unknown[];
		if (values.length === 0) return null;
		if (!["+", "-", "*", "/", "&", "|"].includes(op as string)) {
			throw new Error("reduce(array, op) supports '+', '-', '/', '*', '&', and '|'.");
		}
		return values
			.slice(1)
			.reduce((total, value) => binaryOp(op as BinaryOp, total, value, ctx), values[0]);
	})
	.add(["array", "function"], ([list, fn]) => {
		const values = list as unknown[];
		if (values.length === 0) return null;
		let total = values[0];
		for (const value of values.slice(1)) {
			if (value === null || value === undefined) continue;
			total = call(fn, [total, value]);
		}
		return total;
	})
	.add(["null", "*"], () => null)
	.add(["*", "null"], () => null)
	.vectorize(2, [1])
	.build();

const sum: FunctionImpl = new FunctionBuilder("sum")
	.add(["array"], ([list], ctx) => reduce(ctx, [list, "+"]))
	.add(["*"], ([value]) => value)
	.build();

const truncate: FunctionImpl = new FunctionBuilder("truncate")
	.add(["string", "number", "string"], ([text, length, suffix]) => {
		const value = text as string;
		const end = (length as number) - (suffix as string).length;
		return value.length > end ? value.slice(0, Math.max(0, end)) + (suffix as string) : value;
	})
	.add(["string", "number"], ([text, length], ctx) => truncate(ctx, [text, length, "..."]))
	.add(["null", "*"], () => null)
	.add(["*", "null"], () => null)
	.add(["null", "*", "*"], () => null)
	.add(["*", "null", "*"], () => null)
	.add(["*", "*", "null"], () => null)
	.vectorize(2, [0, 1])
	.vectorize(3, [0, 1, 2])
	.build();

const join: FunctionImpl = new FunctionBuilder("join")
	.add(["array", "string"], ([list, separator]) =>
		joinTexts(list as unknown[], separator as string, valueToString),
	)
	.add(["array", "null"], ([list], ctx) => join(ctx, [list, ", "]))
	.add(["*", "string"], ([value]) => valueToString(value))
	.add(["array"], ([list], ctx) => join(ctx, [list, ", "]))
	.add(["*"], ([value]) => valueToString(value))
	.vectorize(2, [1])
	.build();

function nullary(
	name: string,
	impl: (value: unknown, ctx: EvalContext) => unknown,
	type: TypeSpec,
) {
	return new FunctionBuilder(name)
		.add([type], ([value], ctx) => impl(value, ctx))
		.add(["null"], () => null)
		.vectorize(1, [0])
		.build();
}

function stringPair(name: string, impl: (left: string, right: string) => unknown) {
	return new FunctionBuilder(name)
		.add(["string", "string"], ([left, right]) => impl(left as string, right as string))
		.add(["null", "*"], () => null)
		.add(["*", "null"], () => null)
		.vectorize(2, [0, 1])
		.build();
}

function padding(name: string, side: "start" | "end") {
	const pad = (text: unknown, length: unknown, fill: unknown) =>
		padText(text as string, length as number, fill as string, side === "end");
	return new FunctionBuilder(name)
		.add(["string", "number"], ([text, length]) => pad(text, length, " "))
		.add(["string", "number", "string"], ([text, length, fill]) => pad(text, length, fill))
		.add(["null", "*"], () => null)
		.add(["*", "null"], () => null)
		.add(["null", "*", "*"], () => null)
		.add(["*", "null", "*"], () => null)
		.add(["*", "*", "null"], () => null)
		.vectorize(2, [0, 1])
		.vectorize(3, [0, 1, 2])
		.build();
}

function linkTo(path: string, ctx: EvalContext, display?: string, embed = false): DataviewLink {
	return new DataviewLink(ctx.normalizePath(path), "file", undefined, display, embed);
}

const link: FunctionImpl = new FunctionBuilder("link")
	.add(["string"], ([path], ctx) => linkTo(path as string, ctx))
	.add(["link"], ([value]) => value)
	.add(["null"], () => null)
	.vectorize(1, [0])
	.add(["string", "string"], ([path, display], ctx) =>
		linkTo(path as string, ctx, display as string),
	)
	.add(["string", "string", "boolean"], ([path, display, embed], ctx) =>
		linkTo(path as string, ctx, display as string, embed as boolean),
	)
	.add(["link", "string"], ([value, display]) =>
		(value as DataviewLink).withDisplay(display as string),
	)
	.add(["null", "*"], () => null)
	.add(["*", "null"], ([value], ctx) => link(ctx, [value]))
	.vectorize(2, [0, 1])
	.build();

const elink: FunctionImpl = new FunctionBuilder("elink")
	.add(
		["string", "string"],
		([url, display]) => new DataviewExternalLink(url as string, display as string),
	)
	.add(["string", "null"], ([url]) => new DataviewExternalLink(url as string))
	.add(["null", "*"], () => null)
	.vectorize(2, [0])
	.add(["string"], ([url]) => new DataviewExternalLink(url as string))
	.add(["null"], () => null)
	.vectorize(1, [0])
	.build();

const dateFn: FunctionImpl = new FunctionBuilder("date")
	.add(["string"], ([text], ctx) => {
		const trimmed = (text as string).trim();
		return dateShorthand(trimmed, ctx.now) ?? parseDateLiteral(trimmed);
	})
	.add(["date"], ([value]) => value)
	.add(["link"], ([value], ctx) => {
		const target = value as DataviewLink;
		const fromText =
			(target.display && parseDateLiteral(target.display)) || parseDateLiteral(target.path);
		if (fromText) return fromText;
		const file = ctx.resolveLink(target)?.file;
		return file && typeof file === "object" && "day" in file ? (file.day ?? null) : null;
	})
	.add(["string", "string"], ([text, format]) => {
		if (format === "x" || format === "X") {
			const match = NUMBER_IN_TEXT.exec(text as string);
			if (!match) throw new Error(`Not a number for format (${format}): ${text}.`);
			return new Date(Number.parseInt(match[0], 10) * (format === "X" ? 1000 : 1));
		}
		const parsed = parseWithLuxonFormat(text as string, format as string);
		if (!parsed) throw new Error(`Can't handle format (${format}) on date string (${text}).`);
		return parsed;
	})
	.add(["null", "string"], () => null)
	.add(["null"], () => null)
	.vectorize(1, [0])
	.build();

/** The DQL function library, by lowercase name. */
const FUNCTIONS: Record<string, FunctionImpl> = {
	// Constructors
	object: (_ctx, args) => {
		if (args.length % 2 !== 0) throw new Error("object() requires an even number of arguments.");
		const entries: Array<[string, unknown]> = [];
		for (let index = 0; index < args.length; index += 2) {
			const key = args[index];
			if (typeof key !== "string") {
				throw new Error("Keys should be of type string for object(key1, value1, ...).");
			}
			entries.push([key, args[index + 1] ?? null]);
		}
		// `fromEntries` defines own properties: `object("__proto__", x)` is a key, not a prototype.
		return Object.fromEntries(entries);
	},
	list: (_ctx, args) => args,
	array: (_ctx, args) => args,
	date: dateFn,
	dur: new FunctionBuilder("dur")
		.add(["string"], ([text]) => parseDuration(text as string)?.normalize() ?? null)
		.add(["duration"], ([value]) => value)
		.add(["null"], () => null)
		.vectorize(1, [0])
		.build(),
	number: nullary(
		"number",
		(value) => {
			if (typeof value === "number") return value;
			const match = NUMBER_IN_TEXT.exec(value as string);
			return match ? Number.parseFloat(match[0]) : null;
		},
		"*",
	),
	string: new FunctionBuilder("string").add(["*"], ([value]) => valueToString(value)).build(),
	link,
	embed: new FunctionBuilder("embed")
		.add(["link"], ([value]) => (value as DataviewLink).withEmbed(true))
		.vectorize(1, [0])
		.add(["link", "boolean"], ([value, embed]) =>
			(value as DataviewLink).withEmbed(embed as boolean),
		)
		.add(["null"], () => null)
		.add(["null", "*"], () => null)
		.add(["*", "null"], () => null)
		.vectorize(2, [0, 1])
		.build(),
	elink,
	typeof: (_ctx, [value]) => {
		const type = typeOf(value);
		return type === "widget" ? "widget" : type;
	},

	// Numbers
	round: new FunctionBuilder("round")
		.add(["number"], ([value]) => Math.round(value as number))
		.add(["null"], () => null)
		.vectorize(1, [0])
		.add(["number", "number"], ([value, places]) =>
			(places as number) <= 0
				? Math.round(value as number)
				: Number.parseFloat((value as number).toFixed(places as number)),
		)
		.add(["number", "null"], ([value]) => Math.round(value as number))
		.add(["null", "*"], () => null)
		.vectorize(2, [0])
		.build(),
	trunc: nullary("trunc", (value) => Math.trunc(value as number), "number"),
	floor: nullary("floor", (value) => Math.floor(value as number), "number"),
	ceil: nullary("ceil", (value) => Math.ceil(value as number), "number"),
	min,
	max,
	sum,
	product: new FunctionBuilder("product")
		.add(["array"], ([list], ctx) => reduce(ctx, [list, "*"]))
		.add(["*"], ([value]) => value)
		.build(),
	average: new FunctionBuilder("average")
		.add(["array"], ([list], ctx) => {
			const values = list as unknown[];
			if (values.length === 0) return null;
			const total = sum(ctx, [values]);
			return total === null || total === undefined
				? null
				: binaryOp("/", total, values.length, ctx);
		})
		.add(["*"], ([value]) => value)
		.build(),
	minby: new FunctionBuilder("minby")
		.add(["array", "function"], ([list, fn], ctx) => extremeBy(list as unknown[], fn, ctx, 1))
		.add(["null", "function"], () => null)
		.build(),
	maxby: new FunctionBuilder("maxby")
		.add(["array", "function"], ([list, fn], ctx) => extremeBy(list as unknown[], fn, ctx, -1))
		.add(["null", "function"], () => null)
		.build(),

	// Objects, arrays and strings
	contains,
	icontains,
	econtains: new FunctionBuilder("econtains")
		.add(["array", "*"], ([list, item], ctx) =>
			(list as unknown[]).some((element) => equals(item, element, ctx)),
		)
		.add(["string", "string"], ([text, part]) => (text as string).includes(part as string))
		.add(["object", "string"], ([object, key]) => Object.hasOwn(object as object, key as string))
		.add(["*", "*"], ([left, right], ctx) => equals(left, right, ctx))
		.vectorize(2, [1])
		.build(),
	containsword: stringPair("containsword", (text, word) =>
		new RegExp(`\\b${escapeRegExp(word)}\\b`, "i").test(text),
	),
	extract: (ctx, args) => {
		const [object, ...keys] = args;
		const pick = (value: unknown): unknown =>
			Object.fromEntries(
				keys.map((key) => {
					if (typeof key !== "string")
						throw new Error("extract(object, key1, ...) must be called with string keys.");
					return [key, indexValue(value, key, ctx)];
				}),
			);
		return Array.isArray(object) ? object.map(pick) : pick(object);
	},
	sort: new FunctionBuilder("sort")
		.add(["array"], ([list], ctx) =>
			[...(list as unknown[])].sort((left, right) => compareValues(left, right, ctx.normalizeLink)),
		)
		.add(["array", "function"], ([list, fn], ctx) =>
			[...(list as unknown[])]
				.map((value) => ({ value, key: call(fn, [value]) }))
				.sort((left, right) => compareValues(left.key, right.key, ctx.normalizeLink))
				.map((entry) => entry.value),
		)
		.add(["*"], ([value]) => value)
		.build(),
	reverse: new FunctionBuilder("reverse")
		.add(["array"], ([list]) => [...(list as unknown[])].reverse())
		.add(["string"], ([text]) => [...(text as string)].reverse().join(""))
		.add(["*"], ([value]) => value)
		.build(),
	length: new FunctionBuilder("length")
		.add(["array"], ([list]) => (list as unknown[]).length)
		.add(["object"], ([object]) => Object.keys(object as object).length)
		.add(["string"], ([text]) => (text as string).length)
		.add(["null"], () => 0)
		.build(),
	nonnull: new FunctionBuilder("nonnull")
		.add(["array"], ([list]) =>
			(list as unknown[]).filter((value) => value !== null && value !== undefined),
		)
		.vararg((args) => args.filter((value) => value !== null && value !== undefined))
		.build(),
	firstvalue: new FunctionBuilder("firstvalue")
		.add(
			["array"],
			([list]) =>
				(list as unknown[]).find((value) => value !== null && value !== undefined) ?? null,
		)
		.add(["null"], () => null)
		.build(),
	all: new FunctionBuilder("all")
		.add(["array"], ([list]) => (list as unknown[]).every(isTruthy))
		.add(["array", "function"], ([list, fn]) =>
			(list as unknown[]).every((value) => isTruthy(call(fn, [value]))),
		)
		.vararg((args) => args.every(isTruthy))
		.build(),
	any: new FunctionBuilder("any")
		.add(["array"], ([list]) => (list as unknown[]).some(isTruthy))
		.add(["array", "function"], ([list, fn]) =>
			(list as unknown[]).some((value) => isTruthy(call(fn, [value]))),
		)
		.vararg((args) => args.some(isTruthy))
		.build(),
	none: new FunctionBuilder("none")
		.add(["array"], ([list]) => !(list as unknown[]).some(isTruthy))
		.add(
			["array", "function"],
			([list, fn]) => !(list as unknown[]).some((value) => isTruthy(call(fn, [value]))),
		)
		.vararg((args) => !args.some(isTruthy))
		.build(),
	join,
	filter: new FunctionBuilder("filter")
		.add(["array", "function"], ([list, fn]) =>
			(list as unknown[]).filter((value) => isTruthy(call(fn, [value]))),
		)
		.add(["null", "*"], () => null)
		.build(),
	map: new FunctionBuilder("map")
		.add(["array", "function"], ([list, fn]) =>
			(list as unknown[]).map((value) => call(fn, [value])),
		)
		.add(["null", "*"], () => null)
		.build(),
	flat: new FunctionBuilder("flat")
		.add(["array"], ([list]) => flatList(list as unknown[], 1))
		.add(["array", "number"], ([list, depth]) => flatList(list as unknown[], depth as number))
		.add(["null"], () => null)
		.build(),
	slice: new FunctionBuilder("slice")
		.add(["array"], ([list]) => [...(list as unknown[])])
		.add(["array", "number"], ([list, start]) => (list as unknown[]).slice(start as number))
		.add(["array", "number", "number"], ([list, start, end]) =>
			(list as unknown[]).slice(start as number, end as number),
		)
		.add(["null"], () => null)
		.build(),
	unique: new FunctionBuilder("unique")
		.add(["array"], ([list], ctx) => {
			const result: unknown[] = [];
			const budget = budgetOf(ctx);
			for (const value of list as unknown[]) {
				// Each value is compared with every kept one: quadratic, so it is paid for.
				budget.spend(result.length);
				if (!result.some((seen) => equals(seen, value, ctx))) result.push(value);
			}
			return result;
		})
		.add(["null"], () => null)
		.build(),
	reduce,

	// Strings
	regextest: new FunctionBuilder("regextest")
		.add(["string", "string"], ([pattern, text]) =>
			compileRegex(pattern as string, "", text as string).test(text as string),
		)
		.add(["null", "*"], () => false)
		.add(["*", "null"], () => false)
		.vectorize(2, [0, 1])
		.build(),
	regexmatch: new FunctionBuilder("regexmatch")
		.add(["string", "string"], ([pattern, text]) => {
			let source = pattern as string;
			if (!source.startsWith("^") && !source.endsWith("$")) source = `^${source}$`;
			return compileRegex(source, "", text as string).test(text as string);
		})
		.add(["null", "*"], () => false)
		.add(["*", "null"], () => false)
		.vectorize(2, [0, 1])
		.build(),
	regexreplace: new FunctionBuilder("regexreplace")
		.add(["string", "string", "string"], ([text, pattern, replacement]) =>
			replaceText(
				text as string,
				compileRegex(pattern as string, "g", text as string),
				replacement as string,
				true,
			),
		)
		.add(["null", "*", "*"], () => null)
		.add(["*", "null", "*"], () => null)
		.add(["*", "*", "null"], () => null)
		.vectorize(3, [0, 1, 2])
		.build(),
	replace: new FunctionBuilder("replace")
		.add(["string", "string", "string"], ([text, pattern, replacement]) =>
			joinTexts((text as string).split(pattern as string), replacement as string, String),
		)
		.add(["null", "*", "*"], () => null)
		.add(["*", "null", "*"], () => null)
		.add(["*", "*", "null"], () => null)
		.vectorize(3, [0, 1, 2])
		.build(),
	lower: nullary("lower", (value) => (value as string).toLocaleLowerCase(), "string"),
	upper: nullary("upper", (value) => (value as string).toLocaleUpperCase(), "string"),
	split: new FunctionBuilder("split")
		.add(["string", "string"], ([text, delimiter]) =>
			splitText(text as string, delimiter as string, undefined),
		)
		.add(["string", "string", "number"], ([text, delimiter, limit]) =>
			splitText(text as string, delimiter as string, limit as number),
		)
		.add(["null", "*"], () => null)
		.add(["*", "null"], () => null)
		.add(["*", "*", "null"], () => null)
		.add(["*", "null", "*"], () => null)
		.add(["null", "*", "*"], () => null)
		.build(),
	startswith: stringPair("startswith", (text, prefix) => text.startsWith(prefix)),
	endswith: stringPair("endswith", (text, suffix) => text.endsWith(suffix)),
	padleft: padding("padleft", "start"),
	padright: padding("padright", "end"),
	substring: new FunctionBuilder("substring")
		.add(["string", "number"], ([text, start]) => (text as string).substring(start as number))
		.add(["string", "number", "number"], ([text, start, end]) =>
			(text as string).substring(start as number, end as number),
		)
		.add(["null", "*"], () => null)
		.add(["*", "null"], () => null)
		.add(["null", "*", "*"], () => null)
		.add(["*", "null", "*"], () => null)
		.add(["*", "*", "null"], () => null)
		.vectorize(2, [0, 1])
		.vectorize(3, [0, 1, 2])
		.build(),
	truncate,

	// Utilities
	default: new FunctionBuilder("default")
		.add(["*", "*"], ([value, fallback]) =>
			value === null || value === undefined ? fallback : value,
		)
		.vectorize(2, [0, 1])
		.build(),
	ldefault: new FunctionBuilder("ldefault")
		.add(["*", "*"], ([value, fallback]) =>
			value === null || value === undefined ? fallback : value,
		)
		.build(),
	display: (_ctx, [value]) => {
		const show = (item: unknown): string => {
			if (item === null || item === undefined) return "";
			if (Array.isArray(item)) return item.map(show).join(", ");
			if (typeof item === "string") return stripMarkdown(item);
			if (item instanceof DataviewLink)
				return item.display ? stripMarkdown(item.display) : fileTitle(item.path);
			return valueToString(item);
		};
		return show(value);
	},
	choice: new FunctionBuilder("choice")
		.add(["*", "*", "*"], ([condition, left, right]) => (isTruthy(condition) ? left : right))
		.vectorize(3, [0])
		.build(),
	striptime: nullary("striptime", (value) => startOfDay(value as Date), "date"),
	dateformat: new FunctionBuilder("dateformat")
		.add(["date", "string"], ([date, format]) => formatLuxonDate(date as Date, format as string))
		.add(["null", "string"], () => null)
		.vectorize(2, [0])
		.build(),
	durationformat: new FunctionBuilder("durationformat")
		.add(["duration", "string"], ([duration, format]) =>
			formatDuration(duration as DataviewDuration, format as string),
		)
		.add(["null", "string"], () => null)
		.vectorize(2, [0])
		.build(),
	currencyformat: new FunctionBuilder("currencyformat")
		.add(["number", "string"], ([amount, currency]) =>
			new Intl.NumberFormat("en-US", { style: "currency", currency: currency as string }).format(
				amount as number,
			),
		)
		.add(["null", "string"], () => null)
		.add(["number"], ([amount]) =>
			new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
				amount as number,
			),
		)
		.add(["null"], () => null)
		.vectorize(2, [0])
		.build(),
	// Dates are already read in the build's local zone.
	localtime: nullary("localtime", (value) => value, "date"),
	hash: new FunctionBuilder("hash")
		.add(["string", "number"], ([seed, variant]) => cyrb53(seed as string, variant as number))
		.add(["string", "string"], ([seed, text]) => cyrb53((seed as string) + (text as string)))
		.add(["string", "string", "number"], ([seed, text, variant]) =>
			cyrb53((seed as string) + (text as string), variant as number),
		)
		.build(),
	meta: new FunctionBuilder("meta")
		.add(["link"], ([value]) => {
			const target = value as DataviewLink;
			return {
				display: target.display ?? null,
				embed: target.embed,
				path: target.path,
				subpath: target.subpath ?? null,
				type: target.type,
			};
		})
		.build(),
};

/** Call a DQL function by name (DataviewJS `dv.func.<name>` uses the same library). */
export function callDataviewFunction(name: string, ctx: EvalContext, args: unknown[]): unknown {
	const key = name.toLowerCase();
	// Own keys only: `constructor(…)` must not reach Object.
	const impl = Object.hasOwn(FUNCTIONS, key) ? FUNCTIONS[key] : undefined;
	if (!impl) throw new Error(`Unsupported Dataview function: ${name}.`);
	const result = normalizeResult(impl(ctx, args));
	checkSize(result);
	budgetOf(ctx).charge(result, args[0]);
	return result;
}
