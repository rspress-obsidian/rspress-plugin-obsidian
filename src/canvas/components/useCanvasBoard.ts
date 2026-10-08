import { useEffect, useState } from "react";
import { parseCanvas } from "../parser.js";
import type { CanvasData } from "../types.js";
import { normalizeSiteBase, siteBase } from "../utils/base.js";

/**
 * The URL a published board's JSON is served from: `<base>__canvases__/<vault
 * path without .canvas>.json`, each segment percent-encoded so a board called
 * `My Board.canvas` or `Ünïcode.canvas` fetches the file the build wrote.
 */
export function resolveCanvasJsonUrl(src: string, basePath?: string): string {
	const segments = src
		.trim()
		.replace(/\\/g, "/")
		.replace(/\.canvas$/i, "")
		.replace(/\.json$/i, "")
		.split("/")
		.filter((segment) => segment && segment !== "." && segment !== "..")
		.map((segment) => encodeURIComponent(segment));
	const base = basePath === undefined ? siteBase() : normalizeSiteBase(basePath);
	return `${base}__canvases__/${segments.join("/")}.json`;
}

export type CanvasBoardState =
	| { status: "loading"; url: string }
	| { status: "error"; url: string; error: string }
	| { status: "loaded"; url: string; data: CanvasData };

/**
 * Fetch and parse a published board. The result is tagged with the URL it
 * belongs to, so a component switching boards never renders the previous
 * board's data under the new name.
 */
export function useCanvasBoard(src: string, basePath?: string): CanvasBoardState {
	const url = resolveCanvasJsonUrl(src, basePath);
	const [state, setState] = useState<CanvasBoardState>({ status: "loading", url });

	useEffect(() => {
		let cancelled = false;
		setState({ status: "loading", url });
		(async () => {
			try {
				const response = await fetch(url);
				if (!response.ok) throw new Error(`Canvas not found: ${src} (${response.status})`);
				const data = parseCanvas(await response.text(), { enriched: true });
				if (!cancelled) setState({ status: "loaded", url, data });
			} catch (error) {
				if (cancelled) return;
				console.error("[rspress-plugin-obsidian:canvas] Failed to load canvas:", error);
				setState({
					status: "error",
					url,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [url, src]);

	return state.url === url ? state : { status: "loading", url };
}
