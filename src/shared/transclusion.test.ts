import { describe, expect, test } from "bun:test";
import { extractBlockSection, extractHeadingSection, extractNoteSection } from "./transclusion.ts";

const NOTE = [
	"# A",
	"",
	"## Details",
	"Under A.",
	"",
	"# B",
	"",
	"## Details",
	"Under B.",
	"",
	"## Uninstall steps",
	"Gone.",
].join("\n");

describe("extractHeadingSection", () => {
	test("walks a nested heading path", () => {
		expect(extractHeadingSection(NOTE, "B#Details")).toBe("## Details\nUnder B.");
		expect(extractHeadingSection(NOTE, "A#Details")).toBe("## Details\nUnder A.");
	});

	test("matches exactly, never by prefix or substring", () => {
		expect(extractHeadingSection(NOTE, "install")).toBeUndefined();
		expect(extractHeadingSection(NOTE, "Uninstall")).toBeUndefined();
		expect(extractHeadingSection(NOTE, "uninstall steps")).toBe("## Uninstall steps\nGone.");
	});

	test("accepts an explicit id", () => {
		expect(extractHeadingSection("## Title {#custom}\nBody", "custom")).toBe(
			"## Title {#custom}\nBody",
		);
	});

	test("ignores a heading line inside a fence", () => {
		const content = "```\n# Fake\n```\n# Real\ntext\n";
		expect(extractHeadingSection(content, "Fake")).toBeUndefined();
		expect(extractHeadingSection(content, "Real")).toBe("# Real\ntext");
	});

	test("finds a heading inside a blockquote, as the page does", () => {
		const content = "> ## Setup\n> quoted body\n\n## Other\ntext";
		expect(extractHeadingSection(content, "Setup")).toBe("> ## Setup\n> quoted body");
	});

	test("numbers a repeated heading so the slug the page publishes selects it", () => {
		const content = "## Details\nfirst\n\n## Details\nsecond\n";
		expect(extractHeadingSection(content, "Details")).toBe("## Details\nfirst");
		expect(extractHeadingSection(content, "Details-1")).toBe("## Details\nsecond");
	});
});

describe("extractBlockSection", () => {
	test("a trailing id embeds the whole paragraph, not its last line", () => {
		const content = "Intro.\n\nFirst line of paragraph\nsecond line ^para\n\nAfter.";
		expect(extractBlockSection(content, "para")).toBe("First line of paragraph\nsecond line");
	});

	test("a heading carrying the id is a block of its own", () => {
		expect(extractBlockSection("Para line\n## Heading ^h\nBody", "h")).toBe("## Heading");
	});

	test("a list item keeps its nested items", () => {
		expect(extractBlockSection("- one ^li\n  - nested\n- two", "li")).toBe("- one\n  - nested");
	});
});

describe("extractNoteSection", () => {
	test("routes a `^` subpath to the block extractor", () => {
		expect(extractNoteSection("Line ^x", "#^x")).toBe("Line");
	});

	test("a missing or malformed block id selects nothing", () => {
		expect(extractNoteSection("Line ^x", "#^missing")).toBeUndefined();
		expect(extractNoteSection("Line ^x", "#^bad id!")).toBeUndefined();
	});

	test("an empty subpath is the whole note", () => {
		expect(extractNoteSection("# A\ntext", "")).toBe("# A\ntext");
	});
});
