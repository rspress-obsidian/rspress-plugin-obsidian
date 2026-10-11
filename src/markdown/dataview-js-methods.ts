import {
	addDuration,
	compareValues,
	DataviewDuration,
	DataviewFunction,
	DataviewLink,
	isoWeek,
	luxonWeekday,
	valueToString,
} from "./dataview-values.js";
import {
	checkListLength,
	concatLists,
	concatTexts,
	flatList,
	joinTexts,
	padText,
	repeatText,
	replaceText,
	type WorkBudget,
} from "./interpreter-limits.js";

/** The `dv` object, a marker the evaluator dispatches API calls on. */
export const DV = Object.freeze({ kind: "dv" });
/** `dv.func`: every DQL function. */
export const DV_FUNC = Object.freeze({ kind: "dv.func" });
/** `Math`: a handful of pure helpers. */
export const MATH = Object.freeze({ kind: "Math" });

export function invoke(fn: unknown, args: unknown[]): unknown {
	if (!(fn instanceof DataviewFunction))
		throw new Error("DataviewJS: expected a function such as p => p.file.name.");
	return fn.invoke(args);
}

/** `String(value)` with Dataview's display for links, dates and durations. */
export function jsString(value: unknown): string {
	if (value === null || value === undefined || typeof value !== "object") return String(value);
	return valueToString(value);
}

function comparable(value: unknown): unknown {
	if (value instanceof Date) return value.getTime();
	if (value instanceof DataviewDuration) return value.toMillis();
	return value;
}

export function binary(op: string, left: unknown, right: unknown): unknown {
	switch (op) {
		case "===":
		case "==": {
			if (
				typeof left === "object" &&
				left !== null &&
				typeof right === "object" &&
				right !== null
			) {
				return compareValues(left, right) === 0;
			}
			return op === "==" && left == null && right == null
				? true
				: comparable(left) === comparable(right);
		}
		case "!==":
		case "!=":
			return !binary(op === "!==" ? "===" : "==", left, right);
		case "<":
		case "<=":
		case ">":
		case ">=": {
			const a = comparable(left);
			const b = comparable(right);
			const comparison =
				(typeof a === "number" && typeof b === "number") ||
				(typeof a === "string" && typeof b === "string")
					? a < b
						? -1
						: a > b
							? 1
							: 0
					: compareValues(left, right);
			if (op === "<") return comparison < 0;
			if (op === "<=") return comparison <= 0;
			if (op === ">") return comparison > 0;
			return comparison >= 0;
		}
		case "+":
			if (typeof left === "string" || typeof right === "string")
				return concatTexts(jsString(left), jsString(right));
			if (left instanceof Date && right instanceof DataviewDuration)
				return addDuration(left, right);
			if (typeof left === "number" && typeof right === "number") return left + right;
			break;
		case "-":
			if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime();
			if (left instanceof Date && right instanceof DataviewDuration)
				return addDuration(left, right, -1);
			if (typeof left === "number" && typeof right === "number") return left - right;
			break;
		case "*":
			if (typeof left === "number" && typeof right === "number") return left * right;
			break;
		case "/":
			if (typeof left === "number" && typeof right === "number") return left / right;
			break;
		case "%":
			if (typeof left === "number" && typeof right === "number") return left % right;
			break;
	}
	throw new Error(
		`DataviewJS: the ${op} operator does not apply to ${describe(left)} and ${describe(right)}.`,
	);
}

export function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	if (value instanceof Date) return "a date";
	if (value instanceof DataviewLink) return "a link";
	return typeof value === "object" ? "an object" : `a ${typeof value}`;
}

/** Luxon-style properties of a date, which `dv` scripts read off `file.mtime` and friends. */
function dateProperty(date: Date, name: string): unknown {
	switch (name) {
		case "year":
			return date.getFullYear();
		case "month":
			return date.getMonth() + 1;
		case "day":
			return date.getDate();
		case "hour":
			return date.getHours();
		case "minute":
			return date.getMinutes();
		case "second":
			return date.getSeconds();
		case "millisecond":
			return date.getMilliseconds();
		case "weekday":
			return luxonWeekday(date);
		case "weekNumber":
			return isoWeek(date).week;
		case "weekYear":
			return isoWeek(date).year;
		case "ts":
			return date.getTime();
		default:
			return undefined;
	}
}

/** A value's own field — never an inherited one, so prototypes are unreachable. */
export function readProperty(value: unknown, property: string): unknown {
	if (value === null || value === undefined) {
		throw new Error(`DataviewJS: cannot read "${property}" of ${value}.`);
	}
	if (Array.isArray(value)) {
		if (property === "length") return value.length;
		if (property === "values") return value;
		if (/^\d+$/.test(property)) return value[Number(property)];
		// `pages.file.name`: a field of every element, as Dataview's DataArray does.
		// Grown item by item: lists of the same long list would flatten into its square.
		const fields: unknown[] = [];
		for (const item of value) {
			if (item === null || item === undefined) continue;
			const field = readProperty(item, property);
			for (const entry of Array.isArray(field) ? field : [field]) {
				fields.push(entry);
				checkListLength(fields.length);
			}
		}
		return fields;
	}
	if (typeof value === "string") return property === "length" ? value.length : undefined;
	if (value instanceof Date) return dateProperty(value, property);
	if (value instanceof DataviewDuration) {
		return Object.hasOwn(value, property) ? Reflect.get(value, property) : undefined;
	}
	if (value instanceof DataviewLink) {
		if (
			property === "path" ||
			property === "display" ||
			property === "subpath" ||
			property === "embed" ||
			property === "type"
		) {
			return value[property];
		}
		return undefined;
	}
	if (value === DV || value === DV_FUNC || value === MATH || value instanceof DataviewFunction) {
		if (value === DV && property === "func") return DV_FUNC;
		return undefined;
	}
	if (typeof value === "object") {
		return Object.hasOwn(value, property) &&
			Object.prototype.propertyIsEnumerable.call(value, property)
			? Reflect.get(value, property)
			: undefined;
	}
	return undefined;
}

export function callStringMethod(text: string, name: string, args: unknown[]): unknown {
	const arg = (position: number) => String(args[position] ?? "");
	switch (name) {
		case "toUpperCase":
			return text.toUpperCase();
		case "toLowerCase":
			return text.toLowerCase();
		case "trim":
			return text.trim();
		case "includes":
			return text.includes(arg(0));
		case "startsWith":
			return text.startsWith(arg(0));
		case "endsWith":
			return text.endsWith(arg(0));
		case "indexOf":
			return text.indexOf(arg(0));
		case "slice":
			return text.slice(Number(args[0] ?? 0), args[1] === undefined ? undefined : Number(args[1]));
		case "substring":
			return text.substring(
				Number(args[0] ?? 0),
				args[1] === undefined ? undefined : Number(args[1]),
			);
		case "split":
			return text.split(arg(0));
		case "replace":
			return replaceText(text, arg(0), arg(1), false);
		case "replaceAll":
			return replaceText(text, arg(0), arg(1), true);
		case "padStart":
			return padText(text, Number(args[0] ?? 0), args[1] === undefined ? " " : arg(1), false);
		case "padEnd":
			return padText(text, Number(args[0] ?? 0), args[1] === undefined ? " " : arg(1), true);
		case "repeat":
			return repeatText(text, Math.max(0, Number(args[0] ?? 0)));
		case "charAt":
			return text.charAt(Number(args[0] ?? 0));
		case "toString":
			return text;
		case "localeCompare":
			return text.localeCompare(arg(0));
	}
	throw new Error(`Unsupported DataviewJS method: ${name}() on a string.`);
}

function sortKeyed(
	list: unknown[],
	key: (value: unknown) => unknown,
	descending: boolean,
): unknown[] {
	const keyed = list.map((value) => ({ value, key: key(value) }));
	keyed.sort((left, right) => {
		const comparison = compareValues(left.key, right.key);
		return descending ? -comparison : comparison;
	});
	return keyed.map((entry) => entry.value);
}

export function callArrayMethod(
	list: unknown[],
	name: string,
	args: unknown[],
	budget: WorkBudget,
): unknown {
	const fn = args[0];
	const apply = (value: unknown, index: number) => invoke(fn, [value, index]);
	switch (name) {
		case "where":
		case "filter":
			return list.filter((value, index) => Boolean(apply(value, index)));
		case "map":
			return list.map((value, index) => apply(value, index));
		case "flatMap": {
			// Grown item by item: a callback returning a long list each time would square it.
			const flattened: unknown[] = [];
			list.forEach((value, index) => {
				const result = apply(value, index);
				for (const entry of Array.isArray(result) ? result : [result]) {
					flattened.push(entry);
					checkListLength(flattened.length);
				}
			});
			return flattened;
		}
		case "forEach":
			list.forEach((value, index) => {
				apply(value, index);
			});
			return undefined;
		case "sort": {
			const key =
				fn === undefined ? (value: unknown) => value : (value: unknown) => invoke(fn, [value]);
			return sortKeyed(list, key, String(args[1] ?? "asc").toLowerCase() === "desc");
		}
		case "groupBy": {
			const groups: Array<{ key: unknown; rows: unknown[] }> = [];
			for (const value of sortKeyed(list, (item) => invoke(fn, [item]), false)) {
				const key = invoke(fn, [value]);
				const last = groups[groups.length - 1];
				if (last && compareValues(last.key, key) === 0) last.rows.push(value);
				else groups.push({ key, rows: [value] });
			}
			return groups;
		}
		case "distinct": {
			const result: unknown[] = [];
			const keys: unknown[] = [];
			for (const value of list) {
				const key = fn === undefined ? value : invoke(fn, [value]);
				// Each key is compared with every kept one: quadratic, so it is paid for.
				budget.spend(keys.length);
				if (keys.some((seen) => compareValues(seen, key) === 0)) continue;
				keys.push(key);
				result.push(value);
			}
			return result;
		}
		case "limit":
			return list.slice(0, Math.max(0, Number(args[0] ?? 0)));
		case "slice":
			return list.slice(Number(args[0] ?? 0), args[1] === undefined ? undefined : Number(args[1]));
		case "join":
			return joinTexts(list, args[0] === undefined ? ", " : String(args[0]), jsString);
		case "flat":
			return flatList(list, Math.max(0, Math.min(16, Number(args[0] ?? 1))));
		case "first":
			return list[0];
		case "last":
			return list[list.length - 1];
		case "find":
			return list.find((value, index) => Boolean(apply(value, index)));
		case "findIndex":
			return list.findIndex((value, index) => Boolean(apply(value, index)));
		case "includes":
			return list.some((value) => binary("===", value, args[0]));
		case "indexOf":
			return list.findIndex((value) => binary("===", value, args[0]));
		case "some":
		case "any":
			return list.some((value, index) => Boolean(apply(value, index)));
		case "every":
		case "all":
			return list.every((value, index) => Boolean(apply(value, index)));
		case "none":
			return !list.some((value, index) => Boolean(apply(value, index)));
		case "concat":
			return concatLists([list, ...args.map((arg) => (Array.isArray(arg) ? arg : [arg]))]);
		case "array":
			return [...list];
		case "reverse":
			return [...list].reverse();
	}
	throw new Error(`Unsupported DataviewJS collection method: ${name}.`);
}
