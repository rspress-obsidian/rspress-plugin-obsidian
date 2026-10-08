import { CanvasRenderer } from "./CanvasRenderer.js";
import { resolveCanvasJsonUrl, useCanvasBoard } from "./useCanvasBoard.js";

export interface CanvasEmbedProps {
	/** Vault path of the board, e.g. `Projects/Board.canvas`. */
	src: string;
	fileRoutePrefix?: string;
	/** Show link nodes as live website previews. @default true */
	linkPreview?: boolean;
	iframeSandbox?: string;
	/**
	 * Site base to fetch the board under. Defaults to the Rspress `base` the
	 * canvas plugin was built with; set it only for a board published by a
	 * different site.
	 */
	basePath?: string;
}

export { resolveCanvasJsonUrl };

/**
 * A published board inside a page. Unlike the full-page viewer, a bare scroll
 * wheel scrolls the page: the board zooms with Ctrl/⌘+wheel, a trackpad pinch,
 * or once the reader has clicked into it.
 */
export default function CanvasEmbed({
	src,
	fileRoutePrefix,
	linkPreview,
	iframeSandbox,
	basePath,
}: CanvasEmbedProps) {
	const board = useCanvasBoard(src, basePath);

	if (board.status === "loading") {
		return (
			<div className="canvas-embed-loading" role="status">
				<div className="canvas-embed-spinner" />
				<span>Loading canvas…</span>
			</div>
		);
	}

	if (board.status === "error") {
		return (
			<div className="canvas-embed-error" role="alert">
				<svg
					width="20"
					height="20"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<circle cx="12" cy="12" r="10" />
					<line x1="12" y1="8" x2="12" y2="12" />
					<line x1="12" y1="16" x2="12.01" y2="16" />
				</svg>
				<span>
					Could not load canvas: <code>{src}</code>
				</span>
			</div>
		);
	}

	return (
		<div className="canvas-embed">
			<CanvasRenderer
				// The renderer seeds its editor state from `data` once, so a different
				// board has to remount it or the old one stays on screen.
				key={board.url}
				data={board.data}
				boardId={src}
				fileRoutePrefix={fileRoutePrefix}
				linkPreview={linkPreview}
				iframeSandbox={iframeSandbox}
				wheelZoom={false}
			/>
		</div>
	);
}
