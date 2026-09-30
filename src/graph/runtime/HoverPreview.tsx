import { useCallback, useEffect, useRef, useState } from "react";
import { pageContentData } from "virtual-page-content-data";
import { PREVIEW_CONTENT_LENGTH } from "../build/preview-content.js";
import { normalizeClientRoutePath } from "./deriveGraphViewData.js";

interface PagePreview {
	routePath: string;
	title: string;
	content: string;
}

interface PopupState {
	preview: PagePreview;
	x: number;
	y: number;
}

const POPUP_WIDTH = 320;
const POPUP_HEIGHT = 240;
const HOVER_DELAY = 300;

// The mouseover listener is document-level, so index the pages once instead of
// scanning every route on every hover.
const previewByRoutePath = new Map(pageContentData.map((page) => [page.routePath, page]));

export default function HoverPreview() {
	const [popup, setPopup] = useState<PopupState | null>(null);
	// The clamp depends on the viewport, so track it in state: reading
	// `window.innerWidth` during render leaves a popup stranded off-screen after
	// a resize.
	const [viewport, setViewport] = useState(() => ({
		width: typeof window === "undefined" ? 0 : window.innerWidth,
		height: typeof window === "undefined" ? 0 : window.innerHeight,
	}));
	const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearHoverTimer = useCallback(() => {
		if (hoverTimer.current) {
			clearTimeout(hoverTimer.current);
			hoverTimer.current = null;
		}
	}, []);

	const handleMouseEnter = useCallback(
		(e: MouseEvent) => {
			const target = e.target as HTMLElement;
			const link = target.closest("a[href]") as HTMLAnchorElement | null;
			if (!link) return;

			const href = link.getAttribute("href");
			if (!href || href.startsWith("#") || href.startsWith("http")) return;

			// Rspress rewrites markdown links to `.html` and appends fragments and
			// queries; reduce all of that to the graph's route path.
			const preview = previewByRoutePath.get(normalizeClientRoutePath(href.split(/[?#]/)[0] ?? ""));
			if (!preview) return;

			clearHoverTimer();
			hoverTimer.current = setTimeout(() => {
				setPopup({
					preview,
					x: e.clientX,
					y: e.clientY,
				});
			}, HOVER_DELAY);
		},
		[clearHoverTimer],
	);

	const handleMouseLeave = useCallback(() => {
		clearHoverTimer();
		setPopup(null);
	}, [clearHoverTimer]);

	useEffect(() => {
		document.addEventListener("mouseover", handleMouseEnter);
		document.addEventListener("mouseout", handleMouseLeave);
		return () => {
			document.removeEventListener("mouseover", handleMouseEnter);
			document.removeEventListener("mouseout", handleMouseLeave);
			// A pending hover timer must not fire after the component unmounts.
			clearHoverTimer();
		};
	}, [handleMouseEnter, handleMouseLeave, clearHoverTimer]);

	useEffect(() => {
		const updateViewport = () =>
			setViewport({ width: window.innerWidth, height: window.innerHeight });
		window.addEventListener("resize", updateViewport);
		return () => window.removeEventListener("resize", updateViewport);
	}, []);

	if (!popup) return null;

	// The build ships one character past the budget when it truncated the note.
	const previewContent =
		popup.preview.content.length > PREVIEW_CONTENT_LENGTH
			? `${popup.preview.content.slice(0, PREVIEW_CONTENT_LENGTH)}…`
			: popup.preview.content;

	return (
		<div
			className="obsidian-hover-preview"
			style={{
				position: "fixed",
				left: Math.min(popup.x + 16, viewport.width - POPUP_WIDTH - 16),
				top: Math.min(popup.y + 16, viewport.height - POPUP_HEIGHT - 16),
				width: POPUP_WIDTH,
				maxHeight: POPUP_HEIGHT,
				overflow: "auto",
				background: "var(--rp-c-bg, #fff)",
				border: "1px solid var(--rp-c-divider, #e5e7eb)",
				borderRadius: 8,
				boxShadow: "0 4px 16px rgba(0,0,0,0.1)",
				padding: 12,
				zIndex: 9999,
			}}
		>
			<h4
				className="obsidian-hover-preview__title"
				style={{ margin: "0 0 8px", fontSize: 14, fontWeight: 600 }}
			>
				{popup.preview.title}
			</h4>
			<div
				className="obsidian-hover-preview__content"
				style={{
					fontSize: 12,
					color: "var(--rp-c-text-2, #6b7280)",
					lineHeight: 1.5,
					whiteSpace: "pre-wrap",
				}}
			>
				{previewContent}
			</div>
		</div>
	);
}
