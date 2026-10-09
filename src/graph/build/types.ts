import type { ContentIndex } from "../../markdown/types.js";
import type { GraphData } from "../types.js";
import type { PageTextCache } from "./page-content.js";

export interface CollectedRoute {
	routePath: string;
	absolutePath: string;
	relativePath: string;
	pageName: string;
}

export interface GraphBuildOptions {
	/** Rspress `root`, used when `markdown()` has not published its own roots. */
	docsRoot: string;
	/** Rspress `base` (`/…/`); attachment nodes need it. */
	base: string;
	profile?: boolean;
	logger?: (message: string) => void;
	/** What to do about a link that resolves to nothing. @default "warn" */
	onUnresolvedLink?: "error" | "warn" | "ignore";
}

export interface GraphBuildDiagnostics {
	routeCount: number;
	nodeCount: number;
	linkCount: number;
	/** Outlinks run through the resolver in this build (0 when the module was reused). */
	resolvedLinks: number;
	/** Files read in this build (0 when the module was reused). */
	filesRead: number;
	reusedModule: boolean;
	totalMs: number;
}

/** Virtual module id → module source. */
export type GraphModules = Record<string, string>;

export interface GraphBuildResult {
	graphData: GraphData;
	modules: GraphModules;
	diagnostics: GraphBuildDiagnostics;
}

/**
 * What a rebuild compares against to skip work. The content indexes are
 * compared by identity: `getCachedContentIndex` hands back the same object
 * until a routable file changes.
 */
export interface GraphBuildState {
	last?: {
		indexes: ContentIndex[];
		key: string;
		result: Omit<GraphBuildResult, "diagnostics">;
	};
	/** Each note's visible text by file, so a rebuild re-reads only edited notes. */
	texts?: PageTextCache;
}
