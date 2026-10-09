import type { UserConfig } from "@rspress/core";

type RsbuildPluginEntry = NonNullable<NonNullable<UserConfig["builderConfig"]>["plugins"]>[number];

type InvalidateCallback = (error: Error | null) => void;

/** The part of an rspack watching that lazy compilation and the graph refresher call. */
interface WatchingLike {
	invalidate(callback?: InvalidateCallback): void;
	invalidateWithChangesAndRemovals(
		changed: Set<string>,
		removed: Set<string>,
		callback?: InvalidateCallback,
	): void;
}

interface HookLike {
	tap(options: string | { name: string; stage: number }, fn: () => void): void;
}

/** The part of an rspack compiler the plugin drives. */
interface CompilerLike {
	watching?: WatchingLike;
	hooks: Record<"done" | "afterDone" | "failed" | "watchRun", HookLike>;
}

interface RspackPluginLike {
	name: string;
	apply(compiler: CompilerLike): void;
}

/**
 * The slice of Rsbuild's plugin API the plugin uses. Rsbuild types
 * `builderConfig.plugins` entries' `setup(api)` as `any`, so the plugin spells
 * out what it relies on.
 */
interface RspackConfigApi {
	modifyRspackConfig(
		modify: (config: object, utils: { appendPlugins(plugin: RspackPluginLike): void }) => void,
	): void;
}

const NAME = "rspress-plugin-obsidian:defer-invalidation";

// The markdown, canvas and graph plugins each register this plugin.
const deferring = new WeakSet<CompilerLike>();

// Rspack (2.2.2 to at least 2.2.8) marks a watch build finished before its
// `done` taps settle and reads that build's dependencies on the tick after
// `afterDone`. An invalidation in between, such as a lazy-compilation request
// from a page hover, starts the next build, which takes the module graph, and
// the read crashes `rspress dev`. Remove this once `bun scripts/repro-dev-race.ts`
// passes without it.
const deferInvalidationDuringDone: RspackPluginLike = {
	name: NAME,
	apply(compiler) {
		if (deferring.has(compiler)) return;
		deferring.add(compiler);
		let held: Array<() => void> | undefined;
		let wrapped: WatchingLike | undefined;
		const release = () =>
			process.nextTick(() => {
				const calls = held ?? [];
				held = undefined;
				for (const call of calls) call();
			});

		compiler.hooks.done.tap({ name: NAME, stage: Number.NEGATIVE_INFINITY }, () => {
			held ??= [];
		});
		compiler.hooks.afterDone.tap(NAME, release);
		compiler.hooks.failed.tap(NAME, release);
		compiler.hooks.watchRun.tap(NAME, () => {
			const watching = compiler.watching;
			if (!watching || watching === wrapped) return;
			wrapped = watching;
			const invalidate = watching.invalidate.bind(watching);
			const invalidateWithChanges = watching.invalidateWithChangesAndRemovals.bind(watching);
			watching.invalidate = (callback) => {
				if (held) held.push(() => invalidate(callback));
				else invalidate(callback);
			};
			watching.invalidateWithChangesAndRemovals = (changed, removed, callback) => {
				if (held) held.push(() => invalidateWithChanges(changed, removed, callback));
				else invalidateWithChanges(changed, removed, callback);
			};
		});
	},
};

/** Holds rspack invalidations that arrive while a finished dev build is still completing. */
export const deferInvalidationPlugin = {
	name: NAME,
	setup(api: RspackConfigApi) {
		api.modifyRspackConfig((_config, { appendPlugins }) =>
			appendPlugins(deferInvalidationDuringDone),
		);
	},
} satisfies RsbuildPluginEntry;
