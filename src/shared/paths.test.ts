import { describe, expect, test } from "bun:test";
import { encodeTagPathSegment, normalizeFilePathKey } from "./paths";

/**
 * `src/shared/` had no test file of its own, and these two functions are reached
 * from every feature, so the coverage gate was the only thing standing between
 * a shared primitive and no test at all.
 */
describe("shared/paths", () => {
	describe("normalizeFilePathKey", () => {
		test("strips a Markdown extension, folds backslashes and trims slashes", () => {
			expect(normalizeFilePathKey("guide\\setup.md")).toBe("guide/setup");
			expect(normalizeFilePathKey("/guide/setup.MDX")).toBe("guide/setup");
			expect(normalizeFilePathKey("  guide/setup.md  ")).toBe("guide/setup");
		});

		test("leaves a name that merely contains a dot alone", () => {
			// A prose note title is not a filename with an extension, and the
			// canvas embed path broke on exactly this shape once already. Casing is
			// the caller's business — this only folds separators and the extension.
			expect(normalizeFilePathKey("Chapter 1. Introduction")).toBe("Chapter 1. Introduction");
		});

		test("folds unicode to NFC so the reader matches the writer", () => {
			// NFD (decomposed) must land on the same key as NFC (composed), or an
			// accented note name resolves on one machine and not another.
			const nfc = "café/naïve.md";
			const nfd = nfc.normalize("NFD");
			expect(nfd).not.toBe(nfc);
			expect(normalizeFilePathKey(nfd)).toBe(normalizeFilePathKey(nfc));
		});
	});

	describe("encodeTagPathSegment", () => {
		test("encodes the characters that would break a URL path segment", () => {
			expect(encodeTagPathSegment("needs space")).toBe("needs%20space");
			expect(encodeTagPathSegment("a/b")).toBe("a/b");
			expect(encodeTagPathSegment("q&a")).toBe("q%26a");
		});

		test("warns and returns empty rather than emitting a bare segment", () => {
			// The branch the coverage gate flagged: an empty tag has no encoding,
			// and a route ending in `/tags/` would be published silently.
			const warnings: unknown[][] = [];
			const original = console.warn;
			console.warn = (...args: unknown[]) => warnings.push(args);
			try {
				expect(encodeTagPathSegment("")).toBe("");
			} finally {
				console.warn = original;
			}
			expect(warnings).toHaveLength(1);
			expect(String(warnings[0]?.[0])).toContain("encoded to an empty path segment");
		});
	});
});
