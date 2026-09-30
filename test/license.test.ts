import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// The merged work carries copyright notices from three separately published
// plugins. npm always ships every root `LICENSE*` file regardless of
// `package.json#files`, so the root LICENSE is the notice consumers actually
// receive — these assertions exist so a cleanup cannot silently drop a line
// that already shipped in a published tarball.
const repoRoot = path.resolve(import.meta.dir, "..");
const licensePath = path.join(repoRoot, "LICENSE");
const license = readFileSync(licensePath, "utf8");

test("LICENSE retains every copyright line the merged plugins shipped", () => {
	const copyrightLines = [
		"Copyright (c) 2025-present Rspress contributors",
		"Copyright (c) 2026 Jacob Valor",
		"Copyright (c) 2026 rspress-plugin-obsidian-canvas contributors from Jacob",
	];
	for (const line of copyrightLines) {
		expect(license).toContain(line);
	}
	expect(license.match(/^Copyright \(c\) /gm)).toHaveLength(copyrightLines.length);
});

test("LICENSE carries the full MIT grant", () => {
	expect(license).toContain("MIT License");
	expect(license).toContain("Permission is hereby granted, free of charge");
	expect(license).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
	expect(license).toContain(
		"The above copyright notice and this permission notice shall be included",
	);
});

test("LICENSE names the three merged plugins", () => {
	expect(license).toContain("rspress-plugin-obsidian-wikilink");
	expect(license).toContain("rspress-plugin-obsidian-canvas");
	expect(license).toContain("rspress-plugin-graph-view");
});

test("the package ships a single root LICENSE file", () => {
	// Separate LICENSE-*.txt files used to sit beside LICENSE; the notices now
	// live inside it, so a resurrected partial file would be a second, and
	// potentially stale, copy of the notice.
	const licenseFiles = readdirSync(repoRoot).filter((name) => /^LICENSE/i.test(name));
	expect(licenseFiles).toEqual(["LICENSE"]);

	const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
		files: string[];
	};
	expect(pkg.files).toContain("LICENSE");
	expect(existsSync(licensePath)).toBe(true);
});
