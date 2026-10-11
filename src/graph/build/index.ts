import { performance } from "node:perf_hooks";
import { encodeGraphPayload, graphPayloadModuleSource } from "../graph-payload.js";
import { loadGraphDocuments, planGraphDocuments } from "./documents.js";
import { buildGraphData } from "./graph-builder.js";
import { collectPageTexts, searchModuleSource } from "./page-content.js";
import type {
	CollectedRoute,
	GraphBuildOptions,
	GraphBuildResult,
	GraphBuildState,
} from "./types.js";

export type {
	CollectedRoute,
	GraphBuildDiagnostics,
	GraphBuildOptions,
	GraphBuildResult,
	GraphBuildState,
	GraphModules,
} from "./types.js";

export const GRAPH_DATA_MODULE = "virtual-graph-data";
export const GRAPH_SEARCH_MODULE = "virtual-graph-search-data";

/**
 * Build the graph's virtual modules for the routes Rspress publishes.
 *
 * An unchanged site — same routes, same content-index objects, same untracked
 * files — reuses the previous modules without resolving a link or reading a
 * file, which is what a dev-server refresh relies on to stay cheap.
 */
export async function buildGraphModules(
	routes: CollectedRoute[],
	state: GraphBuildState,
	options: GraphBuildOptions,
): Promise<GraphBuildResult> {
	const totalStart = performance.now();
	const plan = await planGraphDocuments(routes, options.docsRoot);
	const key = JSON.stringify([
		routes.map((route) => [route.routePath, route.absolutePath]),
		plan.untrackedSignature,
		options.base,
		options.onUnresolvedLink ?? "warn",
	]);
	const last = state.last;
	if (
		last &&
		last.key === key &&
		last.indexes.length === plan.indexes.length &&
		last.indexes.every((index, position) => index === plan.indexes[position])
	) {
		const diagnostics = {
			routeCount: routes.length,
			nodeCount: last.result.graphData.nodes.length,
			linkCount: last.result.graphData.links.length,
			resolvedLinks: 0,
			filesRead: 0,
			reusedModule: true,
			totalMs: performance.now() - totalStart,
		};
		logBuild(diagnostics, options);
		return { ...last.result, diagnostics };
	}

	const { documents, filesRead: documentReads } = await loadGraphDocuments(plan);
	const { graph, unresolved, resolvedLinks } = buildGraphData(documents);
	reportUnresolved(unresolved, options.onUnresolvedLink ?? "warn");
	state.texts ??= new Map();
	const texts = await collectPageTexts(documents, state.texts);

	const modules: Record<string, string> = {
		[GRAPH_DATA_MODULE]: graphPayloadModuleSource(encodeGraphPayload(graph, options.base)),
		[GRAPH_SEARCH_MODULE]: searchModuleSource(texts.search),
	};

	const result = { graphData: graph, modules };
	state.last = { indexes: plan.indexes, key, result };
	const diagnostics = {
		routeCount: routes.length,
		nodeCount: graph.nodes.length,
		linkCount: graph.links.length,
		resolvedLinks,
		filesRead: documentReads + texts.filesRead,
		reusedModule: false,
		totalMs: performance.now() - totalStart,
	};
	logBuild(diagnostics, options);
	return { ...result, diagnostics };
}

function reportUnresolved(
	unresolved: Map<string, Set<string>>,
	mode: "error" | "warn" | "ignore",
): void {
	if (unresolved.size === 0 || mode === "ignore") return;
	const lines: string[] = [];
	for (const [source, targets] of unresolved) {
		for (const target of targets) lines.push(`  ${source} -> ${target}`);
	}
	// The markdown plugin reports the same links through `onBrokenLink` on the
	// pages themselves; a site that already hears about them there can set
	// `onUnresolvedLink: "ignore"`.
	const message = `[rspress-plugin-obsidian:graph] ${unresolved.size} page(s) reference ${lines.length} unresolved internal link(s):\n${lines.join("\n")}`;
	if (mode === "error") throw new Error(message);
	console.warn(message);
}

function logBuild(diagnostics: GraphBuildResult["diagnostics"], options: GraphBuildOptions): void {
	if (!options.profile) return;
	(options.logger ?? console.info)(
		[
			"[rspress-plugin-obsidian:graph] graph build",
			`routes=${diagnostics.routeCount}`,
			`nodes=${diagnostics.nodeCount}`,
			`links=${diagnostics.linkCount}`,
			`resolvedLinks=${diagnostics.resolvedLinks}`,
			`filesRead=${diagnostics.filesRead}`,
			`reusedModule=${diagnostics.reusedModule}`,
			`total=${diagnostics.totalMs.toFixed(1)}ms`,
		].join(" | "),
	);
}
