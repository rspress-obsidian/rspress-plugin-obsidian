import { describe, expect, test } from "bun:test";
import { escapeHtmlAttribute, escapeHtmlText, sanitizeUrl } from "./escape.js";

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
