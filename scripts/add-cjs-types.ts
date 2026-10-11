#!/usr/bin/env bun
/**
 * Writes the `.d.cts` declarations CommonJS consumers resolve.
 *
 * The package sets `"type": "module"`, so the `.d.ts` files `tsc` emits are
 * ESM-flavored: a CJS consumer resolving through the `require` condition
 * needs a CommonJS-flavored declaration, or TypeScript sees ESM types over
 * CJS JavaScript ("masquerading as ESM" — the attw `false-esm` finding and
 * publint's shared-`types`-condition warning).
 *
 * A verbatim copy is not enough past the entry file: TypeScript resolves the
 * twin's relative specifier `./canvas/index.js` to `canvas/index.d.ts`, so the
 * chain would fall back into the ESM declarations one hop in. Each twin
 * therefore has its relative `.js` specifiers rewritten to `.cjs`, which
 * resolves to the next `.d.cts`, and the walk starts from the `require.types`
 * targets in the exports map and twins only what those reach — CJS consumers
 * can never see the rest.
 *
 * Runs after `tsc -p tsconfig.build.json` in `bun run build`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");

/** Relative specifiers in `from "…"`, `import("…")` and `import "…"` forms. */
const RELATIVE_SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])(\.\.?\/[^"']*)\2/g;

/** The `require.types` targets of the exports map: where CJS resolution starts. */
export function requireTypesEntries(exportsMap: Record<string, unknown>): string[] {
	const entries: string[] = [];
	for (const conditions of Object.values(exportsMap)) {
		if (typeof conditions !== "object" || conditions === null || !("require" in conditions)) {
			continue;
		}
		const requireBranch = conditions.require;
		if (
			typeof requireBranch === "object" &&
			requireBranch !== null &&
			"types" in requireBranch &&
			typeof requireBranch.types === "string"
		) {
			entries.push(requireBranch.types);
		}
	}
	return entries;
}

/**
 * Write the `.d.cts` twin for every declaration reachable from `entries`
 * (package-root-relative `.d.cts` paths), returning the twins written.
 *
 * @throws When an entry's `.d.ts` source is missing, or a relative specifier
 *   does not end in `.js` — such a specifier cannot be pointed at a twin, and
 *   leaving it would silently break the CJS chain.
 */
export function writeCjsTwins(packageRoot: string, entries: string[]): string[] {
	const written: string[] = [];
	const queue = entries.map((entry) => path.join(packageRoot, entry));
	const seen = new Set<string>();
	while (queue.length > 0) {
		const twin = queue.shift() as string;
		if (seen.has(twin)) continue;
		seen.add(twin);
		const source = `${twin.slice(0, -".d.cts".length)}.d.ts`;
		if (!existsSync(source)) {
			throw new Error(`[add-cjs-types] ${path.relative(packageRoot, source)} does not exist`);
		}
		const rewritten = readFileSync(source, "utf8").replace(
			RELATIVE_SPECIFIER,
			(_match, lead: string, quote: string, specifier: string) => {
				if (!specifier.endsWith(".js")) {
					throw new Error(
						`[add-cjs-types] ${path.relative(packageRoot, source)}: relative specifier "${specifier}" has no .js extension`,
					);
				}
				const target = path.resolve(
					path.dirname(source),
					`${specifier.slice(0, -".js".length)}.d.cts`,
				);
				queue.push(target);
				return `${lead}${quote}${specifier.slice(0, -".js".length)}.cjs${quote}`;
			},
		);
		writeFileSync(twin, rewritten);
		written.push(twin);
	}
	return written;
}

if (import.meta.main) {
	const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
		exports: Record<string, unknown>;
	};
	const entries = requireTypesEntries(manifest.exports);
	if (entries.length === 0) {
		console.error("[add-cjs-types] the exports map has no `require.types` targets");
		process.exit(1);
	}
	try {
		const written = writeCjsTwins(root, entries);
		console.log(`[add-cjs-types] wrote ${written.length} .d.cts declaration(s)`);
	} catch (error) {
		console.error(error instanceof Error ? error.message : error);
		process.exit(1);
	}
}
