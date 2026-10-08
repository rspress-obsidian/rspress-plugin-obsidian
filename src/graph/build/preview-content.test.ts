import { describe, expect, test } from "bun:test";
import { toPreviewText } from "./preview-content";

describe("toPreviewText", () => {
	test("strips heading, blockquote and list markers", () => {
		expect(toPreviewText("# Getting Started")).toBe("Getting Started");
		expect(toPreviewText("###### Deep heading")).toBe("Deep heading");
		expect(toPreviewText("> quoted line")).toBe("quoted line");
		expect(toPreviewText("- item one")).toBe("item one");
		expect(toPreviewText("1. numbered item")).toBe("numbered item");
	});

	test("strips emphasis and strong markers", () => {
		expect(toPreviewText("**bold** text")).toBe("bold text");
		expect(toPreviewText("__bold__ text")).toBe("bold text");
		expect(toPreviewText("*italic* text")).toBe("italic text");
		expect(toPreviewText("_italic_ text")).toBe("italic text");
	});

	test("strips inline-code backticks", () => {
		expect(toPreviewText("run `bun add x` now")).toBe("run bun add x now");
	});

	test("reduces images, links, wikilinks and embeds to their labels", () => {
		expect(toPreviewText("![alt text](image.png)")).toBe("alt text");
		expect(toPreviewText("[the guide](https://example.com)")).toBe("the guide");
		expect(toPreviewText("[[Target|Label]]")).toBe("Label");
		expect(toPreviewText("[[Target]]")).toBe("Target");
		expect(toPreviewText("[[Target#Heading]]")).toBe("Target");
		expect(toPreviewText("![[Embed]]")).toBe("Embed");
		expect(toPreviewText("![[image.png|Caption]]")).toBe("Caption");
	});

	test("removes footnote references, Obsidian comments and HTML tags", () => {
		expect(toPreviewText("A claim[^1] here")).toBe("A claim here");
		expect(toPreviewText("visible %%hidden%% text")).toBe("visible text");
		expect(toPreviewText("<b>bold</b> prose")).toBe("bold prose");
	});

	test("hides HTML comments the page hides, closed or not", () => {
		expect(toPreviewText("Visible <!-- internal: password is hunter2 --> text")).toBe(
			"Visible text",
		);
		expect(toPreviewText("Visible <!-- never closed\nsecret")).toBe("Visible");
	});

	test("keeps arithmetic and snake_case intact", () => {
		expect(toPreviewText("2 * 3 = 6")).toBe("2 * 3 = 6");
		expect(toPreviewText("snake_case survives")).toBe("snake_case survives");
		expect(toPreviewText("snake_case_name survives")).toBe("snake_case_name survives");
	});

	test("collapses whitespace runs and trims", () => {
		expect(toPreviewText("\n\n  spaced   out\n\n text  \n")).toBe("spaced out text");
	});
});

describe("toPreviewText fences", () => {
	test("drops fence lines and keeps the code text", () => {
		const preview = toPreviewText("Intro line.\n\n```ts\nconst a = 1;\n```\n\nOutro line.");

		expect(preview).toBe("Intro line. const a = 1; Outro line.");
		expect(preview).not.toContain("```");
	});
});
