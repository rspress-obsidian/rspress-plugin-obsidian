import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import type { GraphViewGroup } from "../types.js";
import GraphFab from "./components/GraphFab.js";
import { LOCAL_STORAGE_KEY_OPEN, NARROW_VIEWPORT_QUERY } from "./graph-panel-storage.js";

// Lazy load heavy graph components
const GraphPanel = lazy(() => import("./GraphPanel.js"));

interface LazyGraphPanelProps {
	defaultOpen?: boolean;
	colors?: Record<string, string>;
	groups?: readonly GraphViewGroup[];
}

/** The FAB in its loading state: the panel's chunk is downloading. */
function GraphPanelFallback() {
	return <GraphFab label="Loading graph" loading />;
}

/**
 * Whether a `defaultOpen` panel actually mounts open, decided the way
 * GraphPanel's hydration effect decides it: the reader's stored choice wins,
 * and a phone keeps it closed. A panel that would mount closed shows only its
 * FAB, so downloading it for that would be wasted.
 */
function opensByDefault(): boolean {
	try {
		const stored = localStorage.getItem(LOCAL_STORAGE_KEY_OPEN);
		if (stored !== null) return stored === "true";
	} catch {
		// localStorage may be unavailable (private mode, storage disabled)
	}
	return !window.matchMedia?.(NARROW_VIEWPORT_QUERY).matches;
}

/**
 * The graph data and the force-graph renderer are heavy, so the panel only
 * loads once it is wanted: on mount on pages that open it by default (unless
 * the reader closed it before, or the screen is a phone's), otherwise on the
 * FAB click or the documented `g` shortcut — the panel's own key handler
 * cannot answer `g` until it is loaded.
 */
export default function LazyGraphPanel({ defaultOpen, colors, groups }: LazyGraphPanelProps) {
	// `undefined` while a `defaultOpen` panel is undecided: the answer depends on
	// localStorage and the viewport, which the server render cannot see.
	const [isPanelRequested, setIsPanelRequested] = useState<boolean | undefined>(
		defaultOpen ? undefined : false,
	);
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
		setIsPanelRequested((requested) => requested ?? opensByDefault());
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

	if (isPanelRequested === undefined) return <GraphPanelFallback />;

	if (!isPanelRequested) {
		return <GraphFab label="Open graph view" onClick={requestPanel} />;
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
