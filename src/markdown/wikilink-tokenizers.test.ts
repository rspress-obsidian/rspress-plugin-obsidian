import { describe, expect, test } from "bun:test";
import { findWikilinkMatches } from "./parse-wikilink.js";
import { parseObsidianMarkdown, type WikiLinkNode } from "./syntax.js";
import { visit } from "./visit.js";

/**
 * The build tokenizes `[[…]]` twice: micromark's construct decides what the
 * page renders, and `findWikilinkMatches` decides what the index, backlinks and
 * Bases link tables see. They were written separately and had drifted (the
 * scanner crossed line ends, `[[]]` counted as a link), so a note could render
 * one set of links and be indexed as another. These cases pin both to the same
 * grammar.
 */
function rendered(source: string): string[] {
	const found: string[] = [];
	visit(parseObsidianMarkdown(source, { enableMath: false }), "wikiLink", (node) => {
		// `wikiLink` carries the raw token, `!` and brackets included.
		found.push((node as WikiLinkNode).value.replace(/^!?\[\[|\]\]$/g, ""));
	});
	return found;
}

function scanned(source: string): string[] {
	return findWikilinkMatches(source).map((match) => match.inner);
}

const CASES: Array<[source: string, links: string[]]> = [
	["[[Note]]", ["Note"]],
	["see [[Note|Alias]] and [[Other#Heading]]", ["Note|Alias", "Other#Heading"]],
	["![[photo.png]]", ["photo.png"]],
	["[[Note#^block-id]]", ["Note#^block-id"]],
	["[[A\\]B]]", ["A\\]B"]],
	["[[a]b]]", ["a]b"]],
	["[[Note]]]]", ["Note"]],
	["[[ space kept ]]", [" space kept "]],
	["[[]]", []],
	["[[a\nb]]", []],
	["[[a\\\nb]]", []],
	["no links here", []],
];

describe("wikilink grammar", () => {
	for (const [source, links] of CASES) {
		test(JSON.stringify(source), () => {
			expect(rendered(source)).toEqual(links);
			expect(scanned(source)).toEqual(links);
		});
	}
});
