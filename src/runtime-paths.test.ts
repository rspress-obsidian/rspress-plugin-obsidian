import { describe, expect, test } from "bun:test";
import path from "node:path";
import { moduleDir, resolveRuntimeFile } from "./runtime-paths.ts";

const here = path.join(moduleDir, "runtime-paths.ts");

describe("resolveRuntimeFile", () => {
	test("returns the first candidate that exists", () => {
		expect(resolveRuntimeFile(path.join(moduleDir, "does-not-exist.ts"), here)).toBe(here);
		expect(resolveRuntimeFile(here)).toBe(here);
	});

	test("throws with every candidate when none exists", () => {
		const missing = [path.join(moduleDir, "nope-a.ts"), path.join(moduleDir, "nope-b.ts")];
		// A silent fallback would hand Rspress a nonexistent path and the real
		// failure (package layout mismatch) would only show up much later.
		expect(() => resolveRuntimeFile(...missing)).toThrow(/no runtime file found/);
		for (const candidate of missing) {
			expect(() => resolveRuntimeFile(...missing)).toThrow(candidate);
		}
	});

	test("throws when called with no candidates", () => {
		expect(() => resolveRuntimeFile()).toThrow(/no runtime file found/);
	});
});
