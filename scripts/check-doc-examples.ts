/**
 * Type-check the config the documentation tells people to copy.
 *
 * `docs/getting-started.md` and `docs/markdown/guide/getting-started.md` are the
 * first thing a new user runs, and nothing in the suite executes them — a fenced
 * code block is a string, so a config naming a removed export, a misspelled
 * option, or a plugin shape Rspress rejects passes typecheck, lint, 1281 unit
 * tests and 41 browser tests without a murmur. All three of those happened.
 *
 * This extracts every `defineConfig` block from the docs, writes it somewhere
 * Node can resolve `node_modules` from, and runs `tsc --noEmit` over it. It is a
 * type check, not a build: it proves the documented config is well-formed and
 * that every symbol and option it names exists, which is the class of defect
 * worth catching here. `bun run docs:build` already proves the site itself.
 *
 * `test/doc-examples.test.ts` covers the same fences statically and runs in the
 * unit suite; this is the half that needs a compiler.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const SOURCES = [
	"docs/getting-started.md",
	"docs/markdown/guide/getting-started.md",
	"docs/graph/guide/getting-started.md",
	"docs/canvas/guide/getting-started.md",
];

const FACTORIES = ["markdown", "canvas", "graphview", "pluginObsidian"];

/** A fenced `ts` block that configures Rspress, with its import lines. */
function configFences(): Array<{ source: string; line: number; code: string }> {
	const out: Array<{ source: string; line: number; code: string }> = [];
	for (const source of SOURCES) {
		const full = path.join(ROOT, source);
		let text: string;
		try {
			text = readFileSync(full, "utf-8");
		} catch {
			continue;
		}
		const lines = text.split("\n");
		let open = false;
		let start = 0;
		let buffer: string[] = [];
		for (const [index, line] of lines.entries()) {
			if (!open && /^```(?:ts|tsx)\s*$/.test(line)) {
				open = true;
				start = index + 2;
				buffer = [];
				continue;
			}
			if (open && /^```\s*$/.test(line)) {
				open = false;
				const code = buffer.join("\n");
				// Any fence that configures `plugins:` is in scope, including the
				// continuation snippets that show one option without repeating the
				// imports. A missing import is a separate defect — the static test in
				// `test/doc-examples.test.ts` reports it — so here it just needs
				// prepending for the snippet to resolve.
				if (!/plugins\s*:/.test(code)) continue;
				const prelude = [
					...(/\bdefineConfig\b/.test(code) && !/from\s*["']@rspress\/core["']/.test(code)
						? ['import { defineConfig } from "@rspress/core";']
						: []),
					...(/\bpath\b/.test(code) && !/from\s*["']node:path["']/.test(code)
						? ['import path from "node:path";']
						: []),
					...(/\bcreateRequire\b/.test(code) && !/from\s*["']node:module["']/.test(code)
						? ['import { createRequire } from "node:module";']
						: []),
					...FACTORIES.filter(
						(name) =>
							new RegExp(`\\b${name}\\b`).test(code) &&
							!/from\s*["']rspress-plugin-obsidian/.test(code),
					).map((name) => `import { ${name} } from "rspress-plugin-obsidian";`),
					"",
				].join("\n");
				out.push({ source, line: start, code: `${prelude}${code}` });
				continue;
			}
			if (open) buffer.push(line);
		}
	}
	return out;
}

const fences = configFences();

if (fences.length === 0) {
	console.error("[check-doc-examples] no documented config found — did the docs change shape?");
	process.exit(1);
}

// Inside the repo so `node_modules` resolves, and named so nothing collides with
// a real source file. `rspress.config.ts` would be picked up by the project's own
// typecheck; this is a distinct filename that tsc is pointed at explicitly.
let failed = false;
const scratch = mkdtempSync(path.join(ROOT, ".doc-examples-"));
try {
	const files: string[] = [];
	for (const [index, fence] of fences.entries()) {
		const file = path.join(scratch, `config-${index}.ts`);
		writeFileSync(
			file,
			`// Extracted from ${fence.source}:${fence.line} by scripts/check-doc-examples.ts\n${fence.code}\n`,
			"utf-8",
		);
		files.push(file);
	}

	const tsconfig = path.join(scratch, "tsconfig.json");
	writeFileSync(
		tsconfig,
		JSON.stringify(
			{
				compilerOptions: {
					target: "ES2022",
					module: "ESNext",
					moduleResolution: "bundler",
					strict: true,
					noEmit: true,
					skipLibCheck: true,
					allowImportingTsExtensions: true,
					jsx: "react-jsx",
					types: ["node"],
				},
				files: files.map((f) => path.basename(f)),
			},
			null,
			2,
		),
		"utf-8",
	);

	// `process.exit` skips `finally`, so a failure has to set the status and fall
	// through to the cleanup rather than exiting from inside the try. Leaking a
	// scratch directory per failed run is how a check like this quietly becomes
	// part of `git status`.
	try {
		execFileSync("bunx", ["tsc", "--noEmit", "--project", tsconfig], {
			cwd: ROOT,
			stdio: "inherit",
		});
	} catch {
		failed = true;
		for (const fence of fences) {
			console.error(`  ↑ the config documented at ${fence.source}:${fence.line}`);
		}
	}

	if (failed) {
		console.error("[check-doc-examples] a documented config does not type-check.");
	} else {
		console.log(
			`[check-doc-examples] ${fences.length} documented config${fences.length === 1 ? "" : "s"} type-check.`,
		);
	}
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

// Outside the finally so the scratch directory is already gone by the time this
// runs; setting `exitCode` here is safe where `process.exit` would not be.
process.exitCode = failed ? 1 : 0;
