/**
 * KaTeX's stylesheet as a static file of the site, linked only by the pages
 * that show KaTeX math.
 *
 * A stylesheet the plugins hand Rspress (`globalStyles`, or one a component
 * imports) is merged into the one CSS file every page loads before its first
 * paint, which put KaTeX's ~25 kB of rules in front of every page whether it
 * had a formula or not. Instead the stylesheet and its fonts are copied into
 * an extra public directory and served as they ship in the katex package: the
 * stylesheet names its fonts by relative URL, so the layout under the
 * versioned directory keeps them resolving. A page whose formulas were
 * rendered at build time links it from its `<head>` (`KatexStylesheet`); a
 * canvas board, which typesets in the browser, loads it before typesetting.
 */
import { cpSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { type BuilderPlugin, publicDirectoryPlugin } from "./markdown/public-dir.js";
import { moduleDir } from "./runtime-paths.js";

// Resolved where the bundler resolves `katex` for the renderer, so the
// stylesheet always matches the markup the build emitted.
const katexPackageJson = createRequire(path.join(moduleDir, "noop.js")).resolve(
	"katex/package.json",
);
const katexDist = path.join(path.dirname(katexPackageJson), "dist");
const { version } = JSON.parse(readFileSync(katexPackageJson, "utf8")) as { version: string };

/**
 * The stylesheet's path under the site base. Versioned, so a site that
 * upgrades KaTeX never gets a cached stylesheet for the old markup.
 */
export const KATEX_STYLESHEET_PATH = `obsidian-katex/${version}/katex.min.css`;

const PUBLIC_DIR = path.join(process.cwd(), "node_modules", ".rspress-plugin-obsidian", "katex");

function stageStylesheet(): void {
	const target = path.join(PUBLIC_DIR, path.dirname(KATEX_STYLESHEET_PATH));
	if (existsSync(path.join(PUBLIC_DIR, KATEX_STYLESHEET_PATH))) return;
	cpSync(path.join(katexDist, "fonts"), path.join(target, "fonts"), { recursive: true });
	// Last, so an interrupted copy is retried rather than taken as done.
	cpSync(path.join(katexDist, "katex.min.css"), path.join(target, "katex.min.css"));
}

/**
 * The Rsbuild plugin that publishes the stylesheet. Both the markdown and the
 * canvas plugin add it; the directory is served once either way.
 */
export function katexStylesheetPlugin(): BuilderPlugin {
	return publicDirectoryPlugin(
		"rspress-plugin-obsidian:katex-stylesheet",
		PUBLIC_DIR,
		stageStylesheet,
	);
}
