import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Documentation is executable surface that no test suite sees. Three separate
 * defects got through a fully green run this way — a quick-start config that
 * imported a symbol the package no longer exported, an import of a `.css`
 * subpath that Node cannot resolve from `rspress.config.ts`, and a JSDoc example
 * that imported one name and called another. All three were invisible to 1281
 * unit tests and 41 browser tests, because a fenced code block is a string.
 *
 * So this reads the fences. It does not run them — that is
 * `scripts/check-doc-examples.ts`, which the CI release job invokes — but it
 * catches the class that is cheapest to catch statically: a doc naming a symbol
 * the package does not export, or calling a factory it never imported.
 */

const ROOT = path.resolve(import.meta.dir, "..");
const DOC_DIRS = ["docs"];
const DOC_FILES = ["README.md"];
const FACTORIES = ["markdown", "canvas", "graphview", "pluginObsidian"];

/** Every value and type the umbrella entry exports, read from its own source. */
function publicSurface(): Set<string> {
	const source = readFileSync(path.join(ROOT, "src", "index.ts"), "utf-8");
	const names = new Set<string>();
	// Two forms reach this file: `export { a, type B } from "…"` /
	// `export type { … }`, and a direct declaration such as
	// `export function pluginObsidian(…)`. Missing the second is how this test
	// reported a real export as missing on its first run.
	for (const match of source.matchAll(
		/^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|abstract\s+class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm,
	)) {
		names.add(match[1] as string);
	}

	for (const match of source.matchAll(
		/export\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s*["'][^"']*["'])?/g,
	)) {
		for (const part of (match[1] ?? "").split(",")) {
			const name = part
				.trim()
				.replace(/^type\s+/, "")
				.split(/\s+as\s+/)[0]
				?.trim();
			if (name) names.add(name);
		}
	}
	return names;
}

function docFiles(): string[] {
	const out: string[] = [];
	for (const dir of DOC_DIRS) {
		const walk = (current: string) => {
			for (const entry of readdirSync(current)) {
				const full = path.join(current, entry);
				if (statSync(full).isDirectory()) walk(full);
				else if (/\.mdx?$/.test(entry)) out.push(full);
			}
		};
		walk(path.join(ROOT, dir));
	}
	for (const file of DOC_FILES) out.push(path.join(ROOT, file));
	return out;
}

/** Every fenced `ts`/`tsx` block, with where it came from for a useful failure. */
function fences(): Array<{ file: string; line: number; code: string }> {
	const out: Array<{ file: string; line: number; code: string }> = [];
	for (const file of docFiles()) {
		const lines = readFileSync(file, "utf-8").split("\n");
		let open = false;
		let start = 0;
		let buffer: string[] = [];
		for (const [index, line] of lines.entries()) {
			if (!open && /^```(ts|tsx|typescript)\s*$/.test(line)) {
				open = true;
				start = index + 2;
				buffer = [];
				continue;
			}
			if (open && /^```\s*$/.test(line)) {
				out.push({ file: path.relative(ROOT, file), line: start, code: buffer.join("\n") });
				open = false;
				continue;
			}
			if (open) buffer.push(line);
		}
	}
	return out;
}

const SURFACE = publicSurface();
const ALL_FENCES = fences();

describe("documented examples", () => {
	test("there are examples to check, so this file cannot pass vacuously", () => {
		expect(ALL_FENCES.length).toBeGreaterThan(40);
	});

	test("every symbol imported from the package is actually exported", () => {
		const bad: string[] = [];
		for (const fence of ALL_FENCES) {
			const imports = fence.code.matchAll(
				/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']rspress-plugin-obsidian(?:\/[^"']*)?["']/g,
			);
			for (const group of imports) {
				for (const part of (group[1] ?? "").split(",")) {
					const name = part
						.trim()
						.replace(/^type\s+/, "")
						.split(/\s+as\s+/)[0]
						?.trim();
					// A subpath import (`…/markdown`) is about files, not symbols.
					if (!name || name.startsWith("/") || name.startsWith(".")) continue;
					if (!SURFACE.has(name)) {
						bad.push(`${fence.file}:${fence.line} imports \`${name}\`, which is not exported`);
					}
				}
			}
		}
		expect(bad).toEqual([]);
	});

	test("an example that calls a factory imports it", () => {
		// The JSDoc in `src/markdown/index.ts` shipped an example that imported
		// one name and called another; inside a doc fence the same slip reads as
		// working code and teaches a broken first line.
		//
		// The name has to be compared against what the fence actually imports.
		// An earlier version tested `!code.includes(factory)`, which is
		// unsatisfiable — any string matching `canvas(` contains "canvas" — so
		// the guard could never fire. `check-doc-examples.ts` papers over the
		// symptom by prepending the missing import before type-checking, so this
		// static check is the only thing standing between a doc and a
		// copy-paste that does not run.
		const bad: string[] = [];
		for (const fence of ALL_FENCES) {
			// `pluginObsidian((markdown, canvas, graphview) => …)` hands the three
			// factories in as parameters, so the names are bound without an import.
			if (/\bpluginObsidian\s*\(/.test(fence.code)) continue;
			const imported = new Set<string>();
			for (const group of fence.code.matchAll(
				/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']rspress-plugin-obsidian(?:\/[^"']*)?["']/g,
			)) {
				for (const part of (group[1] ?? "").split(",")) {
					const name = part
						.trim()
						.replace(/^type\s+/, "")
						.split(/\s+as\s+/)[0]
						?.trim();
					if (name) imported.add(name);
				}
			}
			if (imported.size === 0) continue;
			for (const factory of FACTORIES) {
				if (new RegExp(`\\b${factory}\\s*\\(`).test(fence.code) && !imported.has(factory)) {
					bad.push(
						`${fence.file}:${fence.line} calls ${factory}() but imports only ${[...imported].join(", ")}`,
					);
				}
			}
		}
		expect(bad).toEqual([]);
	});

	test("no example imports a stylesheet into rspress.config.ts", () => {
		// Rspress loads the config with Node, not the bundler, so any `.css`
		// specifier fails before the build starts — with or without `?url`.
		const bad: string[] = [];
		for (const fence of ALL_FENCES) {
			if (/^import\s+[\w$]+\s+from\s*["'][^"']*\.css(\?url)?["']/m.test(fence.code)) {
				bad.push(`${fence.file}:${fence.line} imports a .css module`);
			}
		}
		expect(bad).toEqual([]);
	});

	test("the source JSDoc example for markdown() is consistent", () => {
		// The one surface TypeScript itself never type-checks.
		const source = readFileSync(path.join(ROOT, "src", "markdown", "index.ts"), "utf-8");
		const doc = source.match(/\/\*\*[\s\S]*?\*\/\s*export function markdown\(/)?.[0] ?? "";
		const imported = [...doc.matchAll(/import\s*\{([^}]*)\}/g)].map((m) => (m[1] ?? "").trim());
		for (const name of FACTORIES) {
			if (new RegExp(`\\b${name}\\s*\\(`).test(doc) && !imported.includes(name)) {
				expect(`${name} is called in the JSDoc but not imported there`).toBe(`${name} is imported`);
			}
		}
	});
});
