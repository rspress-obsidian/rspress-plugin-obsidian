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
import type { RspressPlugin, UserConfig } from "@rspress/core";
import { moduleDir } from "../runtime-paths.js";
import { MERMAID_INSTALL_HINT } from "./classes.js";

type BuilderConfig = NonNullable<RspressPlugin["builderConfig"]>;
type RsbuildPluginEntry = NonNullable<NonNullable<UserConfig["builderConfig"]>["plugins"]>[number];

/** The part of an rspack module a lazy-compilation `test` reads. */
interface LazyCompilationCandidate {
	nameForCondition(): string | undefined;
}

type LazyCompilationTest = RegExp | ((module: LazyCompilationCandidate) => boolean);

/**
 * The slice of Rsbuild's plugin API the plugin uses. Rsbuild types
 * `builderConfig.plugins` entries' `setup(api)` as `any`, so the plugin spells
 * out what it relies on.
 */
interface RspackConfigApi {
	modifyRspackConfig(
		modify: (config: { lazyCompilation?: boolean | { test?: LazyCompilationTest } }) => void,
	): void;
}

/** Accepts every module path except mermaid's and the packages it imports on demand. */
const LAZY_OUTSIDE_MERMAID = /^(?!.*[\\/]node_modules[\\/](?:mermaid|@mermaid-js|katex)[\\/])/;

function excludeMermaid(test: LazyCompilationTest | undefined): LazyCompilationTest {
	if (test === undefined || test === LAZY_OUTSIDE_MERMAID) return LAZY_OUTSIDE_MERMAID;
	return (module) => {
		// rspack matches a RegExp `test` against the module's `nameForCondition()`.
		const name = module.nameForCondition() ?? "";
		return (
			LAZY_OUTSIDE_MERMAID.test(name) && (test instanceof RegExp ? test.test(name) : test(module))
		);
	};
}

// Rspack (2.2.2 to at least 2.2.8) crashes `rspress dev` when one lazy
// compilation chains into another, as a diagram page's `import("mermaid")` does
// through mermaid's on-demand chunks and katex. Mermaid compiles with its
// renderer instead; lazy compilation stays on for everything else.
const eagerMermaidPlugin = {
	name: "rspress-plugin-obsidian:eager-mermaid",
	setup(api: RspackConfigApi) {
		api.modifyRspackConfig((config) => {
			const lazy = config.lazyCompilation;
			if (!lazy) return;
			const options = lazy === true ? {} : lazy;
			config.lazyCompilation = { ...options, test: excludeMermaid(options.test) };
		});
	},
} satisfies RsbuildPluginEntry;

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
 * Rsbuild config a plugin that bundles the mermaid renderer contributes. With
 * mermaid installed, a plugin that keeps mermaid out of dev lazy compilation;
 * otherwise an alias that turns `import("mermaid")` into an empty module so the
 * site still builds.
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
	if (options.installed ?? isMermaidInstalled()) return { plugins: [eagerMermaidPlugin] };
	if (options.diagramsRequested && !warned) {
		warned = true;
		console.warn(`[rspress-plugin-obsidian] ${MERMAID_INSTALL_HINT}`);
	}
	return { resolve: { alias: { mermaid: false } } };
}
