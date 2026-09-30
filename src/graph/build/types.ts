import type { GraphData } from "../types.js";

export interface CollectedRoute {
	routePath: string;
	absolutePath: string;
	relativePath: string;
	pageName: string;
}

export interface GraphBuildOptions {
	profile?: boolean;
	logger?: (message: string) => void;
	/** What to do about a link that resolves to no route. @default "warn" */
	onUnresolvedLink?: "error" | "warn" | "ignore";
}

export interface GraphBuildDiagnostics {
	routeCount: number;
	linkCount: number;
	cacheHits: number;
	cacheMisses: number;
	reusedModule: boolean;
	totalMs: number;
	statMs: number;
	parseMs: number;
	resolveMs: number;
	serializeMs: number;
}

export interface GraphBuildResult {
	graphData: GraphData;
	moduleSource: string;
	diagnostics: GraphBuildDiagnostics;
}
