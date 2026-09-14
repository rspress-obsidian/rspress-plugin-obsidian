import { useCallback, useEffect, useRef, useState } from "react";
import { pageContentData } from "virtual-page-content-data";

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

function getPreview(routePath: string): PagePreview | null {
	const page = pageContentData.find((p) => p.routePath === routePath);
	return page ?? null;
}

export default function HoverPreview() {
	const [popup, setPopup] = useState<PopupState | null>(null);
	const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const popupRef = useRef<HTMLDivElement>(null);

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
			if (!href || href.startsWith("http")) return;

			const preview = getPreview(href);
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
		};
	}, [handleMouseEnter, handleMouseLeave]);

	if (!popup) return null;

	return (
		<div
			ref={popupRef}
			className="obsidian-hover-preview"
			style={{
				position: "fixed",
				left: Math.min(popup.x + 16, window.innerWidth - POPUP_WIDTH - 16),
				top: Math.min(popup.y + 16, window.innerHeight - POPUP_HEIGHT - 16),
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
				{popup.preview.content.slice(0, 300) + (popup.preview.content.length > 300 ? "…" : "")}
			</div>
		</div>
	);
}
