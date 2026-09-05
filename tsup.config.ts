import { defineConfig } from "tsup";
import { minifyCssFile } from "./scripts/minify-css";

// Dist contract — the factories resolve sibling runtime chunks by path
// (import.meta.url), so the entry NAMES below ARE the runtime layout.
// test/publish/dist.test.ts asserts this layout.
export default defineConfig([
	// 1. Library: umbrella + per-feature plugin factories & helpers (dual format)
	{
		entry: {
			index: "src/index.ts",
			markdown: "src/markdown/index.ts",
			canvas: "src/canvas/index.ts",
			graph: "src/graph/index.ts",
		},
		format: ["esm", "cjs"],
		dts: true,
		clean: true,
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
			"fast-glob",
			"virtual-graph-data",
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
			"graph/runtime/GraphPanel": "src/graph/runtime/GraphPanel.tsx",
			"graph/runtime/GraphSidebar": "src/graph/runtime/GraphSidebar.tsx",
		},
		format: ["esm"],
		outDir: "dist",
		dts: true,
		external: [
			"react",
			"react-dom",
			"mermaid",
			"react-force-graph-2d",
			"@rspress/core",
			"virtual-graph-data",
		],
		target: "es2020",
		noExternal: ["marked"],
	},
	// 3. CSS: per-feature + aggregate.
	//    Keys are extensionless so esbuild emits `dist/<key>.css` (a `.css` key
	//    would double the extension). Output filenames must match the exports map.
	{
		entry: {
			markdown: "src/markdown/styles.css",
			canvas: "src/canvas/styles/canvas.css",
			"canvas-bundle": "src/canvas/styles/canvas.css",
			styles: "src/markdown/styles.css",
		},
		format: ["esm"],
		outDir: "dist",
		target: "es2020",
		onSuccess: async () => {
			await minifyCssFile("dist/markdown.css");
			await minifyCssFile("dist/canvas.css");
			await minifyCssFile("dist/styles.css");
			await minifyCssFile("dist/canvas-bundle.css");
		},
	},
]);
