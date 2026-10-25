import { afterEach, describe, expect, test, vi } from "bun:test";
import path from "node:path";
import { createGraphDevRefresher, type GraphDevRefresher } from "./dev-refresh";

// Absolute on every platform, as the plugin's `node_modules` path is: on
// Windows a bare `/tmp/...` is drive-relative and gains the drive letter when
// the refresher resolves it against the compiler's context.
const moduleDir = path.resolve("/tmp/graph-dev");

type Listener = (event: string, file: string | null) => void;

/** A fake `fs.watch`: records watched roots and lets a test fire changes. */
function fakeWatch() {
	const listeners = new Map<string, Listener>();
	const closed: string[] = [];
	const watch = (root: string, _options: unknown, listener: Listener) => {
		listeners.set(root, listener);
		return { close: () => closed.push(root) };
	};
	return { watch, listeners, closed };
}

/**
 * Run the plugin's `setup` against a fake Rsbuild API: records what reaches the
 * compiler's in-memory store and every invalidation of its watching, and lets
 * a test fire the compiler's `watchRun` and `done` hooks.
 */
function attachCompiler(refresher: GraphDevRefresher) {
	const writes: Array<[string, string]> = [];
	const invalidated: string[][] = [];
	const seeded: Array<Record<string, string>> = [];
	const taps = new Map<string, Array<() => void>>();
	const hook = (name: string) => ({
		tap: (_plugin: string, fn: () => void) => taps.set(name, [...(taps.get(name) ?? []), fn]),
	});
	const fire = (name: string) => {
		for (const fn of taps.get(name) ?? []) fn();
	};
	class VirtualModulesPlugin {
		constructor(modules: Record<string, string>) {
			seeded.push(modules);
		}
		getVirtualFileStore() {
			return {
				writeVirtualFileSync: (file: string, contents: string) => writes.push([file, contents]),
			};
		}
	}
	const compiler = {
		context: "/",
		watching: {
			invalidateWithChangesAndRemovals: (changed: Set<string>) => invalidated.push([...changed]),
		},
		hooks: { watchRun: hook("watchRun"), done: hook("done"), failed: hook("failed") },
	};
	const plugin = refresher.rsbuildPlugin as { setup: (api: unknown) => void };
	plugin.setup({
		modifyRspackConfig: (
			modify: (
				config: object,
				utils: { rspack: unknown; appendPlugins: (plugins: unknown[]) => void },
			) => object,
		) =>
			modify(
				{},
				{
					rspack: { experiments: { VirtualModulesPlugin } },
					appendPlugins: (plugins) => {
						for (const entry of plugins as Array<{ apply?: (c: typeof compiler) => void }>) {
							entry.apply?.(compiler);
						}
					},
				},
			),
	});
	return { writes, seeded, invalidated, fire };
}

/** Let a started rebuild and its write finish (`setImmediate` is not on the fake clock). */
async function settled(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	await promise;
}

afterEach(() => {
	vi.useRealTimers();
});

describe("graph dev refresher", () => {
	test("publishes re-exports of in-memory files seeded with the first build", () => {
		const refresher = createGraphDevRefresher({
			moduleDir,
			rebuild: async () => ({}),
		});

		const published = refresher.publish({ "virtual-graph-data": "export const graphPayload = 1;" });
		const { seeded } = attachCompiler(refresher);

		const file = path.join(moduleDir, "virtual-graph-data.js");
		expect(published["virtual-graph-data"]).toContain(`export * from ${JSON.stringify(file)}`);
		expect(seeded[0]).toEqual({ [file]: "export const graphPayload = 1;" });
	});

	test("a change under a watched root rebuilds once (debounced) and writes only what changed", async () => {
		vi.useFakeTimers();
		const { watch, listeners } = fakeWatch();
		let builds = 0;
		const refresher = createGraphDevRefresher({
			moduleDir,
			debounceMs: 100,
			watch,
			rebuild: async () => {
				builds += 1;
				return { "virtual-graph-data": "v2", "virtual-graph-search-data": "same" };
			},
		});
		refresher.publish({ "virtual-graph-data": "v1", "virtual-graph-search-data": "same" });
		const { writes } = attachCompiler(refresher);
		refresher.watch(["/docs"]);

		const onChange = listeners.get("/docs");
		onChange?.("change", "a.md");
		onChange?.("change", "b.md");
		onChange?.("change", "node_modules/x.js");
		vi.advanceTimersByTime(150);
		await refresher.refresh();

		// Two saves inside the debounce window are one rebuild (plus the explicit
		// refresh above); `node_modules` noise is ignored.
		expect(builds).toBe(2);
		expect(writes).toEqual([[path.join(moduleDir, "virtual-graph-data.js"), "v2"]]);
		refresher.close();
	});

	test("a change that lands mid-compile rebuilds once that compile is done, not before", async () => {
		// The saved note is itself being recompiled when the debounce ends;
		// invalidating then would hold the note's hot update back for a second run.
		vi.useFakeTimers();
		const { watch, listeners } = fakeWatch();
		let builds = 0;
		const refresher = createGraphDevRefresher({
			moduleDir,
			watch,
			rebuild: async () => {
				builds += 1;
				return { "virtual-graph-data": `v${builds + 1}` };
			},
		});
		refresher.publish({ "virtual-graph-data": "v1" });
		const { fire, invalidated } = attachCompiler(refresher);
		refresher.watch(["/docs"]);
		const onChange = listeners.get("/docs");

		fire("watchRun");
		onChange?.("change", "a.md");
		vi.advanceTimersByTime(25);
		await settled();
		expect(builds).toBe(0);

		fire("done");
		await settled();
		expect(builds).toBe(1);
		expect(invalidated).toEqual([[path.join(moduleDir, "virtual-graph-data.js")]]);

		// A compile with no change waiting rebuilds nothing.
		fire("watchRun");
		fire("done");
		await settled();
		expect(builds).toBe(1);

		// A failed compile releases the change too, unless the watcher was closed.
		fire("watchRun");
		onChange?.("change", "b.md");
		vi.advanceTimersByTime(25);
		fire("failed");
		await settled();
		expect(builds).toBe(2);
		fire("watchRun");
		onChange?.("change", "c.md");
		vi.advanceTimersByTime(25);
		refresher.close();
		fire("done");
		await settled();
		expect(builds).toBe(2);
	});

	test("a change with no compile running rebuilds as soon as the debounce ends", async () => {
		vi.useFakeTimers();
		const { watch, listeners } = fakeWatch();
		let builds = 0;
		const refresher = createGraphDevRefresher({
			moduleDir,
			watch,
			rebuild: async () => {
				builds += 1;
				return {};
			},
		});
		attachCompiler(refresher);
		refresher.watch(["/docs"]);

		listeners.get("/docs")?.("change", "a.md");
		vi.advanceTimersByTime(24);
		await settled();
		expect(builds).toBe(0);
		vi.advanceTimersByTime(1);
		await settled();
		expect(builds).toBe(1);
		refresher.close();
	});

	test("a rewritten module is marked changed on the compiler's watching, so a compile in flight cannot drop it", async () => {
		// rspack's own `writeModule` signals through the native watcher, which
		// loses the event while paused around a compile — a note's recompile
		// runs at exactly that moment. The refresher invalidates the watching
		// with the file instead, which rspack queues even mid-compile.
		const refresher = createGraphDevRefresher({
			moduleDir,
			rebuild: async () => ({ "virtual-graph-data": "v2" }),
		});
		refresher.publish({ "virtual-graph-data": "v1" });
		const { writes, invalidated } = attachCompiler(refresher);

		await refresher.refresh();

		const file = path.join(moduleDir, "virtual-graph-data.js");
		expect(writes).toEqual([[file, "v2"]]);
		expect(invalidated).toEqual([[file]]);
	});

	test("a failed rebuild warns and keeps the last good data", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const refresher = createGraphDevRefresher({
			moduleDir,
			rebuild: async () => {
				throw new Error("half-typed frontmatter");
			},
		});
		refresher.publish({ "virtual-graph-data": "v1" });
		const { writes } = attachCompiler(refresher);

		await refresher.refresh();

		expect(writes).toEqual([]);
		expect(String(warn.mock.calls[0]?.[0])).toContain("half-typed frontmatter");
		warn.mockRestore();
	});

	test("watching again replaces the previous watchers", () => {
		const { watch, closed } = fakeWatch();
		const refresher = createGraphDevRefresher({
			moduleDir,
			watch,
			rebuild: async () => ({}),
		});
		refresher.watch(["/docs", "/vault"]);
		refresher.watch(["/docs"]);
		expect(closed.sort()).toEqual(["/docs", "/vault"]);
		refresher.close();
	});
});
