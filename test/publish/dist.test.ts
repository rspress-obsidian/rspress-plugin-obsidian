import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
} from "node:fs";
import { builtinModules, createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Asserts the *packed* artifact, not the dist/ on disk: exports-map resolution,
// both module formats loading under Node, tarball contents and size. Run with
// `bun run test:publish` after `bun run build`. With no dist/ it prints why and
// reports a counted skip (`bun test` on a clean checkout does the same), and the
// CI step asserts the dist files themselves immediately before calling it, so a
// missing build cannot pass the gate.
const root = path.resolve(import.meta.dir, "..", "..");
const distEntry = path.join(root, "dist", "index.js");
const distExists = existsSync(distEntry);

if (!distExists) {
	console.info("[publish] skipped — `bun run test:publish` builds dist/ first.");
}

/** Every subpath the package advertises, and whether it must load. */
const EXPORTS: Array<{ subpath: string; load: "esm" | "cjs" | "css" | null }> = [
	{ subpath: "rspress-plugin-obsidian", load: "esm" },
	{ subpath: "rspress-plugin-obsidian/markdown", load: "esm" },
	{ subpath: "rspress-plugin-obsidian/canvas", load: "esm" },
	{ subpath: "rspress-plugin-obsidian/graph", load: "esm" },
	// Documented custom-theme API. They import Rspress-only virtual modules, so
	// resolving them to an existing file is the assertion, not loading them.
	{ subpath: "rspress-plugin-obsidian/graph/runtime/GraphPanel", load: null },
	{ subpath: "rspress-plugin-obsidian/graph/runtime/GraphSidebar", load: null },
	{ subpath: "rspress-plugin-obsidian/styles.css", load: "css" },
	{ subpath: "rspress-plugin-obsidian/markdown/styles.css", load: "css" },
	{ subpath: "rspress-plugin-obsidian/markdown/katex.css", load: "css" },
	{ subpath: "rspress-plugin-obsidian/canvas/styles.css", load: "css" },
	{ subpath: "rspress-plugin-obsidian/graph/styles.css", load: "css" },
	{ subpath: "rspress-plugin-obsidian/package.json", load: null },
];

/** Package entry subpaths, exercised in both module formats. */
const ENTRIES = ["", "/markdown", "/canvas", "/graph"];

test.skipIf(!distExists)("packed artifact", async () => {
	const workDir = mkdtempSync(path.join(os.tmpdir(), "rspress-obsidian-pack-"));
	const installDir = path.join(root, "node_modules", ".publish-test");
	try {
		// 1. Pack and inspect the tarball.
		const packJson = execFileSync("npm", ["pack", "--json", "--pack-destination", workDir], {
			cwd: root,
			encoding: "utf-8",
			// Windows has no `npm` executable image: npm ships as a `npm.cmd`
			// shim, and CreateProcess cannot launch one directly (Node refuses to
			// even try since the 2024 .bat/.cmd hardening), so the pack step needs
			// a shell there.
			shell: process.platform === "win32",
		});
		const [packed] = JSON.parse(packJson) as Array<{
			filename: string;
			files: Array<{ path: string }>;
			size: number;
		}>;
		if (!packed) throw new Error("npm pack produced no artifact");
		const tarball = path.join(workDir, packed.filename);

		const shipped = packed.files.map((file) => file.path);
		expect(shipped).toContain("dist/index.js");
		expect(shipped).toContain("dist/index.cjs");
		expect(shipped).toContain("dist/graph/runtime/GraphPanel.js");
		expect(shipped).toContain("dist/graph/runtime/graph-panels.css");
		// Runtime components are resolved by path at module load, so a missing
		// chunk fails the import of the plugin entry itself.
		expect(shipped).toContain("dist/markdown/runtime/MermaidBlocks.js");
		expect(shipped).toContain("dist/markdown/runtime/WikiPicker.js");
		expect(shipped.filter((file) => /\.test\./.test(file))).toEqual([]);

		// The 13 MB devkit/TypeScript chunk used to ship here.
		expect(packed.size).toBeLessThan(2 * 1024 * 1024);

		// 2. Extract into node_modules so bare imports resolve upward.
		rmSync(installDir, { recursive: true, force: true });
		mkdirSync(installDir, { recursive: true });
		// `tar` is an executable image on every platform — Windows ships
		// `tar.exe` in System32 — so it needs no shell, unlike `npm` above; the
		// `.exe` on win32 skips the PATHEXT search entirely and keeps the temp
		// paths in the argument list quoted rather than re-split by cmd.exe.
		execFileSync(process.platform === "win32" ? "tar.exe" : "tar", [
			"-xzf",
			tarball,
			"-C",
			installDir,
			"--strip-components=1",
		]);
		rmSync(path.join(root, "node_modules", "rspress-plugin-obsidian"), {
			recursive: true,
			force: true,
		});
		// A Windows directory *symlink* needs Developer Mode or elevation
		// (`EPERM` otherwise); a junction is a reparse point that needs neither
		// and is what npm/pnpm create for linked packages. POSIX ignores the type
		// argument, so one call covers all three platforms.
		symlinkSync(
			installDir,
			path.join(root, "node_modules", "rspress-plugin-obsidian"),
			process.platform === "win32" ? "junction" : "dir",
		);

		// 3. Every advertised subpath resolves to a file that exists, under the
		// `require` conditions too: a CJS consumer — or a resolver that only
		// understands `require` — must not hit ERR_PACKAGE_PATH_NOT_EXPORTED.
		const require = createRequire(pathToFileURL(path.join(root, "index.js")).href);
		for (const entry of EXPORTS) {
			const resolved = require.resolve(entry.subpath);
			expect(existsSync(resolved)).toBe(true);
			if (entry.load === "css") {
				expect(statSync(resolved).size).toBeGreaterThan(0);
			}
		}

		// 4. Both formats load under Node, not just Bun. Dynamic import is
		//    required here: the specifier is built at runtime from the exports
		//    subpaths above, and this test exists to exercise module loading.
		for (const name of ENTRIES) {
			const loaded = require(`rspress-plugin-obsidian${name}`) as Record<string, unknown>;
			expect(Object.keys(loaded).length).toBeGreaterThan(0);
		}
		for (const name of ENTRIES) {
			const loaded = (await import(`rspress-plugin-obsidian${name}`)) as Record<string, unknown>;
			expect(Object.keys(loaded).length).toBeGreaterThan(0);
		}

		// 5. The aggregate stylesheet carries all three features.
		const aggregate = readFileSync(path.join(installDir, "dist", "styles.css"), "utf-8");
		const markdownOnly = readFileSync(path.join(installDir, "dist", "markdown.css"), "utf-8");
		expect(aggregate).not.toBe(markdownOnly);
		expect(aggregate).toContain(".canvas-");
		expect(aggregate).toContain(".obsidian-hover-preview");
	} finally {
		rmSync(path.join(root, "node_modules", "rspress-plugin-obsidian"), {
			recursive: true,
			force: true,
		});
		rmSync(installDir, { recursive: true, force: true });
		rmSync(workDir, { recursive: true, force: true });
	}
});

const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf-8")) as {
	dependencies: Record<string, string>;
	devDependencies: Record<string, string>;
	peerDependencies: Record<string, string>;
	sideEffects: string[];
	// Conditions nest (`import`/`require` each hold `types` + `default`), so
	// the walker below recurses rather than assuming one level of mapping.
	exports: Record<string, string | { [condition: string]: unknown }>;
};

/** Every string leaf of an exports subtree, `./`-prefixed or not. */
function exportTargets(node: unknown): string[] {
	if (typeof node === "string") return [node];
	if (node && typeof node === "object") return Object.values(node).flatMap(exportTargets);
	return [];
}

/**
 * Bare package specifiers imported anywhere under `src/` (colocated tests
 * included). `import type …` statements are dropped: they are erased from the
 * bundle and are satisfied by type packages (`mdast` by `@types/mdast`), not by
 * the package that owns the runtime.
 */
async function bareImportsInSource(include: (file: string) => boolean): Promise<Set<string>> {
	const specifiers = new Set<string>();
	for (const file of new Bun.Glob("src/**/*.{ts,tsx}").scanSync({ cwd: root })) {
		if (!include(file)) continue;
		const source = readFileSync(path.join(root, file), "utf-8")
			.replace(/\bimport\s+type\s+[\s\S]*?from\s*["'][^"']+["'];?/g, "")
			// JSDoc examples import the package by its own name.
			.replace(/\/\*[\s\S]*?\*\//g, "");
		for (const match of source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g)) {
			const specifier = match[1] as string;
			if (specifier.startsWith(".") || specifier.startsWith("node:") || specifier.startsWith("/")) {
				continue;
			}
			specifiers.add(
				specifier.startsWith("@")
					? specifier.split("/").slice(0, 2).join("/")
					: (specifier.split("/")[0] as string),
			);
		}
	}
	return specifiers;
}

// The exports map is the published contract; the hand-maintained list above
// must cover every key, or a subpath ships with no coverage at all.
test("EXPORTS covers every advertised subpath", () => {
	const advertised = Object.keys(packageJson.exports).map((key) =>
		key === "." ? "rspress-plugin-obsidian" : `rspress-plugin-obsidian${key.slice(1)}`,
	);
	expect(EXPORTS.map((entry) => entry.subpath).sort()).toEqual(advertised.sort());
});

// A stylesheet that `sideEffects` does not cover can be tree-shaken out of a
// production bundle. The package ships only `dist/**`, so a root-anchored
// `*.css` never matched the exported stylesheets; `**/*.css` matches those and
// a root-level `styles.css` alike.
test("sideEffects covers every exported stylesheet", () => {
	const stylesheets = Object.values(packageJson.exports)
		.flatMap(exportTargets)
		.filter((target) => target.endsWith(".css"))
		.map((target) => target.replace(/^\.\//, ""));
	expect(stylesheets.length).toBeGreaterThan(0);
	const uncovered = stylesheets.filter(
		(stylesheet) =>
			!packageJson.sideEffects.some((pattern) => new Bun.Glob(pattern).match(stylesheet)),
	);
	expect(uncovered).toEqual([]);
});

// Every consumer installs the runtime dependencies; one that no source file
// imports is dead weight. `@types/*` packages are type-only by construction —
// they are referenced from the emitted `.d.ts`, never from an import statement.
test("every runtime dependency is imported by source", async () => {
	const imports = await bareImportsInSource(() => true);
	const unused = Object.keys(packageJson.dependencies).filter(
		(name) => !name.startsWith("@types/") && !imports.has(name),
	);
	expect(unused).toEqual([]);
});

// Dependencies reached only from a `*.test.ts` file are test tooling: declared
// as runtime dependencies they are installed by every consumer for nothing.
test("dependencies imported only by tests are devDependencies", async () => {
	const shipped = await bareImportsInSource((file) => !/\.test\.tsx?$/.test(file));
	const all = await bareImportsInSource(() => true);
	const misplaced = Object.keys(packageJson.dependencies).filter(
		(name) => !shipped.has(name) && all.has(name),
	);
	expect(misplaced).toEqual([]);
});

// ...and a test-only import must be declared at all, or it resolves by accident
// through whatever happens to hoist it into `node_modules`.
test("every bare import under src/ is declared", async () => {
	const declared = new Set([
		...Object.keys(packageJson.dependencies),
		...Object.keys(packageJson.devDependencies),
		...Object.keys(packageJson.peerDependencies),
	]);
	const undeclared = [...(await bareImportsInSource(() => true))].filter(
		(specifier) =>
			!declared.has(specifier) &&
			!declared.has(`@types/${specifier}`) &&
			// Node builtins are imported bare in a few files, and `bun:*` plus
			// Rspress' virtual modules (src/graph/runtime/virtual-modules.d.ts)
			// are supplied by the runtime.
			!builtinModules.includes(specifier) &&
			!specifier.startsWith("bun:") &&
			!specifier.startsWith("virtual-"),
	);
	expect(undeclared).toEqual([]);
});
