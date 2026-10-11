/**
 * Build-time side of the optional `mermaid` peer dependency.
 *
 * Both browser renderers that can draw diagrams (the markdown feature's
 * `MermaidBlocks` and the canvas renderer) reach mermaid through
 * `import("mermaid")` in `./blocks.ts`. The site's bundler resolves that
 * specifier while it builds, so a missing package is a "Module not found" build
 * failure, not a runtime one — even for a site whose notes and boards contain
 * no diagram. When mermaid is absent the plugins alias it to an empty module:
 * the site builds, and the client renderer leaves each diagram's source in
 * place with an install hint (`MermaidUnavailableError`).
 */
import { createRequire } from "node:module";
import path from "node:path";
import type { RspressPlugin } from "@rspress/core";
import { moduleDir } from "../runtime-paths.js";
import { MERMAID_INSTALL_HINT } from "./classes.js";

type BuilderConfig = NonNullable<RspressPlugin["builderConfig"]>;

/**
 * Whether `mermaid` resolves from `fromDir`. The default is this package's own
 * directory, which is where the bundler starts resolving the specifier the
 * shipped runtime chunks import — so a hoisted install, a pnpm peer link and a
 * workspace install all answer the same way the build will.
 */
export function isMermaidInstalled(fromDir: string = moduleDir): boolean {
	try {
		createRequire(path.join(fromDir, "noop.js")).resolve("mermaid");
		return true;
	} catch {
		return false;
	}
}

let warned = false;

/**
 * Rsbuild config a plugin that bundles the mermaid renderer contributes:
 * nothing when mermaid is installed, otherwise an alias that turns
 * `import("mermaid")` into an empty module so the site still builds.
 *
 * @param options.diagramsRequested - The site asked for diagrams
 *   (`enableMermaid`), so a missing package is worth one build-time warning.
 *   Canvas boards pass `false`: their renderer always contains the import,
 *   whether or not any board has a diagram, and the browser reports the
 *   missing package on the pages that actually have one.
 * @param options.installed - Override for tests; defaults to
 *   {@link isMermaidInstalled}.
 */
export function mermaidBuilderConfig(options: {
	diagramsRequested: boolean;
	installed?: boolean;
}): BuilderConfig {
	if (options.installed ?? isMermaidInstalled()) return {};
	if (options.diagramsRequested && !warned) {
		warned = true;
		console.warn(`[rspress-plugin-obsidian] ${MERMAID_INSTALL_HINT}`);
	}
	return { resolve: { alias: { mermaid: false } } };
}
