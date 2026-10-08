/**
 * Resource limits shared by the interpreters that run vault-written code
 * during a build: DataviewJS, DQL, Templater and Bases formulas.
 *
 * Obsidian runs a script until it finishes or the app runs out of memory. A
 * build must finish, so a value that would outgrow these limits, or a script
 * that keeps working past its budget, stops with an error naming the limit
 * instead of an out-of-memory crash or a hung build. Node-free.
 */

/** The longest text a script may build. */
export const MAX_TEXT_LENGTH = 10_000_000;
/** The longest list a script may build. */
export const MAX_LIST_LENGTH = 1_000_000;

const OBSIDIAN_HAS_NO_LIMIT = "Obsidian has no such limit, but a site build must finish";

/** A value or a run grew past a build limit. */
export class ResourceLimitError extends RangeError {
	constructor(message: string) {
		super(message);
		this.name = "ResourceLimitError";
	}
}

/** Throw unless a text of `length` characters fits the build. */
export function checkTextLength(length: number): void {
	if (length > MAX_TEXT_LENGTH) {
		throw new ResourceLimitError(
			`A text value would be ${length} characters long, over the limit of ${MAX_TEXT_LENGTH}; ${OBSIDIAN_HAS_NO_LIMIT}.`,
		);
	}
}

/** Throw unless a list of `length` items fits the build. */
export function checkListLength(length: number): void {
	if (length > MAX_LIST_LENGTH) {
		throw new ResourceLimitError(
			`A list would have ${length} items, over the limit of ${MAX_LIST_LENGTH}; ${OBSIDIAN_HAS_NO_LIMIT}.`,
		);
	}
}

/** Throw when `value` is a text or a list larger than the build allows. */
export function checkSize(value: unknown): void {
	if (typeof value === "string") checkTextLength(value.length);
	else if (Array.isArray(value)) checkListLength(value.length);
}

/** Lists nested deeper than this are counted as over any cap (a list holding itself is infinite). */
const MAX_COUNTED_DEPTH = 64;

/**
 * A value's size in {@link WorkBudget} units, counted only until it passes
 * `cap`: one unit per list item and per 16 characters of text, plus the size
 * of every list or text a list holds. A shared item counts every time it
 * appears, as it does when the value is rendered or joined: a list holding
 * the same long list a thousand times is a thousand long lists.
 */
function deepSize(value: unknown, cap: number, depth = 0): number {
	if (typeof value === "string") return value.length >> 4;
	if (!Array.isArray(value)) return 0;
	if (depth > MAX_COUNTED_DEPTH) return cap + 1;
	let total = 0;
	for (const item of value) {
		total += 1 + deepSize(item, cap - total, depth + 1);
		if (total > cap) break;
	}
	return total;
}

/**
 * What an operation built beyond its input, in {@link WorkBudget} units,
 * counted up to `cap`. The input counts only its own items, so copying a list
 * to append an item costs that item, while `list.map(() => list)` costs the
 * whole square.
 */
export function growthCost(result: unknown, input: unknown, cap: number): number {
	const own =
		typeof input === "string" ? input.length >> 4 : Array.isArray(input) ? input.length : 0;
	return Math.max(0, deepSize(result, cap + own) - own);
}

/** `text.repeat(count)`, refused before it allocates past the limit. */
export function repeatText(text: string, count: number): string {
	const times = Math.trunc(count);
	if (times > 0 && text.length > 0) checkTextLength(text.length * times);
	return text.repeat(times);
}

/** `text.padStart(length, fill)` (or `padEnd`), refused before it allocates past the limit. */
export function padText(text: string, length: number, fill: string, atEnd: boolean): string {
	if (fill !== "" && length > text.length) checkTextLength(Math.trunc(length));
	return atEnd ? text.padEnd(length, fill) : text.padStart(length, fill);
}

/**
 * `items.map(show).join(separator)`, stopping as soon as the joined text
 * would pass the limit, before the remaining items are even converted.
 */
export function joinTexts<T>(
	items: readonly T[],
	separator: string,
	show: (item: T) => string,
): string {
	const parts: string[] = [];
	let length = 0;
	for (const item of items) {
		const part = show(item);
		length += part.length + (parts.length > 0 ? separator.length : 0);
		checkTextLength(length);
		parts.push(part);
	}
	return parts.join(separator);
}

/** `left + right` for two texts, refused before a rope past the limit is built. */
export function concatTexts(left: string, right: string): string {
	checkTextLength(left.length + right.length);
	return left + right;
}

/** The lists joined end to end, refused before they are copied past the limit. */
export function concatLists<T>(lists: readonly (readonly T[])[]): T[] {
	checkListLength(lists.reduce((total, list) => total + list.length, 0));
	return lists.flat() as T[];
}

/** How many items `list.flat(depth)` would have, counted only up to just past the limit. */
function flatLength(list: readonly unknown[], depth: number, budget: number): number {
	let total = 0;
	for (const item of list) {
		total += Array.isArray(item) && depth > 0 ? flatLength(item, depth - 1, budget - total) : 1;
		if (total > budget) return total;
	}
	return total;
}

/**
 * `list.flat(depth)`, refused before it copies past the limit: a list of the
 * same long list repeated flattens into its square.
 */
export function flatList(list: readonly unknown[], depth: number): unknown[] {
	checkListLength(flatLength(list, depth, MAX_LIST_LENGTH));
	return list.flat(depth);
}

/** Visit the length of each match of `pattern` in `text`; `visit` throws to end the scan early. */
function eachMatch(
	text: string,
	pattern: RegExp | string,
	all: boolean,
	visit: (length: number) => void,
): void {
	if (typeof pattern === "string") {
		let from = text.indexOf(pattern);
		while (from >= 0) {
			visit(pattern.length);
			if (!all) return;
			from = text.indexOf(pattern, from + Math.max(1, pattern.length));
		}
		return;
	}
	// A single match's length is unknown without moving `lastIndex`; the whole text bounds it.
	if (!pattern.global) {
		if (text.search(pattern) >= 0) visit(text.length);
		return;
	}
	for (const match of text.matchAll(pattern)) visit(match[0].length);
}

/**
 * `text.replace(pattern, replacement)` (`replaceAll` with `all`), refused
 * before it builds a text past the limit. Each match is replaced by at most
 * the replacement, plus the match for each `$` reference, plus the whole text
 * for each `` $` `` or `$'`. Matches are only scanned when that bound, over
 * a match at every position, could pass the limit.
 */
export function replaceText(
	text: string,
	pattern: RegExp | string,
	replacement: string,
	all: boolean,
): string {
	const references = replacement.split("$").length - 1;
	const perMatch = replacement.length + (replacement.match(/\$[`']/g)?.length ?? 0) * text.length;
	const worst = text.length * (1 + references) + (text.length + 1) * perMatch;
	if (worst > MAX_TEXT_LENGTH) {
		let length = text.length;
		eachMatch(text, pattern, all, (matched) => {
			length += perMatch + references * matched;
			checkTextLength(length);
		});
	}
	return all ? text.replaceAll(pattern, replacement) : text.replace(pattern, replacement);
}

/**
 * A run's allowance of work: evaluation steps plus the {@link growthCost} of
 * what it builds. Spending past the allowance throws {@link ResourceLimitError}.
 */
export class WorkBudget {
	private spent = 0;

	constructor(
		private readonly limit: number,
		/** What ran, for the message: "The DataviewJS script". */
		private readonly subject: string,
	) {}

	spend(units = 1): void {
		this.spent += units;
		if (this.spent > this.limit) {
			throw new ResourceLimitError(
				`${this.subject} ran more than ${this.limit} steps and was stopped; ${OBSIDIAN_HAS_NO_LIMIT}.`,
			);
		}
	}

	/** Spend what `result` built beyond `input`. */
	charge(result: unknown, input: unknown): void {
		this.spend(growthCost(result, input, this.limit - this.spent + 1));
	}
}

/** Whether `error` is the engine's stack overflow ("Maximum call stack size exceeded"). */
export function isStackOverflow(error: unknown): boolean {
	return (
		error instanceof RangeError && /call stack|stack size|too much recursion/i.test(error.message)
	);
}

/** The message for a stack overflow inside an interpreter. */
export const STACK_OVERFLOW_MESSAGE =
	"The expression is nested too deeply or recurses too far to evaluate (the interpreter ran out of stack).";
