import { useCallback, useEffect, useRef, useState } from "react";
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

interface PreviewIndex {
	base: string;
	byRoutePath: Map<string, PagePreview>;
}

const POPUP_WIDTH = 320;
const POPUP_HEIGHT = 240;
const HOVER_DELAY = 300;

let previewIndex: Promise<PreviewIndex> | undefined;

/**
 * The preview text of every page is the largest thing this component needs, so
 * it is its own chunk, fetched on the first hover over an internal link rather
 * than shipped in every page's initial bundle.
 */
function loadPreviewIndex(): Promise<PreviewIndex> {
	previewIndex ??= import("virtual-page-content-data")
		.then(({ base, pageContentData }) => ({
			base: base || "/",
			byRoutePath: new Map(pageContentData.map((page) => [page.routePath, page])),
		}))
		.catch((error: unknown) => {
			previewIndex = undefined;
			throw error;
		});
	return previewIndex;
}

/**
 * The route an internal link points at, as a preview key: same-origin only,
 * site base removed, then the graph's own route normalization (percent
 * decoding, `.html`, `/index`, trailing slashes).
 */
export function previewKeyForHref(
	href: string,
	base: string,
	location: Location,
): string | undefined {
	if (!href || href.startsWith("#")) return undefined;
	let url: URL;
	try {
		url = new URL(href, location.href);
	} catch {
		return undefined;
	}
	if (url.origin !== location.origin) return undefined;
	const prefix = base.replace(/\/+$/, "");
	let pathname = url.pathname;
	if (prefix && (pathname === prefix || pathname.startsWith(`${prefix}/`))) {
		pathname = pathname.slice(prefix.length) || "/";
	}
	return normalizeClientRoutePath(pathname);
}

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
	// The link the pointer is on now; a preview that finishes loading after the
	// pointer left must not appear.
	const hoveredLinkRef = useRef<Element | null>(null);

	const clearHoverTimer = useCallback(() => {
		if (hoverTimer.current) {
			clearTimeout(hoverTimer.current);
			hoverTimer.current = null;
		}
	}, []);

	const handleMouseEnter = useCallback(
		(e: MouseEvent) => {
			const target = e.target as Element | null;
			const link = target?.closest?.("a[href]") ?? null;
			if (!link) return;
			const href = link.getAttribute("href") ?? "";
			if (!href || href.startsWith("#")) return;
			hoveredLinkRef.current = link;

			const { clientX, clientY } = e;
			void loadPreviewIndex()
				.then((index) => {
					if (hoveredLinkRef.current !== link) return;
					const key = previewKeyForHref(href, index.base, window.location);
					const preview = key ? index.byRoutePath.get(key) : undefined;
					if (!preview) return;
					clearHoverTimer();
					hoverTimer.current = setTimeout(() => {
						setPopup({ preview, x: clientX, y: clientY });
					}, HOVER_DELAY);
				})
				.catch(() => {
					// No preview data, no popup; the link still works.
				});
		},
		[clearHoverTimer],
	);

	const handleMouseLeave = useCallback(() => {
		hoveredLinkRef.current = null;
		clearHoverTimer();
		setPopup(null);
	}, [clearHoverTimer]);

	useEffect(() => {
		document.addEventListener("mouseover", handleMouseEnter);
		document.addEventListener("mouseout", handleMouseLeave);
		return () => {
			document.removeEventListener("mouseover", handleMouseEnter);
			document.removeEventListener("mouseout", handleMouseLeave);
			// Neither a pending hover timer nor a preview still loading may open a
			// popup after the component unmounts.
			hoveredLinkRef.current = null;
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
					color: "var(--rp-c-text-2, #4b5563)",
					lineHeight: 1.5,
					whiteSpace: "pre-wrap",
				}}
			>
				{previewContent}
			</div>
		</div>
	);
}
