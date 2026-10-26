import { describe, expect, test } from "bun:test";
import { isSameSiteUrl, pdfEmbedHtml } from "./media-html";

describe("isSameSiteUrl", () => {
	test("refuses every URL with a scheme, however a browser would trim it", () => {
		for (const url of [
			"https:evil.example/x.pdf",
			"HTTP:evil.example/x.pdf",
			"\thttps:evil.example/x.pdf",
			" \u0000https:evil.example/x.pdf",
			"ht\ntps:evil.example/x.pdf",
			"javascript:alert(1)",
			"https://same-site.invalid/x.pdf",
		]) {
			expect(isSameSiteUrl(url)).toBe(false);
		}
		// What makes `https:host` dangerous: from an `http:` page it is another site.
		expect(new URL("https:evil.example/x.pdf", "http://docs.example/page").host).toBe(
			"evil.example",
		);
	});

	test("accepts relative and root-relative paths, a colon later in the path included", () => {
		for (const url of ["doc.pdf", "./doc.pdf", "../doc.pdf", "/files/doc.pdf", "./a:b.pdf"]) {
			expect(isSameSiteUrl(url)).toBe(true);
		}
	});
});

describe("pdfEmbedHtml", () => {
	test("frames a PDF the site serves itself", () => {
		for (const src of ["/vault/doc.pdf#page=2", "doc.pdf", "./files/doc.pdf", "../doc.pdf"]) {
			expect(pdfEmbedHtml({ src, target: "doc.pdf" })).toContain(
				'<iframe class="obsidian-pdf-frame"',
			);
		}
	});

	test("links, and never frames, a PDF any browser would load from another site", () => {
		for (const src of [
			"https://evil.example/x.pdf",
			"//evil.example/x.pdf",
			"/\\evil.example/x.pdf",
			"\\\\evil.example\\x.pdf",
			"data:application/pdf;base64,AA",
		]) {
			const html = pdfEmbedHtml({ src, target: "x.pdf" });
			expect(html).not.toContain("<iframe");
			expect(html).toContain('rel="noopener noreferrer">x.pdf</a>');
		}
	});
});
