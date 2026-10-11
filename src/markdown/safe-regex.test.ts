import { describe, expect, test } from "bun:test";
import {
	assertSafeRegex,
	compileSafeRegex,
	MAX_REGEX_PATTERN_LENGTH,
	UnsafeRegexError,
} from "./safe-regex";

const refused = (pattern: string) => {
	try {
		assertSafeRegex(pattern);
		return undefined;
	} catch (error) {
		expect(error).toBeInstanceOf(UnsafeRegexError);
		return (error as Error).message;
	}
};

describe("assertSafeRegex", () => {
	test("refuses the catastrophic-backtracking shapes, and says Obsidian would run them", () => {
		for (const pattern of [
			"(a+)+$",
			"(a*)*b",
			"(?:\\w+\\s?)+$",
			"((a+))+",
			"(?<word>x+)*y",
			"(a+b){2,}",
			"(a{1,})+",
			"(a|b+)*c",
			"a{2}*",
			"a+*",
		]) {
			const message = refused(pattern);
			expect(message).toContain("nested quantifiers");
			expect(message).toContain("catastrophic backtracking");
			expect(message).toContain("Obsidian would run it");
		}
	});

	test("lets ordinary patterns through, including lazy and optional quantifiers", () => {
		for (const pattern of [
			"^\\d{4}-\\d{2}-\\d{2}$",
			"(ab)+",
			"(a?)+",
			"a+?b*?",
			"(?:foo|bar)*",
			"[(+*)]+",
			"\\(a+\\)+",
			"x{,5}",
			"(a+){1}",
			"(a+)?",
			"[^\\]]+",
		]) {
			expect(refused(pattern)).toBeUndefined();
		}
	});

	test("refuses a pattern over the length limit", () => {
		expect(refused("a".repeat(MAX_REGEX_PATTERN_LENGTH))).toBeUndefined();
		expect(refused("a".repeat(MAX_REGEX_PATTERN_LENGTH + 1))).toContain(
			"pattern is too long (1001 characters, limit 1000)",
		);
	});
});

describe("compileSafeRegex", () => {
	test("compiles a safe pattern with its flags", () => {
		const regex = compileSafeRegex("^a.c$", "i");
		expect(regex.test("ABC")).toBe(true);
		expect(regex.flags).toBe("i");
	});

	test("an unsafe pattern never reaches the RegExp engine; a broken one is a SyntaxError", () => {
		expect(() => compileSafeRegex("(x+)+y")).toThrow(UnsafeRegexError);
		expect(() => compileSafeRegex("(")).toThrow(SyntaxError);
	});
});
