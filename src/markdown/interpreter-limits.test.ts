import { describe, expect, test } from "bun:test";
import {
	checkSize,
	concatLists,
	concatTexts,
	flatList,
	growthCost,
	isStackOverflow,
	joinTexts,
	MAX_LIST_LENGTH,
	MAX_TEXT_LENGTH,
	padText,
	ResourceLimitError,
	repeatText,
	replaceText,
	WorkBudget,
} from "./interpreter-limits";

describe("text limits", () => {
	test("repeat and pad behave as JavaScript's below the limit", () => {
		expect(repeatText("ab", 3)).toBe("ababab");
		expect(repeatText("ab", 2.9)).toBe("abab");
		expect(repeatText("ab", Number.NaN)).toBe("");
		expect(repeatText("", 1e12)).toBe("");
		expect(padText("7", 3, "0", false)).toBe("007");
		expect(padText("7", 3, "!", true)).toBe("7!!");
		expect(padText("7", 1e12, "", false)).toBe("7");
	});

	test("repeat and pad refuse a huge result before allocating it", () => {
		expect(() => repeatText("x", 1e9)).toThrow(ResourceLimitError);
		expect(() => repeatText("x", 1e9)).toThrow(
			`A text value would be 1000000000 characters long, over the limit of ${MAX_TEXT_LENGTH}; Obsidian has no such limit`,
		);
		expect(() => padText("x", 1e9, " ", false)).toThrow(ResourceLimitError);
		expect(() => padText("x", 1e9, " ", true)).toThrow(ResourceLimitError);
	});

	test("concatenation and joins stop at the limit", () => {
		const big = "x".repeat(MAX_TEXT_LENGTH / 2 + 1);
		expect(concatTexts("a", "b")).toBe("ab");
		expect(() => concatTexts(big, big)).toThrow(ResourceLimitError);
		expect(joinTexts([1, 2, 3], "-", String)).toBe("1-2-3");
		let converted = 0;
		expect(() =>
			joinTexts(
				Array.from({ length: 100 }, () => big),
				",",
				(item) => {
					converted += 1;
					return item;
				},
			),
		).toThrow(ResourceLimitError);
		// It stopped at the item that crossed the limit, not after converting all of them.
		expect(converted).toBe(2);
	});

	test("replace keeps JavaScript's semantics and refuses a blow-up, `$` references included", () => {
		expect(replaceText("a-b-c", "-", "+", false)).toBe("a+b-c");
		expect(replaceText("a-b-c", "-", "+", true)).toBe("a+b+c");
		expect(replaceText("John Smith", /(\w+) (\w+)/, "$2, $1", false)).toBe("Smith, John");
		expect(replaceText("aaa", /a/g, "$&$&", false)).toBe("aaaaaa");
		expect(replaceText("x".repeat(2_000_000), "y", "z".repeat(100), true)).toHaveLength(2_000_000);
		const text = "a".repeat(100_000);
		expect(() => replaceText(text, /a/g, "b".repeat(1000), false)).toThrow(ResourceLimitError);
		expect(() => replaceText(text, "a", "b".repeat(1000), true)).toThrow(ResourceLimitError);
		// `$\`` repeats everything before each match: quadratic in the text.
		expect(() => replaceText("a".repeat(10_000), /a/g, "$`", false)).toThrow(ResourceLimitError);
		expect(() =>
			replaceText("a".repeat(20_000), /a/, "$'$'$'$'$'$'$'$'$'$'$'$'", false),
		).not.toThrow();
		expect(() => replaceText("a".repeat(6_000_000), /a/, "$'$'", false)).toThrow(
			ResourceLimitError,
		);
	});
});

describe("list limits", () => {
	test("concatenation and flattening refuse a list past the limit", () => {
		expect(concatLists([[1], [2, 3]])).toEqual([1, 2, 3]);
		const half = new Array(MAX_LIST_LENGTH / 2 + 1).fill(0);
		expect(() => concatLists([half, half])).toThrow(ResourceLimitError);
		expect(flatList([1, [2, [3, [4]]]], 1)).toEqual([1, 2, [3, [4]]]);
		expect(flatList([1, [2, [3, [4]]]], Number.POSITIVE_INFINITY)).toEqual([1, 2, 3, 4]);
		// The same thousand-item list a thousand times over flattens into a million and more;
		// counting stops one item past the limit.
		const thousand = new Array(1000).fill(0);
		const square = new Array(1001).fill(thousand);
		expect(() => flatList(square, 1)).toThrow(`A list would have ${MAX_LIST_LENGTH + 1} items`);
	});

	test("checkSize accepts what fits and names what does not", () => {
		expect(() => checkSize(new Array(MAX_LIST_LENGTH).fill(0))).not.toThrow();
		expect(() => checkSize(new Array(MAX_LIST_LENGTH + 1).fill(0))).toThrow(ResourceLimitError);
		expect(() => checkSize(42)).not.toThrow();
	});
});

describe("work budget", () => {
	test("spending past the allowance stops the run with its subject named", () => {
		const budget = new WorkBudget(3, "The script");
		budget.spend(3);
		expect(() => budget.spend()).toThrow(
			"The script ran more than 3 steps and was stopped; Obsidian has no such limit",
		);
	});

	test("growth charges what a value holds beyond its input's own items", () => {
		const list = new Array(1000).fill(1);
		// Appending one item to a copy costs that item.
		expect(growthCost([...list, 2], list, 1e9)).toBe(1);
		// A list of the same list a hundred times costs the whole square.
		expect(growthCost(new Array(100).fill(list), list, 1e9)).toBe(100 * 1001 - 1000);
		// Text counts a unit per 16 characters.
		expect(growthCost("x".repeat(160), undefined, 1e9)).toBe(10);
		// The count stops once past the cap, and a list holding itself is never finished.
		expect(growthCost(new Array(1000).fill(list), undefined, 5000)).toBeLessThan(10_000);
		const cyclic: unknown[] = [];
		cyclic.push(cyclic);
		expect(growthCost(cyclic, undefined, 50)).toBeGreaterThan(50);
	});

	test("charge spends a result's growth", () => {
		const budget = new WorkBudget(1500, "The formula");
		budget.charge(new Array(1000).fill(0), undefined);
		expect(() => budget.charge(new Array(1000).fill(0), undefined)).toThrow(ResourceLimitError);
	});
});

describe("isStackOverflow", () => {
	test("recognises the engine's stack overflow, and only that", () => {
		const recurse = (depth: number): number => recurse(depth + 1) + 1;
		let overflow: unknown;
		try {
			recurse(0);
		} catch (error) {
			overflow = error;
		}
		expect(isStackOverflow(overflow)).toBe(true);
		expect(isStackOverflow(new RangeError("Invalid array length"))).toBe(false);
		expect(isStackOverflow(new Error("Maximum call stack size exceeded"))).toBe(false);
	});
});
