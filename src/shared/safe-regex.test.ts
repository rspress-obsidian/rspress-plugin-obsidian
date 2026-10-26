import { describe, expect, test } from "bun:test";
import {
	assertSafeRegex,
	compileSafeRegex,
	MAX_REGEX_PATTERN_LENGTH,
	UnsafeRegexError,
} from "./safe-regex";

const refused = (pattern: string, flags = "") => {
	try {
		assertSafeRegex(pattern, flags);
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

	test("refuses a repeated choice whose options can start on the same character", () => {
		for (const pattern of [
			"(a|a)*$",
			"(a|ab)*c",
			"(?:ab|a)+$",
			"(?:\\d|1)*x",
			"(?:x|[a-z])+$",
			"(?:a(?:b|bc))*d",
			// An optional part against skipping it: `ab` is one pass or two.
			"(?:a?b?)*c",
			// Passes under the minimum may be empty, so `a?` competes with the next pass.
			"(a?){30}a{30}",
		]) {
			const message = refused(pattern);
			expect([pattern, message]).toEqual([pattern, expect.stringContaining("repeats a choice")]);
			expect(message).toContain("catastrophic backtracking");
			expect(message).toContain("Obsidian would run it");
		}
	});

	test("refuses unbounded quantifiers in a row over shared characters", () => {
		for (const pattern of [
			"\\d*\\d*\\d*x",
			".*.*.*=",
			".*.*=",
			"\\d+\\.?\\d*",
			// A part both can take does not separate them.
			".*,.*=",
			"\\w+\\s*\\w+x",
			"(\\w+)(\\w+)x",
			"(?:ab)+(?:ba)*x",
			"(?:a|b)*a*x",
			"(?:x.*)?.*=",
			"\\x61+a+",
			"(a)\\1*a*",
			// Anchored, a match can still split one text three ways.
			"^\\s*(.*?)\\s*$",
			"^.*.*.*=",
		]) {
			const message = refused(pattern);
			expect([pattern, message]).toEqual([
				pattern,
				expect.stringContaining("unbounded quantifiers in a row over shared characters"),
			]);
			expect(message).toContain("Obsidian would run it");
		}
	});

	test("an anchored pattern may chain two quantifiers, unless `m` makes every line a start", () => {
		expect(refused("^(\\w+):\\s*(.*)$")).toBeUndefined();
		expect(refused("(?=x)^.*.*")).toBeUndefined();
		expect(refused(".*.*", "y")).toBeUndefined();
		expect(refused("^(\\w+):\\s*(.*)$", "m")).toContain("in a row");
		expect(refused("(?:^a|b).*.*")).toContain("in a row");
	});

	test("refuses optional parts, bounded quantifiers and alternatives whose choices multiply past 2^20", () => {
		for (const pattern of [
			// 100 pass counts each: 100^4 ways to split one run of digits.
			"\\d{0,99}\\d{0,99}\\d{0,99}\\d{0,99}x",
			`${"\\d{0,99}".repeat(10)}x`,
			"^\\d{0,99}\\d{0,99}\\d{0,99}\\d{0,99}x",
			`${"a?".repeat(30)}${"a".repeat(30)}`,
			`${"a?".repeat(21)}$`,
			`${"(?:a|aa)".repeat(40)}$`,
			`${"(?:\\d|1)".repeat(21)}x`,
			// A one-or-two-digit field per date token: `dHdH…`.
			`^${"(\\d{1,2})".repeat(21)}$`,
			// Optional parts between that both sides can take, or that can be skipped, do not break the run.
			`${"\\d{0,99}-?".repeat(4)}x`,
			`${"a?b?".repeat(21)}`,
		]) {
			const message = refused(pattern);
			expect([pattern, message]).toEqual([
				pattern,
				expect.stringContaining(
					"too many optional parts, bounded quantifiers or alternatives in a row over shared characters",
				),
			]);
			expect(message).toContain("Obsidian would run it");
		}
		expect(refused(`${"a?".repeat(21)}`, "")).toContain("too many");
		expect(refused(`${"(?:a|A)".repeat(21)}x`)).toBeUndefined();
		expect(refused(`${"(?:a|A)".repeat(21)}x`, "i")).toContain("too many");
	});

	test("a choice whose characters nothing next to it shares starts a new run", () => {
		for (const pattern of [
			"\\d{0,99}\\d{0,99}\\d{0,99}x",
			`${"a?".repeat(20)}${"a".repeat(20)}`,
			`${"(?:a|aa)".repeat(20)}$`,
			`${"\\d{0,99},".repeat(10)}x`,
			`${"a?-".repeat(30)}`,
			`^${"(\\d{1,2})[-/.]".repeat(20)}$`,
			"\\+?\\d{1,3}[-.\\s]?\\(?\\d{1,4}\\)?[-.\\s]?\\d{1,4}[-.\\s]?\\d{1,9}",
			// Alternatives that differ at some character never both match.
			`^${"(January|February|March|April|May|June|July|August|September|October|November|December) ".repeat(5)}$`,
			`${"(?:ab|ac)".repeat(30)}$`,
		]) {
			expect([pattern, refused(pattern, "i")]).toEqual([pattern, undefined]);
		}
	});

	test("lets a repeated group nest a quantifier when each pass starts with its own delimiter", () => {
		for (const pattern of [
			"^\\d{1,3}(\\.\\d{1,3}){3}$",
			"(?:,\\s*\\w+)*$",
			"(?:x\\d+)+$",
			"(?:\\b-\\d{1,2}){0,5}",
			"(?:X[a-z]+)+$",
		]) {
			expect([pattern, refused(pattern)]).toEqual([pattern, undefined]);
		}
		// The delimiter must be the first character, and nothing else in the pass may match it.
		const nested: Array<[pattern: string, flags: string]> = [
			["(?:x\\w+)+$", ""],
			["(\\.\\d{1,3}\\.?){3}$", ""],
			["(?:\\d+\\.)+$", ""],
			["(?:\\.?\\d+)+$", ""],
			["(?:X[a-z]+)+$", "i"],
			["(?<a>.)(?:x\\k<a>+)+$", ""],
		];
		for (const [pattern, flags] of nested) {
			expect([pattern, refused(pattern, flags)]).toEqual([
				pattern,
				expect.stringContaining("nested quantifiers"),
			]);
		}
		// Inside a pass, the extra passes of a quantifier still compete with what follows.
		expect(refused("(?:x\\d{1,3}\\d?)+$")).toContain("repeats a choice");
	});

	test("compares characters case-insensitively under `i` or an `(?i:…)` group", () => {
		expect(refused("(?:a|A)*")).toBeUndefined();
		expect(refused("(?:a|A)*", "i")).toContain("repeats a choice");
		expect(refused("(?i:a|A)*")).toContain("repeats a choice");
		expect(refused("[a-z]+[A-Z]+")).toBeUndefined();
		expect(refused("[a-z]+[A-Z]+", "i")).toContain("in a row");
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
			"(?:a|b)*c",
			"(?:ab?)*c",
			"(?:ab|cd?)*x",
			"(?:\\w\\s?)*$",
			"(\\w+)\\s+(\\w+)",
			"^\\s*-\\s*\\[.\\]",
			"[^,]+,[^,]+",
			".*\\.md$",
			"^(.*)/([^/]*)$",
			"https?://\\S+",
			"\\[\\[([^\\]|]+)(?:\\|([^\\]]+))?\\]\\]",
			"(?:\\r?\\n)+",
			"\\b\\w+\\b",
			"(?:(?=a+)b)*",
			"[\\d-]+x",
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

	test("reads `\\p` and `\\u` escapes as the flags do", () => {
		// Without `u`/`v`, `\p` and `\u` are letters, and `{…}` after them a quantifier.
		expect(refused("(?:\\p{1,})+$")).toContain("nested quantifiers");
		expect(refused("(?:\\P{2,})+$")).toContain("nested quantifiers");
		expect(refused("(?:\\u{1}|u)+$")).toContain("repeats a choice");
		expect(refused("\\u{2,}\\u*x")).toContain("in a row");
		expect(refused("\\p{L}+")).toBeUndefined();
		// With them, a property is any character, and `\u{…}` the code point it names.
		expect(refused("(?:\\p{L}+)+", "u")).toContain("nested quantifiers");
		expect(refused("(?:\\p{L}+)+", "v")).toContain("nested quantifiers");
		expect(refused("\\p{L}+\\p{N}*x", "u")).toContain("in a row");
		expect(refused("(?:\\u{75}|u)+$", "u")).toContain("repeats a choice");
		expect(refused("(?:\\u{1}|u)+$", "u")).toBeUndefined();
		expect(refused("\\p{L}+", "u")).toBeUndefined();
		expect(refused("[\\p{L}\\d_]+", "u")).toBeUndefined();
	});

	test("reads the other flag-dependent escapes as the flags do", () => {
		// `\uD83D\uDE00` is one character under `u`, and `😀` two code units without it.
		expect(refused("(?:\\uD83D\\uDE00|😀)+$")).toContain("repeats a choice");
		expect(refused("(?:\\uD83D\\uDE00|😀)+$", "u")).toContain("repeats a choice");
		expect(refused("(?:\\uD83D|😀)+$")).toContain("repeats a choice");
		expect(refused("(?:\\uD83D|😀)+$", "u")).toBeUndefined();
		// Without `u`, `\c1` in a class is a control character, and an octal escape stops at `\377`.
		expect(refused("(?:[\\c1]|\\x11)+$")).toContain("repeats a choice");
		expect(refused("(?:[\\477]|')+$")).toContain("repeats a choice");
		expect(refused("(?:[\\477]|7)+$")).toContain("repeats a choice");
		// `\k<a>` is a backreference only beside a named group (or under `u`); otherwise text.
		expect(refused("(?:\\k<a>|x)+$")).toBeUndefined();
		expect(refused("(?<a>.)(?:\\k<a>|x)+$")).toContain("repeats a choice");
		expect(refused("(?<a>.)(?:\\k<a>|x)+$", "u")).toContain("repeats a choice");
		// A `{` that does not start a quantifier is text.
		expect(refused("a{,5}a{x}")).toBeUndefined();
		expect(refused("(?:a{|a)+$")).toContain("repeats a choice");
	});

	test("under `v`, a class or property that matches strings is a choice of lengths", () => {
		expect(refused("[\\q{a|aa}]+b", "v")).toContain("nested quantifiers");
		expect(refused("(?:x[\\q{a|aa}]?)*y", "v")).toContain("nested quantifiers");
		expect(refused("\\p{RGI_Emoji}+$", "v")).toContain("nested quantifiers");
		expect(refused("[\\p{RGI_Emoji}--\\q{x}]+$", "v")).toContain("nested quantifiers");
		expect(refused("^\\p{RGI_Emoji}$", "v")).toBeUndefined();
		expect(refused("[\\q{abc}]x", "v")).toBeUndefined();
		expect(refused("[\\p{L}--[a-z]]+", "v")).toBeUndefined();
	});

	test("folds every case class under `i`, however wide the range", () => {
		expect(refused("(?:[\\x2f-\\u042f]|[\\u0430-\\u0830])+$")).toBeUndefined();
		expect(refused("(?:[\\x2f-\\u042f]|[\\u0430-\\u0830])+$", "i")).toContain("repeats a choice");
		// `ϑ` and `ϴ` both fold to `θ`; `ﬅ` and `ﬆ` share their uppercase.
		expect(refused("(?:ϑ|ϴ)+$", "ui")).toContain("repeats a choice");
		expect(refused("(?:ﬅ|ﬆ)+$", "ui")).toContain("repeats a choice");
		expect(refused("(?:k|\\u212a)+$", "ui")).toContain("repeats a choice");
		expect(refused("\\S+\\s+\\S+", "i")).toBeUndefined();
	});

	test("counts a bounded quantifier allowing over 100 extra passes as unbounded", () => {
		expect(refused("\\d{0,9999}\\d{0,9999}x")).toContain("in a row");
		expect(refused("\\d{0,101}\\d*x")).toContain("in a row");
		expect(refused("^\\d{5,1000}\\d{0,999}\\d{1,}x")).toContain("in a row");
		expect(refused("(a{1,1000}){1,1000}")).toContain("nested quantifiers");
		expect(refused("(?:a{1,1000}b){2,1000}")).toContain("nested quantifiers");
		// Up to 100, the choice is the pattern's own size; a fixed count is no choice.
		expect(refused("\\d{0,100}\\d{0,100}x")).toBeUndefined();
		expect(refused("\\d{500}\\d*x")).toBeUndefined();
		expect(refused("\\w{2,64}@\\w+")).toBeUndefined();
		expect(refused(".{0,80}x")).toBeUndefined();
	});

	test("refuses every valid pattern the guard once let through", () => {
		const bypasses: Array<[pattern: string, flags: string]> = [
			["(?:\\p{1,})+$", ""],
			["(?:\\u{1}|u)+$", ""],
			["\\d{0,9999}\\d{0,9999}x", ""],
			["[\\q{a|aa}]+b", "v"],
			["\\p{RGI_Emoji}+$", "v"],
			["(?:[\\c1]|\\x11)+$", ""],
			["(?:[\\477]|')+$", ""],
			["(?:\\uD83D\\uDE00|😀)+$", ""],
			["(?:\\uD83D\\uDE00|😀)+$", "u"],
			["(?:[\\x2f-\\u042f]|[\\u0430-\\u0830])+$", "i"],
			["\\d{0,99}\\d{0,99}\\d{0,99}\\d{0,99}x", ""],
			[`${"a?".repeat(30)}${"a".repeat(30)}`, ""],
			[`${"\\d{0,99}".repeat(10)}x`, ""],
			[`${"(?:a|aa)".repeat(40)}$`, ""],
		];
		for (const [pattern, flags] of bypasses) {
			// A real pattern, which the RegExp engine would run.
			expect(new RegExp(pattern, flags).source).toBe(pattern);
			expect([pattern, flags, refused(pattern, flags)]).toEqual([
				pattern,
				flags,
				expect.stringContaining("catastrophic backtracking"),
			]);
		}
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
