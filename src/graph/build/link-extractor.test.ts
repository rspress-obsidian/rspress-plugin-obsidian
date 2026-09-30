import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	extractDisplayTitle,
	extractFrontmatterNames,
	extractMarkdownLinks,
	extractWikilinkTargets,
} from "./link-extractor";

describe("extractMarkdownLinks", () => {
	test("extracts relative markdown links", () => {
		const source = "# Page\n\nSee [guide](./guide.md) and [api](../api.md).";
		expect(extractMarkdownLinks(source)).toEqual(["./guide.md", "../api.md"]);
	});

	test("extracts absolute path links", () => {
		const source = "Read [docs](/docs/intro).";
		expect(extractMarkdownLinks(source)).toEqual(["/docs/intro"]);
	});

	test("extracts full reference markdown links", () => {
		const source = "Read [the guide][guide-ref].\n\n[guide-ref]: ./guide.md";
		expect(extractMarkdownLinks(source)).toEqual(["./guide.md"]);
	});

	test("extracts collapsed and shortcut reference markdown links", () => {
		const source = [
			"Read [Guide][] and [API].",
			"",
			"[guide]: ./guide.md#intro",
			"[api]: ../api.mdx?from=docs",
		].join("\n");

		expect(extractMarkdownLinks(source)).toEqual(["./guide.md", "../api.mdx"]);
	});

	test("ignores external reference markdown links", () => {
		const source = "Visit [site][site].\n\n[site]: https://example.com";
		expect(extractMarkdownLinks(source)).toEqual([]);
	});

	test("strips hash fragments from links", () => {
		const source = "See [section](./page.md#heading).";
		expect(extractMarkdownLinks(source)).toEqual(["./page.md"]);
	});

	test("strips query strings from links", () => {
		const source = "See [page](./page.md?foo=1).";
		expect(extractMarkdownLinks(source)).toEqual(["./page.md"]);
	});

	test("ignores external http links", () => {
		const source = "Visit [site](https://example.com) and [other](http://other.com).";
		expect(extractMarkdownLinks(source)).toEqual([]);
	});

	test("ignores mailto and tel links", () => {
		const source = "Email [us](mailto:hi@example.com) or call [us](tel:+1234).";
		expect(extractMarkdownLinks(source)).toEqual([]);
	});

	test("ignores non-http schemes", () => {
		const source = [
			"Download [file](ftp://files.example.com/guide.md)",
			"and [data](data:text/plain;base64,SGVsbG8=)",
			"and [doc](file:///etc/guide.md).",
		].join("\n");
		expect(extractMarkdownLinks(source)).toEqual([]);
	});

	test("ignores protocol-relative URLs", () => {
		const source = "See [cdn](//cdn.example.com/guide.md).";
		expect(extractMarkdownLinks(source)).toEqual([]);
	});

	test("strips query string before hash fragment", () => {
		const source = "See [page](./page.md?foo=1#heading).";
		expect(extractMarkdownLinks(source)).toEqual(["./page.md"]);
	});

	test("ignores bare hash anchor links", () => {
		const source = "Jump to [section](#heading).";
		expect(extractMarkdownLinks(source)).toEqual([]);
	});

	test("ignores links inside fenced code blocks", () => {
		const source = "```\nSee [guide](./guide.md)\n```";
		expect(extractMarkdownLinks(source)).toEqual([]);
	});

	test("returns empty array when no links are present", () => {
		const source = "# Just a heading\n\nSome text without links.";
		expect(extractMarkdownLinks(source)).toEqual([]);
	});

	test("works with CRLF line endings", () => {
		const source = "# Page\r\n\r\nSee [guide](./guide.md).\r\n";
		expect(extractMarkdownLinks(source)).toEqual(["./guide.md"]);
	});
});

describe("Obsidian syntax", () => {
	test("extracts wikilinks and frontmatter tags", () => {
		const source = [
			"---",
			"tags:",
			"  - project/ideas",
			"---",
			"See [[guide/getting-started#Install|Install]] and #inline-tag.",
		].join("\n");
		expect(extractMarkdownLinks(source)).toEqual([
			"guide/getting-started",
			"/tags/inline-tag",
			"/tags/project/ideas",
		]);
	});

	test("encodes frontmatter tags exactly like the generated tag-page routes", () => {
		const source = [
			"---",
			"tags:",
			"  - café",
			"  - data science",
			"  - project/ideas",
			"---",
			"Body.",
		].join("\n");

		expect(extractMarkdownLinks(source)).toEqual([
			"/tags/café",
			"/tags/data%20science",
			"/tags/project/ideas",
		]);
	});

	test("extracts inline and scalar frontmatter tag forms", () => {
		expect(extractMarkdownLinks("---\ntags: [alpha, beta]\n---\nBody.")).toEqual([
			"/tags/alpha",
			"/tags/beta",
		]);
		expect(extractMarkdownLinks("---\ntag: solo\n---\nBody.")).toEqual(["/tags/solo"]);
	});

	test("extracts Markdown and wiki links from Canvas file nodes", () => {
		const source = JSON.stringify({
			nodes: [
				{ type: "file", file: "guide/getting-started.md" },
				{ type: "text", text: "See [[api]]" },
			],
		});
		expect(extractMarkdownLinks(source, "Demo.canvas")).toEqual([
			"guide/getting-started.md",
			"api",
		]);
	});

	test("keeps note embeds but drops attachment embeds", () => {
		// `![[image.png]]` can never resolve to a route, so it must not reach the
		// graph as a link — it would warn as unresolved on every build. A note
		// embed stays: the markdown pipeline indexes it as a link too.
		const source = [
			"![[Note]]",
			"![[Note|Alias]]",
			"![[diagram.png]]",
			"![[diagram.png|300]]",
			"![[paper.pdf#page=2]]",
			"![[Demo.canvas]]",
			"![[guide.md]]",
		].join("\n");

		expect(extractMarkdownLinks(source)).toEqual(["Note", "Note", "Demo.canvas", "guide.md"]);
	});
});

describe("extractFrontmatterNames", () => {
	test("collects the title and both alias forms", () => {
		const source = [
			"---",
			"title: My Long Title",
			"aliases:",
			"  - Alt Name",
			"  - Second Alias",
			"---",
			"Body.",
		].join("\n");

		expect(extractFrontmatterNames(source)).toEqual(["Alt Name", "Second Alias", "My Long Title"]);
	});

	test("accepts the singular `alias` key and an inline list", () => {
		const source = "---\nalias: [One, Two]\n---\n";
		expect(extractFrontmatterNames(source)).toEqual(["One", "Two"]);
	});

	test("reads a block alias list", () => {
		const source = "---\naliases:\n  - One\n  - Two\n---\n";
		expect(extractFrontmatterNames(source)).toEqual(["One", "Two"]);
	});

	test("unquotes aliases and keeps quoted commas intact", () => {
		const source = "---\naliases: [\"Quoted Alias\", 'Single']\n---\n";
		expect(extractFrontmatterNames(source)).toEqual(["Quoted Alias", "Single"]);
	});

	test("reads a folded scalar title as its folded value", () => {
		// A hand-rolled `title:` regex returns the literal `>-` here.
		const source = "---\ntitle: >-\n  A Long Title\n  Across Lines\n---\n";
		expect(extractDisplayTitle(source)).toBe("A Long Title Across Lines");
		expect(extractFrontmatterNames(source)).toEqual(["A Long Title Across Lines"]);
	});

	test("refuses JavaScript frontmatter without throwing or naming it", () => {
		const source = "---js\ntitle: Ignored\n---\n\n# Heading\n";
		expect(extractFrontmatterNames(source)).toEqual([]);
		expect(extractDisplayTitle(source)).toBe("Heading");
	});

	test("returns an empty list without frontmatter", () => {
		expect(extractFrontmatterNames("# Heading\n\nBody.")).toEqual([]);
	});

	test("keeps frontmatter straight when documents interleave", () => {
		const first = "---\ntitle: First\naliases: [A1]\n---\n\nBody.";
		const second = "---\ntitle: Second\n---\n\nBody.";

		expect(extractFrontmatterNames(first)).toEqual(["A1", "First"]);
		expect(extractFrontmatterNames(second)).toEqual(["Second"]);
		// Re-reading the first document must not serve the second's cached parse.
		expect(extractDisplayTitle(first)).toBe("First");
		expect(extractFrontmatterNames(first)).toEqual(["A1", "First"]);
	});
});

describe("extractDisplayTitle", () => {
	test("returns frontmatter title when present", () => {
		const source = "---\ntitle: My Title\n---\n\n# Heading\n";
		expect(extractDisplayTitle(source)).toBe("My Title");
	});

	test("strips surrounding quotes from frontmatter title", () => {
		const source = `---\ntitle: "Quoted Title"\n---\n`;
		expect(extractDisplayTitle(source)).toBe("Quoted Title");
	});

	test("strips single quotes from frontmatter title", () => {
		const source = `---\ntitle: 'Single Quoted'\n---\n`;
		expect(extractDisplayTitle(source)).toBe("Single Quoted");
	});

	test("falls back to first h1 heading when no frontmatter title", () => {
		const source = "# Guide\n\nSome content.";
		expect(extractDisplayTitle(source)).toBe("Guide");
	});

	test("prefers frontmatter title over h1 heading", () => {
		const source = "---\ntitle: Frontmatter Title\n---\n\n# Heading Title\n";
		expect(extractDisplayTitle(source)).toBe("Frontmatter Title");
	});

	test("returns undefined when no title or heading", () => {
		const source = "Some content without a heading.";
		expect(extractDisplayTitle(source)).toBeUndefined();
	});

	test("returns undefined for empty source", () => {
		expect(extractDisplayTitle("")).toBeUndefined();
	});

	test("works with CRLF frontmatter", () => {
		const source = "---\r\ntitle: CRLF Title\r\n---\r\n\r\n# Heading\r\n";
		expect(extractDisplayTitle(source)).toBe("CRLF Title");
	});

	test("works with CRLF heading", () => {
		const source = "# CRLF Heading\r\n\r\nContent.\r\n";
		expect(extractDisplayTitle(source)).toBe("CRLF Heading");
	});

	test("does not include carriage return in heading title", () => {
		const source = "# Title With No Trailing CR\r\n";
		const result = extractDisplayTitle(source);
		expect(result).toBe("Title With No Trailing CR");
		expect(result?.endsWith("\r")).toBe(false);
	});
});

describe("code samples", () => {
	test("ignores wikilinks and tags inside code fences and inline code", () => {
		const source = [
			"Real [[Note]] and a real #tag here.",
			"",
			"```",
			"[[Fenced]] #fenced",
			"```",
			"",
			"`[[Inline]]` and `#inline` stay documentation.",
		].join("\n");

		const links = extractMarkdownLinks(source);

		expect(links).toContain("Note");
		expect(links).toContain("/tags/tag");
		expect(links.filter((link) => /fenced|inline/i.test(link))).toEqual([]);
	});
});

describe("frontmatter", () => {
	test("ignores links and tags written in frontmatter prose", () => {
		const source = [
			"---",
			"description: 'Link pages with [[Page]] and tag them #tags'",
			"tags:",
			"  - real",
			"---",
			"",
			"Body with [[Note]].",
		].join("\n");

		const links = extractMarkdownLinks(source);

		expect(links).toContain("Note");
		expect(links).toContain("/tags/real");
		expect(links.filter((link) => link === "Page" || link === "/tags/tags")).toEqual([]);
	});
});

describe("footnote definitions", () => {
	test("extracts wikilinks written inside a footnote definition", () => {
		// The site pipeline parses with GFM, where this is a footnoteDefinition
		// holding a text node. Without GFM it is a plain `definition` and the
		// wikilink never reaches the extractor.
		const links = extractMarkdownLinks("Body text.[^1]\n\n[^1]: See [[Page]] for details.\n");

		expect(links).toContain("Page");
	});
});

describe("fast path parity", () => {
	/** Every real note in the repo: fixtures, docs pages and the demo vault. */
	const corpus = [
		...new Bun.Glob("test/markdown/fixtures/**/*.md").scanSync({ cwd: process.cwd() }),
		...new Bun.Glob("docs/**/*.md").scanSync({ cwd: process.cwd() }),
		...new Bun.Glob("Obsidian Vault/**/*.md").scanSync({ cwd: process.cwd() }),
	].sort();

	test("the corpus is big enough to be meaningful", () => {
		expect(corpus.length).toBeGreaterThan(30);
	});

	test("both strategies agree on every note that takes the fast path", () => {
		const compared: string[] = [];
		const mismatches: Array<{ file: string; parsed: string[]; fast: string[] }> = [];

		for (const file of corpus) {
			const source = readFileSync(file, "utf8");
			// Only notes without markdown-link syntax take the fast path; for those
			// the masked scan must find exactly what the parser finds.
			if (/\](?:\(|\[|:)|\]:|<(?:https?|mailto):/i.test(source)) continue;
			compared.push(file);

			const parsed = [...new Set(extractMarkdownLinks(source, file))].sort();
			const fast = [
				...new Set([
					...extractWikilinkTargets(source),
					...extractMarkdownLinks(source, file).filter((link) => link.startsWith("/tags/")),
				]),
			].sort();

			if (JSON.stringify(parsed) !== JSON.stringify(fast)) {
				mismatches.push({ file, parsed, fast });
			}
		}

		expect(compared.length).toBeGreaterThan(10);
		expect(mismatches).toEqual([]);
	});

	test("the masked scan ignores code fences and inline code", () => {
		const source = [
			"Real [[Note]] and a #realtag.",
			"",
			"```",
			"[[Fenced]] #fencedtag",
			"```",
			"",
			"`[[Inline]]` and `#inlinetag` stay documentation.",
		].join("\n");

		const links = extractWikilinkTargets(source);

		expect(links).toContain("Note");
		expect(links).toContain("/tags/realtag");
		expect(links.filter((link) => /fenced|inline/i.test(link))).toEqual([]);
	});

	test("markdown-link syntax routes a note back to the parser", () => {
		// The parser is the only path that resolves reference links, so the
		// pre-check must not let these through to the masked scan.
		const reference = "See [the guide][g].\n\n[g]: ../guide.md\n";
		const inline = "See [the guide](../guide.md).\n";

		expect(extractMarkdownLinks(reference, "note.md")).toContain("../guide.md");
		expect(extractMarkdownLinks(inline, "note.md")).toContain("../guide.md");

		// An autolink also routes to the parser, which then drops it as external —
		// external targets are not graph edges, so the routing is unobservable here.
		expect(extractMarkdownLinks("See <https://example.com>.\n", "note.md")).toEqual([]);
	});
});
