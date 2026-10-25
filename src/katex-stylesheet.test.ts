import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { KATEX_STYLESHEET_PATH, katexStylesheetPlugin } from "./katex-stylesheet";

/** Run the Rsbuild plugins' config step the way Rsbuild does, in order, on one config. */
function configure(plugins: unknown[]): { publicDir: Array<{ name: string }> } {
	const config: { server?: { publicDir?: unknown } } = { server: { publicDir: [] } };
	for (const plugin of plugins as Array<{
		setup(api: {
			context: { rootPath: string };
			modifyRsbuildConfig(fn: (c: typeof config) => void): void;
		}): void;
	}>) {
		plugin.setup({ context: { rootPath: "/site" }, modifyRsbuildConfig: (fn) => fn(config) });
	}
	return { publicDir: config.server?.publicDir as Array<{ name: string }> };
}

test("the stylesheet is published once, with every font it names", () => {
	// The markdown and the canvas plugin both add it.
	const { publicDir } = configure([katexStylesheetPlugin(), katexStylesheetPlugin()]);
	expect(publicDir).toHaveLength(1);
	const dir = publicDir[0]?.name ?? "";

	const stylesheet = path.join(dir, KATEX_STYLESHEET_PATH);
	expect(existsSync(stylesheet)).toBe(true);
	const fonts = [...readFileSync(stylesheet, "utf8").matchAll(/url\(([^)]+)\)/g)].map(
		(match) => match[1] ?? "",
	);
	expect(fonts.length).toBeGreaterThan(0);
	for (const font of fonts) {
		expect(existsSync(path.join(path.dirname(stylesheet), font))).toBe(true);
	}
});

test("the path is versioned by the installed katex", () => {
	const { version } = JSON.parse(
		readFileSync(path.join(import.meta.dir, "..", "node_modules", "katex", "package.json"), "utf8"),
	) as { version: string };
	expect(KATEX_STYLESHEET_PATH).toBe(`obsidian-katex/${version}/katex.min.css`);
});
