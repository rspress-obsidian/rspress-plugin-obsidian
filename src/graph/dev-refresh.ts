import { type FSWatcher, watch as fsWatch } from "node:fs";
import path from "node:path";
import type { UserConfig } from "@rspress/core";

type RsbuildPluginEntry = NonNullable<NonNullable<UserConfig["builderConfig"]>["plugins"]>[number];

/** The part of rspack's `experiments.VirtualModulesPlugin` the refresher drives. */
interface VirtualModulesPluginLike {
	getVirtualFileStore(): { writeVirtualFileSync(filePath: string, contents: string): void };
}

/** The part of an rspack compiler the refresher drives. */
interface CompilerLike {
	context: string;
	watching?: {
		invalidateWithChangesAndRemovals(changed: Set<string>, removed: Set<string>): void;
	};
}

/** A tiny rspack plugin that only remembers the compiler it is applied to. */
interface CompilerCapture {
	name: string;
	apply(compiler: CompilerLike): void;
}

/** One compiler's in-memory files, and the compiler once it exists. */
interface WriteTarget {
	plugin: VirtualModulesPluginLike;
	compiler?: CompilerLike;
}

/**
 * The slice of Rsbuild's plugin API the refresher uses. Rsbuild types
 * `builderConfig.plugins` entries' `setup(api)` as `any`, so the plugin spells
 * out what it relies on.
 */
interface RspackConfigApi {
	modifyRspackConfig(
		modify: (
			config: object,
			utils: {
				rspack: {
					experiments: {
						VirtualModulesPlugin: new (modules: Record<string, string>) => VirtualModulesPluginLike;
					};
				};
				appendPlugins: (plugins: Array<VirtualModulesPluginLike | CompilerCapture>) => void;
			},
		) => object,
	): void;
}

type WatchFunction = (
	root: string,
	options: { recursive: true; persistent: false },
	listener: (event: string, file: string | Buffer | null) => void,
) => Pick<FSWatcher, "close">;

export interface GraphDevRefresherOptions {
	/** Directory the in-memory module files are addressed under (never written to disk). */
	moduleDir: string;
	/** Rebuild every graph module; returns module id → source. */
	rebuild: () => Promise<Record<string, string>>;
	debounceMs?: number;
	watch?: WatchFunction;
}

/**
 * Keeps the graph's virtual modules current under `rspress dev`.
 *
 * Rspress asks plugins for their runtime modules once per dev-server start and
 * serves a fixed string afterwards, so a note edited during `rspress dev` would
 * never reach the graph or the hover previews. In dev the Rspress module is a
 * one-line re-export of an in-memory file this refresher owns (rspack's
 * `VirtualModulesPlugin`); a debounced watcher on the content roots rebuilds
 * the data and rewrites that file, which rspack treats as a changed module and
 * hot-updates.
 */
export interface GraphDevRefresher {
	/** Rspress module sources for dev: re-exports of the refresher's in-memory files. */
	publish(modules: Record<string, string>): Record<string, string>;
	/** Registers the in-memory files with every rspack compiler the dev server creates. */
	rsbuildPlugin: RsbuildPluginEntry;
	/** Watch the content roots, replacing any earlier watchers. */
	watch(roots: readonly string[]): void;
	/** Rebuild now and push whatever changed. */
	refresh(): Promise<void>;
	close(): void;
}

export function createGraphDevRefresher(options: GraphDevRefresherOptions): GraphDevRefresher {
	// One live record seeds every compiler's in-memory files: rspack reads it
	// when the compiler is set up, so a write that lands before then is still
	// picked up.
	const current: Record<string, string> = {};
	const targets: WriteTarget[] = [];
	let watchers: Array<Pick<FSWatcher, "close">> = [];
	let timer: ReturnType<typeof setTimeout> | undefined;
	let pending: Promise<void> = Promise.resolve();
	const watch = options.watch ?? (fsWatch as WatchFunction);

	const fileFor = (moduleId: string) => path.join(options.moduleDir, `${moduleId}.js`);

	const write = (modules: Record<string, string>) => {
		for (const [moduleId, source] of Object.entries(modules)) {
			const file = fileFor(moduleId);
			if (current[file] === source) continue;
			current[file] = source;
			for (const { plugin, compiler } of targets) {
				if (!compiler) continue;
				const fullPath = path.resolve(compiler.context, file);
				try {
					plugin.getVirtualFileStore().writeVirtualFileSync(fullPath, source);
				} catch {
					// The compiler's store is not set up yet; it will read `current`.
					continue;
				}
				// `writeModule` would signal the change through the native watcher,
				// which drops events while it is paused around a compile — and a
				// note's own recompile runs at exactly that moment. Invalidating the
				// watching records the file as changed and, mid-compile, queues
				// another run instead.
				compiler.watching?.invalidateWithChangesAndRemovals(new Set([fullPath]), new Set());
			}
		}
	};

	const refresh = (): Promise<void> => {
		pending = pending
			.then(async () => write(await options.rebuild()))
			.catch((error: unknown) => {
				// A half-typed note must not take the dev server down; the next
				// save tries again.
				console.warn(
					`[rspress-plugin-obsidian:graph] graph refresh failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		return pending;
	};

	const stopWatching = () => {
		clearTimeout(timer);
		for (const watcher of watchers) watcher.close();
		watchers = [];
	};

	return {
		/** Rspress module sources for dev: re-exports of the refresher's files. */
		publish(modules: Record<string, string>): Record<string, string> {
			write(modules);
			return Object.fromEntries(
				Object.keys(modules).map((moduleId) => {
					const file = JSON.stringify(fileFor(moduleId));
					return [moduleId, `export * from ${file};\nexport { default } from ${file};\n`];
				}),
			);
		},

		/** Registers the in-memory files with every rspack compiler the dev server creates. */
		rsbuildPlugin: {
			name: "rspress-plugin-obsidian:graph-dev-data",
			setup(api: RspackConfigApi) {
				api.modifyRspackConfig((config, { rspack, appendPlugins }) => {
					const target: WriteTarget = {
						plugin: new rspack.experiments.VirtualModulesPlugin(current),
					};
					targets.push(target);
					appendPlugins([
						target.plugin,
						{
							name: "rspress-plugin-obsidian:graph-dev-compiler",
							apply(compiler) {
								target.compiler = compiler;
							},
						},
					]);
					return config;
				});
			},
		} satisfies RsbuildPluginEntry,

		watch(roots: readonly string[]): void {
			stopWatching();
			const onChange = (_event: string, file: string | Buffer | null) => {
				const name = String(file ?? "");
				if (/(?:^|[\\/])(?:node_modules|\.git)(?:[\\/]|$)/.test(name)) return;
				clearTimeout(timer);
				timer = setTimeout(() => void refresh(), options.debounceMs ?? 150);
			};
			watchers = [...new Set(roots)].flatMap((root) => {
				try {
					return [watch(root, { recursive: true, persistent: false }, onChange)];
				} catch {
					// A root that vanished between config and watch has nothing to report.
					return [];
				}
			});
		},

		refresh,

		close: stopWatching,
	};
}
