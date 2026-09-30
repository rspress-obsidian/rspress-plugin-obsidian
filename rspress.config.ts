import path from "node:path";
import { defineConfig } from "@rspress/core";
import { pluginObsidian } from "./src";

const docsRoot = path.join(import.meta.dirname, "docs");
const vaultRoot = path.join(import.meta.dirname, "Obsidian Vault");

export default defineConfig({
	root: docsRoot,
	title: "Rspress x Obsidian",
	description: "One Obsidian-publishing suite for Rspress: wikilinks, canvas, graph",
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
			onBrokenLink: "warn",
		}),
		canvas({
			vaultRoot,
			routePrefix: "/canvas",
			fileRoutePrefix: "/vault",
		}),
		graphview({
			defaultOpen: true,
			enableHoverPreviews: true,
			// The examples page documents an unresolved link on purpose, and the
			// markdown plugin already reports every unresolved wikilink through
			// `onBrokenLink` above. Without this the same link is reported twice.
			onUnresolvedLink: "ignore",
		}),
	]),
});
