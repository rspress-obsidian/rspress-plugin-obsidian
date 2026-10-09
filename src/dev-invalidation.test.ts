import { expect, test } from "bun:test";
import { deferInvalidationPlugin } from "./dev-invalidation";

type Callback = (error: Error | null) => void;

interface FakeHook {
	tap(options: string | { name: string; stage: number }, fn: () => void): void;
	call(): void;
}

interface FakeWatching {
	invalidate(callback?: Callback): void;
	invalidateWithChangesAndRemovals(
		changed: Set<string>,
		removed: Set<string>,
		callback?: Callback,
	): void;
}

interface FakeCompiler {
	watching?: FakeWatching;
	hooks: Record<"done" | "afterDone" | "failed" | "watchRun", FakeHook>;
}

/** A hook that runs its taps by stage, as rspack's tapable hooks do. */
function fakeHook(): FakeHook {
	const taps: Array<{ stage: number; fn: () => void }> = [];
	return {
		tap(options, fn) {
			taps.push({ stage: typeof options === "string" ? 0 : options.stage, fn });
		},
		call() {
			for (const { fn } of taps.toSorted((a, b) => a.stage - b.stage)) fn();
		},
	};
}

/** A watching that records each invalidation it receives. */
function fakeWatching(received: unknown[][]): FakeWatching {
	return {
		invalidate(callback) {
			received.push(["invalidate", callback]);
		},
		invalidateWithChangesAndRemovals(changed, removed, callback) {
			received.push(["invalidateWithChangesAndRemovals", [...changed], [...removed], callback]);
		},
	};
}

function fakeCompiler(received: unknown[][]): FakeCompiler {
	return {
		watching: fakeWatching(received),
		hooks: { done: fakeHook(), afterDone: fakeHook(), failed: fakeHook(), watchRun: fakeHook() },
	};
}

/** Registers the plugin `times` times, as the markdown, canvas and graph plugins do. */
function register(compiler: FakeCompiler, times = 1) {
	for (let i = 0; i < times; i++) {
		deferInvalidationPlugin.setup({
			modifyRspackConfig: (modify) =>
				modify({}, { appendPlugins: (plugin) => plugin.apply(compiler) }),
		});
	}
	compiler.hooks.watchRun.call();
}

const nextTick = () => new Promise<void>((resolve) => process.nextTick(resolve));

const onInvalid: Callback = () => {};

test("an invalidation outside a finishing build reaches the watching at once", () => {
	const received: unknown[][] = [];
	const compiler = fakeCompiler(received);
	register(compiler);

	compiler.watching?.invalidate(onInvalid);
	compiler.watching?.invalidateWithChangesAndRemovals(new Set(["/a.md"]), new Set(["/b.md"]));

	expect(received).toEqual([
		["invalidate", onInvalid],
		["invalidateWithChangesAndRemovals", ["/a.md"], ["/b.md"], undefined],
	]);
});

test("invalidations from a done tap wait for the tick after afterDone, in order, with their arguments", async () => {
	const received: unknown[][] = [];
	const compiler = fakeCompiler(received);
	// Registered before the plugin, at the default stage, like Rsbuild's own async `done` taps.
	compiler.hooks.done.tap("lazy-request", () => {
		compiler.watching?.invalidateWithChangesAndRemovals(
			new Set(["/note.md"]),
			new Set(),
			onInvalid,
		);
		compiler.watching?.invalidate();
	});
	register(compiler);

	compiler.hooks.done.call();
	compiler.hooks.afterDone.call();
	expect(received).toEqual([]);

	await nextTick();
	expect(received).toEqual([
		["invalidateWithChangesAndRemovals", ["/note.md"], [], onInvalid],
		["invalidate", undefined],
	]);
});

test("a failed build releases the invalidations it held", async () => {
	const received: unknown[][] = [];
	const compiler = fakeCompiler(received);
	register(compiler);

	compiler.hooks.done.call();
	compiler.watching?.invalidate(onInvalid);
	compiler.hooks.failed.call();
	expect(received).toEqual([]);

	await nextTick();
	expect(received).toEqual([["invalidate", onInvalid]]);
	compiler.watching?.invalidate();
	expect(received).toEqual([
		["invalidate", onInvalid],
		["invalidate", undefined],
	]);
});

test("three registrations on one compiler deliver each invalidation once", async () => {
	const received: unknown[][] = [];
	const compiler = fakeCompiler(received);
	register(compiler, 3);

	compiler.watching?.invalidate();
	compiler.hooks.done.call();
	compiler.watching?.invalidateWithChangesAndRemovals(new Set(["/c.md"]), new Set());
	compiler.hooks.afterDone.call();
	await nextTick();

	expect(received).toEqual([
		["invalidate", undefined],
		["invalidateWithChangesAndRemovals", ["/c.md"], [], undefined],
	]);
});

test("a later watch run keeps the watching's wrapper and wraps a replaced watching", async () => {
	const received: unknown[][] = [];
	const compiler = fakeCompiler(received);
	register(compiler);
	const wrapper = compiler.watching?.invalidate;

	compiler.hooks.watchRun.call();
	expect(compiler.watching?.invalidate).toBe(wrapper);

	const replacement: unknown[][] = [];
	compiler.watching = undefined;
	compiler.hooks.watchRun.call();
	compiler.watching = fakeWatching(replacement);
	compiler.hooks.watchRun.call();
	compiler.hooks.done.call();
	compiler.watching.invalidate(onInvalid);
	compiler.hooks.afterDone.call();
	expect(replacement).toEqual([]);

	await nextTick();
	expect(replacement).toEqual([["invalidate", onInvalid]]);
	expect(received).toEqual([]);
});
