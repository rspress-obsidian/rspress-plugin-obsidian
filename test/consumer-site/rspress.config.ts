// A consumer site, as a user writes it: the plugin comes from the installed
// tarball (`rspress-plugin-obsidian`), never from this repository's `src/`.
// CI copies this directory out of the repository before installing, so module
// resolution cannot fall back to the repository's own node_modules.
import path from "node:path";
import { defineConfig } from "@rspress/core";
import { canvas, graphview, markdown } from "rspress-plugin-obsidian";

const docsRoot = path.join(import.meta.dirname, "docs");
const vaultRoot = path.join(import.meta.dirname, "vault");

export default defineConfig({
	root: docsRoot,
	title: "Consumer fixture",
	plugins: [
		markdown({
			vaultRoot,
			vaultRoutePrefix: "/vault",
			enableCallouts: true,
			enableBacklinks: true,
			enableTransclusion: true,
			enableTagLinking: true,
			enableTagPages: true,
			enableMath: true,
			enableMermaid: true,
			enableDefaultStyles: true,
			enableDailyNotes: true,
			dailyNotes: { folder: "Daily", template: "Templates/Daily" },
			// The reproduced plugins, from the tarball: their runtime deps
			// (rrule, roughjs, yaml, …) must resolve, and the optional
			// `@excalidraw/excalidraw` and `lucide-static` peers stay absent.
			enableTasks: true,
			tasks: { now: "2024-05-15" },
			enableKanban: true,
			enableExcalidraw: true,
			enableBases: true,
			enableTemplater: true,
			templater: { templatesFolder: "Templates", now: "2024-05-15" },
			onBrokenLink: "error",
		}),
		canvas({ vaultRoot, routePrefix: "/canvas", fileRoutePrefix: "/vault" }),
		graphview({ defaultOpen: true, enableHoverPreviews: true }),
	],
});
