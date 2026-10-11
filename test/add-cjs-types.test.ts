import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireTypesEntries, writeCjsTwins } from "../scripts/add-cjs-types";

let dir = "";

afterEach(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
	dir = "";
});

function fixture(files: Record<string, string>): string {
	dir = mkdtempSync(path.join(os.tmpdir(), "add-cjs-types-"));
	for (const [name, content] of Object.entries(files)) {
		const file = path.join(dir, name);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, content);
	}
	return dir;
}

test("reads the require.types targets from the exports map", () => {
	expect(
		requireTypesEntries({
			".": { import: { types: "./dist/index.d.ts" }, require: { types: "./dist/index.d.cts" } },
			"./graph/runtime/GraphPanel": { types: "./dist/graph/runtime/GraphPanel.d.ts" },
			"./styles.css": "./dist/styles.css",
		}),
	).toEqual(["./dist/index.d.cts"]);
});

test("chains every reachable twin through .cjs specifiers and skips the rest", () => {
	const root = fixture({
		"dist/index.d.ts": [
			'import type { A } from "./feature/index.js";',
			'export { b } from "./feature/b.js";',
			'export type Lazy = import("./feature/index.js").A;',
			'import type { Root } from "mdast";',
		].join("\n"),
		"dist/feature/index.d.ts": 'export type A = import("./b.js").B;',
		"dist/feature/b.d.ts": "export type B = string;\nexport declare const b: B;",
		"dist/browser-only.d.ts": "export declare const unreachable: true;",
	});

	const written = writeCjsTwins(root, ["./dist/index.d.cts"]).map((file) =>
		path.relative(root, file).split(path.sep).join("/"),
	);

	expect(written.sort()).toEqual(
		["dist/feature/b.d.cts", "dist/feature/index.d.cts", "dist/index.d.cts"].sort(),
	);
	expect(existsSync(path.join(root, "dist/browser-only.d.cts"))).toBe(false);
	const entry = readFileSync(path.join(root, "dist/index.d.cts"), "utf8");
	expect(entry).toContain('from "./feature/index.cjs"');
	expect(entry).toContain('from "./feature/b.cjs"');
	expect(entry).toContain('import("./feature/index.cjs")');
	// Package specifiers are not relative and stay as they are.
	expect(entry).toContain('from "mdast"');
	expect(readFileSync(path.join(root, "dist/feature/index.d.cts"), "utf8")).toContain(
		'import("./b.cjs")',
	);
});

test("refuses a relative specifier it cannot point at a twin", () => {
	const root = fixture({ "dist/index.d.ts": 'export * from "./feature";' });
	expect(() => writeCjsTwins(root, ["./dist/index.d.cts"])).toThrow(/no \.js extension/);
});

test("refuses an entry whose declaration was never emitted", () => {
	const root = fixture({});
	expect(() => writeCjsTwins(root, ["./dist/index.d.cts"])).toThrow(/does not exist/);
});
