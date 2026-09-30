import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { normalizeUnicode } from "../shared/slug.js";
import {
	isPathInsideRoot,
	isRealPathInsideRoot,
	normalizeFilePathKey,
	normalizeRealPath,
} from "./utils.ts";

/** The remark pass reports forward-slash paths while `vaultRoot` comes from
 *  `path.resolve`; a `path.sep` prefix test silently fails on Windows. */
describe("isPathInsideRoot", () => {
	test("matches a forward-slash file path against a native-separator root", () => {
		expect(isPathInsideRoot("C:/vault/note.md", "C:\\vault")).toBe(true);
		expect(isPathInsideRoot("C:/vault/nested/note.md", "C:\\vault\\")).toBe(true);
		expect(isPathInsideRoot("/vault/note.md", "/vault")).toBe(true);
	});

	test("rejects siblings, parents and prefix lookalikes", () => {
		expect(isPathInsideRoot("/vault-other/note.md", "/vault")).toBe(false);
		expect(isPathInsideRoot("/other/note.md", "/vault")).toBe(false);
		expect(isPathInsideRoot("/vault", "/vault")).toBe(false);
	});

	test("compares case-insensitively on the platforms whose filesystem is", () => {
		// `C:\Vault` and `C:\vault` are one directory on Windows/macOS. A
		// case-sensitive test sends the file to the docs root instead, silently
		// disabling vault processing for it.
		expect(isPathInsideRoot("C:/Vault/Note.md", "c:\\vault", "win32")).toBe(true);
		expect(isPathInsideRoot("/Vault/Note.md", "/vault", "darwin")).toBe(true);
	});

	test("stays case-sensitive where the filesystem is", () => {
		expect(isPathInsideRoot("/Vault/Note.md", "/vault", "linux")).toBe(false);
	});
});

/**
 * Node's `realpathSync` returns an extended-length path (`\\?\C:\…`, or
 * `\\?\UNC\server\share\…`) once a path exceeds `MAX_PATH` on Windows, while
 * the vault root it is compared against usually stays unprefixed — so the
 * containment test fails in both directions. Only Windows can produce a real
 * one; these are synthetic strings, and the Windows CI leg covers the real case.
 */
describe("normalizeRealPath", () => {
	test("strips the extended-length drive prefix", () => {
		expect(normalizeRealPath("\\\\?\\C:\\vault\\note.md")).toBe("C:\\vault\\note.md");
		expect(normalizeRealPath("\\\\?\\C:\\")).toBe("C:\\");
	});

	test("rewrites an extended-length UNC share to the normal form", () => {
		expect(normalizeRealPath("\\\\?\\UNC\\server\\share\\note.md")).toBe(
			"\\\\server\\share\\note.md",
		);
	});

	test("leaves ordinary paths untouched", () => {
		expect(normalizeRealPath("C:\\vault\\note.md")).toBe("C:\\vault\\note.md");
		expect(normalizeRealPath("/vault/note.md")).toBe("/vault/note.md");
		expect(normalizeRealPath("relative/note.md")).toBe("relative/note.md");
	});
});

describe("isRealPathInsideRoot", () => {
	test("accepts a prefixed candidate under an unprefixed root", () => {
		expect(isRealPathInsideRoot("\\\\?\\C:\\vault\\note.md", "C:\\vault")).toBe(true);
	});

	test("accepts an unprefixed candidate under a prefixed root", () => {
		expect(isRealPathInsideRoot("C:\\vault\\note.md", "\\\\?\\C:\\vault")).toBe(true);
	});

	test("accepts prefixed/parent-equal pairs and tolerates a trailing separator", () => {
		expect(isRealPathInsideRoot("\\\\?\\C:\\vault\\note.md", "\\\\?\\C:\\vault\\")).toBe(true);
		expect(isRealPathInsideRoot("\\\\?\\C:\\vault", "C:\\vault")).toBe(true);
	});

	test("handles both UNC forms", () => {
		expect(isRealPathInsideRoot("\\\\?\\UNC\\server\\share\\note.md", "\\\\server\\share")).toBe(
			true,
		);
		expect(isRealPathInsideRoot("\\\\server\\share\\note.md", "\\\\?\\UNC\\server\\share")).toBe(
			true,
		);
	});

	test("still refuses a genuine escape", () => {
		expect(isRealPathInsideRoot("C:\\other\\secret.md", "C:\\vault")).toBe(false);
		expect(isRealPathInsideRoot("\\\\?\\C:\\other\\secret.md", "C:\\vault")).toBe(false);
		expect(
			isRealPathInsideRoot("\\\\?\\UNC\\server\\elsewhere\\secret.md", "\\\\server\\share"),
		).toBe(false);
	});

	test("still refuses a sibling whose name merely starts with the root", () => {
		expect(isRealPathInsideRoot("C:\\vault-other\\note.md", "C:\\vault")).toBe(false);
		expect(isRealPathInsideRoot("/vault-other/note.md", "/vault")).toBe(false);
	});

	test("matches POSIX realpaths the same way", () => {
		expect(isRealPathInsideRoot("/vault/note.md", "/vault")).toBe(true);
		expect(isRealPathInsideRoot("/vault", "/vault")).toBe(true);
		expect(isRealPathInsideRoot("/elsewhere/note.md", "/vault")).toBe(false);
	});
});

/** macOS stores filenames decomposed (NFD) while note text is usually composed
 *  (NFC); Linux can create either, so both halves are testable here. The
 *  index-level consequence is covered in `content-index.test.ts`. */
describe("normalizeFilePathKey", () => {
	const NFD_CAFE = "cafe\u0301";
	const NFC_CAFE = "caf\u00e9";

	test("folds a decomposed filename onto the composed lookup key", () => {
		expect(normalizeUnicode(NFD_CAFE)).toBe(NFC_CAFE);
		expect(normalizeFilePathKey(`${NFD_CAFE}.md`)).toBe(NFC_CAFE);
		expect(normalizeFilePathKey(`${NFC_CAFE}.MD`)).toBe(NFC_CAFE);
	});

	test("keeps the existing path normalization", () => {
		expect(normalizeFilePathKey("\\notes\\Welcome.md")).toBe("notes/Welcome");
		expect(normalizeFilePathKey("/notes/Welcome.mdx")).toBe("notes/Welcome");
	});
});

describe("normalizeRealPath (property)", () => {
	test("property: idempotent — stripping twice equals stripping once", () => {
		fc.assert(
			fc.property(fc.string(), (input) => {
				const once = normalizeRealPath(input);
				return normalizeRealPath(once) === once;
			}),
		);
	});

	test("property: output never carries the extended-length prefix", () => {
		fc.assert(fc.property(fc.string(), (input) => !normalizeRealPath(input).startsWith("\\\\?\\")));
	});
});

describe("isPathInsideRoot (property)", () => {
	test("property: a child joined under the root is always inside it", () => {
		fc.assert(
			fc.property(
				fc.string(),
				fc.string(),
				fc.constantFrom("win32", "linux", "darwin"),
				(root, child, platform) => isPathInsideRoot(`${root}/${child}`, root, platform),
			),
		);
	});
});

describe("isRealPathInsideRoot (property)", () => {
	test("property: a child joined under the root is always inside it", () => {
		fc.assert(
			fc.property(fc.string(), fc.string(), (root, child) =>
				isRealPathInsideRoot(`${root}/${child}`, root),
			),
		);
	});
});
