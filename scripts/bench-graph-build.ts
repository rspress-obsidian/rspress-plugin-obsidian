import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	buildGraphModules,
	type CollectedRoute,
	type GraphBuildDiagnostics,
	type GraphBuildOptions,
	type GraphBuildState,
} from "../src/graph/build";

type GraphShape = "sequential" | "ring" | "hub" | "clustered";

/** How each synthetic note links onward: the two shapes real vaults come in. */
type LinkStyle = "wikilink" | "markdown";

interface BenchmarkOptions {
	pages: number;
	linksPerPage: number;
	iterations: number;
	shape: GraphShape;
	style: LinkStyle;
	jsonOutputPath?: string;
	csvOutputPath?: string;
}

interface SyntheticDocsFixture {
	rootDir: string;
	routes: CollectedRoute[];
}

interface BenchmarkSummary {
	scenario: string;
	shape: GraphShape;
	avgTotalMs: number;
	avgFilesRead: number;
	avgResolvedLinks: number;
	moduleReuseRate: number;
	nodes: number;
	links: number;
}

interface BenchmarkReport {
	generatedAt: string;
	options: Pick<BenchmarkOptions, "pages" | "linksPerPage" | "iterations" | "shape">;
	summaries: BenchmarkSummary[];
	improvements: {
		warmCacheVsCold: number;
		singleFileChangeVsCold: number;
	};
}

function buildOptions(rootDir: string): GraphBuildOptions {
	// Without `markdown()` in the process the graph indexes the docs root
	// itself, which is exactly the work a real build shares with the markdown
	// plugin.
	return { docsRoot: rootDir, base: "/", profile: true, logger: () => {} };
}

await main();

async function main(): Promise<void> {
	const options = parseArgs(Bun.argv.slice(2));
	const fixture = await createSyntheticDocs(options);

	try {
		const coldRuns = await runColdBuilds(options);
		const warmRuns = await runWarmBuilds(fixture, options.iterations);
		const incrementalRuns = await runIncrementalBuilds(
			fixture,
			options.iterations,
			options.linksPerPage,
			options.shape,
			options.style,
		);

		const coldSummary = summarizeDiagnostics("cold", options.shape, coldRuns);
		const warmSummary = summarizeDiagnostics("warm-cache", options.shape, warmRuns);
		const incrementalSummary = summarizeDiagnostics(
			"single-file-change",
			options.shape,
			incrementalRuns,
		);
		const summaries = [coldSummary, warmSummary, incrementalSummary];
		const report = createReport(options, summaries);

		console.log("Synthetic graph build benchmark");
		console.log(
			`pages=${options.pages} | linksPerPage=${options.linksPerPage} | iterations=${options.iterations} | shape=${options.shape}`,
		);
		console.table([
			toTableRow(coldSummary),
			toTableRow(warmSummary),
			toTableRow(incrementalSummary),
		]);
		console.log(
			`warm-cache improvement vs cold: ${formatPercent(report.improvements.warmCacheVsCold)}`,
		);
		console.log(
			`single-file-change improvement vs cold: ${formatPercent(report.improvements.singleFileChangeVsCold)}`,
		);

		await writeOptionalOutputs(options, report);
	} finally {
		await rm(fixture.rootDir, { recursive: true, force: true });
	}
}

function parseArgs(argv: string[]): BenchmarkOptions {
	const options: BenchmarkOptions = {
		pages: 750,
		linksPerPage: 6,
		iterations: 5,
		shape: "sequential",
		// Wikilinks are what a vault actually contains, and they take the
		// common case; `--style=markdown` measures markdown-link extraction.
		style: "wikilink",
	};

	for (const arg of expandArgv(argv)) {
		const [rawKey, rawValue = ""] = arg.split("=");

		switch (rawKey) {
			case "--shape":
				if (!isGraphShape(rawValue)) {
					throw new Error(`Invalid --shape: "${rawValue}"`);
				}
				options.shape = rawValue;
				break;
			case "--style":
				if (rawValue !== "wikilink" && rawValue !== "markdown") {
					throw new Error(`Invalid --style: "${rawValue}" (wikilink | markdown)`);
				}
				options.style = rawValue;
				break;
			case "--json":
				options.jsonOutputPath = rawValue;
				break;
			case "--csv":
				options.csvOutputPath = rawValue;
				break;
			case "--pages":
				options.pages = clampInteger(parseFlagNumber(rawKey, rawValue), 2);
				break;
			case "--links":
				options.linksPerPage = clampInteger(parseFlagNumber(rawKey, rawValue), 1);
				break;
			case "--iterations":
				options.iterations = clampInteger(parseFlagNumber(rawKey, rawValue), 1);
				break;
			default:
				throw new Error(`Unknown benchmark flag: "${rawKey}"`);
		}
	}

	options.linksPerPage = Math.min(options.linksPerPage, options.pages - 1);
	return options;
}

/** Accept `--pages 3000` as well as `--pages=3000`; reject dangling or unknown flags. */
function expandArgv(argv: string[]): string[] {
	const expanded: string[] = [];

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index] ?? "";
		if (arg.includes("=")) {
			expanded.push(arg);
			continue;
		}
		if (!arg.startsWith("--")) {
			throw new Error(`Unexpected benchmark argument: "${arg}"`);
		}

		const value = argv[index + 1];
		if (value === undefined || value.startsWith("--")) {
			throw new Error(`Missing value for ${arg}`);
		}

		expanded.push(`${arg}=${value}`);
		index += 1;
	}

	return expanded;
}

function parseFlagNumber(key: string, value: string): number {
	const trimmed = value.trim();
	const parsed = Number(trimmed);
	if (trimmed === "" || !Number.isFinite(parsed)) {
		throw new Error(`Invalid value for ${key}: "${value}"`);
	}

	return parsed;
}

function isGraphShape(value: string): value is GraphShape {
	return value === "sequential" || value === "ring" || value === "hub" || value === "clustered";
}

function clampInteger(value: number, minimum: number): number {
	return Math.max(minimum, Math.floor(value));
}

async function createSyntheticDocs(options: BenchmarkOptions): Promise<SyntheticDocsFixture> {
	const rootDir = await mkdtemp(join(tmpdir(), "graph-view-bench-"));
	const routes: CollectedRoute[] = [];

	for (let pageIndex = 0; pageIndex < options.pages; pageIndex += 1) {
		const route = createRoute(rootDir, pageIndex);
		const content = createSyntheticMarkdown(
			pageIndex,
			options.pages,
			options.linksPerPage,
			options.shape,
			0,
			options.style,
		);

		await Bun.write(route.absolutePath, content);
		routes.push(route);
	}

	return { rootDir, routes };
}

function createRoute(rootDir: string, pageIndex: number): CollectedRoute {
	const fileName = pageIndex === 0 ? "index.md" : `page-${pageIndex}.md`;
	const routePath = pageIndex === 0 ? "/" : `/page-${pageIndex}`;

	return {
		routePath,
		absolutePath: join(rootDir, fileName),
		relativePath: fileName,
		pageName: pageIndex === 0 ? "index" : `page-${pageIndex}`,
	};
}

function createSyntheticMarkdown(
	pageIndex: number,
	pageCount: number,
	linksPerPage: number,
	shape: GraphShape,
	revision: number,
	style: LinkStyle,
): string {
	const links = buildSyntheticLinkTargets(pageIndex, pageCount, linksPerPage, shape).map(
		(targetIndex) => {
			// The links must name the file, or every edge is unresolved and the
			// benchmark measures the unresolved-link report instead of the build.
			// Page 0 is the site's `index.md`.
			const file = targetIndex === 0 ? "index" : `page-${targetIndex}`;
			return style === "wikilink" ? `- [[${file}]]` : `- [Page ${targetIndex}](./${file}.md)`;
		},
	);

	return [
		`# Page ${pageIndex}`,
		"",
		`Synthetic benchmark revision ${revision} (${shape})`,
		"",
		...links,
		"",
	].join("\n");
}

function buildSyntheticLinkTargets(
	pageIndex: number,
	pageCount: number,
	linksPerPage: number,
	shape: GraphShape,
): number[] {
	switch (shape) {
		case "sequential":
			return buildSequentialTargets(pageIndex, pageCount, linksPerPage);
		case "hub":
			return buildHubTargets(pageIndex, pageCount, linksPerPage);
		case "clustered":
			return buildClusteredTargets(pageIndex, pageCount, linksPerPage);
		default:
			return buildRingTargets(pageIndex, pageCount, linksPerPage);
	}
}

function buildSequentialTargets(
	pageIndex: number,
	pageCount: number,
	linksPerPage: number,
): number[] {
	return Array.from({ length: linksPerPage }, (_, offset) => (pageIndex + offset + 1) % pageCount);
}

function buildRingTargets(pageIndex: number, pageCount: number, linksPerPage: number): number[] {
	const targets = new Set<number>();
	let distance = 1;

	while (targets.size < linksPerPage && distance < pageCount) {
		targets.add((pageIndex + distance) % pageCount);

		if (targets.size < linksPerPage) {
			targets.add((pageIndex - distance + pageCount) % pageCount);
		}

		targets.delete(pageIndex);
		distance += 1;
	}

	if (targets.size < linksPerPage) {
		for (const target of buildSequentialTargets(pageIndex, pageCount, linksPerPage)) {
			targets.add(target);
			if (targets.size >= linksPerPage) {
				break;
			}
		}
	}

	return [...targets].slice(0, linksPerPage);
}

function buildHubTargets(pageIndex: number, pageCount: number, linksPerPage: number): number[] {
	const targets = new Set<number>();
	const hubIndex = 0;

	if (pageIndex !== hubIndex) {
		targets.add(hubIndex);
	}

	let offset = 1;
	while (targets.size < linksPerPage) {
		const candidate = (pageIndex + offset) % pageCount;
		if (candidate !== pageIndex) {
			targets.add(candidate);
		}
		offset += 1;
	}

	return [...targets];
}

function buildClusteredTargets(
	pageIndex: number,
	pageCount: number,
	linksPerPage: number,
): number[] {
	const targets = new Set<number>();
	const clusterCount = Math.min(6, Math.max(2, Math.ceil(pageCount / 150)));
	const clusterSize = Math.max(1, Math.ceil(pageCount / clusterCount));
	const clusterIndex = Math.floor(pageIndex / clusterSize);
	const clusterStart = clusterIndex * clusterSize;
	const clusterEnd = Math.min(pageCount, clusterStart + clusterSize);

	let offset = 1;
	while (targets.size < Math.max(1, linksPerPage - 1)) {
		const candidate =
			clusterStart + ((pageIndex - clusterStart + offset) % (clusterEnd - clusterStart));
		if (candidate !== pageIndex) {
			targets.add(candidate);
		}
		offset += 1;
	}

	const nextClusterStart = (clusterStart + clusterSize) % pageCount;
	if (targets.size < linksPerPage && nextClusterStart !== pageIndex) {
		targets.add(nextClusterStart);
	}

	let spillOffset = 1;
	while (targets.size < linksPerPage) {
		const candidate = (pageIndex + clusterSize + spillOffset) % pageCount;
		if (candidate !== pageIndex) {
			targets.add(candidate);
		}
		spillOffset += 1;
	}

	return [...targets];
}

/**
 * A cold build starts from nothing: a fresh docs tree per run, so neither the
 * content-index cache nor the graph's own module reuse can help.
 */
async function runColdBuilds(options: BenchmarkOptions): Promise<GraphBuildDiagnostics[]> {
	const diagnostics: GraphBuildDiagnostics[] = [];

	for (let iteration = 0; iteration < options.iterations; iteration += 1) {
		const fixture = await createSyntheticDocs(options);
		try {
			const result = await buildGraphModules(fixture.routes, {}, buildOptions(fixture.rootDir));
			diagnostics.push(result.diagnostics);
		} finally {
			await rm(fixture.rootDir, { recursive: true, force: true });
		}
	}

	return diagnostics;
}

async function runWarmBuilds(
	fixture: SyntheticDocsFixture,
	iterations: number,
): Promise<GraphBuildDiagnostics[]> {
	const state: GraphBuildState = {};
	await buildGraphModules(fixture.routes, state, buildOptions(fixture.rootDir));

	const diagnostics: GraphBuildDiagnostics[] = [];
	for (let iteration = 0; iteration < iterations; iteration += 1) {
		const result = await buildGraphModules(fixture.routes, state, buildOptions(fixture.rootDir));
		diagnostics.push(result.diagnostics);
	}

	return diagnostics;
}

async function runIncrementalBuilds(
	fixture: SyntheticDocsFixture,
	iterations: number,
	linksPerPage: number,
	shape: GraphShape,
	style: LinkStyle,
): Promise<GraphBuildDiagnostics[]> {
	const { routes } = fixture;
	const state: GraphBuildState = {};
	await buildGraphModules(routes, state, buildOptions(fixture.rootDir));

	const targetRoute = routes[Math.min(1, routes.length - 1)];
	if (!targetRoute) {
		throw new Error("No routes available for incremental build benchmark");
	}
	const targetPageIndex =
		targetRoute.routePath === "/" ? 0 : Number(targetRoute.routePath.slice(6));

	const diagnostics: GraphBuildDiagnostics[] = [];
	for (let iteration = 0; iteration < iterations; iteration += 1) {
		await sleep(20);
		await Bun.write(
			targetRoute.absolutePath,
			createSyntheticMarkdown(
				targetPageIndex,
				routes.length,
				linksPerPage,
				shape,
				iteration + 1,
				style,
			),
		);
		const result = await buildGraphModules(routes, state, buildOptions(fixture.rootDir));
		diagnostics.push(result.diagnostics);
	}

	return diagnostics;
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeDiagnostics(
	scenario: string,
	shape: GraphShape,
	diagnostics: GraphBuildDiagnostics[],
): BenchmarkSummary {
	const latest = diagnostics[diagnostics.length - 1];

	return {
		scenario,
		shape,
		avgTotalMs: average(diagnostics.map((entry) => entry.totalMs)),
		avgFilesRead: average(diagnostics.map((entry) => entry.filesRead)),
		avgResolvedLinks: average(diagnostics.map((entry) => entry.resolvedLinks)),
		// Share of runs where the whole module was reused (nothing changed).
		moduleReuseRate: average(diagnostics.map((entry) => (entry.reusedModule ? 1 : 0))) * 100,
		nodes: latest?.nodeCount ?? 0,
		links: latest?.linkCount ?? 0,
	};
}

function createReport(options: BenchmarkOptions, summaries: BenchmarkSummary[]): BenchmarkReport {
	const coldSummary = summaries.find((summary) => summary.scenario === "cold");
	const warmSummary = summaries.find((summary) => summary.scenario === "warm-cache");
	const incrementalSummary = summaries.find((summary) => summary.scenario === "single-file-change");

	return {
		generatedAt: new Date().toISOString(),
		options: {
			pages: options.pages,
			linksPerPage: options.linksPerPage,
			iterations: options.iterations,
			shape: options.shape,
		},
		summaries,
		improvements: {
			warmCacheVsCold: improvementRatio(coldSummary?.avgTotalMs ?? 0, warmSummary?.avgTotalMs ?? 0),
			singleFileChangeVsCold: improvementRatio(
				coldSummary?.avgTotalMs ?? 0,
				incrementalSummary?.avgTotalMs ?? 0,
			),
		},
	};
}

async function writeOptionalOutputs(
	options: BenchmarkOptions,
	report: BenchmarkReport,
): Promise<void> {
	if (options.jsonOutputPath) {
		await writeOutputFile(options.jsonOutputPath, `${JSON.stringify(report, null, 2)}\n`);
		console.log(`JSON report written to ${options.jsonOutputPath}`);
	}

	if (options.csvOutputPath) {
		await writeOutputFile(options.csvOutputPath, toCsv(report.summaries));
		console.log(`CSV report written to ${options.csvOutputPath}`);
	}
}

async function writeOutputFile(filePath: string, content: string): Promise<void> {
	await mkdir(dirname(filePath), { recursive: true });
	await Bun.write(filePath, content);
}

function toCsv(summaries: BenchmarkSummary[]): string {
	const header = [
		"scenario",
		"nodes",
		"links",
		"shape",
		"avgTotalMs",
		"avgFilesRead",
		"avgResolvedLinks",
		"moduleReuseRate",
	];

	const rows = summaries.map((summary) => [
		summary.scenario,
		summary.nodes,
		summary.links,
		summary.shape,
		summary.avgTotalMs.toFixed(3),
		summary.avgFilesRead.toFixed(3),
		summary.avgResolvedLinks.toFixed(3),
		summary.moduleReuseRate.toFixed(3),
	]);

	return `${[header, ...rows].map((row) => row.map(escapeCsvCell).join(",")).join("\n")}\n`;
}

function escapeCsvCell(value: string | number): string {
	const cell = String(value);
	if (!cell.includes(",") && !cell.includes('"') && !cell.includes("\n")) {
		return cell;
	}

	return `"${cell.split('"').join('""')}"`;
}

function average(values: number[]): number {
	if (values.length === 0) {
		return 0;
	}

	return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function toTableRow(summary: BenchmarkSummary): Record<string, string | number> {
	return {
		scenario: summary.scenario,
		shape: summary.shape,
		nodes: summary.nodes,
		links: summary.links,
		totalMs: formatMs(summary.avgTotalMs),
		filesRead: summary.avgFilesRead.toFixed(1),
		resolvedLinks: summary.avgResolvedLinks.toFixed(1),
		moduleReuseRate: `${summary.moduleReuseRate.toFixed(0)}%`,
	};
}

function formatMs(value: number): string {
	return `${value.toFixed(1)} ms`;
}

function improvementRatio(baselineMs: number, candidateMs: number): number {
	if (baselineMs <= 0) {
		return 0;
	}

	return (baselineMs - candidateMs) / baselineMs;
}

function formatPercent(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}
