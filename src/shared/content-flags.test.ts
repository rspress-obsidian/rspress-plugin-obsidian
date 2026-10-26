import { describe, expect, test } from "bun:test";
import { getContentLineFlags } from "./content-flags.js";
import { stripFrontmatter } from "./frontmatter.js";

/** The content lines of `source`, by text. */
function contentLines(source: string): string[] {
	const lines = source.split("\n");
	const flags = getContentLineFlags(lines);
	return lines.filter((_line, index) => flags[index]);
}

describe("getContentLineFlags fences", () => {
	test.each([
		["a `~~~` line does not close a backtick fence", "```\n~~~\ncode\n```\nafter", ["after"]],
		["a backtick line does not close a tilde fence", "~~~\n```\ncode\n~~~\nafter", ["after"]],
		["a shorter run does not close a fence", "````\n```\ncode\n````\nafter", ["after"]],
		["a longer run closes a fence", "```\ncode\n`````\nafter", ["after"]],
		["a run with an info string does not close a fence", "```\n```js\ncode\n```\nafter", ["after"]],
		["a backtick info string opens no fence", "``` a`b\ntext", ["``` a`b", "text"]],
		["a tilde fence's info string may hold backticks", "~~~ a`b\ncode\n~~~\nafter", ["after"]],
		["a fence nested in a list item", "- item\n  ```\n  code\n  ```\nafter", ["- item", "after"]],
		["a fence in a block quote", "> ```\n> code\n> ```\nafter", ["after"]],
		["a fence ends with its block quote", "> ```\n> code\n\ntext", ["", "text"]],
		["a deeper `>` inside a fence is code", "```\n> ```\ncode\n```\nafter", ["after"]],
		["an unclosed fence runs to the end", "text\n```\ncode", ["text"]],
	])("%s", (_name, source, expected) => {
		expect(contentLines(source)).toEqual(expected);
	});
});

describe("getContentLineFlags frontmatter", () => {
	test.each([
		"---\ntitle: x\n---\nbody",
		"---\r\ntitle: x\r\n---\r\nbody",
		"---\n---\nbody",
		"---  \ntitle: x\n---\t\nbody",
		" ---\ntitle: x\n---\nbody",
		"---\ntitle: x\n ---\nbody",
		"---\ntitle: x",
		"----\ntitle: x\n----\nbody",
	])("agrees with stripFrontmatter: %j", (source) => {
		const body = stripFrontmatter(source);
		const lines = source.split(/\r?\n/);
		const skipped = lines.length - body.split(/\r?\n/).length;
		const flags = getContentLineFlags(lines);
		expect(flags.slice(0, skipped).every((flag) => !flag)).toBe(true);
		expect(flags[skipped]).toBe(true);
	});
});
