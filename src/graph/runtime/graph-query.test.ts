import { describe, expect, test } from "bun:test";
import { matchesGraphQuery, parseGraphQuery } from "./graph-query";

const node = (routePath: string, label?: string, tags?: string[]) => ({
	routePath,
	label: label ?? routePath.split("/").pop() ?? routePath,
	tags,
});

describe("parseGraphQuery", () => {
	test("empty input and stray negation match everything", () => {
		expect(parseGraphQuery("").isEmpty).toBe(true);
		expect(parseGraphQuery("   ").isEmpty).toBe(true);
		expect(parseGraphQuery("-").isEmpty).toBe(true);
		expect(matchesGraphQuery(node("/guide"), parseGraphQuery("-"))).toBe(true);
	});

	test("lowercases and trims plain terms", () => {
		const query = parseGraphQuery("  Guide  ");
		expect(query.terms).toEqual([{ kind: "text", value: "guide", negated: false }]);
	});

	test("recognizes path, file and tag operators, case-insensitively", () => {
		const query = parseGraphQuery("PATH:daily file:Welcome TAG:#project");
		expect(query.terms).toEqual([
			{ kind: "path", value: "daily", negated: false },
			{ kind: "file", value: "welcome", negated: false },
			{ kind: "tag", value: "project", negated: false },
		]);
	});

	test("drops an operator with no value instead of matching nonsense", () => {
		expect(parseGraphQuery("path:").isEmpty).toBe(true);
	});

	test("quoted phrases stay text terms even where an operator would apply", () => {
		const query = parseGraphQuery('"path:daily notes"');
		expect(query.terms).toEqual([{ kind: "text", value: "path:daily notes", negated: false }]);
	});
});

describe("matchesGraphQuery", () => {
	test("a matchable query must match every term", () => {
		const query = parseGraphQuery("guide api");
		expect(matchesGraphQuery(node("/guide", "Guide"), query)).toBe(false);
		expect(matchesGraphQuery(node("/api", "Guide API"), query)).toBe(true);
	});

	test("plain text matches the label or the route path", () => {
		expect(
			matchesGraphQuery(node("/vault/Setup Guide", "Untitled"), parseGraphQuery("setup")),
		).toBe(true);
		expect(matchesGraphQuery(node("/vault/Setup Guide"), parseGraphQuery("untitled"))).toBe(false);
	});

	test("file: matches only the last route segment", () => {
		expect(
			matchesGraphQuery(node("/guide/Install", "Getting Started"), parseGraphQuery("file:install")),
		).toBe(true);
		expect(
			matchesGraphQuery(node("/guide/Install", "Install"), parseGraphQuery("file:guide")),
		).toBe(false);
	});

	test("tag: matches the tag page itself and its subtags", () => {
		expect(matchesGraphQuery(node("/tags/project"), parseGraphQuery("tag:project"))).toBe(true);
		expect(matchesGraphQuery(node("/tags/project/ideas"), parseGraphQuery("tag:project"))).toBe(
			true,
		);
		expect(matchesGraphQuery(node("/tags/project/ideas"), parseGraphQuery("tag:proj"))).toBe(false);
		expect(matchesGraphQuery(node("/tags/other"), parseGraphQuery("tag:project"))).toBe(false);
	});

	test("tag: matches a page through the tags it links to", () => {
		const paged = node("/notes/plan", "Plan", ["/tags/project/ideas"]);
		expect(matchesGraphQuery(paged, parseGraphQuery("tag:project"))).toBe(true);
		expect(matchesGraphQuery(paged, parseGraphQuery("tag:inbox"))).toBe(false);
	});

	test("negation inverts a term", () => {
		const query = parseGraphQuery("-path:daily");
		expect(matchesGraphQuery(node("/daily/2026"), query)).toBe(false);
		expect(matchesGraphQuery(node("/notes/plan"), query)).toBe(true);
	});
});
