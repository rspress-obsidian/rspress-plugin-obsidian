/**
 * What DQL evaluation shares between the expression evaluator
 * (`dataview-expression.ts`) and the function library
 * (`dataview-functions.ts`): the evaluation context, the per-query work
 * budget, Dataview's binary operator table and its indexing rules
 * (`binaryop.ts` and `context.ts` of blacksmithgu/obsidian-dataview).
 */
import {
	addDuration,
	compareValues,
	type DataviewDuration,
	type DataviewLink,
	diffDates,
	isoWeek,
	isTruthy,
	luxonWeekday,
	typeOf,
	valueToString,
} from "./dataview-values.js";
import { concatLists, concatTexts, repeatText, WorkBudget } from "./interpreter-limits.js";

export type BinaryOp =
	| "+"
	| "-"
	| "*"
	| "/"
	| "%"
	| "="
	| "!="
	| "<"
	| "<="
	| ">"
	| ">="
	| "&"
	| "|";

/** What an expression is evaluated against, besides the row it reads. */
export interface EvalContext {
	/** Variables visible to every row: `this`, the current page. */
	globals: Record<string, unknown>;
	/** The build's clock for `date(today)`, `date(now)` and friends. */
	now: Date;
	/** The page values a link points at (indexing into a link), or `null`. */
	resolveLink(link: DataviewLink): Record<string, unknown> | null;
	/** The canonical target of a link, so `[[Alice]]` equals Alice's `file.link`. */
	normalizeLink(link: DataviewLink): string;
	/** The canonical path for a link written as text (`link("Alice")`). */
	normalizePath(path: string): string;
}

/** Lambda calls, and what they and the functions build, allowed per query. */
const MAX_QUERY_WORK = 50_000_000;
const budgets = new WeakMap<EvalContext, WorkBudget>();

/** The query's work budget: `map(xs, (x) => map(xs, …))` over long lists must still end. */
export function budgetOf(ctx: EvalContext): WorkBudget {
	let budget = budgets.get(ctx);
	if (!budget) {
		budget = new WorkBudget(MAX_QUERY_WORK, "The Dataview query");
		budgets.set(ctx, budget);
	}
	return budget;
}

export function normalizeResult(value: unknown): unknown {
	return value === undefined ? null : value;
}

/** Property names a date answers to (`date.year`, `file.mtime.hour`). */
function dateProperty(date: Date, name: string): unknown {
	switch (name) {
		case "year":
			return date.getFullYear();
		case "month":
			return date.getMonth() + 1;
		case "weekyear":
			return isoWeek(date).week;
		case "week":
			return Math.floor(date.getDate() / 7) + 1;
		case "weekday":
			return luxonWeekday(date);
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
		default:
			return null;
	}
}

const DURATION_PROPERTIES: Record<
	string,
	"years" | "months" | "weeks" | "days" | "hours" | "minutes" | "seconds" | "milliseconds"
> = {
	year: "years",
	years: "years",
	month: "months",
	months: "months",
	weeks: "weeks",
	day: "days",
	days: "days",
	hour: "hours",
	hours: "hours",
	minute: "minutes",
	minutes: "minutes",
	second: "seconds",
	seconds: "seconds",
	millisecond: "milliseconds",
	milliseconds: "milliseconds",
};

/** `object[index]` with Dataview's rules for each type. */
export function indexValue(object: unknown, index: string | number, ctx: EvalContext): unknown {
	switch (typeOf(object)) {
		case "object": {
			if (typeof index !== "string") {
				throw new Error('Can only index into objects with strings (a.b or a["b"]).');
			}
			const record = object as Record<string, unknown>;
			return Object.hasOwn(record, index) ? (record[index] ?? null) : null;
		}
		case "link": {
			if (typeof index !== "string") {
				throw new Error('Can only index into links with strings (a.b or a["b"]).');
			}
			const page = ctx.resolveLink(object as DataviewLink);
			return page && Object.hasOwn(page, index) ? (page[index] ?? null) : null;
		}
		case "array": {
			const list = object as unknown[];
			if (typeof index === "number")
				return index >= 0 && index < list.length ? (list[index] ?? null) : null;
			// `rows.file.link`: a string index maps over the elements ("swizzling").
			const result: unknown[] = [];
			for (const item of list) {
				try {
					result.push(indexValue(item, index, ctx));
				} catch {
					// Dataview drops elements that cannot be indexed.
				}
			}
			return result;
		}
		case "string": {
			if (typeof index !== "number") throw new Error("String indexing requires a numeric index.");
			const text = object as string;
			return index >= 0 && index < text.length ? (text[index] ?? null) : null;
		}
		case "date":
			if (typeof index !== "string") throw new Error("Date indexing requires a unit name.");
			return dateProperty(object as Date, index);
		case "duration": {
			if (typeof index !== "string") throw new Error("Duration indexing requires a unit name.");
			const unit = Object.hasOwn(DURATION_PROPERTIES, index)
				? DURATION_PROPERTIES[index]
				: undefined;
			return unit ? (object as DataviewDuration).as(unit) : null;
		}
		default:
			return null;
	}
}

const ARITHMETIC: Record<string, true> = { "+": true, "-": true, "*": true, "/": true, "%": true };

/** Dataview's binary operator table. */
export function binaryOp(op: BinaryOp, left: unknown, right: unknown, ctx: EvalContext): unknown {
	const leftType = typeOf(left);
	const rightType = typeOf(right);
	switch (op) {
		case "&":
			return isTruthy(left) && isTruthy(right);
		case "|":
			return isTruthy(left) || isTruthy(right);
		case "=":
		case "!=":
		case "<":
		case "<=":
		case ">":
		case ">=": {
			const comparison = compareValues(left, right, ctx.normalizeLink);
			if (op === "=") return comparison === 0;
			if (op === "!=") return comparison !== 0;
			if (op === "<") return comparison < 0;
			if (op === "<=") return comparison <= 0;
			if (op === ">") return comparison > 0;
			return comparison >= 0;
		}
	}
	if (op === "+" && (leftType === "string" || rightType === "string")) {
		return concatTexts(valueToString(left), valueToString(right));
	}
	// A missing field in arithmetic gives no value rather than a number.
	if (ARITHMETIC[op] && (leftType === "null" || rightType === "null")) return null;
	if (leftType === "number" && rightType === "number") {
		const a = left as number;
		const b = right as number;
		if (op === "+") return a + b;
		if (op === "-") return a - b;
		if (op === "*") return a * b;
		if (op === "/") return a / b;
		return a % b;
	}
	if (op === "*" && leftType === "string" && rightType === "number") {
		return (right as number) < 0 ? "" : repeatText(left as string, right as number);
	}
	if (op === "*" && leftType === "number" && rightType === "string") {
		return (left as number) < 0 ? "" : repeatText(right as string, left as number);
	}
	if (leftType === "date" && rightType === "duration" && (op === "+" || op === "-")) {
		return addDuration(left as Date, right as DataviewDuration, op === "+" ? 1 : -1);
	}
	if (leftType === "duration" && rightType === "date" && op === "+") {
		return addDuration(right as Date, left as DataviewDuration, 1);
	}
	if (leftType === "date" && rightType === "date" && op === "-") {
		return diffDates(left as Date, right as Date);
	}
	if (leftType === "duration" && rightType === "duration" && (op === "+" || op === "-")) {
		return (left as DataviewDuration)
			.plus(right as DataviewDuration, op === "+" ? 1 : -1)
			.normalize();
	}
	if (leftType === "duration" && rightType === "number" && (op === "*" || op === "/")) {
		const factor = right as number;
		return (left as DataviewDuration)
			.map((part) => (op === "*" ? part * factor : part / factor))
			.normalize();
	}
	if (leftType === "number" && rightType === "duration" && op === "*") {
		const factor = left as number;
		return (right as DataviewDuration).map((part) => part * factor).normalize();
	}
	if (leftType === "array" && rightType === "array" && op === "+") {
		return concatLists([left as unknown[], right as unknown[]]);
	}
	if (leftType === "object" && rightType === "object" && op === "+") {
		return { ...(left as object), ...(right as object) };
	}
	throw new Error(`No implementation found for '${leftType} ${op} ${rightType}'.`);
}
