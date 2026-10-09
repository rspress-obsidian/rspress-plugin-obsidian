import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MERMAID_INSTALL_HINT } from "./classes";
import { isMermaidInstalled, mermaidBuilderConfig } from "./install";

type LazyCompilationTest =
	| RegExp
	| ((module: { nameForCondition(): string | undefined }) => boolean);
type LazyCompilation =
	| boolean
	| { entries?: boolean; imports?: boolean; test?: LazyCompilationTest };
type EagerMermaidPlugin = {
	name: string;
	setup(api: {
		modifyRspackConfig(modify: (config: { lazyCompilation?: LazyCompilation }) => void): void;
	}): void;
};

const MODULES = [
	"/site/node_modules/mermaid/dist/mermaid.core.mjs",
	"/site/node_modules/@mermaid-js/parser/dist/index.mjs",
	"C:\\site\\node_modules\\katex\\dist\\katex.mjs",
	"/site/src/mermaid/blocks.ts",
	"/site/node_modules/react-force-graph-2d/dist/x.mjs",
];

/**
 * Run the plugin's `setup` against a fake Rsbuild API `times` times; a site
 * with both the markdown and the canvas plugin registers it twice.
 */
function applyPlugin(lazyCompilation: LazyCompilation | undefined, times = 1) {
	const config = { lazyCompilation };
	const plugin = mermaidBuilderConfig({ diagramsRequested: true, installed: true })
		.plugins?.[0] as EagerMermaidPlugin;
	for (let i = 0; i < times; i++) {
		plugin.setup({ modifyRspackConfig: (modify) => modify(config) });
	}
	return config.lazyCompilation;
}

/** Which of {@link MODULES} rspack compiles lazily: a RegExp `test` sees `nameForCondition()`, a function the module. */
function lazilyCompiled(lazy: LazyCompilation | undefined): boolean[] {
	return MODULES.map((name) => {
		if (!lazy) return false;
		const test = lazy === true ? undefined : lazy.test;
		if (test === undefined) return true;
		return test instanceof RegExp ? test.test(name) : test({ nameForCondition: () => name });
	});
}

test("finds mermaid where this package's runtime chunks resolve it", () => {
	expect(isMermaidInstalled()).toBe(true);
});

test("reports mermaid missing from a directory with no node_modules above it", () => {
	const isolated = mkdtempSync(path.join(os.tmpdir(), "obsidian-no-mermaid-"));
	try {
		expect(isMermaidInstalled(isolated)).toBe(false);
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
});

test("contributes a plugin that keeps mermaid out of lazy compilation when mermaid is installed", () => {
	expect(mermaidBuilderConfig({ diagramsRequested: true, installed: true })).toEqual({
		plugins: [expect.objectContaining({ name: "rspress-plugin-obsidian:eager-mermaid" })],
	});
});

test("leaves lazy compilation off when the site turned it off", () => {
	expect(applyPlugin(false)).toBe(false);
	expect(applyPlugin(undefined)).toBeUndefined();
	expect(lazilyCompiled(applyPlugin(true))).toEqual([false, false, false, true, true]);
});

test("compiles mermaid, its parser and katex eagerly and every other module lazily", () => {
	expect(lazilyCompiled(applyPlugin(true))).toEqual([false, false, false, true, true]);
	const options = applyPlugin({ entries: false, imports: true });
	expect(options).toMatchObject({ entries: false, imports: true });
	expect(lazilyCompiled(options)).toEqual([false, false, false, true, true]);
});

test("keeps a site's own RegExp or function test", () => {
	expect(lazilyCompiled(applyPlugin({ test: /[\\/]src[\\/]/ }))).toEqual([
		false,
		false,
		false,
		true,
		false,
	]);
	const notTypeScript: LazyCompilationTest = (module) =>
		!module.nameForCondition()?.endsWith(".ts");
	expect(lazilyCompiled(applyPlugin({ imports: true, test: notTypeScript }))).toEqual([
		false,
		false,
		false,
		false,
		true,
	]);
});

test("gives the same verdicts when both the markdown and canvas plugins apply it", () => {
	const notTypeScript: LazyCompilationTest = (module) =>
		!module.nameForCondition()?.endsWith(".ts");
	expect(lazilyCompiled(applyPlugin(true, 2))).toEqual([false, false, false, true, true]);
	expect(lazilyCompiled(applyPlugin({ test: /[\\/]src[\\/]/ }, 2))).toEqual([
		false,
		false,
		false,
		true,
		false,
	]);
	expect(lazilyCompiled(applyPlugin({ test: notTypeScript }, 2))).toEqual([
		false,
		false,
		false,
		false,
		true,
	]);
});

test("aliases a missing mermaid to an empty module so the site still builds", () => {
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		expect(mermaidBuilderConfig({ diagramsRequested: false, installed: false })).toEqual({
			resolve: { alias: { mermaid: false } },
		});
		// A canvas-only site never asked for diagrams, so the build stays quiet.
		expect(warn).not.toHaveBeenCalled();

		mermaidBuilderConfig({ diagramsRequested: true, installed: false });
		mermaidBuilderConfig({ diagramsRequested: true, installed: false });
		expect(warn).toHaveBeenCalledTimes(1);
		expect(String(warn.mock.calls[0]?.[0])).toContain(MERMAID_INSTALL_HINT);
	} finally {
		warn.mockRestore();
	}
});
