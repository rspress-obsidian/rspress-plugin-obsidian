// rspress-plugin-obsidian — umbrella entry: the three feature plugins,
// `pluginObsidian` composing them, and the types of their options. The
// helpers each feature is built on (content index, resolver, canvas parser…)
// are exported by the feature's own entry: `rspress-plugin-obsidian/markdown`,
// `/canvas` and `/graph`.

import type { RspressPlugin } from "@rspress/core";
import { canvas } from "./canvas/index.js";
import type { CanvasPluginOptions } from "./canvas/types.js";
import { graphview, type RspressPluginGraphViewOptions } from "./graph/index.js";
import { markdown } from "./markdown/index.js";
import { DEFAULT_VAULT_ROUTE_PREFIX } from "./markdown/normalize-options.js";
import type { RspressPluginMarkdownOptions } from "./markdown/types.js";

export type { GraphViewColors } from "./graph/runtime/GraphView.js";
export type { GraphViewGroup } from "./graph/types.js";
export type { BasesMapTiles, BasesOptions } from "./markdown/obsidian-plugins/bases/options.js";
export type { ExcalidrawOptions } from "./markdown/obsidian-plugins/excalidraw/options.js";
export type {
	KanbanDateColor,
	KanbanInlineMetadataPosition,
	KanbanMetadataKey,
	KanbanOptions,
	KanbanTagColor,
} from "./markdown/obsidian-plugins/kanban/options.js";
export type {
	TasksOptions,
	TasksStatusOption,
	TasksStatusType,
} from "./markdown/obsidian-plugins/tasks/options.js";
export type {
	TemplaterFileTemplate,
	TemplaterFolderTemplate,
	TemplaterOptions,
} from "./markdown/obsidian-plugins/templater/options.js";
export type { DailyNotesOptions, DiagnosticMode } from "./markdown/types.js";
export type { MathEngine } from "./math.js";
export type { MermaidSecurityLevel } from "./mermaid/classes.js";
export type { CanvasPluginOptions, RspressPluginGraphViewOptions, RspressPluginMarkdownOptions };
export { canvas, graphview, markdown };

/**
 * Options {@link pluginObsidian} applies to every feature it builds; an option
 * passed to a feature's own factory wins.
 */
export interface PluginObsidianOptions {
	/**
	 * The Obsidian vault the site publishes: `markdown`'s `vaultRoot`, and the
	 * folder `canvas` scans for boards.
	 */
	vaultRoot?: string;
	/**
	 * Where vault notes are published: `markdown`'s `vaultRoutePrefix`, and the
	 * `fileRoutePrefix` canvas cards link notes under when `canvas` scans this
	 * vault. Default: `"/vault"`.
	 */
	vaultRoutePrefix?: string;
}

/**
 * Builder handed to {@link pluginObsidian}: receives the three feature
 * factories, with the shared options already applied, and returns the plugins
 * to register.
 */
export type PluginObsidianBuilder = (
	markdown: (options?: RspressPluginMarkdownOptions) => RspressPlugin,
	canvas: (options?: CanvasPluginOptions) => RspressPlugin,
	graphview: (options?: RspressPluginGraphViewOptions) => RspressPlugin,
) => RspressPlugin[];

/**
 * Umbrella factory that composes {@link markdown}, {@link canvas}, and
 * {@link graphview} into a single flat `RspressPlugin[]` suitable for the
 * `plugins:` slot in an Rspress config.
 *
 * Pass the options every feature shares, then a builder that receives the
 * three factory functions as arguments and calls them inline. The graph view
 * and canvas boards follow the vault the markdown feature publishes, so the
 * vault is named once:
 *
 * @example
 * ```ts
 * import path from "node:path";
 * import { defineConfig } from "@rspress/core";
 * import { pluginObsidian } from "rspress-plugin-obsidian";
 *
 * export default defineConfig({
 *   plugins: pluginObsidian(
 *     { vaultRoot: path.join(import.meta.dirname, "My Vault") },
 *     (markdown, canvas, graphview) => [
 *       markdown({ enableCallouts: true }),
 *       canvas({ routePrefix: "/canvas" }),
 *       graphview({ defaultOpen: true }),
 *     ],
 *   ),
 * });
 * ```
 *
 * @param shared - Options applied to every feature; see
 *   {@link PluginObsidianOptions}. May be omitted.
 * @param build - Callback that picks options per feature and returns the
 *   plugins to register.
 * @returns The flattened plugin list, ready for `plugins:`.
 */
export function pluginObsidian(build: PluginObsidianBuilder): RspressPlugin[];
export function pluginObsidian(
	shared: PluginObsidianOptions,
	build: PluginObsidianBuilder,
): RspressPlugin[];
export function pluginObsidian(
	sharedOrBuild: PluginObsidianOptions | PluginObsidianBuilder,
	maybeBuild?: PluginObsidianBuilder,
): RspressPlugin[] {
	const shared: PluginObsidianOptions = typeof sharedOrBuild === "function" ? {} : sharedOrBuild;
	const build = typeof sharedOrBuild === "function" ? sharedOrBuild : maybeBuild;
	if (!build) throw new TypeError("pluginObsidian(shared, build) needs a build callback");
	return build(
		(options) =>
			markdown({
				...options,
				vaultRoot: options?.vaultRoot ?? shared.vaultRoot,
				vaultRoutePrefix: options?.vaultRoutePrefix ?? shared.vaultRoutePrefix,
			}),
		(options) => {
			const vaultRoot = options?.vaultRoot ?? shared.vaultRoot;
			// Cards link notes at the route the markdown feature publishes them
			// under — when the boards come from that same vault.
			const scansSharedVault = shared.vaultRoot !== undefined && vaultRoot === shared.vaultRoot;
			return canvas({
				...options,
				vaultRoot,
				fileRoutePrefix:
					options?.fileRoutePrefix ??
					(scansSharedVault ? (shared.vaultRoutePrefix ?? DEFAULT_VAULT_ROUTE_PREFIX) : undefined),
			});
		},
		graphview,
	);
}
