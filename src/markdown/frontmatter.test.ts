import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { stripFrontmatter } from "../shared/frontmatter.js";

describe("stripFrontmatter", () => {
	test("drops a leading block and returns the body byte-for-byte", () => {
		expect(stripFrontmatter("---\ntitle: One\n---\n\n# Body\n")).toBe("\n# Body\n");
	});

	test("accepts a CRLF checkout", () => {
		expect(stripFrontmatter("---\r\ntitle: One\r\n---\r\nBody")).toBe("Body");
	});

	test("sees an empty block", () => {
		expect(stripFrontmatter("---\n---\nBody")).toBe("Body");
	});

	test("closes on a line with trailing spaces", () => {
		expect(stripFrontmatter("---\na: 1\n---   \nBody")).toBe("Body");
	});

	test("returns content with no frontmatter unchanged", () => {
		expect(stripFrontmatter("# Heading\n")).toBe("# Heading\n");
		expect(stripFrontmatter("")).toBe("");
	});

	test("returns an unterminated block unchanged", () => {
		const source = "---\ntitle: One\n# Body";
		expect(stripFrontmatter(source)).toBe(source);
	});

	test("does not treat ---js or a ---- thematic break as an opener", () => {
		expect(stripFrontmatter("---js\ncode: 1\n---\nBody")).toBe("---js\ncode: 1\n---\nBody");
		expect(stripFrontmatter("----\nBody")).toBe("----\nBody");
	});
});

describe("stripFrontmatter (property)", () => {
	test("property: the output is always a suffix of the input", () => {
		fc.assert(
			fc.property(fc.string(), (markdown) => markdown.endsWith(stripFrontmatter(markdown))),
		);
	});

	test("property: input that cannot open a frontmatter block passes through", () => {
		// Prefixing guarantees the `^---` opener can never match.
		fc.assert(
			fc.property(
				fc.string().map((markdown) => `x${markdown}`),
				(markdown) => stripFrontmatter(markdown) === markdown,
			),
		);
	});
});
