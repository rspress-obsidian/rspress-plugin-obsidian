import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigateTo, usePathname } from "../../shared/usePathname.js";
import type { GraphViewGroup } from "../types.js";
import GraphIcon from "./components/GraphIcon.js";
import ZoomButton from "./components/ZoomButton.js";
import { type GraphScope, MAX_DEPTH } from "./deriveGraphViewData.js";
import GraphView, {
	type GraphViewColors,
	type GraphViewFilters,
	type GraphViewHandle,
	type GraphViewStats,
} from "./GraphView.js";
import {
	LOCAL_STORAGE_KEY_FILTERS,
	LOCAL_STORAGE_KEY_OPEN,
	LOCAL_STORAGE_KEY_POS,
} from "./graph-panel-storage.js";

interface GraphPanelProps {
	defaultOpen?: boolean;
	colors?: GraphViewColors;
	groups?: readonly GraphViewGroup[];
}

const STYLE_ID = "graph-panel-keyframes";
const PANEL_ID = "rspress-graph-view-panel";
const PANEL_TITLE_ID = "rspress-graph-view-title";
const GRAPH_REGION_ID = "rspress-graph-view-region";

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

export default function GraphPanel({ defaultOpen = false, colors, groups }: GraphPanelProps) {
	const pathname = usePathname();
	const navigateTo = useNavigateTo();
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
	const [depth, setDepth] = useState(1);
	const [showTags, setShowTags] = useState(true);
	const [showOrphans, setShowOrphans] = useState(true);
	const [scope, setScope] = useState<GraphScope>("local");
	const panelRef = useRef<HTMLDivElement>(null);
	const wrapperRef = useRef<HTMLDivElement>(null);
	const graphViewRef = useRef<GraphViewHandle>(null);
	const fabRef = useRef<HTMLButtonElement>(null);
	const closeButtonRef = useRef<HTMLButtonElement>(null);
	// True when the reader opened the panel themselves. Only then does the panel
	// take focus on open, and only then does closing it hand focus back to the FAB:
	// a `defaultOpen` panel must not move focus the reader never asked it to move.
	const readerOpenedRef = useRef(false);

	const isDragging = useRef(false);
	const dragStart = useRef({ x: 0, y: 0, posX: 0, posY: 0 });

	useEffect(() => {
		setIsHydrated(true);
		try {
			const storedOpen = localStorage.getItem(LOCAL_STORAGE_KEY_OPEN);
			if (storedOpen !== null) setIsOpen(storedOpen === "true");

			const storedPos = localStorage.getItem(LOCAL_STORAGE_KEY_POS);
			if (storedPos) setPos(JSON.parse(storedPos));

			const storedFilters = localStorage.getItem(LOCAL_STORAGE_KEY_FILTERS);
			if (storedFilters) {
				const parsed = JSON.parse(storedFilters) as Partial<GraphViewFilters>;
				if (typeof parsed.depth === "number") {
					setDepth(Math.min(MAX_DEPTH, Math.max(1, Math.round(parsed.depth))));
				}
				if (typeof parsed.showTags === "boolean") setShowTags(parsed.showTags);
				if (typeof parsed.showOrphans === "boolean") setShowOrphans(parsed.showOrphans);
				if (parsed.scope === "global" || parsed.scope === "local") setScope(parsed.scope);
			}
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
			localStorage.setItem(
				LOCAL_STORAGE_KEY_FILTERS,
				JSON.stringify({ depth, showTags, showOrphans, scope }),
			);
		} catch {
			// localStorage may be unavailable (private mode, SSR, storage disabled)
		}
	}, [isOpen, pos, depth, showTags, showOrphans, scope, isHydrated]);

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
			if (e.key === "Escape" && isOpen) {
				// A non-empty search clears first — a filter bar you cannot
				// backspace out of with Escape is a trap — and only the next
				// Escape closes the panel.
				if (query) {
					e.preventDefault();
					setQuery("");
					return;
				}
				e.preventDefault();
				// A panel the reader opened hands focus back to the FAB; an auto-opened
				// one leaves focus wherever it is (another plugin's dialog, say).
				const readerOpened = readerOpenedRef.current;
				setIsOpen(false);
				setIsFullscreen(false);
				if (readerOpened) fabRef.current?.focus();
				return;
			}

			if (e.key === "Tab" && isOpen && panelRef.current) {
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
	}, [isOpen, query]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: stats track route and filter changes; graphViewRef is stable
	useEffect(() => {
		const s = graphViewRef.current?.getStats();
		if (s) setStats(s);
	}, [pathname, depth, showTags, showOrphans, scope, query]);

	// Stable identity: GraphView re-derives only when a filter value changes,
	// not on every panel re-render (position drags, stats ticks).
	const filters = useMemo(
		() => ({ query, depth, showTags, showOrphans, scope }),
		[query, depth, showTags, showOrphans, scope],
	);

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

	const handleNodeClick = useCallback((routePath: string) => navigateTo(routePath), [navigateTo]);

	const FOOTER_HEIGHT = 22;
	const HEADER_HEIGHT = 34;
	const FILTER_BAR_HEIGHT = 32;
	const actualWidth = isFullscreen ? windowSize.width : panelSize.width;
	const actualHeight = isFullscreen ? windowSize.height : panelSize.height;

	const neighborsShown =
		stats && stats.neighborCount < stats.neighborTotal
			? `${stats.neighborCount} of ${stats.neighborTotal} neighbors`
			: null;
	// The global scope caps the drawn nodes so d3-force stays usable; say how
	// many were left out rather than presenting a partial vault as the whole one.
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
						aria-modal="false"
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
									color: "var(--rp-c-text-1, #d0d0d0)",
									opacity: 0.9,
									userSelect: "none",
								}}
							>
								<GraphIcon size={13} />
								<span
									id={PANEL_TITLE_ID}
									style={{
										fontSize: 11,
										fontWeight: 600,
										fontFamily:
											"system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
										letterSpacing: "0.05em",
										textTransform: "uppercase",
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
										color: "color-mix(in srgb, var(--rp-c-text-2, #64748b) 70%, transparent)",
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
										e.currentTarget.style.color = "#ef4444";
									}}
									onMouseLeave={(e) => {
										e.currentTarget.style.background = "transparent";
										e.currentTarget.style.color =
											"color-mix(in srgb, var(--rp-c-text-2, #64748b) 70%, transparent)";
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
									placeholder="Search… (path:, file:, tag:)"
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
										color: "var(--rp-c-text-1, #334155)",
										fontFamily:
											"system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
										outline: "none",
									}}
								/>
								{/* Local is the neighborhood of the current page; global is the
								    whole vault with the current page highlighted. */}
								<div
									role="group"
									aria-label="Graph scope"
									style={{
										display: "flex",
										alignItems: "center",
										gap: 1,
										flexShrink: 0,
										border:
											"1px solid color-mix(in srgb, var(--rp-c-divider, #e8e8f0) 50%, transparent)",
										borderRadius: 6,
										padding: "1px",
									}}
								>
									{(["local", "global"] as const).map((value) => {
										const active = scope === value;
										return (
											<button
												key={value}
												type="button"
												aria-label={`${value === "local" ? "Local" : "Global"} graph`}
												aria-pressed={active}
												onClick={() => setScope(value)}
												style={{
													border: "none",
													borderRadius: 4,
													padding: "1px 6px",
													fontSize: 10,
													lineHeight: "16px",
													cursor: "pointer",
													background: active
														? "color-mix(in srgb, var(--rp-c-brand, #3b82f6) 18%, transparent)"
														: "transparent",
													color: active
														? "var(--rp-c-text-1, #334155)"
														: "var(--rp-c-text-2, #64748b)",
													fontWeight: active ? 600 : 400,
													fontFamily:
														"system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
												}}
											>
												{value === "local" ? "Local" : "Global"}
											</button>
										);
									})}
								</div>
								<div
									style={{
										display: "flex",
										alignItems: "center",
										gap: 1,
										flexShrink: 0,
										border:
											"1px solid color-mix(in srgb, var(--rp-c-divider, #e8e8f0) 50%, transparent)",
										borderRadius: 6,
										padding: "1px",
									}}
									// The stepper is one control; the count between the buttons
									// announces itself when it changes. Depth sizes the local
									// neighborhood, so the control is hidden in the global scope.
									role="group"
									aria-label="Neighborhood depth"
									hidden={scope === "global"}
								>
									<button
										type="button"
										aria-label="Decrease depth"
										disabled={depth <= 1}
										onClick={() => setDepth((value) => Math.max(1, value - 1))}
										style={{
											width: 18,
											height: 18,
											border: "none",
											borderRadius: 4,
											background: "transparent",
											color: "var(--rp-c-text-2, #64748b)",
											cursor: depth <= 1 ? "default" : "pointer",
											fontSize: 12,
											lineHeight: 1,
											padding: 0,
											opacity: depth <= 1 ? 0.4 : 1,
										}}
									>
										−
									</button>
									<span
										aria-live="polite"
										style={{
											fontSize: 10,
											minWidth: 12,
											textAlign: "center",
											color: "var(--rp-c-text-2, #64748b)",
											fontFamily:
												"system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
											userSelect: "none",
										}}
									>
										{depth}
									</span>
									<button
										type="button"
										aria-label="Increase depth"
										disabled={depth >= MAX_DEPTH}
										onClick={() => setDepth((value) => Math.min(MAX_DEPTH, value + 1))}
										style={{
											width: 18,
											height: 18,
											border: "none",
											borderRadius: 4,
											background: "transparent",
											color: "var(--rp-c-text-2, #64748b)",
											cursor: depth >= MAX_DEPTH ? "default" : "pointer",
											fontSize: 12,
											lineHeight: 1,
											padding: 0,
											opacity: depth >= MAX_DEPTH ? 0.4 : 1,
										}}
									>
										+
									</button>
								</div>
								<label
									style={{
										display: "flex",
										alignItems: "center",
										gap: 3,
										flexShrink: 0,
										fontSize: 10,
										color: "var(--rp-c-text-2, #64748b)",
										fontFamily:
											"system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
										userSelect: "none",
										cursor: "pointer",
									}}
								>
									<input
										type="checkbox"
										checked={showTags}
										onChange={(event) => setShowTags(event.target.checked)}
									/>
									Tags
								</label>
								<label
									style={{
										display: "flex",
										alignItems: "center",
										gap: 3,
										flexShrink: 0,
										fontSize: 10,
										color: "var(--rp-c-text-2, #64748b)",
										fontFamily:
											"system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
										userSelect: "none",
										cursor: "pointer",
									}}
								>
									<input
										type="checkbox"
										checked={showOrphans}
										onChange={(event) => setShowOrphans(event.target.checked)}
									/>
									Orphans
								</label>
							</div>
						)}

						<div
							id={GRAPH_REGION_ID}
							role="img"
							aria-label={
								stats
									? `Graph view showing ${stats.nodes} ${stats.nodes === 1 ? "node" : "nodes"} and ${stats.links} ${stats.links === 1 ? "link" : "links"}${neighborsShown ? ` (${neighborsShown})` : ""}${truncationShown ? ` (${truncationShown})` : ""}. Click graph nodes to navigate documentation pages.`
									: "Interactive documentation graph loading."
							}
							style={{ position: "relative", width: "100%", flex: 1, overflow: "hidden" }}
						>
							<GraphView
								ref={graphViewRef}
								width={actualWidth}
								height={graphHeight}
								onNodeClick={handleNodeClick}
								colors={colors}
								filters={filters}
								groups={groups}
							/>

							{/* Hover tooltip removed for Obsidian-like canvas-only text */}
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
							}}
						>
							{stats ? (
								<>
									<svg
										aria-hidden="true"
										width="10"
										height="10"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										style={{
											color: "color-mix(in srgb, var(--rp-c-text-2, #a0a0a0) 60%, transparent)",
											flexShrink: 0,
										}}
									>
										<circle cx="12" cy="12" r="4" />
									</svg>
									<span
										aria-live="polite"
										style={{
											fontSize: 10,
											fontFamily:
												"system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
											color: "color-mix(in srgb, var(--rp-c-text-2, #64748b) 80%, transparent)",
											userSelect: "none",
											letterSpacing: "0.02em",
										}}
									>
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
								</>
							) : (
								<span
									style={{
										fontSize: 10,
										color: "color-mix(in srgb, var(--rp-c-text-2, #64748b) 40%, transparent)",
										fontFamily:
											"system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
										userSelect: "none",
									}}
								>
									Loading…
								</span>
							)}

							<span
								style={{
									marginLeft: "auto",
									fontSize: 10,
									color: "color-mix(in srgb, var(--rp-c-text-2, #64748b) 40%, transparent)",
									fontFamily:
										"system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
									userSelect: "none",
									display: "flex",
									alignItems: "center",
									gap: 3,
								}}
							>
								<kbd
									style={{
										fontSize: 9,
										padding: "0px 4px",
										borderRadius: 3,
										border:
											"1px solid color-mix(in srgb, var(--rp-c-divider, #e2e8f0) 60%, transparent)",
										background: "color-mix(in srgb, var(--rp-c-divider, #e2e8f0) 20%, transparent)",
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
