import { describe, expect, test } from "bun:test";
import { type RenderContext, renderMarkdownInline, renderValue } from "./dataview-render";
import { type DataviewLink, DEFAULT_DATE_FORMATS } from "./dataview-values";

const rc: RenderContext = {
	linkHtml: (link: DataviewLink) => `<a data-path="${link.path}">${link.label()}</a>`,
	formats: DEFAULT_DATE_FORMATS,
};

describe("renderValue", () => {
	test("inline lists are comma-separated spans; empty ones say so", () => {
		expect(renderValue([1, null, "x"], rc, true)).toBe(
			'<span class="dataview dataview-result-list-span">1, -, x</span>',
		);
		expect(renderValue([], rc, true)).toBe("&lt;Empty List&gt;");
	});

	test("nesting deeper than Dataview's render depth is elided", () => {
		expect(renderValue([[[[[1]]]]], rc, true)).toContain("...");
	});
});

describe("renderMarkdownInline", () => {
	test("phrasing markup renders as HTML", () => {
		expect(renderMarkdownInline("~~gone~~ *em* **b** `c`", rc)).toBe(
			"<del>gone</del> <em>em</em> <strong>b</strong> <code>c</code>",
		);
		expect(renderMarkdownInline("*a*\\\nb", rc)).toBe("<em>a</em><br>b");
	});

	test("links and images keep safe URLs and drop unsafe ones", () => {
		expect(renderMarkdownInline("[x](https://e.org/a)", rc)).toBe(
			'<a href="https://e.org/a">x</a>',
		);
		expect(renderMarkdownInline("[x](javascript:alert(1))", rc)).toBe("x");
		expect(renderMarkdownInline("![pic](https://e.org/p.png)", rc)).toBe(
			'<img src="https://e.org/p.png" alt="pic" />',
		);
		expect(renderMarkdownInline("![pic](javascript:alert(1))", rc)).toBe("pic");
	});

	test("raw HTML and footnote references show as text", () => {
		expect(renderMarkdownInline("a <b>bold</b>", rc)).toBe("a &lt;b&gt;bold&lt;/b&gt;");
		expect(renderMarkdownInline("see[^1]\n\n[^1]: note", rc)).toContain("see[^1]");
	});

	test("non-paragraph blocks keep their source text", () => {
		expect(renderMarkdownInline("> quoted\n> line", rc)).toBe("&gt; quoted<br>&gt; line");
	});

	test("wikilinks inside formatting resolve through the link renderer", () => {
		expect(renderMarkdownInline("*[[Folder/Page]]*", rc)).toBe(
			'<em><a data-path="Folder/Page">Page</a></em>',
		);
	});

	test("bracketed inline fields show key and value, parenthesised ones only the value", () => {
		expect(renderMarkdownInline("[k:: v] and (p:: q)", rc)).toBe(
			'<span class="dataview inline-field"><span class="dataview inline-field-key">k</span><span class="dataview inline-field-value">v</span></span> and <span class="dataview inline-field"><span class="dataview inline-field-standalone-value">q</span></span>',
		);
	});
});
