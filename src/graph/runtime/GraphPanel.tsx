import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "../../shared/usePathname.js";
import type { GraphViewGroup } from "../types.js";
import GraphIcon from "./components/GraphIcon.js";
import ZoomButton from "./components/ZoomButton.js";
import { DEFAULT_GRAPH_FILTERS, MAX_DEPTH } from "./deriveGraphViewData.js";
import GraphSettings, { type GraphFilterSettings } from "./GraphSettings.js";
import GraphView, {
	type GraphViewColors,
	type GraphViewHandle,
	type GraphViewStats,
} from "./GraphView.js";
import {
	LOCAL_STORAGE_KEY_DISPLAY,
	LOCAL_STORAGE_KEY_FILTERS,
	LOCAL_STORAGE_KEY_FORCES,
	LOCAL_STORAGE_KEY_OPEN,
	LOCAL_STORAGE_KEY_POS,
} from "./graph-panel-storage.js";
import { parseGraphQuery } from "./graph-query.js";
import { loadGraphSearchText } from "./graph-search-data.js";
import {
	DEFAULT_DISPLAY_SETTINGS,
	DEFAULT_FORCE_SETTINGS,
	type GraphDisplaySettings,
	type GraphForceSettings,
	readDisplaySettings,
	readForceSettings,
} from "./graph-settings.js";

interface GraphPanelProps {
	defaultOpen?: boolean;
	/**
	 * The reader asked for the panel (FAB click or `g`) before this chunk
	 * loaded. The panel then takes focus on open, as it does when opened after
	 * loading; a `defaultOpen` panel leaves focus alone.
	 */
	readerRequested?: boolean;
	colors?: GraphViewColors;
	groups?: readonly GraphViewGroup[];
}

const STYLE_ID = "graph-panel-keyframes";
const PANEL_ID = "rspress-graph-view-panel";
const PANEL_TITLE_ID = "rspress-graph-view-title";
const GRAPH_REGION_ID = "rspress-graph-view-region";
const SYSTEM_FONT = "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
/** Secondary text: `--rp-c-text-2` is ≥ 4.5:1 on Rspress's light and dark backgrounds. */
const SECONDARY_TEXT = "var(--rp-c-text-2, #475569)";

const DEFAULT_FILTER_SETTINGS: GraphFilterSettings = {
	scope: DEFAULT_GRAPH_FILTERS.scope,
	depth: DEFAULT_GRAPH_FILTERS.depth,
	incoming: DEFAULT_GRAPH_FILTERS.incoming,
	outgoing: DEFAULT_GRAPH_FILTERS.outgoing,
	neighborLinks: DEFAULT_GRAPH_FILTERS.neighborLinks,
	showTags: DEFAULT_GRAPH_FILTERS.showTags,
	showAttachments: DEFAULT_GRAPH_FILTERS.showAttachments,
	existingOnly: DEFAULT_GRAPH_FILTERS.existingOnly,
	showOrphans: DEFAULT_GRAPH_FILTERS.showOrphans,
};

/** Stored filter toggles, each validated; unknown or malformed fields keep their default. */
function readFilterSettings(value: unknown): GraphFilterSettings {
	const stored: Record<string, unknown> = value && typeof value === "object" ? { ...value } : {};
	const flag = (key: keyof GraphFilterSettings) => {
		const raw = stored[key];
		return typeof raw === "boolean" ? raw : (DEFAULT_FILTER_SETTINGS[key] as boolean);
	};
	return {
		scope: stored.scope === "global" ? "global" : "local",
		depth:
			typeof stored.depth === "number" && Number.isFinite(stored.depth)
				? Math.min(MAX_DEPTH, Math.max(1, Math.round(stored.depth)))
				: DEFAULT_FILTER_SETTINGS.depth,
		incoming: flag("incoming"),
		outgoing: flag("outgoing"),
		neighborLinks: flag("neighborLinks"),
		showTags: flag("showTags"),
		showAttachments: flag("showAttachments"),
		existingOnly: flag("existingOnly"),
		showOrphans: flag("showOrphans"),
	};
}

function readStoredJson(key: string): unknown {
	const raw = localStorage.getItem(key);
	return raw ? JSON.parse(raw) : undefined;
}

function injectKeyframes() {
	if (typeof document === "undefined") return;
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = `
    @keyframes gv-fab-pulse {
      0%, 100% { box-shadow: 0 2px 16px rgba(99,102,241,0.35), 0 0 0 0 rgba(99,102,241,0.3); }
      50% { box-shadow: 0 4px 20px rgba(99,102,241,0.5), 0 0 0 6px rgba(99,102,241,0); }
    }
    @keyframes gv-panel-enter {
      from { opacity: 0; transform: scale(0.92) translateY(8px); }
      to { opacity: 1; transform: scale(1) translateY(0); }
    }
    @keyframes gv-fab-spin-in {
      from { transform: rotate(-90deg) scale(0.8); opacity: 0; }
      to { transform: rotate(0deg) scale(1); opacity: 1; }
    }
    @keyframes gv-accent-shimmer {
      0% { background-position: -200% 0; }
      100% { background-position: 200% 0; }
    }
    @keyframes gv-spinner {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
    @keyframes gv-tooltip-in {
      from { opacity: 0; transform: translateY(3px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `;
	document.head.appendChild(style);
}

/** Screens too narrow for the floating panel to sit beside the article. */
const NARROW_VIEWPORT_QUERY = "(max-width: 639px)";

export default function GraphPanel({
	defaultOpen = false,
	readerRequested = false,
	colors,
	groups,
}: GraphPanelProps) {
	const pathname = usePathname();
	const [isHydrated, setIsHydrated] = useState(false);
	const [isOpen, setIsOpen] = useState(defaultOpen);
	const [pos, setPos] = useState({ x: 0, y: 0 });
	const [isFullscreen, setIsFullscreen] = useState(false);
	const [windowSize, setWindowSize] = useState({ width: 1000, height: 800 });
	const [panelSize, setPanelSize] = useState({ width: 320, height: 252 });
	const [panelVisible, setPanelVisible] = useState(false);
	const [stats, setStats] = useState<GraphViewStats | null>(null);
	const [filtersOpen, setFiltersOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [filterSettings, setFilterSettings] = useState(DEFAULT_FILTER_SETTINGS);
	const [display, setDisplay] = useState<GraphDisplaySettings>(DEFAULT_DISPLAY_SETTINGS);
	const [forces, setForces] = useState<GraphForceSettings>(DEFAULT_FORCE_SETTINGS);
	const [searchText, setSearchText] = useState<ReadonlyMap<string, string>>();
	const [timelapseRun, setTimelapseRun] = useState(0);
	const [isAnimating, setIsAnimating] = useState(false);
	const panelRef = useRef<HTMLDivElement>(null);
	const wrapperRef = useRef<HTMLDivElement>(null);
	const graphViewRef = useRef<GraphViewHandle>(null);
	const fabRef = useRef<HTMLButtonElement>(null);
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	// True when the reader opened the panel themselves. Only then does the panel
	// take focus on open, and only then does closing it hand focus back to the FAB:
	// a `defaultOpen` panel must not move focus the reader never asked it to move.
	const readerOpenedRef = useRef(readerRequested);

	const isDragging = useRef(false);
	const dragStart = useRef({ x: 0, y: 0, posX: 0, posY: 0 });

	useEffect(() => {
		setIsHydrated(true);
		try {
			const storedOpen = localStorage.getItem(LOCAL_STORAGE_KEY_OPEN);
			if (storedOpen !== null) setIsOpen(storedOpen === "true");
			// On a phone the open panel covers about half the article, so
			// `defaultOpen` does not apply there; the reader opens it from the FAB
			// or `g`, and that choice is remembered as on any screen.
			else if (!readerOpenedRef.current && window.matchMedia?.(NARROW_VIEWPORT_QUERY).matches) {
				setIsOpen(false);
			}

			const storedPos = localStorage.getItem(LOCAL_STORAGE_KEY_POS);
			if (storedPos) setPos(JSON.parse(storedPos));

			setFilterSettings(readFilterSettings(readStoredJson(LOCAL_STORAGE_KEY_FILTERS)));
			setDisplay(readDisplaySettings(readStoredJson(LOCAL_STORAGE_KEY_DISPLAY)));
			setForces(readForceSettings(readStoredJson(LOCAL_STORAGE_KEY_FORCES)));
		} catch {
			// localStorage may be unavailable (private mode, SSR, storage disabled)
		}
	}, []);

	useEffect(() => {
		if (!isHydrated) return;
		setPanelVisible(isOpen);
	}, [isHydrated, isOpen]);

	useEffect(() => {
		if (!isHydrated) return;
		try {
			localStorage.setItem(LOCAL_STORAGE_KEY_OPEN, String(isOpen));
			localStorage.setItem(LOCAL_STORAGE_KEY_POS, JSON.stringify(pos));
			localStorage.setItem(LOCAL_STORAGE_KEY_FILTERS, JSON.stringify(filterSettings));
			localStorage.setItem(LOCAL_STORAGE_KEY_DISPLAY, JSON.stringify(display));
			localStorage.setItem(LOCAL_STORAGE_KEY_FORCES, JSON.stringify(forces));
		} catch {
			// localStorage may be unavailable (private mode, SSR, storage disabled)
		}
	}, [isOpen, pos, filterSettings, display, forces, isHydrated]);

	// Note text loads only once a query (or a colour group) reads it.
	const needsSearchText = useMemo(
		() =>
			parseGraphQuery(query).needsText ||
			(groups ?? []).some((group) => parseGraphQuery(group.query).needsText),
		[query, groups],
	);
	useEffect(() => {
		if (!needsSearchText || searchText) return;
		let active = true;
		loadGraphSearchText()
			.then((text) => {
				if (active) setSearchText(text);
			})
			.catch(() => {
				// Without the text, text terms keep matching names and paths only.
			});
		return () => {
			active = false;
		};
	}, [needsSearchText, searchText]);

	const handlePointerDown = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			if (e.button !== 0) return;
			if ((e.target as HTMLElement).closest("button")) return;
			if (isFullscreen) return;

			isDragging.current = true;
			dragStart.current = { x: e.clientX, y: e.clientY, posX: pos.x, posY: pos.y };
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
			e.currentTarget.style.cursor = "grabbing";
		},
		[pos, isFullscreen],
	);

	const handlePointerMove = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			if (!isDragging.current || isFullscreen) return;
			const dx = e.clientX - dragStart.current.x;
			const dy = e.clientY - dragStart.current.y;
			if (wrapperRef.current) {
				wrapperRef.current.style.transform = `translate(${dragStart.current.posX + dx}px, ${dragStart.current.posY + dy}px)`;
				wrapperRef.current.style.transition = "none";
			}
		},
		[isFullscreen],
	);

	const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
		if (!isDragging.current) return;
		isDragging.current = false;
		const dx = e.clientX - dragStart.current.x;
		const dy = e.clientY - dragStart.current.y;
		setPos({ x: dragStart.current.posX + dx, y: dragStart.current.posY + dy });
		if (wrapperRef.current) {
			wrapperRef.current.style.transition =
				"bottom 0.4s cubic-bezier(0.25, 1, 0.5, 1), right 0.4s cubic-bezier(0.25, 1, 0.5, 1), width 0.4s cubic-bezier(0.25, 1, 0.5, 1), height 0.4s cubic-bezier(0.25, 1, 0.5, 1), transform 0.4s cubic-bezier(0.25, 1, 0.5, 1)";
		}
		(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
		e.currentTarget.style.cursor = "grab";
	}, []);

	useEffect(() => {
		injectKeyframes();
	}, []);

	useEffect(() => {
		const updateSize = () => {
			setWindowSize({ width: window.innerWidth, height: window.innerHeight });
			const w = Math.min(400, Math.max(280, window.innerWidth * 0.36));
			const h = Math.min(312, Math.max(220, window.innerHeight * 0.36));
			setPanelSize({ width: w, height: h });
		};
		updateSize();
		window.addEventListener("resize", updateSize);
		return () => window.removeEventListener("resize", updateSize);
	}, []);

	useEffect(() => {
		if (!isOpen) {
			readerOpenedRef.current = false;
			return;
		}
		const timer = setTimeout(() => {
			const s = graphViewRef.current?.getStats();
			if (s) setStats(s);
			// `defaultOpen` panels mount already open, and focusing 150ms later pulled
			// focus out of whatever the reader had focused in the meantime — a canvas
			// help dialog, for one.
			if (readerOpenedRef.current) {
				closeButtonRef.current?.focus();
			}
		}, 150);
		return () => clearTimeout(timer);
	}, [isOpen]);

	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			const focusInPanel =
				panelRef.current?.contains(document.activeElement) === true ||
				document.activeElement === fabRef.current;

			// Escape belongs to whatever has focus: the panel answers it only when
			// focus is in the panel (or on the FAB that controls it), so it cannot
			// steal Escape from the search modal or another widget.
			if (e.key === "Escape" && isOpen && focusInPanel) {
				// A non-empty search clears first — a filter bar you cannot
				// backspace out of with Escape is a trap — and only the next
				// Escape closes the panel.
				e.preventDefault();
				if (query) {
					setQuery("");
					return;
				}
				// A panel the reader opened hands focus back to the FAB; an auto-opened
				// one leaves focus wherever it is (another plugin's dialog, say).
				const readerOpened = readerOpenedRef.current;
				setIsOpen(false);
				setIsFullscreen(false);
				if (readerOpened || panelRef.current?.contains(document.activeElement)) {
					fabRef.current?.focus();
				}
				return;
			}

			// Only the fullscreen view is modal; the floating panel lets Tab move on
			// to the page like any other non-modal dialog.
			if (e.key === "Tab" && isOpen && isFullscreen && panelRef.current) {
				const focusableElements = panelRef.current.querySelectorAll<HTMLElement>(
					"button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
				);
				const firstElement = focusableElements[0];
				const lastElement = focusableElements[focusableElements.length - 1];

				if (firstElement && lastElement) {
					if (e.shiftKey && document.activeElement === firstElement) {
						e.preventDefault();
						lastElement.focus();
						return;
					}

					if (!e.shiftKey && document.activeElement === lastElement) {
						e.preventDefault();
						firstElement.focus();
						return;
					}
				}
			}

			const target = e.target as HTMLElement;
			const isEditable =
				target.tagName === "INPUT" ||
				target.tagName === "TEXTAREA" ||
				target.tagName === "SELECT" ||
				target.isContentEditable;
			if (e.key === "g" && !isEditable && !e.metaKey && !e.ctrlKey && !e.altKey) {
				e.preventDefault();
				// Two separate setters, not a setState updater with a side effect:
				// updaters must stay pure or a double-invoked render toggles twice.
				readerOpenedRef.current = true;
				setIsOpen((prev) => !prev);
				setIsFullscreen(false);
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [isOpen, isFullscreen, query]);

	// Stable identity: GraphView re-derives only when a filter value changes,
	// not on every panel re-render (position drags, stats ticks).
	const filters = useMemo(() => ({ ...filterSettings, query }), [filterSettings, query]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: stats track route, filter and data changes; graphViewRef is stable
	useEffect(() => {
		const s = graphViewRef.current?.getStats();
		if (s) setStats(s);
	}, [pathname, filters, searchText]);

	const handleToggle = useCallback(() => {
		readerOpenedRef.current = true;
		setIsOpen((prev) => !prev);
		setIsFullscreen(false);
	}, []);

	const handleClose = useCallback(() => {
		setIsOpen(false);
		setIsFullscreen(false);
		fabRef.current?.focus();
	}, []);

	const handleAnimate = useCallback(() => {
		setIsAnimating(true);
		setTimelapseRun((run) => run + 1);
	}, []);
	const handleAnimateEnd = useCallback(() => setIsAnimating(false), []);

	const handleReset = useCallback(() => {
		setFilterSettings(DEFAULT_FILTER_SETTINGS);
		setDisplay(DEFAULT_DISPLAY_SETTINGS);
		setForces(DEFAULT_FORCE_SETTINGS);
	}, []);

	const FOOTER_HEIGHT = 22;
	const HEADER_HEIGHT = 34;
	const FILTER_BAR_HEIGHT = 32;
	const actualWidth = isFullscreen ? windowSize.width : panelSize.width;
	const actualHeight = isFullscreen ? windowSize.height : panelSize.height;

	const neighborsShown =
		stats && stats.neighborCount < stats.neighborTotal
			? `${stats.neighborCount} of ${stats.neighborTotal} neighbors`
			: null;
	// The render cap keeps d3-force usable; say how many nodes it left out
	// rather than presenting a partial graph as the whole one.
	const truncationShown =
		stats && stats.truncatedCount > 0 ? `${stats.truncatedCount} more not drawn` : null;
	const graphHeight =
		actualHeight - HEADER_HEIGHT - FOOTER_HEIGHT - (filtersOpen ? FILTER_BAR_HEIGHT : 0);

	return (
		<>
			<button
				ref={fabRef}
				type="button"
				onClick={handleToggle}
				aria-controls={PANEL_ID}
				aria-expanded={isOpen}
				// Fullscreen only fades the FAB out; without this it stays in the tab
				// order and is announced while invisible.
				aria-hidden={isFullscreen}
				tabIndex={isFullscreen ? -1 : 0}
				style={{
					position: "fixed",
					bottom: 24,
					right: 24,
					zIndex: 9999,
					width: 48,
					height: 48,
					borderRadius: "50%",
					border: "none",
					background: "linear-gradient(135deg, #3f3f3f 0%, #262626 50%, #3f3f3f 100%)",
					color: "#fff",
					cursor: isFullscreen ? "default" : "pointer",
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					opacity: isFullscreen ? 0 : 1,
					pointerEvents: isFullscreen ? "none" : "auto",
					animation: isFullscreen ? "none" : "gv-fab-pulse 3s ease-in-out infinite",
					transition: "transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.2s ease",
				}}
				onMouseEnter={(e) => {
					if (isFullscreen) return;
					e.currentTarget.style.transform = "scale(1.12)";
					e.currentTarget.style.animationPlayState = "paused";
				}}
				onMouseLeave={(e) => {
					if (isFullscreen) return;
					e.currentTarget.style.transform = "scale(1)";
					e.currentTarget.style.animationPlayState = "running";
				}}
				aria-label={isOpen ? "Close graph view" : "Open graph view"}
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
					style={{
						animation: isOpen ? "none" : "gv-fab-spin-in 0.4s ease-out",
						filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.2))",
					}}
				>
					{isOpen ? (
						<>
							<line x1="18" y1="6" x2="6" y2="18" />
							<line x1="6" y1="6" x2="18" y2="18" />
						</>
					) : (
						<>
							<circle cx="5" cy="6" r="2.5" />
							<circle cx="19" cy="6" r="2.5" />
							<circle cx="12" cy="18" r="2.5" />
							<line x1="7.5" y1="6" x2="16.5" y2="6" />
							<line x1="6.5" y1="8" x2="10.5" y2="16" />
							<line x1="17.5" y1="8" x2="13.5" y2="16" />
						</>
					)}
				</svg>
			</button>

			<div
				ref={wrapperRef}
				style={{
					position: "fixed",
					bottom: isFullscreen ? 0 : 80,
					right: isFullscreen ? 0 : 24,
					zIndex: 9998,
					transform: isFullscreen ? "translate(0px, 0px)" : `translate(${pos.x}px, ${pos.y}px)`,
					width: actualWidth,
					height: actualHeight,
					transition:
						"bottom 0.4s cubic-bezier(0.25, 1, 0.5, 1), right 0.4s cubic-bezier(0.25, 1, 0.5, 1), width 0.4s cubic-bezier(0.25, 1, 0.5, 1), height 0.4s cubic-bezier(0.25, 1, 0.5, 1), transform 0.4s cubic-bezier(0.25, 1, 0.5, 1)",
					pointerEvents: panelVisible ? "auto" : "none",
				}}
			>
				{panelVisible && (
					<div
						id={PANEL_ID}
						ref={panelRef}
						role="dialog"
						aria-modal={isFullscreen ? "true" : "false"}
						aria-labelledby={PANEL_TITLE_ID}
						aria-describedby={GRAPH_REGION_ID}
						style={{
							position: "relative",
							width: "100%",
							height: "100%",
							borderRadius: isFullscreen ? 0 : 16,
							overflow: "hidden",
							background: isFullscreen
								? "var(--rp-c-bg, #ffffff)"
								: "color-mix(in srgb, var(--rp-c-bg, #ffffff) 78%, transparent)",
							backdropFilter: isFullscreen ? "none" : "blur(20px) saturate(1.5)",
							WebkitBackdropFilter: isFullscreen ? "none" : "blur(20px) saturate(1.5)",
							border: isFullscreen
								? "none"
								: "1px solid color-mix(in srgb, var(--rp-c-divider, #e2e8f0) 60%, transparent)",
							boxShadow: isFullscreen
								? "none"
								: [
										"0 12px 40px rgba(0,0,0,0.14)",
										"0 4px 12px rgba(0,0,0,0.06)",
										"inset 0 1px 0 rgba(255,255,255,0.12)",
									].join(", "),
							animation: isOpen
								? "gv-panel-enter 0.28s cubic-bezier(0.34, 1.56, 0.64, 1) forwards"
								: "none",
							opacity: isOpen ? 1 : 0,
							transform: isOpen ? "scale(1) translateY(0)" : "scale(0.92) translateY(8px)",
							transition: isOpen ? "none" : "opacity 0.2s ease, transform 0.2s ease",
							display: "flex",
							flexDirection: "column",
						}}
					>
						<div
							style={{
								position: "absolute",
								top: 0,
								left: 0,
								right: 0,
								height: 2,
								background:
									"linear-gradient(90deg, transparent, #8f8f8f, #d0d0d0, #8f8f8f, transparent)",
								backgroundSize: "200% 100%",
								animation: "gv-accent-shimmer 4s linear infinite",
								zIndex: 2,
							}}
						/>

						<div
							onPointerDown={handlePointerDown}
							onPointerMove={handlePointerMove}
							onPointerUp={handlePointerUp}
							onPointerCancel={handlePointerUp}
							style={{
								display: "flex",
								alignItems: "center",
								justifyContent: "space-between",
								height: HEADER_HEIGHT,
								padding: "0 8px 0 10px",
								borderBottom:
									"1px solid color-mix(in srgb, var(--rp-c-divider, #e2e8f0) 40%, transparent)",
								background: "color-mix(in srgb, var(--rp-c-bg, #ffffff) 50%, transparent)",
								position: "relative",
								zIndex: 1,
								flexShrink: 0,
								cursor: isFullscreen ? "default" : "grab",
								touchAction: isFullscreen ? "auto" : "none",
							}}
						>
							<div
								style={{
									display: "flex",
									alignItems: "center",
									gap: 6,
									color: "var(--rp-c-text-1, #1f2937)",
									userSelect: "none",
								}}
							>
								<GraphIcon size={13} />
								<span
									id={PANEL_TITLE_ID}
									style={{
										fontSize: 11,
										fontWeight: 600,
										fontFamily: SYSTEM_FONT,
										letterSpacing: "0.05em",
										textTransform: "uppercase",
										whiteSpace: "nowrap",
									}}
								>
									Graph View
								</span>
							</div>

							<div style={{ display: "flex", alignItems: "center", gap: 4 }}>
								<div
									style={{
										display: "flex",
										alignItems: "center",
										gap: 1,
										background: "color-mix(in srgb, var(--rp-c-divider, #e2e8f0) 35%, transparent)",
										borderRadius: 7,
										padding: "1px 2px",
										border:
											"1px solid color-mix(in srgb, var(--rp-c-divider, #e2e8f0) 50%, transparent)",
									}}
								>
									<ZoomButton ariaLabel="Zoom in" onClick={() => graphViewRef.current?.zoomIn()}>
										<svg
											aria-hidden="true"
											width="12"
											height="12"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2.5"
											strokeLinecap="round"
										>
											<line x1="12" y1="5" x2="12" y2="19" />
											<line x1="5" y1="12" x2="19" y2="12" />
										</svg>
									</ZoomButton>
									<ZoomButton ariaLabel="Zoom out" onClick={() => graphViewRef.current?.zoomOut()}>
										<svg
											aria-hidden="true"
											width="12"
											height="12"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2.5"
											strokeLinecap="round"
										>
											<line x1="5" y1="12" x2="19" y2="12" />
										</svg>
									</ZoomButton>
									<ZoomButton
										ariaLabel={isFullscreen ? "Restore" : "Maximize"}
										onClick={() => setIsFullscreen(!isFullscreen)}
									>
										{isFullscreen ? (
											<svg
												aria-hidden="true"
												width="12"
												height="12"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											>
												<path d="M8 3v3a2 2 0 0 1-2 2H3" />
												<path d="M21 8h-3a2 2 0 0 1-2-2V3" />
												<path d="M3 16h3a2 2 0 0 1 2 2v3" />
												<path d="M16 21v-3a2 2 0 0 1 2-2h3" />
											</svg>
										) : (
											<svg
												aria-hidden="true"
												width="12"
												height="12"
												viewBox="0 0 24 24"
												fill="none"
												stroke="currentColor"
												strokeWidth="2"
												strokeLinecap="round"
												strokeLinejoin="round"
											>
												<path d="M8 3H5a2 2 0 0 0-2 2v3" />
												<path d="M21 8V5a2 2 0 0 0-2-2h-3" />
												<path d="M3 16v3a2 2 0 0 0 2 2h3" />
												<path d="M16 21h3a2 2 0 0 0 2-2v-3" />
											</svg>
										)}
									</ZoomButton>
									<ZoomButton
										ariaLabel="Reset zoom"
										onClick={() => graphViewRef.current?.zoomReset()}
									>
										<svg
											aria-hidden="true"
											width="12"
											height="12"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2"
											strokeLinecap="round"
											strokeLinejoin="round"
										>
											<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
											<path d="M3 3v5h5" />
										</svg>
									</ZoomButton>
									<ZoomButton
										ariaLabel={filtersOpen ? "Hide graph filters" : "Show graph filters"}
										ariaExpanded={filtersOpen}
										onClick={() => setFiltersOpen((open) => !open)}
									>
										<svg
											aria-hidden="true"
											width="12"
											height="12"
											viewBox="0 0 24 24"
											fill="none"
											stroke="currentColor"
											strokeWidth="2"
											strokeLinecap="round"
											strokeLinejoin="round"
										>
											<path d="M4 5h16l-6.5 7.5V19l-3 1.5v-8L4 5z" />
										</svg>
									</ZoomButton>
								</div>

								<div
									style={{
										width: 1,
										height: 16,
										background: "color-mix(in srgb, var(--rp-c-divider, #e2e8f0) 60%, transparent)",
										margin: "0 2px",
									}}
								/>

								<button
									ref={closeButtonRef}
									type="button"
									onClick={handleClose}
									style={{
										width: 24,
										height: 24,
										borderRadius: 6,
										border: "none",
										background: "transparent",
										color: SECONDARY_TEXT,
										cursor: "pointer",
										display: "flex",
										alignItems: "center",
										justifyContent: "center",
										padding: 0,
										transition: "background 0.12s, color 0.12s",
									}}
									onMouseEnter={(e) => {
										e.currentTarget.style.background =
											"color-mix(in srgb, #ef4444 10%, transparent)";
										e.currentTarget.style.color = "#b91c1c";
									}}
									onMouseLeave={(e) => {
										e.currentTarget.style.background = "transparent";
										e.currentTarget.style.color = SECONDARY_TEXT;
									}}
									aria-label="Close graph view"
								>
									<svg
										aria-hidden="true"
										width="12"
										height="12"
										viewBox="0 0 12 12"
										fill="none"
										stroke="currentColor"
										strokeWidth="1.8"
										strokeLinecap="round"
									>
										<line x1="2" y1="2" x2="10" y2="10" />
										<line x1="10" y1="2" x2="2" y2="10" />
									</svg>
								</button>
							</div>
						</div>

						{filtersOpen && (
							<div
								style={{
									display: "flex",
									alignItems: "center",
									gap: 6,
									padding: "5px 8px",
									height: FILTER_BAR_HEIGHT,
									boxSizing: "border-box",
									borderBottom:
										"1px solid color-mix(in srgb, var(--rp-c-divider, #e2e8f0) 40%, transparent)",
									background: "color-mix(in srgb, var(--rp-c-bg, #ffffff) 45%, transparent)",
									flexShrink: 0,
								}}
							>
								<input
									type="search"
									value={query}
									onChange={(event) => setQuery(event.target.value)}
									placeholder="Search… (path:, tag:, content:, OR, /re/)"
									aria-label="Filter graph nodes"
									style={{
										flex: 1,
										minWidth: 0,
										fontSize: 11,
										padding: "3px 6px",
										borderRadius: 6,
										border:
											"1px solid color-mix(in srgb, var(--rp-c-divider, #e2e8f0) 60%, transparent)",
										background: "color-mix(in srgb, var(--rp-c-bg, #ffffff) 70%, transparent)",
										color: "var(--rp-c-text-1, #1f2937)",
										fontFamily: SYSTEM_FONT,
										outline: "none",
									}}
								/>
							</div>
						)}

						<div
							id={GRAPH_REGION_ID}
							role="group"
							aria-label={
								stats
									? `Graph view showing ${stats.nodes} ${stats.nodes === 1 ? "node" : "nodes"} and ${stats.links} ${stats.links === 1 ? "link" : "links"}${neighborsShown ? ` (${neighborsShown})` : ""}${truncationShown ? ` (${truncationShown})` : ""}. The pages are listed as links after the graph.`
									: "Interactive documentation graph loading."
							}
							style={{ position: "relative", width: "100%", flex: 1, overflow: "hidden" }}
						>
							<GraphView
								ref={graphViewRef}
								width={actualWidth}
								height={graphHeight}
								colors={colors}
								filters={filters}
								groups={groups}
								display={display}
								forces={forces}
								searchText={searchText}
								timelapseRun={timelapseRun}
								onTimelapseEnd={handleAnimateEnd}
							/>

							{filtersOpen && (
								<section
									aria-label="Graph settings"
									style={{
										position: "absolute",
										top: 0,
										right: 0,
										bottom: 0,
										width: Math.min(220, actualWidth - 16),
										overflowY: "auto",
										padding: "4px 10px 10px",
										boxSizing: "border-box",
										background: "color-mix(in srgb, var(--rp-c-bg, #ffffff) 94%, transparent)",
										borderLeft: "1px solid var(--rp-c-divider, #e2e8f0)",
										zIndex: 4,
									}}
								>
									<GraphSettings
										filters={filterSettings}
										onFiltersChange={setFilterSettings}
										display={display}
										onDisplayChange={setDisplay}
										forces={forces}
										onForcesChange={setForces}
										onAnimate={handleAnimate}
										isAnimating={isAnimating}
										onReset={handleReset}
									/>
								</section>
							)}
						</div>

						<div
							style={{
								height: FOOTER_HEIGHT,
								display: "flex",
								alignItems: "center",
								padding: "0 12px",
								borderTop:
									"1px solid color-mix(in srgb, var(--rp-c-divider, #e2e8f0) 35%, transparent)",
								background: "color-mix(in srgb, var(--rp-c-bg, #ffffff) 40%, transparent)",
								flexShrink: 0,
								gap: 4,
								fontSize: 10,
								fontFamily: SYSTEM_FONT,
								color: SECONDARY_TEXT,
								userSelect: "none",
							}}
						>
							{stats ? (
								<span aria-live="polite" style={{ letterSpacing: "0.02em" }}>
									{stats.nodes} {stats.nodes === 1 ? "node" : "nodes"}
									{" · "}
									{stats.links} {stats.links === 1 ? "link" : "links"}
									{neighborsShown ? (
										<>
											{" · "}
											{neighborsShown}
										</>
									) : null}
									{truncationShown ? (
										<>
											{" · "}
											{truncationShown}
										</>
									) : null}
								</span>
							) : (
								<span>Loading…</span>
							)}

							<span style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 3 }}>
								<kbd
									style={{
										fontSize: 9,
										padding: "0px 4px",
										borderRadius: 3,
										border: "1px solid var(--rp-c-divider, #cbd5e1)",
										lineHeight: "14px",
										fontFamily: "inherit",
									}}
								>
									Esc
								</kbd>
								to close
							</span>
						</div>
					</div>
				)}
			</div>
		</>
	);
}
