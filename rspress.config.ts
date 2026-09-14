import path from "node:path";
import { defineConfig } from "@rspress/core";
import { pluginObsidianWikiLink, pluginObsidianCanvas, pluginGraphview } from "./src";

const docsRoot = path.join(import.meta.dirname, "docs");
const vaultRoot = path.join(import.meta.dirname, "Obsidian Vault");

export default defineConfig({
  root: docsRoot,
  title: "Rspress x Obsidian",
  description: "One Obsidian-publishing suite for Rspress: wikilinks, canvas, graph",
  globalStyles: path.join(docsRoot, "theme.css"),
  themeDir: path.join(import.meta.dirname, "theme"),
  plugins: [
    pluginObsidianWikiLink({
      vaultRoot,
      vaultRoutePrefix: "/vault",
      enableTagLinking: true,
      enableCallouts: true,
      enableBacklinks: true,
      enableTransclusion: true,
      enableMediaEmbeds: true,
      enableTagPages: true,
      enableDailyNotes: true,
      enableDefaultStyles: true,
      onBrokenLink: "warn",
    }),
    pluginObsidianCanvas({
      vaultRoot,
      routePrefix: "/canvas",
    }),
    pluginGraphview({
      defaultOpen: true,
      enableHoverPreviews: true,
    }),
  ],
});
