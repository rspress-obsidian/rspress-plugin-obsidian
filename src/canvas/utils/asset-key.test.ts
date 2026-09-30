import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { normalizeAssetKey } from "./asset-key";

// The writer keys the asset/note map with this and the reader looks targets up
// with it; these are the fold rules both sides depend on.
describe("normalizeAssetKey", () => {
	test("lowercases and normalizes separators", () => {
		expect(normalizeAssetKey("Assets/Clip.PNG")).toBe("assets/clip.png");
		expect(normalizeAssetKey("Assets\\Clip.PNG")).toBe("assets/clip.png");
		expect(normalizeAssetKey("./Assets/clip.png")).toBe("assets/clip.png");
		expect(normalizeAssetKey("/Assets/clip.png")).toBe("assets/clip.png");
	});

	test("resolves `..` by popping instead of dropping the segment", () => {
		expect(normalizeAssetKey("../images/photo.png")).toBe("images/photo.png");
		expect(normalizeAssetKey("notes/../images/photo.png")).toBe("images/photo.png");
		// A `..` above the root has nothing left to pop; the reference still
		// has to land on a stable key rather than an empty or mangled one.
		expect(normalizeAssetKey("../../photo.png")).toBe("photo.png");
	});

	test("ignores the subpath after `#`", () => {
		expect(normalizeAssetKey("note.md#A heading")).toBe("note.md");
		expect(normalizeAssetKey("image.png#x=1")).toBe("image.png");
	});
});

describe("normalizeAssetKey (property)", () => {
	test("property: idempotent — the folded key is already folded", () => {
		fc.assert(
			fc.property(fc.string(), (value) => {
				const once = normalizeAssetKey(value);
				return normalizeAssetKey(once) === once;
			}),
		);
	});

	test("property: keys are lowercase with no empty or dot segments", () => {
		fc.assert(
			fc.property(fc.string(), (value) => {
				const key = normalizeAssetKey(value);
				if (key !== key.toLowerCase()) return false;
				// A key that resolves to nothing is the documented `..`-above-root
				// case; any non-empty key must be fully canonical.
				return (
					key === "" ||
					!key.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
				);
			}),
		);
	});
});
