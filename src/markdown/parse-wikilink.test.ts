import { describe, test } from "bun:test";
import fc from "fast-check";
import { findWikilinkMatches, parseWikiLink } from "./parse-wikilink.ts";

// The tokenizer and parser run over arbitrary note text on every build, so the
// invariants below are the ones that keep a malformed or hostile vault note
// from crashing the build: no throws, and every match a faithful slice of the
// source it claims to cover.
describe("findWikilinkMatches (property)", () => {
	test("property: matches are ordered, non-overlapping slices of the input", () => {
		fc.assert(
			fc.property(fc.string(), (input) => {
				let previousEnd = 0;
				for (const match of findWikilinkMatches(input)) {
					if (match.start < previousEnd) return false;
					if (input.slice(match.start, match.end) !== match.fullMatch) return false;
					if (!/^(?:!\[\[|\[\[)/.test(match.fullMatch)) return false;
					previousEnd = match.end;
				}
				return true;
			}),
		);
	});

	test("property: inner excludes exactly the `[[`/`![[` opener and `]]` closer", () => {
		fc.assert(
			fc.property(fc.string(), (input) => {
				for (const match of findWikilinkMatches(input)) {
					const openerLength = match.fullMatch.startsWith("!") ? 3 : 2;
					if (match.inner !== input.slice(match.start + openerLength, match.end - 2)) {
						return false;
					}
				}
				return true;
			}),
		);
	});
});

describe("parseWikiLink (property)", () => {
	test("property: never throws and always echoes the raw source", () => {
		fc.assert(
			fc.property(fc.string(), fc.string(), (inner, raw) => {
				const parsed = parseWikiLink(inner, raw);
				return parsed.raw === raw && typeof parsed.target === "string";
			}),
		);
	});

	test("property: parsing a live match round-trips its raw source", () => {
		fc.assert(
			fc.property(fc.string(), (input) => {
				for (const match of findWikilinkMatches(input)) {
					const parsed = parseWikiLink(match.inner, match.fullMatch);
					if (parsed.raw !== match.fullMatch) return false;
				}
				return true;
			}),
		);
	});
});
