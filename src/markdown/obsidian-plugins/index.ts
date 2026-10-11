import type { NormalizedPluginOptions } from "../types.js";
import { basesFeature } from "./bases/index.js";
import { excalidrawFeature } from "./excalidraw/index.js";
import { kanbanFeature } from "./kanban/index.js";
import { tasksFeature } from "./tasks/index.js";
import { templaterFeature } from "./templater/index.js";
import type { BuilderConfig, ObsidianPluginFeature } from "./types.js";

/** Every reproduced Obsidian plugin, in the order their hooks run. */
export const OBSIDIAN_PLUGIN_FEATURES: readonly ObsidianPluginFeature[] = [
	templaterFeature,
	tasksFeature,
	kanbanFeature,
	excalidrawFeature,
	basesFeature,
];

export function enabledPluginFeatures(options: NormalizedPluginOptions): ObsidianPluginFeature[] {
	return OBSIDIAN_PLUGIN_FEATURES.filter((feature) => feature.isEnabled(options));
}

/**
 * Why a fence stays code: it belongs to a plugin whose feature is off. A fence
 * in any other language is the author's own code and gets no message.
 */
export function disabledFenceMessage(
	language: string,
	options: NormalizedPluginOptions,
): string | undefined {
	if ((language === "dataview" || language === "dataviewjs") && !options.enableDataview) {
		return `Dataview blocks render only with \`enableDataview\`; the block is rendered as code.`;
	}
	const feature = OBSIDIAN_PLUGIN_FEATURES.find((candidate) =>
		candidate.fences?.includes(language),
	);
	if (!feature || feature.isEnabled(options)) return undefined;
	return `${feature.label} blocks render only with \`${String(feature.enableOption)}\`; the block is rendered as code.`;
}

/**
 * Combine Rsbuild configs: `plugins` concatenate, `resolve.alias` entries chain
 * (Rsbuild applies each in turn), `source.define` merges key by key, and any
 * other key is taken from the last config that sets it.
 */
export function mergeBuilderConfigs(...configs: BuilderConfig[]): BuilderConfig {
	const merged: BuilderConfig = {};
	const plugins: NonNullable<BuilderConfig["plugins"]> = [];
	for (const config of configs) {
		const { plugins: own, resolve, source, ...rest } = config;
		Object.assign(merged, rest);
		if (own) plugins.push(...own);
		if (resolve) {
			const alias = chainAliases(merged.resolve?.alias, resolve.alias);
			merged.resolve = { ...merged.resolve, ...resolve, ...(alias && { alias }) };
		}
		if (source) {
			merged.source = {
				...merged.source,
				...source,
				define: { ...merged.source?.define, ...source.define },
			};
		}
	}
	if (plugins.length > 0) merged.plugins = plugins;
	return merged;
}

type AliasChain = NonNullable<NonNullable<BuilderConfig["resolve"]>["alias"]>;

function chainAliases(...aliases: Array<AliasChain | undefined>): AliasChain | undefined {
	const entries: unknown[] = aliases.flatMap((alias) =>
		alias === undefined ? [] : Array.isArray(alias) ? alias : [alias],
	);
	// Rsbuild's `ConfigChain` accepts an array of alias objects and functions,
	// applied in order — exactly the entries collected here.
	return entries.length > 0 ? (entries as AliasChain) : undefined;
}

export type {
	BuilderConfig,
	ObsidianPluginFeature,
	PluginBuildContext,
	PluginPage,
	PluginRenderContext,
} from "./types.js";
