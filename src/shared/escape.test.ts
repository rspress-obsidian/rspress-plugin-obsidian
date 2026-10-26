import { describe, expect, test } from "bun:test";
import {
	escapeHtmlAttribute,
	escapeHtmlText,
	escapeMarkdownDestination,
	escapeRegExp,
	sanitizeUrl,
} from "./escape.js";

describe("sanitizeUrl", () => {
	test("rejects URLs a browser resolves off-site", () => {
		for (const url of ["//evil.example/x", "/\\evil.example/x", "\\\\evil.example/x"]) {
			expect(sanitizeUrl(url)).toBeNull();
			// The rule exists because of how the browser reads these.
			if (url.startsWith("/")) {
				expect(new URL(url, "https://docs.example/canvas/board").host).toBe("evil.example");
			}
		}
	});

	test("rejects script URLs in every spelling", () => {
		for (const url of [
			"javascript:alert(1)",
			" JaVaScRiPt:alert(1)",
			"java\tscript:alert(1)",
			"data:text/html,<script>alert(1)</script>",
		]) {
			expect(sanitizeUrl(url)).toBeNull();
		}
	});

	test("keeps site, relative, fragment, web and media data URLs", () => {
		for (const url of [
			"/vault/note",
			"./pic.png",
			"../pic.png",
			"#heading",
			"https://example.com",
			"mailto:a@b.c",
			"data:image/png;base64,AAAA",
		]) {
			expect(sanitizeUrl(url)).toBe(url);
		}
	});
});

describe("escaping", () => {
	test("attribute escaping also covers double quotes", () => {
		expect(escapeHtmlText(`<a href="x">&`)).toBe(`&lt;a href="x"&gt;&amp;`);
		expect(escapeHtmlAttribute(`"><img onerror=x>`)).toBe("&quot;&gt;&lt;img onerror=x&gt;");
	});
});

describe("escapeRegExp", () => {
	const SYNTAX = "\\^$.*+?()[]{}|/-";

	test("every syntax character matches itself, with and without the u and v flags", () => {
		for (const flags of ["", "u", "v"]) {
			const pattern = new RegExp(`^${escapeRegExp(SYNTAX)}$`, flags);
			expect([flags, pattern.test(SYNTAX)]).toEqual([flags, true]);
			expect([flags, pattern.test(SYNTAX.slice(1))]).toEqual([flags, false]);
		}
	});

	test("is literal inside a character class and an alternation", () => {
		for (const flags of ["", "u"]) {
			// A bare `-` between two characters would be a range: `[(-)]` matches `*`.
			const anyOf = new RegExp(`^[${escapeRegExp("(-)")}]$`, flags);
			expect(["(", "-", ")"].every((character) => anyOf.test(character))).toBe(true);
			expect(anyOf.test("*")).toBe(false);
			const either = new RegExp(`^(?:${["a|b", "c.d"].map(escapeRegExp).join("|")})$`, flags);
			expect(either.test("a|b")).toBe(true);
			expect(either.test("cxd")).toBe(false);
			expect(either.test("a")).toBe(false);
		}
	});

	test("leaves other text, the empty string and non-ASCII alone", () => {
		expect(escapeRegExp("")).toBe("");
		expect(escapeRegExp("due 📅 Ünïcode_1")).toBe("due 📅 Ünïcode_1");
	});
});

describe("escapeMarkdownDestination", () => {
	test("parentheses and backslashes are escaped, so the link does not end early", () => {
		expect(escapeMarkdownDestination("/notes/a (draft)")).toBe("/notes/a%20\\(draft\\)");
		expect(escapeMarkdownDestination("/a\\b")).toBe("/a\\\\b");
		// What a CommonMark parser reads back is the URL that went in.
		expect(escapeMarkdownDestination("/x/(1)\\y").replace(/\\([\\()])/g, "$1")).toBe("/x/(1)\\y");
	});

	test("whitespace, angle brackets and double quotes are percent-encoded", () => {
		expect(escapeMarkdownDestination("/a b\tc\nd")).toBe("/a%20b%09c%0Ad");
		expect(escapeMarkdownDestination('/<x>"y"')).toBe("/%3Cx%3E%22y%22");
	});

	test("everything else, already-encoded text and `'` included, stays as written", () => {
		for (const url of ["/tags/c++", "/notes/it's", "/a%20b", "/página#heading?x=1&y=2", ""]) {
			expect(escapeMarkdownDestination(url)).toBe(url);
		}
	});
});
