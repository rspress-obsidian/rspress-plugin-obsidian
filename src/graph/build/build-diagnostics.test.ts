import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGraphModule, createGraphBuildCache } from "./index";
import type { CollectedRoute } from "./types";

/**
 * The graph build is the slowest part of a large site's build, so these assert
 * its performance *contract* rather than a wall-clock number: every file is read
 * and parsed at most once per build, and a warm cache re-parses nothing. A
 * regression of the "rebuild the index per file" kind breaks these immediately,
 * on any machine.
 */
const roots: string[] = [];

afterEach(async () => {
	for (const root of roots.splice(0)) {
		await rm(root, { recursive: true, force: true });
	}
});

async function makeFixture(
	count: number,
): Promise<{ routes: CollectedRoute[]; write: (index: number, body: string) => Promise<void> }> {
	const root = await mkdtemp(join(tmpdir(), "graph-build-"));
	roots.push(root);

	const routes: CollectedRoute[] = [];
	for (let index = 0; index < count; index += 1) {
		const absolutePath = join(root, `note-${index}.md`);
		// `[^1]` keeps the extractor on the GFM path, which is the slower one.
		await writeFile(
			absolutePath,
			`# Note ${index}\n\nLinks to [[note-${(index + 1) % count}]].[^1]\n\n[^1]: see [[note-0]]\n`,
		);
		routes.push({
			routePath: `/note-${index}`,
			absolutePath,
			relativePath: `note-${index}.md`,
			pageName: `note-${index}`,
		});
	}

	return {
		routes,
		write: (index, body) => writeFile(join(root, `note-${index}.md`), body),
	};
}

describe("graph build diagnostics", () => {
	test("a cold build parses each route exactly once", async () => {
		const fixture = await makeFixture(20);
		const cache = createGraphBuildCache();

		const { diagnostics } = await buildGraphModule(fixture.routes, cache);

		expect(diagnostics.routeCount).toBe(20);
		expect(diagnostics.cacheMisses).toBe(20);
		expect(diagnostics.cacheHits).toBe(0);
		expect(diagnostics.reusedModule).toBe(false);
		// Every note links onward, so a build that skipped files would show up here.
		expect(diagnostics.linkCount).toBeGreaterThan(0);
	});

	test("a second build reuses every file and skips parsing", async () => {
		const fixture = await makeFixture(20);
		const cache = createGraphBuildCache();
		await buildGraphModule(fixture.routes, cache);

		const { diagnostics } = await buildGraphModule(fixture.routes, cache);

		expect(diagnostics.cacheHits).toBe(20);
		expect(diagnostics.cacheMisses).toBe(0);
		expect(diagnostics.reusedModule).toBe(true);
		expect(diagnostics.parseMs).toBe(0);
	});

	test("a single edited file misses the cache alone", async () => {
		const fixture = await makeFixture(20);
		const cache = createGraphBuildCache();
		await buildGraphModule(fixture.routes, cache);

		await fixture.write(7, "# Note 7\n\nNow links to [[note-3]].\n");
		const { diagnostics } = await buildGraphModule(fixture.routes, cache);

		expect(diagnostics.cacheMisses).toBe(1);
		expect(diagnostics.cacheHits).toBe(19);
		expect(diagnostics.reusedModule).toBe(false);
	});

	test("build time stays sub-quadratic as the site doubles", async () => {
		const measure = async (count: number): Promise<number> => {
			const fixture = await makeFixture(count);
			// Median of three cold builds: one sample is too noisy for a ratio.
			const samples: number[] = [];
			for (let run = 0; run < 3; run += 1) {
				const { diagnostics } = await buildGraphModule(fixture.routes, createGraphBuildCache());
				samples.push(diagnostics.parseMs + diagnostics.resolveMs);
			}
			return samples.sort((a, b) => a - b)[1] ?? 0;
		};

		const small = await measure(60);
		const large = await measure(120);

		// Linear work doubles; quadratic would quadruple. The bound is generous so
		// machine noise cannot fail it while a real algorithmic regression does.
		expect(large).toBeLessThan(Math.max(small, 1) * 3);
	});
});
