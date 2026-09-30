#!/usr/bin/env bun
/**
 * Copies every emitted declaration file to a `.d.cts` twin.
 *
 * The package sets `"type": "module"`, so the `.d.ts` files `tsc` emits are
 * ESM-flavored: a CJS consumer resolving through the `require` condition
 * needs a CommonJS-flavored declaration, or TypeScript sees ESM types over
 * CJS JavaScript ("masquerading as ESM" — the attw `false-esm` finding and
 * publint's shared-`types`-condition warning). The copies are verbatim: the
 * only difference between the two files is the extension that selects how
 * TypeScript interprets them.
 *
 * Every declaration is copied, not just the four entries: a `.d.cts` reached
 * through a relative specifier (`./canvas/index.js`) resolves to the twin of
 * that target, so partial coverage would break mid-graph.
 *
 * Runs after `tsc -p tsconfig.build.json` in `bun run build`.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const distDir = path.join(root, "dist");

/** Every `*.d.ts` under dist/, relative to dist/. */
function declarationFiles(dir: string): string[] {
	const found: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...declarationFiles(full));
		else if (entry.name.endsWith(".d.ts")) found.push(full);
	}
	return found;
}

let copied = 0;
for (const file of declarationFiles(distDir)) {
	const twin = `${file.slice(0, -".d.ts".length)}.d.cts`;
	writeFileSync(twin, readFileSync(file, "utf8"));
	copied += 1;
}

if (copied === 0) {
	console.error("[add-cjs-types] found no declarations in dist/ — did `tsc` run?");
	process.exit(1);
}
console.log(`[add-cjs-types] wrote ${copied} .d.cts twin(s)`);
