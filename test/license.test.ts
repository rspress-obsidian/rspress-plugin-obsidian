import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// The MIT license asks two things of anyone redistributing the work: keep the
// copyright notices and keep the permission notice. This package merges three
// separately licensed plugins, so "the notices" are those of each upstream work
// — those are asserted, and nothing else about the file's wording is. npm ships
// every root `LICENSE*` file regardless of `package.json#files`, so the root
// LICENSE is the notice consumers actually receive.
const repoRoot = path.resolve(import.meta.dir, "..");
const license = readFileSync(path.join(repoRoot, "LICENSE"), "utf8");

test("LICENSE carries the MIT permission notice and its conditions", () => {
	expect(license).toContain("Permission is hereby granted, free of charge");
	expect(license).toContain(
		"The above copyright notice and this permission notice shall be included",
	);
	expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
});

test("LICENSE retains the copyright notice of every upstream work", () => {
	// Holders whose MIT-licensed code was merged in; their notices must survive
	// any cleanup. New holders may be added freely.
	for (const holder of ["Rspress contributors", "Jacob Valor"]) {
		expect(license).toMatch(new RegExp(`^Copyright \\(c\\) .*${holder}`, "m"));
	}
});

test("the package ships a single root LICENSE file", () => {
	// A stray LICENSE-*.txt beside LICENSE would ship too, as a second and
	// potentially stale copy of the notice.
	expect(readdirSync(repoRoot).filter((name) => /^LICENSE/i.test(name))).toEqual(["LICENSE"]);
});
