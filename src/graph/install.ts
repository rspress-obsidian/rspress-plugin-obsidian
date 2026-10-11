/**
 * Build-time side of the optional `react-force-graph-2d` peer dependency.
 *
 * The graph panel reaches the renderer through `import("react-force-graph-2d")`
 * in `./runtime/GraphView.tsx`. The site's bundler resolves that specifier
 * while it builds, so a missing package is a "Module not found" build failure,
 * not a runtime one — before any client fallback can run. When the package is
 * absent the plugin aliases it to an empty module: the site builds, and the
 * panel lists the pages with an install hint instead of drawing the graph.
 */
import { createRequire } from "node:module";
import path from "node:path";
import type { RspressPlugin } from "@rspress/core";
import { moduleDir } from "../runtime-paths.js";

type BuilderConfig = NonNullable<RspressPlugin["builderConfig"]>;

const FORCE_GRAPH_PACKAGE = "react-force-graph-2d";

/** Shown at build time when the site is built without the optional peer. */
export const FORCE_GRAPH_INSTALL_HINT = `The graph panel draws with the optional peer dependency \`${FORCE_GRAPH_PACKAGE}\`: install it next to rspress-plugin-obsidian (\`npm install ${FORCE_GRAPH_PACKAGE}\`) and rebuild the site. Until then the panel lists the pages without drawing the graph.`;

/**
 * Whether `react-force-graph-2d` resolves from `fromDir`. The default is this
 * package's own directory, which is where the bundler starts resolving the
 * specifier the shipped runtime chunks import — so a hoisted install, a pnpm
 * peer link and a workspace install all answer the same way the build will.
 */
export function isForceGraphInstalled(fromDir: string = moduleDir): boolean {
	try {
		createRequire(path.join(fromDir, "noop.js")).resolve(FORCE_GRAPH_PACKAGE);
		return true;
	} catch {
		return false;
	}
}

let warned = false;

/**
 * Rsbuild config the graph feature contributes: nothing when the renderer is
 * installed, otherwise an alias that turns `import("react-force-graph-2d")`
 * into an empty module so the site still builds, plus one build-time warning.
 *
 * @param options.installed - Override for tests; defaults to
 *   {@link isForceGraphInstalled}.
 */
export function forceGraphBuilderConfig(options: { installed?: boolean } = {}): BuilderConfig {
	if (options.installed ?? isForceGraphInstalled()) return {};
	if (!warned) {
		warned = true;
		console.warn(`[rspress-plugin-obsidian] ${FORCE_GRAPH_INSTALL_HINT}`);
	}
	return { resolve: { alias: { [FORCE_GRAPH_PACKAGE]: false } } };
}
