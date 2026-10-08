import { describe, expect, test } from "bun:test";
import { matchesGraphQuery, parseGraphQuery, type QueryableNode } from "./graph-query";

const node = (path: string, label?: string, tags?: string[]): QueryableNode => ({
	id: `/${path.replace(/\.md$/, "")}`,
	path,
	label: label ?? path.split("/").pop()?.replace(/\.md$/, "") ?? path,
	tags,
});

const matches = (query: string, target: QueryableNode, text?: string) =>
	matchesGraphQuery(target, parseGraphQuery(query), text);

describe("parseGraphQuery", () => {
	test("empty input and stray negation match everything", () => {
		expect(parseGraphQuery("").isEmpty).toBe(true);
		expect(parseGraphQuery("   ").isEmpty).toBe(true);
		expect(parseGraphQuery("-").isEmpty).toBe(true);
		expect(parseGraphQuery("path:").isEmpty).toBe(true);
		expect(matches("-", node("guide.md"))).toBe(true);
	});

	test("reports when the query reads note text", () => {
		expect(parseGraphQuery("path:daily tag:x file:y").needsText).toBe(false);
		expect(parseGraphQuery("content:x").needsText).toBe(true);
		expect(parseGraphQuery("line:(a b)").needsText).toBe(true);
		expect(parseGraphQuery("plain").needsText).toBe(true);
	});
});

describe("matchesGraphQuery", () => {
	test("terms are ANDed; plain text matches the name or path, case-insensitively", () => {
		expect(matches("guide api", node("guide.md"))).toBe(false);
		expect(matches("Setup", node("vault/Setup Guide.md", "Untitled"))).toBe(true);
		expect(matches("guide api", node("api.md", "Guide API"))).toBe(true);
	});

	test("plain text also searches the note once its text has loaded", () => {
		expect(matches("hunter", node("a.md"))).toBe(false);
		expect(matches("hunter", node("a.md"), "the hunter's moon")).toBe(true);
	});

	test("OR, negation and parentheses", () => {
		expect(matches("alpha OR beta", node("beta.md"))).toBe(true);
		expect(matches("alpha OR beta", node("gamma.md"))).toBe(false);
		expect(matches("-path:daily", node("daily/2026.md"))).toBe(false);
		expect(matches("-path:daily", node("notes/plan.md"))).toBe(true);
		expect(matches("notes (plan OR idea)", node("notes/idea.md"))).toBe(true);
		expect(matches("notes -(plan OR idea)", node("notes/idea.md"))).toBe(false);
	});

	test("an operator applies to a whole group", () => {
		expect(matches("path:(daily OR journal)", node("journal/x.md"))).toBe(true);
		expect(matches("path:(daily OR journal)", node("notes/x.md", "daily"))).toBe(false);
	});

	test("quoted phrases are exact text, never operators", () => {
		expect(matches('"path:daily notes"', node("x.md", "path:daily notes"))).toBe(true);
		expect(matches('"setup guide"', node("Setup Guide.md"))).toBe(true);
		expect(matches('"guide setup"', node("Setup Guide.md"))).toBe(false);
	});

	test("/regex/ terms, and a malformed one matches nothing", () => {
		expect(matches("/^2026-\\d\\d/", node("2026-05-01.md"))).toBe(true);
		expect(matches("file:/^draft/", node("notes/Draft plan.md"))).toBe(true);
		expect(matches("/[unclosed/", node("x.md"))).toBe(false);
	});

	test("file: matches the file name only", () => {
		expect(matches("file:install", node("guide/Install.md", "Getting Started"))).toBe(true);
		expect(matches("file:guide", node("guide/Install.md"))).toBe(false);
	});

	test("tag: matches the tag and its subtags, not a prefix of a word", () => {
		const tagged = node("plan.md", "Plan", ["project/ideas"]);
		expect(matches("tag:project", tagged)).toBe(true);
		expect(matches("tag:#project/ideas", tagged)).toBe(true);
		expect(matches("tag:proj", tagged)).toBe(false);
		expect(matches("tag:inbox", tagged)).toBe(false);
	});

	test("content:, line: and section: search the note's text", () => {
		const text = "# Intro\nalpha here\nbeta there\n# Next\nalpha and beta";
		const note = node("a.md");
		expect(matches("content:there", note, text)).toBe(true);
		expect(matches("content:there", note)).toBe(false);
		expect(matches("line:(alpha beta)", note, text)).toBe(true);
		expect(matches("line:(alpha there)", note, text)).toBe(false);
		expect(matches("section:(alpha there)", note, text)).toBe(true);
		expect(matches("section:(here and)", note, text)).toBe(false);
	});
});
