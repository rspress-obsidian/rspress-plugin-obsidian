import path from "node:path";
import { defineConfig } from "@rspress/core";
import { pluginObsidian } from "./src";

const docsRoot = path.join(import.meta.dirname, "docs");
const vaultRoot = path.join(import.meta.dirname, "Obsidian Vault");

export default defineConfig({
	root: docsRoot,
	title: "rspress-plugin-obsidian",
	description:
		"Publish an Obsidian vault as an Rspress site: wikilinks, callouts, plugins, canvas and graph view",
	globalStyles: path.join(docsRoot, "theme.css"),
	themeDir: path.join(import.meta.dirname, "theme"),
	plugins: pluginObsidian((markdown, canvas, graphview) => [
		markdown({
			vaultRoot,
			vaultRoutePrefix: "/vault",
			enableTagLinking: true,
			enableCallouts: true,
			enableBacklinks: true,
			enableTransclusion: true,
			enableMediaEmbeds: true,
			enableTagPages: true,
			enableDailyNotes: true,
			enableDataview: true,
			enableMath: true,
			enableMermaid: true,
			enableDefaultStyles: true,
			// The reproduced community/core plugins; the demo vault has a folder
			// of notes for each under `Plugins/`.
			enableTasks: true,
			enableKanban: true,
			enableExcalidraw: true,
			enableBases: true,
			enableTemplater: true,
		}),
		canvas({
			vaultRoot,
			routePrefix: "/canvas",
			fileRoutePrefix: "/vault",
		}),
		graphview({
			defaultOpen: true,
			enableHoverPreviews: true,
			// The markdown plugin already reports every unresolved wikilink
			// through `onBrokenLink`; without this the same link is reported twice.
			onUnresolvedLink: "ignore",
		}),
	]),
});
