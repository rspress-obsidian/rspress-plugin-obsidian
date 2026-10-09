import { readdirSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "tsup";
import { minifyCssFile } from "./scripts/minify-css";

/**
 * Browser components of the reproduced Obsidian plugins, one chunk each:
 * `src/markdown/obsidian-plugins/<id>/runtime/<Name>.tsx` ships as
 * `dist/markdown/obsidian-plugins/<id>/runtime/<Name>.js`, the path the
 * feature resolves at runtime (`resolveRuntimeFile`). Discovered rather than
 * listed, so a feature's components cannot drift out of the bundle. Only
 * `.tsx` files are components; `.ts` helpers next to them are shared chunks.
 */
function pluginRuntimeEntries(): Record<string, string> {
	const root = "src/markdown/obsidian-plugins";
	const entries: Record<string, string> = {};
	for (const feature of readdirSync(root, { withFileTypes: true })) {
		if (!feature.isDirectory()) continue;
		const runtimeDir = path.join(root, feature.name, "runtime");
		let files: string[];
		try {
			files = readdirSync(runtimeDir);
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.endsWith(".tsx") || file.endsWith(".test.tsx")) continue;
			entries[`markdown/obsidian-plugins/${feature.name}/runtime/${file.slice(0, -4)}`] = path.join(
				runtimeDir,
				file,
			);
		}
	}
	return entries;
}

// Dist contract — the factories resolve sibling runtime chunks by path
// (import.meta.url), so the entry NAMES below ARE the runtime layout.
// test/publish/dist.test.ts asserts this layout.
export default defineConfig([
	// 1. Library: umbrella + per-feature plugin factories & helpers (dual format)
	//    `clean` is deliberately absent: tsup runs the configs below
	//    concurrently, so cleaning here would delete files another config has
	//    already emitted. `bun run build` cleans dist/ before invoking tsup.
	{
		entry: {
			index: "src/index.ts",
			markdown: "src/markdown/index.ts",
			canvas: "src/canvas/index.ts",
			graph: "src/graph/index.ts",
		},
		format: ["esm", "cjs"],
		dts: false,
		outDir: "dist",
		target: "es2022",
		treeshake: true,
		splitting: true,
		external: [
			"react",
			"react-dom",
			"@rspress/core",
			"marked",
			"katex",
			"mermaid",
			"@excalidraw/excalidraw",
			"maplibre-gl",
			"fast-glob",
			"virtual-graph-data",
			"virtual-graph-search-data",
		],
	},
	// 2. Browser component chunks (string-path loaded by Rspress:
	//    globalUIComponents, markdown.globalComponents). Named entries give
	//    stable dist filenames. GraphPanel/GraphSidebar keep .d.ts — they are
	//    the documented custom-theme API.
	{
		entry: {
			"canvas/components/CanvasViewer": "src/canvas/components/CanvasViewer.tsx",
			"canvas/components/CanvasEmbed": "src/canvas/components/CanvasEmbed.tsx",
			"markdown/runtime/MermaidBlocks": "src/markdown/runtime/MermaidBlocks.tsx",
			"markdown/runtime/WikiPicker": "src/markdown/runtime/WikiPicker.tsx",
			"graph/runtime/GraphPanel": "src/graph/runtime/GraphPanel.tsx",
			"graph/runtime/GraphSidebar": "src/graph/runtime/GraphSidebar.tsx",
			"graph/runtime/LazyGraphPanel": "src/graph/runtime/LazyGraphPanel.tsx",
			"graph/runtime/HoverPreview": "src/graph/runtime/HoverPreview.tsx",
			...pluginRuntimeEntries(),
		},
		format: ["esm"],
		outDir: "dist",
		dts: false,
		// Shared deps (the Mermaid renderer) must be one module instance across
		// the canvas and markdown components: two instances would each scan and
		// render the same blocks.
		splitting: true,
		external: [
			"react",
			"react-dom",
			"mermaid",
			"@excalidraw/excalidraw",
			"maplibre-gl",
			"react-force-graph-2d",
			"@rspress/core",
			"virtual-graph-data",
			"virtual-graph-search-data",
		],
		target: "es2020",
		noExternal: ["marked"],
	},
	// 3. CSS: per-feature + aggregate.
	//    Keys are extensionless so esbuild emits `dist/<key>.css` (a `.css` key
	//    would double the extension). Output filenames must match the exports
	//    map, and `graph/runtime/graph-panels` must match the path the graph
	//    plugin resolves at runtime.
	{
		entry: {
			markdown: "src/markdown/styles.css",
			"markdown/math": "src/markdown/styles-math.css",
			"markdown/katex": "src/markdown/katex.css",
			canvas: "src/canvas/styles/canvas.css",
			styles: "src/styles/aggregate.css",
			"graph/runtime/graph-panels": "src/graph/runtime/graph-panels.css",
		},
		format: ["esm"],
		outDir: "dist",
		target: "es2020",
		// KaTeX's stylesheet is left unresolved so the consuming site build
		// resolves it against the installed katex package (keeping its fonts out
		// of this package's tarball).
		external: ["katex/*"],
		onSuccess: async () => {
			await minifyCssFile("dist/markdown.css");
			await minifyCssFile("dist/markdown/math.css");
			await minifyCssFile("dist/markdown/katex.css");
			await minifyCssFile("dist/canvas.css");
			await minifyCssFile("dist/styles.css");
			await minifyCssFile("dist/graph/runtime/graph-panels.css");
		},
	},
]);
