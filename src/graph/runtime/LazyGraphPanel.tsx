import type { CSSProperties } from "react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { GraphViewGroup } from "../types.js";
import { LOCAL_STORAGE_KEY_OPEN } from "./graph-panel-storage.js";

// Lazy load heavy graph components
const GraphPanel = lazy(() => import("./GraphPanel.js"));

interface LazyGraphPanelProps {
	defaultOpen?: boolean;
	colors?: Record<string, string>;
	groups?: readonly GraphViewGroup[];
}

const FAB_STYLE: CSSProperties = {
	position: "fixed",
	bottom: 24,
	right: 24,
	zIndex: 9999,
	width: 48,
	height: 48,
	borderRadius: "50%",
	background: "linear-gradient(135deg, #3f3f3f 0%, #262626 50%, #3f3f3f 100%)",
	display: "flex",
	alignItems: "center",
	justifyContent: "center",
};

const GRAPH_GLYPH = (
	<>
		<circle cx="5" cy="6" r="2.5" />
		<circle cx="19" cy="6" r="2.5" />
		<circle cx="12" cy="18" r="2.5" />
		<line x1="7.5" y1="6" x2="16.5" y2="6" />
		<line x1="6.5" y1="8" x2="10.5" y2="16" />
		<line x1="17.5" y1="8" x2="13.5" y2="16" />
	</>
);

/** Shown while the heavy graph chunk downloads. */
function GraphPanelFallback() {
	return (
		<div style={FAB_STYLE}>
			<svg
				role="img"
				aria-label="Loading graph"
				width="20"
				height="20"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				style={{ color: "#fff", animation: "gv-fab-pulse 3s ease-in-out infinite" }}
			>
				<title>Loading graph</title>
				{GRAPH_GLYPH}
			</svg>
		</div>
	);
}

/**
 * The graph data and the force-graph renderer are heavy, so the panel only
 * loads once it is wanted: immediately on pages that open it by default,
 * otherwise on the FAB click or the documented `g` shortcut — the panel's own
 * key handler cannot answer `g` until it is loaded.
 */
export function LazyGraphPanel({ defaultOpen, colors, groups }: LazyGraphPanelProps) {
	const [isPanelRequested, setIsPanelRequested] = useState(defaultOpen ?? false);
	// The reader's own request (FAB or `g`): the button they activated unmounts
	// as the chunk loads, so the panel must take focus or it falls to <body>.
	const [readerRequested, setReaderRequested] = useState(false);

	const requestPanel = useCallback(() => {
		// GraphPanel's hydration effect lets a stored value override its
		// `defaultOpen` prop, so an explicit request has to be recorded first —
		// otherwise a visitor who closed the panel earlier would click the FAB
		// and get a panel that mounts closed.
		try {
			localStorage.setItem(LOCAL_STORAGE_KEY_OPEN, "true");
		} catch {
			// localStorage may be unavailable (private mode, SSR, storage disabled)
		}
		setReaderRequested(true);
		setIsPanelRequested(true);
	}, []);

	useEffect(() => {
		if (isPanelRequested) return;

		const handleKeyDown = (e: KeyboardEvent) => {
			const target = e.target as HTMLElement;
			const isEditable =
				target.tagName === "INPUT" ||
				target.tagName === "TEXTAREA" ||
				target.tagName === "SELECT" ||
				target.isContentEditable;
			if (e.key === "g" && !isEditable && !e.metaKey && !e.ctrlKey && !e.altKey) {
				requestPanel();
			}
		};

		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [isPanelRequested, requestPanel]);

	if (!isPanelRequested) {
		return (
			<button
				type="button"
				aria-label="Open graph view"
				onClick={requestPanel}
				style={{ ...FAB_STYLE, border: "none", padding: 0, cursor: "pointer" }}
			>
				<svg
					aria-hidden="true"
					width="20"
					height="20"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					style={{ color: "#fff" }}
				>
					{GRAPH_GLYPH}
				</svg>
			</button>
		);
	}

	return (
		<Suspense fallback={<GraphPanelFallback />}>
			<GraphPanel
				defaultOpen={isPanelRequested}
				readerRequested={readerRequested}
				colors={colors}
				groups={groups}
			/>
		</Suspense>
	);
}
export default LazyGraphPanel;
