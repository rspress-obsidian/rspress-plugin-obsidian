import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// npm ships every root `LICENSE*` file regardless of `package.json#files`, so a
// stray LICENSE-*.txt beside LICENSE would ship too, as a second and
// potentially stale copy of the notice.
const repoRoot = path.resolve(import.meta.dir, "..");

test("the package ships a single root LICENSE file", () => {
	expect(readdirSync(repoRoot).filter((name) => /^LICENSE/i.test(name))).toEqual(["LICENSE"]);
});

test("LICENSE keeps the copyright notice of every upstream MIT work", () => {
	// MIT obliges every copy to keep the original copyright notices. This package
	// merges separately released MIT works, so each holder's line must survive any
	// cleanup; nothing else about the file's wording is pinned, and holders may be
	// added freely.
	const license = readFileSync(path.join(repoRoot, "LICENSE"), "utf8");
	const holders = [
		"Rspress contributors",
		"Jacob Valor",
		"rspress-plugin-obsidian-canvas contributors",
	];
	for (const holder of holders) {
		expect(license).toMatch(new RegExp(`^Copyright \\(c\\) .*${holder}`, "m"));
	}
});
