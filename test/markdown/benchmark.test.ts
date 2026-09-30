import { describe, expect, test } from "bun:test";
import path from "node:path";
import { buildContentIndex, getCachedContentIndex } from "../../src/markdown/content-index";
import { findWikilinkMatches, parseWikiLink } from "../../src/markdown/parse-wikilink";
import { resolveWikiLink } from "../../src/markdown/resolve-wikilink";

const fixtureRoot = path.resolve(process.cwd(), "test/markdown/fixtures/basic");

const SAMPLE_CONTENT = `
# Welcome

This is a test document with various wikilinks:

- Basic link: [[getting-started]]
- With alias: [[getting-started|Installation]]
- Heading link: [[advanced#Configuration]]
- Block ref: [[guide/getting-started#^install-step]]
- Embed: ![[getting-started]]

And some more links:
- [[api]]
- [[guide/advanced]]
- [[#FAQ]]

Keep linking: [[another-page]] [[third-page]] [[fourth]] [[fifth]]
`.repeat(10);

/**
 * Wall-clock budgets only hold on an idle dev box: `< 100 ms` for 10k iterations
 * is a different number on a 2-vCPU CI runner, and one miss used to abort the
 * whole run — so the coverage step never executed. Asserting a budget therefore
 * requires `RUN_BENCH_TESTS=1` (the same shape as `RUN_PUBLISH_TESTS` in
 * test/publish/dist.test.ts); the timings are still measured and logged, and the
 * correctness assertions in these tests run either way.
 */
const runBenchmarks = process.env.RUN_BENCH_TESTS === "1";

const expectWithinBudget = (duration: number, budgetMs: number): void => {
	if (runBenchmarks) expect(duration).toBeLessThan(budgetMs);
};

describe("parse-wikilink benchmarks", () => {
	test("findWikilinkMatches - 100 wikilinks", () => {
		const matches = findWikilinkMatches(SAMPLE_CONTENT);
		// 12 tokens per repeat, embeds included.
		expect(matches).toHaveLength(120);

		const start = performance.now();
		for (let i = 0; i < 1000; i++) {
			findWikilinkMatches(SAMPLE_CONTENT);
		}
		const duration = performance.now() - start;
		console.log(`  findWikilinkMatches: ${duration.toFixed(2)}ms for 1000 iterations`);
		expectWithinBudget(duration, 500);
	});

	test("parseWikiLink - single link", () => {
		const parsed = parseWikiLink(
			"guide/getting-started#Install|Install guide",
			"[[guide/getting-started#Install|Install guide]]",
		);
		expect(parsed).toMatchObject({
			target: "guide/getting-started",
			alias: "Install guide",
			subpath: { kind: "heading", value: "Install" },
		});

		const start = performance.now();
		for (let i = 0; i < 10000; i++) {
			parseWikiLink(
				"guide/getting-started#Install|Install guide",
				"[[guide/getting-started#Install|Install guide]]",
			);
		}
		const duration = performance.now() - start;
		console.log(`  parseWikiLink: ${duration.toFixed(2)}ms for 10000 iterations`);
		expectWithinBudget(duration, 100);
	});

	test("parseWikiLink - 100 links", () => {
		const matches = findWikilinkMatches(SAMPLE_CONTENT);
		const parsed = matches.map((match) => parseWikiLink(match.inner, match.fullMatch));
		expect(parsed.filter((link) => link.isEmbed)).toHaveLength(10);

		const start = performance.now();
		for (let i = 0; i < 1000; i++) {
			for (const match of matches) {
				parseWikiLink(match.inner, match.fullMatch);
			}
		}
		const duration = performance.now() - start;
		console.log(`  parseWikiLink 100 links: ${duration.toFixed(2)}ms for 1000 iterations`);
		expectWithinBudget(duration, 500);
	});
});

describe("content-index benchmarks", () => {
	test("buildContentIndex - basic fixture", async () => {
		const start = performance.now();
		const index = await buildContentIndex(fixtureRoot);
		const duration = performance.now() - start;
		console.log(`  buildContentIndex: ${duration.toFixed(2)}ms`);
		expectWithinBudget(duration, 100);

		expect([...index.byPathKey.keys()].sort()).toEqual([
			"",
			"guide/advanced",
			"guide/getting-started",
		]);
	});

	test("getCachedContentIndex - cached", async () => {
		const fresh = await buildContentIndex(fixtureRoot);
		const start = performance.now();
		let cached = fresh;
		for (let i = 0; i < 1000; i++) {
			cached = await getCachedContentIndex(fixtureRoot);
		}
		const duration = performance.now() - start;
		console.log(`  getCachedContentIndex (cached): ${duration.toFixed(2)}ms for 1000 iterations`);
		expectWithinBudget(duration, 500);

		// The cache is an optimisation, not a different index.
		expect([...cached.byPathKey.keys()].sort()).toEqual([...fresh.byPathKey.keys()].sort());
	});

	test("resolveWikiLink - exact path", async () => {
		const index = await buildContentIndex(fixtureRoot);
		const page = index.byPathKey.get("")!;
		const resolution = resolveWikiLink(
			parseWikiLink("guide/getting-started", "[[guide/getting-started]]"),
			{
				currentPage: page,
				index,
			},
		);
		expect(resolution).toMatchObject({ status: "ok", href: "/guide/getting-started" });

		const start = performance.now();
		for (let i = 0; i < 10000; i++) {
			resolveWikiLink(parseWikiLink("guide/getting-started", "[[guide/getting-started]]"), {
				currentPage: page,
				index,
			});
		}
		const duration = performance.now() - start;
		console.log(`  resolveWikiLink exact path: ${duration.toFixed(2)}ms for 10000 iterations`);
		expectWithinBudget(duration, 100);
	});

	test("resolveWikiLink - basename match", async () => {
		const index = await buildContentIndex(fixtureRoot);
		const page = index.byPathKey.get("")!;
		const resolution = resolveWikiLink(parseWikiLink("getting-started", "[[getting-started]]"), {
			currentPage: page,
			index,
		});
		// A bare basename resolves to the same page as the full path.
		expect(resolution).toMatchObject({ status: "ok", href: "/guide/getting-started" });

		const start = performance.now();
		for (let i = 0; i < 10000; i++) {
			resolveWikiLink(parseWikiLink("getting-started", "[[getting-started]]"), {
				currentPage: page,
				index,
			});
		}
		const duration = performance.now() - start;
		console.log(`  resolveWikiLink basename: ${duration.toFixed(2)}ms for 10000 iterations`);
		expectWithinBudget(duration, 100);
	});

	test("resolveWikiLink - with heading", async () => {
		const index = await buildContentIndex(fixtureRoot);
		const page = index.byPathKey.get("")!;
		const resolution = resolveWikiLink(
			parseWikiLink("guide/getting-started#Install", "[[guide/getting-started#Install]]"),
			{ currentPage: page, index },
		);
		expect(resolution.href).toBe("/guide/getting-started#install");
		expect(resolution.description).toBeTruthy();

		const start = performance.now();
		for (let i = 0; i < 10000; i++) {
			resolveWikiLink(
				parseWikiLink("guide/getting-started#Install", "[[guide/getting-started#Install]]"),
				{ currentPage: page, index },
			);
		}
		const duration = performance.now() - start;
		console.log(`  resolveWikiLink with heading: ${duration.toFixed(2)}ms for 10000 iterations`);
		expectWithinBudget(duration, 200);
	});
});

describe("full pipeline benchmarks", () => {
	test("full pipeline - 100 wikilinks", async () => {
		const index = await buildContentIndex(fixtureRoot);
		const page = index.byPathKey.get("")!;
		const matches = findWikilinkMatches(SAMPLE_CONTENT);

		const resolutions = matches.map((match) =>
			resolveWikiLink(parseWikiLink(match.inner, match.fullMatch), {
				currentPage: page,
				index,
			}),
		);
		expect(resolutions).toHaveLength(matches.length);
		expect(resolutions.some((resolution) => resolution.status === "ok")).toBe(true);

		const start = performance.now();
		for (let i = 0; i < 1000; i++) {
			for (const match of matches) {
				const parsed = parseWikiLink(match.inner, match.fullMatch);
				resolveWikiLink(parsed, {
					currentPage: page,
					index,
				});
			}
		}
		const duration = performance.now() - start;
		console.log(`  full pipeline 100 wikilinks: ${duration.toFixed(2)}ms for 1000 iterations`);
		expectWithinBudget(duration, 1000);
	});
});
