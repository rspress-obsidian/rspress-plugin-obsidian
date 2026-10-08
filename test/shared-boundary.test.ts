import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";

/**
 * `src/shared/` holds the primitives more than one feature needs, so the rule
 * that keeps it that way is mechanical and worth a test rather than a note in a
 * README: nothing in there may import `node:*` or reach into a feature.
 *
 * Both halves have bitten this codebase. `route-path.ts` exists, and is
 * documented as node-free, purely so the browser bundle does not inherit
 * `node:fs`; and `link-extractor.ts` once imported a 45-line pure function
 * through `content-index.ts`, dragging that module's `node:fs` with it. Neither
 * was a bug at the time — both were one careless import away from being one.
 */

const SRC = path.join(import.meta.dir, "..", "src");
const SHARED = path.join(SRC, "shared");
const FEATURES = ["markdown", "canvas", "graph"];

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...sourceFiles(full));
			continue;
		}
		if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
	}
	return out;
}

/**
 * Every module specifier a source file loads: static `import … from`,
 * `export … from`, side-effect `import "…"`, dynamic `import("…")` and
 * `require("…")`. Comments are dropped first so prose cannot trip it.
 */
function moduleSpecifiers(source: string): string[] {
	const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
	const pattern =
		/\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']/g;
	return [...code.matchAll(pattern)].map(
		(match) => match[1] ?? match[2] ?? match[3] ?? match[4] ?? "",
	);
}

/** `node:fs`, `fs`, `fs/promises`, … — anything Node resolves as a builtin. */
function isNodeBuiltin(specifier: string): boolean {
	return specifier.startsWith("node:") || builtinModules.includes(specifier);
}

describe("src/shared boundary", () => {
	const files = sourceFiles(SHARED);

	test("is scanned at all", () => {
		// Guards the checks below against passing vacuously after a move.
		expect(files.length).toBeGreaterThan(0);
	});

	test("no module imports node builtins, in any import form", () => {
		const offenders: string[] = [];
		for (const file of files) {
			for (const specifier of moduleSpecifiers(readFileSync(file, "utf-8"))) {
				if (isNodeBuiltin(specifier)) offenders.push(`${path.relative(SRC, file)} -> ${specifier}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("the builtin guard sees every import form", () => {
		const forms = [
			'import fs from "node:fs";',
			'import { join } from "path";',
			'export { readFile } from "fs/promises";',
			'import "node:process";',
			'const os = await import("node:os");',
			"const os = await import('os');",
			'const cp = require("child_process");',
		];
		for (const form of forms) {
			expect(moduleSpecifiers(form).some(isNodeBuiltin)).toBe(true);
		}
		const clean = [
			'import { visit } from "unist-util-visit";',
			'// import fs from "node:fs";',
			'import { x } from "./path.js";',
		].join("\n");
		expect(moduleSpecifiers(clean).some(isNodeBuiltin)).toBe(false);
	});

	test("no module reaches into a feature", () => {
		const offenders: string[] = [];
		for (const file of files) {
			const source = readFileSync(file, "utf-8");
			// `../markdown/`, `../../canvas/`, … — a shared module that needs a
			// feature is a feature-pure module that has not been extracted yet.
			for (const feature of FEATURES) {
				if (new RegExp(`from "\\.{1,2}/${feature}/`).test(source)) {
					offenders.push(`${path.relative(SRC, file)} -> ${feature}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test("only build-time code reaches into another feature, and only into markdown's", () => {
		// The markdown feature owns the content index and link resolution, and
		// the canvas and graph build steps reuse them so all three agree on what
		// a link means (vault containment, `resolveWikiLink`, the page index).
		// That is node-side code. Browser code — runtime components, canvas
		// components and hooks — must never import across features: whatever it
		// imports lands in the client bundle, node dependencies included.
		const isBrowserCode = (relative: string) =>
			/\/(runtime|components|hooks)\//.test(`/${relative}`) || relative.endsWith(".tsx");

		const offenders: string[] = [];
		for (const feature of FEATURES) {
			const dir = path.join(SRC, feature);
			if (!statSync(dir).isDirectory()) continue;
			for (const file of sourceFiles(dir)) {
				for (const specifier of moduleSpecifiers(readFileSync(file, "utf-8"))) {
					if (!specifier.startsWith(".")) continue;
					// Resolve the specifier to a real file before judging it. A
					// textual `canvas/` match is not evidence of a cross-feature
					// import: `graph/runtime/` has a directory of its own named
					// `canvas`, and `./canvas/colors.js` from inside graph is graph's.
					const resolved = path.resolve(path.dirname(file), specifier);
					const target = FEATURES.find(
						(candidate) =>
							resolved === path.join(SRC, candidate) ||
							resolved.startsWith(`${path.join(SRC, candidate)}${path.sep}`),
					);
					if (!target || target === feature) continue;
					// `/`-normalised so the message reads the same on Windows.
					const relative = path.relative(SRC, file).replace(/\\/g, "/");
					const targetRelative = path.relative(SRC, resolved).replace(/\\/g, "/");
					if (isBrowserCode(relative) || target !== "markdown" || isBrowserCode(targetRelative)) {
						offenders.push(`${relative} -> ${specifier}`);
					}
				}
			}
		}

		expect(offenders).toEqual([]);
	});
});
